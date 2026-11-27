import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startService, stopService } from '../helpers/service.js';

const FIXTURE_A = path.resolve('tests/fixtures/sample-a.pdf');
const FIXTURE_B = path.resolve('tests/fixtures/sample-b.pdf');

// 全流程按声明顺序串行执行（导入 → 重开 → 阅读 → 保存 → 重启恢复）。
test.describe.configure({ mode: 'serial' });

let service;

test.beforeAll(async () => {
  service = await startService();
});

test.afterAll(async () => {
  await stopService(service);
});

async function openLibrary(page) {
  await page.goto(`${service.base}/`);
  return page;
}

async function openReaderFromLibrary(page, nameText) {
  await openLibrary(page);
  const row = page.locator('#library-tbody tr', { hasText: nameText });
  await row.getByRole('button', { name: '打开' }).click();
  await expect(page).toHaveURL(/#\/read\/[0-9a-f]{64}/);
  await expect(page.locator('#reader-title')).toContainText(nameText);
  // 等待首页渲染完成，后续阅读操作才生效。
  await expect(page.locator('#viewer')).toHaveAttribute('data-page', /^\d+$/);
}

test('启动服务后书库可导入多份 PDF 并列出', async ({ page }) => {
  await openLibrary(page);
  await expect(page.locator('#library-empty')).toBeVisible();

  await page.setInputFiles('#import-input', [FIXTURE_A, FIXTURE_B]);
  const rows = page.locator('#library-tbody tr');
  await expect(rows).toHaveCount(2);

  const rowA = page.locator('#library-tbody tr', { hasText: 'sample-a.pdf' });
  await expect(rowA).toContainText('8'); // 页数来自 PDF 内容
  const rowB = page.locator('#library-tbody tr', { hasText: 'sample-b.pdf' });
  await expect(rowB).toContainText('4');

  // 文档身份 = 内容摘要（64 位十六进制），在列表中以短形式展示。
  await expect(rowA.locator('.identity')).toHaveText(/^[0-9a-f]{8}…$/);
  await expect(rowB.locator('.identity')).toHaveText(/^[0-9a-f]{8}…$/);
});

test('相同内容、不同文件名不会产生重复身份', async ({ page }) => {
  const dupPath = path.join(os.tmpdir(), `readeva-dup-${Date.now()}-renamed.pdf`);
  fs.copyFileSync(FIXTURE_A, dupPath);
  try {
    await openLibrary(page);
    await page.setInputFiles('#import-input', dupPath);
    await expect(page.locator('#import-status')).toContainText('已存在');
    await expect(page.locator('#library-tbody tr')).toHaveCount(2);
  } finally {
    fs.rmSync(dupPath, { force: true });
  }
});

test('书库可再次打开文档，原页按原始排版渲染', async ({ page }) => {
  await openReaderFromLibrary(page, 'sample-a.pdf');
  await expect(page.locator('#page-total')).toHaveText('8');
  await expect(page.locator('#page-input')).toHaveValue('1');
  await expect(page.locator('#viewer')).toHaveAttribute('data-page', '1');

  // canvas 实际渲染出了页面内容（存在大量非空白像素）。
  const info = await page.evaluate(() => {
    const canvas = document.getElementById('pdf-canvas');
    const ctx = canvas.getContext('2d');
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let dark = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] < 160) dark += 1;
    }
    return { width: canvas.width, height: canvas.height, dark };
  });
  expect(info.width).toBeGreaterThan(300);
  expect(info.height).toBeGreaterThan(300);
  expect(info.dark).toBeGreaterThan(200);
});

test('支持翻页、页码跳转和缩放', async ({ page }) => {
  await openReaderFromLibrary(page, 'sample-a.pdf');

  // 翻页
  await page.click('#page-next');
  await expect(page.locator('#page-input')).toHaveValue('2');
  await expect(page.locator('#viewer')).toHaveAttribute('data-page', '2');
  await page.click('#page-next');
  await expect(page.locator('#viewer')).toHaveAttribute('data-page', '3');

  // 页码跳转
  await page.fill('#page-input', '5');
  await page.press('#page-input', 'Enter');
  await expect(page.locator('#viewer')).toHaveAttribute('data-page', '5');

  // 缩放
  await page.click('#zoom-in');
  await expect(page.locator('#zoom-level')).toHaveText('120%');
  await expect(page.locator('#viewer')).toHaveAttribute('data-zoom', '1.2');
  await page.click('#zoom-out');
  await expect(page.locator('#zoom-level')).toHaveText('100%');
  await expect(page.locator('#viewer')).toHaveAttribute('data-zoom', '1');
});

test('阅读位置变化后自动持久保存', async ({ page, request }) => {
  await openReaderFromLibrary(page, 'sample-a.pdf');

  await page.fill('#page-input', '6');
  await page.press('#page-input', 'Enter');
  await expect(page.locator('#viewer')).toHaveAttribute('data-page', '6');
  await page.click('#zoom-in');
  await expect(page.locator('#zoom-level')).toHaveText('120%');

  const docId = new URL(page.url()).hash.split('/').pop();
  // 自动保存（400ms 去抖 + PUT），轮询直到服务端确认。
  await expect
    .poll(
      async () => {
        const res = await request.get(`${service.base}/api/documents/${docId}/progress`);
        const { progress } = await res.json();
        return `${progress.page}:${progress.zoom}`;
      },
      { timeout: 8000, intervals: [400, 800, 1600] },
    )
    .toBe('6:1.2');
});

test('重启服务后，新浏览器会话恢复上次阅读页与缩放', async ({ browser }) => {
  // 前置：上一用例已保存 sample-a 的阅读位置（第 6 页、120%）。
  const { dataDir, port } = service;
  await stopService(service);
  service = await startService({ dataDir, port: Number(port) });

  // 全新浏览器会话 = 应用重启。
  const context = await browser.newContext();
  const page = await context.newPage();
  await openLibrary(page);

  const row = page.locator('#library-tbody tr', { hasText: 'sample-a.pdf' });
  await expect(row.locator('.last-read')).toContainText('第 6 页');

  await row.getByRole('button', { name: '打开' }).click();
  await expect(page.locator('#viewer')).toHaveAttribute('data-page', '6');
  await expect(page.locator('#zoom-level')).toHaveText('120%');
  await expect(page.locator('#page-total')).toHaveText('8');

  // 恢复后继续阅读仍然有效：翻页并再次确认自动保存。
  await page.click('#page-next');
  await expect(page.locator('#viewer')).toHaveAttribute('data-page', '7');
  const docId = new URL(page.url()).hash.split('/').pop();
  await expect
    .poll(async () => {
      const res = await page.request.get(`${service.base}/api/documents/${docId}/progress`);
      const { progress } = await res.json();
      return String(progress.page);
    }, { timeout: 8000 })
    .toBe('7');

  await context.close();
});
