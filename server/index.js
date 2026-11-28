import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Library, InvalidPdfError } from './library.js';
import { DoclingAdapter } from './docling.js';
import { ParseStore } from './parse-store.js';
import { ParseTaskManager, buildParseProgress } from './page-tasks.js';
import { DictionaryStore, DictionaryNotPreparedError, normalizeLookupKey, MAX_LOOKUP_LENGTH } from './dictionary.js';
import {
  MiniMaxTranslator,
  MinimaxServiceError,
  MINIMAX_MODEL,
  DEFAULT_MINIMAX_BASE_URL,
  MINIMAX_API_KEY_ENV,
} from './minimax.js';
import {
  TranslationStore,
  DEFAULT_TARGET_LANGUAGE,
  MAX_TRANSLATION_SOURCE_LENGTH,
  normalizeSelectionText,
  selectionSourceKey,
  blockSourceKey,
  translationId,
} from './translations.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const APP_VERSION = '0.1.0';

function parseArg(argv, flag) {
  const index = argv.indexOf(flag);
  if (index >= 0 && argv[index + 1]) return argv[index + 1];
  return undefined;
}

const dataDirOption =
  parseArg(process.argv, '--data-dir') ?? process.env.READEVA_DATA_DIR ?? path.join(repoRoot, 'data');

const config = {
  host: parseArg(process.argv, '--host') ?? process.env.READEVA_HOST ?? '127.0.0.1',
  port: Number(
    parseArg(process.argv, '--port') ?? process.env.READEVA_PORT ?? 8787,
  ),
  dataDir: dataDirOption,
  // Docling 解析服务地址（服务端配置，客户端不接触解析服务地址与密钥）。
  doclingUrl:
    parseArg(process.argv, '--docling-url') ?? process.env.READEVA_DOCLING_URL ?? '',
  doclingPollIntervalMs: Number(
    parseArg(process.argv, '--docling-poll-interval-ms') ??
      process.env.READEVA_DOCLING_POLL_INTERVAL_MS ??
      500,
  ),
  doclingTimeoutMs: Number(
    parseArg(process.argv, '--docling-timeout-ms') ??
      process.env.READEVA_DOCLING_TIMEOUT_MS ??
      300_000,
  ),
  // 页解析并发上限（Issue #5）：与解析服务能力匹配，默认 2（docling_service 线程池
  // 同步为 2，共享已加载模型），最小 1；本机 2GB pagefile 建议不超过 2。
  parseConcurrency: Number(
    parseArg(process.argv, '--parse-concurrency') ??
      process.env.READEVA_PARSE_CONCURRENCY ??
      2,
  ),
  // 背景扫全派发节流固定覆盖（毫秒）：>0 时使用固定间隔；0/未设置 = 动态 pacing
  // （间隔 = 最近转换耗时估计 × 系数）。
  parseSweepDelayMs: Number(
    parseArg(process.argv, '--parse-sweep-delay-ms') ??
      process.env.READEVA_PARSE_SWEEP_DELAY_MS ??
      0,
  ),
  // 动态 pacing 系数：间隔 = 估计转换耗时 × 系数（默认 0.5；>0.5 时并发 2 出现 CPU 空隙）。
  parseSweepPacingFactor: Number(
    parseArg(process.argv, '--parse-sweep-pacing-factor') ??
      process.env.READEVA_PARSE_SWEEP_PACING_FACTOR ??
      0.5,
  ),
  // 客户端会话宽限期（毫秒，Issue #6）：超过该时长无客户端活动（阅读位置上报/
  // 进度轮询/状态轮询等）即视为客户端退出——完成已开始页、清除未开始队列。
  // 默认 300000（5 分钟）：浏览器隐藏标签页会节流页面内定时器（约 1 次/分钟），
  // 阅读视图内 8s 慢刷新心跳被稀释后仍需留足余量，避免正常阅读被误判退出；
  // 默认值必须大于客户端心跳间隔（README 注明取舍）。
  clientGraceMs: Number(
    parseArg(process.argv, '--client-grace-ms') ??
      process.env.READEVA_CLIENT_GRACE_MS ??
      300000,
  ),
  // ECDICT 离线词典目录（Issue #7）：构建产物所在目录（scripts/build-dictionary.mjs 产出）。
  ecdictDir:
    parseArg(process.argv, '--ecdict-dir') ??
    process.env.READEVA_ECDICT_DIR ??
    path.join(dataDirOption, 'dict', 'ecdict'),
  // MiniMax 翻译（Issue #8）：中国站（国内站）OpenAI 兼容接口，模型固定
  // MiniMax-M3.1-Flash；默认地址取国内站官方文档（https://api.minimax.cn/v1）。
  // 国际站（api.minimax.io）不使用——密钥与模型订阅按站区分；测试可用该变量指向 mock。
  minimaxBaseUrl:
    parseArg(process.argv, '--minimax-url') ??
    process.env.READEVA_MINIMAX_BASE_URL ??
    DEFAULT_MINIMAX_BASE_URL,
  // 指定密钥环境变量（Hans 确认本机已设置）：仅服务端读取，客户端不接触，
  // 接口响应不含密钥字段；未设置时翻译接口返回 503 与明确提示。
  minimaxApiKey: process.env[MINIMAX_API_KEY_ENV] ?? '',
  // 单次翻译超时（毫秒）：MiniMax-M3.1-Flash 为思考型模型，留足长译文余量。
  minimaxTimeoutMs: Number(
    parseArg(process.argv, '--minimax-timeout-ms') ??
      process.env.READEVA_MINIMAX_TIMEOUT_MS ??
      120_000,
  ),
};

if (!Number.isFinite(config.port) || config.port < 0 || config.port > 65535) {
  console.error(`无效端口: ${config.port}`);
  process.exit(1);
}

const library = new Library(config.dataDir);
const parseStore = new ParseStore(config.dataDir);
const doclingAdapter = config.doclingUrl
  ? new DoclingAdapter({
      baseUrl: config.doclingUrl,
      pollIntervalMs: Number.isFinite(config.doclingPollIntervalMs)
        ? config.doclingPollIntervalMs
        : 500,
      timeoutMs: Number.isFinite(config.doclingTimeoutMs) ? config.doclingTimeoutMs : 300_000,
    })
  : null;
const parseTasks = doclingAdapter
  ? new ParseTaskManager({
      store: parseStore,
      adapter: doclingAdapter,
      library,
      concurrency: config.parseConcurrency,
      sweepDelayMs: config.parseSweepDelayMs,
      sweepPacingFactor: config.parseSweepPacingFactor,
      clientGraceMs: config.clientGraceMs,
    })
  : null;
// MiniMax 翻译适配层（Issue #8）：密钥仅服务端持有；未配置时接口给出明确提示。
const minimaxTranslator = new MiniMaxTranslator({
  apiKey: config.minimaxApiKey,
  baseUrl: config.minimaxBaseUrl,
  timeoutMs: config.minimaxTimeoutMs,
});
const translationStore = new TranslationStore(config.dataDir);
const app = express();
app.disable('x-powered-by');

// 托管浏览器应用（默认同源访问，服务地址可在界面中另行配置）。
app.use(express.static(path.join(repoRoot, 'web')));

// PDF.js 静态资源（渲染原页所需）。
const pdfjsRoot = path.join(repoRoot, 'node_modules', 'pdfjs-dist');
app.use('/vendor/pdfjs/build', express.static(path.join(pdfjsRoot, 'legacy', 'build'), { maxAge: '1d' }));
app.use('/vendor/pdfjs/cmaps', express.static(path.join(pdfjsRoot, 'cmaps'), { maxAge: '1d' }));
app.use('/vendor/pdfjs/standard_fonts', express.static(path.join(pdfjsRoot, 'standard_fonts'), { maxAge: '1d' }));

app.use('/api', express.json({ limit: '1mb' }));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'readeva', version: APP_VERSION });
});

// 解析服务可用性（不含地址/密钥，供客户端提示「解析服务未配置」）。
app.get('/api/parse/service', (req, res) => {
  res.json({ configured: Boolean(doclingAdapter), engine: doclingAdapter ? 'docling' : null });
});

app.post(
  '/api/documents/import',
  // 导入以原始字节流上传，避免引入 multipart 依赖；文件名放在 x-filename 头。
  express.raw({ type: () => true, limit: '512mb' }),
  async (req, res, next) => {
    try {
      let name = '未命名.pdf';
      const rawHeader = req.get('x-filename');
      if (rawHeader) {
        let decoded;
        try {
          decoded = decodeURIComponent(rawHeader);
        } catch {
          // 非法编码（审查建议：客户端错误返回 400 而非 500）。
          return res.status(400).json({ error: 'invalid x-filename header encoding' });
        }
        const basename = path.basename(decoded.replace(/[\\/]+/g, '_')).trim();
        if (basename) name = basename;
        if (!/\.pdf$/i.test(name)) name += '.pdf';
        name = name.slice(0, 200);
      }
      const result = await library.importPdf(req.body, name);
      res.status(result.created ? 201 : 200).json(result);
    } catch (err) {
      next(err);
    }
  },
);

app.get('/api/documents', (req, res) => {
  res.json({ documents: library.listDocuments() });
});

app.get('/api/documents/:id', (req, res) => {
  const doc = library.getDocument(req.params.id);
  if (!doc) return res.status(404).json({ error: 'document not found' });
  // 打开文档 = 客户端活动（会话存续，Issue #6）。
  parseTasks?.touch(doc.id);
  res.json({ document: doc });
});

app.get('/api/documents/:id/file', (req, res) => {
  const doc = library.getDocument(req.params.id);
  if (!doc || !library.hasPdf(doc.id)) {
    return res.status(404).json({ error: 'document not found' });
  }
  parseTasks?.touch(doc.id);
  // 内容寻址副本，字节永不变更，可长期缓存。
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.type('application/pdf');
  res.sendFile(library.pdfPath(doc.id));
});

app.get('/api/documents/:id/progress', async (req, res, next) => {
  try {
    const doc = library.getDocument(req.params.id);
    if (!doc) {
      return res.status(404).json({ error: 'document not found' });
    }
    parseTasks?.touch(doc.id);
    res.json({ progress: await library.getProgress(req.params.id) });
  } catch (err) {
    next(err);
  }
});

app.put('/api/documents/:id/progress', async (req, res, next) => {
  try {
    const { page, zoom } = req.body ?? {};
    if (!Number.isFinite(Number(page)) || !Number.isFinite(Number(zoom))) {
      return res.status(400).json({ error: 'page and zoom must be numbers' });
    }
    const progress = await library.setProgress(req.params.id, page, zoom);
    // 阅读位置保存 = 客户端活动（会话存续，Issue #6）。
    parseTasks?.touch(req.params.id);
    res.json({ progress });
  } catch (err) {
    if (err.status === 404) {
      return res.status(404).json({ error: 'document not found' });
    }
    next(err);
  }
});

// 客户端会话状态（Issue #6）：只读观察端点，不刷新 lastSeen。
// 未配置解析服务时返回 supported:false（无可到期处置的队列）。
app.get('/api/documents/:id/session', (req, res) => {
  const doc = library.getDocument(req.params.id);
  if (!doc) return res.status(404).json({ error: 'document not found' });
  if (!parseTasks) return res.json({ documentId: doc.id, supported: false });
  res.json(parseTasks.sessionInfo(doc.id));
});

/* ---------------- 页解析（Issue #3） ---------------- */

function resolvePageParam(req, res) {
  const doc = library.getDocument(req.params.id);
  if (!doc) {
    res.status(404).json({ error: 'document not found' });
    return null;
  }
  const page = Math.floor(Number(req.params.page));
  if (!Number.isInteger(page) || page < 1 || page > doc.pageCount) {
    res.status(400).json({ error: `page must be an integer in [1, ${doc.pageCount}]` });
    return null;
  }
  return page;
}

function parseStatusPayload(docId, page) {
  if (parseTasks?.isRunning(docId, page)) {
    return { page, status: 'running' };
  }
  if (parseTasks?.isQueued(docId, page)) {
    const payload = { page, status: 'queued' };
    const position = parseTasks.queuePosition(docId, page);
    if (position >= 0) payload.queuePosition = position;
    return payload;
  }
  // 轻量状态（B1）：单页状态轮询不读内容块，只取状态字段。
  const record = parseStore.getStatus(docId, page);
  if (!record) return { page, status: 'idle' };
  const payload = {
    page,
    status: record.status,
    updatedAt: record.updatedAt,
  };
  if (record.status === 'succeeded') payload.parseId = record.parseId;
  if (record.status === 'failed') payload.error = record.error;
  return payload;
}

// 页解析请求（幂等：进行中不重复启动，已完成直接复用不重新解析）。
app.post('/api/documents/:id/pages/:page/parse', (req, res, next) => {
  try {
    const page = resolvePageParam(req, res);
    if (page === null) return;
    if (!doclingAdapter) {
      return res.status(503).json({ error: 'docling service not configured' });
    }
    // 解析请求 = 客户端活动（会话存续，Issue #6）。
    parseTasks.touch(req.params.id);
    const outcome = parseTasks.start(req.params.id, page);
    if (outcome === 'reused') {
      const payload = parseStatusPayload(req.params.id, page);
      return res.json({ ...payload, reused: true });
    }
    if (outcome === 'running') {
      return res.status(200).json({ page, status: 'running' });
    }
    // started：并发空闲时立即开始；占满时进入队列（仍为 202 已接受）。
    const state = parseTasks.stateOf(req.params.id, page);
    res.status(202).json({ page, status: state === 'queued' ? 'queued' : 'running' });
  } catch (err) {
    next(err);
  }
});

// 任务状态：idle（未开始）/ queued（排队）/ running（已开始）/ succeeded / failed。
app.get('/api/documents/:id/pages/:page/parse', (req, res) => {
  const page = resolvePageParam(req, res);
  if (page === null) return;
  // 状态轮询 = 客户端活动（会话存续，Issue #6）。
  parseTasks?.touch(req.params.id);
  res.json(parseStatusPayload(req.params.id, page));
});

// 结果获取（仅成功后可得；按页返回解析身份、结构、文字及可用位置）。
app.get('/api/documents/:id/pages/:page/parse/result', (req, res) => {
  const page = resolvePageParam(req, res);
  if (page === null) return;
  // 结果获取 = 客户端活动（会话存续，Issue #6）。
  parseTasks?.touch(req.params.id);  const record = parseStore.getRecord(req.params.id, page);
  if (!record || record.status !== 'succeeded') {
    return res.status(404).json({ error: 'parse result not found' });
  }
  // 防御：无论落盘记录来自哪个版本，绝不通过接口暴露解析服务地址（审查 B1）。
  const { serviceUrl, ...meta } = record.meta ?? {};
  res.json({
    parse: {
      documentId: record.documentId,
      page: record.page,
      status: record.status,
      parseId: record.parseId,
      blocks: record.blocks,
      meta,
      updatedAt: record.updatedAt,
    },
  });
});

// 阅读页优先级更新（Issue #5）：阅读位置变化 → 服务端按「当前页及后续页优先，
// 其余降级」重排未开始任务；不影响进行中的页；已完成/失败页不入队。
app.put('/api/documents/:id/reading-position', (req, res, next) => {
  try {
    const doc = library.getDocument(req.params.id);
    if (!doc) return res.status(404).json({ error: 'document not found' });
    const page = Number(req.body?.page);
    if (!Number.isInteger(page) || page < 1 || page > doc.pageCount) {
      return res.status(400).json({ error: `page must be an integer in [1, ${doc.pageCount}]` });
    }
    if (!parseTasks) {
      // 未配置解析服务：无可调度任务，位置本身有效（不视为错误）。
      return res.json({ documentId: doc.id, page, scheduled: false });
    }
    parseTasks.updateReadingPosition(doc.id, page);
    res.json({
      documentId: doc.id,
      page,
      scheduled: true,
      progress: parseTasks.progress(doc.id),
    });
  } catch (err) {
    next(err);
  }
});

// 整本解析进度查询（Issue #5）：逐页状态 + 整体进度 + 失败原因；
// 基于 parse-store 轻量状态索引构建（B1：不逐轮全量读盘），服务重启后进度不丢。
// 进度轮询同时作为客户端会话心跳（Issue #6）。
app.get('/api/documents/:id/parse/progress', (req, res) => {
  const doc = library.getDocument(req.params.id);
  if (!doc) return res.status(404).json({ error: 'document not found' });
  parseTasks?.touch(doc.id);
  const progress = buildParseProgress({
    store: parseStore,
    library,
    tasks: parseTasks,
    docId: doc.id,
  });
  res.json(progress);
});

/* ---------------- 选词查词：ECDICT 离线词典（Issue #7） ---------------- */

const dictionaryStore = new DictionaryStore(config.ecdictDir);

// 词条查询：200 { entry, license, dataSources } / 404 未收录（含超长查询）/
// 503 词典数据未准备 / 400 非法参数（缺 word / 仅空白）。
// 纯本地查询（内存索引 + 文件切片），不访问网络；首版不维护查词历史。
app.get('/api/dictionary/lookup', async (req, res, next) => {
  try {
    const key = normalizeLookupKey(req.query.word);
    if (!key) {
      return res.status(400).json({ error: 'word query parameter is required' });
    }
    // 超长查询与「未收录」同一语义：整段选文必然不在词典里，报非法参数没有意义。
    if (key.length > MAX_LOOKUP_LENGTH) {
      return res.status(404).json({ error: 'entry not found' });
    }
    let entry;
    try {
      entry = await dictionaryStore.lookup(key);
    } catch (err) {
      if (err instanceof DictionaryNotPreparedError) {
        return res.status(503).json({ error: 'dictionary data not prepared' });
      }
      throw err;
    }
    if (!entry) return res.status(404).json({ error: 'entry not found' });
    // 归因（许可 + 上游数据来源）：来自构建产物 manifest，缺字段时用内嵌常量。
    const attribution = dictionaryStore.getAttribution();
    res.json({
      entry,
      license: attribution?.license ?? null,
      dataSources: attribution?.dataSources ?? null,
    });
  } catch (err) {
    next(err);
  }
});

/* ---------------- 选文与内容块翻译：MiniMax（Issue #8） ---------------- */

/**
 * 从页解析记录中提取内容块的待翻译源文本（服务端自行提取，客户端只传块 id，
 * 保证译文与解析内容一致）。图片等无文本块返回 null（不支持翻译）。
 */
function extractBlockSourceText(block) {
  switch (block?.kind) {
    case 'heading':
    case 'paragraph':
      return typeof block.text === 'string' ? block.text : '';
    case 'list':
      return (Array.isArray(block.items) ? block.items : []).join('\n');
    case 'table': {
      const rows = Array.isArray(block.rows) ? block.rows : [];
      return rows.map((row) => (Array.isArray(row) ? row.join('\t') : '')).join('\n');
    }
    default:
      return null;
  }
}

/** 同一译文（同文档+解析+来源+语言）的在途请求去重：双击/重复点击只翻译一次。 */
const translationInFlight = new Map();

function translateOnce(key, params) {
  const existing = translationInFlight.get(key);
  if (existing) return existing;
  const wrapped = minimaxTranslator.translate(params).finally(() => {
    if (translationInFlight.get(key) === wrapped) translationInFlight.delete(key);
  });
  translationInFlight.set(key, wrapped);
  return wrapped;
}

// 翻译服务可用性（不含地址/密钥，供客户端提示「翻译服务未配置」）。
app.get('/api/translate/service', (req, res) => {
  res.json({
    configured: minimaxTranslator.configured,
    model: MINIMAX_MODEL,
    defaultTargetLanguage: DEFAULT_TARGET_LANGUAGE,
  });
});

// 翻译请求（选文或内容块 → 译文）：
// - 200 { reused: true }  已有对应译文直接复用（不调用翻译服务、不重复落盘）；
// - 201 { reused: false } 新翻译完成并自动保存（事务式：成功才写入）；
// - 409 parseId 与当前页解析不一致（含解析替换期间返回的旧请求——不写入新解析）；
// - 400 非法参数（缺 parseId/来源、选文超长、块不存在或无文本）；
// - 404 未知文档；503 翻译服务未配置；502 翻译失败（失败不写入任何译文）。
app.post('/api/documents/:id/pages/:page/translations', async (req, res, next) => {
  try {
    const doc = library.getDocument(req.params.id);
    if (!doc) return res.status(404).json({ error: 'document not found' });
    const page = resolvePageParam(req, res);
    if (page === null) return;
    // 翻译请求 = 客户端活动（会话存续，Issue #6）。
    parseTasks?.touch(doc.id);

    const body = req.body ?? {};
    const parseId = typeof body.parseId === 'string' ? body.parseId.trim() : '';
    if (!parseId) return res.status(400).json({ error: 'parseId is required' });
    const targetLanguage =
      typeof body.targetLanguage === 'string' && body.targetLanguage.trim()
        ? body.targetLanguage.trim().slice(0, 32)
        : DEFAULT_TARGET_LANGUAGE;
    if (!/^[A-Za-z0-9_-]+$/.test(targetLanguage)) {
      return res.status(400).json({ error: 'targetLanguage must be a language code' });
    }

    const source = body.source ?? {};
    let sourceKind;
    let blockId = null;
    let sourceText = null;
    let sourceKey;
    if (source.kind === 'block') {
      sourceKind = 'block';
      blockId = typeof source.blockId === 'string' ? source.blockId.trim() : '';
      if (!/^[\w.-]{1,64}$/.test(blockId)) {
        return res.status(400).json({ error: 'source.blockId is required' });
      }
      sourceKey = blockSourceKey(blockId);
    } else if (source.kind === 'selection') {
      sourceKind = 'selection';
      const normalized = normalizeSelectionText(source.text);
      if (!normalized) {
        return res.status(400).json({ error: 'source.text is required' });
      }
      if (normalized.length > MAX_TRANSLATION_SOURCE_LENGTH) {
        return res
          .status(400)
          .json({ error: `source.text exceeds ${MAX_TRANSLATION_SOURCE_LENGTH} characters` });
      }
      sourceKey = selectionSourceKey(normalized);
      sourceText = normalized;
    } else {
      return res.status(400).json({ error: 'source.kind must be "block" or "selection"' });
    }

    // 译文与页解析身份绑定：请求必须针对当前页解析（旧解析的译文请求直接拒绝）。
    const current = parseStore.getRecord(doc.id, page);
    if (!current || current.status !== 'succeeded') {
      return res
        .status(409)
        .json({ error: 'page parse is not available', parseId: current?.parseId ?? null });
    }
    if (current.parseId !== parseId) {
      return res
        .status(409)
        .json({ error: 'page parse has been replaced', parseId: current.parseId });
    }

    // 内容块来源：块必须存在于当前解析结果且携带可翻译文本。
    if (sourceKind === 'block') {
      const block = (current.blocks ?? []).find((b) => b?.id === blockId);
      if (!block) {
        return res.status(400).json({ error: 'block not found in page parse result' });
      }
      const text = extractBlockSourceText(block);
      if (text === null || !text.trim()) {
        return res.status(400).json({ error: 'block has no translatable text' });
      }
      sourceText = text;
    }

    // 已有对应译文直接复用：不重复翻译。
    const existing = translationStore.find(doc.id, parseId, sourceKey, targetLanguage);
    if (existing) {
      return res.status(200).json({ reused: true, translation: existing });
    }

    if (!minimaxTranslator.configured) {
      return res.status(503).json({ error: 'translation service not configured' });
    }

    // 事务式：翻译成功才写入；失败不落任何记录。
    let translated;
    try {
      const dedupKey = `${doc.id}|${parseId}|${sourceKey}|${targetLanguage}`;
      translated = await translateOnce(dedupKey, {
        text: sourceText,
        targetLanguage,
      });
    } catch (err) {
      if (!(err instanceof MinimaxServiceError)) throw err;
      return res.status(502).json({ error: `translation failed: ${err.message}` });
    }

    // 防污染：解析替换期间返回的旧翻译响应不得写入新解析——落盘前再次校验
    // parseId 仍与当前页解析一致（不一致一律丢弃，不产生任何写入）。
    const latest = parseStore.getRecord(doc.id, page);
    if (!latest || latest.status !== 'succeeded' || latest.parseId !== parseId) {
      return res
        .status(409)
        .json({ error: 'page parse replaced during translation', parseId: latest?.parseId ?? null });
    }

    const now = new Date().toISOString();
    const entry = {
      id: translationId(sourceKey, targetLanguage),
      documentId: doc.id,
      parseId,
      page,
      sourceKind,
      blockId,
      sourceKey,
      // 块译文不重复存块文本（解析记录本身就是源）；选文存归一化源文本供展示与复用。
      sourceText: sourceKind === 'selection' ? sourceText : null,
      targetLanguage,
      text: translated.text,
      model: translated.model,
      createdAt: now,
      updatedAt: now,
    };
    await translationStore.save(doc.id, parseId, entry);
    res.status(201).json({ reused: false, translation: entry });
  } catch (err) {
    next(err);
  }
});

// 取回当前页解析绑定的全部译文（客户端重开/重连恢复与复用的数据源）：
// 译文按 parseId 读取——页解析被替换后旧译文不再出现（只返回当前解析的译文）。
app.get('/api/documents/:id/pages/:page/translations', (req, res) => {
  const doc = library.getDocument(req.params.id);
  if (!doc) return res.status(404).json({ error: 'document not found' });
  const page = resolvePageParam(req, res);
  if (page === null) return;
  // 取回译文 = 客户端活动（会话存续，Issue #6）。
  parseTasks?.touch(doc.id);
  const current = parseStore.getRecord(doc.id, page);
  // 未解析/解析失败/解析进行中：没有可绑定的解析身份，无译文。
  if (!current || current.status !== 'succeeded') {
    return res.json({ page, parseId: null, translations: [] });
  }
  res.json({
    page,
    parseId: current.parseId,
    translations: translationStore.list(doc.id, current.parseId),
  });
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'not found' });
});

// 错误处理。
app.use('/api', (err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err instanceof InvalidPdfError) {
    return res.status(400).json({ error: err.message });
  }
  if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') {
    return res.status(err.statusCode ?? 400).json({ error: err.message });
  }
  console.error(err);
  res.status(500).json({ error: 'internal error' });
});

const server = app.listen(config.port, config.host, () => {
  const addr = server.address();
  const host = addr.address === '::' ? '127.0.0.1' : addr.address;
  console.log(`Readeva service listening on http://${host}:${addr.port}`);
  console.log(`Readeva data dir: ${library.dataDir}`);
  console.log(
    `Readeva docling service: ${doclingAdapter ? config.doclingUrl : 'not configured'}`,
  );
  console.log(`Readeva dictionary dir: ${config.ecdictDir}`);
  console.log(
    `Readeva translation service: ${minimaxTranslator.configured ? MINIMAX_MODEL : 'not configured (set MINIMAX_API_KEY)'}`,
  );
});

server.on('error', (err) => {
  console.error(`service error: ${err.code ?? ''} ${err.message}`);
  process.exit(1);
});
