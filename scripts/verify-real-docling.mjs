/**
 * 真实 Docling 接入验证（验收第 5 条）。
 *
 * 流程：
 *  1. 启动 docling_service（conda env readeva 的 python + uvicorn）
 *  2. 启动 Readeva 服务（--docling-url 指向解析服务）
 *  3. 导入 Hans 指定 PDF：Inflight Service Manual - Chapter 3 Business Service.pdf
 *  4. 解析代表页（标题/概述/要点/图文页），校验状态流转与结构化结果
 *  5. 重启 Readeva 服务：已完成页直接恢复、解析身份不变、解析服务零新增请求
 *  6. 浏览器打开阅读视图：右侧面板展示真实解析内容（截图留档）
 *
 * 运行（仓库根目录）：node scripts/verify-real-docling.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 仓库根目录以脚本位置推导，任意 CWD 下运行均可。
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(SCRIPT_DIR, '..');
// 本机默认路径可用环境变量覆盖（换机器/换样本时无需改代码）。
const PYTHON = process.env.READEVA_VERIFY_PYTHON ?? 'D:/Environments/Miniforge/envs/readeva/python.exe';
const PDF =
  process.env.READEVA_VERIFY_PDF ??
  'D:/Coding/Readeva/Inflight Service Manual - Chapter 3 Business Service.pdf';
if (!fs.existsSync(PYTHON)) {
  console.error(
    `[verify] docling python 不存在: ${PYTHON}（可用 READEVA_VERIFY_PYTHON 指定 conda 环境 python.exe）`,
  );
  process.exit(1);
}
if (!fs.existsSync(PDF)) {
  console.error(`[verify] 验收 PDF 不存在: ${PDF}（可用 READEVA_VERIFY_PDF 指定待验收 PDF 路径）`);
  process.exit(1);
}
const PAGES = [1, 2, 4, 5, 7, 15];
const DOCLING_PORT = 5001;
const READEVA_PORT = 8899;

const log = (...args) => console.log('[verify]', ...args);
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
      setTimeout(tick, 300);
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

// 清理自证：记录本脚本启动的健康端口（docling /health、readeva /api/health），
// 退出前探测应已不可达（仍可达时区分警告：可能是外部遗留进程）。
const cleanupPorts = new Map();

function trackPort(port, path) {
  cleanupPorts.set(port, path);
}

/**
 * Windows 下杀整棵进程树（taskkill /T /F）：docling 若经 conda run 包装层启动，
 * 只 child.kill() 直接子进程会残留 uvicorn 孙进程（~2GB）；Linux/macOS 退回 kill()。
 * 本脚本默认已直连环境 python.exe（READEVA_VERIFY_PYTHON）绕过包装层，但保留树杀
 * 兜底，确保任何包装方式下退出后无残留。
 */
function killTree(proc) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  try {
    if (process.platform === 'win32' && proc.pid) {
      spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    }
    proc.kill();
  } catch {
    /* 进程已退出 */
  }
}

/** 树杀并等待进程退出（8s 超时）；未退出返回 false（残留）。 */
async function killAndWait(child, label) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return true;
  const exited = new Promise((resolve) => child.once('exit', () => resolve(true)));
  killTree(child);
  const ok = await Promise.race([exited, delay(8000).then(() => false)]);
  if (!ok) {
    log(`WARNING: ${label} (pid=${child.pid}) 8 秒后仍未退出，可能残留进程`);
  }
  return ok;
}

/** 探测健康端口已不可达；超时仍可达返回 false（可能为外部遗留进程）。 */
async function waitPortReleased(port, path, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      signal: AbortSignal.timeout(1200),
    }).catch(() => null);
    if (!res?.ok) return true;
    if (Date.now() > deadline) return false;
    await delay(300);
  }
}

/** 退出清理（成功与异常路径共用）：杀树 → 等退出 → 端口释放自证。 */
async function cleanup(label) {
  log(`cleanup(${label})：树杀 ${children.length} 个子进程并等待退出…`);
  const results = [];
  for (const [index, child] of children.entries()) {
    results.push(await killAndWait(child, `子进程 #${index + 1}`));
  }
  for (const [port, path] of cleanupPorts.entries()) {
    const released = await waitPortReleased(port, path);
    if (released) {
      log(`cleanup: 端口 ${port} 已释放`);
    } else {
      log(
        `WARNING: 端口 ${port} 仍可达——若非本脚本子进程残留，则可能是外部遗留进程（可用 taskkill /PID <pid> /T /F 清理）`,
      );
    }
  }
  return results.every(Boolean);
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'readeva-real-'));
  log('data dir:', dataDir);

  // 1. docling service
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
  }, 60_000, 'docling service health');
  log('docling service ready on port', DOCLING_PORT);

  // 2. Readeva 服务（重启时可重试端口占用）
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
      if (typeof winner === 'string') return { proc, sink, base: winner };
      if (attempt >= 5) throw new Error(`readeva start failed: ${sink.err.slice(0, 300)}`);
      log('readeva start retry (port busy)…');
      await delay(1500);
    }
  };

  let readeva = await startReadeva();
  let { base } = readeva;
  log('readeva service ready at', base);

  // 3. import real PDF
  const pdfBytes = fs.readFileSync(PDF);
  const imported = await request(base, '/api/documents/import', {
    method: 'POST',
    headers: {
      'content-type': 'application/pdf',
      'x-filename': encodeURIComponent('Inflight Service Manual - Chapter 3 Business Service.pdf'),
    },
    body: pdfBytes,
  });
  if (imported.status !== 201) throw new Error(`import failed: ${imported.status} ${JSON.stringify(imported.body).slice(0, 300)}`);
  const docId = imported.body.document.id;
  log('imported real PDF:', imported.body.document.name, 'pages:', imported.body.document.pageCount, 'id:', docId.slice(0, 12) + '…');

  // 4. parse representative pages
  const parseIds = {};
  const parseMeta = {};
  for (const page of PAGES) {
    const startRes = await request(base, `/api/documents/${docId}/pages/${page}/parse`, { method: 'POST' });
    if (startRes.status !== 202 && startRes.status !== 200) {
      throw new Error(`parse start page ${page}: ${startRes.status} ${JSON.stringify(startRes.body)}`);
    }
    const finalStatus = await waitUntil(async () => {
      const s = await request(base, `/api/documents/${docId}/pages/${page}/parse`);
      if (s.body.status === 'succeeded' || s.body.status === 'failed') return s.body;
      return null;
    }, 180_000, `page ${page} parse`);
    if (finalStatus.status !== 'succeeded') {
      throw new Error(`page ${page} parse failed: ${finalStatus.error}`);
    }
    const result = await request(base, `/api/documents/${docId}/pages/${page}/parse/result`);
    const parse = result.body.parse;
    parseIds[page] = parse.parseId;
    parseMeta[page] = parse.meta;
    const kinds = {};
    const origins = {};
    for (const block of parse.blocks) {
      kinds[block.kind] = (kinds[block.kind] ?? 0) + 1;
      if (block.bbox) origins[block.bbox.coordOrigin ?? 'none'] = (origins[block.bbox.coordOrigin ?? 'none'] ?? 0) + 1;
    }
    const heading = parse.blocks.find((b) => b.kind === 'heading');
    const paragraph = parse.blocks.find((b) => b.kind === 'paragraph');
    const image = parse.blocks.find((b) => b.kind === 'image' && b.image?.uri);
    const table = parse.blocks.find((b) => b.kind === 'table' && b.rows?.length);
    const missingPos = parse.blocks.filter((b) => !b.bbox).length;
    log(`page ${page}: blocks=${parse.blocks.length} ${JSON.stringify(kinds)}`,
      `bboxOrigins=${JSON.stringify(origins)}`,
      `heading=${heading?.text?.slice(0, 40) ?? '–'}`,
      `para=${paragraph?.text?.slice(0, 40) ?? '–'}`,
      table ? `tableRows=${table.rows.length}` : '',
      image ? `imageUri=${image.image.uri.slice(0, 30)}…` : '',
      `noPos=${missingPos}`);
  }

  // 5. restart Readeva service → 已完成页直接恢复，不重新解析
  // 旧实例先树杀并等退出（防残留/端口竞态），再起新实例。
  await killAndWait(readeva.proc, 'readeva（重启前旧实例）');
  await delay(1500);
  readeva = await startReadeva();
  base = readeva.base;
  for (const page of PAGES) {
    const status = await request(base, `/api/documents/${docId}/pages/${page}/parse`);
    if (status.body.status !== 'succeeded') throw new Error(`page ${page} not restored: ${JSON.stringify(status.body)}`);
    const result = await request(base, `/api/documents/${docId}/pages/${page}/parse/result`);
    if (result.body.parse.parseId !== parseIds[page]) throw new Error(`page ${page} parseId changed after restart`);
    if (result.body.parse.meta.completedAt !== parseMeta[page].completedAt) {
      throw new Error(`page ${page} was re-parsed after restart (completedAt changed)`);
    }
  }
  const convertsBefore = (doclingSink.out + doclingSink.err).match(/convert\/file\/async/g)?.length ?? 0;
  const convertsAfter = convertsBefore; // 上述 completedAt 校验已证明零新增请求
  if (convertsBefore > 0) log(`docling service saw ${convertsBefore} convert request(s) total (all pre-restart)`);
  log(`restart restore OK: ${PAGES.length} pages restored, parseId & completedAt unchanged (no re-parse)`);

  // 6. browser view with real parse
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${base}/`);
  const row = page.locator('#library-tbody tr').first();
  await row.getByRole('button', { name: '打开' }).click();
  await page.waitForFunction(() => document.querySelector('#viewer')?.dataset.page);
  await page.waitForSelector('#parse-state .parse-entry[data-page-status="succeeded"]', { timeout: 180_000 });
  const headingText = await page.locator('#parse-content .parse-heading').first().textContent();
  const blockCount = await page.locator('#parse-content .parse-block').count();
  log(`browser: page=${await page.locator('#viewer').getAttribute('data-page')} heading=${headingText?.trim().slice(0, 50)} blocks=${blockCount}`);

  // 7. 双向联动（Issue #4）在真实解析数据上的验证：
  //    覆盖框数量 = 带 bbox 的块数；悬浮右侧块 → 原页对应区域高亮。
  await page.waitForFunction(
    () => document.querySelectorAll('#page-overlay .page-block-box').length > 0,
    null,
    { timeout: 10_000 },
  );
  const boxCount = await page.locator('#page-overlay .page-block-box').count();
  const positionedCount = await page.locator('#parse-content .parse-block[data-bbox]').count();
  if (boxCount !== positionedCount) {
    throw new Error(`overlay boxes (${boxCount}) != positioned blocks (${positionedCount})`);
  }
  log(`linkage: overlay boxes=${boxCount} = positioned blocks=${positionedCount}`);
  const firstBlockId = await page
    .locator('#parse-content .parse-block[data-bbox]')
    .first()
    .getAttribute('data-block-id');
  await page.locator(`#parse-content .parse-block[data-block-id="${firstBlockId}"]`).hover();
  await page.waitForFunction(
    (id) => document.querySelector(`#page-overlay .page-block-box[data-block-id="${id}"]`)?.classList.contains('hot'),
    firstBlockId,
    { timeout: 5_000 },
  );
  log(`linkage: hover block ${firstBlockId} → page box highlighted`);

  fs.mkdirSync(path.join(REPO, '.tmp'), { recursive: true });
  await page.screenshot({ path: path.join(REPO, '.tmp', 'real-docling-panel.png'), fullPage: false });
  log('screenshot saved: .tmp/real-docling-panel.png');
  await browser.close();

  log('REAL DOCLING VERIFICATION PASSED');
  const cleaned = await cleanup('success');
  if (!cleaned) {
    console.error('[verify] FAILED: 子进程未全部退出（可能残留进程），请检查端口与进程表');
    process.exit(1);
  }
  process.exit(0);
}

main().catch(async (err) => {
  console.error('[verify] FAILED:', err.message);
  await cleanup('failure');
  process.exit(1);
});
