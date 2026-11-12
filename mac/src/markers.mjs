// Touch markers: from the phone's meta.markers and from the optional detector at
// src/touch-detect.mjs (written separately; loaded only if present and working).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const KINDS = new Set(['tap', 'longpress', 'drag']);
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/** Validate and clean one marker; returns null if unusable. */
export function normalizeMarker(m, source, duration = Infinity) {
  if (!m || typeof m !== 'object') return null;
  const t = Number(m.t);
  const x = Number(m.x);
  const y = Number(m.y);
  if (!finite(t) || !finite(x) || !finite(y) || t < 0 || t > duration + 1) return null;
  const kind = KINDS.has(m.kind) ? m.kind : 'tap';
  const tEnd = finite(Number(m.tEnd)) && Number(m.tEnd) >= t ? Number(m.tEnd) : t;
  const out = { t, tEnd, kind, x: clamp01(x), y: clamp01(y), source };
  if (Array.isArray(m.path)) {
    const p = m.path
      .filter((q) => Array.isArray(q) && q.length >= 3 && q.every((v) => finite(Number(v))))
      .map(([pt, px, py]) => [Number(pt), clamp01(Number(px)), clamp01(Number(py))]);
    if (p.length) out.path = p;
  }
  if (m.bbox && ['x', 'y', 'w', 'h'].every((k) => finite(Number(m.bbox[k])))) {
    out.bbox = { x: clamp01(Number(m.bbox.x)), y: clamp01(Number(m.bbox.y)), w: clamp01(Number(m.bbox.w)), h: clamp01(Number(m.bbox.h)) };
  }
  return out;
}

const DETECTOR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'touch-detect.mjs');

/** Run the optional detector. Never throws; reports what happened. */
export async function detectMarkers(videoPath, opts = {}, { timeoutMs = 180_000, detectorPath = process.env.SCREENBRIEF_TOUCH_DETECT || DETECTOR } = {}) {
  if (!fs.existsSync(detectorPath)) return { markers: [], status: 'absent' };
  let timer;
  const abort = new AbortController();
  try {
    const mod = await import(pathToFileURL(detectorPath).href);
    if (typeof mod.detectTouches !== 'function') return { markers: [], status: 'no detectTouches export' };
    const result = await Promise.race([
      Promise.resolve(mod.detectTouches(videoPath, { ...opts, timeoutMs, signal: abort.signal })),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          abort.abort();
          reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs + 2000);
      }),
    ]);
    const list = result && Array.isArray(result.markers) ? result.markers : [];
    return { markers: list, status: `ok (${list.length})` };
  } catch (err) {
    return { markers: [], status: `failed: ${String((err && err.message) || err).slice(0, 300)}` };
  } finally {
    clearTimeout(timer);
  }
}

/** Phone markers win over detected ones that describe the same touch. */
export function mergeMarkers(phone, detected) {
  const out = [...phone];
  for (const d of detected) {
    const dup = out.some((p) => p.kind === d.kind && Math.abs(p.t - d.t) < 0.35 && Math.hypot(p.x - d.x, p.y - d.y) < 0.06);
    if (!dup) out.push(d);
  }
  return out.sort((a, b) => a.t - b.t);
}

const pct = (v) => `${Math.round(v * 100)}%`;
const at = (x, y) => `${pct(x)} across, ${pct(y)} down`;

/** "tapped at 42% across, 71% down" */
export function describeMarker(m) {
  if (m.kind === 'drag') {
    const end = m.path && m.path.length ? m.path[m.path.length - 1] : null;
    if (end) return `dragged from ${at(m.x, m.y)} to ${at(end[1], end[2])}`;
    return `dragged starting at ${at(m.x, m.y)}`;
  }
  if (m.kind === 'longpress') return `long-pressed at ${at(m.x, m.y)}${m.tEnd > m.t ? ` for ${(m.tEnd - m.t).toFixed(1)}s` : ''}`;
  return `tapped at ${at(m.x, m.y)}`;
}
