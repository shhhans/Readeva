import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { startService, stopService } from '../helpers/service.js';

const FIXTURE_A = path.resolve('tests/fixtures/sample-a.pdf');

// 未配置 Docling 服务时的降级行为：阅读不受影响，解析明确提示未配置。
test.describe.configure({ mode: 'serial' });

let service;

test.beforeAll(async () => {
  // 不设置 READEVA_DOCLING_URL。
  service = await startService();
});

test.afterAll(async () => {
  await stopService(service);
});

test('未配置解析服务：接口返回 configured=false，解析请求被拒绝', async ({ request }) => {
  const importRes = await request.post(`${service.base}/api/documents/import`, {
    headers: { 'content-type': 'application/pdf', 'x-filename': 'sample-a.pdf' },
    data: fs.readFileSync(FIXTURE_A),
  });
  expect(importRes.status()).toBe(201);
  const { document } = await importRes.json();

  const serviceRes = await request.get(`${service.base}/api/parse/service`);
  expect((await serviceRes.json()).configured).toBe(false);

  const parseRes = await request.post(`${service.base}/api/documents/${document.id}/pages/1/parse`);
  expect(parseRes.status()).toBe(503);
  expect((await parseRes.json()).error).toContain('docling service not configured');

  const statusRes = await request.get(`${service.base}/api/documents/${document.id}/pages/1/parse`);
  expect((await statusRes.json()).status).toBe('idle');

  const resultRes = await request.get(`${service.base}/api/documents/${document.id}/pages/1/parse/result`);
  expect(resultRes.status()).toBe(404);
});

test('未配置解析服务：阅读不受影响，面板提示解析服务未配置', async ({ page }) => {
  await page.goto(`${service.base}/`);
  const row = page.locator('#library-tbody tr', { hasText: 'sample-a.pdf' });
  await row.getByRole('button', { name: '打开' }).click();
  await expect(page.locator('#viewer')).toHaveAttribute('data-page', '1');
  // 一行静态提示；界面无任何进度残留（无整体进度文本、无内联状态条目）。
  await expect(page.locator('#parse-hint')).toBeVisible();
  await expect(page.locator('#parse-hint')).toContainText('解析服务未配置');
  await expect(page.locator('#parse-summary')).toBeHidden();
  await expect(page.locator('#parse-state .parse-entry')).toHaveCount(0);
  await expect(page.locator('#parse-content .parse-block')).toHaveCount(0);
});
