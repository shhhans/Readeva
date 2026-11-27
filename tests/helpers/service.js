import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SERVER_ENTRY = path.resolve('server/index.js');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function launch(dataDir, port, host) {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      process.execPath,
      [SERVER_ENTRY],
      {
        env: {
          ...process.env,
          READEVA_PORT: String(port),
          READEVA_HOST: host,
          READEVA_DATA_DIR: dataDir,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (err, base) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.stdout.removeAllListeners('data');
      proc.stderr.removeAllListeners('data');
      proc.removeAllListeners('exit');
      if (err) reject(err);
      else resolve({ proc, base, dataDir, port: String(new URL(base).port) });
    };

    const timer = setTimeout(() => {
      finish(new Error(`service start timeout\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, 20_000);

    proc.stdout.on('data', (chunk) => {
      stdout += chunk;
      const match = stdout.match(/listening on (http:\/\/\S+)/);
      if (match) finish(null, match[1]);
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    proc.on('exit', (code, signal) => {
      const err = new Error(
        `service exited early (code=${code} signal=${signal})\nstdout: ${stdout}\nstderr: ${stderr}`,
      );
      if (/EADDRINUSE/.test(stderr)) err.code = 'EADDRINUSE';
      finish(err);
    });
  });
}

/**
 * 启动独立服务进程（与生产 `npm start` 相同入口）。
 * port=0 时由 OS 分配端口并从服务输出解析实际地址。
 */
export async function startService({ dataDir, port = 0, host = '127.0.0.1' } = {}) {
  const dir = dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'readeva-e2e-'));
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      return await launch(dir, port, host);
    } catch (err) {
      if (err.code === 'EADDRINUSE' && port !== 0 && attempt < 6) {
        await delay(400 * attempt);
        continue;
      }
      throw err;
    }
  }
}

export function stopService(service) {
  return new Promise((resolve) => {
    const proc = service?.proc;
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) {
      resolve();
      return;
    }
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    proc.once('exit', finish);
    proc.kill();
    setTimeout(() => {
      if (!done) {
        try {
          proc.kill('SIGKILL');
        } catch {
          /* 已退出 */
        }
        finish();
      }
    }, 5000);
  });
}
