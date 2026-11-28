import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { startService, stopService } from '../helpers/service.js';
import { startMockDocling } from '../helpers/mock-docling.js';
import { startMockMinimax } from '../helpers/mock-minimax.js';

const FIXTURE_A = path.resolve('tests/fixtures/sample-a.pdf');
const PAGE3_DOC = path.resolve('tests/fixtures/docling/page-3.json');
const TEST_KEY = 'test-key-123';

/**
 * Issue #8 服务级用例（mock MiniMax 固定翻译响应，不依赖真实服务/密钥）：
 * 翻译接口（块/选文 → 译文）、按「文档 + parseId + 来源 + 目标语言」的复用、
 * 自动落盘与重启恢复、失败不写入成功译文、parseId 绑定与解析替换防污染、
 * 参数校验与未配置降级、在途请求去重。
 */
test.describe.configure({ mode: 'serial' });

let service;
let docling;
let minimax;
let docId;
/** 第 1 页（default-page.json）解析身份与内容块。 */
let parseId1;
let page1Blocks;
/** 第 2 页（同 fixture，pageNo 不同 → parseId 不同）。 */
let parseId2;
/** 第 3 页（page-3.json：标题/小节/列表/表格/图片/段落）。 */
let parseId3;
let page3Blocks;

function translationsUrl(doc, page) {
  return `${service.base}/api/documents/${doc}/pages/${page}/translations`;
}

async function postTranslation(doc, page, body) {
  return fetch(translationsUrl(doc, page), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function getTranslations(doc, page) {
  const res = await fetch(translationsUrl(doc, page));
  return { status: res.status, body: await res.json() };
}

async function parsePageAndWait(doc, page) {
  await fetch(`${service.base}/api/documents/${doc}/pages/${page}/parse`, { method: 'POST' });
  await expect
    .poll(async () => {
      const res = await fetch(`${service.base}/api/documents/${doc}/pages/${page}/parse`);
      return (await res.json()).status;
    })
    .toBe('succeeded');
  const res = await fetch(`${service.base}/api/documents/${doc}/pages/${page}/parse/result`);
  return (await res.json()).parse;
}

async function importFixtureA() {
  const res = await fetch(`${service.base}/api/documents/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/pdf', 'x-filename': 'sample-a.pdf' },
    body: fs.readFileSync(FIXTURE_A),
  });
  expect(res.status).toBe(201);
  return (await res.json()).document;
}

test.beforeAll(async () => {
  minimax = await startMockMinimax();
  docling = await startMockDocling({ byPage: { 3: PAGE3_DOC } });
  service = await startService({
    env: {
      READEVA_DOCLING_URL: docling.base,
      READEVA_MINIMAX_BASE_URL: `${minimax.base}/v1`,
      MINIMAX_API_KEY: TEST_KEY,
    },
  });
  const doc = await importFixtureA();
  docId = doc.id;

  const page1 = await parsePageAndWait(docId, 1);
  parseId1 = page1.parseId;
  page1Blocks = page1.blocks;
  parseId2 = (await parsePageAndWait(docId, 2)).parseId;
  expect(parseId2).not.toBe(parseId1);
  const page3 = await parsePageAndWait(docId, 3);
  parseId3 = page3.parseId;
  page3Blocks = page3.blocks;
});

test.afterAll(async () => {
  await stopService(service);
  if (docling) await docling.close();
  if (minimax) await minimax.close();
});

/* ---------------- 配置暴露 ---------------- */

test('翻译服务配置暴露：模型固定 MiniMax-M3.1-Flash，默认中文，不含密钥', async () => {
  const res = await fetch(`${service.base}/api/translate/service`);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.configured).toBe(true);
  expect(body.model).toBe('MiniMax-M3.1-Flash');
  expect(body.defaultTargetLanguage).toBe('zh');
  // 客户端不接收密钥：配置端点响应不含密钥值。
  expect(JSON.stringify(body)).not.toContain(TEST_KEY);
});

/* ---------------- 内容块翻译 ---------------- */

test('内容块翻译：译文绑定文档+parseId+块来源+目标语言，mock 收到固定模型与 Bearer 密钥', async () => {
  const block = page1Blocks.find((b) => b.kind === 'paragraph');
  expect(block).toBeTruthy();
  const callsBefore = minimax.chatCalls();
  const res = await postTranslation(docId, 1, {
    parseId: parseId1,
    source: { kind: 'block', blockId: block.id },
  });
  expect(res.status).toBe(201);
  const { reused, translation } = await res.json();
  expect(reused).toBe(false);
  expect(translation.documentId).toBe(docId);
  expect(translation.parseId).toBe(parseId1);
  expect(translation.page).toBe(1);
  expect(translation.sourceKind).toBe('block');
  expect(translation.blockId).toBe(block.id);
  expect(translation.sourceKey).toBe(`block:${block.id}`);
  expect(translation.targetLanguage).toBe('zh');
  expect(translation.id).toBe(`block:${block.id}|zh`);
  expect(translation.model).toBe('MiniMax-M3.1-Flash');
  // 固定 mock 译文 = 【译】+ 块源文本（服务端从解析记录自行提取，客户端只传块 id）。
  expect(translation.text).toBe(`【译】${block.text}`);
  expect(translation.createdAt).toBe(translation.updatedAt);

  // 上游调用契约：模型名、Bearer 密钥形态、待翻译文本；密钥不出现在响应里。
  expect(minimax.chatCalls()).toBe(callsBefore + 1);
  const call = minimax.requests[minimax.requests.length - 1];
  expect(call.model).toBe('MiniMax-M3.1-Flash');
  expect(call.authorizationPrefix).toBe('bearer');
  expect(call.system).toContain('translate');
  expect(call.text).toBe(block.text);
  expect(JSON.stringify({ reused, translation })).not.toContain(TEST_KEY);
});

test('内容块复用：同一块重复请求返回已有译文，不再调用翻译服务', async () => {
  const block = page1Blocks.find((b) => b.kind === 'paragraph');
  const callsBefore = minimax.chatCalls();
  const res = await postTranslation(docId, 1, {
    parseId: parseId1,
    source: { kind: 'block', blockId: block.id },
  });
  expect(res.status).toBe(200);
  const { reused, translation } = await res.json();
  expect(reused).toBe(true);
  expect(translation.text).toBe(`【译】${block.text}`);
  expect(minimax.chatCalls()).toBe(callsBefore);
});

test('列表与表格块：服务端按块结构提取源文本；图片块无文本 400', async () => {
  const list = page3Blocks.find((b) => b.kind === 'list');
  expect(list).toBeTruthy();
  const listRes = await postTranslation(docId, 3, {
    parseId: parseId3,
    source: { kind: 'block', blockId: list.id },
  });
  expect(listRes.status).toBe(201);
  expect((await listRes.json()).translation.text).toBe(`【译】${list.items.join('\n')}`);

  const table = page3Blocks.find((b) => b.kind === 'table');
  const tableRes = await postTranslation(docId, 3, {
    parseId: parseId3,
    source: { kind: 'block', blockId: table.id },
  });
  expect(tableRes.status).toBe(201);
  const tableText = table.rows.map((row) => row.join('\t')).join('\n');
  expect((await tableRes.json()).translation.text).toBe(`【译】${tableText}`);

  const image = page3Blocks.find((b) => b.kind === 'image');
  expect(image).toBeTruthy();
  const imageRes = await postTranslation(docId, 3, {
    parseId: parseId3,
    source: { kind: 'block', blockId: image.id },
  });
  expect(imageRes.status).toBe(400);
  expect((await imageRes.json()).error).toBe('block has no translatable text');
});

/* ---------------- 选文翻译与归一化复用 ---------------- */

test('选文翻译：绑定归一化选文 sha256 来源；空白差异映射同一复用键', async () => {
  const res = await postTranslation(docId, 1, {
    parseId: parseId1,
    source: { kind: 'selection', text: '  The reading position   of this document ' },
  });
  expect(res.status).toBe(201);
  const { reused, translation } = await res.json();
  expect(reused).toBe(false);
  expect(translation.sourceKind).toBe('selection');
  expect(translation.blockId).toBeNull();
  expect(translation.sourceText).toBe('The reading position of this document');
  // sourceKey = selection:<sha256 hex>；id 绑定目标语言。
  expect(translation.sourceKey).toMatch(/^selection:[0-9a-f]{64}$/);
  expect(translation.id).toBe(`${translation.sourceKey}|zh`);
  expect(translation.targetLanguage).toBe('zh');
  expect(translation.text).toBe('【译】The reading position of this document');

  // 归一化复用：不同空白形式的同一选文 → reused，不重新翻译。
  const callsBefore = minimax.chatCalls();
  const res2 = await postTranslation(docId, 1, {
    parseId: parseId1,
    source: { kind: 'selection', text: 'The reading position of this document' },
  });
  expect(res2.status).toBe(200);
  expect((await res2.json()).reused).toBe(true);
  expect(minimax.chatCalls()).toBe(callsBefore);
});

test('目标语言绑定：同一来源不同语言各自保存与复用', async () => {
  const heading = page1Blocks.find((b) => b.kind === 'heading');
  const enRes = await postTranslation(docId, 1, {
    parseId: parseId1,
    source: { kind: 'block', blockId: heading.id },
    targetLanguage: 'en',
  });
  expect(enRes.status).toBe(201);
  const en = (await enRes.json()).translation;
  expect(en.targetLanguage).toBe('en');
  expect(en.id).toBe(`${en.sourceKey}|en`);
  expect(en.text).toBe(`【译】${heading.text}`);

  // 同一块中文（默认语言）与英文共存。
  const zhRes = await postTranslation(docId, 1, {
    parseId: parseId1,
    source: { kind: 'block', blockId: heading.id },
  });
  expect(zhRes.status).toBe(201);
  expect((await zhRes.json()).translation.targetLanguage).toBe('zh');

  const enAgain = await postTranslation(docId, 1, {
    parseId: parseId1,
    source: { kind: 'block', blockId: heading.id },
    targetLanguage: 'en',
  });
  expect(enAgain.status).toBe(200);
  expect((await enAgain.json()).reused).toBe(true);
});

/* ---------------- 取回、持久保存与重启恢复 ---------------- */

test('取回当前页解析绑定的全部译文；重启服务后恢复且不重新翻译', async () => {
  const { body } = await getTranslations(docId, 1);
  expect(body.page).toBe(1);
  expect(body.parseId).toBe(parseId1);
  const ids = body.translations.map((t) => t.id);
  const block = page1Blocks.find((b) => b.kind === 'paragraph');
  const heading = page1Blocks.find((b) => b.kind === 'heading');
  expect(ids).toContain(`block:${block.id}|zh`);
  expect(ids).toContain(`block:${heading.id}|zh`);
  expect(ids).toContain(`block:${heading.id}|en`);
  expect(ids.some((id) => id.startsWith('selection:'))).toBe(true);
  // 译文落盘在数据目录：translations/<docId>/<parseId>.json。
  expect(fs.existsSync(path.join(service.dataDir, 'translations', docId, `${parseId1}.json`))).toBe(
    true,
  );

  // 重启服务（同一数据目录）：译文直接恢复，解析不重跑，翻译服务零调用。
  const callsBefore = minimax.chatCalls();
  const convertsBefore = docling.convertCalls();
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
  const { body: body2 } = await getTranslations(docId, 1);
  expect(body2.parseId).toBe(parseId1);
  expect(body2.translations.map((t) => t.id)).toEqual(ids);
  expect(minimax.chatCalls()).toBe(callsBefore);
  expect(docling.convertCalls()).toBe(convertsBefore);

  // 重启后复用语义不变：重复请求仍 reused 且零翻译调用。
  const again = await postTranslation(docId, 1, {
    parseId: parseId1,
    source: { kind: 'block', blockId: block.id },
  });
  expect(again.status).toBe(200);
  expect((await again.json()).reused).toBe(true);
  expect(minimax.chatCalls()).toBe(callsBefore);
});

/* ---------------- 失败不写入成功译文 ---------------- */

test('翻译失败：502 明确反馈，失败不写入任何译文；恢复后重试成功', async () => {
  const source = { kind: 'selection', text: 'failure case selection' };
  const callsBefore = minimax.chatCalls();
  // 行为脚本：第一次失败（HTTP 500），第二次成功（验证恢复后重试）。
  minimax.setBehavior([
    { mode: 'failure', httpStatus: 500, message: 'mock upstream down' },
    { mode: 'success' },
  ]);

  const res = await postTranslation(docId, 1, { parseId: parseId1, source });
  expect(res.status).toBe(502);
  const body = await res.json();
  expect(body.error).toContain('translation failed');
  expect(body.error).toContain('mock upstream down');
  expect(minimax.chatCalls()).toBe(callsBefore + 1);

  // 失败不写入：GET 不含该来源的译文。
  const { body: list } = await getTranslations(docId, 1);
  expect(list.translations.some((t) => t.sourceText === 'failure case selection')).toBe(false);

  // 行为脚本第二步成功：重试成功并保存。
  const res2 = await postTranslation(docId, 1, { parseId: parseId1, source });
  expect(res2.status).toBe(201);
  const retry = (await res2.json()).translation;
  expect(retry.text).toBe('【译】failure case selection');
  const { body: list2 } = await getTranslations(docId, 1);
  expect(list2.translations.some((t) => t.id === retry.id)).toBe(true);
});

/* ---------------- parseId 绑定与解析替换防污染 ---------------- */

test('parseId 绑定：错误的解析身份 / 未解析页 / 其他页的 parseId 一律 409', async () => {
  const block = page1Blocks.find((b) => b.kind === 'paragraph');
  // 伪造的 parseId（与当前页解析不匹配）。
  const stale = await postTranslation(docId, 1, {
    parseId: 'f'.repeat(64),
    source: { kind: 'block', blockId: block.id },
  });
  expect(stale.status).toBe(409);
  expect((await stale.json()).error).toBe('page parse has been replaced');

  // 用第 2 页的 parseId 请求第 1 页：解析身份不匹配。
  const wrongPage = await postTranslation(docId, 1, {
    parseId: parseId2,
    source: { kind: 'block', blockId: block.id },
  });
  expect(wrongPage.status).toBe(409);

  // 未解析页（第 8 页 idle）：没有可绑定的解析身份。
  const idle = await postTranslation(docId, 8, {
    parseId: parseId1,
    source: { kind: 'selection', text: 'never parsed page' },
  });
  expect(idle.status).toBe(409);
  expect((await idle.json()).error).toBe('page parse is not available');

  // 以上请求全部未触发翻译调用。
  const callsBefore = minimax.chatCalls();
  const after = await postTranslation(docId, 1, {
    parseId: 'e'.repeat(64),
    source: { kind: 'block', blockId: block.id },
  });
  expect(after.status).toBe(409);
  expect(minimax.chatCalls()).toBe(callsBefore);
});

test('防污染：解析替换期间返回的旧翻译响应不写入新解析', async () => {
  // 第 2 页已有解析（beforeAll）；发起一个慢翻译（mock 延迟 1.5s），不立即等待。
  const source = { kind: 'selection', text: 'pollution guard selection' };
  const callsBefore = minimax.chatCalls();
  minimax.setDelay(1500);
  const pending = postTranslation(docId, 2, { parseId: parseId2, source });
  // 等待翻译请求真实到达上游（= 服务端已完成初始 parseId 校验并进入翻译调用），
  // 再替换解析——保证触发的是「解析替换期间返回的旧翻译响应」场景而非请求竞态。
  await expect
    .poll(async () => minimax.chatCalls(), { timeout: 5000 })
    .toBe(callsBefore + 1);

  // 翻译在途期间重新解析第 2 页（外部删除记录 → 用不同 DoclingDocument 重新解析）。
  fs.rmSync(path.join(service.dataDir, 'parses', docId, 'page-2.json'), { force: true });
  docling.setBehavior([{ mode: 'success', document: PAGE3_DOC }]);
  await fetch(`${service.base}/api/documents/${docId}/pages/2/parse`, { method: 'POST' });
  await expect
    .poll(async () => {
      const res = await fetch(`${service.base}/api/documents/${docId}/pages/2/parse`);
      return (await res.json()).status;
    })
    .toBe('succeeded');
  const resultRes = await fetch(`${service.base}/api/documents/${docId}/pages/2/parse/result`);
  const newParseId = (await resultRes.json()).parse.parseId;
  expect(newParseId).not.toBe(parseId2);

  // 旧解析期间发起的翻译请求返回：不写入新解析（409，无落盘）。
  const late = await pending;
  expect(late.status).toBe(409);
  expect((await late.json()).error).toBe('page parse replaced during translation');
  expect(minimax.chatCalls()).toBe(callsBefore + 1); // 翻译确实调用了上游

  // 新解析下没有任何绑定译文；新解析的译文文件不存在（零写入）。
  const { body: list } = await getTranslations(docId, 2);
  expect(list.parseId).toBe(newParseId);
  expect(list.translations).toEqual([]);
  expect(
    fs.existsSync(path.join(service.dataDir, 'translations', docId, `${newParseId}.json`)),
  ).toBe(false);

  minimax.setDelay(0);
  docling.setBehavior(null);
});

/* ---------------- 参数校验 ---------------- */

test('参数校验：非法请求 400 / 未知文档 404', async () => {
  const block = page1Blocks.find((b) => b.kind === 'paragraph');
  const cases = [
    [{ source: { kind: 'block', blockId: block.id } }, 400], // 缺 parseId
    [{ parseId: parseId1, source: { kind: 'other' } }, 400], // 非法来源类型
    [{ parseId: parseId1, source: { kind: 'selection', text: '   ' } }, 400], // 空选文
    [{ parseId: parseId1, source: { kind: 'selection', text: 'a'.repeat(20001) } }, 400], // 超长选文
    [{ parseId: parseId1, source: { kind: 'block', blockId: 'b99' } }, 400], // 块不存在
    [{ parseId: parseId1, source: { kind: 'block' } }, 400], // 缺块 id
    [{ parseId: parseId1, source: { kind: 'selection', text: 'ok' }, targetLanguage: 'zh CN!' }, 400], // 非法语言码
  ];
  for (const [data, expected] of cases) {
    const res = await postTranslation(docId, 1, data);
    expect(res.status, JSON.stringify(data)).toBe(expected);
    expect((await res.json()).error).toBeTruthy();
  }
  // 未知文档 / 非法页码（POST 与 GET 一致）。
  const unknownId = '0'.repeat(64);
  const unknownDoc = await postTranslation(unknownId, 1, {
    parseId: parseId1,
    source: { kind: 'selection', text: 'x' },
  });
  expect(unknownDoc.status).toBe(404);
  const badPage = await postTranslation(docId, 9, {
    parseId: parseId1,
    source: { kind: 'selection', text: 'x' },
  });
  expect(badPage.status).toBe(400);
  const badPageGet = await fetch(translationsUrl(docId, 9));
  expect(badPageGet.status).toBe(400);
  const unknownGet = await fetch(translationsUrl(unknownId, 1));
  expect(unknownGet.status).toBe(404);
});

test('在途去重：并发重复请求同一新译文只调用一次翻译服务', async () => {
  minimax.setDelay(400);
  const source = { kind: 'selection', text: 'concurrent dedup selection' };
  const callsBefore = minimax.chatCalls();
  const [a, b] = await Promise.all([
    postTranslation(docId, 1, { parseId: parseId1, source }),
    postTranslation(docId, 1, { parseId: parseId1, source }),
  ]);
  expect(a.status).toBe(201);
  expect(b.status).toBe(201);
  const ta = (await a.json()).translation;
  const tb = (await b.json()).translation;
  expect(ta.id).toBe(tb.id);
  expect(minimax.chatCalls()).toBe(callsBefore + 1);
  minimax.setDelay(0);
});

/* ---------------- 未配置翻译服务 ---------------- */

test('未配置密钥：503 与明确提示，配置端点 configured=false', async () => {
  const localDocling = await startMockDocling({});
  // 显式置空 MINIMAX_API_KEY：本机环境可能已设置真实密钥（覆盖 process.env 继承）。
  const localService = await startService({
    env: { READEVA_DOCLING_URL: localDocling.base, MINIMAX_API_KEY: '' },
  });
  try {
    const configRes = await fetch(`${localService.base}/api/translate/service`);
    expect((await configRes.json()).configured).toBe(false);

    const res = await fetch(`${localService.base}/api/documents/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/pdf', 'x-filename': 'sample-a.pdf' },
      body: fs.readFileSync(FIXTURE_A),
    });
    const localDocId = (await res.json()).document.id;
    await fetch(`${localService.base}/api/documents/${localDocId}/pages/1/parse`, { method: 'POST' });
    await expect
      .poll(async () => {
        const r = await fetch(`${localService.base}/api/documents/${localDocId}/pages/1/parse`);
        return (await r.json()).status;
      })
      .toBe('succeeded');
    const parseId = (
      await (
        await fetch(`${localService.base}/api/documents/${localDocId}/pages/1/parse/result`)
      ).json()
    ).parse.parseId;

    const post = await fetch(`${localService.base}/api/documents/${localDocId}/pages/1/translations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parseId, source: { kind: 'selection', text: 'unconfigured service' } }),
    });
    expect(post.status).toBe(503);
    expect((await post.json()).error).toBe('translation service not configured');
    // 取回不受影响（无译文）。
    const list = await (
      await fetch(`${localService.base}/api/documents/${localDocId}/pages/1/translations`)
    ).json();
    expect(list.translations).toEqual([]);
  } finally {
    await stopService(localService);
    await localDocling.close();
  }
});
