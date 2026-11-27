import crypto from 'node:crypto';
import { PDFDocument } from 'pdf-lib';

/**
 * Docling 服务适配层。
 *
 * 通过可配置的 HTTP 地址访问独立 Docling 服务（docling-serve 兼容接口）：
 *   1. POST /v1/convert/file/async   —— 提交页解析请求（multipart 字节流）
 *   2. GET  /v1/status/poll/{task}   —— 任务状态（pending|started|success|failure）
 *   3. GET  /v1/result/{task}        —— 结果获取（DoclingDocument JSON）
 *
 * 契约不依赖客户端与服务共享文件路径：本项目把单页 PDF 的**字节流**发给
 * 解析服务，并消费其返回的结构化内容（DoclingDocument JSON）。
 */

const CONVERT_OPTIONS = {
  // 仅需要结构化 JSON；图片以内嵌 data URI 随结果返回。
  to_formats: ['json'],
  image_export_mode: 'embedded',
};

export class DoclingServiceError extends Error {
  constructor(message, { status } = {}) {
    super(message);
    this.name = 'DoclingServiceError';
    this.status = status;
  }
}

/** 解析结果统一身份：对内容块做内容摘要，同一结果重复解析身份不变。 */
export function computeParseId(blocks) {
  return crypto.createHash('sha256').update(JSON.stringify(blocks)).digest('hex');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function compactErrors(errors) {
  if (!Array.isArray(errors) || errors.length === 0) return [];
  return errors
    .map((e) => {
      if (typeof e === 'string') return e;
      const kind = e?.kind ? `${e.kind}: ` : '';
      return `${kind}${e?.message ?? e?.error ?? JSON.stringify(e)}`;
    })
    .filter(Boolean)
    .slice(0, 5);
}

/* ---------------- DoclingDocument → 内容块 ---------------- */

const PARAGRAPH_LABELS = new Set([
  'paragraph',
  'text',
  'caption',
  'footnote',
  'code',
  'formula',
  'key_value_item',
  'form_item',
  'checkbox_selected',
  'checkbox_unselected',
  'section_header_content',
]);

// 页眉页脚是版面装饰，不属于阅读顺序中的正文内容。
const SKIP_LABELS = new Set(['page_header', 'page_footer', 'page_number']);

function normalizeBbox(prov, fallbackPageNo) {
  const first = Array.isArray(prov) ? prov[0] : undefined;
  const bbox = first?.bbox;
  if (!bbox) return null;
  return {
    l: bbox.l,
    t: bbox.t,
    r: bbox.r,
    b: bbox.b,
    coordOrigin: bbox.coord_origin ?? null,
    // 解析按单页进行，结果统一按用户阅读页归档，页码以请求页为准。
    pageNo: fallbackPageNo,
  };
}

function cellText(cell, tableCells) {
  if (!cell) return '';
  if (cell.$ref) {
    // grid 里可能是引用（#/tables/N/data/table_cells/M）。
    const match = /table_cells\/(\d+)$/.exec(cell.$ref);
    if (match) cell = tableCells?.[Number(match[1])];
    else return '';
  }
  return typeof cell?.text === 'string' ? cell.text : '';
}

function normalizeTable(tableItem, pageNo) {
  const data = tableItem.data ?? {};
  const tableCells = data.table_cells ?? [];
  const grid = Array.isArray(data.grid) ? data.grid : [];
  const rows = grid.map((row) =>
    (Array.isArray(row) ? row : []).map((cell) => cellText(cell, tableCells)),
  );
  // grid 缺失时退化用 table_cells 的行列偏移拼装，保证内容仍可展示。
  if (rows.length === 0 && tableCells.length > 0) {
    for (const cell of tableCells) {
      const r = cell.start_row_offset_idx ?? 0;
      rows[r] ??= [];
      rows[r][cell.start_col_offset_idx ?? 0] = cellText(cell, tableCells);
    }
    for (let i = 0; i < rows.length; i += 1) {
      rows[i] ??= [];
    }
  }
  const firstRowCells = grid[0] ?? [];
  const columnHeader =
    firstRowCells.length > 0 &&
    firstRowCells.every((c) => !c.$ref && c?.column_header === true);
  return {
    kind: 'table',
    rows,
    columnHeader,
    bbox: normalizeBbox(tableItem.prov, pageNo),
  };
}

function normalizeImage(pictureItem, pageNo) {
  const image = pictureItem.image ?? {};
  let uri = typeof image.uri === 'string' ? image.uri : '';
  // 仅内嵌 data URI 或绝对 http(s) 资源能直接在浏览器展示；
  // 其余（如服务端本地路径）视为资源不可用，内容块仍然展示。
  if (!(uri.startsWith('data:') || /^https?:\/\//i.test(uri))) uri = undefined;
  const block = {
    kind: 'image',
    bbox: normalizeBbox(pictureItem.prov, pageNo),
  };
  if (uri) block.image = { uri, mimeType: image.mimetype ?? null };
  return block;
}

function makeBlock(index, block) {
  return { id: `b${index}`, order: index, ...block, bbox: block.bbox ?? null };
}

/**
 * 把 DoclingDocument JSON 规范化为按阅读顺序排列的内容块列表。
 * 每块保留解析提供的结构、文字、资源及可用位置；缺少位置不阻止展示。
 */
export function normalizeDoclingDocument(doc, { pageNo }) {
  if (!doc || typeof doc !== 'object') {
    throw new DoclingServiceError('docling result has no document body');
  }
  const texts = Array.isArray(doc.texts) ? doc.texts : [];
  const tables = Array.isArray(doc.tables) ? doc.tables : [];
  const pictures = Array.isArray(doc.pictures) ? doc.pictures : [];
  const groups = Array.isArray(doc.groups) ? doc.groups : [];

  const byRef = (ref) => {
    if (typeof ref !== 'string' || !ref.startsWith('#/')) return undefined;
    const path = ref.slice(2).split('/');
    const kind = path[0];
    const index = Number(path[1]);
    if (!Number.isInteger(index)) return undefined;
    if (kind === 'texts') return texts[index];
    if (kind === 'tables') return tables[index];
    if (kind === 'pictures') return pictures[index];
    if (kind === 'groups') return groups[index];
    return undefined;
  };

  const toTextBlock = (item, pageNo_) => {
    const text = typeof item.text === 'string' ? item.text : '';
    const label = item.label;
    const bbox = normalizeBbox(item.prov, pageNo_);
    if (label === 'title') return { kind: 'heading', level: 1, text, bbox };
    if (label === 'section_header') return { kind: 'heading', level: 2, text, bbox };
    return { kind: 'paragraph', text, bbox };
  };

  const blocks = [];
  // 相邻 list_item 合并为一个列表块（Docling 列表有时通过 list 组、有时平铺）。
  let pendingList = null;
  const flushList = () => {
    if (pendingList) {
      blocks.push(pendingList);
      pendingList = null;
    }
  };
  const pushListItem = (item) => {
    const ordered = item.enumerated === true;
    if (!pendingList || pendingList.ordered !== ordered) {
      flushList();
      pendingList = { kind: 'list', ordered, items: [], bbox: null };
    }
    // 列表块的位置取首个有位置信息的列表项。
    if (!pendingList.bbox) pendingList.bbox = normalizeBbox(item.prov, pageNo);
    pendingList.items.push(typeof item.text === 'string' ? item.text : '');
  };

  const walkChildren = (children, pageNo_) => {
    for (const child of children ?? []) {
      const item = byRef(child?.$ref) ?? child;
      if (!item || typeof item !== 'object') continue;
      if (item.content_layer === 'furniture') continue;
      const label = item.label;
      if (SKIP_LABELS.has(label)) continue;
      if (label === 'list_item') {
        pushListItem(item);
        continue;
      }
      if (label === 'list' || label === 'section' || label === 'group') {
        // list 组：其子项为 list_item 文本。
        walkChildren(item.children, pageNo_);
        continue;
      }
      flushList();
      let block;
      if (label === 'table') block = normalizeTable(item, pageNo_);
      else if (label === 'picture') block = normalizeImage(item, pageNo_);
      else if (PARAGRAPH_LABELS.has(label) || typeof item.text === 'string') {
        block = toTextBlock(item, pageNo_);
      } else continue;
      blocks.push(block);
    }
  };

  const bodyChildren = doc.body?.children;
  if (Array.isArray(bodyChildren) && bodyChildren.length > 0) {
    walkChildren(bodyChildren, pageNo);
  } else {
    // 退化：body 缺失时按容器数组顺序拼接，保证内容仍可展示。
    for (const item of [...texts, ...tables, ...pictures]) {
      if (item?.content_layer === 'furniture' || SKIP_LABELS.has(item?.label)) continue;
      if (item.label === 'list_item') pushListItem(item);
      else if (item.label === 'table') {
        flushList();
        blocks.push(normalizeTable(item, pageNo));
      } else if (item.label === 'picture') {
        flushList();
        blocks.push(normalizeImage(item, pageNo));
      } else {
        flushList();
        blocks.push(toTextBlock(item, pageNo));
      }
    }
  }
  flushList();

  const blocksWithIds = blocks.map((block, index) => makeBlock(index, block));
  return { blocks: blocksWithIds, parseId: computeParseId(blocksWithIds) };
}

/* ---------------- 服务适配客户端 ---------------- */

/**
 * Docling 服务客户端：提交单页字节流、轮询任务状态、获取并规范化结果。
 */
export class DoclingAdapter {
  constructor({ baseUrl, pollIntervalMs = 500, timeoutMs = 300_000, fetchImpl = fetch } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.pollIntervalMs = pollIntervalMs;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  async requestJson(url, options = {}, context) {
    let response;
    try {
      response = await this.fetchImpl(url, options);
    } catch (err) {
      throw new DoclingServiceError(`docling service unreachable (${context}): ${err.message}`);
    }
    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      throw new DoclingServiceError(
        `docling service ${context} failed: HTTP ${response.status} ${bodyText.slice(0, 300)}`,
        { status: response.status },
      );
    }
    try {
      return await response.json();
    } catch (err) {
      throw new DoclingServiceError(`docling service ${context} returned invalid JSON: ${err.message}`);
    }
  }

  /** 提交单页 PDF 字节流，返回 { taskId }。 */
  async submitPage(pageBytes, { filename }) {
    const form = new FormData();
    form.append('files', new Blob([pageBytes], { type: 'application/pdf' }), filename);
    for (const [key, value] of Object.entries(CONVERT_OPTIONS)) {
      form.append(key, value);
    }
    const task = await this.requestJson(
      `${this.baseUrl}/v1/convert/file/async`,
      { method: 'POST', body: form },
      'submit',
    );
    if (!task?.task_id) {
      throw new DoclingServiceError('docling service submit response missing task_id');
    }
    return { taskId: task.task_id };
  }

  async pollTask(taskId) {
    const task = await this.requestJson(
      `${this.baseUrl}/v1/status/poll/${encodeURIComponent(taskId)}`,
      { method: 'GET' },
      'status poll',
    );
    return task?.task_status;
  }

  async fetchResult(taskId) {
    return this.requestJson(
      `${this.baseUrl}/v1/result/${encodeURIComponent(taskId)}`,
      { method: 'GET' },
      'result fetch',
    );
  }

  /**
   * 解析一页：提交 → 轮询 → 取结果 → 规范化。
   * 返回 { blocks, parseId, errors }；服务失败抛 DoclingServiceError。
   */
  async parsePage(pageBytes, { filename, pageNo }) {
    const { taskId } = await this.submitPage(pageBytes, { filename });
    const deadline = Date.now() + this.timeoutMs;
    let taskStatus = 'pending';
    while (taskStatus !== 'success' && taskStatus !== 'failure') {
      if (Date.now() > deadline) {
        throw new DoclingServiceError(`docling parse timed out after ${this.timeoutMs}ms`);
      }
      await delay(this.pollIntervalMs);
      taskStatus = await this.pollTask(taskId);
    }
    if (taskStatus === 'failure') {
      // 任务失败时结果接口可能仍带原因；尽力读取后抛错。
      let reason = 'docling task failed';
      try {
        const result = await this.fetchResult(taskId);
        reason = compactErrors(result?.errors)[0] ?? reason;
      } catch {
        /* 保留默认原因 */
      }
      throw new DoclingServiceError(reason);
    }
    const result = await this.fetchResult(taskId);
    const errors = compactErrors(result?.errors);
    const jsonContent = result?.document?.json_content;
    if (!jsonContent) {
      throw new DoclingServiceError('docling result missing json_content');
    }
    const { blocks, parseId } = normalizeDoclingDocument(jsonContent, { pageNo });
    return { blocks, parseId, errors };
  }
}

/** 从整本 PDF 字节流中抽取单页（内容寻址副本在服务端本地读取，不依赖共享路径）。 */
export async function extractPage(pdfBytes, pageNo) {
  try {
    const source = await PDFDocument.load(pdfBytes, {
      ignoreEncryption: true,
      updateMetadata: false,
    });
    const pageCount = source.getPageCount();
    if (!Number.isInteger(pageNo) || pageNo < 1 || pageNo > pageCount) {
      throw new Error(`page ${pageNo} out of range (1..${pageCount})`);
    }
    const single = await PDFDocument.create();
    // 固定元数据时间，保证同一页抽取出的字节确定（可校验、可缓存身份）。
    single.setCreationDate(new Date(0));
    single.setModificationDate(new Date(0));
    // copyPages 必须在目标文档上调用（pdf-lib 跨文档复制规则）。
    const [copied] = await single.copyPages(source, [pageNo - 1]);
    single.addPage(copied);
    const bytes = await single.save();
    return { bytes, pageCount };
  } catch (err) {
    throw new DoclingServiceError(`page extraction failed: ${err.message}`);
  }
}
