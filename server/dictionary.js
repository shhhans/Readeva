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
 * 归一化查询词：返回小写查询键；无有效查询词（空/超长）时返回 null。
 *
 * - Unicode NFC 归一；弯引号/破折号折算为常见 ASCII 形态；
 * - 连续空白折叠为单个空格（支持词组词条，如 “cabin pressure”）；
 * - 去掉首尾的标点/符号，但保留词条中实际存在的撇号与连字符
 *   （ECDICT 收录 ‘hood、-gate 这类以撇号/连字符开头的词条）；
 * - 查询键统一小写（构建时同样按小写键索引，大小写不敏感）。
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
  if (s.length === 0 || s.length > 80) return null;
  return s.toLowerCase();
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
