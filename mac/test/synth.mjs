// Generates phone-shaped synthetic screen recordings: distinct "screens" that change at
// known times, macOS `say` speech placed at known offsets, and stretches of silence.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { run } from '../src/util.mjs';

const FFMPEG = '/opt/homebrew/bin/ffmpeg';
export const W = 886;
export const H = 1920;

// Each screen is a background colour plus a distinct layout of boxes (header, rows, buttons).
export const SCREENS = [
  { bg: '0xF2F2F7', boxes: [[0, 0, W, 220, '0x1C64F2'], [60, 320, 766, 140, '0xFFFFFF'], [60, 500, 766, 140, '0xFFFFFF'], [60, 680, 766, 140, '0xFFFFFF'], [300, 1600, 286, 120, '0x34C759']] },
  { bg: '0x111827', boxes: [[0, 0, W, 180, '0xF59E0B'], [80, 400, 726, 726, '0x6366F1'], [80, 1250, 340, 160, '0xEF4444'], [466, 1250, 340, 160, '0x10B981']] },
  { bg: '0xFFF7ED', boxes: [[0, 0, W, 260, '0x7C3AED'], [40, 300, 380, 380, '0xFB7185'], [466, 300, 380, 380, '0x22D3EE'], [40, 720, 380, 380, '0xA3E635'], [466, 720, 380, 380, '0xFACC15']] },
  { bg: '0x0F766E', boxes: [[100, 600, 686, 500, '0xFFFFFF'], [160, 950, 566, 110, '0x0F766E']] },
  { bg: '0x1E293B', boxes: [[0, 1700, W, 220, '0x334155'], [60, 200, 766, 90, '0x94A3B8'], [60, 330, 500, 90, '0x94A3B8'], [60, 460, 640, 90, '0x94A3B8']] },
  { bg: '0xFEE2E2', boxes: [[0, 0, W, 300, '0xB91C1C'], [200, 800, 486, 486, '0x991B1B']] },
];

function screenFilter(i, dur, fps) {
  const s = SCREENS[i % SCREENS.length];
  let f = `color=c=${s.bg}:s=${W}x${H}:r=${fps}:d=${dur.toFixed(3)}`;
  for (const [x, y, w, h, c] of s.boxes) f += `,drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=${c}:t=fill`;
  return f;
}

/**
 * opts: {
 *   out, duration, screenTimes: [0, 8, 15, ...],
 *   phrases: [{ t, text }], audio: 'speech' | 'none' | 'silent',
 *   codec: 'hevc' | 'h264', container: 'mov' | 'mp4', vfr: boolean, noise: boolean
 * }
 */
export async function makeRecording(opts) {
  const { out, duration, screenTimes, phrases = [], audio = 'speech', codec = 'h264', vfr = false, noise = true, fps = 30, gop } = opts;
  const work = await fsp.mkdtemp(path.join(path.dirname(out), '.synth-'));
  try {
    const inputs = [];
    const fparts = [];
    // Video: one colour source per screen, concatenated.
    const times = [...screenTimes, duration];
    for (let i = 0; i < screenTimes.length; i++) {
      fparts.push(`${screenFilter(i, times[i + 1] - times[i], fps)}[s${i}]`);
    }
    fparts.push(`${screenTimes.map((_, i) => `[s${i}]`).join('')}concat=n=${screenTimes.length}:v=1:a=0${vfr ? ',mpdecimate' : ''},format=yuv420p[v]`);
    // Audio: speech clips delayed to their offsets over silence (optionally faint noise).
    if (audio === 'speech') {
      for (let i = 0; i < phrases.length; i++) {
        const aiff = path.join(work, `p${i}.aiff`);
        await run('/usr/bin/say', ['-o', aiff, phrases[i].text], { timeoutMs: 60_000 });
        inputs.push('-i', aiff);
      }
      const base = noise ? `anoisesrc=r=48000:a=0.0015:c=pink:d=${duration}` : `anullsrc=r=48000:cl=mono:d=${duration}`;
      fparts.push(`${base},aformat=sample_rates=48000:channel_layouts=mono[base]`);
      for (let i = 0; i < phrases.length; i++) {
        const ms = Math.round(phrases[i].t * 1000);
        fparts.push(`[${i}:a]aresample=48000,aformat=channel_layouts=mono,adelay=${ms}:all=1[d${i}]`);
      }
      fparts.push(`[base]${phrases.map((_, i) => `[d${i}]`).join('')}amix=inputs=${phrases.length + 1}:normalize=0:duration=first[a]`);
    } else if (audio === 'silent') {
      fparts.push(`anullsrc=r=48000:cl=stereo:d=${duration}[a]`);
    }
    const args = ['-hide_banner', '-nostdin', '-y', ...inputs, '-filter_complex', fparts.join(';'), '-map', '[v]'];
    if (audio !== 'none') args.push('-map', '[a]', '-c:a', 'aac', '-b:a', '128k');
    if (codec === 'hevc') args.push('-c:v', 'hevc_videotoolbox', '-b:v', '3M', '-tag:v', 'hvc1');
    else args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23');
    if (gop) args.push('-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0');
    if (vfr) args.push('-fps_mode', 'vfr');
    args.push('-t', String(duration), out);
    await run(FFMPEG, args, { timeoutMs: 600_000 });
    return out;
  } finally {
    await fsp.rm(work, { recursive: true, force: true });
  }
}

/** The standard scenario used by the tests (about 40 s). */
export const SCENARIO = {
  duration: 40,
  // Screen changes at 0, 7, 14, 21 (inside the silence), 30, 35.
  screenTimes: [0, 7, 14, 21, 30, 35],
  phrases: [
    { t: 1.5, text: 'The login button is too small, please make it bigger.', keywords: ['login', 'button'] },
    { t: 8.0, text: 'This list should be sorted by date, newest first.', keywords: ['sorted', 'date'] },
    { t: 15.0, text: 'Change the header color to dark blue.', keywords: ['header', 'blue'] },
    // 18.5 .. 31 is silent (a screen change at 21 happens during the silence).
    { t: 31.0, text: 'The settings icon is hard to find.', keywords: ['settings', 'icon'] },
  ],
  silence: [18.5, 30.8],
};

/**
 * A short no-audio clip showing the ScreenBrief touch overlay's mark (magenta #FF00DC disc,
 * radius 24 pt, 4 pt white ring; overlays/README.md) for 0.4 s at (x, y) from time t.
 */
export async function makeTapClip({ out, t = 3, x = 0.42, y = 0.71, duration = 8 }) {
  const work = await fsp.mkdtemp(path.join(path.dirname(out), '.synth-'));
  try {
    const disc = path.join(work, 'disc.png');
    const d = 'hypot(X-64,Y-64)';
    await run(FFMPEG, ['-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i', 'color=c=black@0:s=128x128,format=rgba', '-frames:v', '1',
      '-vf', `geq=r='255':g='if(lte(${d},54),0,255)':b='if(lte(${d},54),220,255)':a='if(lte(${d},63),255,0)'`, disc], { timeoutMs: 60_000 });
    const cx = Math.round(x * W) - 64;
    const cy = Math.round(y * H) - 64;
    await run(FFMPEG, ['-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i', `color=c=0xF2F2F7:s=${W}x${H}:r=30:d=${duration}`, '-i', disc,
      '-filter_complex', `[0:v]drawbox=x=0:y=0:w=${W}:h=220:color=0x1C64F2:t=fill[bg];[bg][1:v]overlay=x=${cx}:y=${cy}:enable='between(t,${t},${t + 0.4})',format=yuv420p`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', out], { timeoutMs: 120_000 });
    return out;
  } finally {
    await fsp.rm(work, { recursive: true, force: true });
  }
}
