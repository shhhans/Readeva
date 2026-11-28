import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

/**
 * ECDICT 词典数据许可与来源声明（保留所需许可声明，随 manifest 落盘）。
 * 词典仓库：https://github.com/skywind3000/ECDICT（MIT License）。
 */
const ECDICT_LICENSE = {
  name: 'MIT',
  url: 'https://github.com/skywind3000/ECDICT/blob/master/LICENSE',
  copyright: 'Copyright (c) 2025 Linwei (skywind3000)',
  text: [
    'MIT License',
    '',
    'Copyright (c) 2025 Linwei',
    '',
    'Permission is hereby granted, free of charge, to any person obtaining a copy',
    'of this software and associated documentation files (the "Software"), to deal',
    'in the Software without restriction, including without limitation the rights',
    'to use, copy, modify, merge, publish, distribute, sublicense, and/or sell',
    'copies of the Software, and to permit persons to whom the Software is',
    'furnished to do so, subject to the following conditions:',
    '',
    'The above copyright notice and this permission notice shall be included in all',
    'copies or substantial portions of the Software.',
    '',
    'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
    'IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,',
    'FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE',
    'AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER',
    'LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,',
    'OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE',
    'SOFTWARE.',
  ].join('\n'),
  dataSources:
    '词条数据整理自公开资料：EDictAZ.txt、四六级至 GRE 词汇表（音标由作者补充）、' +
    'cdict-1.0-1 开源字典数据，并按英国国家语料库（BNC）校对与社区贡献增补；' +
    '来源与许可说明见 https://github.com/skywind3000/ECDICT。',
};

const CSV_COLUMNS = [
  'word',
  'phonetic',
  'definition',
  'translation',
  'pos',
  'collins',
  'oxford',
  'tag',
  'bnc',
  'frq',
  'exchange',
  'detail',
  'audio',
];

/**
 * ECDICT CSV 的必需表头列（构建实际使用的列；detail/audio 只读取不使用）。
 */
const REQUIRED_COLUMNS = [
  'word',
  'phonetic',
  'definition',
  'translation',
  'pos',
  'collins',
  'oxford',
  'tag',
  'bnc',
  'frq',
  'exchange',
];

/**
 * 词条数下限：解析出的词条明显少于该值时，判定「下载到了错误文件」
 * （HTML 错误页 / 截断文件 / 代理返回的占位内容），构建直接失败，
 * 避免产出空词典或残缺词典。
 *
 * 可调：命令行 `--min-entries N` 或环境变量 `READEVA_DICT_MIN_ENTRIES`。
 * 正式 ECDICT 词条约 34 万条，1000 是很宽松的下限（只挡明显异常）。
 */
export const DEFAULT_MIN_ENTRIES = 1000;

/**
 * 嗅探「下载到的不是 ECDICT 词条表」：HTML/XML 错误页、Git LFS 指针。
 * 命中即抛错，并给出可操作的提示。
 */
export function assertCsvIsDictionary({ text, fileName }) {
  const head = text.slice(0, 1024).trimStart().toLowerCase();
  if (head.startsWith('<!doctype html') || head.startsWith('<html') || head.startsWith('<?xml')) {
    throw new Error(
      `dictionary csv is not a CSV file: ${fileName} looks like an HTML/XML page ` +
      '(downloaded an error page instead of ecdict.csv) — please re-download ' +
      'https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv',
    );
  }
  if (head.startsWith('version https://git-lfs.github.com/spec')) {
    throw new Error(
      `dictionary csv is a Git LFS pointer, not the dictionary data: ${fileName} — ` +
      "please download the raw file (git lfs pull or the raw.githubusercontent.com URL)",
    );
  }
}

/**
 * 表头校验：必需列齐全 + 列数与预期一致。
 * 列数不符通常意味着拿到的不是 ECDICT 词条表（表头被截断或换了文件）。
 */
export function assertCsvHeader(header) {
  const missing = REQUIRED_COLUMNS.filter((col) => !header.includes(col));
  if (missing.length > 0) {
    throw new Error(
      `unexpected csv header: missing column(s) ${missing.join(',')} ` +
      `(expected first row with '${CSV_COLUMNS.join(',')}', got ${header.slice(0, 5).join(',')})`,
    );
  }
  if (header.length !== CSV_COLUMNS.length) {
    throw new Error(
      `unexpected csv header: expected ${CSV_COLUMNS.length} columns ` +
      `('${CSV_COLUMNS.join(',')}'), got ${header.length} ('${header.join(',')}') — ` +
      'if upstream added a column, update CSV_COLUMNS in this script',
    );
  }
}

/**
 * 解析一段 CSV 文本为行数组。RFC4180 规则：
 * 双引号包裹的字段可包含逗号/换行（"" 转义引号）；ECDICT 用引号包裹
 * 含逗号的字段，换行以字面 “\n” 两个字符表示（本函数原样保留，由
 * 展示层转换为多行）。
 */
export function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const n = text.length;
  let i = 0;
  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
      } else {
        field += ch;
        i += 1;
      }
    } else if (ch === '"') {
      inQuotes = true;
      i += 1;
    } else if (ch === ',') {
      row.push(field);
      field = '';
      i += 1;
    } else if (ch === '\r') {
      i += 1;
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
    } else {
      field += ch;
      i += 1;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function toIntOrNull(value) {
  const trimmed = String(value ?? '').trim();
  if (!/^-?\d+$/.test(trimmed)) return null;
  const num = Number(trimmed);
  return Number.isSafeInteger(num) ? num : null;
}

/**
 * ECDICT 的释义字段用字面 “\n”（反斜杠 + n）两个字符表示换行；
 * 构建时转换为真实换行，API 契约统一为“以真实换行分行”。
 */
function decodeLineBreaks(value) {
  return value ? String(value).replace(/\\n/g, '\n') : value;
}

/** CSV 行 → 词条对象；无效行返回 null。 */
function rowToEntry(row) {
  if (row.length < 2) return null;
  const word = String(row[0] ?? '').trim();
  if (!word) return null;
  const [, phonetic, definition, translation, pos, collins, oxford, tag, bnc, frq, exchange] = row;
  // detail（例句 JSON）与 audio（网络音频 URL）不进入离线数据：断网仍可完整展示释义。
  return {
    word,
    phonetic: phonetic || null,
    definition: decodeLineBreaks(definition) || null,
    translation: decodeLineBreaks(translation) || null,
    pos: pos || null,
    collins: toIntOrNull(collins),
    oxford: toIntOrNull(oxford),
    tag: tag || null,
    bnc: toIntOrNull(bnc),
    frq: toIntOrNull(frq),
    exchange: exchange || null,
  };
}

/**
 * 从 ECDICT 的 ecdict.csv 构建本地查询数据：
 * - 构建前校验 CSV（表头列数/必需列 + 词条数下限），避免「下载到错误文件」
 *   （HTML 错误页/截断文件）时静默产出空词典；
 * - 小写键去重（同键保留首个出现的词条，统计为 duplicates）；
 * - 按小写键的 UTF-8 字节序排序，写入 `ecdict.entries.jsonl`（每行一个词条
 *   JSON）并记录每条的文件偏移；
 * - `ecdict.words.bin` 内存索引：[keyLen u8][key utf8][offset u32][length u32]；
 * - `manifest.json` 数据来源/许可/统计，最后写入（作为完整性标记）。
 *
 * 全部产物先写入临时目录、整体就绪后原子换入 outDir，中断不会留下半成品。
 */
export async function buildDictionary({
  csvPath,
  outDir,
  sourceUrl,
  minEntries = DEFAULT_MIN_ENTRIES,
}) {
  csvPath = path.resolve(csvPath);
  outDir = path.resolve(outDir ?? path.join(repoRoot, 'data', 'dict', 'ecdict'));
  sourceUrl = sourceUrl ?? 'https://github.com/skywind3000/ECDICT（ecdict.csv）';
  minEntries =
    Number.isFinite(minEntries) && minEntries >= 0 ? Math.floor(minEntries) : DEFAULT_MIN_ENTRIES;

  const csvBytes = fs.readFileSync(csvPath);
  const text = csvBytes.toString('utf8');
  // 兼容个别发行版可能带有的 UTF-8 BOM。
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  // (1) 下载到错误文件的最常见形态：HTML 错误页 / Git LFS 指针。
  assertCsvIsDictionary({ text: body, fileName: path.basename(csvPath) });

  const rows = parseCsvRows(body);
  if (rows.length === 0) {
    throw new Error('dictionary csv is empty');
  }
  // (2) 表头校验：必需列齐全 + 列数与预期一致。
  const header = rows[0].map((c) => c.trim().toLowerCase());
  assertCsvHeader(header);
  const dataRows = rows.slice(1);

  const entries = new Map(); // key → entry（保留首次出现）
  let duplicates = 0;
  let skipped = 0;
  let malformedRows = 0; // 字段数与表头不一致的行（截断/拼接错误时出现）
  for (const row of dataRows) {
    if (row.length !== header.length) malformedRows += 1;
    const entry = rowToEntry(row);
    if (!entry) {
      skipped += 1;
      continue;
    }
    const key = entry.word.normalize('NFC').toLowerCase();
    if (key.length === 0 || key.length > 255) {
      skipped += 1;
      continue;
    }
    if (entries.has(key)) {
      duplicates += 1;
      continue;
    }
    entries.set(key, entry);
  }

  // (3) 词条数下限：明显异常（HTML 错误页/截断下载）直接失败，不产出空词典。
  if (entries.size < minEntries) {
    throw new Error(
      `dictionary csv looks wrong: only ${entries.size} entries parsed ` +
      `(expected at least ${minEntries}) — the downloaded file is probably an HTML error page ` +
      'or a truncated download; please re-download ecdict.csv and retry',
    );
  }

  const warnings = [];
  if (malformedRows > 0) {
    warnings.push(
      `${malformedRows}/${dataRows.length} data rows have a different column count than the header`,
    );
  }

  const keys = [...entries.keys()];
  // 按小写键的 UTF-8 字节序排序（与运行时二分查找的比较方式一致）。
  keys.sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));

  // 临时目录构建，成功后整体换入目标目录（Windows 上旧目录先改名让位）。
  const staging = `${outDir}.tmp-${process.pid}`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });

  const jsonlPath = path.join(staging, 'ecdict.entries.jsonl');
  const binPath = path.join(staging, 'ecdict.words.bin');
  const jsonlChunks = [];
  const binChunks = [];
  let offset = 0;
  for (const key of keys) {
    const entry = entries.get(key);
    const line = JSON.stringify(entry);
    const lineBuf = Buffer.from(`${line}\n`, 'utf8');
    const keyBuf = Buffer.from(key, 'utf8');
    const record = Buffer.alloc(1 + keyBuf.length + 8);
    record.writeUInt8(keyBuf.length, 0);
    keyBuf.copy(record, 1);
    record.writeUInt32LE(offset, 1 + keyBuf.length);
    record.writeUInt32LE(lineBuf.length, 1 + keyBuf.length + 4);
    jsonlChunks.push(lineBuf);
    binChunks.push(record);
    offset += lineBuf.length;
  }
  fs.writeFileSync(jsonlPath, Buffer.concat(jsonlChunks));
  fs.writeFileSync(binPath, Buffer.concat(binChunks));

  const manifest = {
    format: 1,
    source: 'ECDICT',
    sourceUrl,
    sourceFile: {
      name: path.basename(csvPath),
      bytes: csvBytes.length,
      sha256: crypto.createHash('sha256').update(csvBytes).digest('hex'),
    },
    builtAt: new Date().toISOString(),
    entryCount: keys.length,
    duplicateKeys: duplicates,
    license: ECDICT_LICENSE,
    validation: {
      minEntries,
      dataRows: dataRows.length,
      malformedRows,
      columns: CSV_COLUMNS,
    },
  };
  fs.writeFileSync(path.join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  // 整体换入：旧目录改名让位 → 暂存目录就位 → 删除旧目录。
  const previous = `${outDir}.old-${Date.now()}`;
  let replaced = false;
  if (fs.existsSync(outDir)) {
    fs.renameSync(outDir, previous);
    replaced = true;
  }
  try {
    fs.renameSync(staging, outDir);
  } catch (err) {
    if (replaced) fs.renameSync(previous, outDir);
    throw err;
  }
  if (replaced) {
    fs.rmSync(previous, { recursive: true, force: true });
  }

  return {
    outDir,
    entryCount: keys.length,
    duplicates,
    skipped,
    malformedRows,
    minEntries,
    warnings,
    files: {
      'ecdict.entries.jsonl': fs.statSync(path.join(outDir, 'ecdict.entries.jsonl')).size,
      'ecdict.words.bin': fs.statSync(path.join(outDir, 'ecdict.words.bin')).size,
      'manifest.json': fs.statSync(path.join(outDir, 'manifest.json')).size,
    },
  };
}

/* ---------------- CLI ---------------- */

function parseArg(argv, flag) {
  const index = argv.indexOf(flag);
  if (index >= 0 && argv[index + 1]) return argv[index + 1];
  return undefined;
}

export async function main(argv) {
  const csvPath = parseArg(argv, '--csv');
  if (!csvPath) {
    console.error('用法: node scripts/build-dictionary.mjs --csv <ecdict.csv 路径> [--out <输出目录>] [--min-entries <下限>]');
    console.error('  --csv  下载好的 ecdict.csv（ECDICT 仓库 master 分支，约 63MB）');
    console.error('  --out  输出目录（默认 <项目目录>\\data\\dict\\ecdict，服务默认从此读取）');
    console.error(
      `  --min-entries  词条数下限（默认 ${DEFAULT_MIN_ENTRIES}，也可用 READEVA_DICT_MIN_ENTRIES）：` +
        '解析出的词条少于该值时直接失败（下载到错误文件/截断文件）',
    );
    return 1;
  }
  const outDir = parseArg(argv, '--out');
  const minEntriesFlag = parseArg(argv, '--min-entries');
  const minEntries =
    minEntriesFlag !== undefined
      ? Number(minEntriesFlag)
      : Number(process.env.READEVA_DICT_MIN_ENTRIES ?? DEFAULT_MIN_ENTRIES);
  try {
    const summary = await buildDictionary({ csvPath, outDir, minEntries });
    console.log(`词典构建完成：${summary.entryCount} 条词条（去重 ${summary.duplicates}，跳过 ${summary.skipped}）`);
    console.log(`输出目录: ${summary.outDir}`);
    for (const [file, bytes] of Object.entries(summary.files)) {
      console.log(`  ${file}: ${(bytes / 1024 / 1024).toFixed(1)} MB`);
    }
    for (const warning of summary.warnings) {
      console.warn(`警告: ${warning}`);
    }
    console.log('重启 Readeva 服务后即可离线查词（无需其他配置）。');
    return 0;
  } catch (err) {
    console.error(`词典构建失败: ${err.message}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
