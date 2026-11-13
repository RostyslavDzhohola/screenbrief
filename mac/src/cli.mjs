// Command-line interface: pull, process, frames, watch, doctor.
import { pullRecording, PullError, bundleDirFor, findAttached, joinParts, idTime, titleFor } from './pull.mjs';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, ensureDirs, tools as toolPaths, paths, CLI_PATH } from './config.mjs';
import { processVideo, finishedFeedback } from './pipeline.mjs';
import { probe, extractFrame } from './media.mjs';
import { doctor } from './doctor.mjs';
import { rememberWaiter, forgetWaiter, listWaiters, watchOnce, withWatchLock, watchInstalled, installWatch, uninstallWatch, watchPlistPath, WATCH_INTERVAL_SEC } from './watch.mjs';
import { fmtTimeForName, readJsonSync, mapLimit } from './util.mjs';

const HELP = `screenbrief: phone screen recordings with spoken feedback -> a timeline an agent can read

Usage:
  screenbrief pull <recording id | latest> [--device <name>] [--no-phone] [--force]
      get a recording (from the iPhone, or the video attached in T3 Code), process it,
      and print the path of its FEEDBACK.md
  screenbrief process <video> [--out <dir>] [--note <text>]
      process any video file the same way
  screenbrief frames <bundle dir | recording id> --at <sec> [--at <sec> ...]
  screenbrief frames <bundle dir | recording id> --from <sec> --to <sec> [--fps <n>]
      extra frames around a moment
  screenbrief watch [--install | --uninstall | --status]
      fetch recordings that a pull could not get, once the iPhone is in reach again, and tell the
      thread that asked. --install runs it every two minutes in the background.
  screenbrief doctor
      check ffmpeg, whisper and the rest

Data: ${paths().home} (override with SCREENBRIEF_HOME). CLI: ${CLI_PATH}`;

/** Minimal flag parser: --k v, --k=v, repeated flags collect into arrays, bare words are positionals. */
export function parseArgs(argv, { boolean = [] } = {}) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      out._.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      let [k, v] = a.slice(2).split(/=(.*)/s);
      if (v === undefined) {
        if (boolean.includes(k)) v = true;
        else if (i + 1 < argv.length) v = argv[++i];
        else throw new Error(`--${k} needs a value`);
      }
      if (k in out) out[k] = [].concat(out[k], v);
      else out[k] = v;
    } else out._.push(a);
  }
  return out;
}

const list = (v) => (v === undefined ? [] : [].concat(v));
const num = (v, name) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a number of seconds, got ${v}`);
  return n;
};

/** A recording id, a bundle dir name, or a path -> bundle directory. */
export function resolveBundle(ref) {
  if (!ref) throw new Error('pass a recording id or bundle directory');
  const asPath = path.resolve(ref);
  if (fs.existsSync(path.join(asPath, 'meta.json'))) return asPath;
  const root = paths().recordings;
  if (fs.existsSync(root)) {
    for (const name of fs.readdirSync(root).sort().reverse()) {
      const dir = path.join(root, name);
      if (name === ref) return dir;
      const rec = readJsonSync(path.join(dir, 'meta.json'), null);
      if (rec && rec.id === ref) return dir;
    }
  }
  throw new Error(`no bundle found for ${ref}`);
}

async function cmdProcess(args) {
  const input = args._[0];
  if (!input) throw new Error('usage: screenbrief process <video> [--out <dir>] [--note <text>]');
  const cfg = loadConfig();
  ensureDirs();
  const started = Date.now();
  const bundle = await processVideo(path.resolve(input), {
    outDir: args.out ? path.resolve(args.out) : undefined,
    note: args.note,
    cfg,
    onStatus: (s) => process.stderr.write(`[screenbrief] ${s.stage}\n`),
  });
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  process.stderr.write(
    `[screenbrief] ${bundle.frames.length} frames, ${bundle.transcript.phrases.length} phrases, audio: ${bundle.transcript.audio.state}, ${secs}s for a ${bundle.durationSec.toFixed(1)}s recording\n`,
  );
  console.log(bundle.feedbackPath);
  return 0;
}

async function cmdPull(args) {
  const id = String(args._[0] || '').trim().toLowerCase();
  if (!id) throw new Error('usage: screenbrief pull <recording id | latest> [--device <name>] [--no-phone] [--force]');
  const cfg = loadConfig();
  ensureDirs();
  const tools = toolPaths(cfg);
  const say = (m) => process.stderr.write(`[screenbrief] ${m}\n`);
  // Already here and processed: answer at once.
  if (id !== 'latest' && !args.force) {
    const done = finishedFeedback(bundleDirFor(id));
    if (done) {
      say(`already here; reusing ${bundleDirFor(id)} (--force fetches and processes again)`);
      settleWaiter(id);
      console.log(done);
      return 0;
    }
  }
  const staging = path.join(paths().incoming, `pull-${process.pid}-${Date.now()}`);
  try {
    // 1. The phone, when it can be reached.
    let pulled = null;
    const noPhone = args['no-phone'] || process.env.SCREENBRIEF_NO_PHONE === '1';
    let phoneProblem = noPhone ? 'the phone was not tried (--no-phone)' : '';
    if (!noPhone) {
      try {
        pulled = await pullRecording(id, { device: args.device, destDir: staging, log: say });
      } catch (e) {
        if (!(e instanceof PullError)) throw e;
        phoneProblem = e.message;
      }
    }
    // 2. Otherwise the video the user attached to a T3 Code thread, whole or in parts.
    let attachProblem = 'no attached video carries this recording\'s id or start time.';
    let ask = `attach ${id === 'latest' ? 'the recording' : titleFor(id)} from Photos (album "ScreenBrief") to the thread`;
    if (!pulled && id !== 'latest') {
      const attached = await findAttached(id, { tools });
      if (attached && attached.file) {
        say(`using the attached video ${attached.file}`);
        pulled = { id, moviePath: attached.file, meta: null, device: null };
      } else if (attached && attached.parts) {
        say(`joining the ${attached.total} attached parts`);
        const joined = await joinParts(tools, attached.parts, path.join(staging, `${titleFor(id)}.mov`));
        pulled = { id, moviePath: joined, meta: null, device: null };
      } else if (attached && attached.missing) {
        const have = attached.total - attached.missing.length;
        const names = attached.missing.map((k) => `${titleFor(id)}-part${k}of${attached.total}`);
        attachProblem = `this recording was attached in ${attached.total} parts and ${have} of them ${have === 1 ? 'is' : 'are'} here; missing: ${names.join(', ')}.`;
        ask = `attach the missing part${names.length === 1 ? '' : 's'} (${names.join(', ')}) from Photos (album "ScreenBrief") to the thread`;
      }
    }
    if (!pulled) {
      console.error(
        `screenbrief pull: could not get the video for recording ${id}.\n` +
          `- iPhone: ${phoneProblem}\n` +
          (id === 'latest' ? '' : `- T3 Code attachments: ${attachProblem}\n`) +
          `Do not start on the changes and do not work from the transcript alone. Tell the user you need the video, ask them to ${ask}, and wait. ` +
          `When it is attached, run this command again.` +
          laterNote(id),
      );
      return 2;
    }
    settleWaiter(pulled.id);
    const outDir = bundleDirFor(pulled.id);
    const done = finishedFeedback(outDir);
    if (done && !args.force) {
      say(`already processed; reusing ${outDir}`);
      console.log(done);
      return 0;
    }
    const m = pulled.meta || {};
    const when = idTime(pulled.id);
    const meta = {
      id: pulled.id,
      startedAt: m.startedAt || (when ? when.toISOString() : undefined),
      durationSec: m.durationSec,
      device: m.device || (pulled.device ? { name: pulled.device.name, model: pulled.device.model, os: '' } : undefined),
      source: pulled.device ? 'phone' : 'attachment',
      hasMicAudio: m.hasMicAudio,
    };
    const started = Date.now();
    const bundle = await processVideo(pulled.moviePath, { outDir, cfg, meta, id: pulled.id, onStatus: (s) => say(s.stage) });
    say(
      `${bundle.frames.length} frames, ${bundle.transcript.phrases.length} phrases, audio: ${bundle.transcript.audio.state}, ` +
        `${((Date.now() - started) / 1000).toFixed(1)}s for a ${bundle.durationSec.toFixed(1)}s recording`,
    );
    console.log(bundle.feedbackPath);
    return 0;
  } finally {
    await fsp.rm(staging, { recursive: true, force: true });
  }
}

/**
 * Remembers a pull that failed, so `screenbrief watch` can finish it when the phone is back in
 * reach, and returns the lines that tell the agent so. Nothing when the watcher itself is asking.
 */
function laterNote(id) {
  if (id === 'latest' || process.env.SCREENBRIEF_WATCHER === '1') return '';
  const threadId = process.env.T3CODE_THREAD_ID || null;
  const waiter = rememberWaiter(id, { threadId, t3Bin: process.env.T3CODE_CLI_PATH || null });
  if (!waiter) return '';
  if (!watchInstalled()) {
    return `\n(Fetching it automatically later is off on this Mac. The user can turn it on once with: screenbrief watch --install)`;
  }
  return (
    `\nThis request is remembered. When the iPhone is next in reach of this Mac (unlocked, on the same Wi-Fi or plugged in), ` +
    `the video is fetched and processed automatically` +
    (threadId ? `, and this thread gets a message with the FEEDBACK.md path. Tell the user that, and that attaching the video is only needed to continue sooner.` : `. Run this command again later.`)
  );
}

/** A pull by hand that got the video ends the wait. The watcher's own pull leaves it: the thread is told first. */
function settleWaiter(id) {
  if (process.env.SCREENBRIEF_WATCHER !== '1') forgetWaiter(id);
}

async function cmdWatch(args) {
  if (args.install) {
    const file = await installWatch();
    console.log(`installed ${file}: checks every ${WATCH_INTERVAL_SEC / 60} minutes, and only reaches for the iPhone while a recording is waiting. Remove with: screenbrief watch --uninstall`);
    return 0;
  }
  if (args.uninstall) {
    const r = await uninstallWatch();
    console.log(r.removed ? `removed ${r.file}` : `not installed (${r.file})`);
    return 0;
  }
  const waiters = listWaiters();
  if (args.status) {
    console.log(watchInstalled() ? `background check: on (${watchPlistPath()})` : 'background check: off (turn on with: screenbrief watch --install)');
    if (!waiters.length) console.log('waiting: nothing');
    for (const w of waiters) console.log(`waiting: ${w.id}  asked ${w.requestedAt}${w.threadId ? `  thread ${w.threadId}` : ''}`);
    return 0;
  }
  if (!waiters.length) return 0; // the usual case: nothing to do, and the phone is left alone
  ensureDirs();
  const stamp = () => new Date().toISOString();
  const results = await withWatchLock(() => watchOnce({ log: (m) => console.log(`${stamp()} ${m}`) }));
  if (results === null) console.log(`${stamp()} another pass is still running`);
  return 0;
}

async function cmdFrames(args) {
  const dir = resolveBundle(args._[0]);
  const cfg = loadConfig();
  const tools = toolPaths(cfg);
  const src = path.join(dir, 'recording.mp4');
  if (!fs.existsSync(src)) throw new Error(`no recording.mp4 in ${dir}`);
  const info = await probe(tools, src);
  const times = list(args.at).map((v) => num(v, '--at'));
  if (args.from !== undefined || args.to !== undefined) {
    const from = num(args.from ?? 0, '--from');
    const to = num(args.to ?? info.duration, '--to');
    const fps = Number(args.fps || 2);
    if (!(fps > 0 && fps <= 30)) throw new Error('--fps must be between 0 and 30');
    if (to < from) throw new Error('--to must be after --from');
    for (let t = from; t <= to + 1e-6 && times.length < 240; t += 1 / fps) times.push(Number(t.toFixed(3)));
  }
  if (!times.length) throw new Error('pass --at <sec> (repeatable) or --from <sec> --to <sec> [--fps n]');
  const outDir = path.join(dir, 'frames', 'extra');
  await fsp.mkdir(outDir, { recursive: true });
  const dims = info.video ? { srcWidth: info.video.displayWidth, srcHeight: info.video.displayHeight } : {};
  const items = times.map((t) => ({ t: Math.min(t, Math.max(0, info.duration - 0.05)), file: path.join(outDir, `x-${fmtTimeForName(t)}.jpg`) }));
  await mapLimit(items, 4, (it) => extractFrame(tools, src, it.t, it.file, dims));
  for (const it of items) console.log(it.file);
  return 0;
}

export async function main(argv) {
  const [cmd, ...rest] = argv;
  const args = parseArgs(rest, { boolean: ['help', 'force', 'no-phone', 'install', 'uninstall', 'status'] });
  switch (cmd) {
    case 'pull':
      return cmdPull(args);
    case 'process':
      return cmdProcess(args);
    case 'frames':
      return cmdFrames(args);
    case 'watch':
      return cmdWatch(args);
    case 'doctor':
      return doctor();
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return cmd === undefined ? 1 : 0;
    default:
      console.error(HELP);
      throw new Error(`unknown command: ${cmd}`);
  }
}

