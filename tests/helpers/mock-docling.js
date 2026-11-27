import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';

/**
 * 固定结果的 Docling 服务 mock：实现 docling-serve 兼容线协议
 *   POST /v1/convert/file/async   → { task_id, task_status }
 *   GET  /v1/status/poll/{task}   → { task_status: started → success|failure }
 *   GET  /v1/result/{task}        → { document: { json_content }, status, errors }
 *
 * 日常自动化指向本 mock（READEVA_DOCLING_URL），不依赖真实外部服务。
 * 返回句柄可运行时切换行为（模拟失败/重试）并检查调用记录。
 */

function loadDocument(doc) {
  if (typeof doc === 'string') return JSON.parse(fs.readFileSync(doc, 'utf8'));
  return doc;
}

/** 从 multipart/form-data 请求体中提取第一个文件部分。 */
function extractMultipartFile(body, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? '');
  if (!match) throw new Error('mock docling: request is not multipart');
  const boundary = Buffer.from(`--${match[1] ?? match[2]}`);
  const marker = body.indexOf(boundary);
  if (marker < 0) throw new Error('mock docling: boundary not found in body');
  const markerLineEnd = body.indexOf('\r\n', marker);
  if (markerLineEnd < 0) throw new Error('mock docling: malformed part header');
  const headerEnd = body.indexOf('\r\n\r\n', markerLineEnd);
  if (headerEnd < 0) throw new Error('mock docling: malformed part header');
  const headers = body.toString('latin1', markerLineEnd + 2, headerEnd);
  const filenameMatch = /filename="([^"]*)"/i.exec(headers);
  if (!filenameMatch) throw new Error('mock docling: no file part found');
  const payloadStart = headerEnd + 4;
  const closing = body.indexOf(boundary, payloadStart);
  if (closing < 0) throw new Error('mock docling: closing boundary not found');
  // 边界前有一个 CRLF 属于分隔符，不属于文件内容。
  let end = closing;
  if (body[end - 1] === 0x0a && body[end - 2] === 0x0d) end -= 2;
  return { filename: filenameMatch[1], bytes: body.subarray(payloadStart, end) };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function startMockDocling({
  defaultDocument = 'tests/fixtures/docling/default-page.json',
  byPage = {},
  pollsBeforeDone = 1,
  convertDelayMs = 0,
} = {}) {
  const requests = [];
  const tasks = new Map(); // taskId -> { polls, outcome }
  let taskCounter = 0;
  let steps = null; // 行为脚本：逐次消耗；null = 始终成功
  let stepIndex = 0;

  const nextOutcome = () => {
    if (!steps) return { mode: 'success', document: null };
    const step = steps[Math.min(stepIndex, steps.length - 1)];
    stepIndex += 1;
    return step;
  };

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://mock-docling');

    if (req.method === 'POST' && url.pathname === '/v1/convert/file/async') {
      const upload = extractMultipartFile(body, req.headers['content-type']);
      const record = {
        kind: 'convert',
        filename: upload.filename,
        byteLength: upload.bytes.length,
        sha256: crypto.createHash('sha256').update(upload.bytes).digest('hex'),
        at: new Date().toISOString(),
      };
      requests.push(record);

      const pageMatch = /page-(\d+)\.pdf$/.exec(upload.filename ?? '');
      const page = pageMatch ? Number(pageMatch[1]) : null;
      const outcome = nextOutcome();
      const task = {
        id: `mock-task-${++taskCounter}`,
        polls: 0,
        page,
        outcome,
        document: outcome.document ? loadDocument(outcome.document) : null,
      };
      tasks.set(task.id, task);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ task_id: task.id, task_status: 'started', task_position: 0, task_meta: null }));
      return;
    }

    const pollMatch = /^\/v1\/status\/poll\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'GET' && pollMatch) {
      const task = tasks.get(decodeURIComponent(pollMatch[1]));
      if (!task) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'unknown task' }));
        return;
      }
      task.polls += 1;
      if (convertDelayMs) await delay(convertDelayMs);
      let status;
      if (task.polls <= pollsBeforeDone) {
        status = 'started';
      } else {
        status = task.outcome.mode === 'failure' ? 'failure' : 'success';
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ task_id: task.id, task_status: status, task_position: 0, task_meta: null }));
      return;
    }

    const resultMatch = /^\/v1\/result\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'GET' && resultMatch) {
      const task = tasks.get(decodeURIComponent(resultMatch[1]));
      if (!task) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'unknown task' }));
        return;
      }
      if (task.polls <= pollsBeforeDone) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'result not ready' }));
        return;
      }
      res.setHeader('content-type', 'application/json');
      if (task.outcome.mode === 'failure') {
        res.end(
          JSON.stringify({
            document: {},
            status: 'failure',
            errors: [{ kind: 'conversion', message: task.outcome.message ?? 'mock conversion failure' }],
          }),
        );
        return;
      }
      const jsonContent =
        task.document ?? (pageSpecific(task.page) ?? loadDocument(defaultDocument));
      res.end(
        JSON.stringify({
          document: { md_content: '', json_content: jsonContent },
          status: 'success',
          errors: [],
        }),
      );
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  });

  const pageSpecific = (page) => {
    if (page !== null && byPage[String(page)] !== undefined) {
      return loadDocument(byPage[String(page)]);
    }
    return null;
  };

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        base: `http://127.0.0.1:${port}`,
        requests,
        /** 传入 null 恢复默认成功行为；数组 = 按次消耗的行为脚本。 */
        setBehavior(next) {
          steps = next;
          stepIndex = 0;
        },
        convertCalls() {
          return requests.filter((r) => r.kind === 'convert').length;
        },
        close() {
          return new Promise((done) => server.close(done));
        },
      });
    });
  });
}
