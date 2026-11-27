import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { startService, stopService } from '../helpers/service.js';
import { startMockDocling } from '../helpers/mock-docling.js';

const FIXTURE_A = path.resolve('tests/fixtures/sample-a.pdf');

// 服务级用例覆盖 Issue #5 验收 5 条：优先级、跳页重排、闲置补全、失败隔离与重试。
// 每个用例使用独立的服务进程与 mock：队列是内存态，隔离后顺序断言才确定。
test.describe.configure({ mode: 'serial' });

let mock;
let service;

test.afterEach(async () => {
  if (service) await stopService(service);
  if (mock) await mock.close();
  service = undefined;
  mock = undefined;
});

/** 启动独立服务 + mock Docling（默认高轮询频率与串行并发，保证顺序确定性）。 */
async function setup({ mockOptions = {}, env = {} } = {}) {
  mock = await startMockDocling(mockOptions);
  service = await startService({
    env: {
      READEVA_DOCLING_URL: mock.base,
      READEVA_DOCLING_POLL_INTERVAL_MS: '30',
      READEVA_PARSE_CONCURRENCY: '1',
      ...env,
    },
  });
}

async function importFixtureA(request) {
  const res = await request.post(`${service.base}/api/documents/import`, {
    headers: { 'content-type': 'application/pdf', 'x-filename': 'sample-a.pdf' },
    data: fs.readFileSync(FIXTURE_A),
  });
  expect(res.status()).toBe(201);
  const { document } = await res.json();
  expect(document.pageCount).toBe(8);
  return document;
}

const putReadingPosition = (request, docId, page) =>
  request.put(`${service.base}/api/documents/${docId}/reading-position`, { data: { page } });

async function getProgress(request, docId) {
  const res = await request.get(`${service.base}/api/documents/${docId}/parse/progress`);
  expect(res.status()).toBe(200);
  return res.json();
}

/** mock 记录的真实单页提交顺序（审查靶子 8：断言看实际请求顺序）。 */
const convertSeq = () =>
  mock.requests.filter((r) => r.kind === 'convert').map((r) => r.filename);

const waitFor = (fn, timeout = 20000) =>
  expect.poll(fn, { timeout, intervals: [100, 200, 500] });

test('阅读位置更新：当前页立即解析，后续页优先排队，前置页降级', async ({ request }) => {
  await setup();
  const doc = await importFixtureA(request);

  const put = await putReadingPosition(request, doc.id, 3);
  expect(put.status()).toBe(200);
  const { scheduled, progress } = await put.json();
  expect(scheduled).toBe(true);

  // 第 3 页（当前页）立即开始；4-8（后续页）按阅读顺序排队；1-2（前置页）降级到队尾。
  expect(progress).toMatchObject({ total: 8, succeeded: 0, failed: 0, completed: 0 });
  expect(progress.pages[2]).toMatchObject({ page: 3, status: 'running' });
  expect(progress.pages.slice(3).map((p) => p.status)).toEqual([
    'queued', 'queued', 'queued', 'queued', 'queued',
  ]);
  expect(progress.pages.slice(3).map((p) => p.page)).toEqual([4, 5, 6, 7, 8]);
  expect(progress.pages.slice(3).map((p) => p.queuePosition)).toEqual([0, 1, 2, 3, 4]);
  expect(progress.pages.slice(0, 2).map((p) => p.status)).toEqual(['queued', 'queued']);
  expect(progress.pages.slice(0, 2).map((p) => p.queuePosition)).toEqual([5, 6]);

  // mock 实际提交顺序：当前页 → 后续页（3 → 4 → 5），降级的前置页尚未开始。
  await waitFor(() => convertSeq().length).toBeGreaterThanOrEqual(3);
  expect(convertSeq().slice(0, 3)).toEqual(['page-3.pdf', 'page-4.pdf', 'page-5.pdf']);
  const later = await getProgress(request, doc.id);
  expect(later.pages.slice(0, 2).map((p) => p.status)).toEqual(['queued', 'queued']);
  expect(convertSeq().filter((f) => f === 'page-1.pdf' || f === 'page-2.pdf')).toEqual([]);
});

test('跳页后重排未开始任务：新位置及其后续优先，其余降级到队尾', async ({ request }) => {
  await setup();
  const doc = await importFixtureA(request);

  await putReadingPosition(request, doc.id, 2); // 第 2 页开始，队列 [3..8, 1]
  // 跳到第 6 页：未开始任务重排为 [6,7,8,1,3,4,5]（第 2 页已在运行，不动）。
  const put = await putReadingPosition(request, doc.id, 6);
  expect(put.status()).toBe(200);
  const { progress } = await put.json();
  // pages 数组按页码序返回；队列顺序按 queuePosition 排序后断言。
  const queuedPages = progress.pages
    .filter((p) => p.status === 'queued')
    .sort((a, b) => a.queuePosition - b.queuePosition)
    .map((p) => p.page);
  expect(queuedPages).toEqual([6, 7, 8, 1, 3, 4, 5]);
  expect(progress.pages.find((p) => p.page === 2).status).toBe('running');

  await waitFor(() => convertSeq().length).toBe(8);
  expect(convertSeq()).toEqual([
    'page-2.pdf',
    'page-6.pdf',
    'page-7.pdf',
    'page-8.pdf',
    'page-1.pdf',
    'page-3.pdf',
    'page-4.pdf',
    'page-5.pdf',
  ]);
});

test('闲置补全：剩余未解析页全部解析，已完成页直接复用不重新解析', async ({ request }) => {
  await setup();
  const doc = await importFixtureA(request);

  await putReadingPosition(request, doc.id, 1);
  // 后台补全整本：无需其他任何请求，全部页解析完成。
  await waitFor(async () => (await getProgress(request, doc.id)).succeeded).toBe(8);
  const snap = await getProgress(request, doc.id);
  expect(snap).toMatchObject({
    succeeded: 8,
    failed: 0,
    running: 0,
    queued: 0,
    idle: 0,
    completed: 8,
    total: 8,
  });
  for (const page of snap.pages) {
    expect(page.parseId).toMatch(/^[0-9a-f]{64}$/);
  }

  // 已完成页复用：POST 解析请求返回 reused:true，且解析服务零新增转换。
  const before = mock.convertCalls();
  const res = await request.post(`${service.base}/api/documents/${doc.id}/pages/5/parse`);
  expect(res.status()).toBe(200);
  expect(await res.json()).toMatchObject({ page: 5, status: 'succeeded', reused: true });
  expect(mock.convertCalls()).toBe(before);
});

test('失败页不阻塞队列：其他页继续处理，失败原因可查询，不自动重试', async ({ request }) => {
  await setup({ mockOptions: { failPages: { 4: 'mock page 4 conversion failed' } } });
  const doc = await importFixtureA(request);

  await putReadingPosition(request, doc.id, 1);
  await waitFor(async () => (await getProgress(request, doc.id)).completed).toBe(8);
  const snap = await getProgress(request, doc.id);
  expect(snap.succeeded).toBe(7);
  expect(snap.failed).toBe(1);

  // 失败页：状态 failed 且带原因；无结果可取回。
  const failed = snap.pages.find((p) => p.page === 4);
  expect(failed).toMatchObject({ page: 4, status: 'failed' });
  expect(failed.error).toContain('mock page 4 conversion failed');
  const result = await request.get(`${service.base}/api/documents/${doc.id}/pages/4/parse/result`);
  expect(result.status()).toBe(404);

  // 失败之后的页继续完成（失败不阻塞），失败页不自动重试。
  expect(snap.pages.filter((p) => p.page > 4).every((p) => p.status === 'succeeded')).toBe(true);
  const calls = mock.convertCalls();
  expect(calls).toBe(8); // 7 成功 + 1 失败，恰好每页一次
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(mock.convertCalls()).toBe(calls);

  // 单页状态端点同样可见失败原因。
  const status = await (
    await request.get(`${service.base}/api/documents/${doc.id}/pages/4/parse`)
  ).json();
  expect(status).toMatchObject({ page: 4, status: 'failed' });
  expect(status.error).toContain('mock page 4 conversion failed');
});

test('失败页显式重试：仅重跑该页，成功后替换失败记录', async ({ request }) => {
  await setup({ mockOptions: { failPages: { 4: 'mock page 4 conversion failed' } } });
  const doc = await importFixtureA(request);

  await putReadingPosition(request, doc.id, 1);
  await waitFor(async () => (await getProgress(request, doc.id)).completed).toBe(8);
  expect(mock.convertCalls()).toBe(8);

  // 解除失败注入后显式重试：请求被接受并立即开始（队列已空、并发空闲）。
  mock.setFailPages({});
  const retry = await request.post(`${service.base}/api/documents/${doc.id}/pages/4/parse`);
  expect(retry.status()).toBe(202);
  expect(await retry.json()).toMatchObject({ page: 4, status: 'running' });

  await waitFor(async () => (await getProgress(request, doc.id)).pages[3].status).toBe('succeeded');
  const snap = await getProgress(request, doc.id);
  expect(snap.succeeded).toBe(8);
  expect(snap.failed).toBe(0);
  // 只新增第 4 页那一次转换：其他页结果不受影响。
  expect(mock.convertCalls()).toBe(9);
  const result = await (
    await request.get(`${service.base}/api/documents/${doc.id}/pages/4/parse/result`)
  ).json();
  expect(result.parse.parseId).toMatch(/^[0-9a-f]{64}$/);
});

test('显式解析请求优先于队列：并发占满时排队且置于队首', async ({ request }) => {
  // 拉长单页解析耗时，保证显式请求落在第 1 页解析期间（并发 1 已占满）。
  await setup({ env: { READEVA_DOCLING_POLL_INTERVAL_MS: '200' } });
  const doc = await importFixtureA(request);

  await putReadingPosition(request, doc.id, 1); // 第 1 页运行中，2-8 排队
  const post = await request.post(`${service.base}/api/documents/${doc.id}/pages/5/parse`);
  expect(post.status()).toBe(202);
  expect(await post.json()).toMatchObject({ page: 5, status: 'queued' });

  const snap = await getProgress(request, doc.id);
  expect(snap.pages.find((p) => p.page === 5)).toMatchObject({ status: 'queued', queuePosition: 0 });

  await waitFor(() => convertSeq().length).toBe(8);
  // 第 1 页完成后立即解析第 5 页（显式请求插队），随后按队列顺序补全。
  expect(convertSeq().slice(0, 4)).toEqual(['page-1.pdf', 'page-5.pdf', 'page-2.pdf', 'page-3.pdf']);
});

test('单页解析请求不触发整本调度（Issue #3 行为保持）', async ({ request }) => {
  await setup();
  const doc = await importFixtureA(request);

  const start = await request.post(`${service.base}/api/documents/${doc.id}/pages/3/parse`);
  expect(start.status()).toBe(202);
  expect(await start.json()).toMatchObject({ page: 3, status: 'running' });

  await waitFor(async () => (await getProgress(request, doc.id)).pages[2].status).toBe('succeeded');
  // 整本调度仅由阅读位置更新触发：其余页保持未开始，解析服务零新增请求。
  await new Promise((resolve) => setTimeout(resolve, 600));
  const snap = await getProgress(request, doc.id);
  expect(snap.succeeded).toBe(1);
  expect(snap.pages.filter((p) => p.status === 'idle').length).toBe(7);
  expect(mock.convertCalls()).toBe(1);
});

test('进度快照基于持久化记录：重启服务后进度不丢、已完成页不重新解析', async ({ request }) => {
  await setup();
  const doc = await importFixtureA(request);

  await putReadingPosition(request, doc.id, 1);
  await waitFor(async () => (await getProgress(request, doc.id)).succeeded).toBe(8);
  const before = await getProgress(request, doc.id);

  // 真实重启服务（同数据目录）：内存队列清空，进度从落盘记录恢复。
  const { dataDir, port } = service;
  await stopService(service);
  service = await startService({
    dataDir,
    port: Number(port),
    env: {
      READEVA_DOCLING_URL: mock.base,
      READEVA_DOCLING_POLL_INTERVAL_MS: '30',
      READEVA_PARSE_CONCURRENCY: '1',
    },
  });

  const after = await getProgress(request, doc.id);
  expect(after.succeeded).toBe(8);
  expect(after.pages).toEqual(before.pages);
  // 重启后上报阅读位置：全部页已有结果，队列保持空，解析服务零新增转换。
  const put = await putReadingPosition(request, doc.id, 6);
  expect((await put.json()).progress.succeeded).toBe(8);
  expect(mock.convertCalls()).toBe(8);
});

test('阅读位置与进度接口的参数校验与降级', async ({ request }) => {
  await setup();
  const doc = await importFixtureA(request);

  for (const page of [0, 9, 1.5, 'abc']) {
    const res = await putReadingPosition(request, doc.id, page);
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toBeTruthy();
  }
  const missing = await request.put(
    `${service.base}/api/documents/${'0'.repeat(64)}/reading-position`,
    { data: { page: 1 } },
  );
  expect(missing.status()).toBe(404);
  const missingProgress = await request.get(
    `${service.base}/api/documents/${'0'.repeat(64)}/parse/progress`,
  );
  expect(missingProgress.status()).toBe(404);
});

test('未配置解析服务：阅读位置更新降级不调度，进度接口仍可用', async ({ request }) => {
  // 不设置 READEVA_DOCLING_URL。
  service = await startService();
  const doc = await importFixtureA(request);

  const put = await putReadingPosition(request, doc.id, 2);
  expect(put.status()).toBe(200);
  expect(await put.json()).toMatchObject({ documentId: doc.id, page: 2, scheduled: false });

  const snap = await getProgress(request, doc.id);
  expect(snap.total).toBe(8);
  expect(snap.idle).toBe(8);
  expect(snap.succeeded).toBe(0);
});
