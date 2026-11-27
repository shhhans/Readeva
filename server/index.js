import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Library, InvalidPdfError } from './library.js';
import { DoclingAdapter } from './docling.js';
import { ParseStore } from './parse-store.js';
import { ParseTaskManager } from './page-tasks.js';

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
  ? new ParseTaskManager({ store: parseStore, adapter: doclingAdapter, library })
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
  res.json({ document: doc });
});

app.get('/api/documents/:id/file', (req, res) => {
  const doc = library.getDocument(req.params.id);
  if (!doc || !library.hasPdf(doc.id)) {
    return res.status(404).json({ error: 'document not found' });
  }
  // 内容寻址副本，字节永不变更，可长期缓存。
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.type('application/pdf');
  res.sendFile(library.pdfPath(doc.id));
});

app.get('/api/documents/:id/progress', async (req, res, next) => {
  try {
    if (!library.getDocument(req.params.id)) {
      return res.status(404).json({ error: 'document not found' });
    }
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
    res.json({ progress });
  } catch (err) {
    if (err.status === 404) {
      return res.status(404).json({ error: 'document not found' });
    }
    next(err);
  }
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
  const record = parseStore.getRecord(docId, page);
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
    const outcome = parseTasks.start(req.params.id, page);
    if (outcome === 'reused') {
      const payload = parseStatusPayload(req.params.id, page);
      return res.json({ ...payload, reused: true });
    }
    res.status(outcome === 'started' ? 202 : 200).json({ page, status: 'running' });
  } catch (err) {
    next(err);
  }
});

// 任务状态：idle（未开始）/ running（已开始）/ succeeded / failed。
app.get('/api/documents/:id/pages/:page/parse', (req, res) => {
  const page = resolvePageParam(req, res);
  if (page === null) return;
  res.json(parseStatusPayload(req.params.id, page));
});

// 结果获取（仅成功后可得；按页返回解析身份、结构、文字及可用位置）。
app.get('/api/documents/:id/pages/:page/parse/result', (req, res) => {
  const page = resolvePageParam(req, res);
  if (page === null) return;
  const record = parseStore.getRecord(req.params.id, page);
  if (!record || record.status !== 'succeeded') {
    return res.status(404).json({ error: 'parse result not found' });
  }
  res.json({
    parse: {
      documentId: record.documentId,
      page: record.page,
      status: record.status,
      parseId: record.parseId,
      blocks: record.blocks,
      meta: record.meta,
      updatedAt: record.updatedAt,
    },
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
});

server.on('error', (err) => {
  console.error(`service error: ${err.code ?? ''} ${err.message}`);
  process.exit(1);
});
