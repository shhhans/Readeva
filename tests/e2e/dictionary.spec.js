import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startService, stopService } from '../helpers/service.js';
import { startMockDocling } from '../helpers/mock-docling.js';
import { buildDictionary } from '../../scripts/build-dictionary.mjs';

const FIXTURE_CSV = path.resolve('tests/fixtures/dict/ecdict-fixture.csv');
const FIXTURE_A = path.resolve('tests/fixtures/sample-a.pdf');

/**
 * Issue #7 后续收口（审核官非阻塞建议 ②–⑤）：卡片页脚真实 attribution、
 * 构建脚本对「下载到错误文件」更敏感、超长查询改「未收录」语义。
 *
 * 按父规格：自动化测试使用固定 ECDICT 结果——由 `scripts/build-dictionary.mjs`
 * 从小型固定 CSV（tests/fixtures/dict/ecdict-fixture.csv）构建临时词典目录，
 * 服务经 READEVA_ECDICT_DIR 指向它，**不依赖真实词典数据文件**；
 * 真实数据（约 63MB）由 Hans 下载与构建后人工验收。
 *
 * 覆盖：构建脚本（去重/排序/许可声明/CSV 校验）、词条查询 API（命中/未收录/
 * 未准备/非法参数/超长查询/归因字段）、选词查词浏览器流程（双击选词 → 查词 →
 * 卡片释义与元信息、真实归因页脚、未收录与未准备的明确反馈、工具条显隐）、
 * 无查词历史。查询为服务端纯本地文件操作（断网可查）。
 */
test.describe.configure({ mode: 'serial' });

let service;
let mock;
let docId;
let dictDir;

/** 固定样例 CSV 只有 9 条词条：构建校验的下限必须显式调低（正式数据远大于此）。 */
const FIXTURE_MIN_ENTRIES = 1;

/* ---------------- 构建脚本（无需服务） ---------------- */

test.describe('词典构建脚本', () => {
  test('从固定 CSV 构建：键去重、按字节序排序、许可声明落盘', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'readeva-dict-build-'));
    const summary = await buildDictionary({
      csvPath: FIXTURE_CSV,
      outDir: out,
      minEntries: FIXTURE_MIN_ENTRIES,
    });
    expect(summary.entryCount).toBe(9); // 10 行数据 - 1 行重复（Identity）
    expect(summary.duplicates).toBe(1);
    // 固定样例本身格式健康：无字段数异常行、无告警。
    expect(summary.malformedRows).toBe(0);
    expect(summary.warnings).toEqual([]);

    const lines = fs
      .readFileSync(path.join(out, 'ecdict.entries.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(lines).toHaveLength(9);

    // 键按小写 UTF-8 字节序排序（与运行时二分查找一致）。
    const keys = lines.map((entry) => entry.word.toLowerCase());
    const sorted = [...keys.map((k) => Buffer.from(k))].sort(Buffer.compare);
    expect(keys.map((k) => Buffer.from(k))).toEqual(sorted);

    // 小写键去重：保留首个出现的词条。
    const identity = lines.find((entry) => entry.word === 'identity');
    expect(identity.translation).toContain('身份');
    expect(identity.translation).not.toContain('重复行');

    // ECDICT 格式细节：引号包裹字段内的逗号、字面 \n 分行、数字字段。
    const cabin = lines.find((entry) => entry.word === 'cabin');
    expect(cabin.phonetic).toBe("'kæbɪn");
    expect(cabin.definition).toContain('especially one built of wood');
    expect(cabin.translation.split('\n')).toHaveLength(2);
    expect(cabin.pos).toBe('n:8/v:2');
    expect(cabin.collins).toBe(3);
    expect(cabin.oxford).toBe(1);
    expect(cabin.tag).toBe('zk gk cet4 cet6 ky toefl');
    expect(cabin.bnc).toBe(4321);
    expect(cabin.frq).toBe(5678);
    expect(cabin.exchange).toBe('p:cabined/d:cabined/3:cabins/i:cabining');

    // 原始词形保留（大写）；词条可含空格/连字符/撇号；词首尾空白被修剪。
    expect(lines.find((entry) => entry.word === 'NASA')).toBeTruthy();
    expect(lines.find((entry) => entry.word === 'cabin pressure')).toBeTruthy();
    expect(lines.find((entry) => entry.word === '-gate')).toBeTruthy();
    expect(lines.find((entry) => entry.word === "'hood")).toBeTruthy();
    expect(lines.find((entry) => entry.word === 'revision')).toBeTruthy();

    // manifest：来源与许可声明（保留所需许可声明）。
    const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
    expect(manifest.source).toBe('ECDICT');
    expect(manifest.entryCount).toBe(9);
    expect(manifest.license.name).toBe('MIT');
    expect(manifest.license.text).toContain('Permission is hereby granted');
    expect(manifest.license.dataSources).toContain('ECDICT');

    // 内存索引与词条文件一一对应：记录数一致。
    const bin = fs.readFileSync(path.join(out, 'ecdict.words.bin'));
    let count = 0;
    let pos = 0;
    while (pos < bin.length) {
      count += 1;
      pos += 1 + bin[pos] + 8;
    }
    expect(count).toBe(9);
  });

  test('缺 CSV 文件时构建失败并给出原因', async () => {
    await expect(
      buildDictionary({ csvPath: 'tests/fixtures/dict/not-exist.csv', outDir: os.tmpdir() }),
    ).rejects.toThrow(/ENOENT/);
  });

  test('词条数明显不足时构建失败（下载到截断/错误文件）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'readeva-dict-short-'));
    const csv = path.join(dir, 'ecdict.csv');
    const out = path.join(dir, 'out');
    fs.writeFileSync(
      csv,
      [
        'word,phonetic,definition,translation,pos,collins,oxford,tag,bnc,frq,exchange,detail,audio',
        'alpha,,"first",甲,,,,,,0,0,,,',
        'beta,,"second",乙,,,,,,0,0,,,',
        '',
      ].join('\n'),
    );
    await expect(
      buildDictionary({ csvPath: csv, outDir: out, minEntries: 1000 }),
    ).rejects.toThrow(/only 2 entries parsed/);
    // 失败时不产出词典目录（不留下空词典/残缺词典）。
    expect(fs.existsSync(out)).toBe(false);
  });

  test('下载到 HTML 错误页时构建失败（不产出空词典）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'readeva-dict-html-'));
    const csv = path.join(dir, 'ecdict.csv');
    const out = path.join(dir, 'out');
    fs.writeFileSync(csv, '<!DOCTYPE html>\n<html><body>404: Not Found</body></html>\n');
    await expect(buildDictionary({ csvPath: csv, outDir: out })).rejects.toThrow(
      /not a CSV file/,
    );
    expect(fs.existsSync(out)).toBe(false);
  });

  test('表头缺列时构建失败并说明缺了哪些列', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'readeva-dict-header-'));
    const csv = path.join(dir, 'ecdict.csv');
    const out = path.join(dir, 'out');
    fs.writeFileSync(csv, 'word,phonetic,definition\nalpha,,"first"\n');
    await expect(
      buildDictionary({ csvPath: csv, outDir: out, minEntries: FIXTURE_MIN_ENTRIES }),
    ).rejects.toThrow(/unexpected csv header: missing column\(s\) translation/);
    expect(fs.existsSync(out)).toBe(false);
  });

  test('表头列数不符时构建失败（拿到的不是 ECDICT 词条表）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'readeva-dict-cols-'));
    const csv = path.join(dir, 'ecdict.csv');
    const out = path.join(dir, 'out');
    fs.writeFileSync(
      csv,
      [
        'word,phonetic,definition,translation,pos,collins,oxford,tag,bnc,frq,exchange,detail',
        'alpha,,"first",甲,,,,,,0,0,',
        '',
      ].join('\n'),
    );
    await expect(
      buildDictionary({ csvPath: csv, outDir: out, minEntries: FIXTURE_MIN_ENTRIES }),
    ).rejects.toThrow(/expected 13 columns/);
    expect(fs.existsSync(out)).toBe(false);
  });

  test('个别数据行字段数异常：告警但照常构建（截断/拼接容错）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'readeva-dict-warn-'));
    const csv = path.join(dir, 'ecdict.csv');
    const out = path.join(dir, 'out');
    fs.writeFileSync(
      csv,
      [
        'word,phonetic,definition,translation,pos,collins,oxford,tag,bnc,frq,exchange,detail,audio',
        'alpha,,"first",甲,,,,,,0,0,,',
        // 少 2 列（截断/拼接错误的行）：不阻断构建，统计到告警里。
        'beta,,"second",乙,,,,,,0,0',
        'gamma,,"third",丙,,,,,,0,0,,',
        '',
      ].join('\n'),
    );
    const summary = await buildDictionary({
      csvPath: csv,
      outDir: out,
      minEntries: FIXTURE_MIN_ENTRIES,
    });
    expect(summary.entryCount).toBe(3);
    expect(summary.malformedRows).toBe(1);
    expect(summary.warnings).toHaveLength(1);
    expect(summary.warnings[0]).toContain('1/3 data rows');
    // manifest 记录校验信息，供排查与归因。
    const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
    expect(manifest.validation.malformedRows).toBe(1);
    expect(manifest.validation.minEntries).toBe(FIXTURE_MIN_ENTRIES);
  });
});

/* ---------------- 共享服务（固定词典目录 + mock Docling） ---------------- */

test.beforeAll(async () => {
  dictDir = fs.mkdtempSync(path.join(os.tmpdir(), 'readeva-dict-fixture-'));
  await buildDictionary({
    csvPath: FIXTURE_CSV,
    outDir: dictDir,
    minEntries: FIXTURE_MIN_ENTRIES,
  });
  mock = await startMockDocling({});
  service = await startService({
    env: { READEVA_DOCLING_URL: mock.base, READEVA_ECDICT_DIR: dictDir },
  });
  const res = await fetch(`${service.base}/api/documents/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/pdf', 'x-filename': 'sample-a.pdf' },
    body: fs.readFileSync(FIXTURE_A),
  });
  expect(res.status).toBe(201);
  docId = (await res.json()).document.id;
});

test.afterAll(async () => {
  await stopService(service);
  if (mock) await mock.close();
});

/* ---------------- 词条查询 API（服务级） ---------------- */

test.describe('ECDICT 词条查询 API', () => {
  test('词条命中：返回词典提供的释义等完整字段', async ({ request }) => {
    const res = await request.get(
      `${service.base}/api/dictionary/lookup?word=${encodeURIComponent('CABIN')}`,
    );
    expect(res.status()).toBe(200);
    const { entry } = await res.json();
    expect(entry.word).toBe('cabin');
    expect(entry.phonetic).toBe("'kæbɪn");
    expect(entry.translation).toContain('客舱，机舱');
    expect(entry.translation.split('\n')).toHaveLength(2);
    expect(entry.definition).toContain('a small house');
    expect(entry.pos).toBe('n:8/v:2');
    expect(entry.collins).toBe(3);
    expect(entry.oxford).toBe(1);
    expect(entry.tag).toBe('zk gk cet4 cet6 ky toefl');
    expect(entry.bnc).toBe(4321);
    expect(entry.frq).toBe(5678);
    expect(entry.exchange).toBe('p:cabined/d:cabined/3:cabins/i:cabining');
  });

  test('词条命中：响应携带真实归因（许可 + 上游数据来源）', async ({ request }) => {
    const res = await request.get(
      `${service.base}/api/dictionary/lookup?word=${encodeURIComponent('cabin')}`,
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    // 归因来自构建产物 manifest.json（固定样例 ECDICT 许可与来源声明）。
    expect(body.license.name).toBe('MIT');
    expect(body.license.url).toContain('skywind3000/ECDICT');
    expect(body.license.copyright).toContain('skywind3000');
    expect(body.dataSources).toContain('EDictAZ');
    expect(body.dataSources).toContain('cdict-1.0-1');
    expect(body.dataSources).toContain('BNC');
  });

  test('大小写/空白/首尾标点归一后仍命中', async ({ request }) => {
    const res = await request.get(
      `${service.base}/api/dictionary/lookup?word=${encodeURIComponent('  Cabin, ')}`,
    );
    expect(res.status()).toBe(200);
    expect((await res.json()).entry.word).toBe('cabin');
  });

  test('词组词条命中（含空格键）', async ({ request }) => {
    const res = await request.get(
      `${service.base}/api/dictionary/lookup?word=${encodeURIComponent('cabin pressure')}`,
    );
    expect(res.status()).toBe(200);
    expect((await res.json()).entry.word).toBe('cabin pressure');
  });

  test('大写词条以原始词形返回（NASA）', async ({ request }) => {
    const res = await request.get(
      `${service.base}/api/dictionary/lookup?word=${encodeURIComponent('nasa')}`,
    );
    expect(res.status()).toBe(200);
    expect((await res.json()).entry.word).toBe('NASA');
  });

  test('撇号与连字符词条命中（ECDICT 收录 ’hood、-gate）', async ({ request }) => {
    for (const word of ["'hood", '-gate']) {
      const res = await request.get(
        `${service.base}/api/dictionary/lookup?word=${encodeURIComponent(word)}`,
      );
      expect(res.status()).toBe(200);
      expect((await res.json()).entry.word).toBe(word);
    }
  });

  test('未收录词条：404 明确反馈', async ({ request }) => {
    const res = await request.get(
      `${service.base}/api/dictionary/lookup?word=${encodeURIComponent('zzznosuchword')}`,
    );
    expect(res.status()).toBe(404);
    expect(await res.json()).toEqual({ error: 'entry not found' });
  });

  test('非法参数：缺少 word / 仅空白 → 400', async ({ request }) => {
    expect((await request.get(`${service.base}/api/dictionary/lookup`)).status()).toBe(400);
    expect(
      (await request.get(`${service.base}/api/dictionary/lookup?word=${encodeURIComponent('   ')}`)).status(),
    ).toBe(400);
  });

  test('超长查询：与「未收录」同一语义（404），不再报非法参数', async ({ request }) => {
    const long = 'a'.repeat(81);
    const res = await request.get(
      `${service.base}/api/dictionary/lookup?word=${encodeURIComponent(long)}`,
    );
    expect(res.status()).toBe(404);
    expect((await res.json()).error).toBe('entry not found');
  });

  test('解析服务不可用仍可查词（词典查询是纯本地文件操作，断网可查）', async () => {
    // 独立服务 + 独立 mock：关闭解析服务后查词仍命中，证明词典不依赖任何外部服务。
    const localMock = await startMockDocling({});
    const localService = await startService({
      env: { READEVA_DOCLING_URL: localMock.base, READEVA_ECDICT_DIR: dictDir },
    });
    try {
      await localMock.close();
      const res = await fetch(
        `${localService.base}/api/dictionary/lookup?word=${encodeURIComponent('pressure')}`,
      );
      expect(res.status).toBe(200);
      expect((await res.json()).entry.word).toBe('pressure');
    } finally {
      await stopService(localService);
    }
  });
});

/* ---------------- 浏览器流程（选词 → 查词 → 卡片） ---------------- */

async function dblclickPanelWord(page, word) {
  const point = await page.evaluate((target) => {
    const root = document.querySelector('#parse-content');
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const index = node.textContent.indexOf(target);
      if (index >= 0) {
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + target.length);
        const rect = range.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      }
    }
    return null;
  }, word);
  expect(point, `面板中找不到目标词: ${word}`).not.toBeNull();
  await page.mouse.dblclick(point.x, point.y);
}

/**
 * 选中面板里包含指定文本的整个元素（用于超长选文场景：
 * 模拟用户拖选一整段，而不是双击一个词）。
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

test.describe('选词查词浏览器流程', () => {
  async function openReader(page) {
    await page.goto(`${service.base}/#/read/${docId}`);
    await expect(page.locator('#parse-content .parse-block').first()).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#selection-toolbar')).toBeHidden();
  }

  test('双击选词 → 查词 → 卡片展示释义、音标、标签与元信息', async ({ page }) => {
    await openReader(page);
    await dblclickPanelWord(page, 'identity');
    await expect(page.locator('#selection-toolbar')).toBeVisible();
    await page.locator('#dict-lookup-button').click();

    await expect(page.locator('#dict-card')).toBeVisible();
    await expect(page.locator('#dict-word')).toHaveText('identity');
    await expect(page.locator('#dict-phonetic')).toHaveText("aɪ'dentəti");
    await expect(page.locator('#dict-translation-text')).toContainText('身份');
    await expect(page.locator('#dict-definition-text')).toContainText('who or what a person or thing is');
    await expect(page.locator('#dict-meta .dict-tag')).toHaveText(['高考', '六级', '考研', '雅思']);
    await expect(page.locator('#dict-meta .dict-facts')).toContainText('柯林斯 ★★');
    await expect(page.locator('#dict-meta .dict-facts')).toContainText('牛津核心');
    await expect(page.locator('.dict-card-footer')).toContainText('ECDICT');
    await expect(page.locator('#dict-status')).toBeHidden();
  });

  test('页脚展示真实归因（MIT 许可 + 上游数据来源）', async ({ page }) => {
    await openReader(page);
    await dblclickPanelWord(page, 'identity');
    await page.locator('#dict-lookup-button').click();
    await expect(page.locator('#dict-card')).toBeVisible();

    const footer = page.locator('#dict-attribution');
    await expect(footer).toContainText('MIT License');
    await expect(footer).toContainText('ECDICT');
    await expect(footer).toContainText('离线查询');
    // 上游数据来源来自构建产物 manifest.json（固定样例 ECDICT 来源声明）。
    await expect(footer).toContainText('数据来源');
    await expect(footer).toContainText('EDictAZ');
    await expect(footer).toContainText('cdict-1.0-1');
    await expect(footer).toContainText('BNC');
    // 不再是旧的静态文案。
    await expect(footer).not.toHaveText('释义来自本地 ECDICT 词典（MIT License）· 离线查询');
  });

  test('点查词后工具条消失；关闭按钮收起卡片，Escape 隐藏工具条', async ({ page }) => {
    await openReader(page);
    await dblclickPanelWord(page, 'identity');
    await page.locator('#dict-lookup-button').click();
    await expect(page.locator('#dict-card')).toBeVisible();
    await expect(page.locator('#selection-toolbar')).toBeHidden();
    await page.locator('#dict-close').click();
    await expect(page.locator('#dict-card')).toBeHidden();

    await dblclickPanelWord(page, 'provenance');
    await expect(page.locator('#selection-toolbar')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#selection-toolbar')).toBeHidden();
  });

  test('未收录词条：卡片明确反馈（无词条情况）', async ({ page }) => {
    await openReader(page);
    await dblclickPanelWord(page, 'document');
    await page.locator('#dict-lookup-button').click();
    await expect(page.locator('#dict-card')).toBeVisible();
    await expect(page.locator('#dict-word')).toHaveText('document');
    await expect(page.locator('#dict-status')).toContainText('词典未收录「document」');
    // 首版不维护查词历史：查询不写入任何本地存储。
    const keys = await page.evaluate(() => Object.keys(window.localStorage));
    expect(keys.filter((key) => /dict|lookup|history|word/i.test(key))).toEqual([]);
  });

  test('超长选文：按「未收录」反馈（不再报非法参数）', async ({ page }) => {
    await openReader(page);
    await selectPanelText(page, 'The reading position of this document');
    await page.locator('#dict-lookup-button').click();
    await expect(page.locator('#dict-card')).toBeVisible();
    await expect(page.locator('#dict-status')).toContainText('词典未收录');
    // 卡片里只展示前 40 字符（完整选文仍在服务端按未收录处理）。
    await expect(page.locator('#dict-word')).toContainText('The reading position of this documen');
  });

  test('词典数据未准备：明确提示准备步骤', async ({ page }) => {
    // 独立服务：显式指向空目录（不依赖真实数据是否已构建）；配 mock Docling 供面板渲染。
    const emptyDict = fs.mkdtempSync(path.join(os.tmpdir(), 'readeva-dict-empty-'));
    const mock2 = await startMockDocling({});
    const service2 = await startService({
      env: { READEVA_DOCLING_URL: mock2.base, READEVA_ECDICT_DIR: emptyDict },
    });
    try {
      const res = await fetch(`${service2.base}/api/documents/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/pdf', 'x-filename': 'sample-a.pdf' },
        body: fs.readFileSync(FIXTURE_A),
      });
      const docId2 = (await res.json()).document.id;
      await page.goto(`${service2.base}/#/read/${docId2}`);
      await expect(page.locator('#parse-content .parse-block').first()).toBeVisible({ timeout: 15000 });
      await dblclickPanelWord(page, 'identity');
      await page.locator('#dict-lookup-button').click();
      await expect(page.locator('#dict-card')).toBeVisible();
      await expect(page.locator('#dict-status')).toContainText('离线词典数据未准备');
      await expect(page.locator('#dict-status')).toContainText('README');
      // 无归因信息（词典未准备）：页脚降级为静态文案。
      await expect(page.locator('#dict-attribution')).toHaveText(
        '释义来自本地 ECDICT 词典（MIT License）· 离线查询',
      );
    } finally {
      await stopService(service2);
      await mock2.close();
    }
  });
});
