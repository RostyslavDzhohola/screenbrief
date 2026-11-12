// Paths, tool locations and ~/ScreenBrief/config.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJsonSync } from './util.mjs';

export const VERSION = '1';
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
    models: path.join(home, 'models'),
  };
}

const firstExisting = (cands) => cands.find((c) => c && fs.existsSync(c));

export function tools(cfg = {}) {
  const p = paths();
  return {
    ffmpeg: process.env.SCREENBRIEF_FFMPEG || cfg.ffmpegPath || firstExisting(['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg']) || 'ffmpeg',
    ffprobe: process.env.SCREENBRIEF_FFPROBE || cfg.ffprobePath || firstExisting(['/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe']) || 'ffprobe',
    whisper: process.env.SCREENBRIEF_WHISPER_BIN || cfg.whisperPath || firstExisting(['/opt/homebrew/bin/whisper-cli', '/usr/local/bin/whisper-cli']) || 'whisper-cli',
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
  maxFrames: 40,
  fallbackIntervalSec: 12,
  language: 'en',
};

/** Defaults overlaid with ~/ScreenBrief/config.json, when there is one. Never writes. */
export function loadConfig() {
  const cfg = readJsonSync(paths().config, null);
  return { ...DEFAULTS, ...(cfg && typeof cfg === 'object' ? cfg : {}) };
}

export function ensureDirs() {
  const p = paths();
  for (const d of [p.home, p.recordings, p.incoming, p.models]) fs.mkdirSync(d, { recursive: true });
  return p;
}
