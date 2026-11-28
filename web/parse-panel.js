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
/** 自愈重报阅读位置的冷却时间（避免无队列可建时重复请求）。 */
const SELF_HEAL_COOLDOWN_MS = 10_000;
/**
 * 整体进度慢刷新间隔（毫秒）：阅读视图打开期间的兜底快照刷新。
 * 取 8s（落在 5–10s 区间）：既能让头部文本跟上后台补全，又不会退化成秒级轮询。
 */
const SUMMARY_SLOW_REFRESH_MS = 8_000;

/** 内容块列表变化事件：联动层据此重建原页覆盖框（Issue #4）。 */
export const BLOCKS_CHANGED_EVENT = 'parse-blocks-changed';

/** 单页状态 → 内容列表内联状态条目的徽标文案。 */
const STATE_LABELS = {
  idle: '未开始',
  queued: '排队中',
  running: '解析中',
  succeeded: '已完成',
  failed: '解析失败',
};

/**
 * 阅读视图右侧面板：展示当前页解析状态与结构化内容。
 *
 * - 原页立即打开，面板独立异步加载，不阻塞阅读；
 * - 单页状态内联在内容列表里（未开始/排队中/解析中/已完成/解析失败）；
 *   失败条目带状态徽标、失败原因与显式重试按钮；
 * - 整体进度只有面板头部一处静态文本：事件（派发/完成/失败/重试/翻页）时取一次
 *   快照更新，阅读视图打开期间另以固定 8s 间隔慢刷新一次（离开阅读视图即停止，
 *   不做秒级轮询、不重建页码芯片）；
 * - 按阅读顺序渲染标题、段落、列表、表格与图片资源；缺少位置的块照常展示；
 * - 服务端已持久化的页直接取回结果，不重新解析。
 */
export class ParsePanel {
  constructor({ root }) {
    this.root = root;
    this.contentEl = root.querySelector('#parse-content');
    this.stateEl = root.querySelector('#parse-state');
    this.blocksEl = root.querySelector('#parse-blocks');
    this.hintEl = root.querySelector('#parse-hint');
    this.summaryEl = root.querySelector('#parse-summary');
    this.serviceConfigured = null; // null = 尚未探测
    this.docId = null;
    this.page = null;
    this.parseId = null; // 当前页解析身份（译文绑定/取回用，Issue #8）
    this.generation = 0;
    this.pollTimer = 0;
    this.pollDeadline = 0;
    this.summaryTimer = 0;
    this.summarySlowTimer = 0;
    this.stateKey = '';
    this.lastSelfHealAt = 0;
  }

  /* ---------------- 内联状态（内容列表内） ---------------- */

  /**
   * 渲染当前页的状态条目：徽标 + 说明 +（失败时）显式重试按钮。
   * 状态条目位于内容列表顶部，与内容块同属一个滚动区。
   */
  renderState(status, error = '') {
    this.stateEl.replaceChildren();
    if (!status) return;
    const entry = document.createElement('div');
    entry.className = `parse-entry parse-entry-${status}`;
    entry.dataset.pageStatus = status;
    const badge = document.createElement('span');
    badge.className = 'parse-entry-badge';
    badge.textContent = STATE_LABELS[status] ?? status;
    const text = document.createElement('span');
    text.className = 'parse-entry-text';
    text.textContent = this.stateText(status, error);
    entry.append(badge, text);
    if (status === 'failed') {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'parse-entry-retry';
      retry.textContent = '重试解析';
      retry.addEventListener('click', () => {
        this.startParse().catch(() => {});
      });
      entry.append(retry);
    }
    this.stateEl.append(entry);
  }

  /** 状态条目的说明文案（页码来自当前页）。 */
  stateText(status, error) {
    const page = this.page ?? '?';
    switch (status) {
      case 'idle':
        return `第 ${page} 页尚未开始解析`;
      case 'queued':
        return `第 ${page} 页排队等待解析…`;
      case 'running':
        return `第 ${page} 页正在解析…`;
      case 'succeeded':
        return `第 ${page} 页解析完成`;
      case 'failed':
        return `第 ${page} 页解析失败：${error || '原因未知'}`;
      default:
        return '';
    }
  }

  /** 更新单页状态；状态（及原因）变化时返回 true（用于触发事件式刷新）。 */
  setState(status, error = '') {
    const key = `${status}|${error}`;
    if (key === this.stateKey) return false;
    this.stateKey = key;
    this.renderState(status, error);
    return true;
  }

  clearContent() {
    this.blocksEl.replaceChildren();
    // 注意：不清 this.parseId——renderBlocks 内部会先调用本方法清空 DOM，
    // 随后以当前解析身份发事件；解析身份的生命周期由 showPage/reset/loadResult 管理。
    this.notifyBlocksChanged();
  }

  /**
   * 内容列表变化事件：联动层据此重建原页覆盖框（Issue #4）；翻译层据此取回
   * 当前页解析绑定的译文（Issue #8）。detail 携带 docId/page/parseId。
   */
  notifyBlocksChanged() {
    this.root.dispatchEvent(
      new CustomEvent(BLOCKS_CHANGED_EVENT, {
        bubbles: true,
        detail: { docId: this.docId, page: this.page, parseId: this.parseId ?? null },
      }),
    );
  }

  /* ---------------- 生命周期 ---------------- */

  reset() {
    this.generation += 1;
    clearTimeout(this.pollTimer);
    this.pollTimer = 0;
    clearTimeout(this.summaryTimer);
    this.summaryTimer = 0;
    // 离开阅读视图：停止慢刷新（头部快照不再取数）。
    this.stopSlowSummary();
    this.hideSummary();
    this.lastSelfHealAt = 0;
    this.docId = null;
    this.page = null;
    this.parseId = null;
    this.pollDeadline = 0;
    this.stateKey = '';
    this.stateEl.replaceChildren();
    this.clearContent();
    this.hintEl.hidden = true;
  }

  /** 切换到指定文档页；同页重复调用为无操作。 */
  showPage(docId, page) {
    if (this.docId === docId && this.page === page) return;
    this.generation += 1;
    clearTimeout(this.pollTimer);
    this.pollTimer = 0;
    clearTimeout(this.summaryTimer);
    this.summaryTimer = 0;
    this.docId = docId;
    this.page = page;
    this.parseId = null;
    this.stateKey = '';
    this.stateEl.replaceChildren();
    this.clearContent();
    // 尚未探测到服务配置前不渲染任何状态条目：避免「未配置解析服务」时闪现进度残留。
    if (this.serviceConfigured === true) this.setState('idle');
    this.load().catch((err) => {
      console.warn('解析面板加载失败', err);
    });
  }

  async load() {
    const generation = this.generation;
    this.pollDeadline = 0;
    if (this.serviceConfigured === null) {
      const service = await fetchParseService();
      // 页面可能已切换，丢弃过期响应。
      if (generation !== this.generation) return;
      this.serviceConfigured = Boolean(service.configured);
    }
    if (!this.serviceConfigured) {
      // 未配置解析服务：只保留一行静态提示，界面无任何进度残留。
      this.hideSummary();
      this.hintEl.hidden = false;
      this.stateKey = '';
      this.stateEl.replaceChildren();
      this.clearContent();
      return;
    }
    this.hintEl.hidden = true;
    // 服务已配置：此时才渲染单页状态条目（此前界面无任何进度残留）。
    if (!this.stateKey) this.setState('idle');
    // 事件式刷新整体进度（打开/翻页等事件后取一次快照，不轮询）。
    this.refreshSummary();
    // 阅读视图打开期间开启慢刷新（固定 8s 间隔），离开阅读视图即停止。
    this.scheduleSlowSummary();
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
      this.setState('failed', `获取解析状态失败：${err.message}`);
      this.refreshSummary();
      return;
    }
    if (generation !== this.generation) return;

    if (status.status === 'succeeded') {
      await this.loadResult(generation);
      return;
    }
    if (status.status === 'failed') {
      if (this.setState('failed', status.error ?? '解析失败，原因未知')) this.refreshSummary();
      return;
    }
    if (status.status === 'running') {
      if (this.setState('running')) this.refreshSummary();
      // 首次加载即见到「已开始」（如另一端已发起）时同样需要超时基线。
      if (!this.pollDeadline) this.pollDeadline = Date.now() + POLL_MAX_MS;
      this.schedulePoll(generation);
      return;
    }
    if (status.status === 'queued') {
      // 已被调度器接受但并发占满：排在队列中等待解析。
      if (this.setState('queued')) this.refreshSummary();
      if (!this.pollDeadline) this.pollDeadline = Date.now() + POLL_MAX_MS;
      this.schedulePoll(generation);
      return;
    }
    // idle：未开始。
    if (startIfIdle) {
      await this.startParse(generation);
    } else {
      this.setState('idle');
    }
  }

  async startParse(generation = this.generation) {
    if (generation !== this.generation) return;
    const { docId, page } = this;
    let body;
    try {
      body = await requestPageParse(docId, page);
    } catch (err) {
      if (generation !== this.generation) return;
      this.setState('failed', `发起解析失败：${err.message}`);
      this.refreshSummary();
      return;
    }
    if (generation !== this.generation) return;
    this.setState(body?.status === 'queued' ? 'queued' : 'running');
    this.pollDeadline = Date.now() + POLL_MAX_MS;
    this.schedulePoll(generation);
    // 派发事件（含显式重试）：刷新一次整体进度。
    this.refreshSummary();
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
      this.setState('failed', '解析任务长时间未完成，可稍后重试。');
      this.refreshSummary();
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

  /* ---------------- 整体进度（事件式静态文本） ---------------- */

  /** 隐藏整体进度文本（未配置解析服务 / 无快照时）。 */
  hideSummary() {
    this.summaryEl.textContent = '';
    this.summaryEl.hidden = true;
  }

  /**
   * 事件式刷新整体进度：仅在派发/完成/失败/重试/翻页等事件后取一次快照。
   * 没有秒级轮询，也不重建任何页码列表（面板头部只有一处静态文本）。
   */
  refreshSummary() {
    if (!this.docId || this.serviceConfigured !== true) return;
    // 事件刚取过快照 → 慢刷新重新计时，避免事件后紧接着重复取数。
    this.scheduleSlowSummary();
    if (this.summaryTimer) return; // 同一批事件合并为一次刷新
    this.summaryTimer = setTimeout(() => {
      this.summaryTimer = 0;
      this.fetchSummary().catch(() => {});
    }, 0);
  }

  /** 取一次整本进度快照：更新头部静态文本，并做低成本自愈检查。 */
  async fetchSummary() {
    const generation = this.generation;
    let snapshot;
    try {
      snapshot = await fetchParseProgress(this.docId);
    } catch {
      /* 服务不可达/重启中：保持当前文本 */
      return;
    }
    if (generation !== this.generation) return;
    this.applySummary(snapshot);
    // 低成本自愈：队列与进行中任务都丢失（如服务重启）且仍有未开始页时，
    // 自动重新上报阅读位置恢复调度（带冷却；Issue #6 的完整重连调度另行交付）。
    if (snapshot.idle > 0 && snapshot.running === 0 && snapshot.queued === 0) {
      const now = Date.now();
      if (now - this.lastSelfHealAt > SELF_HEAL_COOLDOWN_MS) {
        this.lastSelfHealAt = now;
        updateReadingPosition(this.docId, this.page).catch(() => {});
      }
    }
  }

  /* ---------------- 整体进度慢刷新（阅读期间定时快照） ---------------- */

  /**
   * 安排下一次慢刷新（幂等）：仅在阅读视图打开且解析服务已配置时运行。
   * 每次快照（事件式或慢刷新）后都重新计时 → 相邻两次快照间隔 ≥ 8s，
   * 既不会退化成秒级轮询，也不会在事件后紧接着重复取数。
   */
  scheduleSlowSummary() {
    clearTimeout(this.summarySlowTimer);
    this.summarySlowTimer = 0;
    if (this.serviceConfigured !== true || !this.docId) return;
    this.summarySlowTimer = setTimeout(() => {
      this.summarySlowTimer = 0;
      this.slowRefreshSummary().catch(() => {});
    }, SUMMARY_SLOW_REFRESH_MS);
  }

  /** 停止慢刷新（离开阅读视图 / 面板重置）。 */
  stopSlowSummary() {
    clearTimeout(this.summarySlowTimer);
    this.summarySlowTimer = 0;
  }

  /**
   * 慢刷新一次整本快照：只更新头部静态文本。
   * 不做自愈重排（自愈仍由事件式刷新驱动，调度语义不变）。
   */
  async slowRefreshSummary() {
    const generation = this.generation;
    if (generation !== this.generation) return;
    if (this.serviceConfigured !== true || !this.docId) return;
    try {
      const snapshot = await fetchParseProgress(this.docId);
      if (generation !== this.generation) return;
      this.applySummary(snapshot);
    } catch {
      /* 服务不可达/重启中：保持当前文本 */
    }
    // 阅读视图仍在且服务已配置 → 继续下一轮慢刷新。
    this.scheduleSlowSummary();
  }

  /** 整体进度静态文本（如「解析 12/215 · 失败 1」）。 */
  applySummary(snapshot) {
    if (!snapshot || this.serviceConfigured !== true) {
      this.hideSummary();
      return;
    }
    const parts = [`解析 ${snapshot.succeeded}/${snapshot.total}`];
    if (snapshot.failed > 0) parts.push(`失败 ${snapshot.failed}`);
    if (snapshot.running > 0) parts.push(`解析中 ${snapshot.running}`);
    if (snapshot.queued > 0) parts.push(`排队 ${snapshot.queued}`);
    this.summaryEl.textContent = parts.join(' · ');
    this.summaryEl.hidden = false;
  }

  /* ---------------- 结果加载与内容渲染 ---------------- */

  async loadResult(generation) {
    const { docId, page } = this;
    let result;
    try {
      ({ parse: result } = await fetchParseResult(docId, page));
    } catch (err) {
      if (generation !== this.generation) return;
      this.setState('failed', `获取解析结果失败：${err.message}`);
      this.refreshSummary();
      return;
    }
    if (generation !== this.generation) return;
    this.setState('succeeded');
    this.parseId = result.parseId ?? null;
    this.renderBlocks(result.blocks);
    // 完成事件：刷新一次整体进度。
    this.refreshSummary();
  }

  renderBlocks(blocks) {
    this.clearContent();
    const fragment = document.createDocumentFragment();
    let count = 0;
    for (const block of blocks ?? []) {
      const node = this.renderBlock(block);
      if (node) {
        fragment.append(node);
        count += 1;
      }
    }
    if (count === 0) {
      const empty = document.createElement('p');
      empty.className = 'parse-empty';
      empty.textContent = '本页没有可展示的解析内容。';
      fragment.append(empty);
    }
    this.blocksEl.append(fragment);
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
    // 内容块翻译入口（Issue #8）：标题/段落/列表/表格可整块翻译；图片无文本不提供。
    if (block.kind === 'heading' || block.kind === 'paragraph' || block.kind === 'list' || block.kind === 'table') {
      const translate = document.createElement('button');
      translate.type = 'button';
      translate.className = 'block-translate-button';
      translate.textContent = '翻译';
      translate.title = '翻译此内容块（MiniMax-M3.1-Flash → 中文）';
      translate.dataset.translateBlockButton = 'true';
      wrapper.append(translate);
    }
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
