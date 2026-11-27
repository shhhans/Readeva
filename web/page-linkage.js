import { RENDER_EVENT } from './pdf-viewer.js';
import { BLOCKS_CHANGED_EVENT } from './parse-panel.js';

const TOAST_AUTO_HIDE_MS = 3000;

const CSS_ESCAPE_SUPPORTED = typeof CSS !== 'undefined' && typeof CSS.escape === 'function';

function escapeSelector(value) {
  return CSS_ESCAPE_SUPPORTED ? CSS.escape(value) : (value ?? '').replace(/"/g, '\\"');
}

/** 校验 bbox 数值有效性：四个坐标必须为有限数字。 */
function validBboxNumbers(bbox) {
  return (
    bbox &&
    [bbox.l, bbox.t, bbox.r, bbox.b].every((v) => typeof v === 'number' && Number.isFinite(v))
  );
}

/**
 * 原页与内容块双向联动（Issue #4）。
 *
 * - 原页覆盖层：按内容块 bbox（PDF 坐标）在 canvas 上叠加定位框，
 *   随 pdf-rendered 事件（翻页/缩放）按当前渲染缩放重算位置；
 * - 双向悬浮高亮：悬浮右侧内容块 ↔ 悬浮原页覆盖框互相高亮；
 * - 主动定位：点击右侧内容块 → 原页滚动定位到对应区域；
 *   点击覆盖框 → 右侧滚动定位到对应内容块；
 * - 位置不可用：内容照常展示；悬浮静默（无框可高亮即无操作）；
 *   主动定位失败给 toast 提示，不打断阅读。
 *
 * 数据来源全部为 DOM（data-bbox / data-block-id）与渲染事件，组件间零耦合；
 * 对应文档侧约定见 docs/architecture.md「双向联动」。
 */
export class PageLinkage {
  constructor({ viewer, canvas, overlay, panel, content, toast }) {
    this.viewer = viewer;
    this.canvas = canvas;
    this.overlay = overlay;
    this.panel = panel;
    this.content = content;
    this.toast = toast;

    // 最近一次渲染几何：{ page, zoom, pointWidth, pointHeight }（PDF 点尺寸）。
    this.geometry = null;
    this.activeId = null; // 主动选中的内容块
    this.hoverId = null; // 当前悬浮双向高亮的内容块
    this.toastTimer = 0;

    this.onPdfRendered = (event) => {
      this.geometry = { ...event.detail };
      // 缩放/翻页重绘只重算位置，保留已选中的块（若其位置仍可用）。
      this.rebuildOverlay({ keepActive: true });
    };

    this.onBlocksChanged = () => {
      // 内容列表变化（清空或新结果）：选中态与提示随内容一起失效。
      this.activeId = null;
      this.hoverId = null;
      this.hideToast();
      this.rebuildOverlay({ keepActive: false });
    };

    this.onContentOver = (event) => {
      const block = event.target?.closest?.('.parse-block');
      this.setHover(block?.dataset.blockId ?? null);
    };
    this.onContentLeave = () => this.setHover(null);

    this.onOverlayOver = (event) => {
      const box = event.target?.closest?.('.page-block-box');
      this.setHover(box?.dataset.blockId ?? null);
    };
    this.onOverlayLeave = () => this.setHover(null);

    this.onContentClick = (event) => {
      const block = event.target?.closest?.('.parse-block');
      if (block) this.locateOnPage(block);
    };
    this.onOverlayClick = (event) => {
      const box = event.target?.closest?.('.page-block-box');
      if (box) this.locateOnPanel(box);
    };
  }

  /** 绑定事件（阅读视图元素常驻 DOM，构造后绑定一次即可）。 */
  attach() {
    this.viewer.addEventListener(RENDER_EVENT, this.onPdfRendered);
    this.panel.addEventListener(BLOCKS_CHANGED_EVENT, this.onBlocksChanged);
    this.content.addEventListener('mouseover', this.onContentOver);
    this.content.addEventListener('mouseleave', this.onContentLeave);
    this.content.addEventListener('click', this.onContentClick);
    this.overlay.addEventListener('mouseover', this.onOverlayOver);
    this.overlay.addEventListener('mouseleave', this.onOverlayLeave);
    this.overlay.addEventListener('click', this.onOverlayClick);
  }

  /* ---------------- 覆盖层 ---------------- */

  /** 内容块列表中所有带 bbox 的块（用于覆盖层重建）。 */
  positionedBlocks() {
    return [...this.content.querySelectorAll('.parse-block[data-bbox]')];
  }

  /**
   * bbox（PDF 坐标）→ canvas 渲染坐标（CSS 像素）。
   * 以 canvas 实际显示尺寸 / 页面点尺寸为换算系数，天然跟随缩放与取整；
   * 无效（坐标非法、零尺寸、完全出页）返回 null。
   */
  bboxToRect(bbox, cssWidth, cssHeight) {
    if (!validBboxNumbers(bbox)) return null;
    const { pointWidth, pointHeight } = this.geometry ?? {};
    if (!(pointWidth > 0 && pointHeight > 0)) return null;
    if (!(cssWidth > 0 && cssHeight > 0)) return null;
    const fx = cssWidth / pointWidth;
    const fy = cssHeight / pointHeight;

    let left = bbox.l * fx;
    let top;
    let height;
    if (bbox.coordOrigin === 'BOTTOMLEFT') {
      // 底部原点：t 为上边缘（y 自下向上），换算为顶部原点。
      top = (pointHeight - bbox.t) * fy;
      height = (bbox.t - bbox.b) * fy;
    } else {
      // TOPLEFT（Docling 默认）与未声明坐标系同样按顶部原点处理。
      top = bbox.t * fy;
      height = (bbox.b - bbox.t) * fy;
    }
    const width = (bbox.r - bbox.l) * fx;
    if (!(width > 0 && height > 0)) return null;
    // 完全出页的框无定位意义；轻微越界的框保留，由覆盖层裁剪。
    if (left >= cssWidth || top >= cssHeight || left + width <= 0 || top + height <= 0) {
      return null;
    }
    return { left, top, width, height };
  }

  rebuildOverlay({ keepActive = false } = {}) {
    this.overlay.replaceChildren();
    if (!this.geometry) return;
    const cssWidth = this.canvas.clientWidth;
    const cssHeight = this.canvas.clientHeight;
    for (const block of this.positionedBlocks()) {
      let bbox;
      try {
        bbox = JSON.parse(block.dataset.bbox);
      } catch {
        continue; // 位置数据损坏按无位置处理（静默）
      }
      const rect = this.bboxToRect(bbox, cssWidth, cssHeight);
      if (!rect) continue;
      const box = document.createElement('div');
      box.className = 'page-block-box';
      box.dataset.blockId = block.dataset.blockId ?? '';
      box.style.left = `${rect.left}px`;
      box.style.top = `${rect.top}px`;
      box.style.width = `${rect.width}px`;
      box.style.height = `${rect.height}px`;
      this.overlay.append(box);
    }
    if (keepActive && this.activeId) {
      this.applyActiveClass(this.activeId);
    }
  }

  /* ---------------- 高亮 ---------------- */

  queryBlock(id) {
    return this.content.querySelector(`.parse-block[data-block-id="${escapeSelector(id)}"]`);
  }

  queryBox(id) {
    return this.overlay.querySelector(`.page-block-box[data-block-id="${escapeSelector(id)}"]`);
  }

  setHot(id, on) {
    const box = this.queryBox(id);
    if (!box) return; // 无覆盖框（无可用位置）：悬浮静默，两侧都不高亮
    box.classList.toggle('hot', on);
    this.queryBlock(id)?.classList.toggle('hot', on);
  }

  /** 悬浮高亮（双向）：无对应位置时静默，不做任何事。 */
  setHover(id) {
    if (this.hoverId === id) return;
    if (this.hoverId) this.setHot(this.hoverId, false);
    this.hoverId = id;
    if (id) this.setHot(id, true);
  }

  applyActiveClass(id) {
    if (!id) return;
    this.queryBlock(id)?.classList.add('active');
    this.queryBox(id)?.classList.add('active');
  }

  setActive(id) {
    if (this.activeId) {
      this.queryBlock(this.activeId)?.classList.remove('active');
      this.queryBox(this.activeId)?.classList.remove('active');
    }
    this.activeId = id;
    this.applyActiveClass(id);
  }

  /* ---------------- 主动定位 ---------------- */

  /**
   * 把元素居中滚动到指定滚动容器内（直接设 scrollTop/scrollLeft）。
   * 不用 scrollIntoView：它可能连带滚动外层文档；且配合
   * #viewer 的 flex-start + margin auto 布局，左侧区域始终可达。
   */
  scrollToCenter(container, el) {
    const elRect = el.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const targetTop =
      container.scrollTop + elRect.top - containerRect.top - (containerRect.height - elRect.height) / 2;
    const targetLeft =
      container.scrollLeft + elRect.left - containerRect.left - (containerRect.width - elRect.width) / 2;
    container.scrollTop = Math.max(0, targetTop);
    container.scrollLeft = Math.max(0, targetLeft);
  }

  /** 点击右侧内容块：定位原页对应区域；无可用位置时提示（不打断阅读）。 */
  locateOnPage(block) {
    const id = block.dataset.blockId;
    const box = this.queryBox(id);
    if (!box) {
      this.showToast('该内容块没有可用位置，无法在原页上定位。');
      return;
    }
    this.setActive(id);
    this.scrollToCenter(this.viewer, box);
  }

  /** 点击原页覆盖框：定位右侧对应内容块。 */
  locateOnPanel(box) {
    const id = box.dataset.blockId;
    const block = this.queryBlock(id);
    if (!block) return; // 内容尚未就绪：静默
    this.setActive(id);
    this.scrollToCenter(this.content, block);
  }

  /* ---------------- 提示 ---------------- */

  showToast(text) {
    if (!this.toast) return;
    this.toast.textContent = text;
    this.toast.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.hideToast(), TOAST_AUTO_HIDE_MS);
  }

  hideToast() {
    clearTimeout(this.toastTimer);
    this.toastTimer = 0;
    if (this.toast) this.toast.hidden = true;
  }
}
