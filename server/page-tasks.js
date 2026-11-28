import crypto from 'node:crypto';
import { DoclingServiceError, extractPage } from './docling.js';

/**
 * 页解析任务编排与调度：
 *
 * 单页编排（Issue #3）：
 * - 已完成（持久化）的页直接复用结果，不重新解析；
 * - 同一页的重复请求幂等（进行中不重复启动）；
 * - 解析在后台进行，完成后自动持久保存（成功与失败都落盘）；
 * - 服务重启丢失的进行中任务自然回落为「未开始」。
 *
 * 按阅读位置调度（Issue #5）：
 * - 阅读位置更新时按「当前页 → 后续页 → 前置页」重排未开始任务队列；
 * - 跳页只重排未开始任务：进行中的页不取消、不重复启动；
 * - 已完成页从队列摘除并复用结果；失败页标记失败、不回队、不阻塞队列；
 * - 队列按序补全其余未解析页（闲置补全）；失败页仅通过显式请求重试；
 * - 全局并发上限可配置（默认 2，与 docling_service 线程池对齐）；背景派发 pacing
 *   动态自适应设备性能（最近 N 页转换耗时 × 系数，钐制上限），可用固定间隔覆盖。
 */
export class ParseTaskManager {
  constructor({ store, adapter, library, concurrency = 2, sweepDelayMs = 0, sweepPacingFactor = 0.5 }) {
    this.store = store;
    this.adapter = adapter;
    this.library = library;
    const parsed = Number(concurrency);
    // 并发上限与解析服务能力匹配，默认 2（docling_service 线程池同步为 2），最小 1；
    // 本机 2GB pagefile 下 2 是稳妥上限。
    this.concurrency =
      Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : 1;
    const sweep = Number(sweepDelayMs);
    // 背景派发节流固定覆盖值：>0 时使用固定间隔；0/未设置 = 动态 pacing（默认）。
    this.fixedSweepDelayMs = Number.isFinite(sweep) && sweep > 0 ? Math.floor(sweep) : 0;
    const factor = Number(sweepPacingFactor);
    // 动态 pacing 系数：背景派发间隔 = 最近转换耗时估计 × 系数。设备快→间隔小
    // 吞吐高；设备慢→间隔大、留 CPU 给阅读交互。系数 >0.5 时并发 2 下会出现 CPU 空隙。
    this.sweepPacingFactor = Number.isFinite(factor) && factor > 0 ? factor : 0.5;
    // 背景派发间隔钐制上限（避免慢页估计把间隔拉到数秒以上）。
    this.MAX_SWEEP_INTERVAL_MS = 5000;
    // 最近转换耗时样本（派发→succeeded/failed，不含排队等待），滚动估计用。
    this.conversionDurations = [];
    this.CONVERSION_SAMPLE_COUNT = 3;
    /** `${docId}:${page}` -> 派发时间戳，完成时计算耗时。 */
    this.dispatchTimes = new Map();
    /** 进行中的扫全会话（文档打开/首次上报开始，队列排空后结束）。 */
    this.sweepSessions = new Set();
    /** 开局填充额度：新会话授予 concurrency 个免 pacing 的背景派发。 */
    this.openingBurst = new Map();
    this.lastSweepDispatchAt = 0;
    this.sweepTimer = null;
    /** docId -> Set<page>，内存中的进行中任务。 */
    this.running = new Map();
    /** docId -> number[]，未开始任务的优先队列（队首最先解析）。 */
    this.queues = new Map();
    /** docId -> Set<page>，显式解析请求/重试的置顶标记：阅读位置重排不会降级置顶页。 */
    this.pinned = new Map();
  }

  /* ---------------- 单页状态 ---------------- */

  isRunning(docId, page) {
    return this.running.get(docId)?.has(page) ?? false;
  }

  isQueued(docId, page) {
    return this.queues.get(docId)?.includes(page) ?? false;
  }

  /** 队列中的位置（0 = 下一个解析）；不在队列返回 -1。 */
  queuePosition(docId, page) {
    return this.queues.get(docId)?.indexOf(page) ?? -1;
  }

  /** 任务状态：'running' | 'queued' | { status, record } | 'idle'。 */
  status(docId, page) {
    if (this.isRunning(docId, page)) return 'running';
    if (this.isQueued(docId, page)) return 'queued';
    // 轻量状态（B1）：只读状态字段，不解析内容块。
    const record = this.store.getStatus(docId, page);
    if (record) return { status: record.status, record };
    return 'idle';
  }

  /** 执行态（不含持久化结果）：'running' | 'queued' | 'idle'。 */
  stateOf(docId, page) {
    if (this.isRunning(docId, page)) return 'running';
    if (this.isQueued(docId, page)) return 'queued';
    return 'idle';
  }

  /* ---------------- 调度入口 ---------------- */

  /**
   * 阅读页优先级更新：按「当前页 → 后续页 → 前置页」重建未开始任务队列。
   *
   * 只重排未开始（无记录且未运行）的任务：进行中的页不取消、不重复启动；
   * 已完成页（成功/失败都有落盘记录）不入队——成功页复用结果，失败页仅显式重试。
   * 显式请求置顶（pinned）的页保持在队首，不随阅读位置变化降级。
   */
  updateReadingPosition(docId, page) {
    const doc = this.library.getDocument(docId);
    if (!doc) throw new DoclingServiceError('document not found');
    const order = [];
    for (let p = page; p <= doc.pageCount; p += 1) order.push(p);
    for (let p = 1; p < page; p += 1) order.push(p);
    // 置顶页在前（按置顶顺序），其余按阅读顺序重排（B1：全部走轻量状态索引）。
    const pinned = [...(this.pinned.get(docId) ?? [])];
    const pinnedSet = new Set(pinned);
    const queue = [...pinned, ...order.filter((p) => !pinnedSet.has(p))].filter((p) => {
      if (this.isRunning(docId, p)) return false;
      // 无落盘记录 = 未开始；成功/失败页均不自动入队。
      return !this.store.getStatus(docId, p);
    });
    // 清理已有落盘结果的置顶标记（成功复用/失败显式重试均已处理）。
    for (const p of pinned) {
      if (this.store.getStatus(docId, p)) this.pinned.get(docId)?.delete(p);
    }
    this.queues.set(docId, queue);
    // 扫全会话管理：文档首次上报（无进行中会话）授予开局填充额度——立即填满
    // 所有并发槽，不做 pacing；pacing 只作用于后续背景派发。
    if (!this.sweepSessions.has(docId)) {
      this.openingBurst.set(docId, this.concurrency);
    }
    if (queue.length > 0 || this.running.has(docId)) this.sweepSessions.add(docId);
    else this.sweepSessions.delete(docId);
    this.pump();
    return queue;
  }

  /**
   * 显式页解析请求 / 失败页重试：置于队列最前，尽快开始。
   * 返回 'started' | 'running' | 'reused'；并发占满时任务排队（响应 202 queued）。
   */
  start(docId, page) {
    const current = this.status(docId, page);
    if (current === 'running') return 'running';
    if (typeof current === 'object' && current.status === 'succeeded') return 'reused';
    // 失败页重试同样走这里：重新入队（置于队首），成功后由 saveResult 替换失败记录。
    // 置顶标记：随后的阅读位置重排不会把该页降级（顺手项②）。
    let set = this.pinned.get(docId);
    if (!set) {
      set = new Set();
      this.pinned.set(docId, set);
    }
    set.add(page);
    let queue = this.queues.get(docId);
    if (!queue) {
      queue = [];
      this.queues.set(docId, queue);
    } else {
      const index = queue.indexOf(page);
      if (index >= 0) queue.splice(index, 1);
    }
    queue.unshift(page);
    this.pump();
    return 'started';
  }

  /* ---------------- 派发与执行 ---------------- */

  /** 全局进行中任务数（并发上限跨文档共享，保护解析服务）。 */
  runningCount() {
    let total = 0;
    for (const set of this.running.values()) total += set.size;
    return total;
  }

  /** 按并发上限派发队列任务；开局填充与置顶/显式页免 pacing，其余背景任务受 pacing 约束。 */
  pump() {
    for (;;) {
      if (this.runningCount() >= this.concurrency) return;
      const next = this.takeNext();
      if (!next) return;
      const burst = this.openingBurst.get(next.docId) ?? 0;
      const interval = next.pinned || burst > 0 ? 0 : this.sweepIntervalMs();
      if (
        interval > 0 &&
        Date.now() - this.lastSweepDispatchAt < interval
      ) {
        // 未到 pacing 间隔：任务留在队首（不占并发槽），挂定时器到点继续派发。
        if (!this.sweepTimer) {
          const wait = interval - (Date.now() - this.lastSweepDispatchAt);
          this.sweepTimer = setTimeout(() => {
            this.sweepTimer = null;
            this.pump();
          }, wait);
        }
        return;
      }
      this.claimNext(next.docId, next.page);
      if (!next.pinned) {
        this.lastSweepDispatchAt = Date.now();
        if (burst > 0) this.openingBurst.set(next.docId, burst - 1);
      }
      this.runInBackground(next.docId, next.page);
    }
  }

  /** 最近 N 次转换耗时均值（毫秒）；无样本（开局）返回 null。 */
  estimateConversionMs() {
    if (this.conversionDurations.length === 0) return null;
    const sum = this.conversionDurations.reduce((a, b) => a + b, 0);
    return sum / this.conversionDurations.length;
  }

  /**
   * 背景派发间隔：固定覆盖值（READEVA_PARSE_SWEEP_DELAY_MS > 0）优先；
   * 否则动态 pacing = 最近转换耗时估计 × 系数，钐制 [0, MAX_SWEEP_INTERVAL_MS]。
   * 无样本（开局首扫）返回 0：立即填满并发槽，不做 pacing。
   */
  sweepIntervalMs() {
    if (this.fixedSweepDelayMs > 0) return this.fixedSweepDelayMs;
    const estimate = this.estimateConversionMs();
    if (estimate === null) return 0;
    return Math.min(
      Math.max(Math.round(estimate * this.sweepPacingFactor), 0),
      this.MAX_SWEEP_INTERVAL_MS,
    );
  }

  /** 记录一次转换耗时（滚动样本，供动态 pacing 估计）。 */
  recordConversionDuration(ms) {
    this.conversionDurations.push(ms);
    if (this.conversionDurations.length > this.CONVERSION_SAMPLE_COUNT) {
      this.conversionDurations.shift();
    }
  }

  /**
   * 取下一个待解析页：跳过失效条目（已成功/已在运行的陈旧队列项），返回队首
   * 待办页及其置顶状态；**不移出队列、不消耗置顶标记**（由 claimNext 在实际
   * 派发时完成，节流等待期间任务保留在队首）。无可派发任务返回 null。
   */
  takeNext() {
    for (const [docId, queue] of this.queues) {
      while (queue.length > 0) {
        const page = queue[0];
        const status = this.store.getStatus(docId, page);
        if (this.isRunning(docId, page) || status?.status === 'succeeded') {
          // 失效条目出队丢弃（成功页复用持久化结果；运行中页不该留在队列）。
          queue.shift();
          this.pinned.get(docId)?.delete(page);
          continue;
        }
        return { docId, page, pinned: this.pinned.get(docId)?.has(page) ?? false };
      }
      this.queues.delete(docId);
    }
    return null;
  }

  /** 实际派发前从队列移除该页并消耗置顶标记。 */
  claimNext(docId, page) {
    const queue = this.queues.get(docId);
    if (queue) {
      const index = queue.indexOf(page);
      if (index >= 0) queue.splice(index, 1);
      if (queue.length === 0) this.queues.delete(docId);
    }
    this.pinned.get(docId)?.delete(page);
  }

  runInBackground(docId, page) {
    let set = this.running.get(docId);
    if (!set) {
      set = new Set();
      this.running.set(docId, set);
    }
    set.add(page);

    const requestedAt = new Date().toISOString();
    const dispatchedAt = Date.now();
    const durationKey = `${docId}:${page}`;
    this.dispatchTimes.set(durationKey, dispatchedAt);
    const task = this.run(docId, page, requestedAt)
      .catch((err) => {
        console.error(`parse failed (doc=${docId} page=${page}): ${err.message}`);
        return this.store.saveFailure(docId, page, err, { requestedAt });
      })
      .finally(() => {
        set.delete(page);
        if (set.size === 0) this.running.delete(docId);
        // 转换耗时 = 派发 → succeeded/failed（不含排队等待），滚动样本供动态 pacing。
        const started = this.dispatchTimes.get(durationKey);
        if (started !== undefined) {
          this.dispatchTimes.delete(durationKey);
          this.recordConversionDuration(Date.now() - started);
        }
        // 扫全会话结束（队列空且无运行中任务）：下次上报重新授予开局填充。
        if (!this.queues.get(docId)?.length && !this.running.has(docId)) {
          this.sweepSessions.delete(docId);
          this.openingBurst.delete(docId);
        }
        // 任务结束（成功或失败）后继续派发队列下一页：失败不阻塞队列。
        this.pump();
      });
    // 后台任务自成一体；异常已在上面落盘。
    task.catch(() => {});
    return task;
  }

  async run(docId, page, requestedAt) {
    const doc = this.library.getDocument(docId);
    if (!doc) throw new DoclingServiceError('document not found');
    if (!this.library.hasPdf(docId)) throw new DoclingServiceError('document pdf missing');

    const pdfBytes = await this.library.readPdf(docId);
    const { bytes: pageBytes } = await extractPage(pdfBytes, page);
    const result = await this.adapter.parsePage(pageBytes, {
      filename: `page-${page}.pdf`,
      pageNo: page,
    });
    await this.store.saveResult(docId, page, {
      parseId: result.parseId,
      blocks: result.blocks,
      meta: {
        engine: 'docling',
        // 注意：解析服务地址不入盘、不经接口返回（服务边界，审查 B1）——
        // 地址属运行时配置，不属于解析成果内容。
        requestedAt,
        completedAt: new Date().toISOString(),
        errors: result.errors,
        pageContentSha256: crypto.createHash('sha256').update(pageBytes).digest('hex'),
      },
    });
    return result;
  }

  /* ---------------- 整本进度（Issue #5） ---------------- */

  /** 整本解析进度快照：逐页状态 + 计数 + 失败原因。 */
  progress(docId) {
    return buildParseProgress({
      store: this.store,
      library: this.library,
      tasks: this,
      docId,
    });
  }
}

/**
 * 构建整本解析进度快照。已完成/失败页以持久化记录（data/parses/<sha>/page-N.json）
 * 的**轻量状态索引**为准（B1：不逐轮全量读盘解析内容块）：服务重启后进度不丢、
 * 已完成页不重复解析；未开始/排队/进行中来自调度器内存态。
 * tasks 可为 null（未配置解析服务时仍可查询持久化进度）。
 */
export function buildParseProgress({ store, library, tasks, docId }) {
  const doc = library.getDocument(docId);
  if (!doc) return null;
  const pages = [];
  const counts = { succeeded: 0, failed: 0, running: 0, queued: 0, idle: 0 };
  for (let page = 1; page <= doc.pageCount; page += 1) {
    const entry = { page };
    if (tasks?.isRunning(docId, page)) {
      entry.status = 'running';
    } else {
      const position = tasks ? tasks.queuePosition(docId, page) : -1;
      if (position >= 0) {
        entry.status = 'queued';
        entry.queuePosition = position;
      } else {
        // 轻量状态（B1）：不解析 blocks/图片，只取状态字段。
        const status = store.getStatus(docId, page);
        if (status) {
          entry.status = status.status;
          if (status.status === 'succeeded') entry.parseId = status.parseId;
          if (status.status === 'failed') entry.error = status.error;
          entry.updatedAt = status.updatedAt;
        } else {
          entry.status = 'idle';
        }
      }
    }
    counts[entry.status] += 1;
    pages.push(entry);
  }
  return {
    documentId: docId,
    pageCount: doc.pageCount,
    total: doc.pageCount,
    ...counts,
    pages,
  };
}
