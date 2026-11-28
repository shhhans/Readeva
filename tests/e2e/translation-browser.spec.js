import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { startService, stopService } from '../helpers/service.js';
import { startMockDocling } from '../helpers/mock-docling.js';
import { startMockMinimax } from '../helpers/mock-minimax.js';

const FIXTURE_A = path.resolve('tests/fixtures/sample-a.pdf');
const FIXTURE_B = path.resolve('tests/fixtures/sample-b.pdf');
const TEST_KEY = 'test-key-123';

/**
 * Issue #8 浏览器级用例（mock MiniMax 固定翻译响应 + mock Docling 固定解析）：
 * 内容块翻译入口与译文展示位置、选文翻译（工具条扩展位）、请求中/失败状态可见、
 * 已有译文直接复用（重复请求零调用 + 复用标注）、重开文档恢复、重启服务恢复、
 * 未配置翻译服务的明确失败反馈。
 */
test.describe.configure({ mode: 'serial' });

let service;
let docling;
let minimax;
let docId;

async function openReader(page, id) {
  // 先回书库再进入阅读视图：同 URL 的纯 hash 导航不会重载页面，
  // 无法模拟「重新打开文档」；经书库触发完整 teardown/重建。
  await page.goto(`${service.base}/#/`);
  await page.goto(`${service.base}/#/read/${id}`);
  await expect(page.locator('#parse-content .parse-block').first()).toBeVisible({
    timeout: 15000,
  });
}

/**
 * 选中面板里包含指定文本的整个元素（真实浏览器选区；与查词用例同一手法）。
 */
async function selectPanelText(page, needle) {
  const selected = await page.evaluate((target) => {
    const root = document.querySelector('#parse-content');
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent.includes(target)) continue;
      const range = document.createRange();
      range.selectNodeContents(node.parentElement);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new PointerEvent('pointerup'));
      return true;
    }
    return false;
  }, needle);
  expect(selected, `面板中找不到目标文本: ${needle}`).toBe(true);
  await expect(page.locator('#selection-toolbar')).toBeVisible();
}

test.beforeAll(async () => {
  minimax = await startMockMinimax();
  docling = await startMockDocling({});
  service = await startService({
    env: {
      READEVA_DOCLING_URL: docling.base,
      READEVA_MINIMAX_BASE_URL: `${minimax.base}/v1`,
      MINIMAX_API_KEY: TEST_KEY,
    },
  });
  const res = await fetch(`${service.base}/api/documents/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/pdf', 'x-filename': 'sample-a.pdf' },
    body: fs.readFileSync(FIXTURE_A),
  });
  docId = (await res.json()).document.id;
  // 预解析第 1 页（浏览器内直接取回已完成结果）。
  await fetch(`${service.base}/api/documents/${docId}/pages/1/parse`, { method: 'POST' });
  await expect
    .poll(async () => {
      const r = await fetch(`${service.base}/api/documents/${docId}/pages/1/parse`);
      return (await r.json()).status;
    })
    .toBe('succeeded');
});

test.afterAll(async () => {
  await stopService(service);
  if (docling) await docling.close();
  if (minimax) await minimax.close();
});

test('内容块翻译：请求中状态可见 → 译文显示在对应块旁（标注引擎/目标语言）', async ({ page }) => {
  await openReader(page, docId);
  minimax.setDelay(500);
  const callsBefore = minimax.chatCalls();

  await page.locator('.parse-block[data-block-id="b1"] .block-translate-button').click();
  // 请求中状态可见（loading 徽标 + 翻译中文案）。
  const pending = page.locator(
    '.block-translation[data-source-kind="block"][data-translation-state="loading"]',
  );
  await expect(pending).toBeVisible();
  await expect(pending.locator('.translation-loading')).toContainText('翻译中');

  // 完成：译文紧跟来源块，头部标注来源/目标语言/引擎；无复用标注（本次新翻译）。
  const done = page.locator(
    '.block-translation[data-source-kind="block"][data-translation-state="done"]',
  );
  await expect(done).toBeVisible();
  await expect(done.locator('.translation-text')).toContainText('【译】');
  await expect(done.locator('.translation-source-tag')).toHaveText('内容块');
  await expect(done.locator('.translation-target')).toHaveText('→ 中文');
  await expect(done.locator('.translation-engine')).toHaveText('MiniMax-M3.1-Flash');
  await expect(done).toHaveAttribute('data-reused', 'false');
  await expect(page.locator('.translation-reused')).toHaveCount(0);

  // 位置：译文紧跟 b1 块（显示在对应内容旁）。
  const placed = await page.evaluate(() => {
    const block = document.querySelector('.parse-block[data-block-id="b1"]');
    const translation = document.querySelector(
      '.block-translation[data-source-kind="block"][data-translation-state="done"]',
    );
    return Boolean(block && translation && block.nextElementSibling === translation);
  });
  expect(placed).toBe(true);
  expect(minimax.chatCalls()).toBe(callsBefore + 1);
  minimax.setDelay(0);
});

test('选文翻译：工具条「翻译」→ 译文显示在包含选文的块旁（标注选文来源）', async ({ page }) => {
  await openReader(page, docId);
  await selectPanelText(page, 'The reading position of this document');
  await page.locator('#translate-selection-button').click();

  const done = page.locator(
    '.block-translation[data-source-kind="selection"][data-translation-state="done"]',
  );
  await expect(done).toBeVisible();
  await expect(done.locator('.translation-text')).toContainText('【译】The reading position');
  await expect(done.locator('.translation-source-tag')).toHaveText('选文');
  await expect(done.locator('.translation-target')).toHaveText('→ 中文');
  // 消费选区：工具条不再浮现。
  await expect(page.locator('#selection-toolbar')).toBeHidden();

  // 位置：紧跟包含选文的块 b1（在其块译文之后、b2 之前）。
  const placed = await page.evaluate(() => {
    const block = document.querySelector('.parse-block[data-block-id="b1"]');
    const sel = document.querySelector(
      '.block-translation[data-source-kind="selection"][data-translation-state="done"]',
    );
    if (!block || !sel) return false;
    let node = block.nextElementSibling;
    while (node?.classList.contains('block-translation')) {
      if (node === sel) return true;
      node = node.nextElementSibling;
    }
    return false;
  });
  expect(placed).toBe(true);
});

test('复用：重复点击块翻译按钮直接展示已有译文，翻译服务零调用', async ({ page }) => {
  await openReader(page, docId);
  const callsBefore = minimax.chatCalls();
  await page.locator('.parse-block[data-block-id="b1"] .block-translate-button').click();
  // 不出现 loading，直接是已有译文（done）。
  await expect(
    page.locator('.block-translation[data-source-kind="block"][data-translation-state="loading"]'),
  ).toHaveCount(0);
  await expect(
    page.locator('.block-translation[data-source-kind="block"][data-translation-state="done"]'),
  ).toBeVisible();
  expect(minimax.chatCalls()).toBe(callsBefore);
});

test('重开文档恢复：已保存译文就地恢复并标注「已有译文」，不重新翻译', async ({ page }) => {
  const callsBefore = minimax.chatCalls();
  await openReader(page, docId);

  const done = page.locator(
    '.block-translation[data-source-kind="block"][data-translation-state="done"]',
  );
  await expect(done).toBeVisible();
  await expect(done).toHaveAttribute('data-reused', 'true');
  await expect(done.locator('.translation-reused')).toHaveText('已有译文');
  await expect(done.locator('.translation-text')).toContainText('【译】');
  const selectionDone = page.locator(
    '.block-translation[data-source-kind="selection"][data-translation-state="done"]',
  );
  await expect(selectionDone).toBeVisible();
  await expect(selectionDone).toHaveAttribute('data-reused', 'true');
  // 全程零翻译调用（复用已保存译文）。
  expect(minimax.chatCalls()).toBe(callsBefore);
});

test('译文可折叠：收起/展开', async ({ page }) => {
  await openReader(page, docId);
  const done = page.locator(
    '.block-translation[data-source-kind="block"][data-translation-state="done"]',
  );
  await expect(done).toBeVisible();
  await expect(done.locator('.translation-text')).toBeVisible();
  await done.locator('.translation-toggle').click();
  await expect(done).toHaveClass(/is-collapsed/);
  await expect(done.locator('.translation-text')).toBeHidden();
  await done.locator('.translation-toggle').click();
  await expect(done.locator('.translation-text')).toBeVisible();
});

test('失败状态可见且不写入：重试成功后恢复', async ({ page }) => {
  await openReader(page, docId);
  const callsBefore = minimax.chatCalls();
  // 行为脚本：第一次失败（HTTP 500），第二次成功（验证恢复后重试）。
  minimax.setBehavior([
    { mode: 'failure', httpStatus: 500, message: 'mock upstream down' },
    { mode: 'success' },
  ]);

  await page.locator('.parse-block[data-block-id="b2"] .block-translate-button').click();
  const failed = page.locator(
    '.block-translation[data-block-id="b2"][data-translation-state="error"]',
  );
  await expect(failed).toBeVisible();
  await expect(failed.locator('.translation-error')).toContainText('翻译失败');
  await expect(failed.locator('.translation-error')).toContainText('mock upstream down');
  expect(minimax.chatCalls()).toBe(callsBefore + 1);

  // 失败不写入成功译文：重开文档后 b2 没有任何已保存译文。
  await openReader(page, docId);
  await expect(page.locator('.block-translation[data-block-id="b2"]')).toHaveCount(0);

  // 恢复后重试：失败元素被请求中元素替换，最终成功展示。
  await page.locator('.parse-block[data-block-id="b2"] .block-translate-button').click();
  const done = page.locator('.block-translation[data-block-id="b2"][data-translation-state="done"]');
  await expect(done).toBeVisible();
  await expect(done.locator('.translation-text')).toContainText('【译】');
  expect(minimax.chatCalls()).toBe(callsBefore + 2);
});

test('重启服务后新浏览器会话恢复：译文从服务端取回（自动保存 + 持久保留）', async ({ page }) => {
  const callsBefore = minimax.chatCalls();
  await stopService(service);
  service = await startService({
    env: {
      READEVA_DOCLING_URL: docling.base,
      READEVA_MINIMAX_BASE_URL: `${minimax.base}/v1`,
      MINIMAX_API_KEY: TEST_KEY,
    },
    dataDir: service.dataDir,
    port: Number(service.port),
  });

  await openReader(page, docId);
  const done = page.locator('.block-translation[data-translation-state="done"]');
  await expect(done).toHaveCount(3); // b1 块译文 + 选文译文 + b2 重试译文
  for (const el of await done.all()) {
    await expect(el).toHaveAttribute('data-reused', 'true');
    await expect(el.locator('.translation-reused')).toHaveText('已有译文');
  }
  // 服务端持久保留 + 客户端重开取回：零翻译调用。
  expect(minimax.chatCalls()).toBe(callsBefore);
});

test('未配置翻译服务：点击翻译出现明确失败提示（503 语义）', async ({ page }) => {
  // 独立服务：显式清空 MINIMAX_API_KEY（本机环境可能已设置真实密钥），配 mock Docling。
  const localDocling = await startMockDocling({});
  const localService = await startService({
    env: { READEVA_DOCLING_URL: localDocling.base, MINIMAX_API_KEY: '' },
  });
  try {
    const res = await fetch(`${localService.base}/api/documents/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/pdf', 'x-filename': 'sample-b.pdf' },
      body: fs.readFileSync(FIXTURE_B),
    });
    const localDocId = (await res.json()).document.id;
    await fetch(`${localService.base}/api/documents/${localDocId}/pages/1/parse`, { method: 'POST' });
    await expect
      .poll(async () => {
        const r = await fetch(`${localService.base}/api/documents/${localDocId}/pages/1/parse`);
        return (await r.json()).status;
      })
      .toBe('succeeded');

    await page.goto(`${localService.base}/#/read/${localDocId}`);
    await expect(page.locator('#parse-content .parse-block').first()).toBeVisible({
      timeout: 15000,
    });
    await page.locator('.parse-block[data-block-id="b1"] .block-translate-button').click();
    const failed = page.locator('.block-translation[data-translation-state="error"]');
    await expect(failed).toBeVisible();
    await expect(failed.locator('.translation-error')).toContainText('翻译服务未配置');
    await expect(failed.locator('.translation-error')).toContainText('MINIMAX_API_KEY');
    // 失败不写入。
    const list = await (
      await fetch(`${localService.base}/api/documents/${localDocId}/pages/1/translations`)
    ).json();
    expect(list.translations).toEqual([]);
  } finally {
    await stopService(localService);
    await localDocling.close();
  }
});
