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
  }

  docDir(docId) {
    return path.join(this.root, docId);
  }

  pageFile(docId, page) {
    return path.join(this.docDir(docId), `page-${page}.json`);
  }

  /** 读取持久化记录；无记录返回 null（即「未开始」）。 */
  getRecord(docId, page) {
    return readJson(this.pageFile(docId, page), null);
  }

  /**
   * 轻量状态读取（B1）：仅返回状态字段，供进度快照、优先级重排与单页状态查询
   * 使用——不解析 blocks/图片资源。按 mtime+size 判定缓存有效性；记录不存在或
   * 已被外部删除时返回 null 并清缓存。
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

  /** 写路径主动失效缓存，保证下一次 getStatus 读到最新状态。 */
  invalidateStatus(docId, page) {
    this.statusCache.delete(`${docId}:${page}`);
  }

  hasSucceeded(docId, page) {
    return this.getRecord(docId, page)?.status === 'succeeded';
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
    this.invalidateStatus(docId, page);
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
    this.invalidateStatus(docId, page);
    return record;
  }
}
