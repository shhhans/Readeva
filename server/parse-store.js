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
    return record;
  }
}
