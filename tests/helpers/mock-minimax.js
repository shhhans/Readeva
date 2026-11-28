import http from 'node:http';

/**
 * MiniMax Chat Completions mock（Issue #8）：实现 MiniMax 中国站 OpenAI 兼容
 * 线协议的单端点
 *   POST /v1/chat/completions → OpenAI 形态响应（固定译文）+ base_resp
 *
 * 日常自动化指向本 mock（READEVA_MINIMAX_BASE_URL 指向 mock 的 /v1），不依赖
 * 真实外部服务与密钥。返回句柄可运行时切换行为（模拟失败/延迟）并检查调用记录
 * （记录 Authorization 的形态与是否以 Bearer 开头，不记录完整密钥）。
 */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function startMockMinimax({
  /** 固定译文函数：(userText, record) => string；默认按输入确定性推导。 */
  translate = null,
  /** 每次请求的处理延迟（毫秒），可经 setDelay 运行时调整（模拟慢翻译）。 */
  delayMs = 0,
} = {}) {
  const requests = [];
  let steps = null; // 行为脚本：逐次消耗；null = 始终成功
  let stepIndex = 0;
  let wait = delayMs;

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url, 'http://mock-minimax');

    const chatMatch = /^\/v1\/chat\/completions$/.exec(url.pathname);
    if (req.method === 'POST' && chatMatch) {
      let payload = {};
      try {
        payload = JSON.parse(body);
      } catch {
        /* 非法 JSON：按空载荷处理 */
      }
      const auth = req.headers['authorization'] ?? '';
      const messages = Array.isArray(payload.messages) ? payload.messages : [];
      const userText = messages
        .filter((m) => m?.role === 'user')
        .map((m) => (typeof m.content === 'string' ? m.content : ''))
        .join('\n');
      const record = {
        kind: 'chat',
        model: payload.model ?? null,
        system: messages.find((m) => m?.role === 'system')?.content ?? null,
        text: userText,
        // 只记录形态（bearer/other/none）与前缀，不记录完整密钥。
        authorizationPrefix: auth.startsWith('Bearer ') ? 'bearer' : auth ? 'other' : 'none',
        at: new Date().toISOString(),
      };
      requests.push(record);

      if (wait > 0) await delay(wait);

      const step = steps ? steps[Math.min(stepIndex, steps.length - 1)] : null;
      if (steps) stepIndex += 1;

      res.setHeader('content-type', 'application/json');
      if (step?.mode === 'failure') {
        if (step.httpStatus && step.httpStatus !== 200) {
          // HTTP 层失败（如 401 鉴权失败/429 限流）。
          res.statusCode = step.httpStatus;
          res.end(JSON.stringify({ error: step.message ?? 'mock minimax failure' }));
          return;
        }
        // HTTP 200 + base_resp 业务错误（MiniMax 失败形态之一，如 status_code 1004）。
        res.end(
          JSON.stringify({
            base_resp: { status_code: step.statusCode ?? 1004, status_msg: step.message ?? 'mock minimax business failure' },
          }),
        );
        return;
      }
      const translated = step?.text ?? (translate ? translate(userText, record) : `【译】${userText}`);
      res.end(
        JSON.stringify({
          id: `mock-chat-${requests.length}`,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: translated },
              finish_reason: 'stop',
            },
          ],
          usage: { total_tokens: 0 },
          base_resp: { status_code: 0, status_msg: '' },
        }),
      );
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  });

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
        /** 运行时切换处理延迟（模拟快/慢翻译）。 */
        setDelay(next) {
          wait = Number(next) || 0;
        },
        chatCalls() {
          return requests.filter((r) => r.kind === 'chat').length;
        },
        close() {
          return new Promise((done) => server.close(done));
        },
      });
    });
  });
}
