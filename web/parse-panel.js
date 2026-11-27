import {
  fetchParseService,
  fetchParseStatus,
  fetchParseResult,
  fetchParseProgress,
  requestPageParse,
  updateReadingPosition,
} from './api.js';

const POLL_INTERVAL_MS = 500;
const POLL_MAX_MS = 10 * 60 * 1000;
/** 整本进度轮询间隔：后台补全/失败也要在界面上可见（Issue #5）。 */
const PROGRESS_POLL_INTERVAL_MS = 1000;
/** 自愈重报阅读位置的冷却时间（避免无队列可建时重复请求）。 */
const SELF_HEAL_COOLDOWN_MS = 10_000;

/** 内容块列表变化事件：联动层据此重建原页覆盖框（Issue #4）。 */
export const BLOCKS_CHANGED_EVENT = 'parse-blocks-changed';

/** 点击整本进度页码芯片：阅读视图跳到对应页（Issue #5）。 */
export const PROGRESS_JUMP_EVENT = 'parse-progress-jump';

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
    this.progressEl = root.querySelector('#parse-progress');
    this.progressSummaryEl = root.querySelector('#parse-progress-summary');
    this.progressPagesEl = root.querySelector('#parse-progress-pages');
    this.serviceConfigured = null; // null = 尚未探测
    this.docId = null;
    this.page = null;
    this.generation = 0;
    this.pollTimer = 0;
    this.pollDeadline = 0;
    this.progressTimer = 0;
    this.lastSelfHealAt = 0;

    this.retryEl.addEventListener('click', () => {
      this.startParse().catch(() => {});
    });
    // 整本进度页码芯片：点击跳到对应页（跳转逻辑由阅读视图处理，组件零耦合）。
    this.progressPagesEl.addEventListener('click', (event) => {
      const chip = event.target.closest('.parse-page-chip');
      if (!chip) return;
      const page = Number(chip.dataset.page);
      if (!Number.isInteger(page) || page < 1) return;
      this.root.dispatchEvent(
        new CustomEvent(PROGRESS_JUMP_EVENT, { detail: { page }, bubbles: true }),
      );
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
    this.notifyBlocksChanged();
  }

  notifyBlocksChanged() {
    this.root.dispatchEvent(new CustomEvent(BLOCKS_CHANGED_EVENT, { bubbles: true }));
  }

  /* ---------------- 生命周期 ---------------- */

  reset() {
    this.generation += 1;
    clearTimeout(this.pollTimer);
    this.pollTimer = 0;
    this.stopProgressPolling();
    this.showProgress(false);
    this.lastSelfHealAt = 0;
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
    // 整本进度独立轮询：后台补全/失败不依赖当前页状态（Issue #5）。
    this.refreshProgress();
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
      this.stopProgressPolling();
      this.showProgress(false);
      return;
    }
    this.hintEl.hidden = true;
    // 服务探测结论为已配置后才启动整本进度展示（避免未配置时进度区闪现）。
    this.refreshProgress();
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
    if (status.status === 'queued') {
      // 已被调度器接受但并发占满：排在队列中等待解析。
      this.setStatus('已排队，等待解析…', 'running');
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
    let body;
    try {
      body = await requestPageParse(docId, page);
    } catch (err) {
      if (generation !== this.generation) return;
      this.setStatus('解析失败', 'failed');
      this.showError(`发起解析失败：${err.message}`);
      this.showRetry(true);
      return;
    }
    if (generation !== this.generation) return;
    this.setStatus(body?.status === 'queued' ? '已排队，等待解析…' : '解析中…', 'running');
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

  /* ---------------- 整本进度（Issue #5） ---------------- */

  showProgress(visible) {
    this.progressEl.hidden = !visible;
    if (!visible) {
      this.progressSummaryEl.textContent = '';
      this.progressPagesEl.replaceChildren();
    }
  }

  stopProgressPolling() {
    clearTimeout(this.progressTimer);
    this.progressTimer = 0;
  }

  /** 轮询整本解析进度：逐页状态、整体计数与失败原因；服务不可达时跳过本轮。 */
  refreshProgress() {
    // 以服务探测结果为准（pending 阶段不渲染，未配置时保持隐藏）。
    if (!this.docId || this.serviceConfigured !== true) return;
    clearTimeout(this.progressTimer);
    const generation = this.generation;
    fetchParseProgress(this.docId)
      .then((snapshot) => {
        if (generation !== this.generation) return;
        this.renderProgress(snapshot);
        // 低成本自愈：队列与进行中任务都丢失（如服务重启）且仍有未开始页时，
        // 自动重新上报阅读位置恢复调度（带冷却；Issue #6 的完整重连调度另行交付）。
        if (
          this.serviceConfigured === true &&
          snapshot.idle > 0 &&
          snapshot.running === 0 &&
          snapshot.queued === 0
        ) {
          const now = Date.now();
          if (now - this.lastSelfHealAt > SELF_HEAL_COOLDOWN_MS) {
            this.lastSelfHealAt = now;
            updateReadingPosition(this.docId, this.page).catch(() => {});
          }
        }
      })
      .catch(() => {
        /* 服务不可达/重启中：跳过本轮，继续轮询 */
      })
      .finally(() => {
        if (generation !== this.generation || this.serviceConfigured !== true) return;
        this.progressTimer = setTimeout(() => this.refreshProgress(), PROGRESS_POLL_INTERVAL_MS);
      });
  }

  renderProgress(snapshot) {
    // 未配置/尚未探测完成时保持隐藏（迟到的响应不得显示进度区）。
    if (this.serviceConfigured !== true) return;
    this.showProgress(true);
    const parts = [`已解析 ${snapshot.succeeded}/${snapshot.total}`];
    if (snapshot.failed > 0) parts.push(`失败 ${snapshot.failed}`);
    if (snapshot.running > 0) parts.push(`解析中 ${snapshot.running}`);
    if (snapshot.queued > 0) parts.push(`排队 ${snapshot.queued}`);
    this.progressSummaryEl.textContent = parts.join(' · ');

    const fragment = document.createDocumentFragment();
    for (const page of snapshot.pages ?? []) {
      fragment.append(this.renderPageChip(page));
    }
    this.progressPagesEl.replaceChildren(fragment);
  }

  renderPageChip(page) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `parse-page-chip chip-${page.status}`;
    chip.dataset.page = String(page.page);
    chip.dataset.status = page.status;
    chip.textContent = String(page.page);
    const labels = {
      succeeded: '已解析',
      failed: `解析失败：${page.error ?? '原因未知'}`,
      running: '解析中',
      queued: '排队等待解析',
      idle: '未开始',
    };
    const label = `第 ${page.page} 页 ${labels[page.status] ?? page.status}`;
    chip.title = label;
    chip.setAttribute('aria-label', label);
    return chip;
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
    this.notifyBlocksChanged();
  }

  renderBlock(block) {
    const wrapper = document.createElement('div');
    wrapper.className = `parse-block parse-block-${block.kind}`;
    wrapper.dataset.blockId = block.id ?? '';
    wrapper.dataset.kind = block.kind;
    wrapper.dataset.hasPosition = block.bbox ? 'true' : 'false';
    // 原始 bbox（PDF 坐标）随 DOM 提供，联动层按当前渲染缩放换算覆盖位置。
    if (block.bbox) wrapper.dataset.bbox = JSON.stringify(block.bbox);

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
