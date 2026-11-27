import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { readJson, writeFileAtomic } from './fs-utils.js';

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 5;

export class InvalidPdfError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidPdfError';
  }
}

function clampProgress({ page, zoom }, pageCount) {
  let p = Number(page);
  if (!Number.isFinite(p)) p = 1;
  p = Math.floor(p);
  const max = Number.isFinite(pageCount) && pageCount >= 1 ? pageCount : Math.max(p, 1);
  p = Math.min(Math.max(p, 1), max);

  let z = Number(zoom);
  if (!Number.isFinite(z)) z = 1;
  z = Math.min(Math.max(z, MIN_ZOOM), MAX_ZOOM);
  z = Math.round(z * 1000) / 1000;

  return { page: p, zoom: z };
}

/**
 * 书库：管理 PDF 副本、文档内容身份与阅读位置。
 *
 * - 文档身份 = 文件内容 SHA-256 摘要（文档名不作为身份依据，同内容不会重复入库）。
 * - PDF 副本按内容寻址保存为 `library/<sha256>.pdf`。
 * - 阅读位置按文档保存为 `progress/<sha256>.json`，变化后立即持久化。
 */
export class Library {
  constructor(dataDir) {
    this.dataDir = path.resolve(dataDir);
    this.pdfDir = path.join(this.dataDir, 'library');
    this.progressDir = path.join(this.dataDir, 'progress');
    this.documentsFile = path.join(this.dataDir, 'documents.json');
    fs.mkdirSync(this.pdfDir, { recursive: true });
    fs.mkdirSync(this.progressDir, { recursive: true });
    this.documents = readJson(this.documentsFile, {});
    // 单进程内串行化导入，避免并发导入同一内容的检查-写入竞态。
    this.importChain = Promise.resolve();
  }

  static identity(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
  }

  pdfPath(id) {
    return path.join(this.pdfDir, `${id}.pdf`);
  }

  hasPdf(id) {
    return fs.existsSync(this.pdfPath(id));
  }

  /** 读取内容寻址副本字节流（供页解析抽取单页使用）。 */
  readPdf(id) {
    if (!this.hasPdf(id)) {
      const err = new Error('document pdf missing');
      err.status = 404;
      throw err;
    }
    return fs.promises.readFile(this.pdfPath(id));
  }

  importPdf(buffer, name) {
    const task = this.importChain.then(() => this._importPdf(buffer, name));
    this.importChain = task.catch(() => {});
    return task;
  }

  async _importPdf(buffer, name) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      throw new InvalidPdfError('empty upload');
    }
    if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
      throw new InvalidPdfError('not a PDF file');
    }
    let pageCount;
    try {
      const pdf = await PDFDocument.load(buffer, {
        ignoreEncryption: true,
        updateMetadata: false,
      });
      pageCount = pdf.getPageCount();
    } catch (err) {
      throw new InvalidPdfError(`unparsable PDF: ${err.message}`);
    }
    if (!Number.isInteger(pageCount) || pageCount < 1) {
      throw new InvalidPdfError('PDF has no pages');
    }

    const id = Library.identity(buffer);
    const existing = this.documents[id];
    if (existing) {
      return { document: existing, created: false };
    }

    if (!this.hasPdf(id)) {
      await writeFileAtomic(this.pdfPath(id), buffer);
    }
    const now = new Date().toISOString();
    const document = {
      id,
      sha256: id,
      name,
      pageCount,
      sizeBytes: buffer.length,
      createdAt: now,
      updatedAt: now,
      lastReadPage: null,
      lastReadAt: null,
    };
    this.documents[id] = document;
    await writeFileAtomic(this.documentsFile, JSON.stringify(this.documents, null, 2));
    return { document, created: true };
  }

  listDocuments() {
    return Object.values(this.documents).sort((a, b) => {
      const ta = a.lastReadAt ?? a.updatedAt;
      const tb = b.lastReadAt ?? b.updatedAt;
      return tb.localeCompare(ta);
    });
  }

  getDocument(id) {
    return this.documents[id] ?? null;
  }

  async getProgress(id) {
    const saved = readJson(path.join(this.progressDir, `${id}.json`), null);
    if (!saved) return { page: 1, zoom: 1, updatedAt: null };
    return clampProgress(saved, this.getDocument(id)?.pageCount);
  }

  async setProgress(id, page, zoom) {
    const doc = this.getDocument(id);
    if (!doc) {
      const err = new Error('document not found');
      err.status = 404;
      throw err;
    }
    const progress = {
      ...clampProgress({ page, zoom }, doc.pageCount),
      updatedAt: new Date().toISOString(),
    };
    await writeFileAtomic(
      path.join(this.progressDir, `${id}.json`),
      JSON.stringify(progress, null, 2),
    );
    doc.lastReadPage = progress.page;
    doc.lastReadAt = progress.updatedAt;
    await writeFileAtomic(this.documentsFile, JSON.stringify(this.documents, null, 2));
    return progress;
  }
}
