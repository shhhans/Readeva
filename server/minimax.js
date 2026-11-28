/**
 * MiniMax 翻译服务适配层（Issue #8）。
 *
 * 通过 MiniMax **中国站（国内站）** 的 OpenAI 兼容 Chat Completions 接口翻译选文/内容块：
 *   POST {baseUrl}/chat/completions
 *   Authorization: Bearer <MINIMAX_API_KEY>
 *
 * - 默认 base URL 取国内站官方文档（platform.minimaxi.com「模型调用」URL 配置）：
 *   OpenAI 兼容 https://api.minimax.cn/v1（国际站为 api.minimax.io，不使用——
 *   密钥与模型订阅按站区分，用错站点会鉴权失败；可用 READEVA_MINIMAX_BASE_URL
 *   覆盖以便测试指向 mock，默认值始终是中国站）。
 * - 模型固定 MiniMax-M3.1-Flash（国内站文档模型名）。
 * - 密钥只从服务端环境变量 MINIMAX_API_KEY 读取；客户端不接触密钥与上游地址，
 *   API 响应、日志与错误信息都不携带密钥（错误信息只含状态码与截断的响应体）。
 */

export const MINIMAX_MODEL = 'MiniMax-M3.1-Flash';
export const DEFAULT_MINIMAX_BASE_URL = 'https://api.minimax.cn/v1';
/** 指定密钥环境变量（Hans 确认本机已设置；客户端不接触）。 */
export const MINIMAX_API_KEY_ENV = 'MINIMAX_API_KEY';

export class MinimaxServiceError extends Error {
  constructor(message, { status } = {}) {
    super(message);
    this.name = 'MinimaxServiceError';
    this.status = status;
  }
}

/** 目标语言代码 → 提示词中的语言名（未列举的代码原样使用）。 */
const LANGUAGE_NAMES = {
  zh: 'Simplified Chinese (简体中文)',
  en: 'English (英文)',
};

export function targetLanguagePromptName(code) {
  return LANGUAGE_NAMES[code] ?? code;
}

function systemPrompt(targetName) {
  return [
    'You are a professional translator for PDF document content.',
    `Translate the user message into ${targetName}.`,
    'Preserve the original structure: translate line by line, keep table cell text short, and keep numbers, symbols, URLs and proper nouns accurate.',
    'Reply with the translation only — no explanations and no surrounding quotes.',
  ].join(' ');
}

/**
 * M 系列模型可能在 message.content 中内嵌 <think>…</think> 思考段（非流式输出）；
 * 翻译只取思考后的正文。没有思考段时原样返回。
 */
function stripThinking(content) {
  return String(content).replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

/**
 * MiniMax 翻译客户端：单段文本 → 译文。
 * 翻译请求由用户主动触发（每次请求即一次翻译调用），服务端不做批量/排队。
 */
export class MiniMaxTranslator {
  constructor({
    apiKey,
    baseUrl = DEFAULT_MINIMAX_BASE_URL,
    model = MINIMAX_MODEL,
    timeoutMs = 120_000,
    fetchImpl = fetch,
  } = {}) {
    this.apiKey = apiKey ?? '';
    this.baseUrl = (baseUrl ?? DEFAULT_MINIMAX_BASE_URL).replace(/\/+$/, '');
    this.model = model;
    this.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 120_000;
    this.fetchImpl = fetchImpl;
  }

  /** 翻译服务是否已配置（仅取决于密钥；配置信息可安全暴露给客户端）。 */
  get configured() {
    return Boolean(this.apiKey);
  }

  /**
   * 翻译一段文本。返回 { text, model }；任何失败抛 MinimaxServiceError
   * （失败路径不产生译文，由调用方保证「失败不写入成功译文」）。
   */
  async translate({ text, targetLanguage = 'zh' }) {
    if (!this.apiKey) {
      throw new MinimaxServiceError('minimax api key is not configured');
    }
    if (!text || !String(text).trim()) {
      throw new MinimaxServiceError('nothing to translate');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // 密钥只出现在服务端出站请求头；绝不进入日志/错误信息/响应。
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: systemPrompt(targetLanguagePromptName(targetLanguage)) },
            { role: 'user', content: String(text) },
          ],
          stream: false,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      throw new MinimaxServiceError(
        err?.name === 'AbortError'
          ? `minimax translate timed out after ${this.timeoutMs}ms`
          : `minimax service unreachable: ${err.message}`,
      );
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      throw new MinimaxServiceError(
        `minimax translate failed: HTTP ${response.status} ${bodyText.slice(0, 200)}`.trim(),
        { status: response.status },
      );
    }
    let payload;
    try {
      payload = await response.json();
    } catch (err) {
      throw new MinimaxServiceError(`minimax response is not valid JSON: ${err.message}`);
    }
    const baseResp = payload?.base_resp;
    if (baseResp && Number(baseResp.status_code) !== 0) {
      throw new MinimaxServiceError(
        `minimax translate failed: ${baseResp.status_code} ${baseResp.status_msg ?? ''}`.trim(),
      );
    }
    const content = payload?.choices?.[0]?.message?.content;
    const translated = stripThinking(content);
    if (!translated) {
      throw new MinimaxServiceError('minimax response missing translation content');
    }
    return { text: translated, model: this.model };
  }
}
