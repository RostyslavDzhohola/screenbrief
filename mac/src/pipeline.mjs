// The pipeline: video -> bundle directory with recording.mp4, frames/, contact-sheet.jpg,
// transcript.json, timeline.json, meta.json and FEEDBACK.md. Stages are written to
// status.json as they happen: transcoding, transcribing, frames, writing.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { probe, transcode, extractFrames, contactSheet, videoFrameTimes, remux, metaRotation, pictureStart } from './media.mjs';
import { transcribe } from './transcribe.mjs';
import { selectFrames } from './select-frames.mjs';
import { normalizeMarker, detectMarkers, mergeMarkers } from './markers.mjs';
import { buildTimeline, renderFeedback, frameLabel } from './feedback.mjs';
import { writeJsonAtomic, readJsonSync, fmtTimeForName, stampLocal, id8, randomId, log } from './util.mjs';
import { paths, tools as toolPaths, loadConfig, CLI_PATH, VERSION } from './config.mjs';

export function bundleDirName(id, date) {
  return `${stampLocal(date)}-${id8(id)}`;
}

export function deviceString(meta) {
  const d = meta && meta.device;
  if (!d) return null;
  const name = d.model || d.name;
  return [name, d.os].filter(Boolean).join(', ') || null;
}

export async function writeStatus(dir, status) {
  await writeJsonAtomic(path.join(dir, 'status.json'), { ...status, updatedAt: new Date().toISOString() });
}

export function readStatus(dir) {
  return readJsonSync(path.join(dir, 'status.json'), null);
}

/**
 * Process one video into a bundle.
 * opts: { outDir, id, note, meta (phone meta), cfg, onStatus(status) }
 * Returns the bundle summary (also what loadBundle() reads back).
 */
export async function processVideo(input, opts = {}) {
  const cfg = opts.cfg || loadConfig({ create: false });
  const tools = opts.tools || toolPaths(cfg);
  const meta = opts.meta || {};
  const id = opts.id || meta.id || randomId();
  const recordedAt = meta.startedAt && !Number.isNaN(Date.parse(meta.startedAt)) ? new Date(meta.startedAt) : new Date();
  const dir = path.resolve(opts.outDir || path.join(paths().recordings, bundleDirName(id, recordedAt)));
  const note = [opts.note, meta.note].filter((x) => x && String(x).trim()).map((x) => String(x).trim()).filter((x, i, a) => a.indexOf(x) === i).join(' / ') || null;
  const timings = {};
  let stageStart = Date.now();
  const status = async (stage, extra = {}) => {
    const now = Date.now();
    const s = { state: 'processing', stage, ...extra };
    await writeStatus(dir, s);
    if (opts.onStatus) opts.onStatus(s);
    stageStart = now;
  };
  const endStage = (name) => {
    timings[name] = Number(((Date.now() - stageStart) / 1000).toFixed(2));
  };
  const t0 = Date.now();
  await fsp.mkdir(dir, { recursive: true });
  let rotatedInput = null;
  try {
    if (!fs.existsSync(input)) throw new Error(`input not found: ${input}`);
    // 1. transcoding
    await status('transcoding');
    // Leftovers from an interrupted earlier attempt.
    for (const f of await fsp.readdir(dir)) {
      if (/^(recording\..+\.tmp\.mp4|audio\..+\.wav|audio\..+\.whisper\.json|thumbs\..+\.raw|input\.rotated\..+\.mov)$/.test(f)) await fsp.rm(path.join(dir, f), { force: true });
    }
    // meta.rotation (degrees clockwise to display upright) replaces the file's own display
    // matrix, through a stream-copy remux, so the transcode, the stills and the touch
    // detector all see the picture upright.
    const rotation = metaRotation(meta.rotation);
    let src = input;
    if (rotation) {
      rotatedInput = path.join(dir, `input.rotated.${process.pid}-${Date.now().toString(36)}.mov`);
      await remux(tools, input, rotatedInput, { rotation, timeoutMs: 600_000 });
      src = rotatedInput;
    }
    const info = await probe(tools, src);
    if (!info.video) throw new Error('this file has no video stream');
    let lastWrite = 0;
    const tr = await transcode(tools, src, info, dir, {
      onProgress: (p) => {
        const now = Date.now();
        if (now - lastWrite > 1000) {
          lastWrite = now;
          writeStatus(dir, { state: 'processing', stage: 'transcoding', progress: Number(p.toFixed(2)) }).catch(() => {});
        }
      },
    });
    const outInfo = await probe(tools, tr.mp4);
    const durationSec = outInfo.duration || Math.max(0, info.duration - pictureStart(info));
    endStage('transcoding');

    // Touch detection decodes the video on the CPU; run it while whisper uses the GPU.
    const detectStart = Date.now();
    const detecting = detectMarkers(src, {
      durationSec,
      width: tr.encoded.width,
      height: tr.encoded.height,
      recordingPath: tr.mp4,
      bundleDir: dir,
      ffmpegPath: tools.ffmpeg,
      ffprobePath: tools.ffprobe,
    }, { timeoutMs: Math.max(120_000, durationSec * 2000) }).then((r) => ({ ...r, seconds: Number(((Date.now() - detectStart) / 1000).toFixed(2)) }));

    // 2. transcribing
    await status('transcribing');
    const transcript = await transcribe(tools, tr.wav, { language: cfg.language, beam: cfg.whisperBeam || 1, durationSec });
    if (tr.wav) await fsp.rm(tr.wav, { force: true });
    transcript.audioSelection = tr.audioSelection;
    endStage('transcribing');

    // 3. frames (touch markers, selection, extraction, contact sheet)
    await status('frames');
    const phoneMarkers = (Array.isArray(meta.markers) ? meta.markers : []).map((m) => normalizeMarker(m, 'phone', durationSec)).filter(Boolean);
    const detection = await detecting;
    timings.touchDetect = detection.seconds;
    const detected = detection.markers.map((m) => normalizeMarker(m, 'detected', durationSec)).filter(Boolean);
    const markers = mergeMarkers(phoneMarkers, detected);
    const sel = selectFrames({
      thumbs: tr.thumbs.frames,
      fps: tr.thumbs.fps,
      duration: durationSec,
      phrases: transcript.phrases,
      markers,
      maxFrames: cfg.maxFrames || 40,
      fallbackIntervalSec: cfg.fallbackIntervalSec || 12,
    });
    const framesDir = path.join(dir, 'frames');
    await fsp.rm(framesDir, { recursive: true, force: true });
    await fsp.mkdir(framesDir, { recursive: true });
    const frames = sel.frames.map((f, i) => ({
      index: i + 1,
      t: f.t,
      file: path.join(framesDir, `f${String(i + 1).padStart(3, '0')}-${fmtTimeForName(f.t)}.jpg`),
      reasons: f.reasons.map((r) => ({ kind: r.kind, t: Number(r.t.toFixed(2)), ...(r.merged ? { merged: true } : {}) })),
    }));
    // Stills come from the original upload (sharper than the re-encode); same timeline,
    // which starts at the first video frame.
    try {
      const vs = pictureStart(info);
      const frameTimes = await videoFrameTimes(tools, src, info.formatStart + vs);
      if (!frameTimes.length) throw new Error('no video frame timestamps');
      await extractFrames(tools, src, frames, { srcWidth: tr.encoded.width, srcHeight: tr.encoded.height, frameTimes, seekOffset: vs });
    } catch (err) {
      log('frame extraction from the original failed, using recording.mp4:', err.message);
      await extractFrames(tools, tr.mp4, frames, { srcWidth: tr.encoded.width, srcHeight: tr.encoded.height });
    }
    let sheet = null;
    try {
      sheet = await contactSheet(tools, frames, path.join(dir, 'contact-sheet.jpg'), { srcWidth: tr.encoded.width, srcHeight: tr.encoded.height });
    } catch (err) {
      log('contact sheet failed:', err.message);
    }
    endStage('frames');

    // 4. writing
    await status('writing');
    const sections = buildTimeline({ durationSec, phrases: transcript.phrases, frames, markers });
    const bundle = {
      id,
      dir,
      cliPath: CLI_PATH,
      recordingPath: tr.mp4,
      feedbackPath: path.join(dir, 'FEEDBACK.md'),
      contactSheet: sheet ? sheet.file : null,
      durationSec,
      width: tr.encoded.width,
      height: tr.encoded.height,
      recordedAt: recordedAt.toISOString(),
      device: deviceString(meta),
      note,
      interrupted: meta.interrupted === true,
      transcript,
      frames,
      markers,
      sections,
    };
    await writeJsonAtomic(path.join(dir, 'transcript.json'), transcript);
    await writeJsonAtomic(path.join(dir, 'timeline.json'), {
      version: 1,
      durationSec,
      timeBase: 'seconds from the start of recording.mp4',
      coordinates: 'markers: x,y as fractions of the frame from the top-left',
      sections: sections.map((s) => ({
        ...s,
        frames: s.frames.map((i) => frames[i].file),
        markers: s.markers.map((m) => ({ ...m, frame: frames[m.frame] ? frames[m.frame].file : null })),
      })),
      frames: frames.map((f) => ({ index: f.index, t: f.t, file: f.file, label: frameLabel(f), reasons: f.reasons })),
      markers,
      phrases: transcript.phrases,
      screenChanges: sel.changes,
    });
    timings.total = Number(((Date.now() - t0) / 1000).toFixed(2));
    await writeJsonAtomic(path.join(dir, 'meta.json'), {
      id,
      version: VERSION,
      createdAt: new Date().toISOString(),
      recordedAt: bundle.recordedAt,
      durationSec,
      width: bundle.width,
      height: bundle.height,
      device: bundle.device,
      note,
      ...(bundle.interrupted ? { interrupted: true } : {}),
      ...(rotation ? { rotationApplied: rotation } : {}),
      input: { file: path.basename(input), format: info.formatName, video: info.video, audio: info.audio, sizeBytes: info.sizeBytes },
      encoded: tr.encoded,
      audio: transcript.audio.state,
      frameCount: frames.length,
      markerCount: markers.length,
      touchDetector: `${detection.status}, ${detection.seconds}s`,
      whisperModel: transcript.model,
      timings,
      phoneMeta: Object.keys(meta).length ? meta : undefined,
      paths: { feedback: bundle.feedbackPath, recording: bundle.recordingPath, contactSheet: bundle.contactSheet, frames: framesDir },
    });
    await fsp.writeFile(bundle.feedbackPath, renderFeedback(bundle));
    endStage('writing');
    await writeStatus(dir, { state: 'ready', stage: 'done', timings });
    if (opts.onStatus) opts.onStatus({ state: 'ready', stage: 'done' });
    return bundle;
  } catch (err) {
    await writeStatus(dir, { state: 'failed', stage: 'failed', error: String(err.message || err).slice(0, 2000) }).catch(() => {});
    throw err;
  } finally {
    if (rotatedInput) await fsp.rm(rotatedInput, { force: true }).catch(() => {});
  }
}

/** Read a finished bundle back from disk (for `send` and the server). */
export function loadBundle(dir) {
  const meta = readJsonSync(path.join(dir, 'meta.json'), null);
  const transcript = readJsonSync(path.join(dir, 'transcript.json'), null);
  const timeline = readJsonSync(path.join(dir, 'timeline.json'), null);
  if (!meta || !transcript) return null;
  return {
    id: meta.id,
    dir,
    feedbackPath: path.join(dir, 'FEEDBACK.md'),
    recordingPath: path.join(dir, 'recording.mp4'),
    contactSheet: meta.paths && meta.paths.contactSheet,
    durationSec: meta.durationSec,
    width: meta.width,
    height: meta.height,
    recordedAt: meta.recordedAt,
    createdAt: meta.createdAt,
    device: meta.device,
    note: meta.note,
    transcript,
    frames: (timeline && timeline.frames) || [],
    markers: (timeline && timeline.markers) || [],
    frameCount: meta.frameCount,
    timings: meta.timings,
  };
}
