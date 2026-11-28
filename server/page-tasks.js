import crypto from 'node:crypto';
import { DoclingServiceError, PageExtractor } from './docling.js';

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
 *   动态自适应设备性能（最近 N 页转换耗时 × 系数，钳制上限），可用固定间隔覆盖；
 *   系数 0 = 关闭 pacing（不节流）；**pacing 状态按文档分桶**（A 的间隔不挡 B）；
 *   **当前页豁免 pacing**（用户当前页不被背景间隔拖住）。
 *
 * 客户端会话与宽限期（Issue #6）：
 * - 客户端任何文档活动（阅读位置上报/进度轮询/状态轮询/解析请求等）刷新 lastSeen；
 * - 超过宽限期（READEVA_CLIENT_GRACE_MS / --client-grace-ms，默认 60s）无活动视为
 *   客户端退出：完成已开始页（running 不取消、继续跑完并落盘）、清除尚未开始的任务
 *   （队列/置顶标记），处置幂等（重连/多次到期不误伤）；
 * - 重连（重新上报阅读位置）按当前阅读位置重新调度未完成页（复用本文件的重排规则），
 *   已完成页复用持久化结果不重新解析；宽限内回来队列不受影响；
 * - 跨文档取任务轮转（round-robin）：并发下不单个文档排空。
 */
export class ParseTaskManager {
  constructor({ store, adapter, library, concurrency = 2, sweepDelayMs = 0, sweepPacingFactor = 0.5, clientGraceMs = 60000 }) {
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
    // 吞吐高；设备慢→间隔大、留 CPU 给阅读交互。系数 >0.5 时并发 2 下会出现 CPU
    // 空隙；**系数 0 = 关闭 pacing（不节流）**，非法值/负数回落默认 0.5。
    this.sweepPacingFactor = Number.isFinite(factor) && factor >= 0 ? factor : 0.5;
    // 客户端会话宽限期（毫秒）：超过该时长无客户端活动即视为退出（Issue #6）。
    // 默认 300000（5 分钟）：浏览器隐藏标签页节流页面内定时器（约 1 次/分钟），
    // 默认值必须大于客户端心跳间隔（8s 慢刷新被节流稀释后仍留足余量）。
    const grace = Number(clientGraceMs);
    this.clientGraceMs = Number.isFinite(grace) && grace > 0 ? Math.floor(grace) : 300000;
    // 按页抽取器：整本 PDF 只解析一次并缓存（避免每页全量加载，执行路径归口）。
    this.extractor = new PageExtractor({ library });
    // 背景派发间隔钳制上限（避免慢页估计把间隔拉到数秒以上）。
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
    /** docId -> 该文档最近一次背景派发时间（pacing 按文档分桶，A 的间隔不挡 B）。 */
    this.lastSweepDispatchAtMap = new Map();
    /** docId -> 该文档的 pacing 等待定时器（到点重新 pump）。 */
    this.sweepTimers = new Map();
    /** docId -> 当前阅读页（Issue #6 ④：当前页豁免 pacing，不被背景间隔拖住）。 */
    this.currentPage = new Map();
    /** docId -> Set<page>，内存中的进行中任务。 */
    this.running = new Map();
    /** docId -> number[]，未开始任务的优先队列（队首最先解析）。 */
    this.queues = new Map();
    /** docId -> Set<page>，显式解析请求/重试的置顶标记：阅读位置重排不会降级置顶页。 */
    this.pinned = new Map();
    /** docId -> 最近客户端活动时间戳（会话存续，Issue #6）。 */
    this.lastSeen = new Map();
    // 周期性会话检查：超出宽限期的文档执行到期处置（完成已开始页、清除未开始队列）。
    this.sessionSweepTimer = setInterval(() => this.sessionSweep(), 250);
    if (typeof this.sessionSweepTimer.unref === 'function') this.sessionSweepTimer.unref();
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

  /* ---------------- 客户端会话与宽限期（Issue #6） ---------------- */

  /** 客户端活动（阅读位置上报/进度轮询/状态轮询/解析请求等）→ 刷新会话最近活跃时间。 */
  touch(docId) {
    this.lastSeen.set(docId, Date.now());
  }

  /** 最近一次客户端活动时间；从未活动返回 null。 */
  lastSeenAt(docId) {
    return this.lastSeen.get(docId) ?? null;
  }

  /** 会话是否已过期（超过宽限期无客户端活动）。 */
  isExpired(docId) {
    const seen = this.lastSeen.get(docId);
    return seen !== undefined && Date.now() - seen > this.clientGraceMs;
  }

  /** 会话状态（只读观察端点用；不刷新 lastSeen）。 */
  sessionInfo(docId) {
    const seen = this.lastSeen.get(docId);
    return {
      documentId: docId,
      supported: true,
      lastSeen: seen ?? null,
      graceMs: this.clientGraceMs,
      expired: seen !== undefined && Date.now() - seen > this.clientGraceMs,
    };
  }

  /**
   * 宽限期到期处置（幂等，重连/多次到期不误伤）：完成已开始页（running 不取消、
   * 继续跑完并落盘），清除尚未开始的任务（队列/置顶标记），结束扫全会话，
   * 释放该文档的 pacing 状态与整本 PDF 缓存。
   */
  expireDoc(docId) {
    this.queues.delete(docId);
    this.pinned.delete(docId);
    this.sweepSessions.delete(docId);
    this.openingBurst.delete(docId);
    this.clearDocTimer(docId);
    this.lastSweepDispatchAtMap.delete(docId);
    this.currentPage.delete(docId);
    if (!this.running.has(docId)) this.extractor.release(docId);
  }

  /** 周期性会话检查：超宽限期未活动的文档执行到期处置；状态缓存随书库清理。 */
  sessionSweep() {
    const now = Date.now();
    for (const docId of [...this.lastSeen.keys()]) {
      if (now - this.lastSeen.get(docId) > this.clientGraceMs) this.expireDoc(docId);
    }
    // statusCache / indexCache / lastSeen / pacing 状态随文档清理（与删除能力联动；
    // 删除未实现时保证缓存不无界增长）。书库清单取自内存态 documents（不逐轮读盘）。
    const valid = new Set(Object.keys(this.library.documents));
    this.store.pruneStatusCache(valid);
    for (const docId of [...this.lastSeen.keys()]) {
      if (!valid.has(docId)) this.lastSeen.delete(docId);
    }
    for (const docId of [...this.lastSweepDispatchAtMap.keys()]) {
      if (!valid.has(docId)) {
        this.lastSweepDispatchAtMap.delete(docId);
        this.currentPage.delete(docId);
        this.clearDocTimer(docId);
      }
    }
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
    // 阅读位置上报 = 客户端活动（会话存续，Issue #6）；当前页记录用于 pacing 豁免。
    this.touch(docId);
    this.currentPage.set(docId, page);
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
    this.setQueue(docId, queue);
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
    // 显式解析请求/重试 = 客户端活动（会话存续，Issue #6）。
    this.touch(docId);
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
      this.setQueue(docId, queue);
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

  /**
   * 按并发上限派发队列任务。开局填充、置顶/显式页与**当前页**免 pacing，
   * 其余背景任务受 pacing 约束；**pacing 状态按文档分桶**（每文档独立
   * lastSweepDispatchAt 与等待定时器）——文档 A 的间隔不挡文档 B 的派发。
   */
  pump() {
    for (;;) {
      if (this.runningCount() >= this.concurrency) return;
      // 扫描一轮各文档队列：跳过 pacing 未到的文档（挂各自定时器），
      // 派发首个可派发的文档；全部在等自己的间隔则返回等待定时器。
      if (!this.scanForDispatch()) return;
    }
  }

  /**
   * 扫描一轮队列（跨文档轮转）：对每个文档取队首，pacing 未到则留队首并挂
   * 该文档自己的定时器；派发一个可派发任务返回 true，无可派发返回 false。
   */
  scanForDispatch() {
    const docCount = this.queues.size;
    for (let i = 0; i < docCount; i += 1) {
      const next = this.takeNext();
      if (!next) return null;
      const burst = this.openingBurst.get(next.docId) ?? 0;
      const isCurrent = this.currentPage.get(next.docId) === next.page;
      const interval = next.pinned || isCurrent || burst > 0 ? 0 : this.sweepIntervalMs();
      const last = this.lastSweepDispatchAtMap.get(next.docId) ?? 0;
      if (interval > 0 && Date.now() - last < interval) {
        // 该文档未到自己的 pacing 间隔：任务留在队首（不占并发槽），
        // 挂该文档定时器（已挂过则跳过，其余文档同样在等自己的间隔）。
        if (!this.sweepTimers.has(next.docId)) {
          this.armDocTimer(next.docId, interval - (Date.now() - last));
        }
        continue;
      }
      this.claimNext(next.docId, next.page);
      // 开局填充额度照常消费（当前页豁免 pacing 不豁免额度）；
      // 置顶/当前页派发不计入本文档的 pacing 基线（不拖住后续背景派发）。
      if (burst > 0) this.openingBurst.set(next.docId, burst - 1);
      if (!next.pinned && !isCurrent) {
        this.lastSweepDispatchAtMap.set(next.docId, Date.now());
      }
      this.runInBackground(next.docId, next.page);
      return true;
    }
    return false;
  }

  /** 挂文档级 pacing 定时器：到点重新 pump（该文档间隔已过即可派发）。 */
  armDocTimer(docId, wait) {
    const timer = setTimeout(() => {
      this.sweepTimers.delete(docId);
      this.pump();
    }, wait);
    this.sweepTimers.set(docId, timer);
  }

  /** 清理文档的 pacing 定时器（会话到期/队列排空时）。 */
  clearDocTimer(docId) {
    const timer = this.sweepTimers.get(docId);
    if (timer) clearTimeout(timer);
    this.sweepTimers.delete(docId);
  }

  /** 最近 N 次转换耗时均值（毫秒）；无样本（开局）返回 null。 */
  estimateConversionMs() {
    if (this.conversionDurations.length === 0) return null;
    const sum = this.conversionDurations.reduce((a, b) => a + b, 0);
    return sum / this.conversionDurations.length;
  }

  /**
   * 背景派发间隔：固定覆盖值（READEVA_PARSE_SWEEP_DELAY_MS > 0）优先；
   * 否则动态 pacing = 最近转换耗时估计 × 系数，钳制 [0, MAX_SWEEP_INTERVAL_MS]。
   * 无样本（开局首扫）或系数 0（不节流档）返回 0：立即派发，不做 pacing。
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
   *
   * 跨文档取任务轮转（Issue #6）：取走某文档队首后把该文档移到队列轮转尾部，
   * 下一次取任务从下一份文档开始——并发下不单个文档排空（多文档公平派发）。
   */
  takeNext() {
    while (this.queues.size > 0) {
      const first = this.queues.entries().next().value;
      if (!first) return null;
      const [docId, queue] = first;
      // 宽限期已过（会话到期）但周期性 sweep 尚未执行时立即处置并跳过该文档：
      // 消除「运行中页完成 → pump 派发下一页」与「到期清除」之间的竞态窗口。
      if (this.isExpired(docId)) {
        this.expireDoc(docId);
        continue;
      }
      while (queue.length > 0) {
        const page = queue[0];
        const status = this.store.getStatus(docId, page);
        if (this.isRunning(docId, page) || status?.status === 'succeeded') {
          // 失效条目出队丢弃（成功页复用持久化结果；运行中页不该留在队列）。
          queue.shift();
          this.pinned.get(docId)?.delete(page);
          continue;
        }
        // 轮转：取走本文档队首后把文档移到队尾（下一轮从别的文档开始）；
        // 队列已空则直接删除（不残留空队列）。
        this.queues.delete(docId);
        if (queue.length > 0) this.queues.set(docId, queue);
        return { docId, page, pinned: this.pinned.get(docId)?.has(page) ?? false };
      }
      this.queues.delete(docId);
    }
    return null;
  }

  /**
   * 写入文档队列。新队列（文档此前无队列：新打开/重连）插入轮转队首——下一派发
   * 轮次优先轮转新文档；已有队列的文档保持当前轮转位置（翻页上报不反复插队饿死
   * 其他文档）。
   */
  setQueue(docId, queue) {
    const existed = this.queues.has(docId);
    this.queues.set(docId, queue);
    if (!existed) {
      this.queues.delete(docId);
      this.queues = new Map([[docId, queue], ...this.queues]);
    }
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
        // 扫全会话结束（队列空且无运行中任务）：下次上报重新授予开局填充；
        // 同时释放整本 PDF 缓存与文档级 pacing 状态（执行路径归口）。
        if (!this.queues.get(docId)?.length && !this.running.has(docId)) {
          this.sweepSessions.delete(docId);
          this.openingBurst.delete(docId);
          this.extractor.release(docId);
          this.clearDocTimer(docId);
          this.lastSweepDispatchAtMap.delete(docId);
          this.currentPage.delete(docId);
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

    // 整本 PDF 只解析一次并缓存（PageExtractor）：避免每页全量加载整本 PDF，
    // 与「客户端退出后运行中的页继续跑完」叠加；队列清除不影响已开始任务。
    const { bytes: pageBytes } = await this.extractor.extractPage(docId, page);
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
