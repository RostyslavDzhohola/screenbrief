// Lock files shared by separate `screenbrief` processes (the launchd watcher, a pull an agent
// runs, a pull run by hand).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readJsonSync } from './util.mjs';

const MAX_AGE_MS = 6 * 3600_000;

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** Whether the lock at `file` is gone or was left by a process that no longer runs. */
function abandoned(file, maxAgeMs) {
  const held = readJsonSync(file, null);
  let age = Infinity;
  try {
    age = Date.now() - fs.statSync(file).mtimeMs;
  } catch {
    /* gone */
  }
  // A lock just created may not have its contents yet: it counts as held.
  return held ? !(pidAlive(held.pid) && age < maxAgeMs) : age >= 10_000;
}

/**
 * Takes the lock at `file`. Returns a function that releases it, or null when a live process
 * holds it.
 *
 * The file is created exclusively, so two processes starting together cannot both get it, and
 * it is removed only by the process that owns it. A lock whose process is gone (or that is over
 * six hours old) is replaced. Replacing happens under a second, short-lived lock and the lock is
 * looked at again there, so of several processes that saw the same abandoned lock only one
 * replaces it, and a lock taken in the meantime is never removed.
 */
export function tryLock(file, { maxAgeMs = MAX_AGE_MS } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const mine = { pid: process.pid, at: Date.now(), token: crypto.randomUUID() };
  const create = (target, body) => {
    try {
      fs.writeFileSync(target, body, { flag: 'wx' });
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      return false;
    }
  };
  const take = () => create(file, JSON.stringify(mine));
  if (!take()) {
    if (!abandoned(file, maxAgeMs)) return null;
    const replacing = `${file}.replacing`;
    if (!create(replacing, String(process.pid))) {
      // Someone else is replacing it. One left by a process that died right there is cleared,
      // and the next try gets through.
      try {
        if (Date.now() - fs.statSync(replacing).mtimeMs > 60_000) fs.rmSync(replacing, { force: true });
      } catch {
        /* gone */
      }
      return null;
    }
    try {
      if (!abandoned(file, maxAgeMs)) return null;
      fs.rmSync(file, { force: true });
      if (!take()) return null;
    } finally {
      fs.rmSync(replacing, { force: true });
    }
  }
  return () => {
    const now = readJsonSync(file, null);
    if (now && now.token === mine.token) fs.rmSync(file, { force: true });
  };
}

/**
 * Runs `fn` holding the lock at `file`, waiting up to `waitMs` for another process to release
 * it (`onWait` is called once when it has to wait). Throws when the wait runs out.
 */
export async function withLock(file, fn, { waitMs = 0, pollMs = 500, onWait = () => {}, maxAgeMs } = {}) {
  const deadline = Date.now() + waitMs;
  let release = tryLock(file, { maxAgeMs });
  let told = false;
  while (!release) {
    if (Date.now() >= deadline) throw new Error(`still locked by another screenbrief process: ${file}`);
    if (!told) onWait();
    told = true;
    await new Promise((r) => setTimeout(r, pollMs));
    release = tryLock(file, { maxAgeMs });
  }
  try {
    return await fn();
  } finally {
    release();
  }
}
