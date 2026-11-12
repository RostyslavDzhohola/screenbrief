// Chooses which moments become keyframes. Works on the tiny grayscale thumbnails from
// the transcode pass (about 72 px wide, 5 per second): a frame-to-frame change signal
// finds screen transitions, and the frame is taken once the transition has settled.

const PIXEL_DELTA = 14; // gray levels a pixel must move to count as changed

/** Fraction of pixels that differ between two thumbnails. */
export function changedFraction(a, b) {
  if (!a || !b || a.length !== b.length) return 1;
  let n = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > PIXEL_DELTA) n++;
  return n / a.length;
}

/**
 * Screen-change events from the thumbnail sequence.
 * Returns [{ t (settled time), start, end, magnitude }].
 */
export function detectScreenChanges(thumbs, { fps, activeThreshold = 0.004, minChange = 0.02, settleSamples = 2, maxTransitionSec = 3 } = {}) {
  const n = thumbs.length;
  if (n < 2) return [];
  const diff = new Float32Array(n);
  for (let i = 1; i < n; i++) diff[i] = changedFraction(thumbs[i - 1], thumbs[i]);
  const events = [];
  let i = 1;
  while (i < n) {
    if (diff[i] <= activeThreshold) {
      i++;
      continue;
    }
    // A run of moving samples; it ends after `settleSamples` quiet samples in a row.
    const start = i;
    let j = i;
    let quiet = 0;
    let last = i;
    while (j < n) {
      if (diff[j] > activeThreshold) {
        quiet = 0;
        last = j;
      } else if (++quiet >= settleSamples) break;
      j++;
      // Continuous motion (scrolling, video): cut a long transition into pieces.
      if ((j - start) / fps >= maxTransitionSec && quiet === 0) break;
    }
    const settled = Math.min(n - 1, last + 1);
    const before = thumbs[start - 1];
    const after = thumbs[settled];
    const magnitude = changedFraction(before, after);
    if (magnitude >= minChange) {
      events.push({ t: settled / fps, start: (start - 1) / fps, end: settled / fps, magnitude: Number(magnitude.toFixed(3)) });
    }
    i = Math.max(j, start + 1);
  }
  return events;
}

const PRIORITY = { marker: 5, start: 4, scene: 4, end: 3, speech: 3, fallback: 1 };

/**
 * Choose keyframes.
 *  thumbs: Buffer[] at `fps`; duration: seconds; phrases: [{start,end}]; markers: [{t}]
 * Returns { frames: [{ t, reasons: [...], thumbIndex }], changes }.
 */
export function selectFrames({ thumbs, fps, duration, phrases = [], markers = [], maxFrames = 40, fallbackIntervalSec = 12, dedupeThreshold = 0.012 }) {
  const n = thumbs.length;
  const videoEnd = n ? Math.min(duration || n / fps, (n - 1) / fps) : duration || 0;
  const changes = detectScreenChanges(thumbs, { fps });
  const idxAt = (t) => Math.max(0, Math.min(n - 1, Math.round(t * fps)));
  const settledAt = (t) => {
    // If t falls inside a transition, use the settled frame instead.
    const ev = changes.find((c) => t >= c.start && t < c.end);
    return ev ? ev.t : t;
  };

  const cands = [];
  const add = (t, kind, ref) => cands.push({ t: Math.max(0, Math.min(videoEnd, t)), kind, ref });
  // Start: the first settled moment (skip a broadcast's opening transition).
  add(settledAt(Math.min(0.4, videoEnd)), 'start');
  for (const c of changes) add(c.t, 'scene', c);
  phrases.forEach((p, i) => add(settledAt(p.start), 'speech', i));
  markers.forEach((m, i) => add(m.t, 'marker', i));
  add(Math.max(0, videoEnd - 0.3), 'end');
  // Fallback: one frame every `fallbackIntervalSec` through long stretches with nothing else.
  const sortedTimes = () => cands.map((c) => c.t).sort((a, b) => a - b);
  let times = sortedTimes();
  for (let k = 0; k + 1 < times.length; k++) {
    const gap = times[k + 1] - times[k];
    if (gap > fallbackIntervalSec * 1.5) {
      const count = Math.floor(gap / fallbackIntervalSec);
      for (let q = 1; q <= count; q++) add(times[k] + (gap * q) / (count + 1), 'fallback');
    }
  }
  cands.sort((a, b) => a.t - b.t || PRIORITY[b.kind] - PRIORITY[a.kind]);

  // Dedupe: a candidate that looks like the previous kept frame joins it instead.
  const kept = [];
  for (const c of cands) {
    const ti = idxAt(c.t);
    const prev = kept[kept.length - 1];
    const reason = { kind: c.kind, ref: c.ref, t: c.t };
    if (prev && (Math.abs(prev.t - c.t) < 0.15 || changedFraction(thumbs[prev.thumbIndex], thumbs[ti]) < dedupeThreshold)) {
      prev.reasons.push(reason);
      prev.priority = Math.max(prev.priority, PRIORITY[c.kind]);
      continue;
    }
    kept.push({ t: c.t, thumbIndex: ti, reasons: [reason], priority: PRIORITY[c.kind] });
  }

  // Cap: drop the least important frame (lowest priority, then closest to its neighbours)
  // until within budget; its reasons move to the frame showing the screen just before.
  while (kept.length > Math.max(2, maxFrames)) {
    let worst = -1;
    let worstScore = Infinity;
    for (let k = 1; k < kept.length; k++) {
      const left = kept[k].t - kept[k - 1].t;
      const right = k + 1 < kept.length ? kept[k + 1].t - kept[k].t : left;
      const score = kept[k].priority * 1000 + Math.min(left, right);
      if (score < worstScore) {
        worstScore = score;
        worst = k;
      }
    }
    const [gone] = kept.splice(worst, 1);
    kept[worst - 1].reasons.push(...gone.reasons.map((r) => ({ ...r, merged: true })));
  }
  return { frames: kept.map((k) => ({ t: Number(k.t.toFixed(2)), thumbIndex: k.thumbIndex, reasons: k.reasons })), changes };
}

/** Index of the kept frame that shows the screen at time t (last frame at or before t). */
export function frameIndexAt(frames, t) {
  let best = 0;
  for (let i = 0; i < frames.length; i++) if (frames[i].t <= t + 0.05) best = i;
  return best;
}
