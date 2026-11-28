import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { startService, stopService } from '../helpers/service.js';
import { startMockDocling } from '../helpers/mock-docling.js';

const FIXTURE_B = path.resolve('tests/fixtures/sample-b.pdf');

// 浏览器级用例覆盖 Issue #6 验收 1/2/4 的端到端形态：
// 真实浏览器打开文档 → 关闭浏览器页面 → 独立服务继续运行（运行中的页跨宽限期
// 完成落盘）→ 宽限期到期清除未开始任务 → 重新打开文档（重连）取回已完成成果
// 并按当前阅读位置重新调度未完成页。
// 串行：单个服务进程按顺序流转。
test.describe.configure({ mode: 'serial' });

let mock;
let service;

test.beforeAll(async ({ request }) => {
  // 并发 1 + 拉长单页转换（约 4s/页，跨 1.5s 宽限期继续运行）+ 小宽限期。
  mock = await startMockDocling({ convertDelayMs: 2000 });
  service = await startService({
    env: {
      READEVA_DOCLING_URL: mock.base,
      READEVA_DOCLING_POLL_INTERVAL_MS: '30',
      READEVA_PARSE_CONCURRENCY: '1',
      READEVA_CLIENT_GRACE_MS: '1500',
    },
  });
  const res = await request.post(`${service.base}/api/documents/import`, {
    headers: { 'content-type': 'application/pdf', 'x-filename': 'sample-b.pdf' },
    data: fs.readFileSync(FIXTURE_B),
  });
  expect(res.status()).toBe(201);
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

async function progressSnapshot(request, docId) {
  const res = await request.get(`${service.base}/api/documents/${docId}/parse/progress`);
  return res.json();
}

async function sessionOf(request, docId) {
  const res = await request.get(`${service.base}/api/documents/${docId}/session`);
  return res.json();
}

function docIdOf(page) {
  return new URL(page.url()).hash.split('/').pop();
}

test('浏览器关闭后服务继续运行；宽限期到期清除未开始任务；重连取回成果并重新调度', async ({ page, context, request }) => {
  test.setTimeout(120_000);

  // 打开文档：第 1 页开始解析（并发 1），2-4 排队；关闭浏览器页面。
  await openReader(page, 'sample-b.pdf');
  const docId = docIdOf(page);
  await expect.poll(async () => mock.convertCalls(), { timeout: 15000 }).toBe(1);
  await page.close();

  // 服务独立继续运行：运行中的第 1 页跨宽限期完成并落盘（不取消）。
  // 宽限期到期：尚未开始的任务（2-4）被清除、永不派发。
  await expect.poll(async () => (await sessionOf(request, docId)).expired, { timeout: 15000 }).toBe(true);
  const callsAfterExpiry = mock.convertCalls();
  await new Promise((resolve) => setTimeout(resolve, 2500)); // 越过宽限期 + 处置 sweep
  expect(mock.convertCalls(), '清除后不派发新任务').toBe(callsAfterExpiry);
  await expect
    .poll(async () => (await progressSnapshot(request, docId)).succeeded, { timeout: 30000 })
    .toBe(1);
  const snapshot = await progressSnapshot(request, docId);
  expect(snapshot).toMatchObject({ succeeded: 1, failed: 0, running: 0, queued: 0, idle: 3, total: 4 });
  const before = await (
    await request.get(`${service.base}/api/documents/${docId}/pages/1/parse/result`)
  ).json();

  // 重连（新页面重新打开文档）：取回已完成成果（不重新解析）+ 按当前阅读位置
  // 重新调度未完成页 2-4。
  const page2 = await context.newPage();
  await openReader(page2, 'sample-b.pdf');
  await expect
    .poll(async () => (await progressSnapshot(request, docId)).succeeded, { timeout: 30000 })
    .toBe(4);
  const after = await progressSnapshot(request, docId);
  expect(after).toMatchObject({ succeeded: 4, failed: 0, total: 4 });
  // 全程每页恰好一次转换：1（关闭前）+ 3（重连后）；第 1 页复用零新增。
  expect(mock.convertCalls()).toBe(4);
  const afterResult = await (
    await request.get(`${service.base}/api/documents/${docId}/pages/1/parse/result`)
  ).json();
  expect(afterResult.parse.parseId).toBe(before.parse.parseId);
  expect(afterResult.parse.blocks).toEqual(before.parse.blocks);
  // 阅读视图呈现恢复的成果（第 1 页内容已取回）。
  await expect(page2.locator('#parse-state .parse-entry[data-page-status="succeeded"]')).toBeVisible({
    timeout: 30000,
  });
  await expect(page2.locator('#parse-content .parse-block').first()).toBeVisible();
  await page2.close();
});
