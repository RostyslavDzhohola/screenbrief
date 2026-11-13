// "Fetch it later": when `screenbrief pull <id>` cannot get the video (the phone is out of reach
// and nothing is attached), the request is remembered. `screenbrief watch` runs every two minutes
// under launchd; when a remembered recording becomes available it is pulled and processed, and
// the thread that asked gets a message with the FEEDBACK.md path.
//
// With nothing remembered a pass does nothing at all: it never touches the phone.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, readJsonSync, BIN_PATH_PREFIX } from './util.mjs';
import { paths, CLI_PATH, PACKAGE_DIR } from './config.mjs';

export const WATCH_LABEL = 'com.screenbrief.watch';
export const WATCH_INTERVAL_SEC = 120;
const MAX_AGE_DAYS = 14;
const ID_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;

export const waitingDir = () => path.join(paths().home, 'waiting');
const waiterFile = (id) => path.join(waitingDir(), `${id}.json`);

/** Remember that `threadId` (may be null) is waiting for recording `id`. */
export function rememberWaiter(id, { threadId = null, t3Bin = null, now = Date.now() } = {}) {
  if (!ID_RE.test(String(id))) return null;
  fs.mkdirSync(waitingDir(), { recursive: true });
  const old = readJsonSync(waiterFile(id), null);
  const waiter = {
    id,
    // A later request from another thread replaces the earlier one: the newest asker is told.
    threadId: threadId || (old && old.threadId) || null,
    t3Bin: t3Bin || (old && old.t3Bin) || null,
    requestedAt: (old && old.requestedAt) || new Date(now).toISOString(),
  };
  fs.writeFileSync(waiterFile(id), JSON.stringify(waiter, null, 2) + '\n');
  return waiter;
}

export function forgetWaiter(id) {
  fs.rmSync(waiterFile(id), { force: true });
}

/** Requests still waiting, oldest first. Ones older than two weeks are dropped. */
export function listWaiters({ now = Date.now() } = {}) {
  let names = [];
  try {
    names = fs.readdirSync(waitingDir());
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const w = readJsonSync(path.join(waitingDir(), n), null);
    if (!w || !ID_RE.test(String(w.id)) || `${w.id}.json` !== n) continue;
    const at = Date.parse(w.requestedAt || '');
    if (!Number.isFinite(at) || now - at > MAX_AGE_DAYS * 86_400_000) {
      forgetWaiter(w.id);
      continue;
    }
    out.push(w);
  }
  return out.sort((a, b) => String(a.requestedAt).localeCompare(String(b.requestedAt)));
}

/** What the waiting thread is sent once the recording is on the Mac. */
export function messageFor(id, feedbackPath) {
  return (
    `The video for phone feedback recording ${id} is on the Mac now (fetched automatically by screenbrief watch).\n` +
    `Read ${feedbackPath}: what I said on a timeline next to screenshots of the screen at each moment. ` +
    `Open the frames, then make the changes I described in that recording.`
  );
}

/** `screenbrief pull <id>` as a child process: { ok, feedbackPath } or { ok: false, detail }. */
async function pullChild(id) {
  const r = await run(process.execPath, [CLI_PATH, 'pull', id], { env: { ...process.env, SCREENBRIEF_WATCHER: '1' }, allowFail: true, timeoutMs: 30 * 60_000 });
  const last = r.stdout.trim().split('\n').pop() || '';
  if (r.code === 0 && last.endsWith('FEEDBACK.md') && fs.existsSync(last)) return { ok: true, feedbackPath: last };
  return { ok: false, detail: r.stderr.trim().split('\n').slice(0, 3).join(' | ') };
}

function t3BinFor(waiter) {
  const cands = [process.env.SCREENBRIEF_T3_BIN, waiter.t3Bin, process.env.T3CODE_CLI_PATH, '/opt/homebrew/bin/t3', path.join(os.homedir(), '.t3', 'bin', 't3')];
  return cands.find((c) => c && fs.existsSync(c)) || 't3';
}

async function notifyThread(waiter, feedbackPath) {
  await run(t3BinFor(waiter), ['thread', 'send', waiter.threadId, '-'], { input: messageFor(waiter.id, feedbackPath), timeoutMs: 60_000 });
}

/**
 * One pass over the waiting requests. Returns [{ id, state, detail? }] with state one of
 * 'waiting' (still not available), 'delivered' (processed and the thread told),
 * 'ready' (processed; nobody to tell), 'notify-failed' (processed; telling the thread failed and
 * is tried again on the next pass).
 */
export async function watchOnce({ pull = pullChild, notify = notifyThread, log = () => {}, now = Date.now() } = {}) {
  const results = [];
  for (const w of listWaiters({ now })) {
    const got = await pull(w.id);
    if (!got.ok) {
      results.push({ id: w.id, state: 'waiting', detail: got.detail });
      continue;
    }
    if (!w.threadId) {
      forgetWaiter(w.id);
      log(`${w.id}: processed (${got.feedbackPath}); no thread to tell`);
      results.push({ id: w.id, state: 'ready', feedbackPath: got.feedbackPath });
      continue;
    }
    try {
      await notify(w, got.feedbackPath);
      forgetWaiter(w.id);
      log(`${w.id}: processed and thread ${w.threadId} told`);
      results.push({ id: w.id, state: 'delivered', feedbackPath: got.feedbackPath });
    } catch (e) {
      log(`${w.id}: processed, but telling thread ${w.threadId} failed: ${e.message}`);
      results.push({ id: w.id, state: 'notify-failed', feedbackPath: got.feedbackPath, detail: e.message });
    }
  }
  return results;
}

/** Runs `fn` unless another pass is running (a lock file with a live pid, at most 40 minutes old). */
export async function withWatchLock(fn) {
  fs.mkdirSync(waitingDir(), { recursive: true });
  const lock = path.join(waitingDir(), '.lock');
  const held = readJsonSync(lock, null);
  if (held && Date.now() - held.at < 40 * 60_000) {
    try {
      process.kill(held.pid, 0);
      return null; // still running
    } catch {
      /* stale */
    }
  }
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }));
  try {
    return await fn();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

// ---- launchd -----------------------------------------------------------------------------------

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const domain = () => `gui/${process.getuid()}`;

export function watchPlistPath() {
  return process.env.SCREENBRIEF_WATCH_PLIST || path.join(os.homedir(), 'Library', 'LaunchAgents', `${WATCH_LABEL}.plist`);
}

export const watchInstalled = () => fs.existsSync(watchPlistPath());

/** launchd's PATH has no Homebrew and no nvm, so node is named by absolute path. */
function nodePath() {
  return ['/opt/homebrew/bin/node', '/usr/local/bin/node'].find((p) => fs.existsSync(p)) || process.execPath;
}

export function watchPlistXml() {
  const env = { PATH: BIN_PATH_PREFIX, HOME: os.homedir() };
  if (process.env.SCREENBRIEF_HOME) env.SCREENBRIEF_HOME = paths().home;
  const envXml = Object.entries(env).map(([k, v]) => `      <key>${xml(k)}</key>\n      <string>${xml(v)}</string>`).join('\n');
  const logFile = path.join(paths().home, 'watch.log');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${WATCH_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${xml(nodePath())}</string>
      <string>${xml(CLI_PATH)}</string>
      <string>watch</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${xml(PACKAGE_DIR)}</string>
    <key>EnvironmentVariables</key>
    <dict>
${envXml}
    </dict>
    <key>StartInterval</key>
    <integer>${WATCH_INTERVAL_SEC}</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>${xml(logFile)}</string>
    <key>StandardErrorPath</key>
    <string>${xml(logFile)}</string>
  </dict>
</plist>
`;
}

export async function installWatch() {
  const file = watchPlistPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(paths().home, { recursive: true });
  await run('/bin/launchctl', ['bootout', `${domain()}/${WATCH_LABEL}`], { allowFail: true, timeoutMs: 20_000 });
  fs.writeFileSync(file, watchPlistXml());
  await run('/usr/bin/plutil', ['-lint', file], { timeoutMs: 10_000 });
  await run('/bin/launchctl', ['bootstrap', domain(), file], { timeoutMs: 20_000 });
  return file;
}

export async function uninstallWatch() {
  const file = watchPlistPath();
  await run('/bin/launchctl', ['bootout', `${domain()}/${WATCH_LABEL}`], { allowFail: true, timeoutMs: 20_000 });
  const existed = fs.existsSync(file);
  fs.rmSync(file, { force: true });
  return { file, removed: existed };
}
