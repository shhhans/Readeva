import fs from 'node:fs';
import path from 'node:path';

/**
 * 词典数据未准备错误：目录不存在、构建产物缺失或损坏时抛出，
 * 服务端据此向客户端返回 503（与解析服务未配置的降级语义一致）。
 */
export class DictionaryNotPreparedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DictionaryNotPreparedError';
  }
}

/**
 * 查询词长度上限（归一化后的字符数）。
 * 超长查询不再报「非法参数」，而是与「未收录」同一语义（404 未收录）：
 * 超长文本（整段选文等）必然不在词典里，报错对用户没有意义。
 */
export const MAX_LOOKUP_LENGTH = 80;

/**
 * 归一化查询词：返回小写查询键；无有效查询词（缺参/仅空白）时返回 null。
 *
 * - Unicode NFC 归一；弯引号/破折号折算为常见 ASCII 形态；
 * - 连续空白折叠为单个空格（支持词组词条，如 “cabin pressure”）；
 * - 去掉首尾的标点/符号，但保留词条中实际存在的撇号与连字符
 *   （ECDICT 收录 ‘hood、-gate 这类以撇号/连字符开头的词条）；
 * - 查询键统一小写（构建时同样按小写键索引，大小写不敏感）。
 *
 * 长度判定在调用方完成（见 MAX_LOOKUP_LENGTH）：归一化本身不再丢弃超长词。
 */
export function normalizeLookupKey(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw
    .normalize('NFC')
    .replace(/[\u2018\u2019\u02BC]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  const keep = new Set(["'", '-']);
  const punct = /[\p{P}\p{S}]/u;
  while (s.length > 0 && punct.test(s[0]) && !keep.has(s[0])) {
    s = s.slice(1);
  }
  while (s.length > 0 && punct.test(s[s.length - 1]) && !keep.has(s[s.length - 1])) {
    s = s.slice(0, -1);
  }
  s = s.trim();
  if (s.length === 0) return null;
  return s.toLowerCase();
}

/**
 * ECDICT 归因信息（内嵌常量）：许可 + 上游数据来源。
 * 与 `scripts/build-dictionary.mjs` 落盘到 manifest 的声明一致；
 * manifest 缺少相应字段时回落到这里（结果卡片页脚展示真实归因）。
 */
export const DEFAULT_DICTIONARY_ATTRIBUTION = {
  license: {
    name: 'MIT',
    url: 'https://github.com/skywind3000/ECDICT/blob/master/LICENSE',
    copyright: 'Copyright (c) 2025 Linwei (skywind3000)',
  },
  dataSources:
    '词条数据整理自公开资料：EDictAZ.txt、四六级至 GRE 词汇表（音标由作者补充）、' +
    'cdict-1.0-1 开源字典数据，并按英国国家语料库（BNC）校对与社区贡献增补；' +
    '来源与许可说明见 https://github.com/skywind3000/ECDICT。',
};

/**
 * 从构建产物 manifest 解析归因信息（许可 + 上游数据来源）。
 *
 * - manifest 带许可/来源字段 → 采用构建时的真实声明；
 * - manifest 缺字段 → 逐字段回落到内嵌常量（DEFAULT_DICTIONARY_ATTRIBUTION）；
 * - manifest 完全没有归因信息 → 返回 null（调用方据此降级为静态文案）。
 */
export function resolveAttribution(manifest) {
  const raw = manifest?.license && typeof manifest.license === 'object' ? manifest.license : null;
  const name = typeof raw?.name === 'string' && raw.name.trim() ? raw.name.trim() : null;
  const dataSources =
    (typeof raw?.dataSources === 'string' && raw.dataSources.trim() && raw.dataSources.trim()) ||
    (typeof manifest?.dataSources === 'string' && manifest.dataSources.trim() && manifest.dataSources.trim()) ||
    null;
  if (!name && !dataSources) return null;
  return {
    license: {
      name: name ?? DEFAULT_DICTIONARY_ATTRIBUTION.license.name,
      url: raw?.url ?? DEFAULT_DICTIONARY_ATTRIBUTION.license.url,
      copyright: raw?.copyright ?? DEFAULT_DICTIONARY_ATTRIBUTION.license.copyright,
    },
    dataSources: dataSources ?? DEFAULT_DICTIONARY_ATTRIBUTION.dataSources,
  };
}

/**
 * ECDICT 离线词典存储。
 *
 * 数据由 `scripts/build-dictionary.mjs` 从 ecdict.csv 一次性构建：
 * - `ecdict.words.bin`：按小写键字节序排序的内存索引，记录
 *   [keyLen u8][key utf8][offset u32][length u32]；
 * - `ecdict.entries.jsonl`：每行一个词条 JSON（与索引顺序一致）；
 * - `manifest.json`：数据来源、许可声明与统计（完整性标记，最后写入）。
 *
 * 查询是纯本地操作（内存索引二分 + 一次文件切片读取），不访问网络；
 * 首次查询时惰性加载，词典文件缺失视为「未准备」而非致命错误，
 * 且在数据准备好后无需重启即可恢复（每次失败后重置加载状态）。
 */
export class DictionaryStore {
  constructor(dir) {
    this.dir = path.resolve(dir);
    this.indexFile = path.join(this.dir, 'ecdict.words.bin');
    this.dataFile = path.join(this.dir, 'ecdict.entries.jsonl');
    this.manifestFile = path.join(this.dir, 'manifest.json');
    this._loadPromise = null;
    this._loaded = false;
    this._index = null;
    this._starts = null;
    this._fd = null;
    this.manifest = null;
    this.attribution = null;
  }

  /** 惰性加载；失败时抛 DictionaryNotPreparedError（或损坏时的普通 Error）。 */
  async ensureLoaded() {
    if (this._loaded) return;
    if (!this._loadPromise) {
      this._loadPromise = this._load().catch((err) => {
        this._loadPromise = null; // 下次查询重试：数据可能在运行中被构建好
        throw err;
      });
    }
    await this._loadPromise;
  }

  async _load() {
    let manifest;
    try {
      manifest = JSON.parse(await fs.promises.readFile(this.manifestFile, 'utf8'));
    } catch {
      throw new DictionaryNotPreparedError('dictionary manifest missing');
    }
    let index;
    try {
      index = await fs.promises.readFile(this.indexFile);
    } catch {
      throw new DictionaryNotPreparedError('dictionary index missing');
    }
    if (index.length === 0) {
      throw new DictionaryNotPreparedError('dictionary index empty');
    }
    const starts = [];
    let pos = 0;
    while (pos < index.length) {
      const keyLen = index[pos];
      const recordEnd = pos + 1 + keyLen + 8;
      if (recordEnd > index.length) {
        throw new DictionaryNotPreparedError('dictionary index corrupt');
      }
      starts.push(pos);
      pos = recordEnd;
    }
    this._index = index;
    this._starts = Uint32Array.from(starts);
    try {
      this._fd = await fs.promises.open(this.dataFile, 'r');
    } catch {
      throw new DictionaryNotPreparedError('dictionary entries missing');
    }
    this.manifest = manifest;
    // 归因（许可 + 上游数据来源）：来自构建产物 manifest，缺字段时用内嵌常量。
    this.attribution = resolveAttribution(manifest);
    this._loaded = true;
    const count = manifest.entryCount ?? this._starts.length;
    console.log(`Readeva dictionary: ${count} entries from ${this.dir}`);
  }

  /** 二分查找小写键 → 词条 JSON 对象；未收录返回 null。 */
  async lookup(key) {
    await this.ensureLoaded();
    const hit = this._search(key);
    if (!hit) return null;
    const buf = Buffer.alloc(hit.length);
    await this._fd.read(buf, 0, hit.length, hit.offset);
    return JSON.parse(buf.toString('utf8'));
  }

  _search(key) {
    const query = Buffer.from(key, 'utf8');
    const index = this._index;
    const starts = this._starts;
    let lo = 0;
    let hi = starts.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const at = starts[mid];
      const keyLen = index[at];
      const cmp = query.compare(index, at + 1, at + 1 + keyLen);
      if (cmp === 0) {
        const offset = index.readUInt32LE(at + 1 + keyLen);
        const length = index.readUInt32LE(at + 1 + keyLen + 4);
        return { offset, length };
      }
      if (cmp < 0) hi = mid - 1;
      else lo = mid + 1;
    }
    return null;
  }

  /**
   * 归因信息（许可 + 上游数据来源），供接口回传给前端展示真实 attribution。
   * 词典未准备（manifest 不可读）或 manifest 无归因信息时返回 null。
   */
  getAttribution() {
    return this.attribution;
  }

  /** 释放文件句柄（测试与优雅关闭用；不影响持久化数据）。 */
  async close() {
    this._loaded = false;
    this._loadPromise = null;
    this._index = null;
    this._starts = null;
    if (this._fd) {
      const fd = this._fd;
      this._fd = null;
      await fd.close().catch(() => {});
    }
  }
}
