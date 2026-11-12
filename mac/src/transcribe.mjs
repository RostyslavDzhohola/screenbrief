// Speech: an energy-based voice-activity map of the audio, whisper.cpp transcription,
// splitting into short timestamped phrases, and filtering whisper's inventions on
// silence ("Thank you.", "[BLANK_AUDIO]", ...).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { run } from './util.mjs';
import { readWavMono16 } from './media.mjs';

const HOP_SEC = 0.03;

/** Voice-activity map from 16-bit mono PCM. */
export function analyzeAudio(wavFile) {
  const { sampleRate, samples } = readWavMono16(wavFile);
  const hop = Math.max(1, Math.round(sampleRate * HOP_SEC));
  const n = Math.floor(samples.length / hop);
  const db = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = i * hop; j < (i + 1) * hop; j++) sum += samples[j] * samples[j];
    const rms = Math.sqrt(sum / hop) / 32768;
    db[i] = rms > 1e-6 ? 20 * Math.log10(rms) : -120;
  }
  const durationSec = samples.length / sampleRate;
  if (!n) return { durationSec, silent: true, voiced: [], voicedSec: 0, peakDb: -120, floorDb: -120, thresholdDb: 0 };
  const sorted = Array.from(db).sort((a, b) => a - b);
  const pct = (p) => sorted[Math.min(n - 1, Math.max(0, Math.floor(p * (n - 1))))];
  const floorDb = pct(0.1);
  const peakDb = pct(0.995);
  const thresholdDb = Math.max(-58, floorDb + Math.max(6, (peakDb - floorDb) * 0.35));
  // Runs of loud hops, bridged over short gaps, minimum length, padded.
  const runs = [];
  let start = -1;
  for (let i = 0; i <= n; i++) {
    const on = i < n && db[i] > thresholdDb;
    if (on && start < 0) start = i;
    if (!on && start >= 0) {
      runs.push([start * HOP_SEC, i * HOP_SEC]);
      start = -1;
    }
  }
  const merged = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && r[0] - last[1] < 0.3) last[1] = r[1];
    else merged.push([...r]);
  }
  const voiced = merged
    .filter((r) => r[1] - r[0] >= 0.12)
    .map(([a, b]) => [Math.max(0, a - 0.15), Math.min(durationSec, b + 0.15)]);
  const voicedSec = voiced.reduce((s, [a, b]) => s + (b - a), 0);
  // Silent: nothing above about -55 dBFS, or a level so flat there is no speech-like contrast.
  const silent = peakDb < -55 || peakDb - floorDb < 6 || voicedSec < 0.3;
  return { durationSec, silent, voiced: silent ? [] : voiced, voicedSec: silent ? 0 : voicedSec, peakDb, floorDb, thresholdDb };
}

/** Fraction of [a,b] covered by voiced intervals. */
export function voicedFraction(voiced, a, b) {
  const len = b - a;
  if (len <= 0) return 0;
  let cov = 0;
  for (const [x, y] of voiced) {
    const lo = Math.max(a, x);
    const hi = Math.min(b, y);
    if (hi > lo) cov += hi - lo;
  }
  return cov / len;
}

const NON_SPEECH_RE = /^\s*[\[(*♪♫][^\])*]*[\])*♪♫]?\s*$/;
const HALLUCINATIONS = new Set([
  'thank you', 'thank you very much', 'thanks', 'thanks for watching', 'thank you for watching', 'thank you so much for watching',
  'you', 'bye', 'bye bye', 'goodbye', 'please subscribe', 'subscribe', 'like and subscribe', 'so', 'oh', 'uh', 'um', 'hmm', 'mm', 'ah',
  'subtitles by the amaraorg community', 'thank you for your attention', 'see you next time', 'the end', 'okay bye',
]);
const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, '').replace(/\s+/g, ' ').trim();

export function isNonSpeechText(text) {
  const t = text.trim();
  if (!t) return true;
  if (NON_SPEECH_RE.test(t)) return true;
  if (/^\[?_?(BLANK_AUDIO|SILENCE|MUSIC|NOISE|INAUDIBLE)_?\]?$/i.test(t)) return true;
  return normalize(t) === '';
}

/** Run whisper-cli and return its full JSON. */
export async function runWhisper(tools, wavFile, { language = 'en', threads = 4, beam = 1, timeoutMs = 600_000 } = {}) {
  if (!fs.existsSync(tools.model)) throw new Error(`whisper model not found at ${tools.model}`);
  const base = wavFile.replace(/\.wav$/i, '') + '.whisper';
  const args = ['-m', tools.model, '-f', wavFile, '-oj', '-ojf', '-of', base, '-np', '-l', language || 'en', '-t', String(threads), '-sns',
    '-bs', String(beam), '-bo', String(Math.max(beam, 1))];
  const preset = dtwPreset(tools.model);
  try {
    // DTW token alignment needs flash attention off.
    await run(tools.whisper, preset ? [...args, '-dtw', preset, '-nfa'] : args, { timeoutMs });
  } catch (err) {
    if (!preset || err.timedOut) throw err;
    await run(tools.whisper, args, { timeoutMs });
  }
  const json = JSON.parse(await fsp.readFile(base + '.json', 'utf8'));
  await fsp.rm(base + '.json', { force: true });
  return json;
}

/** whisper.cpp DTW alignment preset for a model file, or null if unknown. */
export function dtwPreset(modelPath) {
  const b = path.basename(modelPath).toLowerCase().replace(/^ggml-/, '').replace(/\.bin$/, '').replace(/-q\d.*$/, '');
  const map = {
    'large-v3-turbo': 'large.v3.turbo', 'large-v3': 'large.v3', 'large-v2': 'large.v2', 'large-v1': 'large.v1',
    'medium.en': 'medium.en', medium: 'medium', 'small.en': 'small.en', small: 'small',
    'base.en': 'base.en', base: 'base', 'tiny.en': 'tiny.en', tiny: 'tiny',
  };
  return map[b] || null;
}

/**
 * Whisper JSON -> segments with word timings. Uses DTW token times (t_dtw, in
 * centiseconds) when present: they are much closer to the real onsets than the
 * plain token offsets, which tend to start at the segment start.
 */
export function wordsFromWhisper(json, offsetSec = 0) {
  const segments = [];
  for (const seg of json.transcription || []) {
    const segStart = seg.offsets.from / 1000;
    const segEnd = seg.offsets.to / 1000;
    const words = [];
    let cur = null;
    for (const tok of seg.tokens || []) {
      const text = tok.text || '';
      if (/^\[_[A-Z_]+_?\d*\]$/.test(text) || /^<\|.*\|>$/.test(text)) continue; // special tokens
      const plain = tok.offsets ? tok.offsets.from / 1000 : segStart;
      const t = typeof tok.t_dtw === 'number' && tok.t_dtw >= 0 ? tok.t_dtw / 100 : plain;
      const startsWord = /^\s/.test(text) || !cur;
      const isPunct = /^[.,!?;:'")\]-]+$/.test(text.trim()) && !/^\s/.test(text);
      if (startsWord && !isPunct) {
        cur = { text: text.trim(), start: t };
        words.push(cur);
      } else if (cur) {
        cur.text += text;
      }
    }
    const ws = words.filter((w) => w.text.trim());
    // Word ends: estimated from length, never past the next word's start.
    for (let i = 0; i < ws.length; i++) {
      const est = ws[i].start + 0.12 + 0.065 * ws[i].text.length;
      const next = i + 1 < ws.length ? ws[i + 1].start : Math.max(segEnd, est);
      ws[i].end = Math.max(ws[i].start + 0.05, Math.min(est, next));
    }
    for (const w of ws) {
      w.start += offsetSec;
      w.end += offsetSec;
    }
    segments.push({ start: segStart + offsetSec, end: segEnd + offsetSec, text: (seg.text || '').trim(), words: ws });
  }
  return segments;
}

/**
 * Pull phrase edges onto the voiced audio: a start just before/after a voice onset
 * moves to the onset; an end inside a voiced stretch extends to its end.
 */
export function snapToVoice(phrases, voiced) {
  return phrases.map((p, i) => {
    let { start, end } = p;
    const prevEnd = i > 0 ? phrases[i - 1].end : 0;
    const onset = voiced.find(([a, b]) => b > start - 0.1 && a < start + 0.5 && a >= prevEnd - 0.05);
    if (onset && Math.abs(onset[0] - start) <= 0.6) start = Math.max(prevEnd, onset[0]);
    const nextStart = i + 1 < phrases.length ? phrases[i + 1].start : Infinity;
    const inside = voiced.find(([a, b]) => a <= end && b >= end);
    if (inside && inside[1] - end <= 1.5) end = Math.min(inside[1], nextStart);
    return { ...p, start, end: Math.max(end, start + 0.1) };
  });
}

/** Split segments into short phrases at sentence ends, pauses, or length limits. */
export function phrasesFromSegments(segments, { maxWords = 16, pauseSec = 0.8 } = {}) {
  const phrases = [];
  for (const seg of segments) {
    const words = seg.words.length ? seg.words : [{ text: seg.text, start: seg.start, end: seg.end }];
    let cur = [];
    const flush = () => {
      if (!cur.length) return;
      phrases.push({ start: cur[0].start, end: cur[cur.length - 1].end, text: cur.map((w) => w.text).join(' ').replace(/\s+([.,!?;:])/g, '$1').trim() });
      cur = [];
    };
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const prev = cur[cur.length - 1];
      if (prev && w.start - prev.end > pauseSec) flush();
      cur.push(w);
      const sentenceEnd = /[.!?]["')]?$/.test(w.text) && cur.length >= 2;
      if (sentenceEnd) flush();
      else if (cur.length >= maxWords) {
        // Prefer splitting at the last comma in the phrase.
        let cut = -1;
        for (let k = cur.length - 2; k >= Math.floor(maxWords / 2); k--) if (/,$/.test(cur[k].text)) { cut = k; break; }
        if (cut >= 0) {
          const rest = cur.slice(cut + 1);
          cur = cur.slice(0, cut + 1);
          flush();
          cur = rest;
        } else if (cur.length >= maxWords + 6) flush();
      }
    }
    flush();
  }
  return phrases.filter((p) => p.text);
}

/**
 * Drop phrases whisper most likely invented: non-speech markers, stock phrases over
 * silence, anything with almost no voiced audio under it, and repetition loops.
 */
export function filterPhrases(phrases, vad) {
  const kept = [];
  const dropped = [];
  for (const p of phrases) {
    const a = p.start - 0.4;
    const b = p.end + 0.4;
    const vf = vad.silent ? 0 : voicedFraction(vad.voiced, a, b);
    const norm = normalize(p.text);
    let reason = null;
    if (vad.silent) reason = 'audio is silent';
    else if (isNonSpeechText(p.text)) reason = 'non-speech marker';
    else if (HALLUCINATIONS.has(norm) && vf < 0.5) reason = 'stock phrase over silence';
    else if (vf < 0.12) reason = 'no voice under it';
    else {
      const last = kept[kept.length - 1];
      const last2 = kept[kept.length - 2];
      if (last && last2 && normalize(last.text) === norm && normalize(last2.text) === norm) reason = 'repetition loop';
      // Whisper sometimes re-emits the end of what was just said (often at the end of the audio).
      const recentText = kept.filter((k) => p.start - k.end < 6).map((k) => normalize(k.text)).join(' ');
      if (!reason && norm.split(' ').length >= 2 && recentText.includes(norm)) reason = 'repeats the previous phrase';
    }
    if (reason) dropped.push({ ...p, reason });
    else kept.push({ ...p, text: p.text.replace(/\s*\[[A-Z_ ]+\]\s*/g, ' ').trim() });
  }
  return { kept, dropped };
}

/**
 * Full speech pass. Returns the transcript.json object.
 * audioState: 'none' (no audio track), 'silent', 'speech', 'no-words' (voice but nothing recognised).
 */
export async function transcribe(tools, wavFile, { language = 'en', beam = 1, durationSec } = {}) {
  if (!wavFile) {
    return { audio: { state: 'none', note: 'The recording has no audio track.' }, language, model: null, phrases: [], segments: [], dropped: [] };
  }
  const vad = analyzeAudio(wavFile);
  const audioInfo = {
    peakDb: Number(vad.peakDb.toFixed(1)),
    floorDb: Number(vad.floorDb.toFixed(1)),
    voicedSec: Number(vad.voicedSec.toFixed(2)),
    voiced: vad.voiced.map(([a, b]) => [Number(a.toFixed(2)), Number(b.toFixed(2))]),
  };
  if (vad.silent) {
    return { audio: { state: 'silent', note: 'The audio track is silent; nothing was said.', ...audioInfo }, language, model: path.basename(tools.model), phrases: [], segments: [], dropped: [] };
  }
  const dur = durationSec || vad.durationSec;
  const json = await runWhisper(tools, wavFile, { language, beam, timeoutMs: Math.max(180_000, dur * 3000) });
  const segments = wordsFromWhisper(json);
  const phrases = phrasesFromSegments(segments);
  const filtered = filterPhrases(phrases, vad);
  const kept = snapToVoice(filtered.kept, vad.voiced);
  const dropped = filtered.dropped;
  const round = (p) => ({ start: Number(p.start.toFixed(2)), end: Number(Math.max(p.end, p.start + 0.1).toFixed(2)), text: p.text });
  const state = kept.length ? 'speech' : 'no-words';
  return {
    audio: { state, note: state === 'no-words' ? 'There is sound on the audio track but no words were recognised.' : undefined, ...audioInfo },
    language: (json.result && json.result.language) || language,
    model: path.basename(tools.model),
    phrases: kept.map(round),
    segments: segments.map((s) => ({ start: Number(s.start.toFixed(2)), end: Number(s.end.toFixed(2)), text: s.text })),
    dropped: dropped.map((d) => ({ ...round(d), reason: d.reason })),
  };
}
