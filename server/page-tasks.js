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
 * - 全局并发上限可配置（对齐解析服务能力：docling_service 单线程串行）。
 */
export class ParseTaskManager {
  constructor({ store, adapter, library, concurrency = 1 }) {
    this.store = store;
    this.adapter = adapter;
    this.library = library;
    const parsed = Number(concurrency);
    // 并发上限与服务能力匹配，默认 1（docling_service 为单线程串行），最小 1。
    this.concurrency =
      Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : 1;
    /** docId -> Set<page>，内存中的进行中任务。 */
    this.running = new Map();
    /** docId -> number[]，未开始任务的优先队列（队首最先解析）。 */
    this.queues = new Map();
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
    const record = this.store.getRecord(docId, page);
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
   */
  updateReadingPosition(docId, page) {
    const doc = this.library.getDocument(docId);
    if (!doc) throw new DoclingServiceError('document not found');
    const order = [];
    for (let p = page; p <= doc.pageCount; p += 1) order.push(p);
    for (let p = 1; p < page; p += 1) order.push(p);
    const queue = order.filter((p) => {
      if (this.isRunning(docId, p)) return false;
      // 无落盘记录 = 未开始；成功/失败页均不自动入队。
      return !this.store.getRecord(docId, p);
    });
    this.queues.set(docId, queue);
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

  /** 按并发上限派发队列任务。 */
  pump() {
    for (;;) {
      if (this.runningCount() >= this.concurrency) return;
      const next = this.takeNext();
      if (!next) return;
      this.runInBackground(next.docId, next.page);
    }
  }

  /** 取下一个待解析页（出队）；跳过失效条目，无任务返回 null。 */
  takeNext() {
    for (const [docId, queue] of this.queues) {
      while (queue.length > 0) {
        const page = queue.shift();
        if (this.isRunning(docId, page)) continue;
        const record = this.store.getRecord(docId, page);
        // 成功页出队丢弃（结果已持久化，复用即可）。失败页不在自动队列中——
        // 出现在这里只能是显式重试（start 入队），照常执行。
        if (record?.status === 'succeeded') continue;
        return { docId, page };
      }
      this.queues.delete(docId);
    }
    return null;
  }

  runInBackground(docId, page) {
    let set = this.running.get(docId);
    if (!set) {
      set = new Set();
      this.running.set(docId, set);
    }
    set.add(page);

    const requestedAt = new Date().toISOString();
    const task = this.run(docId, page, requestedAt)
      .catch((err) => {
        console.error(`parse failed (doc=${docId} page=${page}): ${err.message}`);
        return this.store.saveFailure(docId, page, err, { requestedAt });
      })
      .finally(() => {
        set.delete(page);
        if (set.size === 0) this.running.delete(docId);
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
 * 为准：服务重启后进度不丢、已完成页不重复解析；未开始/排队/进行中来自调度器内存态。
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
        const record = store.getRecord(docId, page);
        if (record) {
          entry.status = record.status;
          if (record.status === 'succeeded') entry.parseId = record.parseId;
          if (record.status === 'failed') entry.error = record.error;
          entry.updatedAt = record.updatedAt;
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
    completed: counts.succeeded + counts.failed,
    pages,
  };
}
