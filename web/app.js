import {
  fetchDocuments,
  fetchDocument,
  fetchProgress,
  saveProgress,
  importPdf,
  pdfFileUrl,
  getServiceBase,
  setServiceBase,
} from './api.js';
import { PdfViewer } from './pdf-viewer.js';
import { ParsePanel } from './parse-panel.js';
import { PageLinkage } from './page-linkage.js';

const state = {
  view: 'library',
  docId: null,
  viewer: null,
  saveTimer: 0,
  // 阅读器就绪信号：渲染就绪前的操作会等待后执行。
  ready: Promise.resolve(),
  parsePanel: null,
};

const $ = (selector) => document.querySelector(selector);

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '–';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatDateTime(iso) {
  if (!iso) return '–';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '–' : date.toLocaleString();
}

function showStatus(element, text) {
  element.textContent = text;
  element.hidden = !text;
}

/* ---------------- 路由 ---------------- */

function switchView(name) {
  state.view = name;
  $('#view-library').hidden = name !== 'library';
  $('#view-reader').hidden = name !== 'reader';
}

function route() {
  const hash = window.location.hash || '#/';
  const match = hash.match(/^#\/read\/([0-9a-fA-F]{8,128})$/);
  if (match) showReader(match[1]);
  else showLibrary();
}

window.addEventListener('hashchange', route);

/* ---------------- 书库 ---------------- */

async function showLibrary() {
  teardownReader();
  switchView('library');
  await refreshLibrary();
}

async function refreshLibrary() {
  const rows = $('#library-tbody');
  const { documents } = await fetchDocuments();

  rows.innerHTML = '';
  $('#library-empty').hidden = documents.length > 0;
  $('#library-table').hidden = documents.length === 0;

  for (const doc of documents) {
    const tr = document.createElement('tr');

    const nameTd = document.createElement('td');
    const openLink = document.createElement('button');
    openLink.type = 'button';
    openLink.className = 'open-link';
    openLink.textContent = doc.name;
    openLink.addEventListener('click', () => {
      window.location.hash = `#/read/${doc.id}`;
    });
    nameTd.append(openLink);

    const pagesTd = document.createElement('td');
    pagesTd.textContent = String(doc.pageCount);

    const sizeTd = document.createElement('td');
    sizeTd.textContent = formatBytes(doc.sizeBytes);

    const identityTd = document.createElement('td');
    identityTd.className = 'mono identity';
    identityTd.title = doc.sha256;
    identityTd.textContent = `${doc.sha256.slice(0, 8)}…`;

    const lastReadTd = document.createElement('td');
    lastReadTd.className = 'last-read';
    lastReadTd.textContent = doc.lastReadPage
      ? `第 ${doc.lastReadPage} 页（${formatDateTime(doc.lastReadAt)}）`
      : '–';

    const actionTd = document.createElement('td');
    const openButton = document.createElement('button');
    openButton.type = 'button';
    openButton.textContent = '打开';
    openButton.addEventListener('click', () => {
      window.location.hash = `#/read/${doc.id}`;
    });
    actionTd.append(openButton);

    tr.append(nameTd, pagesTd, sizeTd, identityTd, lastReadTd, actionTd);
    rows.append(tr);
  }
}

async function handleImport(files) {
  const status = $('#import-status');
  if (!files.length) return;
  let added = 0;
  let existing = 0;
  const failed = [];
  showStatus(status, `导入中…（0/${files.length}）`);
  for (let i = 0; i < files.length; i += 1) {
    showStatus(status, `导入中…（${i}/${files.length}）`);
    try {
      const { created } = await importPdf(files[i]);
      if (created) added += 1;
      else existing += 1;
    } catch (err) {
      failed.push(`${files[i].name}: ${err.message}`);
    }
  }
  const parts = [`导入完成：新增 ${added}，相同内容已存在 ${existing}`];
  if (failed.length) parts.push(`失败 ${failed.length}：${failed.join('；')}`);
  showStatus(status, parts.join('。'));
  await refreshLibrary();
}

$('#import-input').addEventListener('change', (event) => {
  const files = [...event.target.files];
  event.target.value = '';
  handleImport(files);
});

/* 服务设置 */
const settingsDialog = $('#settings-dialog');
$('#settings-button').addEventListener('click', () => {
  $('#service-url-input').value = getServiceBase();
  settingsDialog.showModal();
});
$('#settings-save').addEventListener('click', (event) => {
  event.preventDefault();
  setServiceBase($('#service-url-input').value);
  settingsDialog.close('save');
  refreshLibrary().catch(() => {});
});

/* ---------------- 阅读 ---------------- */

function teardownReader() {
  // 应用内导航（返回书库/切换文档）不触发 pagehide：在清掉去抖定时器与
  // 销毁 viewer 之前先立即落盘，避免 400ms 窗口内的位置变更丢失（审查 B1）。
  if (state.docId && state.viewer?.pdf) {
    persistProgressNow();
  }
  clearTimeout(state.saveTimer);
  state.saveTimer = 0;
  state.docId = null;
  state.ready = Promise.resolve();
  if (state.viewer) {
    state.viewer.destroy();
    state.viewer = null;
  }
  if (state.parsePanel) state.parsePanel.reset();
  // 清除渲染完成标记，避免残留值干扰下次打开时的就绪判定。
  delete $('#viewer').dataset.page;
  delete $('#viewer').dataset.zoom;
}

function updateReaderUi({ page, zoom }) {
  $('#page-input').value = String(page);
  $('#page-input').max = String(state.viewer?.pageCount ?? page);
  $('#zoom-level').textContent = `${Math.round(zoom * 100)}%`;
}

function scheduleSave() {
  clearTimeout(state.saveTimer);
  // 阅读位置变化后立即持久化（短暂去抖合并连续操作）。
  state.saveTimer = setTimeout(persistProgressNow, 400);
}

async function persistProgressNow(useKeepalive = false) {
  clearTimeout(state.saveTimer);
  state.saveTimer = 0;
  if (!state.docId || !state.viewer?.pdf) return;
  const { page, zoom } = state.viewer;
  try {
    await saveProgress(state.docId, page, zoom);
  } catch (err) {
    if (!useKeepalive) console.warn('保存阅读位置失败', err);
  }
}

window.addEventListener('pagehide', () => {
  // 页面关闭/刷新时尽力保存一次（keepalive 请求在页面卸载后仍会送达）。
  if (state.view === 'reader' && state.docId && state.viewer) {
    const { page, zoom } = state.viewer;
    fetch(`${getServiceBase()}/api/documents/${state.docId}/progress`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ page, zoom }),
      keepalive: true,
    }).catch(() => {});
  }
});

async function showReader(docId) {
  teardownReader();
  switchView('reader');
  showStatus($('#reader-error'), '');
  state.docId = docId;

  try {
    const { document: doc } = await fetchDocument(docId);
    $('#reader-title').textContent = doc.name;
    $('#reader-identity').textContent = `身份 ${doc.sha256.slice(0, 12)}…`;
    $('#page-total').textContent = String(doc.pageCount);

    const { progress } = await fetchProgress(docId);

    const viewer = new PdfViewer({ canvas: $('#pdf-canvas'), container: $('#viewer') });
    state.viewer = viewer;

    state.ready = viewer.open(pdfFileUrl(docId), { page: progress.page, zoom: progress.zoom });
    const { page, zoom } = await state.ready;
    updateReaderUi({ page, zoom });
    // 原页已渲染，右侧解析面板独立异步加载，不阻塞阅读。
    state.parsePanel.showPage(docId, page);
  } catch (err) {
    showStatus($('#reader-error'), `无法打开文档：${err.message}`);
  }
}

async function applyViewerAction(action) {
  if (!state.docId) return;
  try {
    await state.ready;
  } catch {
    return; // 打开失败时忽略操作
  }
  if (!state.viewer?.pdf || state.view !== 'reader') return;
  const previousPage = state.viewer.page;
  const result = await action();
  updateReaderUi(result);
  scheduleSave();
  // 翻页后右侧面板跟随当前页；缩放不改页码，不重新加载解析。
  if (result.page !== previousPage) {
    state.parsePanel.showPage(state.docId, result.page);
  }
}

$('#back-button').addEventListener('click', () => {
  window.location.hash = '#/';
});

$('#page-prev').addEventListener('click', () => applyViewerAction(() => state.viewer.prevPage()));
$('#page-next').addEventListener('click', () => applyViewerAction(() => state.viewer.nextPage()));
$('#zoom-in').addEventListener('click', () => applyViewerAction(() => state.viewer.zoomIn()));
$('#zoom-out').addEventListener('click', () => applyViewerAction(() => state.viewer.zoomOut()));
$('#zoom-fit').addEventListener('click', () => applyViewerAction(() => state.viewer.fitWidth()));

function jumpToInputPage() {
  const input = $('#page-input');
  const value = Math.floor(Number(input.value));
  if (!Number.isFinite(value)) return;
  applyViewerAction(() => state.viewer.goTo(value, state.viewer.zoom));
}

$('#page-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') jumpToInputPage();
});
$('#page-input').addEventListener('change', jumpToInputPage);

document.addEventListener('keydown', (event) => {
  if (state.view !== 'reader') return;
  const target = event.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
  if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
    event.preventDefault();
    applyViewerAction(() => state.viewer.prevPage());
  } else if (event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === ' ') {
    event.preventDefault();
    applyViewerAction(() => state.viewer.nextPage());
  } else if (event.key === '+' || event.key === '=') {
    event.preventDefault();
    applyViewerAction(() => state.viewer.zoomIn());
  } else if (event.key === '-') {
    event.preventDefault();
    applyViewerAction(() => state.viewer.zoomOut());
  }
});

// 右侧解析面板：展示当前页解析状态与结构化内容。
state.parsePanel = new ParsePanel({ root: $('#parse-panel') });

// 原页与内容块双向联动（Issue #4）：覆盖层、双向高亮与主动定位。
const linkage = new PageLinkage({
  viewer: $('#viewer'),
  canvas: $('#pdf-canvas'),
  overlay: $('#page-overlay'),
  panel: $('#parse-panel'),
  content: $('#parse-content'),
  toast: $('#locate-toast'),
});
linkage.attach();

route();
