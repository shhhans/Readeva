import { fetchPageTranslations, requestTranslation } from './api.js';
import { BLOCKS_CHANGED_EVENT } from './parse-panel.js';

/** 默认目标语言（父规格：翻译默认中文；与服务端默认一致）。 */
const DEFAULT_TARGET_LANGUAGE = 'zh';
/** 目标语言代码 → 展示名（未列举的代码原样展示）。 */
const LANGUAGE_LABELS = { zh: '中文', en: 'English' };

/**
 * 归一化选文文本（与服务端 normalizeSelectionText 一致：NFC + 空白折叠 + 去首尾），
 * 保证客户端推导的复用身份与服务端 sourceKey 命中同一键。
 */
function normalizeSelectionText(text) {
  return String(text ?? '')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim();
}

/** sha256 hex（secure context 下 crypto.subtle；不可用时退化为 FNV-1a 本地占位）。 */
async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  if (window.crypto?.subtle) {
    try {
      const digest = await window.crypto.subtle.digest('SHA-256', bytes);
      return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    } catch {
      /* 退化为 FNV */
    }
  }
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv-${hash.toString(16).padStart(8, '0')}`;
}

/** 属性选择器值转义（译文 id 含 | 与 :，不含引号）。 */
function cssAttr(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * 选文与内容块翻译（Issue #8）：右侧主动翻译，译文显示在对应内容旁。
 *
 * 交互流程：
 * - 内容块：每个可翻译块（标题/段落/列表/表格）右上角有「翻译」按钮，点击翻译
 *   整块；在途请求去重（重复点击不重复翻译）；已有译文时点击直接展开复用；
 * - 选文：右侧内容选中文本 → 工具条「翻译」按钮 → 翻译选中文字（默认中文）；
 * - 译文渲染在来源内容旁（块：紧跟该块；选文：包含选文的块后，找不到时列表末尾），
 *   头部标注来源（内容块/选文）、目标语言、复用状态（已有译文）与引擎模型，
 *   可折叠；
 * - 请求中（loading）与失败状态可见；失败不产生已保存译文（服务端事务式保证），
 *   错误可就地重试；
 * - 打开/翻页/重开后经 GET 取回当前页解析绑定的译文并就地恢复（复用已保存译文）。
 *
 * 组件零耦合：仅监听 ParsePanel 的 BLOCKS_CHANGED_EVENT（detail 携带
 * docId/page/parseId）与 #parse-blocks 的点击，不改解析面板内部逻辑。
 */
export class Translator {
  constructor({ panel, content, blocks, toolbar, translateButton }) {
    this.panel = panel;
    this.content = content;
    this.blocksEl = blocks;
    this.toolbar = toolbar;
    this.translateButton = translateButton;
    this.docId = null;
    this.page = null;
    this.parseId = null;
    /** 页面/文档切换代数：翻页后旧请求的响应作废。 */
    this.generation = 0;
    /** 已保存译文取回的版本号：仅采纳最后一次取回的响应。 */
    this.fetchToken = 0;
    /** 在途翻译请求（按译文 id 去重）。 */
    this.pending = new Set();
    this.onBlocksChanged = this.onBlocksChanged.bind(this);
    this.onBlocksClick = this.onBlocksClick.bind(this);
    this.onTranslateButtonClick = this.onTranslateButtonClick.bind(this);
  }

  attach() {
    this.blocksEl.addEventListener('click', this.onBlocksClick);
    this.translateButton.addEventListener('click', this.onTranslateButtonClick);
    this.panel.addEventListener(BLOCKS_CHANGED_EVENT, this.onBlocksChanged);
  }

  reset() {
    this.generation += 1;
    this.fetchToken += 1;
    this.pending.clear();
    this.docId = null;
    this.page = null;
    this.parseId = null;
    this.toolbar.hidden = true;
  }

  /* ---------------- 事件 ---------------- */

  onTranslateButtonClick() {
    this.translateSelection().catch(() => {});
  }

  onBlocksClick(event) {
    const button = event.target?.closest?.('.block-translate-button');
    if (!button) return;
    // 翻译按钮点击不触发联动定位（page-linkage 在 #parse-content 上监听 click）。
    event.stopPropagation();
    event.preventDefault();
    const block = button.closest('.parse-block');
    if (!block?.dataset.blockId) return;
    this.translateBlock(block.dataset.blockId).catch(() => {});
  }

  onBlocksChanged(event) {
    const detail = event?.detail ?? {};
    const docId = typeof detail.docId === 'string' ? detail.docId : null;
    const page = Number.isInteger(detail.page) ? detail.page : null;
    if (docId !== this.docId || page !== this.page) {
      // 翻页/切换文档：作废在途请求的渲染，重新取回新页译文。
      this.generation += 1;
      this.fetchToken += 1;
      this.pending.clear();
      this.docId = docId;
      this.page = page;
      this.parseId = null;
    }
    if (!detail.parseId) {
      // 内容清空（未解析/加载中）：等待下一次渲染事件。
      this.parseId = null;
      return;
    }
    this.parseId = detail.parseId;
    this.syncSavedTranslations();
  }

  /* ---------------- 已保存译文取回与恢复 ---------------- */

  async syncSavedTranslations() {
    const generation = this.generation;
    const token = ++this.fetchToken;
    const { docId, page } = this;
    let payload;
    try {
      payload = await fetchPageTranslations(docId, page);
    } catch {
      return; // 服务不可达/重启中：等待下一次事件。
    }
    // 过期响应丢弃：页面已切换（代数变化）或同页重新解析（parseId 变化）或已有更新的取回。
    if (generation !== this.generation || token !== this.fetchToken) return;
    if (!payload?.parseId || payload.parseId !== this.parseId) return;
    this.renderTranslations(payload.translations ?? []);
  }

  renderTranslations(translationList) {
    for (const translation of translationList) {
      if (!translation?.id || this.pending.has(translation.id)) continue;
      const existing = this.getTranslationEl(translation.id);
      if (existing?.dataset.translationState === 'done') continue;
      // 取回即复用：已保存译文标注来源（「已有译文」）。
      this.renderTranslation(translation, { reused: true });
    }
  }

  /* ---------------- 翻译动作 ---------------- */

  /** 翻译整个内容块（块 id 来源服务端解析结果；目标语言默认中文）。 */
  async translateBlock(blockId) {
    if (!this.docId || this.page == null || !this.parseId) return;
    const generation = this.generation;
    const id = `block:${blockId}|${DEFAULT_TARGET_LANGUAGE}`;
    if (this.pending.has(id)) return;
    if (this.isDone(id)) {
      // 已有对应译文：直接复用（展开可见），不重复请求。
      const el = this.getTranslationEl(id);
      if (el) {
        el.classList.remove('is-collapsed');
        el.hidden = false;
      }
      return;
    }
    const anchor = this.getBlockEl(blockId);
    const pendingEl = this.createTranslationEl({
      id,
      sourceKind: 'block',
      blockId,
      targetLanguage: DEFAULT_TARGET_LANGUAGE,
      state: 'loading',
    });
    // 重试：同 id 的旧元素（如失败态）替换为新的请求中元素，避免重复。
    const existing = this.getTranslationEl(id);
    if (existing) existing.replaceWith(pendingEl);
    else this.placePending(pendingEl, anchor);
    this.pending.add(id);
    try {
      const { reused, translation } = await requestTranslation(this.docId, this.page, {
        parseId: this.parseId,
        source: { kind: 'block', blockId },
      });
      if (generation !== this.generation) return;
      this.renderTranslation(translation, { reused });
    } catch (err) {
      if (generation !== this.generation) return;
      this.renderTranslationError(pendingEl, err);
    } finally {
      if (generation === this.generation) this.pending.delete(id);
    }
  }

  /** 翻译选中文本（默认中文）；消费选区并隐藏工具条。 */
  async translateSelection() {
    const selection = window.getSelection();
    const raw = selection ? selection.toString() : '';
    // 消费选区（与查词一致：不清除会让工具条重新浮现）。
    selection?.removeAllRanges?.();
    this.toolbar.hidden = true;
    const normalized = normalizeSelectionText(raw);
    if (!normalized) return;
    if (!this.docId || this.page == null || !this.parseId) return;
    const generation = this.generation;
    const hex = await sha256Hex(normalized);
    if (generation !== this.generation) return;
    const id = `selection:${hex}|${DEFAULT_TARGET_LANGUAGE}`;
    if (this.pending.has(id)) return;
    if (this.isDone(id)) {
      const el = this.getTranslationEl(id);
      if (el) {
        el.classList.remove('is-collapsed');
        el.hidden = false;
      }
      return;
    }
    const pendingEl = this.createTranslationEl({
      id,
      sourceKind: 'selection',
      targetLanguage: DEFAULT_TARGET_LANGUAGE,
      state: 'loading',
    });
    // 重试：同 id 的旧元素（如失败态）替换为新的请求中元素，避免重复。
    const existing = this.getTranslationEl(id);
    if (existing) existing.replaceWith(pendingEl);
    else this.placePending(pendingEl, this.findBlockContaining(normalized));
    this.pending.add(id);
    try {
      const { reused, translation } = await requestTranslation(this.docId, this.page, {
        parseId: this.parseId,
        source: { kind: 'selection', text: normalized },
      });
      if (generation !== this.generation) return;
      this.renderTranslation(translation, { reused, pendingEl });
    } catch (err) {
      if (generation !== this.generation) return;
      this.renderTranslationError(pendingEl, err);
    } finally {
      if (generation === this.generation) this.pending.delete(id);
    }
  }

  /* ---------------- 渲染 ---------------- */

  getBlockEl(blockId) {
    if (!/^[A-Za-z0-9_-]+$/.test(String(blockId))) return null;
    return this.blocksEl.querySelector(`.parse-block[data-block-id="${blockId}"]`);
  }

  getTranslationEl(id) {
    return this.blocksEl.querySelector(`.block-translation[data-translation-id="${cssAttr(id)}"]`);
  }

  isDone(id) {
    return this.getTranslationEl(id)?.dataset.translationState === 'done';
  }

  /** 找到包含选文文本的内容块（归一化包含匹配；找不到返回 null）。 */
  findBlockContaining(text) {
    const needle = normalizeSelectionText(text);
    if (!needle) return null;
    for (const block of this.blocksEl.querySelectorAll('.parse-block')) {
      if (normalizeSelectionText(block.textContent).includes(needle)) return block;
    }
    return null;
  }

  /** 在内容块后插入译文元素；已有相邻译文时排在其后（同块多条译文顺序稳定）。 */
  insertAfterBlock(anchor, el) {
    let target = anchor;
    let sibling = anchor.nextElementSibling;
    while (sibling?.classList.contains('block-translation')) {
      target = sibling;
      sibling = sibling.nextElementSibling;
    }
    target.after(el);
  }

  /** 待渲染译文的位置：块后 / 包含选文的块后 / 列表末尾（找不到对应内容时）。 */
  placePending(el, anchorBlock) {
    if (anchorBlock) this.insertAfterBlock(anchorBlock, el);
    else this.blocksEl.append(el);
  }

  placeTranslation(el, translation) {
    if (translation.sourceKind === 'block' && translation.blockId) {
      const anchor = this.getBlockEl(translation.blockId);
      if (anchor) {
        this.insertAfterBlock(anchor, el);
        return;
      }
    } else if (translation.sourceKind === 'selection') {
      const anchor = this.findBlockContaining(translation.sourceText);
      if (anchor) {
        this.insertAfterBlock(anchor, el);
        return;
      }
    }
    this.blocksEl.append(el);
  }

  renderTranslation(translation, { reused = false, pendingEl = null } = {}) {
    const el = this.createTranslationEl({
      id: translation.id,
      sourceKind: translation.sourceKind,
      blockId: translation.blockId ?? null,
      targetLanguage: translation.targetLanguage ?? DEFAULT_TARGET_LANGUAGE,
      state: 'done',
      text: translation.text ?? '',
      model: translation.model ?? '',
      reused,
    });
    const existing = this.getTranslationEl(translation.id);
    if (existing) existing.replaceWith(el);
    else if (pendingEl?.isConnected) pendingEl.replaceWith(el);
    else this.placeTranslation(el, translation);
  }

  renderTranslationError(pendingEl, err) {
    if (!pendingEl?.isConnected) return;
    pendingEl.dataset.translationState = 'error';
    pendingEl.classList.add('is-error');
    pendingEl.querySelector('.translation-loading')?.remove();
    // 请求中元素没有错误节点：就地创建（失败状态可见，可重试）。
    let errorEl = pendingEl.querySelector('.translation-error');
    if (!errorEl) {
      errorEl = document.createElement('p');
      errorEl.className = 'translation-error';
      pendingEl.querySelector('.translation-body')?.append(errorEl);
    }
    errorEl.textContent = this.errorText(err);
    errorEl.hidden = false;
  }

  errorText(err) {
    if (err?.status === 503) {
      return '翻译服务未配置：请在服务端设置 MINIMAX_API_KEY 后重启服务。';
    }
    if (err?.status === 409) {
      return `解析已更新，本次译文未保存（请刷新内容后重试）：${err?.message ?? ''}`.trim();
    }
    return `翻译失败：${err?.message ?? '未知错误'}`;
  }

  createTranslationEl({ id, sourceKind, blockId = null, targetLanguage, state, text = '', model = '', reused = false }) {
    const el = document.createElement('div');
    el.className = `block-translation is-${state}`;
    el.dataset.translationId = id;
    el.dataset.translationState = state;
    el.dataset.sourceKind = sourceKind;
    el.dataset.targetLanguage = targetLanguage;
    el.dataset.reused = reused ? 'true' : 'false';
    if (blockId) el.dataset.blockId = blockId;

    const header = document.createElement('div');
    header.className = 'translation-header';
    const label = document.createElement('span');
    label.className = 'translation-label';
    label.textContent = '译文';
    const sourceTag = document.createElement('span');
    sourceTag.className = 'translation-source-tag';
    sourceTag.textContent = sourceKind === 'block' ? '内容块' : '选文';
    const targetTag = document.createElement('span');
    targetTag.className = 'translation-target';
    targetTag.textContent = `→ ${LANGUAGE_LABELS[targetLanguage] ?? targetLanguage}`;
    header.append(label, sourceTag, targetTag);
    if (reused) {
      // 复用标注（来源：服务端已保存的译文，本次未重新翻译）。
      const chip = document.createElement('span');
      chip.className = 'translation-reused';
      chip.textContent = '已有译文';
      header.append(chip);
    }
    if (model) {
      const engine = document.createElement('span');
      engine.className = 'translation-engine mono';
      engine.textContent = model;
      header.append(engine);
    }
    const spacer = document.createElement('span');
    spacer.className = 'spacer';
    header.append(spacer);
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'translation-toggle';
    toggle.textContent = '收起';
    toggle.addEventListener('click', (event) => {
      event.stopPropagation();
      const collapsed = el.classList.toggle('is-collapsed');
      toggle.textContent = collapsed ? '展开' : '收起';
    });
    header.append(toggle);
    el.append(header);

    const body = document.createElement('div');
    body.className = 'translation-body';
    if (state === 'done') {
      const textEl = document.createElement('p');
      textEl.className = 'translation-text';
      textEl.textContent = text;
      body.append(textEl);
    } else if (state === 'loading') {
      const loadingEl = document.createElement('p');
      loadingEl.className = 'translation-loading';
      loadingEl.textContent = '翻译中…';
      body.append(loadingEl);
    } else {
      const errorEl = document.createElement('p');
      errorEl.className = 'translation-error';
      errorEl.hidden = true;
      body.append(errorEl);
    }
    el.append(body);
    return el;
  }
}
