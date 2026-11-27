import { expect, test } from '@playwright/test';
import path from 'node:path';
import { startService, stopService } from '../helpers/service.js';
import { startMockDocling } from '../helpers/mock-docling.js';

const FIXTURE_A = path.resolve('tests/fixtures/sample-a.pdf');
// 第 1 页：全部块带有效 bbox（含 BOTTOMLEFT 坐标系样例）；第 2 页：无效/缺失位置；
// 第 3 页：标题/列表/表格/图片/缺位置段落。
const LINKAGE_DOC = path.resolve('tests/fixtures/docling/linkage-page.json');
const BROKEN_DOC = path.resolve('tests/fixtures/docling/broken-positions-page.json');
const PAGE3_DOC = path.resolve('tests/fixtures/docling/page-3.json');

// 串行：同一文档按顺序在多个用例中流转（导入 → 悬浮 → 定位 → 缩放 → 缺位置 → 翻页）。
test.describe.configure({ mode: 'serial' });

let mock;
let service;

test.beforeAll(async () => {
  mock = await startMockDocling({ byPage: { 1: LINKAGE_DOC, 2: BROKEN_DOC, 3: PAGE3_DOC } });
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
  await expect(page.locator('#viewer')).toHaveAttribute('data-page', /^\d+$/);
}

async function waitForPanelDone(page) {
  await expect(page.locator('#parse-status')).toHaveText('已完成', { timeout: 15000 });
}

async function jumpToPage(page, number) {
  await page.fill('#page-input', String(number));
  await page.press('#page-input', 'Enter');
  await expect(page.locator('#viewer')).toHaveAttribute('data-page', String(number));
}

/** 覆盖框相对 canvas 的渲染坐标（CSS 像素）。 */
async function boxRect(page, blockId) {
  return page
    .locator(`.page-block-box[data-block-id="${blockId}"]`)
    .evaluate((el) => {
      const canvas = document.getElementById('pdf-canvas');
      const r = el.getBoundingClientRect();
      const c = canvas.getBoundingClientRect();
      return { left: r.left - c.left, top: r.top - c.top, width: r.width, height: r.height };
    });
}

/** 断言覆盖框渲染位置 ≈ bbox（PDF 点坐标）× 当前缩放。 */
async function expectBoxAtPdfCoordinates(page, blockId, bbox, zoom) {
  const rect = await boxRect(page, blockId);
  const tol = 2; // canvas CSS 尺寸按点坐标向下取整，误差 < 1px
  expect(Math.abs(rect.left - bbox.l * zoom), `left@${zoom}`).toBeLessThanOrEqual(tol);
  expect(Math.abs(rect.top - bbox.t * zoom), `top@${zoom}`).toBeLessThanOrEqual(tol);
  expect(Math.abs(rect.width - (bbox.r - bbox.l) * zoom), `width@${zoom}`).toBeLessThanOrEqual(tol);
  expect(Math.abs(rect.height - (bbox.b - bbox.t) * zoom), `height@${zoom}`).toBeLessThanOrEqual(
    tol,
  );
}

test('双向悬浮高亮：右侧内容块 ↔ 原页覆盖框互相高亮', async ({ page }) => {
  await openLibrary(page);
  await page.setInputFiles('#import-input', FIXTURE_A);
  await expect(page.locator('#library-tbody tr')).toHaveCount(1);

  await openReader(page, 'sample-a.pdf');
  await waitForPanelDone(page);

  // 每个带 bbox 的内容块都有原页覆盖框（第 1 页 6 块全部有位置）。
  await expect(page.locator('.page-block-box')).toHaveCount(6);
  await expect(page.locator('#parse-content .parse-block')).toHaveCount(6);

  // 悬浮右侧内容块 → 原页对应区域高亮。
  const block1 = page.locator('#parse-content .parse-block[data-block-id="b1"]');
  const box1 = page.locator('.page-block-box[data-block-id="b1"]');
  await block1.hover();
  await expect(box1).toHaveClass(/hot/);
  await expect(block1).toHaveClass(/hot/);

  // 移开后高亮清除。
  await page.hover('#reader-title');
  await expect(box1).not.toHaveClass(/hot/);
  await expect(block1).not.toHaveClass(/hot/);

  // 悬浮原页区域 → 右侧对应内容块高亮。
  const block2 = page.locator('#parse-content .parse-block[data-block-id="b2"]');
  const box2 = page.locator('.page-block-box[data-block-id="b2"]');
  await box2.hover();
  await expect(box2).toHaveClass(/hot/);
  await expect(block2).toHaveClass(/hot/);
  // 切换悬浮目标时旧高亮清除。
  await expect(box1).not.toHaveClass(/hot/);
  await page.hover('#reader-title');
  await expect(block2).not.toHaveClass(/hot/);
  await expect(box2).not.toHaveClass(/hot/);
});

test('主动定位：点击右侧内容块 → 原页定位；点击原页区域 → 右侧定位', async ({ page }) => {
  await openReader(page, 'sample-a.pdf');
  await waitForPanelDone(page);

  // 缩小视口：原页与右侧内容列表都超出可视范围，可验证滚动定位。
  await page.setViewportSize({ width: 1280, height: 500 });

  // 放大到 120%：第 4 段（页面底部）超出可视范围，可验证滚动定位。
  await page.click('#zoom-in');
  await expect(page.locator('#viewer')).toHaveAttribute('data-zoom', '1.2');

  // 点击右侧内容块 → 原页对应区域进入视口并保持选中标记。
  await page.locator('#viewer').evaluate((el) => {
    el.scrollTop = 0;
    el.scrollLeft = 0;
  });
  const box4 = page.locator('.page-block-box[data-block-id="b4"]');
  await expect(box4).not.toBeInViewport();
  await page.locator('#parse-content .parse-block[data-block-id="b4"]').click();
  await expect(box4).toHaveClass(/active/);
  await expect(box4).toBeInViewport({ ratio: 0.5 });
  await expect(
    page.locator('#parse-content .parse-block[data-block-id="b4"]'),
  ).toHaveClass(/active/);

  // 点击原页区域 → 右侧对应内容块进入视口并保持选中标记。
  await page.locator('#parse-content').evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  const block0 = page.locator('#parse-content .parse-block[data-block-id="b0"]');
  await expect(block0).not.toBeInViewport();
  await page.locator('.page-block-box[data-block-id="b0"]').click();
  await expect(block0).toHaveClass(/active/);
  await expect(block0).toBeInViewport();
  // 选中态独占：上一个选中的块被清除。
  await expect(
    page.locator('.page-block-box[data-block-id="b4"]'),
  ).not.toHaveClass(/active/);
});

test('缩放后覆盖层按当前缩放重算，bbox 定位仍准确', async ({ page }) => {
  await openReader(page, 'sample-a.pdf');
  await waitForPanelDone(page);

  // 每次缩放点击后等待渲染完成（data-zoom 更新），避免下一次点击读到旧缩放。
  await page.click('#zoom-in');
  await expect(page.locator('#viewer')).toHaveAttribute('data-zoom', '1.2');

  // 120%：同一 bbox 按当前渲染缩放换算（56×1.2=67.2 …）。
  await expectBoxAtPdfCoordinates(page, 'b1', { l: 56, t: 90, r: 540, b: 200 }, 1.2);

  // 回到 100%：恢复为 bbox × 1。
  await page.click('#zoom-out');
  await expect(page.locator('#viewer')).toHaveAttribute('data-zoom', '1');
  await expectBoxAtPdfCoordinates(page, 'b1', { l: 56, t: 90, r: 540, b: 200 }, 1);
  // BOTTOMLEFT 坐标系按页面点高度换算为顶部原点（t=800/b=760 → top=41.89, height=40）。
  await expectBoxAtPdfCoordinates(page, 'b5', { l: 400, t: 41.89, r: 560, b: 81.89 }, 1);

  // 缩小到 83.3%：仍然准确。
  await page.click('#zoom-out');
  await expect(page.locator('#viewer')).toHaveAttribute('data-zoom', '0.833');
  await expectBoxAtPdfCoordinates(page, 'b1', { l: 56, t: 90, r: 540, b: 200 }, 0.833);

  // 缩放重建不丢失覆盖框，双向联动继续可用。
  await expect(page.locator('.page-block-box')).toHaveCount(6);
  const block1 = page.locator('#parse-content .parse-block[data-block-id="b1"]');
  const box1 = page.locator('.page-block-box[data-block-id="b1"]');
  await block1.hover();
  await expect(box1).toHaveClass(/hot/);
  await page.hover('#reader-title');
  await expect(box1).not.toHaveClass(/hot/);
  // 回到 100% 供后续用例使用。
  await page.click('#zoom-in');
  await expect(page.locator('#viewer')).toHaveAttribute('data-zoom', '1');
});

test('缺失/无效位置：内容照常展示，悬浮静默，主动定位有提示', async ({ page }) => {
  await openReader(page, 'sample-a.pdf');
  await waitForPanelDone(page);
  await jumpToPage(page, 2);
  await waitForPanelDone(page);

  // 三个内容块照常展示；仅有效位置的块有覆盖框。
  await expect(page.locator('#parse-content .parse-block')).toHaveCount(3);
  const valid = page.locator('#parse-content .parse-block[data-block-id="b0"]');
  const degenerate = page.locator('#parse-content .parse-block[data-block-id="b1"]');
  const missing = page.locator('#parse-content .parse-block[data-block-id="b2"]');
  await expect(valid).toHaveAttribute('data-has-position', 'true');
  await expect(degenerate).toHaveAttribute('data-has-position', 'true'); // 带 bbox 但零尺寸（无效）
  await expect(missing).toHaveAttribute('data-has-position', 'false');
  await expect(page.locator('.page-block-box')).toHaveCount(1);
  await expect(page.locator('.page-block-box[data-block-id="b0"]')).toHaveCount(1);
  await expect(page.locator('.page-block-box[data-block-id="b1"]')).toHaveCount(0);
  await expect(page.locator('.page-block-box[data-block-id="b2"]')).toHaveCount(0);

  // 悬浮无/无效位置的块：静默（无高亮、无提示、无报错）。
  const toast = page.locator('#locate-toast');
  await degenerate.hover();
  await expect(toast).toBeHidden();
  await expect(page.locator('.page-block-box.hot')).toHaveCount(0);
  await missing.hover();
  await expect(toast).toBeHidden();

  // 主动定位无/无效位置：toast 提示，不打断阅读（状态不变、无错误、无选中残留）。
  await degenerate.click();
  await expect(toast).toBeVisible();
  await expect(toast).toContainText('没有可用位置');
  await expect(page.locator('#parse-status')).toHaveText('已完成');
  await expect(page.locator('#parse-error')).toBeHidden();
  await expect(page.locator('#parse-content .parse-block.active')).toHaveCount(0);

  await missing.click();
  await expect(toast).toBeVisible();
  await expect(page.locator('#parse-status')).toHaveText('已完成');

  // 提示自动消失。
  await expect(toast).toBeHidden({ timeout: 6000 });

  // 同页有效位置块仍可正常定位。
  await valid.click();
  await expect(page.locator('.page-block-box[data-block-id="b0"]')).toHaveClass(/active/);
  await expect(toast).toBeHidden();
});

test('翻页后覆盖层跟随当前页：按新页 bbox 重建并继续联动', async ({ page }) => {
  await openReader(page, 'sample-a.pdf');
  await waitForPanelDone(page);
  await jumpToPage(page, 3);
  await waitForPanelDone(page);

  // 第 3 页 6 个块有位置（列表/表格/图片/标题），缺位置段落（b6）无覆盖框。
  await expect(page.locator('.page-block-box')).toHaveCount(6);
  await expect(page.locator('.page-block-box[data-block-id="b6"]')).toHaveCount(0);

  // 新页内容的双向联动可用（表格块 ↔ 覆盖框）。
  const tableBlock = page.locator('#parse-content .parse-block[data-block-id="b3"]');
  const tableBox = page.locator('.page-block-box[data-block-id="b3"]');
  await tableBlock.hover();
  await expect(tableBox).toHaveClass(/hot/);
  await expect(tableBlock).toHaveClass(/hot/);
  await tableBox.click();
  await expect(tableBlock).toHaveClass(/active/);
  await expect(tableBox).toHaveClass(/active/);
});
