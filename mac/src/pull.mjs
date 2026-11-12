// `screenbrief pull <id|latest>`: copy a recording out of the ScreenBrief app on the user's
// iPhone (over the developer pairing this Mac already has with it) and process it into a bundle.
// The phone app keeps each recording at Documents/Recordings/<id>.mp4|.mov with a <id>.json
// beside it ({ id, startedAt, durationSec, device, hasMicAudio, transcript }).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { run } from './util.mjs';
import { paths } from './config.mjs';

export const APP_BUNDLE_ID = 'com.rostyslav.screenbrief';
export const PHONE_DIR = 'Documents/Recordings';
const MOVIE_RE = /\.(mp4|mov|m4v)$/i;
const ID_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;
const DEVICECTL = ['/usr/bin/xcrun', 'devicectl'];
const UNREACHABLE =
  'The iPhone cannot be reached from this Mac. Unlock it and keep it on the same Wi-Fi as the Mac (or plug it in), open ScreenBrief once, then run this again.';

export class PullError extends Error {}

async function devicectl(args, { timeoutMs = 120_000 } = {}) {
  const tmp = path.join(os.tmpdir(), `screenbrief-devicectl-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  try {
    const r = await run(DEVICECTL[0], [DEVICECTL[1], ...args, '--json-output', tmp], { timeoutMs, allowFail: true });
    let json = null;
    try {
      json = JSON.parse(await fsp.readFile(tmp, 'utf8'));
    } catch {
      /* no JSON written */
    }
    return { code: r.code, stdout: r.stdout || '', stderr: r.stderr || '', json };
  } finally {
    await fsp.rm(tmp, { force: true });
  }
}

/** Phones and tablets this Mac is paired with, reachable ones first. */
export function pickDevices(listJson, wanted) {
  const all = ((listJson && listJson.result && listJson.result.devices) || []).map((d) => {
    const hw = d.hardwareProperties || {};
    const dp = d.deviceProperties || {};
    const cp = d.connectionProperties || {};
    return {
      identifier: d.identifier,
      name: dp.name || hw.marketingName || d.identifier,
      model: hw.marketingName || hw.productType || '',
      type: hw.deviceType || '',
      udid: hw.udid || '',
      reachable: !!cp.tunnelState && cp.tunnelState !== 'unavailable',
    };
  });
  let list = all.filter((d) => /iphone|ipad/i.test(`${d.type} ${d.model}`));
  if (wanted) {
    const w = String(wanted).toLowerCase();
    list = list.filter((d) => [d.identifier, d.name, d.udid].some((v) => String(v).toLowerCase() === w));
  }
  // iPhones before iPads, reachable before not.
  return list.sort((a, b) => Number(b.reachable) - Number(a.reachable) || Number(/ipad/i.test(a.type + a.model)) - Number(/ipad/i.test(b.type + b.model)));
}

/** File names directly inside Documents/Recordings, from `devicectl device info files` JSON. */
export function fileNames(filesJson) {
  const files = (filesJson && filesJson.result && filesJson.result.files) || [];
  const prefix = `${PHONE_DIR}/`;
  return files
    .map((f) => String(f.relativePath || ''))
    .filter((rel) => rel.startsWith(prefix) && !rel.slice(prefix.length).includes('/'))
    .map((rel) => rel.slice(prefix.length))
    .filter((n) => MOVIE_RE.test(n) || /\.json$/i.test(n));
}

/** The movie file name for `id` ("latest" = greatest id), or null. */
export function chooseRecording(names, id) {
  const movies = names.filter((n) => MOVIE_RE.test(n)).sort();
  if (!movies.length) return null;
  if (id === 'latest') return movies[movies.length - 1];
  return movies.find((n) => n.replace(MOVIE_RE, '') === id) || null;
}

/**
 * Copies recording `id` from the phone into `destDir`. Returns { id, moviePath, meta, device }.
 */
export async function pullRecording(id, { device: wanted, destDir, log = () => {} } = {}) {
  if (id !== 'latest' && !ID_RE.test(id)) throw new PullError(`"${id}" is not a recording id (letters, digits and dashes), nor "latest".`);
  const list = await devicectl(['list', 'devices'], { timeoutMs: 60_000 });
  const devices = pickDevices(list.json, wanted);
  if (!devices.length) throw new PullError(wanted ? `No paired iPhone named "${wanted}".` : 'This Mac is not paired with an iPhone for development.');
  const reachable = devices.filter((d) => d.reachable);
  if (!reachable.length) throw new PullError(`${UNREACHABLE} (Paired: ${devices.map((d) => d.name).join(', ')}.)`);

  let lastProblem = '';
  for (const device of reachable) {
    const domain = ['--device', device.identifier, '--domain-type', 'appDataContainer', '--domain-identifier', APP_BUNDLE_ID];
    // The whole container is listed: asking for a subdirectory that does not exist yet fails
    // with an error that says nothing.
    const listing = await devicectl(['device', 'info', 'files', ...domain]);
    if (listing.code !== 0) {
      lastProblem = `${device.name}: could not read the ScreenBrief app's files (${firstLine(listing.stderr || listing.stdout) || 'no detail'}). Is ScreenBrief installed, and the iPhone unlocked?`;
      continue;
    }
    const names = fileNames(listing.json);
    const movie = chooseRecording(names, id);
    if (!movie) {
      lastProblem = names.some((n) => MOVIE_RE.test(n))
        ? `${device.name}: no recording "${id}" in ScreenBrief. It has: ${names.filter((n) => MOVIE_RE.test(n)).map((n) => n.replace(MOVIE_RE, '')).sort().slice(-8).join(', ')}.`
        : `${device.name}: ScreenBrief has no recordings yet (open the app once after recording so it can save its copy).`;
      continue;
    }
    const realId = movie.replace(MOVIE_RE, '');
    await fsp.mkdir(destDir, { recursive: true });
    const moviePath = path.join(destDir, movie);
    log(`copying ${movie} from ${device.name}`);
    const copy = await devicectl(['device', 'copy', 'from', ...domain, '--source', `${PHONE_DIR}/${movie}`, '--destination', moviePath], { timeoutMs: 600_000 });
    if (copy.code !== 0 || !fs.existsSync(moviePath) || fs.statSync(moviePath).size === 0) {
      lastProblem = `${device.name}: copying ${movie} failed: ${firstLine(copy.stderr || copy.stdout)}`;
      continue;
    }
    let meta = null;
    if (names.includes(`${realId}.json`)) {
      const metaPath = path.join(destDir, `${realId}.json`);
      const m = await devicectl(['device', 'copy', 'from', ...domain, '--source', `${PHONE_DIR}/${realId}.json`, '--destination', metaPath]);
      if (m.code === 0) {
        try {
          meta = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
        } catch {
          meta = null;
        }
      }
    }
    return { id: realId, moviePath, meta, device };
  }
  throw new PullError(lastProblem || UNREACHABLE);
}

function firstLine(s) {
  return String(s || '').split('\n').map((l) => l.trim()).filter((l) => l && !/^\d{2}:\d{2}:\d{2}/.test(l)).find((l) => /error|fail|unable|not|denied|locked/i.test(l)) || String(s || '').trim().split('\n')[0] || '';
}

/** Where a pulled recording's bundle lives: stable per id, so pulling twice reuses it. */
export function bundleDirFor(id) {
  return path.join(paths().recordings, `phone-${id}`);
}

/** "20261111-225720" (the phone's local time) -> Date, or null for other id shapes. */
export function idTime(id) {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(id);
  if (!m) return null;
  const [y, mo, d, h, mi, sec] = m.slice(1).map(Number);
  const t = new Date(y, mo - 1, d, h, mi, sec);
  return Number.isNaN(t.getTime()) ? null : t;
}

/** Where T3 Code keeps the files attached to threads (SCREENBRIEF_T3_ATTACHMENTS overrides). */
export function attachmentsDir() {
  return process.env.SCREENBRIEF_T3_ATTACHMENTS || path.join(os.homedir(), '.t3', 'userdata', 'attachments');
}

/**
 * The recording as a file the user attached in T3 Code (it stores attachments under
 * ~/.t3/userdata/attachments with generated names). The phone stamps each movie with its start
 * time, which is also its id, so the match is on that timestamp.
 */
export async function findAttachedVideo(id, { attachmentsDir: dir = attachmentsDir(), tools, maxAgeDays = 30, toleranceSec = 3 } = {}) {
  const want = idTime(id);
  if (!want) return null;
  let names;
  try {
    names = await fsp.readdir(dir);
  } catch {
    return null;
  }
  const cutoff = Date.now() - maxAgeDays * 86_400_000;
  const candidates = [];
  for (const n of names) {
    if (!MOVIE_RE.test(n)) continue;
    const file = path.join(dir, n);
    try {
      const st = await fsp.stat(file);
      if (st.isFile() && st.size > 0 && st.mtimeMs >= cutoff) candidates.push({ file, mtimeMs: st.mtimeMs });
    } catch {
      /* gone */
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const c of candidates.slice(0, 200)) {
    try {
      const r = await run(tools.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_entries', 'format_tags=creation_time:stream=codec_type', c.file], { timeoutMs: 30_000 });
      const info = JSON.parse(r.stdout);
      const created = Date.parse((info.format && info.format.tags && info.format.tags.creation_time) || '');
      const hasVideo = (info.streams || []).some((st) => st.codec_type === 'video');
      if (hasVideo && Number.isFinite(created) && Math.abs(created - want.getTime()) <= toleranceSec * 1000) return c.file;
    } catch {
      /* not a readable movie */
    }
  }
  return null;
}
