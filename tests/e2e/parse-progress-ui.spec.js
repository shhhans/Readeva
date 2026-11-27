import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { startService, stopService } from '../helpers/service.js';
import { startMockDocling } from '../helpers/mock-docling.js';

const FIXTURE_A = path.resolve('tests/fixtures/sample-a.pdf');
const FIXTURE_B = path.resolve('tests/fixtures/sample-b.pdf');

// 浏览器级用例覆盖 Issue #5 验收第 3/4 条：逐页状态、整体进度、失败原因展示与显式重试。
// 串行：同一服务进程上按顺序验证进度展示 → 页码跳转 → 失败隔离与重试。
test.describe.configure({ mode: 'serial' });

let mock;
let service;

test.beforeAll(async ({ request }) => {
  mock = await startMockDocling();
  service = await startService({
    env: { READEVA_DOCLING_URL: mock.base, READEVA_DOCLING_POLL_INTERVAL_MS: '50' },
  });
  for (const [file, name] of [
    [FIXTURE_A, 'sample-a.pdf'],
    [FIXTURE_B, 'sample-b.pdf'],
  ]) {
    const res = await request.post(`${service.base}/api/documents/import`, {
      headers: { 'content-type': 'application/pdf', 'x-filename': name },
      data: fs.readFileSync(file),
    });
    expect(res.status()).toBe(201);
  }
});

test.afterAll(async () => {
  await stopService(service);
  await mock.close();
});

async function openReader(page, nameText) {
  await page.goto(`${service.base}/`);
  const row = page.locator('#library-tbody tr', { hasText: nameText });
  await row.getByRole('button', { name: '打开' }).click();
  await expect(page).toHaveURL(/#\/read\/[0-9a-f]{64}/);
  await expect(page.locator('#viewer')).toHaveAttribute('data-page', /^\d+$/);
}

test('整本解析进度：逐页状态与整体进度可见，闲置补全后台完成', async ({ page }) => {
  await openReader(page, 'sample-a.pdf');

  // 进度区可见：8 个页码芯片逐一展示状态。
  const summary = page.locator('#parse-progress-summary');
  const chips = page.locator('#parse-progress-pages .parse-page-chip');
  await expect(chips).toHaveCount(8);
  await expect(chips.nth(0)).toHaveAttribute('data-page', '1');
  await expect(chips.nth(7)).toHaveAttribute('data-page', '8');
  await expect(summary).toContainText(/已解析 \d+\/8/);

  // 当前页解析完成后后台补全继续：无需用户操作，整体进度推进到 8/8。
  await expect(summary).toHaveText('已解析 8/8', { timeout: 20000 });
  for (let i = 0; i < 8; i += 1) {
    await expect(chips.nth(i)).toHaveAttribute('data-status', 'succeeded');
  }
  // 整本补全恰好每页一次转换（无重复解析）。
  expect(mock.convertCalls()).toBe(8);
});

test('点击进度页码跳转：原页与面板跟随目标页，已完成页直接复用', async ({ page }) => {
  await openReader(page, 'sample-a.pdf');

  await page.locator('#parse-progress-pages .parse-page-chip[data-page="3"]').click();
  await expect(page.locator('#viewer')).toHaveAttribute('data-page', '3');
  await expect(page.locator('#page-input')).toHaveValue('3');
  await expect(page.locator('#parse-status')).toHaveText('已完成');
  // 复用已解析页：转换请求数不变。
  expect(mock.convertCalls()).toBe(8);
});

test('失败页展示失败原因，可显式重试且其他页继续处理', async ({ page }) => {
  // 第 2 页固定失败：后台补全继续处理其他页（失败不阻塞队列）。
  mock.setFailPages({ 2: 'mock page 2 conversion failed' });
  const callsBefore = mock.convertCalls();
  await openReader(page, 'sample-b.pdf');

  const summary = page.locator('#parse-progress-summary');
  const chips = page.locator('#parse-progress-pages .parse-page-chip');
  // 整本处理完成后：3 页成功、1 页失败，失败原因进入逐页状态。
  await expect(summary).toHaveText('已解析 3/4 · 失败 1', { timeout: 20000 });
  await expect(chips.nth(0)).toHaveAttribute('data-status', 'succeeded');
  await expect(chips.nth(1)).toHaveAttribute('data-status', 'failed');
  await expect(chips.nth(2)).toHaveAttribute('data-status', 'succeeded');
  await expect(chips.nth(3)).toHaveAttribute('data-status', 'succeeded');
  await expect(chips.nth(1)).toHaveAttribute('aria-label', /mock page 2 conversion failed/);
  expect(mock.convertCalls()).toBe(callsBefore + 4);

  // 点击失败页芯片跳到该页：面板展示失败原因与重试按钮。
  await chips.nth(1).click();
  await expect(page.locator('#viewer')).toHaveAttribute('data-page', '2');
  await expect(page.locator('#parse-status')).toHaveText('解析失败');
  await expect(page.locator('#parse-error')).toContainText('mock page 2 conversion failed');
  await expect(page.locator('#parse-retry')).toBeVisible();

  // 解除失败注入 → 显式重试仅重跑该页 → 恢复成功，整体进度 4/4。
  mock.setFailPages({});
  await page.click('#parse-retry');
  await expect(summary).toHaveText('已解析 4/4', { timeout: 20000 });
  await expect(chips.nth(1)).toHaveAttribute('data-status', 'succeeded');
  await expect(page.locator('#parse-status')).toHaveText('已完成');
  expect(mock.convertCalls()).toBe(callsBefore + 5);
});
