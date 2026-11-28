/**
 * 真实 MiniMax 接入验证（Issue #8 验收第 6 条的真实接入层）。
 *
 * 流程：
 *  1. 前置检查：MINIMAX_API_KEY 已设置（中国站密钥）、验收 PDF 存在
 *  2. 启动真实 Docling 服务（conda env readeva 的 python + uvicorn）
 *  3. 启动 Readeva 服务（不设 READEVA_MINIMAX_BASE_URL → 默认中国站
 *     https://api.minimax.cn/v1，模型固定 MiniMax-M3.1-Flash，密钥取环境变量）
 *  4. 导入 Hans 指定 PDF，解析代表页（第 15 页：标题/段落/列表/表格/图片齐备）
 *  5. 真实翻译：内容块（段落）+ 选文各一次 → 复用请求验证（reused，零新增调用）
 *  6. 重启 Readeva 服务：译文从服务端恢复（parseId 不变、复用语义不变）
 *  7. 浏览器打开阅读视图：点击内容块「翻译」按钮走真实链路，截图留档
 *
 * 运行（仓库根目录）：node scripts/verify-real-minimax.mjs
 * 密钥：环境变量 MINIMAX_API_KEY（中国站；脚本不打印、不落盘密钥）。
 * 可用环境变量：READEVA_VERIFY_PDF（默认 Hans 指定 PDF）、READEVA_VERIFY_PAGE
 * （默认 15）、READEVA_VERIFY_PYTHON（默认 conda readeva 环境的 python.exe）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(SCRIPT_DIR, '..');
const PYTHON = process.env.READEVA_VERIFY_PYTHON ?? 'D:/Environments/Miniforge/envs/readeva/python.exe';
const PDF =
  process.env.READEVA_VERIFY_PDF ??
  'D:/Coding/Readeva/Inflight Service Manual - Chapter 3 Business Service.pdf';
const VERIFY_PAGE = Number(process.env.READEVA_VERIFY_PAGE ?? 15);
const DOCLING_PORT = 5001;
const READEVA_PORT = 8899;
const API_KEY_ENV = 'MINIMAX_API_KEY';

const log = (...args) => console.log('[verify-minimax]', ...args);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function waitUntil(fn, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = async () => {
      try {
        const value = await fn();
        if (value) return resolve(value);
      } catch {
        /* retry */
      }
      if (Date.now() > deadline) return reject(new Error(`timeout: ${label}`));
      setTimeout(tick, 500);
    };
    tick();
  });
}

async function request(base, pathname, options = {}) {
  const res = await fetch(`${base}${pathname}`, options);
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

function capture(proc, sink) {
  proc.stdout.on('data', (d) => {
    sink.out += String(d);
  });
  proc.stderr.on('data', (d) => {
    sink.err += String(d);
  });
}

const children = [];
const cleanupPorts = new Map();

function trackPort(port, healthPath) {
  cleanupPorts.set(port, healthPath);
}

function killTree(proc) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  try {
    if (process.platform === 'win32' && proc.pid) {
      spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    }
    proc.kill();
  } catch {
    /* 已退出 */
  }
}

async function killAndWait(child, label) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return true;
  const exited = new Promise((resolve) => child.once('exit', () => resolve(true)));
  killTree(child);
  const ok = await Promise.race([exited, delay(8000).then(() => false)]);
  if (!ok) log(`WARNING: ${label} (pid=${child.pid}) 8 秒后仍未退出，可能残留进程`);
  return ok;
}

async function waitPortReleased(port, healthPath, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(`http://127.0.0.1:${port}${healthPath}`, {
      signal: AbortSignal.timeout(1200),
    }).catch(() => null);
    if (!res?.ok) return true;
    if (Date.now() > deadline) return false;
    await delay(300);
  }
}

async function cleanup(label) {
  log(`cleanup(${label})：树杀 ${children.length} 个子进程并等待退出…`);
  const results = [];
  for (const child of children) {
    results.push(await killAndWait(child, '子进程'));
  }
  for (const [port, healthPath] of cleanupPorts.entries()) {
    const released = await waitPortReleased(port, healthPath);
    log(released ? `cleanup: 端口 ${port} 已释放` : `WARNING: 端口 ${port} 仍可达（可能是外部遗留进程）`);
  }
  return results.every(Boolean);
}

/** 脱敏：任何输出都不携带密钥（防手滑；密钥只在出站请求头里使用）。 */
function assertNoKeyLeak(...values) {
  const key = process.env[API_KEY_ENV] ?? '';
  if (!key) return;
  for (const value of values) {
    if (typeof value === 'string' && value.includes(key)) {
      throw new Error('internal error: api key leaked into output');
    }
  }
}

async function main() {
  if (!process.env[API_KEY_ENV]) {
    console.error(
      `[verify-minimax] 未设置环境变量 ${API_KEY_ENV}（MiniMax 中国站密钥）。` +
        ' PowerShell: $env:MINIMAX_API_KEY="<key>"; CMD: set MINIMAX_API_KEY=<key> 后重试。',
    );
    process.exit(1);
  }
  if (!fs.existsSync(PYTHON)) {
    console.error(`[verify-minimax] docling python 不存在: ${PYTHON}（可用 READEVA_VERIFY_PYTHON 指定）`);
    process.exit(1);
  }
  if (!fs.existsSync(PDF)) {
    console.error(`[verify-minimax] 验收 PDF 不存在: ${PDF}（可用 READEVA_VERIFY_PDF 指定）`);
    process.exit(1);
  }

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'readeva-real-minimax-'));
  log('data dir:', dataDir);
  let ok = false;
  try {
    // 1. 真实 Docling 服务
    const doclingSink = { out: '', err: '' };
    const docling = spawn(
      PYTHON,
      ['-m', 'uvicorn', 'docling_service.main:app', '--host', '127.0.0.1', '--port', String(DOCLING_PORT)],
      { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    children.push(docling);
    trackPort(DOCLING_PORT, '/health');
    capture(docling, doclingSink);
    await waitUntil(async () => {
      const res = await fetch(`http://127.0.0.1:${DOCLING_PORT}/health`).catch(() => null);
      return res?.ok ? res : null;
    }, 120_000, 'docling service health');
    log('docling service ready on port', DOCLING_PORT);

    // 2. Readeva 服务（默认中国站 MiniMax 地址 + 环境变量密钥）
    const startReadeva = async () => {
      for (let attempt = 1; ; attempt += 1) {
        const sink = { out: '', err: '' };
        const proc = spawn(process.execPath, ['server/index.js'], {
          cwd: REPO,
          env: {
            ...process.env,
            READEVA_PORT: String(READEVA_PORT),
            READEVA_DATA_DIR: dataDir,
            READEVA_DOCLING_URL: `http://127.0.0.1:${DOCLING_PORT}`,
            // 注意：不设 READEVA_MINIMAX_BASE_URL → 默认 https://api.minimax.cn/v1（中国站）。
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        children.push(proc);
        trackPort(READEVA_PORT, '/api/health');
        capture(proc, sink);
        const exitedEarly = new Promise((resolve) => proc.once('exit', (code) => resolve(code)));
        const winner = await Promise.race([
          waitUntil(() => (/listening on (http:\/\/\S+)/.exec(sink.out)?.[1] ?? ''), 20_000, 'readeva start'),
          exitedEarly,
        ]);
        if (typeof winner === 'string') return { proc, base: winner };
        if (attempt >= 5) throw new Error(`readeva start failed: ${sink.err.slice(0, 300)}`);
        log('readeva start retry (port busy)…');
        await delay(1500);
      }
    };
    let readeva = await startReadeva();
    let base = readeva.base;
    log('readeva service ready at', base);

    const config = await request(base, '/api/translate/service');
    log('translate service:', JSON.stringify(config.body));
    if (!config.body.configured) throw new Error(`${API_KEY_ENV} 未被服务读到`);
    if (config.body.model !== 'MiniMax-M3.1-Flash') throw new Error(`模型不符: ${config.body.model}`);
    assertNoKeyLeak(JSON.stringify(config.body));

    // 3. 导入指定 PDF 并解析代表页
    const pdfBytes = fs.readFileSync(PDF);
    const imported = await request(base, '/api/documents/import', {
      method: 'POST',
      headers: {
        'content-type': 'application/pdf',
        'x-filename': encodeURIComponent('Inflight Service Manual - Chapter 3 Business Service.pdf'),
      },
      body: pdfBytes,
    });
    if (imported.status !== 201) throw new Error(`import failed: ${imported.status}`);
    const docId = imported.body.document.id;
    log('imported:', imported.body.document.name, 'pages:', imported.body.document.pageCount);

    const parseStart = await request(base, `/api/documents/${docId}/pages/${VERIFY_PAGE}/parse`, { method: 'POST' });
    if (parseStart.status !== 202 && parseStart.status !== 200) {
      throw new Error(`parse start: ${parseStart.status} ${JSON.stringify(parseStart.body)}`);
    }
    const finalStatus = await waitUntil(async () => {
      const s = await request(base, `/api/documents/${docId}/pages/${VERIFY_PAGE}/parse`);
      if (s.body.status === 'succeeded' || s.body.status === 'failed') return s.body;
      return null;
    }, 180_000, `page ${VERIFY_PAGE} parse`);
    if (finalStatus.status !== 'succeeded') throw new Error(`page ${VERIFY_PAGE} parse failed: ${finalStatus.error}`);
    const parse = (await request(base, `/api/documents/${docId}/pages/${VERIFY_PAGE}/parse/result`)).body.parse;
    const parseId = parse.parseId;
    const kinds = {};
    for (const block of parse.blocks) kinds[block.kind] = (kinds[block.kind] ?? 0) + 1;
    log(`page ${VERIFY_PAGE}: parseId=${parseId.slice(0, 10)}… blocks=${parse.blocks.length} ${JSON.stringify(kinds)}`);

    // 4. 真实翻译：内容块（段落）+ 选文
    const paragraph = parse.blocks.find((b) => b.kind === 'paragraph' && (b.text ?? '').trim().length > 40);
    if (!paragraph) throw new Error('no paragraph block to translate');
    const blockPost = await request(base, `/api/documents/${docId}/pages/${VERIFY_PAGE}/translations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parseId, source: { kind: 'block', blockId: paragraph.id } }),
    });
    if (blockPost.status !== 201) {
      throw new Error(`block translation failed: ${blockPost.status} ${JSON.stringify(blockPost.body).slice(0, 300)}`);
    }
    const blockTranslation = blockPost.body.translation;
    assertNoKeyLeak(JSON.stringify(blockPost.body));
    log(`块译文 [${blockTranslation.id}] model=${blockTranslation.model}:`);
    log('  原文:', paragraph.text.slice(0, 120).replace(/\s+/g, ' '));
    log('  译文:', blockTranslation.text.slice(0, 160).replace(/\s+/g, ' '));

    const selectionText = paragraph.text.slice(0, 240);
    const selPost = await request(base, `/api/documents/${docId}/pages/${VERIFY_PAGE}/translations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parseId, source: { kind: 'selection', text: selectionText } }),
    });
    if (selPost.status !== 201) {
      throw new Error(`selection translation failed: ${selPost.status} ${JSON.stringify(selPost.body).slice(0, 300)}`);
    }
    const selTranslation = selPost.body.translation;
    assertNoKeyLeak(JSON.stringify(selPost.body));
    log(`选文译文 [${selTranslation.sourceKind}]:`, selTranslation.text.slice(0, 160).replace(/\s+/g, ' '));

    // 5. 复用：重复请求直接复用（不再调用真实服务）
    const reuse = await request(base, `/api/documents/${docId}/pages/${VERIFY_PAGE}/translations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parseId, source: { kind: 'block', blockId: paragraph.id } }),
    });
    if (reuse.status !== 200 || reuse.body.reused !== true) {
      throw new Error(`reuse failed: ${reuse.status} ${JSON.stringify(reuse.body).slice(0, 200)}`);
    }
    log('复用验证 OK：重复请求 reused=true（零新增上游调用）');

    // 6. 重启服务 → 译文从服务端恢复
    await killAndWait(readeva.proc, 'readeva（重启前旧实例）');
    await delay(1500);
    readeva = await startReadeva();
    base = readeva.base;
    const restored = await request(base, `/api/documents/${docId}/pages/${VERIFY_PAGE}/translations`);
    if (restored.body.parseId !== parseId) throw new Error('parseId changed after restart');
    const restoredIds = restored.body.translations.map((t) => t.id);
    if (!restoredIds.includes(blockTranslation.id) || !restoredIds.includes(selTranslation.id)) {
      throw new Error(`translations not restored: ${JSON.stringify(restoredIds)}`);
    }
    log(`重启恢复 OK：${restored.body.translations.length} 条译文从服务端取回（parseId 不变）`);

    // 7. 浏览器真实链路：点击内容块「翻译」按钮
    // 把阅读位置设到已解析的代表页：阅读器打开时直接落在该页，右侧面板立即
    // 渲染已保存解析与恢复译文（否则面板会等待第 1 页的真实解析）。
    await request(base, `/api/documents/${docId}/progress`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ page: VERIFY_PAGE, zoom: 1 }),
    });
    log('reading position set to page', VERIFY_PAGE);
    const { chromium } = await import('@playwright/test');
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('console', (m) => log('[console]', m.type(), m.text().slice(0, 150)));
    page.on('pageerror', (e) => log('[pageerror]', e.message.slice(0, 200)));
    await page.goto(`${base}/#/read/${docId}`);
    await waitUntil(
      async () => {
        const state = await page.evaluate(() => ({
          readerHidden: document.querySelector('#view-reader')?.hidden,
          readerError: document.querySelector('#reader-error')?.textContent,
          viewerPage: document.querySelector('#viewer')?.dataset.page ?? null,
          parseState: document.querySelector('#parse-state')?.textContent?.slice(0, 80),
          blocks: document.querySelectorAll('#parse-content .parse-block').length,
        }));
        log('page state:', JSON.stringify(state));
        return state.blocks > 0;
      },
      120_000,
      'parse blocks visible',
    );
    await page.waitForSelector('.block-translation[data-translation-state="done"]', { timeout: 30_000 });
    const restoredCount = await page.locator('.block-translation[data-translation-state="done"]').count();
    const reusedChips = await page.locator('.translation-reused').count();
    log(`浏览器：恢复译文 ${restoredCount} 条（复用标注 ${reusedChips} 处）`);
    // 找一个尚未翻译的段落块点击「翻译」（真实 MiniMax 调用）
    const blocks = page.locator('#parse-content .parse-block[data-block-id]');
    const total = await blocks.count();
    let translatedViaUi = null;
    for (let i = 0; i < total; i += 1) {
      const block = blocks.nth(i);
      const blockId = await block.getAttribute('data-block-id');
      const hasButton = await block.locator('.block-translate-button').count();
      const existing = await page.locator(`.block-translation[data-block-id="${blockId}"]`).count();
      if (hasButton > 0 && existing === 0) {
        await block.locator('.block-translate-button').click();
        translatedViaUi = await page
          .locator(`.block-translation[data-block-id="${blockId}"][data-translation-state="done"] .translation-text`)
          .textContent({ timeout: 120_000 });
        log(`浏览器真实翻译 block=${blockId}:`, String(translatedViaUi).slice(0, 120).replace(/\s+/g, ' '));
        break;
      }
    }
    if (!translatedViaUi) log('浏览器：本页所有可翻译块均已有译文（跳过 UI 新翻译）');
    fs.mkdirSync(path.join(REPO, '.tmp'), { recursive: true });
    await page.screenshot({ path: path.join(REPO, '.tmp', 'real-minimax-panel.png'), fullPage: false });
    log('截图已保存: .tmp/real-minimax-panel.png');
    await browser.close();

    ok = true;
    log('✅ 真实 MiniMax 接入验证全部通过（中国站 api.minimax.cn · MiniMax-M3.1-Flash）');
  } finally {
    await cleanup('exit');
  }
  if (!ok) process.exit(1);
}

main().catch((err) => {
  console.error('[verify-minimax] FAILED:', err.message);
  cleanup('failure').finally(() => process.exit(1));
});
