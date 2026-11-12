// Small shared helpers: child processes, time formatting, atomic JSON files.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const BIN_PATH_PREFIX = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';

/** Environment for child processes: launchd gives a bare PATH, so make sure Homebrew is on it. */
export function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  const parts = (env.PATH || '').split(':').filter(Boolean);
  for (const p of BIN_PATH_PREFIX.split(':')) if (!parts.includes(p)) parts.push(p);
  env.PATH = parts.join(':');
  return env;
}

export class CommandError extends Error {
  constructor(message, { code, stderr, stdout, timedOut } = {}) {
    super(message);
    this.code = code;
    this.stderr = stderr;
    this.stdout = stdout;
    this.timedOut = timedOut;
  }
}


/**
 * Run a command without a shell. Resolves { code, stdout, stderr }; rejects on spawn
 * failure, timeout, or a non-zero exit (unless allowFail).
 */
export function run(cmd, args, opts = {}) {
  const { timeoutMs = 0, input, env, cwd, allowFail = false, maxBuffer = 64 * 1024 * 1024, onStderrLine, encoding = 'utf8' } = opts;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, env: env || childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      reject(new CommandError(`could not start ${cmd}: ${err.message}`, {}));
      return;
    }
    const out = [];
    let outLen = 0;
    let err = '';
    let timedOut = false;
    let pendingLine = '';
    let timer;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);
    }
    child.stdout.on('data', (d) => {
      outLen += d.length;
      if (outLen <= maxBuffer) out.push(d);
    });
    child.stderr.on('data', (d) => {
      const s = d.toString('utf8');
      if (err.length < 4 * 1024 * 1024) err += s;
      if (onStderrLine) {
        pendingLine += s;
        const lines = pendingLine.split(/\r?\n|\r/);
        pendingLine = lines.pop();
        for (const line of lines) onStderrLine(line);
      }
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new CommandError(`could not start ${cmd}: ${e.message}`, { stderr: err }));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const buf = Buffer.concat(out);
      const stdout = encoding === 'buffer' ? buf : buf.toString('utf8');
      if (timedOut) {
        reject(new CommandError(`${path.basename(cmd)} timed out after ${Math.round(timeoutMs / 1000)}s`, { code, stderr: err, stdout, timedOut: true }));
        return;
      }
      const exit = code === null ? 128 : code;
      if (exit !== 0 && !allowFail) {
        const tail = err.trim().split('\n').slice(-6).join('\n');
        reject(new CommandError(`${path.basename(cmd)} exited with ${code ?? signal}: ${tail}`, { code: exit, stderr: err, stdout }));
        return;
      }
      resolve({ code: exit, stdout, stderr: err });
    });
    child.stdin.on('error', () => {});
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

/** Run async tasks with a concurrency limit, preserving result order. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/** 37.42 -> "00:37.4"; 3725.1 -> "62:05.1" (minutes keep counting past 60). */
export function fmtTime(sec, decimals = 1) {
  const s = Math.max(0, Number(sec) || 0);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  let r = rest.toFixed(decimals);
  if (Number(r) >= 60) return fmtTime(Math.round(s), decimals);
  const [whole, frac] = r.split('.');
  return `${String(m).padStart(2, '0')}:${whole.padStart(2, '0')}${frac !== undefined ? '.' + frac : ''}`;
}

/** 37.42 -> "00m37s4" (file-name safe). */
export function fmtTimeForName(sec) {
  const tenths = Math.round(Math.max(0, sec) * 10);
  const m = Math.floor(tenths / 600);
  const s = Math.floor((tenths % 600) / 10);
  const d = tenths % 10;
  return `${String(m).padStart(2, '0')}m${String(s).padStart(2, '0')}s${d}`;
}

/** 182 -> "3m 02s"; 9.4 -> "9s". */
export function fmtDuration(sec) {
  const s = Math.round(Math.max(0, Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m ${String(r).padStart(2, '0')}s`;
  if (m) return `${m}m ${String(r).padStart(2, '0')}s`;
  return `${r}s`;
}

/** Local "YYYYMMDD-HHMMSS". */
export function stampLocal(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

/** Local "2026-11-11 20:41". */
export function humanLocal(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
}

export function randomId() {
  return crypto.randomUUID();
}

/** First 8 alphanumerics of an id, lowercased. */
export function id8(id) {
  const s = String(id).toLowerCase().replace(/[^a-z0-9]/g, '');
  return (s || crypto.randomBytes(4).toString('hex')).slice(0, 8).padEnd(8, '0');
}

export async function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2) + '\n');
  await fsp.rename(tmp, file);
}

export function readJsonSync(file, fallback = undefined) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

export function log(...args) {
  const ts = new Date().toISOString();
  console.error(`[${ts}]`, ...args);
}
