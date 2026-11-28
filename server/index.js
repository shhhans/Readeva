import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Library, InvalidPdfError } from './library.js';
import { DoclingAdapter } from './docling.js';
import { ParseStore } from './parse-store.js';
import { ParseTaskManager, buildParseProgress } from './page-tasks.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const APP_VERSION = '0.1.0';

function parseArg(argv, flag) {
  const index = argv.indexOf(flag);
  if (index >= 0 && argv[index + 1]) return argv[index + 1];
  return undefined;
}

const config = {
  host: parseArg(process.argv, '--host') ?? process.env.READEVA_HOST ?? '127.0.0.1',
  port: Number(
    parseArg(process.argv, '--port') ?? process.env.READEVA_PORT ?? 8787,
  ),
  dataDir:
    parseArg(process.argv, '--data-dir') ??
    process.env.READEVA_DATA_DIR ??
    path.join(repoRoot, 'data'),
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
  // 默认 60s，必须大于客户端心跳间隔（阅读视图内整本进度慢刷新 8s）以避免误判。
  clientGraceMs: Number(
    parseArg(process.argv, '--client-grace-ms') ??
      process.env.READEVA_CLIENT_GRACE_MS ??
      60000,
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
});

server.on('error', (err) => {
  console.error(`service error: ${err.code ?? ''} ${err.message}`);
  process.exit(1);
});
