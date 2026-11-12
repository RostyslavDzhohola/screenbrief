// ScreenBrief touch detector.
//
// Finds the touch marks drawn by the ScreenBrief debug overlay
// (overlays/react-native/ScreenBriefTouches.tsx, overlays/swiftui/ScreenBriefTouches.swift)
// in a screen recording and turns them into timestamped markers.
//
//   import { detectTouches } from "./touch-detect.mjs";
//   const { markers } = await detectTouches("/path/to/recording.mp4");
//
// Marker = {
//   t, tEnd,                       seconds from the start of the video
//   kind: "tap" | "longpress" | "drag",
//   x, y,                          where the touch began, 0..1 from the top-left of the frame
//   path?: [[t, x, y], ...],       drags only, one point per analysed frame
//   bbox?: { x, y, w, h },         drags only, bounding box of the path (the circled area for loops)
//   closed?: boolean,              drags only, true when the path goes (nearly) all the way round
//   longPressStart?: boolean,      drags only, true when the finger was held still before moving
// }
//
// What it looks for (must match the overlays; see overlays/README.md):
//   - a solid disc of signal magenta #FF00DC, radius 24 pt, with a 4 pt white ring around it
//     (56 pt overall). Sizes are judged relative to the short side of the frame, which covers
//     phone screens 320..440 pt wide (the overlay is drawn in points, the frame is the screen).
//   - while long-pressed, a second magenta ring, radii 42..48 pt, around the disc.
//   - a fading 12 pt magenta trail behind a moving finger, used here only to tell one moving
//     touch from two separate taps.
//
// False positives are treated as worse than misses: a candidate must have the colour, be a
// round disc of the right size, be isolated (nothing magenta just outside it), carry the bright
// ring, and persist for several frames. Static look-alikes visible for more than
// `maxMarkerSeconds` are dropped as UI.
//
// Plain Node ESM, built-ins only, plus the ffmpeg / ffprobe binaries. Never throws: odd input
// (missing file, no video stream, zero-length, undecodable) yields { markers: [] }.

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";

const DEFAULTS = {
  ffmpegPath: "/opt/homebrew/bin/ffmpeg",
  ffprobePath: "/opt/homebrew/bin/ffprobe",
  fps: 15, // analysis rate; marks are designed to stay up >= 250 ms, i.e. >= 3 frames here
  shortSide: 270, // decode so the short side of the frame is this many pixels
  // Software decode is the default: on an M1 multithreaded libavcodec decodes an 886x1920 H.264
  // stream ~2.5x faster than VideoToolbox through this pipe. `true` tries VideoToolbox first.
  hwaccel: false,
  timeoutMs: 10 * 60 * 1000,
  maxMarkerSeconds: 30, // longer-lived "touches" are static UI, not fingers
  minFrames: 3,
  // Mark radius (magenta part) as a fraction of the frame's short side. 24 pt on a
  // 320..440 pt wide phone is 0.0545..0.075; the window allows for compression and blur.
  minRadius: 0.042,
  maxRadius: 0.088,
};

// ---- colour model ---------------------------------------------------------------------
// Signal magenta #FF00DC = (255, 0, 220). The classifier accepts a tight window around it that
// excludes pure magenta #FF00FF (B/R = 1.0), deep/hot pinks such as #FF1493 (B/R 0.58),
// iOS systemPink #FF2D55, and purples (R too low or B > R).
function isSignal(r, g, b) {
  if (g > 72 || r < 165 || b < 115) return false;
  if (r - g < 125 || b - g < 95) return false;
  const q = b * 100;
  return q >= r * 67 && q <= r * 95;
}

const luma = (r, g, b) => (54 * r + 183 * g + 19 * b) >> 8;

// ---- ffprobe ----------------------------------------------------------------------------
function run(cmd, args, { timeoutMs, signal } = {}) {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let done = false;
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve({ code: -1, out: "", err: String(e) });
      return;
    }
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, out, err });
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      finish(-1);
    }, timeoutMs ?? 30000);
    signal?.addEventListener?.("abort", () => { try { child.kill("SIGKILL"); } catch {} finish(-1); }, { once: true });
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => { err += String(e); finish(-1); });
    child.on("close", (code) => finish(code ?? -1));
  });
}

async function probe(videoPath, o) {
  const r = await run(o.ffprobePath, [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=codec_type,width,height,start_time:stream_side_data=rotation:stream_tags=rotate:format=start_time,duration",
    "-of", "json",
    videoPath,
  ], { timeoutMs: 30000, signal: o.signal });
  if (r.code !== 0) return null;
  let j;
  try { j = JSON.parse(r.out); } catch { return null; }
  const s = j?.streams?.[0];
  if (!s || s.codec_type !== "video") return null;
  let w = Number(s.width), h = Number(s.height);
  if (!(w > 0 && h > 0)) return null;
  let rot = 0;
  for (const sd of s.side_data_list ?? []) if (sd && sd.rotation != null) rot = Number(sd.rotation) || 0;
  if (!rot && s.tags?.rotate) rot = Number(s.tags.rotate) || 0;
  if (Math.abs(rot) % 180 === 90) [w, h] = [h, w];
  const vStart = Number(s.start_time);
  const fStart = Number(j?.format?.start_time);
  let offset = 0;
  if (Number.isFinite(vStart) && Number.isFinite(fStart)) offset = Math.max(0, vStart - fStart);
  return { w, h, offset, duration: Number(j?.format?.duration) || 0 };
}

// ---- frame analysis ---------------------------------------------------------------------
const NR = 32;
const COS = new Float64Array(NR), SIN = new Float64Array(NR);
for (let i = 0; i < NR; i++) { COS[i] = Math.cos((2 * Math.PI * i) / NR); SIN[i] = Math.sin((2 * Math.PI * i) / NR); }

class FrameAnalyser {
  constructor(W, H, o) {
    this.W = W; this.H = H;
    const S = Math.min(W, H);
    this.S = S;
    this.rMin = o.minRadius * S;
    this.rMax = o.maxRadius * S;
    this.mask = new Uint8Array(W * H);
    this.dt = new Uint16Array(W * H);
    this.minCount = Math.floor(Math.PI * this.rMin * this.rMin * 0.7);
  }

  // Returns detections [{x, y, r, lp}] in decoder pixels, and keeps mask for link tests.
  analyse(buf) {
    const { W, H, mask } = this;
    const n = W * H;
    let count = 0, y0 = H, y1 = -1, x0 = W, x1 = -1;
    for (let y = 0, i = 0, p = 0; y < H; y++) {
      let rowHit = false;
      for (let x = 0; x < W; x++, i++, p += 3) {
        const g = buf[p + 1];
        if (g > 72) { mask[i] = 0; continue; }
        if (isSignal(buf[p], g, buf[p + 2])) {
          mask[i] = 1; count++; rowHit = true;
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
        } else mask[i] = 0;
      }
      if (rowHit) { if (y < y0) y0 = y; y1 = y; }
    }
    this.count = count;
    if (count < this.minCount) return [];
    // work only inside the bounding box of signal pixels (+1 px of background around it)
    this.bx0 = Math.max(0, x0 - 1); this.bx1 = Math.min(W - 1, x1 + 1);
    this.by0 = Math.max(0, y0 - 1); this.by1 = Math.min(H - 1, y1 + 1);
    this.buf = buf;
    this.distance();
    const cands = this.candidates();
    const dets = [];
    for (const c of cands) {
      const d = this.verify(c.x, c.y);
      if (d) {
        // a second peak inside an accepted disc is the same disc
        if (dets.some((e) => Math.hypot(e.x - d.x, e.y - d.y) < e.r)) continue;
        dets.push(d);
      }
    }
    return dets;
  }

  // Chamfer 3-4 distance to the nearest non-signal pixel. Outside the frame counts as signal,
  // so a disc cut by the screen edge still has its centre found.
  distance() {
    const { W, H, mask, dt } = this;
    const INF = 60000;
    const { bx0, bx1, by0, by1 } = this;
    for (let y = by0; y <= by1; y++) {
      const row = y * W;
      for (let x = bx0; x <= bx1; x++) {
        const i = row + x;
        if (!mask[i]) { dt[i] = 0; continue; }
        let v = INF;
        if (x > 0) v = Math.min(v, dt[i - 1] + 3);
        if (y > 0) {
          v = Math.min(v, dt[i - W] + 3);
          if (x > 0) v = Math.min(v, dt[i - W - 1] + 4);
          if (x < W - 1) v = Math.min(v, dt[i - W + 1] + 4);
        }
        dt[i] = v;
      }
    }
    for (let y = by1; y >= by0; y--) {
      const row = y * W;
      for (let x = bx1; x >= bx0; x--) {
        const i = row + x;
        let v = dt[i];
        if (!v) continue;
        if (x < W - 1) v = Math.min(v, dt[i + 1] + 3);
        if (y < H - 1) {
          v = Math.min(v, dt[i + W] + 3);
          if (x < W - 1) v = Math.min(v, dt[i + W + 1] + 4);
          if (x > 0) v = Math.min(v, dt[i + W - 1] + 4);
        }
        dt[i] = v;
      }
    }
  }

  candidates() {
    const { W, H, dt } = this;
    const lo = Math.floor(3 * this.rMin * 0.6);
    const hiCand = Math.ceil(3 * this.rMax * 1.15);
    const peaks = [];
    const ya = Math.max(1, this.by0), yb = Math.min(H - 2, this.by1);
    const xa = Math.max(1, this.bx0), xb = Math.min(W - 2, this.bx1);
    for (let y = ya; y <= yb; y++) {
      for (let x = xa; x <= xb; x++) {
        const i = y * W + x;
        const v = dt[i];
        if (v < lo) continue;
        if (v < dt[i - 1] || v < dt[i + 1] || v < dt[i - W] || v < dt[i + W] ||
            v < dt[i - W - 1] || v < dt[i - W + 1] || v < dt[i + W - 1] || v < dt[i + W + 1]) continue;
        peaks.push(v, x, y);
      }
    }
    const list = [];
    for (let k = 0; k < peaks.length; k += 3) list.push({ v: peaks[k], x: peaks[k + 1], y: peaks[k + 2] });
    list.sort((a, b) => b.v - a.v);
    const accepted = [];
    for (const p of list) {
      const rad = Math.min(p.v, 3 * this.rMax * 2) / 3;
      let sup = false;
      for (const a of accepted) {
        const ra = a.v / 3;
        if (Math.hypot(a.x - p.x, a.y - p.y) < Math.max(ra, rad) * 1.5) { sup = true; break; }
      }
      if (sup) continue;
      accepted.push(p);
      if (accepted.length >= 16) break;
    }
    return accepted.filter((p) => p.v <= hiCand);
  }

  at(x, y) {
    const xi = Math.round(x), yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= this.W || yi >= this.H) return -1;
    return this.mask[yi * this.W + xi];
  }

  lumaAt(x, y) {
    const xi = Math.round(x), yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= this.W || yi >= this.H) return -1;
    const p = (yi * this.W + xi) * 3;
    return luma(this.buf[p], this.buf[p + 1], this.buf[p + 2]);
  }

  verify(cx, cy) {
    const { rMin, rMax } = this;
    const capR = rMax * 1.35;
    const edge = new Float64Array(NR);
    const state = new Int8Array(NR); // 0 ok, 1 capped (ran on: trail or big region), -1 off-frame
    for (let k = 0; k < NR; k++) {
      let r = 0;
      let st = 0;
      for (;;) {
        r += 0.5;
        if (r > capR) { st = 1; break; }
        const m = this.at(cx + COS[k] * r, cy + SIN[k] * r);
        if (m === -1) { st = -1; break; }
        if (m === 0) break;
      }
      edge[k] = r; state[k] = st;
    }
    let valid = 0, capped = 0;
    const radii = [];
    for (let k = 0; k < NR; k++) {
      if (state[k] === -1) continue;
      valid++;
      if (state[k] === 1) capped++; else radii.push(edge[k]);
    }
    const why = this.why;
    if (valid < NR * 0.5) { why?.push(["valid", cx, cy, valid]); return null; }
    // Rays that run on are the trail (a 12 pt line covers 2-3 of 32 rays) or a larger shape.
    if (capped > valid * 0.2) { why?.push(["capped", cx, cy, capped, valid]); return null; }
    radii.sort((a, b) => a - b);
    const rm = radii[radii.length >> 1];
    if (!(rm >= rMin && rm <= rMax)) { why?.push(["size", cx, cy, rm]); return null; }
    let round = 0;
    for (const r of radii) if (Math.abs(r - rm) <= Math.max(1, rm * 0.1)) round++;
    if (round < radii.length * 0.9) { why?.push(["round", cx, cy, round, radii.length]); return null; }

    // Isolation: nothing magenta in the band just outside the white ring, in any direction
    // (a trail crossing the band is allowed for).
    let gapN = 0, gapHit = 0;
    for (let k = 0; k < NR; k++) {
      if (state[k] === -1) continue;
      let off = false, hit = false;
      for (let r = rm * 1.32; r <= rm * 1.6; r += 1) {
        const m = this.at(cx + COS[k] * r, cy + SIN[k] * r);
        if (m === -1) { off = true; break; }
        if (m === 1) hit = true;
      }
      if (!off) { gapN++; if (hit) gapHit++; }
    }
    if (gapN < 8 || gapHit > gapN * 0.2) { why?.push(["isolation", cx, cy, gapHit, gapN]); return null; }

    // Bright ring: just outside the magenta edge the pixels are bright (the 4 pt white ring).
    let brN = 0, brHit = 0, lpN = 0, lpHit = 0;
    for (let k = 0; k < NR; k++) {
      if (state[k] !== 0) continue;
      const c = COS[k], s = SIN[k];
      let off = false, hit = false;
      let best = -1;
      off = false;
      for (let r = edge[k]; r <= edge[k] + rm * 0.25 + 1.5; r += 0.5) {
        const l = this.lumaAt(cx + c * r, cy + s * r);
        if (l === -1) { off = true; break; }
        if (l > best) best = l;
      }
      if (!off) { brN++; if (best >= 160) brHit++; }

      off = false; hit = false;
      for (let r = rm * 1.62; r <= rm * 2.2; r += 0.75) {
        const m = this.at(cx + c * r, cy + s * r);
        if (m === -1) { off = true; break; }
        if (m === 1) { hit = true; break; }
      }
      if (!off) { lpN++; if (hit) lpHit++; }
    }
    if (brN < 8 || brHit < brN * 0.6) { why?.push(["ring", cx, cy, brHit, brN]); return null; }
    why?.push(["ok", cx, cy, { capped, valid, round, n: radii.length, gapHit, gapN, brHit, brN, lpHit, lpN, rm: Math.round(rm * 10) / 10 }]);
    const lp = lpN >= 8 && lpHit >= lpN * 0.6;

    // Sub-pixel centre: centroid of signal pixels inside the disc.
    let sx = 0, sy = 0, sn = 0;
    const R = Math.ceil(rm);
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        if (dx * dx + dy * dy > rm * rm) continue;
        if (this.at(cx + dx, cy + dy) === 1) { sx += cx + dx; sy += cy + dy; sn++; }
      }
    }
    const x = sn ? sx / sn : cx, y = sn ? sy / sn : cy;

    // Interior colour statistics. The overlay disc is opaque, so its inside decodes to an almost
    // constant colour: B/R ~0.85 for #FF00DC drawn in sRGB and decoded with either BT.601 or
    // BT.709, ~0.83 after the iOS Simulator's colour management. The median separates it from
    // neighbouring UI colours the per-pixel gate lets through: #FF00BF decodes to 0.75 and
    // pure magenta #FF00FF to 1.0.
    const ri = rm * 0.75;
    const hist = new Uint32Array(128);
    let tot = 0, inMask = 0, gSum = 0, rSum = 0;
    const Ri = Math.ceil(ri);
    for (let dy = -Ri; dy <= Ri; dy++) {
      for (let dx = -Ri; dx <= Ri; dx++) {
        if (dx * dx + dy * dy > ri * ri) continue;
        const xi = Math.round(x + dx), yi = Math.round(y + dy);
        if (xi < 0 || yi < 0 || xi >= this.W || yi >= this.H) continue;
        const i = yi * this.W + xi, p = i * 3;
        const R = this.buf[p], G = this.buf[p + 1], B = this.buf[p + 2];
        tot++;
        if (this.mask[i]) inMask++;
        gSum += G; rSum += R;
        hist[Math.min(127, Math.floor((B / Math.max(1, R)) * 64))]++;
      }
    }
    if (!tot || inMask < tot * 0.95) { why?.push(["interior", cx, cy, inMask, tot]); return null; }
    let acc = 0, med = 0;
    for (let b = 0; b < 128; b++) { acc += hist[b]; if (acc * 2 >= tot) { med = (b + 0.5) / 64; break; } }
    if (med < 0.79 || med > 0.9 || gSum / tot > 40 || rSum / tot < 215) {
      why?.push(["hue", cx, cy, Math.round(med * 1000) / 1000, Math.round(gSum / tot), Math.round(rSum / tot)]);
      return null;
    }
    return { x, y, r: rm, lp };
  }

  // True when the straight segment between two disc centres is mostly covered by signal
  // pixels in the current frame, i.e. a fresh trail joins them.
  connected(a, b) {
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    const r0 = a.r * 1.1, r1 = d - b.r * 1.1;
    if (r1 - r0 < 2) return true; // discs overlap: continuous motion
    const ux = (b.x - a.x) / d, uy = (b.y - a.y) / d;
    let n = 0, hit = 0;
    for (let s = r0; s <= r1; s += 1) {
      n++;
      const px = a.x + ux * s, py = a.y + uy * s;
      let h = false;
      for (let o = -2; o <= 2 && !h; o++) if (this.at(px - uy * o, py + ux * o) === 1) h = true;
      if (h) hit++;
    }
    return hit >= n * 0.5;
  }
}

// ---- tracking ---------------------------------------------------------------------------
// Links per-frame disc detections into touches. A detection continues a track when it is
// (almost) in the same place, or when a fresh trail joins the two positions; otherwise it starts
// a new touch. One missed frame is tolerated.
class Tracker {
  constructor(W, H, o) {
    this.W = W; this.H = H; this.S = Math.min(W, H); this.o = o;
    this.active = [];
    this.done = [];
  }

  push(f, dets, an) {
    const pairs = [];
    for (let ti = 0; ti < this.active.length; ti++) {
      const tr = this.active[ti];
      const last = tr.pts[tr.pts.length - 1];
      for (let di = 0; di < dets.length; di++) {
        const d = dets[di];
        const dist = Math.hypot(d.x - last.x, d.y - last.y);
        let ok = dist <= Math.max(last.r, d.r) * 0.7;
        if (!ok && dist <= this.S * 0.8) ok = an.connected(last, d);
        if (ok) pairs.push([dist, ti, di]);
      }
    }
    pairs.sort((a, b) => a[0] - b[0]);
    const usedT = new Set(), usedD = new Set();
    for (const [, ti, di] of pairs) {
      if (usedT.has(ti) || usedD.has(di)) continue;
      usedT.add(ti); usedD.add(di);
      const d = dets[di];
      this.active[ti].pts.push({ f, x: d.x, y: d.y, r: d.r, lp: d.lp });
    }
    for (let di = 0; di < dets.length; di++) {
      if (usedD.has(di)) continue;
      const d = dets[di];
      this.active.push({ pts: [{ f, x: d.x, y: d.y, r: d.r, lp: d.lp }] });
    }
    // allow one missed frame, then close the track
    const keep = [];
    for (const tr of this.active) {
      if (f - tr.pts[tr.pts.length - 1].f > 1) this.done.push(tr); else keep.push(tr);
    }
    this.active = keep;
  }

  finish() {
    this.done.push(...this.active);
    this.active = [];
    return this.done;
  }
}

const r3 = (v) => Math.round(v * 1000) / 1000;
const r4 = (v) => Math.round(v * 10000) / 10000;

function toMarker(tr, W, H, o, offset) {
  const pts = tr.pts;
  if (pts.length < o.minFrames) return null;
  const S = Math.min(W, H);
  const time = (f) => offset + f / o.fps;
  const first = pts[0], last = pts[pts.length - 1];
  const dur = (last.f - first.f) / o.fps;
  if (dur > o.maxMarkerSeconds) return null;
  const nx = (p) => (p.x + 0.5) / W;
  const ny = (p) => (p.y + 0.5) / H;

  // First sighting is up to one analysis interval after touch-down; last sighting is during
  // the release fade, which keeps the disc classifiable for roughly 60 ms.
  const t = Math.max(0, time(first.f) - 0.5 / o.fps);
  const tEnd = Math.max(t, time(last.f) + 0.5 / o.fps - 0.06);

  let maxDisp = 0, moveIdx = -1;
  for (let i = 0; i < pts.length; i++) {
    const d = Math.hypot(pts[i].x - first.x, pts[i].y - first.y) / S;
    if (d > maxDisp) maxDisp = d;
    if (moveIdx < 0 && d > 0.045) moveIdx = i;
  }
  const lpCount = pts.filter((p) => p.lp).length;
  const m = { t: r3(t), tEnd: r3(tEnd), kind: "tap", x: r4(nx(first)), y: r4(ny(first)) };

  if (moveIdx >= 0) {
    m.kind = "drag";
    m.path = pts.map((p) => [r3(time(p.f)), r4(nx(p)), r4(ny(p))]);
    let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
    for (const [, x, y] of m.path) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    m.bbox = { x: r4(x0), y: r4(y0), w: r4(x1 - x0), h: r4(y1 - y0) };
    // closed loop: the path winds (nearly) once around its own centre
    let cxp = 0, cyp = 0;
    for (const p of pts) { cxp += p.x; cyp += p.y; }
    cxp /= pts.length; cyp /= pts.length;
    let wind = 0;
    let prev = Math.atan2(pts[0].y - cyp, pts[0].x - cxp);
    for (let i = 1; i < pts.length; i++) {
      const a = Math.atan2(pts[i].y - cyp, pts[i].x - cxp);
      let da = a - prev;
      while (da > Math.PI) da -= 2 * Math.PI;
      while (da < -Math.PI) da += 2 * Math.PI;
      wind += da; prev = a;
    }
    const minSide = Math.min((x1 - x0) * W, (y1 - y0) * H) / S;
    m.closed = Math.abs(wind) >= 2 * Math.PI * 0.8 && minSide >= 0.06;
    const lpBeforeMove = pts.slice(0, moveIdx).filter((p) => p.lp).length;
    if (lpBeforeMove >= 2) m.longPressStart = true;
  } else if (lpCount >= 2 || dur >= 0.65) {
    m.kind = "longpress";
  }
  return m;
}

// ---- decode loop ------------------------------------------------------------------------
function decode(videoPath, W, H, o, hw, onFrame) {
  return new Promise((resolve) => {
    const vf = `fps=${o.fps},scale=${W}:${H}:flags=area,format=rgb24`;
    const args = ["-hide_banner", "-loglevel", "error", "-nostdin"];
    if (hw) args.push("-hwaccel", "videotoolbox");
    // Deblocking only matters at full resolution; skipping it is ~10% faster and invisible
    // after the 1/3 downscale.
    else args.push("-skip_loop_filter", "all");
    args.push("-i", videoPath, "-map", "0:v:0", "-an", "-sn", "-dn", "-vf", vf,
      "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1");
    let child;
    try {
      child = spawn(o.ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolve({ frames: 0, code: -1 });
      return;
    }
    const size = W * H * 3;
    const frame = Buffer.allocUnsafe(size);
    let fill = 0, frames = 0, done = false, failed = false;
    let err = "";
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ frames, code, err, failed });
    };
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} finish(-1); }, o.timeoutMs);
    o.signal?.addEventListener?.("abort", () => { try { child.kill("SIGKILL"); } catch {} finish(-1); }, { once: true });
    child.stdout.on("data", (chunk) => {
      let off = 0;
      while (off < chunk.length) {
        const take = Math.min(size - fill, chunk.length - off);
        chunk.copy(frame, fill, off, off + take);
        fill += take; off += take;
        if (fill === size) {
          try { onFrame(frame, frames); } catch { failed = true; }
          frames++;
          fill = 0;
        }
      }
    });
    child.stderr.on("data", (d) => { if (err.length < 4000) err += d; });
    child.on("error", () => finish(-1));
    child.on("close", (code) => finish(code ?? -1));
  });
}

/**
 * Detect ScreenBrief touch marks in a screen recording.
 * @param {string} videoPath
 * @param {object} [opts] fps, shortSide, ffmpegPath, ffprobePath, hwaccel, timeoutMs, signal,
 *   maxMarkerSeconds, minRadius, maxRadius, debug
 * @returns {Promise<{markers: object[]}>}
 */
export async function detectTouches(videoPath, opts = {}) {
  try {
    const o = { ...DEFAULTS, ...(opts && typeof opts === "object" ? opts : {}) };
    if (!existsSync(o.ffmpegPath)) o.ffmpegPath = "ffmpeg";
    if (!existsSync(o.ffprobePath)) o.ffprobePath = "ffprobe";
    if (typeof videoPath !== "string" || !videoPath || !existsSync(videoPath)) return { markers: [] };
    const st = statSync(videoPath);
    if (!st.isFile() || st.size === 0) return { markers: [] };
    o.fps = Math.max(5, Math.min(60, Number(o.fps) || DEFAULTS.fps));

    const info = await probe(videoPath, o);
    if (!info) return { markers: [] };
    const short = Math.min(info.w, info.h);
    const k = Math.min(1, (Number(o.shortSide) || DEFAULTS.shortSide) / short);
    const W = Math.max(16, Math.round(info.w * k));
    const H = Math.max(16, Math.round(info.h * k));

    const runOnce = async (hw) => {
      const an = new FrameAnalyser(W, H, o);
      const tracker = new Tracker(W, H, o);
      const debug = [];
      const res = await decode(videoPath, W, H, o, hw, (buf, f) => {
        if (o.debug) an.why = [];
        const dets = an.analyse(buf);
        if (o.debug && (dets.length || an.count >= an.minCount)) {
          debug.push({ f, t: r3(info.offset + f / o.fps), count: an.count, why: an.why, dets: dets.map((d) => ({ x: r3(d.x), y: r3(d.y), r: r3(d.r), lp: d.lp })) });
        }
        tracker.push(f, dets, an);
      });
      return { res, tracks: tracker.finish(), debug };
    };

    let out = await runOnce(o.hwaccel === true);
    if (out.res.frames === 0 && o.hwaccel === true) out = await runOnce(false);
    if (out.res.frames === 0) return { markers: [] };

    const markers = [];
    for (const tr of out.tracks) {
      const m = toMarker(tr, W, H, o, info.offset);
      if (m) markers.push(m);
    }
    markers.sort((a, b) => a.t - b.t || a.x - b.x);
    const result = { markers };
    if (o.debug) result.debug = { W, H, frames: out.res.frames, fps: o.fps, offset: info.offset, perFrame: out.debug, ffmpegExit: out.res.code, ffmpegErr: out.res.err };
    return result;
  } catch {
    return { markers: [] };
  }
}

export default detectTouches;
