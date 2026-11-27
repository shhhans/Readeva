import {
  fetchParseService,
  fetchParseStatus,
  fetchParseResult,
  requestPageParse,
} from './api.js';

const POLL_INTERVAL_MS = 500;
const POLL_MAX_MS = 10 * 60 * 1000;

/**
 * 阅读视图右侧面板：展示当前页解析状态与结构化内容。
 *
 * - 原页立即打开，面板独立异步加载，不阻塞阅读；
 * - 状态可见：未开始 / 解析中（已开始）/ 已完成 / 解析失败（含原因，可重试）；
 * - 按阅读顺序渲染标题、段落、列表、表格与图片资源；缺少位置的块照常展示；
 * - 服务端已持久化的页直接取回结果，不重新解析。
 */
export class ParsePanel {
  constructor({ root }) {
    this.root = root;
    this.statusEl = root.querySelector('#parse-status');
    this.errorEl = root.querySelector('#parse-error');
    this.retryEl = root.querySelector('#parse-retry');
    this.contentEl = root.querySelector('#parse-content');
    this.hintEl = root.querySelector('#parse-hint');
    this.serviceConfigured = null; // null = 尚未探测
    this.docId = null;
    this.page = null;
    this.generation = 0;
    this.pollTimer = 0;
    this.pollDeadline = 0;

    this.retryEl.addEventListener('click', () => {
      this.startParse().catch(() => {});
    });
  }

  /* ---------------- 状态展示 ---------------- */

  setStatus(text, kind = '') {
    this.statusEl.textContent = text;
    this.statusEl.dataset.kind = kind;
  }

  showError(text) {
    this.errorEl.textContent = text ?? '';
    this.errorEl.hidden = !text;
  }

  showRetry(visible) {
    this.retryEl.hidden = !visible;
  }

  clearContent() {
    this.contentEl.replaceChildren();
  }

  /* ---------------- 生命周期 ---------------- */

  reset() {
    this.generation += 1;
    clearTimeout(this.pollTimer);
    this.pollTimer = 0;
    this.docId = null;
    this.page = null;
    this.pollDeadline = 0;
    this.setStatus('未开始', 'idle');
    this.showError('');
    this.showRetry(false);
    this.clearContent();
  }

  /** 切换到指定文档页；同页重复调用为无操作。 */
  showPage(docId, page) {
    if (this.docId === docId && this.page === page) return;
    this.generation += 1;
    clearTimeout(this.pollTimer);
    this.pollTimer = 0;
    this.docId = docId;
    this.page = page;
    this.showError('');
    this.showRetry(false);
    this.clearContent();
    this.setStatus('未开始', 'idle');
    this.load().catch((err) => {
      console.warn('解析面板加载失败', err);
    });
  }

  async load() {
    const generation = this.generation;
    const { docId, page } = this;
    this.pollDeadline = 0;
    if (this.serviceConfigured === null) {
      const service = await fetchParseService();
      // 页面可能已切换，丢弃过期响应。
      if (generation !== this.generation) return;
      this.serviceConfigured = Boolean(service.configured);
    }
    if (!this.serviceConfigured) {
      this.setStatus('解析服务未配置', 'unavailable');
      this.hintEl.hidden = false;
      return;
    }
    this.hintEl.hidden = true;
    await this.refreshStatus(generation, { startIfIdle: true });
  }

  async refreshStatus(generation, { startIfIdle = false } = {}) {
    if (generation !== this.generation) return;
    const { docId, page } = this;
    let status;
    try {
      status = await fetchParseStatus(docId, page);
    } catch (err) {
      if (generation !== this.generation) return;
      this.setStatus('状态未知', 'failed');
      this.showError(`获取解析状态失败：${err.message}`);
      return;
    }
    if (generation !== this.generation) return;

    if (status.status === 'succeeded') {
      await this.loadResult(generation);
      return;
    }
    if (status.status === 'failed') {
      this.setStatus('解析失败', 'failed');
      this.showError(status.error ?? '解析失败，原因未知');
      this.showRetry(true);
      return;
    }
    if (status.status === 'running') {
      this.setStatus('解析中…', 'running');
      // 首次加载即见到「已开始」（如另一端已发起）时同样需要超时基线。
      if (!this.pollDeadline) this.pollDeadline = Date.now() + POLL_MAX_MS;
      this.schedulePoll(generation);
      return;
    }
    // idle：未开始。
    if (startIfIdle) {
      await this.startParse(generation);
    } else {
      this.setStatus('未开始', 'idle');
    }
  }

  async startParse(generation = this.generation) {
    if (generation !== this.generation) return;
    const { docId, page } = this;
    this.showError('');
    this.showRetry(false);
    try {
      await requestPageParse(docId, page);
    } catch (err) {
      if (generation !== this.generation) return;
      this.setStatus('解析失败', 'failed');
      this.showError(`发起解析失败：${err.message}`);
      this.showRetry(true);
      return;
    }
    if (generation !== this.generation) return;
    this.setStatus('解析中…', 'running');
    this.pollDeadline = Date.now() + POLL_MAX_MS;
    this.schedulePoll(generation);
  }

  schedulePoll(generation) {
    clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => {
      this.pollOnce(generation).catch(() => {});
    }, POLL_INTERVAL_MS);
  }

  async pollOnce(generation) {
    if (generation !== this.generation) return;
    if (Date.now() > this.pollDeadline) {
      this.setStatus('解析超时', 'failed');
      this.showError('解析任务长时间未完成，可稍后重试。');
      this.showRetry(true);
      return;
    }
    const { docId, page } = this;
    let status;
    try {
      status = await fetchParseStatus(docId, page);
    } catch (err) {
      // 服务可能正在重启（如测试中）：任务丢失后状态回到 idle，重新发起。
      if (generation !== this.generation) return;
      this.schedulePoll(generation);
      return;
    }
    if (generation !== this.generation) return;
    if (status.status === 'idle') {
      // 服务重启导致进行中任务丢失：重新发起解析。
      await this.startParse(generation);
      return;
    }
    await this.refreshStatus(generation);
  }

  async loadResult(generation) {
    const { docId, page } = this;
    let result;
    try {
      ({ parse: result } = await fetchParseResult(docId, page));
    } catch (err) {
      if (generation !== this.generation) return;
      this.setStatus('解析失败', 'failed');
      this.showError(`获取解析结果失败：${err.message}`);
      this.showRetry(true);
      return;
    }
    if (generation !== this.generation) return;
    this.setStatus('已完成', 'succeeded');
    this.renderBlocks(result.blocks);
  }

  /* ---------------- 内容渲染 ---------------- */

  renderBlocks(blocks) {
    this.clearContent();
    const fragment = document.createDocumentFragment();
    for (const block of blocks ?? []) {
      const node = this.renderBlock(block);
      if (node) fragment.append(node);
    }
    if (fragment.childNodes.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'parse-empty';
      empty.textContent = '本页没有可展示的解析内容。';
      fragment.append(empty);
    }
    this.contentEl.append(fragment);
  }

  renderBlock(block) {
    const wrapper = document.createElement('div');
    wrapper.className = `parse-block parse-block-${block.kind}`;
    wrapper.dataset.blockId = block.id ?? '';
    wrapper.dataset.kind = block.kind;
    wrapper.dataset.hasPosition = block.bbox ? 'true' : 'false';

    let inner;
    switch (block.kind) {
      case 'heading':
        inner = document.createElement(block.level === 1 ? 'h3' : 'h4');
        inner.className = 'parse-heading';
        inner.textContent = block.text;
        break;
      case 'paragraph':
        inner = document.createElement('p');
        inner.className = 'parse-paragraph';
        inner.textContent = block.text;
        break;
      case 'list': {
        inner = document.createElement(block.ordered ? 'ol' : 'ul');
        inner.className = 'parse-list';
        for (const item of block.items ?? []) {
          const li = document.createElement('li');
          li.textContent = item;
          inner.append(li);
        }
        break;
      }
      case 'table':
        inner = this.renderTable(block);
        break;
      case 'image':
        inner = this.renderImage(block);
        break;
      default:
        return null;
    }
    wrapper.append(inner);
    return wrapper;
  }

  renderTable(block) {
    const table = document.createElement('table');
    table.className = 'parse-table';
    const rows = block.rows ?? [];
    const bodyRows = block.columnHeader ? rows.slice(1) : rows;
    if (block.columnHeader && rows.length > 0) {
      const thead = document.createElement('thead');
      const tr = document.createElement('tr');
      for (const cell of rows[0]) {
        const th = document.createElement('th');
        th.textContent = cell;
        tr.append(th);
      }
      thead.append(tr);
      table.append(thead);
    }
    const tbody = document.createElement('tbody');
    for (const row of bodyRows) {
      const tr = document.createElement('tr');
      for (const cell of row ?? []) {
        const td = document.createElement('td');
        td.textContent = cell;
        tr.append(td);
      }
      tbody.append(tr);
    }
    table.append(tbody);
    return table;
  }

  renderImage(block) {
    const figure = document.createElement('figure');
    figure.className = 'parse-figure';
    const uri = block.image?.uri;
    if (uri) {
      const img = document.createElement('img');
      img.className = 'parse-image';
      img.src = uri;
      img.alt = '解析图片资源';
      figure.append(img);
    } else {
      const placeholder = document.createElement('p');
      placeholder.className = 'parse-placeholder';
      placeholder.textContent = '（图片资源不可用）';
      figure.append(placeholder);
    }
    return figure;
  }
}
