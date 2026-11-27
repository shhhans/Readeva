import { getServiceBase, pdfjsAssetUrl } from './api.js';

let pdfjsPromise = null;

/** 动态加载 PDF.js（legacy 构建），worker 与字体资源随服务地址解析。 */
export function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const lib = await import(`${getServiceBase()}/vendor/pdfjs/build/pdf.mjs`);
      lib.GlobalWorkerOptions.workerSrc = `${getServiceBase()}/vendor/pdfjs/build/pdf.worker.mjs`;
      return lib;
    })();
  }
  return pdfjsPromise;
}

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 5;

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

/**
 * 原页渲染器：按 PDF 原始排版把当前页绘制到 canvas，
 * 保留文字、表格与图片的原有布局。
 */
export class PdfViewer {
  constructor({ canvas, container }) {
    this.canvas = canvas;
    this.container = container;
    this.pdf = null;
    this.loadingTask = null;
    this.page = 1;
    this.pageCount = 0;
    this.zoom = 1;
    this.renderToken = 0;
    this.renderTask = null;
  }

  async open(url, { page, zoom }) {
    this.destroy();
    const pdfjsLib = await loadPdfjs();
    this.loadingTask = pdfjsLib.getDocument({
      url,
      cMapUrl: pdfjsAssetUrl('cmaps/'),
      cMapPacked: true,
      standardFontDataUrl: pdfjsAssetUrl('standard_fonts/'),
    });
    this.pdf = await this.loadingTask.promise;
    this.pageCount = this.pdf.numPages;
    return this.goTo(page, zoom);
  }

  /** 跳转到指定页并按缩放渲染；返回最终生效的 {page, zoom}。 */
  async goTo(page, zoom) {
    if (!this.pdf) return { page: this.page, zoom: this.zoom };
    this.page = clamp(Math.floor(Number(page) || 1), 1, this.pageCount);
    this.zoom = Math.round(clamp(Number(zoom) || 1, MIN_ZOOM, MAX_ZOOM) * 1000) / 1000;
    await this.render();
    return { page: this.page, zoom: this.zoom };
  }

  nextPage() {
    return this.goTo(this.page + 1, this.zoom);
  }

  prevPage() {
    return this.goTo(this.page - 1, this.zoom);
  }

  zoomIn() {
    return this.goTo(this.page, this.zoom * 1.2);
  }

  zoomOut() {
    return this.goTo(this.page, this.zoom / 1.2);
  }

  async fitWidth() {
    if (!this.pdf) return { page: this.page, zoom: this.zoom };
    const page = await this.pdf.getPage(this.page);
    const base = page.getViewport({ scale: 1 });
    const available = Math.max(this.container.clientWidth - 40, 200);
    return this.goTo(this.page, available / base.width);
  }

  async render() {
    const token = ++this.renderToken;

    // 同一 canvas 不能并发 render；cancel() 是异步的，必须等被取消任务
    // 的 promise 落定后才能开始新渲染。
    const previous = this.renderTask;
    if (previous) {
      try {
        previous.cancel();
      } catch {
        /* 已完成的任务忽略取消错误 */
      }
      try {
        await previous.promise;
      } catch {
        /* 取消或失败即视为让出 canvas */
      }
    }
    if (token !== this.renderToken) return;

    const page = await this.pdf.getPage(this.page);
    if (token !== this.renderToken) return;

    const viewport = page.getViewport({ scale: this.zoom });
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const ctx = this.canvas.getContext('2d');
    this.canvas.width = Math.floor(viewport.width * dpr);
    this.canvas.height = Math.floor(viewport.height * dpr);
    this.canvas.style.width = `${Math.floor(viewport.width)}px`;
    this.canvas.style.height = `${Math.floor(viewport.height)}px`;

    // 紧贴 render 调用前再检查一次：等待期间可能有更新请求接管渲染。
    if (token !== this.renderToken) return;

    const task = page.render({
      canvasContext: ctx,
      viewport,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
    });
    this.renderTask = task;
    try {
      await task.promise;
    } catch (err) {
      if (err?.name === 'RenderingCancelledException') return;
      throw err;
    }
    if (token === this.renderToken) {
      // 渲染完成标记，供界面与测试确认当前页/缩放已生效。
      this.container.dataset.page = String(this.page);
      this.container.dataset.zoom = String(this.zoom);
    }
  }

  destroy() {
    this.renderTask?.cancel();
    this.renderTask = null;
    if (this.loadingTask) {
      this.loadingTask.destroy().catch(() => {});
      this.loadingTask = null;
    }
    this.pdf = null;
  }
}
