// ffmpeg / ffprobe wrappers: probe, the single transcode pass (playable mp4 + 16 kHz
// wav for whisper + tiny grayscale thumbnails for change detection), still frames,
// and the captioned contact sheet.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { run, mapLimit, fmtTime } from './util.mjs';
import { renderLabel, textWidth } from './font.mjs';

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};
const rate = (r) => {
  if (!r || typeof r !== 'string') return undefined;
  const [a, b] = r.split('/').map(Number);
  if (!b) return num(a);
  const v = a / b;
  return Number.isFinite(v) && v > 0 ? v : undefined;
};

function rotationOf(stream) {
  let rot = 0;
  if (stream.tags && stream.tags.rotate !== undefined) rot = Number(stream.tags.rotate) || 0;
  for (const sd of stream.side_data_list || []) if (sd.rotation !== undefined) rot = Number(sd.rotation) || 0;
  rot = ((Math.round(rot) % 360) + 360) % 360;
  return rot;
}

export async function probe(tools, file) {
  const { stdout } = await run(tools.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { timeoutMs: 60_000 });
  const info = JSON.parse(stdout);
  const streams = info.streams || [];
  const fmt = info.format || {};
  const video = streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  const audio = streams.filter((s) => s.codec_type === 'audio');
  const formatStart = num(fmt.start_time) || 0;
  let duration = num(fmt.duration);
  if (!duration && video) duration = num(video.duration);
  if (!duration && audio[0]) duration = num(audio[0].duration);
  const out = {
    formatName: fmt.format_name,
    duration: duration || 0,
    sizeBytes: num(fmt.size),
    formatStart,
    video: null,
    audio: audio.map((a) => ({
      index: a.index,
      codec: a.codec_name,
      channels: a.channels,
      sampleRate: num(a.sample_rate),
      start: (num(a.start_time) ?? formatStart) - formatStart,
      duration: num(a.duration),
      title: (a.tags && (a.tags.title || a.tags.handler_name)) || '',
    })),
  };
  if (video) {
    const rot = rotationOf(video);
    const w = video.width;
    const h = video.height;
    const swap = rot === 90 || rot === 270;
    out.video = {
      index: video.index,
      codec: video.codec_name,
      width: w,
      height: h,
      rotation: rot,
      displayWidth: swap ? h : w,
      displayHeight: swap ? w : h,
      avgFps: rate(video.avg_frame_rate),
      rFps: rate(video.r_frame_rate),
      start: (num(video.start_time) ?? formatStart) - formatStart,
      frames: num(video.nb_frames),
    };
  }
  return out;
}

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

/** Rotation from phone meta (degrees clockwise to turn upright), or 0 when absent or invalid. */
export function metaRotation(v) {
  const n = Number(v);
  return [90, 180, 270].includes(n) ? n : 0;
}

/**
 * Where the picture starts, in seconds from the file's start time. The bundle's t=0 is
 * the first video frame, so a file whose audio starts first is trimmed to the picture.
 */
export function pictureStart(info) {
  const vs = info && info.video ? info.video.start : 0;
  return vs > 0.001 ? vs : 0;
}

/**
 * Stream-copy remux to a regular (non-fragmented) file: the first video track and every
 * audio track. Normalises concatenated fragmented MP4 (whose reported duration otherwise
 * includes its start offset) and, with `rotation` (degrees clockwise), replaces the
 * display matrix so every later step (ffmpeg autorotate, the touch detector) sees it upright.
 */
export async function remux(tools, input, output, { rotation = 0, timeoutMs = 300_000 } = {}) {
  const pre = rotation ? ['-display_rotation:v:0', String((360 - rotation) % 360)] : [];
  const fmt = /\.mov$/i.test(output) ? 'mov' : 'mp4';
  await run(tools.ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', ...pre, '-i', input, '-map', '0:v:0', '-map', '0:a?', '-c', 'copy',
    '-movflags', '+faststart', '-f', fmt, output], { timeoutMs });
  return output;
}

/** Fit (w,h) so the longer side is at most `maxLong`, both even. */
export function fitLong(w, h, maxLong) {
  const long = Math.max(w, h);
  const k = long > maxLong ? maxLong / long : 1;
  return { w: even(w * k), h: even(h * k) };
}

/** Thumbnail geometry used for change detection: about 72 px on the short side. */
export function thumbGeometry(w, h) {
  const short = 72;
  if (w <= h) return { w: short, h: even((short * h) / w) };
  return { w: even((short * w) / h), h: short };
}

/** Choose which audio stream to use: a track titled like a microphone, else mix them all. */
export function chooseAudio(probeInfo) {
  const a = probeInfo.audio;
  if (!a.length) return { mode: 'none' };
  if (a.length === 1) return { mode: 'single', streams: [a[0]] };
  const mic = a.find((s) => /mic/i.test(s.title));
  if (mic) return { mode: 'single', streams: [mic] };
  return { mode: 'mix', streams: a };
}

/**
 * One decode of the input producing:
 *  - recording.mp4 (H.264, <=1920 long side, <=30 fps, mono AAC, faststart)
 *  - audio.wav (16 kHz mono, padded so t=0 matches the video) when there is audio
 *  - thumbs.raw (gray, `thumbFps` per second) for change detection
 */
export async function transcode(tools, input, info, outDir, { thumbFps = 5, onProgress, timeoutMs } = {}) {
  if (!info.video) throw new Error('the file has no video stream');
  const vw = info.video.displayWidth;
  const vh = info.video.displayHeight;
  const enc = fitLong(vw, vh, 1920);
  const th = thumbGeometry(enc.w, enc.h);
  const srcFps = Math.max(info.video.avgFps || 0, info.video.rFps || 0);
  // Keep a genuine 10-30 fps rate; variable-rate screen recordings (which can report
  // anything from <1 to 120 fps) become constant 30 fps.
  const outFps = srcFps >= 10 && srcFps <= 30 ? Math.round(srcFps) : 30;
  const audioSel = chooseAudio(info);
  // t=0 is the first video frame: seek the input there (trims audio that starts earlier;
  // audio that starts later is padded by aresample first_pts=0). Seek 2 ms early so the
  // first frame is never dropped by rounding.
  const vs = pictureStart(info);
  const seek = vs ? ['-ss', Math.max(0, vs - 0.002).toFixed(6)] : [];
  // Per-process temp names: a resumed job never shares files with an orphaned ffmpeg.
  const tag = `${process.pid}-${Date.now().toString(36)}`;
  const mp4 = path.join(outDir, 'recording.mp4');
  const wav = path.join(outDir, `audio.${tag}.wav`);
  const thumbs = path.join(outDir, `thumbs.${tag}.raw`);
  const tmpMp4 = path.join(outDir, `recording.${tag}.tmp.mp4`);

  // A variable-rate video track can stop before the audio (its last frame simply stays on
  // screen); clone that last frame out to the full duration so every moment has a picture.
  const dur = info.duration > 0 ? Math.max(0, info.duration - vs) : 0;
  const pad = dur ? `,tpad=stop_mode=clone:stop_duration=${Math.ceil(dur + 1)}` : '';
  const limit = dur ? ['-t', dur.toFixed(3)] : [];
  let fc = `[0:v:0]fps=${outFps}${pad},scale=${enc.w}:${enc.h}:flags=bicubic,setsar=1,format=yuv420p,split=2[venc][vt];` +
    `[vt]fps=${thumbFps},scale=${th.w}:${th.h}:flags=area,format=gray[vthumb]`;
  if (audioSel.mode !== 'none') {
    const pads = audioSel.streams.map((s) => `[0:${s.index}]`).join('');
    const src = audioSel.mode === 'mix' ? `${pads}amix=inputs=${audioSel.streams.length}:normalize=0:duration=longest,` : `${pads}`;
    fc += `;${src}aresample=async=1:first_pts=0,aformat=channel_layouts=mono,asplit=2[aenc][awav0];[awav0]aresample=16000[awav]`;
  }

  const bitrate = Math.min(6_000_000, Math.max(800_000, Math.round(enc.w * enc.h * outFps * 0.045)));
  const videoCodecs = [
    ['-c:v', 'h264_videotoolbox', '-b:v', String(bitrate), '-maxrate', String(Math.round(bitrate * 1.5)), '-bufsize', String(bitrate * 2), '-profile:v', 'high', '-allow_sw', '1'],
    ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p'],
  ];
  let lastErr;
  for (const vcodec of videoCodecs) {
    const args = ['-hide_banner', '-nostdin', '-y', ...seek, '-i', input, '-filter_complex', fc,
      '-map', '[venc]', ...vcodec, '-g', String(outFps * 2), '-tag:v', 'avc1'];
    if (audioSel.mode !== 'none') args.push('-map', '[aenc]', '-c:a', 'aac', '-b:a', '64k');
    args.push('-movflags', '+faststart', '-max_muxing_queue_size', '4096', ...limit, tmpMp4);
    if (audioSel.mode !== 'none') args.push('-map', '[awav]', '-c:a', 'pcm_s16le', ...limit, '-f', 'wav', wav);
    args.push('-map', '[vthumb]', '-f', 'rawvideo', '-pix_fmt', 'gray', ...limit, thumbs);
    try {
      await run(tools.ffmpeg, args, {
        timeoutMs: timeoutMs || Math.max(180_000, info.duration * 3000),
        onStderrLine: onProgress
          ? (line) => {
              const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line);
              if (m && dur > 0) onProgress(Math.min(1, (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) / dur));
            }
          : undefined,
      });
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      for (const f of [tmpMp4, wav, thumbs]) await fsp.rm(f, { force: true });
    }
  }
  if (lastErr) throw lastErr;
  await fsp.rename(tmpMp4, mp4);
  const thumbBuf = await fsp.readFile(thumbs);
  await fsp.rm(thumbs, { force: true });
  const frameSize = th.w * th.h;
  const count = Math.floor(thumbBuf.length / frameSize);
  const thumbFrames = [];
  for (let i = 0; i < count; i++) thumbFrames.push(thumbBuf.subarray(i * frameSize, (i + 1) * frameSize));
  return {
    mp4,
    wav: audioSel.mode !== 'none' && fs.existsSync(wav) ? wav : null,
    audioSelection: audioSel.mode,
    encoded: { width: enc.w, height: enc.h, fps: outFps },
    thumbs: { width: th.w, height: th.h, fps: thumbFps, frames: thumbFrames },
  };
}

/** Read a 16-bit PCM mono wav into an Int16Array (handles extra chunks). */
export function readWavMono16(file) {
  const buf = fs.readFileSync(file);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a wav file');
  let off = 12;
  let sampleRate = 16000;
  let channels = 1;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    let size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
    } else if (id === 'data') {
      if (size === 0xffffffff || body + size > buf.length) size = buf.length - body;
      const n = Math.floor(size / 2 / channels);
      const samples = new Int16Array(n);
      for (let i = 0; i < n; i++) samples[i] = buf.readInt16LE(body + i * 2 * channels);
      return { sampleRate, samples };
    }
    off = body + size + (size % 2);
  }
  throw new Error('wav has no data chunk');
}

/**
 * Presentation times (seconds from the file start) of every video frame, from a
 * demux-only scan (no decoding). Needed because on variable-frame-rate input `-ss t`
 * returns the first frame at or after t, not the frame that is on screen at t.
 */
export async function videoFrameTimes(tools, file, formatStart = 0) {
  const { stdout } = await run(tools.ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', file], { timeoutMs: 120_000 });
  const times = [];
  for (const line of stdout.split('\n')) {
    const v = Number(line.split(',')[0]);
    if (line && Number.isFinite(v)) times.push(v - formatStart);
  }
  return Float64Array.from(times).sort();
}

/** The seek time that returns the frame on screen at t: the last frame time <= t. */
export function onScreenSeek(frameTimes, t) {
  if (!frameTimes || !frameTimes.length) return t;
  let lo = 0;
  let hi = frameTimes.length - 1;
  if (frameTimes[0] > t) return Math.max(0, frameTimes[0]);
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (frameTimes[mid] <= t + 1e-4) lo = mid;
    else hi = mid - 1;
  }
  return Math.max(0, frameTimes[lo] - 0.001);
}

/**
 * Extract one JPEG at time t (seconds), longer side <= maxLong. seekOffset is added to
 * the seek (the picture start of a file whose audio starts first).
 */
export async function extractFrame(tools, src, t, outFile, { maxLong = 1568, srcWidth, srcHeight, seekOffset = 0 } = {}) {
  // JPEG wants full-range YUV; phone recordings are limited ("video") range.
  const tail = ':flags=lanczos:out_range=full,format=yuvj420p';
  let vf = `scale='if(gte(iw,ih),min(${maxLong},iw),-2)':'if(gte(iw,ih),-2,min(${maxLong},ih))'${tail}`;
  if (srcWidth && srcHeight) {
    const fit = fitLong(srcWidth, srcHeight, maxLong);
    vf = `scale=${fit.w}:${fit.h}${tail}`;
  }
  const tmp = outFile + '.tmp.jpg';
  const attempt = async (ss) => {
    await run(tools.ffmpeg, ['-hide_banner', '-nostdin', '-y', '-ss', (ss + seekOffset).toFixed(3), '-i', src, '-frames:v', '1', '-an', '-vf', vf, '-q:v', '3', '-f', 'image2', tmp], { timeoutMs: 60_000 });
    const st = await fsp.stat(tmp).catch(() => null);
    return st && st.size > 0;
  };
  let ok = await attempt(Math.max(0, t));
  // Seeking to the very end can return nothing; step back a little.
  for (const back of [0.2, 0.5, 1.0]) {
    if (ok) break;
    ok = await attempt(Math.max(0, t - back));
  }
  if (!ok) throw new Error(`could not extract a frame at ${t.toFixed(2)}s`);
  await fsp.rename(tmp, outFile);
  return outFile;
}

/** Extract several frames; with opts.frameTimes each one is the frame on screen at its time. */
export async function extractFrames(tools, src, items, opts = {}) {
  return mapLimit(items, opts.concurrency || 4, (it) => extractFrame(tools, src, opts.frameTimes ? onScreenSeek(opts.frameTimes, it.t) : it.t, it.file, opts));
}

/**
 * Contact sheet: every frame as a thumbnail with "#NN  MM:SS.s" burned in underneath.
 * frames: [{ file, t, index }]
 */
export async function contactSheet(tools, frames, outFile, { sheetWidth = 1568, srcWidth, srcHeight } = {}) {
  if (!frames.length) return null;
  const n = frames.length;
  const portrait = (srcHeight || 16) >= (srcWidth || 9);
  let cols = portrait ? (n <= 6 ? n : n <= 12 ? Math.ceil(n / 2) : 8) : n <= 2 ? n : n <= 9 ? 3 : 4;
  cols = Math.max(1, Math.min(cols, n));
  const rows = Math.ceil(n / cols);
  const gap = 6;
  const tw = even((sheetWidth - gap * (cols + 1)) / cols);
  const aspect = srcWidth && srcHeight ? srcHeight / srcWidth : portrait ? 1920 / 886 : 9 / 16;
  const thH = even(tw * aspect);
  const scale = tw >= 230 ? 3 : 2;
  const labelH = even(7 * scale + 10);
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'sb-sheet-'));
  try {
    const labels = [];
    for (let i = 0; i < rows * cols; i++) {
      const f = frames[i];
      const text = f ? `#${String(f.index).padStart(2, '0')} ${fmtTime(f.t)}` : '';
      const s = f && textWidth(text, scale) + 12 > tw ? Math.max(1, scale - 1) : scale;
      labels.push(renderLabel(text, tw, labelH, { scale: s }));
      const src = f ? f.file : frames[frames.length - 1].file;
      await fsp.symlink(src, path.join(tmp, `c${String(i + 1).padStart(4, '0')}.jpg`));
    }
    const labelFile = path.join(tmp, 'labels.raw');
    await fsp.writeFile(labelFile, Buffer.concat(labels));
    // Blank out padding cells (index >= n) by drawing a full box over them.
    const fc = `[0:v]scale=${tw}:${thH}:force_original_aspect_ratio=decrease,pad=${tw}:${thH}:-1:-1:color=0x303030,format=rgb24,` +
      `drawbox=x=0:y=0:w=iw:h=ih:color=0x202020:t=fill:enable='gte(n,${n})'[f];` +
      `[1:v]format=rgb24[l];[f][l]vstack,tile=${cols}x${rows}:margin=${gap}:padding=${gap}:color=0x202020`;
    await run(tools.ffmpeg, ['-hide_banner', '-nostdin', '-y', '-framerate', '1', '-start_number', '1', '-i', path.join(tmp, 'c%04d.jpg'),
      '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${tw}x${labelH}`, '-framerate', '1', '-i', labelFile,
      '-filter_complex', fc, '-frames:v', '1', '-q:v', '3', '-update', '1', outFile], { timeoutMs: 120_000 });
    return { file: outFile, cols, rows };
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}
