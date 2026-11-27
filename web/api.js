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
    throw new Error(`请求失败（${detail}）`);
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
