import { fetchDictionaryLookup } from './api.js';
import { BLOCKS_CHANGED_EVENT } from './parse-panel.js';

/**
 * 考试标签 → 展示文案（ECDICT tag 字段，空格分割）。
 */
const TAG_LABELS = {
  zk: '中考',
  gk: '高考',
  cet4: '四级',
  cet6: '六级',
  ky: '考研',
  toefl: '托福',
  ielts: '雅思',
  gre: 'GRE',
};

/**
 * ECDICT exchange 字段类型 → 展示文案。
 * 格式为 “p:did/d:done/i:doing/3:does” 的斜杠分割项目。
 */
const EXCHANGE_LABELS = {
  p: '过去式',
  d: '过去分词',
  i: '现在分词',
  3: '第三人称单数',
  r: '比较级',
  t: '最高级',
  s: '复数',
  0: '词根',
};

/** 词性占比（pos 形如 n:8/v:2）→ 「名 8% · 动 2%」。 */
const POS_LABELS = { n: '名', v: '动', a: '形', adv: '副', prep: '介', conj: '连', pron: '代', num: '数', int: '感叹' };

/**
 * 无归因信息时的静态页脚文案（词典未准备/查询失败时降级到它）。
 */
const STATIC_ATTRIBUTION_TEXT = '释义来自本地 ECDICT 词典（MIT License）· 离线查询';

function formatPos(raw) {
  if (!raw || !/^[a-z0-9]+:/i.test(raw)) return null;
  const parts = raw
    .split('/')
    .map((seg) => {
      const match = /^([a-z0-9]+):(\d+)$/i.exec(seg.trim());
      if (!match) return null;
      const label = POS_LABELS[match[1].toLowerCase()] ?? match[1];
      return `${label} ${match[2]}%`;
    })
    .filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

function formatExchange(raw) {
  if (!raw) return [];
  return raw
    .split('/')
    .map((seg) => {
      const index = seg.indexOf(':');
      if (index <= 0) return null;
      const kind = seg.slice(0, index).trim();
      const word = seg.slice(index + 1).trim();
      if (!word) return null;
      const label = EXCHANGE_LABELS[kind] ?? kind;
      return `${label} ${word}`;
    })
    .filter(Boolean);
}

/**
 * 阅读视图选词查词（Issue #7）：ECDICT 离线英汉查询。
 *
 * 交互流程：
 * - 在右侧解析原文（#parse-content）内选中文本（双击选词/拖选）后，
 *   浮现工具条，点「查词」发起查询（主动触发，不自动弹窗）；
 * - 结果以固定卡片停靠在面板底部：词条、音标、考试标签、中英释义、
 *   词性/词频/词形变化；无词条/词典未准备/查询失败均有明确反馈；
 * - 查询是服务端纯本地操作（ECDICT 构建数据），断网仍可查询；
 *   首版不维护查词历史（不留存任何历史数据）。
 *
 * 组件零耦合：仅监听 #parse-content 的选择与内容变化事件（复用
 * ParsePanel 的 BLOCKS_CHANGED_EVENT），不改解析面板内部逻辑。
 */
export class WordLookup {
  constructor({ panel, content, toolbar, lookupButton, card, elements }) {
    this.panel = panel;
    this.content = content;
    this.toolbar = toolbar;
    this.lookupButton = lookupButton;
    this.card = card;
    this.el = elements; // { word, phonetic, close, status, translation, translationText, definition, definitionText, meta, attribution }
    this.selectedText = '';
    this.lookupToken = 0;
    this.onPointerUp = this.onPointerUp.bind(this);
    this.onKeyDown = this.onKeyDown.bind(this);
    this.hideToolbar = this.hideToolbar.bind(this);
  }

  attach() {
    document.addEventListener('pointerup', this.onPointerUp);
    document.addEventListener('keydown', this.onKeyDown);
    this.content.addEventListener('scroll', this.hideToolbar, { passive: true });
    this.lookupButton.addEventListener('click', () => this.lookupSelection());
    this.el.close.addEventListener('click', () => this.closeCard());
    // 内容列表重渲染（翻页/重解析）后旧选区失效：隐藏工具条。
    this.panel.addEventListener(BLOCKS_CHANGED_EVENT, this.hideToolbar);
  }

  reset() {
    this.selectedText = '';
    this.lookupToken += 1; // 使在途查询的响应作废
    this.hideToolbar();
    this.closeCard();
  }

  onKeyDown(event) {
    if (event.key === 'Escape' && !this.toolbar.hidden) this.hideToolbar();
  }

  onPointerUp() {
    // 选择在 pointerup 后才最终确定，延迟一帧读取。
    setTimeout(() => this.syncSelection(), 0);
  }

  syncSelection() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      this.selectedText = '';
      this.hideToolbar();
      return;
    }
    const anchor = selection.anchorNode;
    if (!anchor || !this.content.contains(anchor)) {
      this.selectedText = '';
      this.hideToolbar();
      return;
    }
    const text = selection.toString();
    if (!text.trim()) {
      this.selectedText = '';
      this.hideToolbar();
      return;
    }
    this.selectedText = text;
    this.showToolbar(selection);
  }

  showToolbar(selection) {
    let rect;
    try {
      rect = selection.getRangeAt(0).getBoundingClientRect();
    } catch {
      this.hideToolbar();
      return;
    }
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      this.hideToolbar();
      return;
    }
    this.toolbar.hidden = false;
    const width = this.toolbar.offsetWidth;
    const height = this.toolbar.offsetHeight;
    const centerX = rect.left + rect.width / 2;
    const left = Math.min(Math.max(centerX - width / 2, 8), window.innerWidth - width - 8);
    let top = rect.top - height - 6;
    if (top < 8) top = rect.bottom + 6; // 上方放不下：放到选区下方
    this.toolbar.style.left = `${Math.round(left)}px`;
    this.toolbar.style.top = `${Math.round(Math.max(top, 8))}px`;
  }

  hideToolbar() {
    this.toolbar.hidden = true;
  }

  closeCard() {
    this.card.hidden = true;
    this.lookupToken += 1;
  }

  async lookupSelection() {
    const word = (this.selectedText ?? '').trim();
    if (!word) return;
    const token = ++this.lookupToken;
    this.selectedText = '';
    // 消费掉当前选区（点查词时浏览器保留文本选区，不清除会让工具条重新浮现）。
    window.getSelection()?.removeAllRanges();
    this.hideToolbar();
    this.showCard();
    this.setStatus(`查询中…`);
    try {
      const { entry, license, dataSources } = await fetchDictionaryLookup(word);
      if (token !== this.lookupToken) return; // 已有新查询/已关闭：丢弃过期响应
      this.renderEntry(entry, { license, dataSources });
    } catch (err) {
      if (token !== this.lookupToken) return;
      this.renderError(word, err);
    }
  }

  showCard() {
    for (const el of [
      this.el.status,
      this.el.translation,
      this.el.definition,
      this.el.meta,
    ]) {
      el.hidden = true;
    }
    this.el.word.textContent = '';
    this.el.phonetic.textContent = '';
    this.el.phonetic.hidden = true;
    this.el.status.textContent = '';
    // 查询中：先回到静态归因文案，命中后由 renderAttribution 换成真实归因。
    this.renderAttribution(null);
    this.card.hidden = false;
  }

  setStatus(text) {
    this.el.status.textContent = text;
    this.el.status.hidden = false;
  }

  renderEntry(entry, attribution) {
    this.el.status.hidden = true;
    this.renderAttribution(attribution);
    this.el.word.textContent = entry.word ?? '';
    if (entry.phonetic) {
      this.el.phonetic.textContent = entry.phonetic;
      this.el.phonetic.hidden = false;
    }

    // 中文释义：ECDICT 以字面 “\n” 分行，逐行渲染（纯文本节点，无 HTML 注入）。
    const translationLines = (entry.translation ?? '').split('\n').filter((line) => line.trim());
    this.el.translationText.replaceChildren();
    translationLines.forEach((line, index) => {
      if (index > 0) this.el.translationText.append(document.createElement('br'));
      this.el.translationText.append(document.createTextNode(line));
    });
    this.el.translation.hidden = translationLines.length === 0;

    const definitionLines = (entry.definition ?? '').split('\n').filter((line) => line.trim());
    this.el.definitionText.replaceChildren();
    definitionLines.forEach((line, index) => {
      if (index > 0) this.el.definitionText.append(document.createElement('br'));
      this.el.definitionText.append(document.createTextNode(line));
    });
    this.el.definition.hidden = definitionLines.length === 0;

    // 元信息行：考试标签芯片 + 柯林斯/牛津 + 词性 + 词频 + 词形变化。
    const meta = document.createDocumentFragment();
    const tags = document.createElement('span');
    tags.className = 'dict-tags';
    for (const raw of (entry.tag ?? '').split(/\s+/).filter(Boolean)) {
      const chip = document.createElement('span');
      chip.className = 'dict-tag';
      chip.textContent = TAG_LABELS[raw] ?? raw;
      tags.append(chip);
    }
    if (tags.childElementCount > 0) meta.append(tags);

    const facts = [];
    if (entry.collins > 0) facts.push(`柯林斯 ${'★'.repeat(entry.collins)}`);
    if (entry.oxford > 0) facts.push('牛津核心');
    const posText = formatPos(entry.pos);
    if (posText) facts.push(posText);
    if (entry.bnc > 0) facts.push(`BNC ${entry.bnc}`);
    if (entry.frq > 0) facts.push(`词频 ${entry.frq}`);
    if (facts.length) {
      const line = document.createElement('span');
      line.className = 'dict-facts';
      line.textContent = facts.join(' · ');
      meta.append(line);
    }

    const exchanges = formatExchange(entry.exchange);
    if (exchanges.length) {
      const line = document.createElement('span');
      line.className = 'dict-exchange';
      line.textContent = exchanges.join(' · ');
      meta.append(line);
    }

    this.el.meta.replaceChildren(meta);
    this.el.meta.hidden = this.el.meta.childElementCount === 0;
  }

  /**
   * 结果卡片页脚归因：展示真实许可与上游数据来源（来自构建产物 manifest.json，
   * 服务端随查询响应一起回传）。无归因信息时降级为静态文案。
   */
  renderAttribution(attribution) {
    const footer = this.el.attribution;
    if (!footer) return;
    const license = attribution?.license ?? null;
    const dataSources = attribution?.dataSources ?? null;
    if (!license && !dataSources) {
      footer.textContent = STATIC_ATTRIBUTION_TEXT;
      footer.removeAttribute('data-attribution');
      return;
    }
    footer.replaceChildren();
    const main = document.createElement('span');
    main.className = 'dict-attribution-main';
    const licenseName = license?.name ? `${license.name} License` : null;
    main.textContent = `释义来自 ECDICT 离线词典${licenseName ? `（${licenseName}）` : ''}· 离线查询`;
    const details = [license?.copyright, license?.url].filter(Boolean).join(' · ');
    if (details) main.title = details;
    footer.append(main);
    if (dataSources) {
      const sources = document.createElement('span');
      sources.className = 'dict-attribution-sources';
      sources.textContent = `数据来源：${dataSources}`;
      sources.title = dataSources;
      footer.append(sources);
    }
    footer.setAttribute('data-attribution', 'manifest');
  }

  renderError(word, err) {
    this.el.word.textContent = truncateForDisplay(word);
    this.el.phonetic.hidden = true;
    this.el.translation.hidden = true;
    this.el.definition.hidden = true;
    this.el.meta.hidden = true;
    // 查询失败/未收录：没有归因信息，页脚降级为静态文案。
    this.renderAttribution(null);
    if (err?.status === 404) {
      this.setStatus(`词典未收录「${truncateForDisplay(word)}」`);
    } else if (err?.status === 503) {
      this.setStatus('离线词典数据未准备：请先按 README「词典数据准备」下载 ECDICT 数据并运行构建命令，然后重启服务。');
    } else {
      this.setStatus(`查询失败：${err?.message ?? '未知错误'}`);
    }
  }
}

/** 超长选文在卡片里只显示前 40 字符（完整内容仍在服务端按未收录处理）。 */
function truncateForDisplay(word) {
  const text = String(word ?? '');
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}
