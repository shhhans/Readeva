import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeFileAtomic } from './fs-utils.js';

export const TRANSLATIONS_SCHEMA_VERSION = 1;
/** 默认目标语言（父规格：翻译默认中文）。 */
export const DEFAULT_TARGET_LANGUAGE = 'zh';
/** 选文源文本上限（字符）：防止无界请求；块文本由解析结果自带，不受此限。 */
export const MAX_TRANSLATION_SOURCE_LENGTH = 20_000;

/**
 * 选文文本归一化：同一选文（空白差异/大小写无关的 Unicode 形式差异）映射到同一
 * 复用键，保证「已有对应译文直接复用」不被空白噪声破坏。块译文不经过这里——
 * 块由 parseId + 块 id 键控，解析身份本身已绑定内容。
 */
export function normalizeSelectionText(text) {
  return String(text ?? '')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim();
}

export function selectionSourceKey(normalizedText) {
  return `selection:${crypto.createHash('sha256').update(normalizedText).digest('hex')}`;
}

export function blockSourceKey(blockId) {
  return `block:${blockId}`;
}

export function translationId(sourceKey, targetLanguage) {
  return `${sourceKey}|${targetLanguage}`;
}

/**
 * 译文存储（Issue #8）：以「文档身份 + 页解析身份（parseId）」为单位持久保存。
 *
 * - 落盘路径 `translations/<docId>/<parseId>.json`：一个 parseId 一个文件，
 *   译文与解析身份天然绑定；页解析被替换（新 parseId）后旧译文不会出现在
 *   新解析的查询结果里（GET 只按当前 parseId 读取）。
 * - 每条译文绑定：documentId、parseId、来源（块 id 或归一化选文文本的
 *   sha256 sourceKey）、目标语言；同键（同来源同语言）覆盖更新，跨语言共存。
 * - 服务重启后直接从磁盘取回（客户端重开恢复），不重新翻译。
 * - 写入是读-改-写：同一文件的并发保存按文档串行链执行，不丢条目；
 *   失败路径（翻译未成功）不产生任何写入——「成功才保存」由调用方与单条
 *   原子写共同保证。
 */
export class TranslationStore {
  constructor(dataDir) {
    this.root = path.join(path.resolve(dataDir), 'translations');
    fs.mkdirSync(this.root, { recursive: true });
    /** 每个译文文件的读-改-写串行链：file → Promise。 */
    this.saveChains = new Map();
  }

  docDir(docId) {
    return path.join(this.root, docId);
  }

  fileFor(docId, parseId) {
    return path.join(this.docDir(docId), `${parseId}.json`);
  }

  /** 读取绑定某次解析的全部译文（保存顺序）；无记录/身份不符返回空数组。 */
  list(docId, parseId) {
    const record = readJson(this.fileFor(docId, parseId), null);
    if (!record || record.parseId !== parseId) return [];
    return Object.values(record.translations ?? {});
  }

  /** 按来源 + 目标语言查找既有译文（复用）；无则 null。 */
  find(docId, parseId, sourceKey, targetLanguage) {
    const record = readJson(this.fileFor(docId, parseId), null);
    if (!record || record.parseId !== parseId) return null;
    return record.translations?.[translationId(sourceKey, targetLanguage)] ?? null;
  }

  /**
   * 保存一条译文（串行链内读-改-写）。调用方必须已完成 parseId 一致性校验；
   * 文件内的 parseId 与目标不一致时拒绝写入（防御：不把译文写进其他解析的文件）。
   */
  save(docId, parseId, entry) {
    const file = this.fileFor(docId, parseId);
    const chain = this.saveChains.get(file) ?? Promise.resolve();
    const next = chain.then(() => this._saveNow(file, docId, parseId, entry));
    // 链上错误不阻断后续保存（每条保存各自感知成败）。
    this.saveChains.set(file, next.catch(() => {}));
    return next;
  }

  async _saveNow(file, docId, parseId, entry) {
    fs.mkdirSync(this.docDir(docId), { recursive: true });
    const record = readJson(file, null) ?? {
      schemaVersion: TRANSLATIONS_SCHEMA_VERSION,
      documentId: docId,
      parseId,
      translations: {},
    };
    if (record.parseId !== parseId) {
      throw new Error(
        `translation record parseId mismatch: expected ${parseId}, found ${record.parseId}`,
      );
    }
    record.translations ??= {};
    record.translations[entry.id] = entry;
    await writeFileAtomic(file, JSON.stringify(record, null, 2));
    return entry;
  }
}
