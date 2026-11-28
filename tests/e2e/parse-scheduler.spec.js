import { expect, test } from '@playwright/test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
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
  expect(progress).toMatchObject({ total: 8, succeeded: 0, failed: 0 });
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
  await waitFor(async () => {
    const s = await getProgress(request, doc.id);
    return s.succeeded + s.failed;
  }).toBe(8);
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
  await waitFor(async () => {
    const s = await getProgress(request, doc.id);
    return s.succeeded + s.failed;
  }).toBe(8);
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

test('显式请求置顶不被随后的阅读位置重排降级（pinned）', async ({ request }) => {
  await setup();
  const doc = await importFixtureA(request);

  await putReadingPosition(request, doc.id, 1); // 第 1 页运行中，队列 [2..8]
  const post = await request.post(`${service.base}/api/documents/${doc.id}/pages/5/parse`);
  expect(post.status()).toBe(202); // 置顶：并发占满 → 排队且置于队首

  // 翻到第 8 页触发重排：置顶的第 5 页仍在队首，其余按 8 → 后续 → 前置排序。
  const put = await putReadingPosition(request, doc.id, 8);
  expect(put.status()).toBe(200);
  const queuedPages = (await put.json()).progress.pages
    .filter((p) => p.status === 'queued')
    .sort((a, b) => a.queuePosition - b.queuePosition)
    .map((p) => p.page);
  expect(queuedPages).toEqual([5, 8, 2, 3, 4, 6, 7]);

  await waitFor(() => convertSeq().length).toBe(8);
  // 第 1 页完成后：先解析置顶的第 5 页，再按新阅读顺序补全。
  expect(convertSeq()).toEqual([
    'page-1.pdf',
    'page-5.pdf',
    'page-8.pdf',
    'page-2.pdf',
    'page-3.pdf',
    'page-4.pdf',
    'page-6.pdf',
    'page-7.pdf',
  ]);
});

test('并发 2：两页同时转换（并行 in-flight），其余排队', async ({ request }) => {
  await setup({ mockOptions: { convertDelayMs: 250 }, env: { READEVA_PARSE_CONCURRENCY: '2' } });
  const doc = await importFixtureA(request);

  const put = await putReadingPosition(request, doc.id, 1);
  const progress = (await put.json()).progress;
  // 并发 2：第 1、2 页同时进入 running（两个转换并行 in-flight），其余排队。
  expect(progress.pages[0]).toMatchObject({ page: 1, status: 'running' });
  expect(progress.pages[1]).toMatchObject({ page: 2, status: 'running' });
  expect(progress.running).toBe(2);
  expect(progress.pages.slice(2).every((p) => p.status === 'queued')).toBe(true);
  expect(progress.pages.slice(2).map((p) => p.page)).toEqual([3, 4, 5, 6, 7, 8]);

  await waitFor(async () => (await getProgress(request, doc.id)).succeeded).toBe(8);
  // 并行不重复解析：每页恰好一次转换。
  expect(mock.convertCalls()).toBe(8);
});

test('并发 2 跳页插队：任一槽释放即开始，排在阅读顺序之前', async ({ request }) => {
  await setup({ mockOptions: { convertDelayMs: 250 }, env: { READEVA_PARSE_CONCURRENCY: '2' } });
  const doc = await importFixtureA(request);

  await putReadingPosition(request, doc.id, 1); // p1、p2 占满两槽，[3..8] 排队
  // 跳到第 6 页：置顶队首，任一槽释放即开始（staggered，不预留空槽）。
  const put = await putReadingPosition(request, doc.id, 6);
  const queuedPages = (await put.json()).progress.pages
    .filter((p) => p.status === 'queued')
    .sort((a, b) => a.queuePosition - b.queuePosition)
    .map((p) => p.page);
  expect(queuedPages).toEqual([6, 7, 8, 3, 4, 5]);

  await waitFor(() => convertSeq().length).toBe(8);
  const seq = convertSeq();
  // 前两个转换是占槽的 p1/p2（并发 2 下两个提交的 mock 到达顺序可能交错，只断集合）。
  expect(seq.slice(0, 2).sort()).toEqual(['page-1.pdf', 'page-2.pdf']);
  // 插队语义：第 6 页先于被降级的 3/4/5（7/8 与 6 同批并行派发，到达顺序不新 assert）。
  const i6 = seq.indexOf('page-6.pdf');
  expect(i6).toBeGreaterThan(1);
  for (const later of ['page-3.pdf', 'page-4.pdf', 'page-5.pdf']) {
    expect(seq.indexOf(later), `page-6 应先于 ${later}`).toBeGreaterThan(i6);
  }
});

test('并发上限钐制：非法值回落 1，更高配置生效', async ({ request }) => {
  for (const concurrency of ['0', 'abc']) {
    await setup({ env: { READEVA_PARSE_CONCURRENCY: concurrency } });
    const doc = await importFixtureA(request);
    const progress = (await (await putReadingPosition(request, doc.id, 1)).json()).progress;
    expect(progress.running).toBe(1);
    expect(progress.pages[0].status).toBe('running');
    expect(progress.pages[1].status).toBe('queued');
    await stopService(service);
    await mock.close();
    service = undefined;
    mock = undefined;
  }

  // 更高配置生效：并发 3 → 三页同时 running。
  await setup({ env: { READEVA_PARSE_CONCURRENCY: '3' } });
  const doc = await importFixtureA(request);
  const progress = (await (await putReadingPosition(request, doc.id, 1)).json()).progress;
  expect(progress.running).toBe(3);
  expect(progress.pages.slice(0, 3).every((p) => p.status === 'running')).toBe(true);
});

test('扫全节流 READEVA_PARSE_SWEEP_DELAY_MS：背景派发间隔生效，显式请求不受限', async ({ request }) => {
  // convertDelayMs 拉长转换窗口，确保轮询能观察到 p2 的 running 状态。
  await setup({ mockOptions: { convertDelayMs: 300 }, env: { READEVA_PARSE_CONCURRENCY: '2', READEVA_PARSE_SWEEP_DELAY_MS: '400' } });
  const doc = await importFixtureA(request);

  // 首个派发不受节流影响（立即开始）；第二个背景派发被节流，任务留在队首。
  let progress = (await (await putReadingPosition(request, doc.id, 1)).json()).progress;
  expect(progress.pages[0]).toMatchObject({ page: 1, status: 'running' });
  expect(progress.pages[1]).toMatchObject({ page: 2, status: 'queued' });
  expect(progress.running).toBe(1);

  // 显式请求不受节流限制：立即占用空闲槽。
  const post = await request.post(`${service.base}/api/documents/${doc.id}/pages/7/parse`);
  expect(post.status()).toBe(202);
  progress = await getProgress(request, doc.id);
  expect(progress.pages.find((p) => p.page === 7).status).toBe('running');

  // 节流计时器到点后，第 2 页恢复派发。
  await waitFor(async () => (await getProgress(request, doc.id)).pages[1].status).toBe('running');
});

test('B1 规模回归：进度/重排接口走轻量状态索引，不逐轮全量读盘（210 页 × ~600KB 记录）', async ({ request }) => {
  await setup();
  // 生成 210 页 PDF 并导入。
  const pdf = await PDFDocument.create();
  for (let i = 0; i < 210; i += 1) pdf.addPage([595, 842]);
  const importRes = await request.post(`${service.base}/api/documents/import`, {
    headers: { 'content-type': 'application/pdf', 'x-filename': 'big-book.pdf' },
    data: Buffer.from(await pdf.save()),
  });
  expect(importRes.status()).toBe(201);
  const { document: doc } = await importRes.json();
  expect(doc.pageCount).toBe(210);

  // 直接落盘 210 条 ~600KB 的成功记录（含 base64 图片资源，等价真实单页记录体积）。
  const docDir = path.join(service.dataDir, 'parses', doc.id);
  fs.mkdirSync(docDir, { recursive: true });
  const filler = 'A'.repeat(600_000);
  for (let page = 1; page <= 210; page += 1) {
    const record = {
      schemaVersion: 1,
      documentId: doc.id,
      page,
      status: 'succeeded',
      parseId: crypto.createHash('sha256').update(`page-${page}`).digest('hex'),
      blocks: [
        { id: 'b0', order: 0, kind: 'paragraph', text: `page ${page} filler` },
        {
          id: 'b1',
          order: 1,
          kind: 'image',
          bbox: null,
          image: { uri: `data:image/png;base64,${filler}`, mimeType: 'image/png' },
        },
      ],
      meta: {
        engine: 'docling',
        requestedAt: null,
        completedAt: null,
        errors: [],
        pageContentSha256: filler.slice(0, 64),
      },
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(docDir, `page-${page}.json`), JSON.stringify(record));
  }

  // 预热：首次调用建立轻量状态索引（一次性成本，不设阈值）。
  const warm = await getProgress(request, doc.id);
  expect(warm.succeeded).toBe(210);
  expect(warm.pages.every((p) => p.status === 'succeeded')).toBe(true);

  // 稳态断言：连续调用命中轻量索引（每轮仅 stat），退回全量读盘会退化到数百 ms/轮。
  const timings = [];
  for (let i = 0; i < 3; i += 1) {
    const t0 = Date.now();
    const snap = await getProgress(request, doc.id);
    timings.push(Date.now() - t0);
    expect(snap.succeeded).toBe(210);
    expect(snap.pages).toHaveLength(210);
  }
  for (const ms of timings) {
    expect(ms, `progress latency ${timings.join(',')}ms`).toBeLessThan(250);
  }

  // 阅读位置重排同样走轻量索引（全部页已有记录 → 队列为空，不触发解析）。
  const t0 = Date.now();
  const put = await putReadingPosition(request, doc.id, 105);
  const putMs = Date.now() - t0;
  expect(put.status()).toBe(200);
  expect((await put.json()).progress.queued).toBe(0);
  expect(putMs).toBeLessThan(250);
  expect(mock.convertCalls()).toBe(0);
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
