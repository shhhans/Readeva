import { expect, test } from '@playwright/test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { startService, stopService } from '../helpers/service.js';
import { startMockDocling } from '../helpers/mock-docling.js';

const FIXTURE_A = path.resolve('tests/fixtures/sample-a.pdf');
const FIXTURE_B = path.resolve('tests/fixtures/sample-b.pdf');

// 服务级用例覆盖 Issue #6 验收 5 条：浏览器关闭服务继续运行、宽限期到期处置
// （运行中页完成 + 未开始任务清除）、短暂断线宽限内回来不中断、重连取回成果并
// 按阅读位置重新调度、幂等；另覆盖跨文档取任务轮转、状态索引与缓存清理。
// 每个用例独立服务进程与 mock（队列是内存态，隔离后断言才确定）。
test.describe.configure({ mode: 'serial' });

let mock;
let service;

test.afterEach(async () => {
  if (service) await stopService(service);
  if (mock) await mock.close();
  service = undefined;
  mock = undefined;
});

/** 启动独立服务 + mock Docling（串行并发 + 高轮询频率，保证顺序确定性）。 */
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

async function importFixture(file, name, request) {
  const res = await request.post(`${service.base}/api/documents/import`, {
    headers: { 'content-type': 'application/pdf', 'x-filename': name },
    data: fs.readFileSync(file),
  });
  expect(res.status()).toBe(201);
  const { document } = await res.json();
  return document;
}

const putReadingPosition = (request, docId, page) =>
  request.put(`${service.base}/api/documents/${docId}/reading-position`, { data: { page } });

async function getProgress(request, docId) {
  const res = await request.get(`${service.base}/api/documents/${docId}/parse/progress`);
  expect(res.status()).toBe(200);
  return res.json();
}

/** 会话状态（只读观察端点，不刷新 lastSeen）。 */
async function getSession(request, docId) {
  const res = await request.get(`${service.base}/api/documents/${docId}/session`);
  expect(res.status()).toBe(200);
  return res.json();
}

/** mock 记录的真实单页提交顺序（审查靶子：断言看实际请求顺序）。 */
const convertSeq = () =>
  mock.requests.filter((r) => r.kind === 'convert').map((r) => r.filename);

const waitFor = (fn, timeout = 20000) =>
  expect.poll(fn, { timeout, intervals: [100, 200, 500] });

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('验收 1：浏览器关闭后独立本地服务继续运行（最后一次客户端请求后队列照常推进）', async ({ request }) => {
  // 默认宽限期（60s）在用例时长内不会到期：聚焦「无客户端请求时服务独立推进队列」。
  await setup({ mockOptions: { convertDelayMs: 150 } });
  const doc = await importFixture(FIXTURE_A, 'sample-a.pdf', request);

  await putReadingPosition(request, doc.id, 1);
  // 此后不再向服务发送任何请求：仅观察 mock（进程内）记录的服务自主派发。
  await waitFor(() => convertSeq().length).toBe(8);
  // 服务继续把全部 8 页解析完（浏览器已「关闭」——无任何客户端活动）。
  expect(mock.convertCalls()).toBe(8);
  // 最后一页仍在转换中：等服务自主完成落盘（默认宽限期 60s，用例时长内不会到期）。
  await waitFor(async () => (await getProgress(request, doc.id)).succeeded).toBe(8);

  // 最终状态由服务落盘：全部页 succeeded。
  const snap = await getProgress(request, doc.id);
  expect(snap.succeeded).toBe(8);
  expect(snap.failed).toBe(0);
});

test('验收 2：宽限期到期——运行中的页继续跑完并持久保存，尚未开始的任务清除（不派发），幂等', async ({ request }) => {
  // 拉长单页转换耗时（约 1s/页），使「运行中页」跨宽限期（800ms）继续运行。
  await setup({ mockOptions: { convertDelayMs: 500 }, env: { READEVA_CLIENT_GRACE_MS: '800' } });
  const doc = await importFixture(FIXTURE_A, 'sample-a.pdf', request);

  await putReadingPosition(request, doc.id, 1); // p1 开始运行，2-8 排队
  await waitFor(() => convertSeq().length).toBe(1);

  // 宽限期到期（只观察只读 session 端点，避免轮询进度刷新 lastSeen）。
  await waitFor(async () => (await getSession(request, doc.id)).expired).toBe(true);
  // 等待周期性处置 sweep 真正执行（≤ grace + 250ms），期间不发送任何请求。
  await delay(700);

  // 运行中的第 1 页继续跑完并落盘；尚未开始的 2-8 被清除：永不派发。
  await waitFor(async () => (await getProgress(request, doc.id)).succeeded).toBe(1);
  const after = await getProgress(request, doc.id);
  expect(after).toMatchObject({ succeeded: 1, failed: 0, running: 0, queued: 0, idle: 7, total: 8 });
  // 已开始页完成：有可取回的成果。
  const result = await (
    await request.get(`${service.base}/api/documents/${doc.id}/pages/1/parse/result`)
  ).json();
  expect(result.parse.parseId).toMatch(/^[0-9a-f]{64}$/);
  // 未开始任务零派发（整个处置周期只有第 1 页那一次转换）。
  expect(mock.convertCalls()).toBe(1);

  // 幂等：再次越过宽限期（多次到期）不误伤——已完成的保留、清除的保持清除、零新增派发。
  await waitFor(async () => (await getSession(request, doc.id)).expired).toBe(true);
  await delay(700);
  const snap = await getProgress(request, doc.id);
  expect(snap.succeeded).toBe(1);
  expect(snap.queued + snap.running).toBe(0);
  expect(mock.convertCalls()).toBe(1);
  const reused = await (
    await request.post(`${service.base}/api/documents/${doc.id}/pages/1/parse`)
  ).json();
  expect(reused).toMatchObject({ page: 1, status: 'succeeded', reused: true });
  expect(mock.convertCalls()).toBe(1);
});

test('验收 3：短暂断线（宽限内回来）——队列不受影响，直接继续', async ({ request }) => {
  await setup({ mockOptions: { convertDelayMs: 300 }, env: { READEVA_CLIENT_GRACE_MS: '3000' } });
  const doc = await importFixture(FIXTURE_A, 'sample-a.pdf', request);

  await putReadingPosition(request, doc.id, 1); // p1 运行，2-8 排队
  await waitFor(() => convertSeq().length).toBe(1);

  // 「断线」间隙（无任何客户端请求）内：队列继续推进（p1 完成后自动派发 p2）。
  await waitFor(() => convertSeq().length).toBe(2);
  // 间隙仍在宽限内：会话未过期。
  const session = await getSession(request, doc.id);
  expect(session.expired).toBe(false);
  expect(session.lastSeen).toBeTruthy();

  // 宽限内回来（重新上报阅读位置 = 客户端活动）：队列不受影响，直接继续。
  await putReadingPosition(request, doc.id, 2);
  await waitFor(async () => (await getProgress(request, doc.id)).succeeded).toBe(8);
  const snap = await getProgress(request, doc.id);
  expect(snap).toMatchObject({ succeeded: 8, failed: 0, total: 8 });
  // 整本恰好每页一次转换：无重复、无清除误伤。
  expect(mock.convertCalls()).toBe(8);
});

test('验收 4：重连取回已完成成果（不重新解析）并按当前阅读位置重新调度未完成页', async ({ request }) => {
  await setup({ mockOptions: { convertDelayMs: 500 }, env: { READEVA_CLIENT_GRACE_MS: '800' } });
  const doc = await importFixture(FIXTURE_A, 'sample-a.pdf', request);

  await putReadingPosition(request, doc.id, 1);
  await waitFor(() => convertSeq().length).toBe(1);
  // 宽限期到期：p1 完成并落盘，2-8 清除（等待处置 sweep 执行，期间不发请求）。
  await waitFor(async () => (await getSession(request, doc.id)).expired).toBe(true);
  await delay(700);
  await waitFor(async () => (await getProgress(request, doc.id)).succeeded).toBe(1);
  expect(mock.convertCalls()).toBe(1);
  const before = await (
    await request.get(`${service.base}/api/documents/${doc.id}/pages/1/parse/result`)
  ).json();

  // 重连（重新打开文档 → 上报阅读位置到第 3 页）：已完成页复用，未完成页按
  // 「当前页 → 后续页 → 前置页」重新调度（队列 [3,4,5,6,7,8,2]，p1 不入队；
  // 并发空闲 → 第 3 页立即开始）。
  const put = await putReadingPosition(request, doc.id, 3);
  const progress = (await put.json()).progress;
  expect(progress.pages.find((p) => p.page === 3).status).toBe('running');
  const queuedPages = progress.pages
    .filter((p) => p.status === 'queued')
    .sort((a, b) => a.queuePosition - b.queuePosition)
    .map((p) => p.page);
  expect(queuedPages).toEqual([4, 5, 6, 7, 8, 2]);

  // 等待重连后的后台补全（轮询进度 = 客户端活动，会话保持活跃）。
  await waitFor(async () => (await getProgress(request, doc.id)).succeeded).toBe(8);
  expect(convertSeq()).toEqual([
    'page-1.pdf',
    'page-3.pdf',
    'page-4.pdf',
    'page-5.pdf',
    'page-6.pdf',
    'page-7.pdf',
    'page-8.pdf',
    'page-2.pdf',
  ]);
  // 已完成成果取回：parseId 不变（未重新解析）。
  const after = await (
    await request.get(`${service.base}/api/documents/${doc.id}/pages/1/parse/result`)
  ).json();
  expect(after.parse.parseId).toBe(before.parse.parseId);
  expect(after.parse.blocks).toEqual(before.parse.blocks);
  // 全程每页恰好一次转换：p1 复用零新增。
  expect(mock.convertCalls()).toBe(8);
});

test('验收 5 配套：会话端点只读观察（不刷新 lastSeen）、宽限期可配置、未配置解析服务时降级', async ({ request }) => {
  await setup({ env: { READEVA_CLIENT_GRACE_MS: '1000' } });
  const doc = await importFixture(FIXTURE_A, 'sample-a.pdf', request);

  await putReadingPosition(request, doc.id, 1);
  const session0 = await getSession(request, doc.id);
  expect(session0).toMatchObject({
    documentId: doc.id,
    supported: true,
    graceMs: 1000,
    expired: false,
  });
  expect(session0.lastSeen).toBeTruthy();

  // 观察期持续轮询 session（只读，不刷新 lastSeen）：到期照常发生。
  await waitFor(async () => (await getSession(request, doc.id)).expired).toBe(true);

  // 未知文档 404；未配置解析服务时 supported:false 降级。
  const missing = await request.get(
    `${service.base}/api/documents/${'0'.repeat(64)}/session`,
  );
  expect(missing.status()).toBe(404);

  await stopService(service);
  await mock.close();
  // 未配置解析服务：session 端点降级 supported:false（无队列可处置）。
  service = await startService();
  const plainDoc = await importFixture(FIXTURE_B, 'sample-b.pdf', request);
  const plainSession = await (
    await request.get(`${service.base}/api/documents/${plainDoc.id}/session`)
  ).json();
  expect(plainSession).toMatchObject({ documentId: plainDoc.id, supported: false });
  await stopService(service);
  service = undefined;
});

test('跨文档取任务轮转（round-robin，并发 1）：严格交替派发，不单个文档排空', async ({ request }) => {
  await setup({ mockOptions: { convertDelayMs: 120 } });
  const docA = await importFixture(FIXTURE_A, 'sample-a.pdf', request); // 8 页
  const docB = await importFixture(FIXTURE_B, 'sample-b.pdf', request); // 4 页

  // 并发 1：取走 A 队首后轮转到 B，再回到 A… 严格交替。
  await putReadingPosition(request, docA.id, 1);
  await putReadingPosition(request, docB.id, 1);
  await waitFor(async () => {
    const a = await getProgress(request, docA.id);
    const b = await getProgress(request, docB.id);
    return a.succeeded + b.succeeded;
  }).toBe(12);

  // 按单页字节 sha256 把 mock 提交记录映射回 (文档, 页码)，断言交替顺序。
  const shaMap = await buildPageShaMap();
  const seq = mock.requests
    .filter((r) => r.kind === 'convert')
    .map((r) => shaMap[r.sha256] ?? r.filename);
  expect(seq).toEqual(['A1', 'B1', 'A2', 'B2', 'A3', 'B3', 'A4', 'B4', 'A5', 'A6', 'A7', 'A8']);
  expect(mock.convertCalls()).toBe(12);
});

test('跨文档取任务轮转（round-robin，并发 2）：A 未排空前 B 已开始，每页恰好一次转换', async ({ request }) => {
  await setup({ mockOptions: { convertDelayMs: 200 }, env: { READEVA_PARSE_CONCURRENCY: '2' } });
  const docC = await importFixture(FIXTURE_A, 'sample-a.pdf', request);
  const docD = await importFixture(FIXTURE_B, 'sample-b.pdf', request);

  await putReadingPosition(request, docC.id, 1);
  await putReadingPosition(request, docD.id, 1);
  await waitFor(async () => {
    const c = await getProgress(request, docC.id);
    const d = await getProgress(request, docD.id);
    return c.succeeded + d.succeeded;
  }).toBe(12);

  const shaMap = await buildPageShaMap();
  const seq = mock.requests
    .filter((r) => r.kind === 'convert')
    .map((r) => shaMap[r.sha256] ?? r.filename);
  // 反饥饿：B 的首个转换发生在 A 完成之前（轮转保证 A 不排空）；12 页各一次。
  expect(seq.indexOf('B1')).toBeLessThan(seq.indexOf('A8'));
  expect(mock.convertCalls()).toBe(12);
});

/** 与 server/docling.js 相同方式抽取单页并建立 sha256 → 'A<page>'/'B<page>' 映射。 */
async function buildPageShaMap() {
  const map = {};
  const extract = async (file, pageNo) => {
    const source = await PDFDocument.load(fs.readFileSync(file), {
      ignoreEncryption: true,
      updateMetadata: false,
    });
    const single = await PDFDocument.create();
    single.setCreationDate(new Date(0));
    single.setModificationDate(new Date(0));
    const [copied] = await single.copyPages(source, [pageNo - 1]);
    single.addPage(copied);
    return Buffer.from(await single.save());
  };
  for (let p = 1; p <= 8; p += 1) {
    const bytes = await extract(FIXTURE_A, p);
    map[crypto.createHash('sha256').update(bytes).digest('hex')] = `A${p}`;
  }
  for (let p = 1; p <= 4; p += 1) {
    const bytes = await extract(FIXTURE_B, p);
    map[crypto.createHash('sha256').update(bytes).digest('hex')] = `B${p}`;
  }
  return map;
}

test('状态索引：解析落盘写 index.json；重启后进度与状态从索引读取且结果完整', async ({ request }) => {
  await setup({ mockOptions: { convertDelayMs: 100 } });
  const doc = await importFixture(FIXTURE_A, 'sample-a.pdf', request);
  await putReadingPosition(request, doc.id, 1);
  await waitFor(async () => (await getProgress(request, doc.id)).succeeded).toBe(8);

  // 保存路径写了状态索引：条目与页记录一致（含页文件 mtime+size 快照）。
  const indexFile = path.join(service.dataDir, 'parses', doc.id, 'index.json');
  const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  expect(index.schemaVersion).toBe(1);
  expect(Object.keys(index.pages)).toHaveLength(8);
  for (const [page, entry] of Object.entries(index.pages)) {
    expect(entry).toMatchObject({ status: 'succeeded' });
    expect(entry.parseId).toMatch(/^[0-9a-f]{64}$/);
    const stat = fs.statSync(path.join(service.dataDir, 'parses', doc.id, `page-${page}.json`));
    expect(entry.pageFileMtimeMs).toBe(stat.mtimeMs);
    expect(entry.pageFileSize).toBe(stat.size);
  }
  const before = await getProgress(request, doc.id);

  // 真实重启服务（同数据目录）：冷启动经状态索引取状态（免首轮逐页读全量）。
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
  // 结果接口完整（blocks 从页记录读盘，不受索引影响）。
  const result = await (
    await request.get(`${service.base}/api/documents/${doc.id}/pages/3/parse/result`)
  ).json();
  expect(result.parse.parseId).toMatch(/^[0-9a-f]{64}$/);
  expect(result.parse.blocks.length).toBeGreaterThan(0);
  // 状态索引失效路径：外部删除页记录 → 状态回到未开始（索引不覆盖文件存在性）。
  fs.rmSync(path.join(service.dataDir, 'parses', doc.id, 'page-4.json'));
  const snap = await getProgress(request, doc.id);
  expect(snap.pages.find((p) => p.page === 4).status).toBe('idle');
  // 外部替换页记录（不同内容，mtime+size 变化）→ 状态反映新记录（索引防过期）。
  fs.writeFileSync(
    path.join(service.dataDir, 'parses', doc.id, 'page-5.json'),
    JSON.stringify({
      schemaVersion: 1,
      documentId: doc.id,
      page: 5,
      status: 'failed',
      error: 'external failure',
      meta: {},
      updatedAt: new Date().toISOString(),
    }),
  );
  const snap2 = await getProgress(request, doc.id);
  expect(snap2.pages.find((p) => p.page === 5)).toMatchObject({ status: 'failed' });
  expect(snap2.pages.find((p) => p.page === 5).error).toBe('external failure');
});
