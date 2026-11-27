import { expect, test } from '@playwright/test';
import path from 'node:path';
import { startService, stopService } from '../helpers/service.js';
import { startMockDocling } from '../helpers/mock-docling.js';

const FIXTURE_A = path.resolve('tests/fixtures/sample-a.pdf');
const FIXTURE_B = path.resolve('tests/fixtures/sample-b.pdf');
const PAGE3_DOC = path.resolve('tests/fixtures/docling/page-3.json');

// 串行：打开 → 首页解析 → 跳页 → 复用 → 重启恢复 → 失败重试。
test.describe.configure({ mode: 'serial' });

let mock;
let service;

test.beforeAll(async () => {
  mock = await startMockDocling({ byPage: { 3: PAGE3_DOC } });
  service = await startService({ env: { READEVA_DOCLING_URL: mock.base } });
});

test.afterAll(async () => {
  await stopService(service);
  await mock.close();
});

async function openLibrary(page) {
  await page.goto(`${service.base}/`);
}

async function openReader(page, nameText) {
  await openLibrary(page);
  const row = page.locator('#library-tbody tr', { hasText: nameText });
  await row.getByRole('button', { name: '打开' }).click();
  await expect(page).toHaveURL(/#\/read\/[0-9a-f]{64}/);
  // 原页渲染先于解析面板（不等解析）。
  await expect(page.locator('#viewer')).toHaveAttribute('data-page', /^\d+$/);
}

async function waitForPanelDone(page) {
  await expect(page.locator('#parse-status')).toHaveText('已完成', { timeout: 15000 });
}

test('导入并打开文档：原页立即渲染，右侧解析面板随后展示结构化内容', async ({ page }) => {
  await openLibrary(page);
  await page.setInputFiles('#import-input', FIXTURE_A);
  await expect(page.locator('#library-tbody tr')).toHaveCount(1);

  await openReader(page, 'sample-a.pdf');
  // 原页先就绪；解析状态可见（未开始/解析中）。
  await expect(page.locator('#parse-panel')).toBeVisible();
  await expect(page.locator('#parse-status')).toHaveText(/未开始|解析中…|已完成/);

  // 解析完成后按阅读顺序展示标题、段落与列表。
  await waitForPanelDone(page);
  const blocks = page.locator('#parse-content .parse-block');
  await expect(blocks.first()).toHaveClass(/parse-block-heading/);
  await expect(page.locator('#parse-content h3')).toHaveText('Sample A · Inflight Service Manual (fixture)');
  await expect(page.locator('#parse-content .parse-paragraph').first()).toContainText(
    'stored per content identity',
  );

  // 缺少位置的段落照常展示，且不携带位置标记。
  const noPosition = page.locator('#parse-content .parse-block', { hasText: 'no provenance' });
  await expect(noPosition).toBeVisible();
  await expect(noPosition).toHaveAttribute('data-has-position', 'false');

  // 页眉页脚（furniture）不进入阅读顺序。
  await expect(page.locator('#parse-content')).not.toContainText('fixture generated for Readeva');

  // 有位置的块携带位置标记。
  await expect(page.locator('#parse-content .parse-block-heading').first()).toHaveAttribute(
    'data-has-position',
    'true',
  );
});

test('跳页到第 3 页：按页重新解析并展示列表、表格与图片资源', async ({ page }) => {
  await openReader(page, 'sample-a.pdf');
  await waitForPanelDone(page);
  await page.fill('#page-input', '3');
  await page.press('#page-input', 'Enter');
  await expect(page.locator('#viewer')).toHaveAttribute('data-page', '3');
  await waitForPanelDone(page);

  // 无序列表
  const unordered = page.locator('#parse-content ul.parse-list');
  await expect(unordered.locator('li')).toHaveCount(2);
  await expect(unordered.locator('li').first()).toHaveText('Check the cabin pressure indicator.');

  // 有序列表
  const ordered = page.locator('#parse-content ol.parse-list');
  await expect(ordered.locator('li')).toHaveCount(2);
  await expect(ordered.locator('li').first()).toHaveText('Remove the checklist card from the rack.');

  // 表格：列头 + 3 行数据。
  const table = page.locator('#parse-content table.parse-table');
  await expect(table.locator('thead th')).toHaveText(['Item', 'Qty', 'Location']);
  await expect(table.locator('tbody tr')).toHaveCount(3);
  await expect(table.locator('tbody tr').first().locator('td')).toHaveText([
    'Service manual',
    '1',
    'Chapter 3',
  ]);

  // 图片资源真实渲染（内嵌 data URI → 浏览器解码成功）。
  const img = page.locator('#parse-content img.parse-image');
  await expect(img).toBeVisible();
  await expect(img).toHaveAttribute('src', /^data:image\/png;base64,/);
  const natural = await img.evaluate((node) => node.naturalWidth);
  expect(natural).toBeGreaterThan(0);

  // 解析按页独立：第 3 页的解析发送的是 page-3.pdf 单页字节流。
  // （Issue #5 起，打开文档后调度器会在后台补全整本，故只断言该页确实被请求；
  // 提交顺序断言见 parse-scheduler.spec.js。）
  const converts = mock.requests.filter((r) => r.kind === 'convert');
  expect(converts.map((r) => r.filename)).toContain('page-3.pdf');
});

test('回到已解析页与重开文档：直接取回结果，不重新解析', async ({ page, context }) => {
  // Issue #5 调度会在后台补全整本：先等待全部页解析完成，再验证已完成页复用。
  await expect.poll(() => mock.convertCalls(), { timeout: 30000 }).toBe(8);
  const callsAfterParse = mock.convertCalls();

  // 打开文档（恢复到上次阅读的第 3 页，已解析 → 只取回），再回到第 1 页。
  await openReader(page, 'sample-a.pdf');
  await waitForPanelDone(page);
  await page.fill('#page-input', '1');
  await page.press('#page-input', 'Enter');
  await expect(page.locator('#viewer')).toHaveAttribute('data-page', '1');
  await waitForPanelDone(page);
  expect(mock.convertCalls()).toBe(callsAfterParse);

  // 返回书库再重开 → 面板直接恢复内容，仍然不重新解析。
  await page.click('#back-button');
  await expect(page.locator('#view-library')).toBeVisible();
  await openReader(page, 'sample-a.pdf');
  await waitForPanelDone(page);
  await expect(page.locator('#parse-content h3')).toHaveText('Sample A · Inflight Service Manual (fixture)');
  expect(mock.convertCalls()).toBe(callsAfterParse);
  await context.close();
});

test('重启服务后新会话恢复解析内容，仍然不重新解析', async ({ browser }) => {
  const callsBeforeRestart = mock.convertCalls();
  const { dataDir, port } = service;
  await stopService(service);
  service = await startService({ dataDir, port: Number(port), env: { READEVA_DOCLING_URL: mock.base } });

  const context = await browser.newContext();
  const page = await context.newPage();
  await openReader(page, 'sample-a.pdf');
  await waitForPanelDone(page);
  await expect(page.locator('#parse-content h3')).toHaveText('Sample A · Inflight Service Manual (fixture)');
  expect(mock.convertCalls()).toBe(callsBeforeRestart);
  await context.close();
});

test('解析失败状态与原因可见，重试后恢复', async ({ page }) => {
  // Issue #5 调度会补全整本，sample-a 已全部解析；改用未解析的 sample-b 验证失败重试：
  // 行为脚本第 1 次成功（打开即解析第 1 页），其后失败（第 2 页及队列后续）。
  await page.goto(`${service.base}/`);
  await page.setInputFiles('#import-input', FIXTURE_B);
  await expect(page.locator('#library-tbody tr', { hasText: 'sample-b.pdf' })).toHaveCount(1);

  mock.setBehavior([{ mode: 'success' }, { mode: 'failure', message: 'mock conversion exploded' }]);

  await openReader(page, 'sample-b.pdf');
  // 跳到第 2 页：调度已在后台排队，该页解析失败（失败不阻塞其他页）。
  await page.fill('#page-input', '2');
  await page.press('#page-input', 'Enter');
  await expect(page.locator('#viewer')).toHaveAttribute('data-page', '2');

  await expect(page.locator('#parse-status')).toHaveText('解析失败', { timeout: 15000 });
  await expect(page.locator('#parse-error')).toContainText('mock conversion exploded');
  await expect(page.locator('#parse-retry')).toBeVisible();

  // 恢复成功行为后点击重试 → 完成。
  mock.setBehavior(null);
  await page.click('#parse-retry');
  await waitForPanelDone(page);
  await expect(page.locator('#parse-content .parse-paragraph').first()).toContainText(
    'stored per content identity',
  );
});
