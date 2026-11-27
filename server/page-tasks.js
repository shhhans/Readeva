import crypto from 'node:crypto';
import { DoclingServiceError, extractPage } from './docling.js';

/**
 * 页解析任务编排：
 * - 已完成（持久化）的页直接复用结果，不重新解析；
 * - 同一页的重复请求幂等（进行中不重复启动）；
 * - 解析在后台进行，完成后自动持久保存（成功与失败都落盘）；
 * - 服务重启丢失的进行中任务自然回落为「未开始」。
 */
export class ParseTaskManager {
  constructor({ store, adapter, library }) {
    this.store = store;
    this.adapter = adapter;
    this.library = library;
    /** docId -> Set<page>，内存中的进行中任务。 */
    this.running = new Map();
  }

  isRunning(docId, page) {
    return this.running.get(docId)?.has(page) ?? false;
  }

  status(docId, page) {
    if (this.isRunning(docId, page)) return 'running';
    const record = this.store.getRecord(docId, page);
    if (record) return { status: record.status, record };
    return 'idle';
  }

  /** 启动解析；返回 'started' | 'running' | 'reused'。 */
  start(docId, page) {
    const current = this.status(docId, page);
    if (current === 'running') return 'running';
    if (typeof current === 'object' && current.status === 'succeeded') return 'reused';
    this.runInBackground(docId, page);
    return 'started';
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
}
