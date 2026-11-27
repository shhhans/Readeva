import { expect, test } from '@playwright/test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { startService, stopService } from '../helpers/service.js';
import { startMockDocling } from '../helpers/mock-docling.js';

const FIXTURE_A = path.resolve('tests/fixtures/sample-a.pdf');
const PAGE3_DOC = path.resolve('tests/fixtures/docling/page-3.json');

// 服务级用例按顺序串行：解析 → 校验 → 重启恢复 → 复用 → 失败重试。
test.describe.configure({ mode: 'serial' });

let mock;
let service;
let docId;

test.beforeAll(async () => {
  mock = await startMockDocling({ byPage: { 3: PAGE3_DOC } });
  service = await startService({ env: { READEVA_DOCLING_URL: mock.base } });
});

test.afterAll(async () => {
  await stopService(service);
  await mock.close();
});

async function importFixtureA(request) {
  const res = await request.post(`${service.base}/api/documents/import`, {
    headers: { 'content-type': 'application/pdf', 'x-filename': 'sample-a.pdf' },
    data: fs.readFileSync(FIXTURE_A),
  });
  expect(res.status()).toBe(201);
  const { document } = await res.json();
  return document;
}

async function waitForStatus(request, page, expected) {
  await expect
    .poll(
      async () => {
        const res = await request.get(`${service.base}/api/documents/${docId}/pages/${page}/parse`);
        const { status } = await res.json();
        return status;
      },
      { timeout: 15000, intervals: [300, 600, 1200] },
    )
    .toBe(expected);
}

/** 与服务端 extractPage 相同方式抽取单页（固定元数据 → 字节确定）。 */
async function extractFixturePage(pageNo) {
  const source = await PDFDocument.load(fs.readFileSync(FIXTURE_A), {
    ignoreEncryption: true,
    updateMetadata: false,
  });
  const single = await PDFDocument.create();
  single.setCreationDate(new Date(0));
  single.setModificationDate(new Date(0));
  const [copied] = await single.copyPages(source, [pageNo - 1]);
  single.addPage(copied);
  return Buffer.from(await single.save());
}

test('解析服务配置暴露：configured=true', async ({ request }) => {
  const res = await request.get(`${service.base}/api/parse/service`);
  const body = await res.json();
  expect(body.configured).toBe(true);
});

test('发起页解析请求 → 任务状态流转到成功 → 结果按阅读顺序返回', async ({ request }) => {
  const doc = await importFixtureA(request);
  docId = doc.id;
  expect(doc.pageCount).toBe(8);

  const start = await request.post(`${service.base}/api/documents/${docId}/pages/3/parse`);
  expect(start.status()).toBe(202);
  expect((await start.json()).status).toBe('running');

  await waitForStatus(request, 3, 'succeeded');
  const status = await (await request.get(`${service.base}/api/documents/${docId}/pages/3/parse`)).json();
  expect(status.status).toBe('succeeded');
  expect(status.parseId).toMatch(/^[0-9a-f]{64}$/);
});

test('结果包含标题/段落/列表/表格/图片资源与可用位置，页脚被跳过，缺位置不阻断', async ({ request }) => {
  const res = await request.get(`${service.base}/api/documents/${docId}/pages/3/parse/result`);
  expect(res.status()).toBe(200);
  const { parse } = await res.json();
  expect(parse.page).toBe(3);
  expect(parse.status).toBe('succeeded');
  expect(parse.parseId).toMatch(/^[0-9a-f]{64}$/);

  const kinds = parse.blocks.map((b) => b.kind);
  expect(kinds).toEqual([
    'heading',
    'heading',
    'list',
    'table',
    'image',
    'list',
    'paragraph',
  ]);

  const [title, section, unordered, table, image, ordered, caption] = parse.blocks;
  expect(title).toMatchObject({ kind: 'heading', level: 1, text: 'Sample A · Chapter 2' });
  expect(title.bbox).toMatchObject({ pageNo: 3, coordOrigin: 'TOPLEFT' });
  expect(section).toMatchObject({ kind: 'heading', level: 2, text: 'Cabin equipment checks' });

  expect(unordered.ordered).toBe(false);
  expect(unordered.items).toEqual([
    'Check the cabin pressure indicator.',
    'Verify the service manual revision.',
  ]);
  expect(unordered.items.every((item) => item.length > 0)).toBe(true);

  // 表格：列头行 + 数据行。
  expect(table.columnHeader).toBe(true);
  expect(table.rows).toEqual([
    ['Item', 'Qty', 'Location'],
    ['Service manual', '1', 'Chapter 3'],
    ['Checklist card', '2', 'Cabin rack'],
    ['Spare label set', '4', 'Storage bin'],
  ]);

  // 图片资源：内嵌 data URI 随块返回。
  expect(image.image.uri).toMatch(/^data:image\/png;base64,/);
  expect(image.image.mimeType).toBe('image/png');
  expect(image.bbox).toBeTruthy();

  expect(ordered.ordered).toBe(true);
  expect(ordered.items).toEqual([
    'Remove the checklist card from the rack.',
    'Stow the spare label set.',
  ]);

  // 缺少位置的段落仍然展示（bbox 为 null，不阻断）。
  expect(caption.kind).toBe('paragraph');
  expect(caption.text).toContain('no provenance position');
  expect(caption.bbox).toBeNull();

  // 页眉页脚（furniture）不进入阅读顺序。
  expect(parse.blocks.some((b) => b.text?.includes('fixture generated for Readeva'))).toBe(false);
});

test('解析请求发送的是单页 PDF 字节流（不依赖共享文件路径）', async () => {
  const converts = mock.requests.filter((r) => r.kind === 'convert');
  expect(converts.length).toBe(1);
  expect(converts[0].filename).toBe('page-3.pdf');

  const expected = await extractFixturePage(3);
  expect(converts[0].sha256).toBe(crypto.createHash('sha256').update(expected).digest('hex'));
});

test('解析结果已持久保存：重启服务后直接取回，不重新解析', async ({ request, browser }) => {
  const before = await (
    await request.get(`${service.base}/api/documents/${docId}/pages/3/parse/result`)
  ).json();

  const recordPath = path.join(service.dataDir, 'parses', docId, 'page-3.json');
  expect(fs.existsSync(recordPath)).toBe(true);

  // 真实重启服务（同数据目录），全新浏览器会话取回。
  const { dataDir, port } = service;
  await stopService(service);
  service = await startService({ dataDir, port: Number(port), env: { READEVA_DOCLING_URL: mock.base } });

  const after = await (
    await request.get(`${service.base}/api/documents/${docId}/pages/3/parse/result`)
  ).json();
  expect(after.parse.parseId).toBe(before.parse.parseId);
  expect(after.parse.blocks).toEqual(before.parse.blocks);
  expect(mock.convertCalls()).toBe(1); // 全程只有最初那一次真实解析

  // 浏览器 API 视角：状态端点也直接返回成功。
  const status = await (await request.get(`${service.base}/api/documents/${docId}/pages/3/parse`)).json();
  expect(status.status).toBe('succeeded');
  void browser;
});

test('已完成页重复请求解析 → 复用结果，不重新解析', async ({ request }) => {
  const res = await request.post(`${service.base}/api/documents/${docId}/pages/3/parse`);
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.status).toBe('succeeded');
  expect(body.reused).toBe(true);
  expect(mock.convertCalls()).toBe(1);
});

test('解析失败 → 状态可见且带原因；重试成功后恢复', async ({ request }) => {
  mock.setBehavior([{ mode: 'failure', message: 'mock conversion exploded' }]);

  const start = await request.post(`${service.base}/api/documents/${docId}/pages/5/parse`);
  expect(start.status()).toBe(202);
  await waitForStatus(request, 5, 'failed');

  const status = await (await request.get(`${service.base}/api/documents/${docId}/pages/5/parse`)).json();
  expect(status.status).toBe('failed');
  expect(status.error).toContain('mock conversion exploded');

  // 失败页没有可取回的结果。
  const result = await request.get(`${service.base}/api/documents/${docId}/pages/5/parse/result`);
  expect(result.status()).toBe(404);

  // 显式重试 → 成功并持久化。
  mock.setBehavior(null);
  const retry = await request.post(`${service.base}/api/documents/${docId}/pages/5/parse`);
  expect(retry.status()).toBe(202);
  await waitForStatus(request, 5, 'succeeded');
  expect(mock.convertCalls()).toBe(3); // page3 + 失败 + 重试
});

test('不同页的解析相互独立（按页保存）', async ({ request }) => {
  // 先解析第 1 页（默认固定文档），再与第 5 页比较身份。
  const start = await request.post(`${service.base}/api/documents/${docId}/pages/1/parse`);
  expect(start.status()).toBe(202);
  await waitForStatus(request, 1, 'succeeded');

  const page1 = await (await request.get(`${service.base}/api/documents/${docId}/pages/1/parse/result`)).json();
  const page5 = await (await request.get(`${service.base}/api/documents/${docId}/pages/5/parse/result`)).json();
  expect(page1.parse.parseId).not.toBe(page5.parse.parseId);
  expect(page1.parse.page).toBe(1);
  expect(page5.parse.page).toBe(5);
});

test('参数校验：非法页码与未知文档', async ({ request }) => {
  for (const page of ['0', '999', 'abc']) {
    const res = await request.post(`${service.base}/api/documents/${docId}/pages/${page}/parse`);
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toBeTruthy();
  }
  const missing = await request.get(`${service.base}/api/documents/${'0'.repeat(64)}/pages/1/parse`);
  expect(missing.status()).toBe(404);
  const missingResult = await request.get(`${service.base}/api/documents/${'0'.repeat(64)}/pages/1/parse/result`);
  expect(missingResult.status()).toBe(404);
  const missingFile = await request.get(`${service.base}/api/documents/${docId}/pages/9/parse`);
  expect(missingFile.status()).toBe(400);
});
