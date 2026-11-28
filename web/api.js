const STORAGE_KEY = 'readeva.serviceUrl';

/** 返回服务基地址；未配置时为空字符串（同源）。 */
export function getServiceBase() {
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored && stored.trim()) return stored.trim().replace(/\/+$/, '');
  return '';
}

export function setServiceBase(value) {
  const trimmed = (value ?? '').trim().replace(/\/+$/, '');
  if (trimmed) window.localStorage.setItem(STORAGE_KEY, trimmed);
  else window.localStorage.removeItem(STORAGE_KEY);
}

async function request(path, options = {}) {
  const response = await fetch(`${getServiceBase()}${path}`, options);
  if (!response.ok) {
    let detail = `${response.status}`;
    try {
      const body = await response.json();
      if (body?.error) detail = body.error;
    } catch {
      /* 非 JSON 响应时使用状态码 */
    }
    const err = new Error(`请求失败（${detail}）`);
    // 保留状态码供调用方分支处理（如查词：404 未收录 / 503 词典未准备）。
    err.status = response.status;
    throw err;
  }
  return response.json();
}

export const fetchDocuments = () => request('/api/documents');

export const fetchDocument = (id) => request(`/api/documents/${id}`);

export const fetchProgress = (id) => request(`/api/documents/${id}/progress`);

export const saveProgress = (id, page, zoom) =>
  request(`/api/documents/${id}/progress`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ page, zoom }),
  });

export function importPdf(file) {
  return request('/api/documents/import', {
    method: 'POST',
    headers: {
      'content-type': 'application/pdf',
      'x-filename': encodeURIComponent(file.name),
    },
    body: file,
  });
}

export const pdfFileUrl = (id) => `${getServiceBase()}/api/documents/${id}/file`;

export const pdfjsAssetUrl = (relative) => `${getServiceBase()}/vendor/pdfjs/${relative}`;

/* ---------------- 页解析（Issue #3） ---------------- */

export const fetchParseService = () => request('/api/parse/service');

export const fetchParseStatus = (id, page) =>
  request(`/api/documents/${id}/pages/${page}/parse`);

export const fetchParseResult = (id, page) =>
  request(`/api/documents/${id}/pages/${page}/parse/result`);

export const requestPageParse = (id, page) =>
  request(`/api/documents/${id}/pages/${page}/parse`, { method: 'POST' });

/* ---------------- 按阅读位置调度（Issue #5） ---------------- */

/** 上报阅读位置：服务端按「当前页及后续页优先，其余降级」重排未开始任务。 */
export const updateReadingPosition = (id, page) =>
  request(`/api/documents/${id}/reading-position`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ page }),
  });

/** 整本解析进度：逐页状态 + 整体计数 + 失败原因。 */
export const fetchParseProgress = (id) => request(`/api/documents/${id}/parse/progress`);

/* ---------------- 选词查词：ECDICT 离线词典（Issue #7） ---------------- */

/**
 * 词条查询：命中返回 { entry, license, dataSources }（归因信息来自构建产物
 * manifest，可能为 null）；未收录 404（含超长查询）；词典数据未准备 503。
 * 错误对象携带 status 属性供界面区分提示。
 */
export async function fetchDictionaryLookup(word) {
  const query = new URLSearchParams({ word });
  return request(`/api/dictionary/lookup?${query.toString()}`);
}
