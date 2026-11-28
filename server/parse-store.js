import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeFileAtomic } from './fs-utils.js';

export const PARSE_SCHEMA_VERSION = 1;

/**
 * 页解析存储：以「文档身份 + 页码」为单位保存解析记录。
 *
 * - 状态含未开始（无记录）、running（仅内存）、succeeded / failed（持久化）。
 * - succeeded 记录保留解析身份（parseId）、结构化内容块、解析元信息。
 * - 服务重启后已完成解析直接从磁盘取回，不重新解析。
 *
 * 轻量状态读取（B1）+ 状态索引（Issue #6）：
 * - `getStatus` 只读状态字段（status/parseId/error/updatedAt），按 mtime+size 命中
 *   内存缓存，不解析 blocks/base64 图片；内容块仅在结果获取时读取。
 * - 每文档一张状态索引 `parses/<sha>/index.json`：保存时增量更新（按文档串行链，
 *   避免并发保存的读-改-写竞态），冷启动时 `getStatus` 先经索引取状态字段，
 *   彻底消除「重启后首轮逐页读全量记录」；索引条目记录页文件的 mtime+size，
 *   与当前 stat 不匹配（页文件被外部改动/替换）时回退逐页读盘，正确性不依赖索引。
 * - 索引缺失/损坏（如测试直接落盘页记录）时同样回退逐页读盘。
 */
export class ParseStore {
  constructor(dataDir) {
    this.root = path.join(path.resolve(dataDir), 'parses');
    fs.mkdirSync(this.root, { recursive: true });
    /**
     * 轻量状态索引缓存（B1）：`<docId>:<page>` → { mtimeMs, size, status }。
     * 只缓存 status/parseId/error/updatedAt 几个字段，不缓存 blocks/base64 图片；
     * 进度快照、优先级重排与单页状态查询按 mtime+size 命中，避免每轮全量读盘。
     */
    this.statusCache = new Map();
    /** 文档状态索引缓存：docId → { mtimeMs, size, entries }（entries = 解析后的 index.json）。 */
    this.indexCache = new Map();
    /** 每文档的状态索引写链（串行化读-改-写，避免并发保存丢条目）。 */
    this.indexChains = new Map();
  }

  docDir(docId) {
    return path.join(this.root, docId);
  }

  pageFile(docId, page) {
    return path.join(this.docDir(docId), `page-${page}.json`);
  }

  indexFile(docId) {
    return path.join(this.docDir(docId), 'index.json');
  }

  /** 读取持久化记录；无记录返回 null（即「未开始」）。 */
  getRecord(docId, page) {
    return readJson(this.pageFile(docId, page), null);
  }

  /**
   * 轻量状态读取（B1）：仅返回状态字段，供进度快照、优先级重排与单页状态查询
   * 使用——不解析 blocks/图片资源。按 mtime+size 判定缓存有效性；记录不存在或
   * 已被外部删除时返回 null 并清缓存。
   *
   * 读取顺序（Issue #6 状态索引加速）：
   *   1. 页文件 stat 不存在 → 未开始（索引条目一律不覆盖「文件存在性」）；
   *   2. 内存 statusCache 命中（mtime+size 一致）→ 直接返回；
   *   3. 文档状态索引条目与当前页文件 stat 一致 → 取状态字段（冷启动免全量读盘）；
   *   4. 回退：逐页读盘（索引缺失/过期/损坏或页文件被外部改动时）。
   */
  getStatus(docId, page) {
    const file = this.pageFile(docId, page);
    const key = `${docId}:${page}`;
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      this.statusCache.delete(key);
      return null;
    }
    const cached = this.statusCache.get(key);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.status;
    }
    // 状态索引加速（冷启动免首轮逐页读全量）。
    const indexEntry = this.readIndex(docId)?.pages?.[String(page)] ?? null;
    if (
      indexEntry &&
      indexEntry.pageFileMtimeMs === stat.mtimeMs &&
      indexEntry.pageFileSize === stat.size
    ) {
      const status = {
        status: indexEntry.status,
        parseId: indexEntry.parseId ?? null,
        error: indexEntry.error ?? null,
        updatedAt: indexEntry.updatedAt ?? null,
      };
      this.statusCache.set(key, { mtimeMs: stat.mtimeMs, size: stat.size, status });
      return status;
    }
    const record = readJson(file, null);
    if (!record) {
      this.statusCache.delete(key);
      return null;
    }
    const status = {
      status: record.status,
      parseId: record.parseId ?? null,
      error: record.error ?? null,
      updatedAt: record.updatedAt ?? null,
    };
    this.statusCache.set(key, { mtimeMs: stat.mtimeMs, size: stat.size, status });
    return status;
  }

  /**
   * 读取文档状态索引（按 mtime+size 缓存）。索引缺失/损坏返回 null：
   * 调用方回退逐页读盘，正确性不依赖索引。
   */
  readIndex(docId) {
    const file = this.indexFile(docId);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      this.indexCache.delete(docId);
      return null;
    }
    const cached = this.indexCache.get(docId);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.entries;
    }
    const parsed = readJson(file, null);
    if (!parsed || typeof parsed.pages !== 'object' || parsed.pages === null) {
      this.indexCache.delete(docId);
      return null;
    }
    this.indexCache.set(docId, { mtimeMs: stat.mtimeMs, size: stat.size, entries: parsed });
    return parsed;
  }

  /** 写路径主动失效缓存，保证下一次 getStatus 读到最新状态。 */
  invalidateStatus(docId, page) {
    this.statusCache.delete(`${docId}:${page}`);
  }

  /**
   * 保存后更新状态索引与内存缓存（B1 + 冷启动加速）：
   * 先取页文件写入后的 stat，刷新 statusCache；再把该页状态字段写入文档
   * 状态索引（按文档串行链，避免并发读-改-写竞态）。索引写失败不影响正确性
   * （getStatus 回退逐页读盘），仅记录告警。
   */
  indexStatus(docId, page, status) {
    const file = this.pageFile(docId, page);
    const key = `${docId}:${page}`;
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return Promise.resolve();
    }
    const statusView = {
      status: status.status,
      parseId: status.parseId ?? null,
      error: status.error ?? null,
      updatedAt: status.updatedAt ?? null,
    };
    this.statusCache.set(key, { mtimeMs: stat.mtimeMs, size: stat.size, status: statusView });
    const chain = this.indexChains.get(docId) ?? Promise.resolve();
    const next = chain.then(() => this._writeIndexEntry(docId, page, statusView, stat));
    this.indexChains.set(docId, next.catch(() => {}));
    return next;
  }

  async _writeIndexEntry(docId, page, status, pageStat) {
    try {
      const file = this.indexFile(docId);
      const current = this.readIndex(docId);
      const index =
        current ?? { schemaVersion: PARSE_SCHEMA_VERSION, documentId: docId, pages: {} };
      index.pages[String(page)] = {
        status: status.status,
        parseId: status.parseId,
        error: status.error,
        updatedAt: status.updatedAt,
        // 页文件写入时的 mtime+size：冷启动时据此判定索引条目是否仍与页文件一致。
        pageFileMtimeMs: pageStat.mtimeMs,
        pageFileSize: pageStat.size,
      };
      await writeFileAtomic(file, JSON.stringify(index, null, 2));
      const stat = fs.statSync(file);
      this.indexCache.set(docId, { mtimeMs: stat.mtimeMs, size: stat.size, entries: index });
    } catch (err) {
      console.warn(`parse status index write failed (doc=${docId} page=${page}): ${err.message}`);
    }
  }

  /**
   * 清理不再存在于书库的文档的状态缓存条目（与文档删除能力联动；
   * 删除未实现时防止缓存无界增长）。
   */
  pruneStatusCache(validDocIds) {
    if (this.statusCache.size === 0 && this.indexCache.size === 0) return;
    for (const key of [...this.statusCache.keys()]) {
      const docId = key.slice(0, key.indexOf(':'));
      if (!validDocIds.has(docId)) this.statusCache.delete(key);
    }
    for (const docId of [...this.indexCache.keys()]) {
      if (!validDocIds.has(docId)) this.indexCache.delete(docId);
    }
  }

  hasSucceeded(docId, page) {
    return this.getStatus(docId, page)?.status === 'succeeded';
  }

  ensureDocDir(docId) {
    fs.mkdirSync(this.docDir(docId), { recursive: true });
  }

  async saveResult(docId, page, { parseId, blocks, meta }) {
    this.ensureDocDir(docId);
    const record = {
      schemaVersion: PARSE_SCHEMA_VERSION,
      documentId: docId,
      page,
      status: 'succeeded',
      parseId,
      blocks,
      meta,
      updatedAt: new Date().toISOString(),
    };
    await writeFileAtomic(this.pageFile(docId, page), JSON.stringify(record, null, 2));
    await this.indexStatus(docId, page, {
      status: 'succeeded',
      parseId,
      error: null,
      updatedAt: record.updatedAt,
    });
    return record;
  }

  async saveFailure(docId, page, error, { requestedAt } = {}) {
    this.ensureDocDir(docId);
    const record = {
      schemaVersion: PARSE_SCHEMA_VERSION,
      documentId: docId,
      page,
      status: 'failed',
      error: String(error?.message ?? error),
      meta: {
        engine: 'docling',
        requestedAt: requestedAt ?? null,
        failedAt: new Date().toISOString(),
      },
      updatedAt: new Date().toISOString(),
    };
    await writeFileAtomic(this.pageFile(docId, page), JSON.stringify(record, null, 2));
    await this.indexStatus(docId, page, {
      status: 'failed',
      parseId: null,
      error: record.error,
      updatedAt: record.updatedAt,
    });
    return record;
  }
}
