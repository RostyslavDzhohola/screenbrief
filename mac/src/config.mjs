// Paths, tool locations and ~/ScreenBrief/config.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomicSync, readJsonSync } from './util.mjs';

export const VERSION = '1';
export const SERVICE_LABEL = 'com.rostyslav.screenbrief';
export const DEFAULT_PORT = 8765;
export const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CLI_PATH = path.join(PACKAGE_DIR, 'bin', 'screenbrief');

export function homeDir() {
  return path.resolve(process.env.SCREENBRIEF_HOME || path.join(os.homedir(), 'ScreenBrief'));
}

export function paths() {
  const home = homeDir();
  return {
    home,
    config: path.join(home, 'config.json'),
    recordings: path.join(home, 'recordings'),
    incoming: path.join(home, 'incoming'),
    live: path.join(home, 'live'),
    models: path.join(home, 'models'),
    logs: path.join(home, 'logs'),
    pairPng: path.join(home, 'pair.png'),
    pairCodes: path.join(home, 'pair-codes.json'),
  };
}

const firstExisting = (cands) => cands.find((c) => c && fs.existsSync(c));

export function tools(cfg = {}) {
  const p = paths();
  return {
    ffmpeg: process.env.SCREENBRIEF_FFMPEG || cfg.ffmpegPath || firstExisting(['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg']) || 'ffmpeg',
    ffprobe: process.env.SCREENBRIEF_FFPROBE || cfg.ffprobePath || firstExisting(['/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe']) || 'ffprobe',
    whisper: process.env.SCREENBRIEF_WHISPER_BIN || cfg.whisperPath || firstExisting(['/opt/homebrew/bin/whisper-cli', '/usr/local/bin/whisper-cli']) || 'whisper-cli',
    qrencode: firstExisting(['/opt/homebrew/bin/qrencode', '/usr/local/bin/qrencode']) || 'qrencode',
    t3: process.env.SCREENBRIEF_T3_BIN || cfg.t3Path || firstExisting(['/opt/homebrew/bin/t3']) || 't3',
    node: firstExisting(['/opt/homebrew/bin/node']) || process.execPath,
    model:
      process.env.SCREENBRIEF_MODEL ||
      cfg.whisperModel ||
      firstExisting([
        path.join(p.models, 'ggml-large-v3-turbo-q5_0.bin'),
        path.join(os.homedir(), 'ScreenBrief', 'models', 'ggml-large-v3-turbo-q5_0.bin'),
        path.join(p.models, 'ggml-small.en.bin'),
      ]) ||
      path.join(p.models, 'ggml-large-v3-turbo-q5_0.bin'),
  };
}

export const DEFAULTS = {
  port: DEFAULT_PORT,
  maxFrames: 40,
  fallbackIntervalSec: 12,
  language: 'en',
  keepOriginal: false,
  maxUploadBytes: 8 * 1024 * 1024 * 1024,
  // A live session with no activity for this long is finalised as interrupted.
  // Long on purpose: finalising early makes the phone drop what it has not sent yet. The app
  // offers "finish with what arrived" for a recording the user gives up on sooner.
  liveIdleSec: 6 * 60 * 60,
  maxSegmentBytes: 64 * 1024 * 1024,
  projectPaths: [],
};

/** Load config.json, creating it (with a fresh token) on first run. */
export function loadConfig({ create = true } = {}) {
  const p = paths();
  let cfg = readJsonSync(p.config, null);
  let dirty = false;
  if (!cfg || typeof cfg !== 'object') {
    if (!create) return { ...DEFAULTS, token: null };
    cfg = {};
    dirty = true;
  }
  if (!cfg.token || !/^[0-9a-f]{64}$/.test(cfg.token)) {
    if (create) {
      cfg.token = crypto.randomBytes(32).toString('hex');
      dirty = true;
    }
  }
  if (cfg.port === undefined) {
    cfg.port = DEFAULT_PORT;
    dirty = true;
  }
  if (cfg.projectPaths === undefined) {
    cfg.projectPaths = [];
    dirty = true;
  }
  if (dirty && create) {
    fs.mkdirSync(p.home, { recursive: true });
    writeJsonAtomicSync(p.config, cfg);
    try {
      fs.chmodSync(p.config, 0o600);
    } catch {}
  }
  const merged = { ...DEFAULTS, ...cfg };
  if (process.env.SCREENBRIEF_PORT) merged.port = Number(process.env.SCREENBRIEF_PORT);
  if (process.env.SCREENBRIEF_LIVE_IDLE_SEC) merged.liveIdleSec = Number(process.env.SCREENBRIEF_LIVE_IDLE_SEC);
  return merged;
}

export function ensureDirs() {
  const p = paths();
  for (const d of [p.home, p.recordings, p.incoming, p.live, p.models, p.logs]) fs.mkdirSync(d, { recursive: true });
  return p;
}
