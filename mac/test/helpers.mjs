// Shared test helpers: fixture videos (generated once and cached), a throwaway
// SCREENBRIEF_HOME, and running the CLI.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRecording, makeTapClip, SCENARIO } from './synth.mjs';
import { run } from '../src/util.mjs';
import { FFMPEG } from './tools.mjs';

export const MAC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CLI = path.join(MAC_DIR, 'bin', 'screenbrief');
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

export async function tempHome(prefix = 'sb-test-') {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

export function testEnv(home, extra = {}) {
  return {
    ...process.env,
    SCREENBRIEF_HOME: home,
    SCREENBRIEF_MODEL: testModel(),
    ...extra,
  };
}

export async function cli(args, env, opts = {}) {
  return run(NODE, [CLI, ...args], { env, timeoutMs: opts.timeoutMs || 600_000, allowFail: opts.allowFail });
}

/** Mean RGB of a small patch of a JPEG (x, y as fractions of the image). */
export async function patchColor(jpeg, fx, fy) {
  const { stdout } = await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', jpeg, '-vf', `crop=8:8:(iw-8)*${fx}:(ih-8)*${fy},scale=1:1:flags=area,format=rgb24`, '-f', 'rawvideo', '-'], { encoding: 'buffer', timeoutMs: 30_000 });
  return [stdout[0], stdout[1], stdout[2]];
}

export const hexRgb = (hex) => {
  const v = parseInt(hex.replace(/^0x|^#/, ''), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};
