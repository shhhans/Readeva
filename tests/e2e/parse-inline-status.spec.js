import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { startService, stopService } from '../helpers/service.js';
import { startMockDocling } from '../helpers/mock-docling.js';

const FIXTURE_A = path.resolve('tests/fixtures/sample-a.pdf');
const FIXTURE_B = path.resolve('tests/fixtures/sample-b.pdf');

// 浏览器级用例覆盖 PR #15 收敛轮（完全移除进度区）后的验收契约：
// - 单页解析状态、失败原因、显式重试改为内容列表内联呈现；
// - 整体进度为面板头部一处静态文本：事件（派发/完成/失败/重试）时更新，
//   阅读视图打开期间另以固定 8s 间隔慢刷新（不做秒级轮询重建）；
// - 进度区（页码芯片）彻底移除；未配置解析服务时界面无任何进度残留。
// 串行：同一服务进程上按顺序验证内联状态 → 失败重试 → 事件式更新 + 慢刷新 → 自愈。
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

/** 整本进度快照（服务端为准）：用于等待后台补全结束等断言。 */
async function progressSnapshot(request, docId) {
  const res = await request.get(`${service.base}/api/documents/${docId}/parse/progress`);
  return res.json();
}

/** 当前文档 id（阅读视图 URL 末段）。 */
function docIdOf(page) {
  return new URL(page.url()).hash.split('/').pop();
}

test('单页状态内联在内容列表：进行中带状态标记，完成后展示内容块', async ({ page, request }) => {
  // 放慢转换，确保能观察到「进行中」的内联状态标记。
  mock.setConvertDelay(500);
  const callsBefore = mock.convertCalls();
  try {
    await openReader(page, 'sample-a.pdf');

    const entry = page.locator('#parse-state .parse-entry');
    await expect(entry).toHaveAttribute('data-page-status', /queued|running/);
    await expect(entry.locator('.parse-entry-badge')).toHaveText(/排队中|解析中/);
    await expect(entry).toContainText('第 1 页');

    // 进度区彻底移除：没有独立进度容器，也没有页码芯片。
    await expect(page.locator('#parse-progress')).toHaveCount(0);
    await expect(page.locator('#parse-progress-pages')).toHaveCount(0);
    await expect(page.locator('.parse-page-chip')).toHaveCount(0);

    // 完成后：状态条目为「已完成」，内容块按阅读顺序展示。
    await expect(
      page.locator('#parse-state .parse-entry[data-page-status="succeeded"]'),
    ).toBeVisible({ timeout: 30000 });
    await expect(page.locator('#parse-state .parse-entry-badge')).toHaveText('已完成');
    await expect(page.locator('#parse-content h3')).toHaveText(
      'Sample A · Inflight Service Manual (fixture)',
    );
    await expect(page.locator('#parse-content .parse-block').first()).toBeVisible();

    // 后台补全完成：整本恰好每页一次转换（无重复解析）。
    const docId = docIdOf(page);
    await expect
      .poll(async () => (await progressSnapshot(request, docId)).succeeded, { timeout: 30000 })
      .toBe(8);
    expect(mock.convertCalls() - callsBefore).toBe(8);
  } finally {
    mock.setConvertDelay(0);
  }
});

test('失败原因与显式重试内联呈现：条目带状态徽标与重试按钮，重试后恢复', async ({ page }) => {
  // 第 2 页固定失败：失败不阻塞其他页的后台补全。
  mock.setFailPages({ 2: 'mock page 2 conversion failed' });
  try {
    await openReader(page, 'sample-b.pdf');
    await page.fill('#page-input', '2');
    await page.press('#page-input', 'Enter');
    await expect(page.locator('#viewer')).toHaveAttribute('data-page', '2');

    // 失败条目内联在内容列表顶部：徽标 + 失败原因 + 显式重试按钮。
    const failed = page.locator('#parse-state .parse-entry[data-page-status="failed"]');
    await expect(failed).toBeVisible({ timeout: 30000 });
    await expect(failed.locator('.parse-entry-badge')).toHaveText('解析失败');
    await expect(failed).toContainText('mock page 2 conversion failed');
    await expect(failed.locator('.parse-entry-retry')).toBeVisible();

    // 整体进度静态文本含失败计数（事件更新，非轮询）。
    await expect(page.locator('#parse-summary')).toContainText('失败 1');

    // 解除失败注入 → 点击内联重试 → 该页恢复成功并展示内容块。
    mock.setFailPages({});
    await failed.locator('.parse-entry-retry').click();
    await expect(
      page.locator('#parse-state .parse-entry[data-page-status="succeeded"]'),
    ).toBeVisible({ timeout: 30000 });
    await expect(page.locator('#parse-content .parse-block').first()).toBeVisible();
  } finally {
    mock.setFailPages({});
  }
});

test('整体进度为头部静态文本：事件更新 + 阅读期间慢刷新（无秒级轮询）', async ({ page, request }) => {
  // 本用例含两段定时等待（慢刷新间隔断言 + 离开阅读视图后停止），放宽用例超时。
  test.setTimeout(120_000);
  const progressCalls = [];
  page.on('request', (req) => {
    if (req.url().includes('/parse/progress')) progressCalls.push(Date.now());
  });

  await openReader(page, 'sample-a.pdf');
  const summary = page.locator('#parse-summary');
  await expect(summary).toBeVisible();
  await expect(summary).toHaveText(/^解析 \d+\/8/);

  // 进度区彻底移除（只剩内容列表 + 头部一处静态文本）。
  await expect(page.locator('#parse-progress')).toHaveCount(0);
  await expect(page.locator('.parse-page-chip')).toHaveCount(0);

  // 后台补全完成（服务端快照为准）。
  const docId = docIdOf(page);
  await expect
    .poll(async () => (await progressSnapshot(request, docId)).succeeded, { timeout: 30000 })
    .toBe(8);

  // 事件（翻页）触发一次刷新：静态文本更新为真实计数。
  const before = progressCalls.length;
  const callsBefore = mock.convertCalls();
  await page.fill('#page-input', '2');
  await page.press('#page-input', 'Enter');
  await expect(page.locator('#viewer')).toHaveAttribute('data-page', '2');
  await expect(summary).toHaveText('解析 8/8', { timeout: 15000 });
  expect(progressCalls.length).toBeGreaterThan(before);
  // 已完成页直接复用：翻到已解析页不触发新的转换。
  expect(mock.convertCalls()).toBe(callsBefore);

  // 慢刷新：阅读视图打开期间按固定间隔（8s）取一次整本快照。
  // 锚点 = 最近一次整本快照请求的时刻（此刻起进入空闲期）。
  const anchorAt = progressCalls[progressCalls.length - 1];
  expect(anchorAt).toBeGreaterThan(0);

  await page.waitForTimeout(12_000);
  const idleCalls = progressCalls.filter((t) => t > anchorAt && t <= anchorAt + 12_000);

  // 空闲 3s 内没有整本进度请求：慢刷新间隔 8s，既不秒级轮询也不紧接事件重复取数。
  expect(idleCalls.filter((t) => t <= anchorAt + 3_000).length).toBe(0);
  // 空闲 12s 内恰一次慢刷新，且间隔落在 5–10s（常量 8s）。
  expect(idleCalls.length).toBe(1);
  const gap = idleCalls[0] - anchorAt;
  expect(gap).toBeGreaterThanOrEqual(5_000);
  expect(gap).toBeLessThanOrEqual(10_000);

  // 离开阅读视图：慢刷新立即停止（不再取整本快照，定时器不泄漏）。
  await page.click('#back-button');
  await expect(page.locator('#view-library')).toBeVisible();
  const afterLeave = progressCalls.length;
  await page.waitForTimeout(9_500);
  expect(progressCalls.length).toBe(afterLeave);
});

test('事件驱动自愈：队列丢失且仍有未开始页时自动重报阅读位置恢复调度', async ({ page, request }) => {
  // 当前页（第 2 页）固定失败：面板给出内联失败条目与重试按钮。
  mock.setFailPages({ 2: 'mock page 2 conversion failed' });
  try {
    await openReader(page, 'sample-b.pdf');
    const docId = docIdOf(page);
    const parseDir = path.join(service.dataDir, 'parses', docId);

    // 归位到第 1 页：避免上轮保存的阅读位置影响本用例的调度前提。
    await page.fill('#page-input', '1');
    await page.press('#page-input', 'Enter');
    await expect(page.locator('#viewer')).toHaveAttribute('data-page', '1');

    // 删除第 2 页落盘记录：模拟「队列丢失 + 记录缺失」——该页回到未开始，
    // 翻到该页时重新入队并失败（注入），面板给出内联失败条目。
    fs.rmSync(path.join(parseDir, 'page-2.json'));
    await page.fill('#page-input', '2');
    await page.press('#page-input', 'Enter');
    await expect(page.locator('#viewer')).toHaveAttribute('data-page', '2');
    const failed = page.locator('#parse-state .parse-entry[data-page-status="failed"]');
    await expect(failed).toBeVisible({ timeout: 30000 });

    // 再删除第 4 页落盘记录：整本队列已空（无 queued/running）但仍有未开始页。
    fs.rmSync(path.join(parseDir, 'page-4.json'));
    const before = mock.convertCalls();

    // 显式重试（= 派发事件）→ 该页再次失败 → 失败事件刷新整体进度快照
    // → 发现「无 queued/running 且仍有未开始页」→ 自动重报阅读位置恢复调度
    // → 第 4 页重新入队解析。
    await failed.locator('.parse-entry-retry').click();
    await expect
      .poll(async () => (await progressSnapshot(request, docId)).succeeded, { timeout: 30000 })
      .toBe(3);
    // 转换次数：第 2 页重试 1 次 + 第 4 页自愈重跑 1 次。
    expect(mock.convertCalls()).toBe(before + 2);
  } finally {
    mock.setFailPages({});
  }
});
