// Command-line interface: serve, process, frames, threads, send, pair, doctor,
// install-service, uninstall-service.
import { pullRecording, PullError, bundleDirFor, findAttachedVideo, idTime } from './pull.mjs';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, ensureDirs, tools as toolPaths, paths, CLI_PATH } from './config.mjs';
import { processVideo, loadBundle } from './pipeline.mjs';
import { probe, extractFrame } from './media.mjs';
import { T3 } from './t3.mjs';
import { deliverBundle } from './deliver.mjs';
import { pairingInfo, qrTerminal, qrPng, createPairCode } from './net.mjs';
import { installService, uninstallService } from './service.mjs';
import { doctor } from './doctor.mjs';
import { fmtTimeForName, readJsonSync, writeJsonAtomic, mapLimit } from './util.mjs';

const HELP = `screenbrief: phone screen recordings with spoken feedback -> agent-readable bundles

Usage:
  screenbrief serve [--port <n>] [--no-bonjour]
  screenbrief pull <recording id | latest> [--device <name>] [--no-phone] [--force]
      get a recording (from the iPhone, or the video attached in T3 Code) and process it
  screenbrief process <video> [--out <dir>] [--note <text>]
  screenbrief frames <bundle dir> --at <sec> [--at <sec> ...]
  screenbrief frames <bundle dir> --from <sec> --to <sec> [--fps <n>]
  screenbrief threads [--json]
  screenbrief send <recording id | bundle dir> (--thread <id> | --project <path>) [--note <text>]
  screenbrief pair
  screenbrief doctor
  screenbrief install-service [--dry-run]
  screenbrief uninstall-service

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
  if (fs.existsSync(path.join(asPath, 'meta.json')) || fs.existsSync(path.join(asPath, 'record.json'))) return asPath;
  const root = paths().recordings;
  if (fs.existsSync(root)) {
    for (const name of fs.readdirSync(root).sort().reverse()) {
      const dir = path.join(root, name);
      if (name === ref) return dir;
      const rec = readJsonSync(path.join(dir, 'record.json'), null) || readJsonSync(path.join(dir, 'meta.json'), null);
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
    const done = path.join(bundleDirFor(id), 'FEEDBACK.md');
    if (fs.existsSync(done)) {
      say(`already here; reusing ${bundleDirFor(id)} (--force fetches and processes again)`);
      console.log(done);
      return 0;
    }
  }
  const staging = path.join(paths().incoming, `pull-${process.pid}-${Date.now()}`);
  try {
    // 1. The phone, when it can be reached.
    let pulled = null;
    let phoneProblem = args['no-phone'] ? 'the phone was not tried (--no-phone)' : '';
    if (!args['no-phone']) {
      try {
        pulled = await pullRecording(id, { device: args.device, destDir: staging, log: say });
      } catch (e) {
        if (!(e instanceof PullError)) throw e;
        phoneProblem = e.message;
      }
    }
    // 2. Otherwise the video the user attached to a T3 Code thread.
    if (!pulled && id !== 'latest') {
      const attached = await findAttachedVideo(id, { tools });
      if (attached) {
        say(`using the attached video ${attached}`);
        pulled = { id, moviePath: attached, meta: null, device: null };
      }
    }
    if (!pulled) {
      console.error(
        `screenbrief pull: could not get the video for recording ${id}.\n` +
          `- iPhone: ${phoneProblem}\n` +
          (id === 'latest' ? '' : `- T3 Code attachments: no attached video was recorded at that time.\n`) +
          `Do not start on the changes and do not work from the transcript alone. Tell the user you need the video, ask them to attach ` +
          `${id === 'latest' ? 'the recording' : `ScreenBrief-${id}`} from Photos (album "ScreenBrief") to the thread, and wait. When it is attached, run this command again.`,
      );
      return 2;
    }
    const outDir = bundleDirFor(pulled.id);
    const done = path.join(outDir, 'FEEDBACK.md');
    if (fs.existsSync(done) && !args.force) {
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

async function cmdFrames(args) {
  const dir = resolveBundle(args._[0]);
  const cfg = loadConfig({ create: false });
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

async function cmdThreads(args) {
  const cfg = loadConfig();
  const t3 = new T3({ t3Bin: toolPaths(cfg).t3, projectPaths: cfg.projectPaths || [] });
  const r = await t3.threads(60);
  if (args.json) {
    console.log(JSON.stringify({ threads: r.threads, source: r.source, ...(r.warning ? { warning: r.warning } : {}) }, null, 2));
    return 0;
  }
  if (r.warning) console.error(`warning: ${r.warning}`);
  for (const t of r.threads) console.log(`${t.threadId}  ${String(t.updatedAt).slice(0, 16).replace('T', ' ')}  [${t.projectName}]  ${t.title}`);
  return 0;
}

async function cmdSend(args) {
  const dir = resolveBundle(args._[0]);
  if (!args.thread && !args.project) throw new Error('pass --thread <id> or --project <path>');
  const cfg = loadConfig();
  const t3 = new T3({ t3Bin: toolPaths(cfg).t3, projectPaths: cfg.projectPaths || [] });
  if (!loadBundle(dir)) throw new Error(`${dir} is not a finished bundle (still processing or failed?)`);
  const target = args.thread ? { threadId: String(args.thread) } : { projectPath: path.resolve(String(args.project)) };
  if (args.note) target.note = String(args.note);
  const delivery = await deliverBundle(t3, dir, target);
  // Keep the server's record in step when this bundle belongs to it.
  const recFile = path.join(dir, 'record.json');
  const rec = readJsonSync(recFile, null);
  if (rec) {
    const { messagePath, ...d } = delivery;
    rec.delivery = d;
    rec.deliveryRequest = null;
    await writeJsonAtomic(recFile, rec);
  }
  if (delivery.state !== 'sent') throw new Error(`delivery failed: ${delivery.error}`);
  console.log(`sent to thread ${delivery.threadId}${delivery.link ? ` (${delivery.link})` : ''}`);
  console.log(delivery.messagePath);
  return 0;
}

async function cmdPair(args = {}) {
  const cfg = loadConfig();
  ensureDirs();
  const tools = toolPaths(cfg);
  const info = pairingInfo(cfg);
  console.log('Pair the ScreenBrief iPhone app by scanning this code with the Camera app:\n');
  try {
    console.log(await qrTerminal(tools, info.link));
  } catch (e) {
    console.error(`(could not draw a QR code: ${e.message})`);
  }
  try {
    await qrPng(tools, info.link, paths().pairPng);
    console.log(`QR image: ${paths().pairPng}`);
  } catch (e) {
    console.error(`(could not write ${paths().pairPng}: ${e.message})`);
  }
  console.log(`\nPairing link:\n${info.link}\n`);
  try {
    const hours = Math.min(72, Math.max(0.1, Number(args['valid-hours']) || 0.5));
    const { code } = createPairCode(paths().pairCodes, Date.now(), hours * 3600 * 1000);
    console.log(`Tap-to-pair page for the phone (valid ${hours < 1 ? `${Math.round(hours * 60)} minutes` : `${hours} hours`}, safe to paste in a chat):\n${info.alt}/pair/${code}\n`);
  } catch (e) {
    console.error(`(could not create a tap-to-pair code: ${e.message})`);
  }
  console.log(`Service: ${info.url}  (LAN: ${info.alt})`);
  console.log(`Web uploader for Safari (no app needed): ${info.webUrl}`);
  return 0;
}

export async function main(argv) {
  const [cmd, ...rest] = argv;
  const args = parseArgs(rest, { boolean: ['json', 'dry-run', 'no-bonjour', 'help', 'force', 'no-phone'] });
  switch (cmd) {
    case 'serve': {
      const { serveForever } = await import('./server.mjs');
      await serveForever({ port: args.port ? Number(args.port) : undefined, bonjour: !args['no-bonjour'] });
      return new Promise(() => {}); // run until signalled
    }
    case 'pull':
      return cmdPull(args);
    case 'process':
      return cmdProcess(args);
    case 'frames':
      return cmdFrames(args);
    case 'threads':
      return cmdThreads(args);
    case 'send':
      return cmdSend(args);
    case 'pair':
      return cmdPair(args);
    case 'doctor':
      return doctor();
    case 'install-service': {
      const r = await installService({ dryRun: !!args['dry-run'] });
      if (r.dryRun) console.log(r.body);
      else console.log(`installed ${r.file}; logs in ${paths().logs}`);
      return 0;
    }
    case 'uninstall-service': {
      const r = await uninstallService();
      console.log(r.removed ? `removed ${r.file}` : `not installed (${r.file})`);
      return 0;
    }
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

