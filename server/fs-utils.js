import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * 原子写入。Windows 上目标文件被其他句柄打开时 rename 可能抛
 * EPERM/EBUSY/EACCES，短暂重试即可恢复。
 */
export async function writeFileAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.writeFileSync(tmp, data);
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      if (attempt < 4 && ['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) {
        await delay(50 * (attempt + 1));
        continue;
      }
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* 清理失败可忽略 */
      }
      throw err;
    }
  }
}
