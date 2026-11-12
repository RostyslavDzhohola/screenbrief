// Shared test helpers: fixture videos (generated once and cached), a throwaway
// SCREENBRIEF_HOME, running the CLI, and a server child process on a test port.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeRecording, makeTapClip, makeLiveSource, SCENARIO } from './synth.mjs';
import { run } from '../src/util.mjs';

export const MAC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CLI = path.join(MAC_DIR, 'bin', 'screenbrief');
export const STUB = path.join(MAC_DIR, 'test', 'fixtures', 't3-stub.mjs');
export const NODE = process.execPath;
const FIXTURES = path.join(os.tmpdir(), 'screenbrief-test-fixtures-v3');

/** The whisper model tests use: the real copy if present, else the small English model. */
export function testModel() {
  const cands = [
    process.env.SCREENBRIEF_MODEL,
    path.join(os.homedir(), 'ScreenBrief', 'models', 'ggml-large-v3-turbo-q5_0.bin'),
    path.join(os.homedir(), '.cache', 'hyperframes', 'whisper', 'models', 'ggml-small.en.bin'),
  ];
  return cands.find((c) => c && fs.existsSync(c));
}

/** Fixture videos, generated once per machine (cached in the temp dir). */
export async function fixtures() {
  await fsp.mkdir(FIXTURES, { recursive: true });
  const want = {
    // HEVC .mov with extreme variable frame rate (duplicate frames dropped), speech + silence.
    scenario: { file: 'scenario.mov', opts: { ...SCENARIO, codec: 'hevc', vfr: true } },
    // H.264 .mp4 with no audio track at all.
    noaudio: { file: 'noaudio.mp4', opts: { duration: 12, screenTimes: [0, 4, 8], audio: 'none' } },
    // H.264 .mp4 with an all-silent stereo audio track.
    silent: { file: 'silent.mp4', opts: { duration: 12, screenTimes: [0, 6], audio: 'silent' } },
  };
  const out = {};
  for (const [k, v] of Object.entries(want)) {
    const file = path.join(FIXTURES, v.file);
    if (!fs.existsSync(file)) {
      const tmp = file + '.tmp' + path.extname(file);
      await makeRecording({ out: tmp, ...v.opts });
      await fsp.rename(tmp, file);
    }
    out[k] = file;
  }
  out.tap = path.join(FIXTURES, 'tap.mp4');
  if (!fs.existsSync(out.tap)) {
    await makeTapClip({ out: out.tap + '.tmp.mp4' });
    await fsp.rename(out.tap + '.tmp.mp4', out.tap);
  }
  return out;
}

export const LIVE_PHRASES = [
  { t: 1.0, text: 'The login button is too small, please make it bigger.', keywords: ['login', 'button'] },
  { t: 8.0, text: 'Change the header color to dark blue.', keywords: ['header', 'blue'] },
];

/**
 * Sources for live-ingest tests, shaped like AVAssetWriter output (cached):
 *  av:    20 s, picture from t=1000 s, mic audio from 1001.5 s (phrases at 1 s and 8 s of the audio)
 *  vonly: 8 s, picture from t=500 s, no audio track
 *  early: 16 s picture from t=1001.5 s, 14.5 s mic audio from t=1000 s (audio starts first)
 *  land:  4 s landscape-stored picture, red square in its top-left corner, for rotation
 */
// For the audio-first fixture: both phrases start after the picture does (audio t - 1.5 s).
export const EARLY_PHRASES = [
  { t: 2.5, text: 'The login button is too small, please make it bigger.', keywords: ['login', 'button'] },
  { t: 9.0, text: 'Change the header color to dark blue.', keywords: ['header', 'blue'] },
];

export async function liveFixtures() {
  await fsp.mkdir(FIXTURES, { recursive: true });
  const want = {
    av: { file: 'live-av.mp4', opts: { duration: 20, screenTimes: [0, 6, 13], phrases: LIVE_PHRASES, startOffset: 1000, audioDelay: 1.5 } },
    vonly: { file: 'live-vonly.mp4', opts: { duration: 8, screenTimes: [0, 4], audio: false, startOffset: 500 } },
    early: { file: 'live-early-v2.mp4', opts: { duration: 16, screenTimes: [0, 7], phrases: EARLY_PHRASES, startOffset: 1000, audioDelay: -1.5 } },
  };
  const out = {};
  for (const [k, v] of Object.entries(want)) {
    const file = path.join(FIXTURES, v.file);
    if (!fs.existsSync(file)) {
      await makeLiveSource({ out: file + '.tmp.mp4', ...v.opts });
      await fsp.rename(file + '.tmp.mp4', file);
    }
    out[k] = file;
  }
  out.land = path.join(FIXTURES, 'live-land.mp4');
  if (!fs.existsSync(out.land)) {
    await run('/opt/homebrew/bin/ffmpeg', ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=white:s=1280x720:r=30:d=4,drawbox=x=0:y=0:w=200:h=200:color=red:t=fill,format=yuv420p',
      '-c:v', 'libx264', '-preset', 'veryfast', '-g', '30', out.land + '.tmp.mp4'], { timeoutMs: 60_000 });
    await fsp.rename(out.land + '.tmp.mp4', out.land);
  }
  return out;
}

export async function tempHome(prefix = 'sb-test-') {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

export function testEnv(home, extra = {}) {
  return {
    ...process.env,
    SCREENBRIEF_HOME: home,
    SCREENBRIEF_MODEL: testModel(),
    SCREENBRIEF_T3_BIN: STUB,
    T3_STUB_LOG: path.join(home, 't3-stub.log'),
    SCREENBRIEF_NO_BONJOUR: '1',
    ...extra,
  };
}

export async function cli(args, env, opts = {}) {
  return run(NODE, [CLI, ...args], { env, timeoutMs: opts.timeoutMs || 600_000, allowFail: opts.allowFail });
}

export function stubCalls(home) {
  const f = path.join(home, 't3-stub.log');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

export async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
    s.on('error', reject);
  });
}

export async function waitFor(fn, { timeoutMs = 120_000, intervalMs = 250, what = 'condition' } = {}) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timed out waiting for ${what}; last: ${last instanceof Error ? last.message : JSON.stringify(last)}`);
}

/** Start `screenbrief serve` as a child process. */
export async function startServer(home, port, extraEnv = {}) {
  const env = testEnv(home, extraEnv);
  const child = spawn(NODE, [CLI, 'serve', '--port', String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const cfg = await waitFor(() => {
    if (child.exitCode !== null) throw new Error(`server exited: ${log}`);
    const f = path.join(home, 'config.json');
    return fs.existsSync(f) && /listening/.test(log) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
  }, { timeoutMs: 20_000, what: 'server start' });
  const base = `http://127.0.0.1:${port}`;
  const api = async (p, opts = {}) => {
    const headers = { Authorization: `Bearer ${cfg.token}`, ...(opts.headers || {}) };
    if (opts.json !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(base + p, { method: opts.method || 'GET', headers, body: opts.json !== undefined ? JSON.stringify(opts.json) : opts.body, duplex: opts.body ? 'half' : undefined });
    const ct = r.headers.get('content-type') || '';
    const body = ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer());
    return { status: r.status, body, headers: r.headers };
  };
  return {
    child,
    token: cfg.token,
    base,
    api,
    log: () => log,
    async stop(signal = 'SIGTERM') {
      if (child.exitCode !== null) return;
      const done = new Promise((r) => child.once('exit', r));
      child.kill(signal);
      await done;
    },
  };
}

export const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

/** Upload a file with fetch (streamed), as the phone does. */
export async function upload(srv, file, meta, { contentType = 'video/quicktime' } = {}) {
  const size = fs.statSync(file).size;
  const r = await fetch(`${srv.base}/api/recordings?id=${encodeURIComponent(meta.id)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${srv.token}`,
      'Content-Type': contentType,
      'Content-Length': String(size),
      'X-ScreenBrief-Meta': b64url(meta),
    },
    body: fs.createReadStream(file),
    duplex: 'half',
  });
  return { status: r.status, body: await r.json() };
}

/** Send only part of the body, then close the connection (a dropped upload). */
export async function truncatedUpload(port, token, file, meta, sendBytes) {
  const size = fs.statSync(file).size;
  const data = fs.readFileSync(file).subarray(0, sendBytes);
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(
        `POST /api/recordings?id=${encodeURIComponent(meta.id)} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${token}\r\n` +
          `Content-Type: video/quicktime\r\nContent-Length: ${size}\r\nX-ScreenBrief-Meta: ${b64url(meta)}\r\n\r\n`,
      );
      sock.write(data, () => setTimeout(() => sock.destroy(), 200));
    });
    let resp = '';
    sock.on('data', (d) => (resp += d));
    sock.on('close', () => resolve(resp));
    sock.on('error', () => {});
  });
}

/** Mean RGB of a small patch of a JPEG (x, y as fractions of the image). */
export async function patchColor(jpeg, fx, fy) {
  const { stdout } = await run('/opt/homebrew/bin/ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', jpeg, '-vf', `crop=8:8:(iw-8)*${fx}:(ih-8)*${fy},scale=1:1:flags=area,format=rgb24`, '-f', 'rawvideo', '-'], { encoding: 'buffer', timeoutMs: 30_000 });
  return [stdout[0], stdout[1], stdout[2]];
}

export const hexRgb = (hex) => {
  const v = parseInt(hex.replace(/^0x|^#/, ''), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};

export const uuid = () => crypto.randomUUID();
