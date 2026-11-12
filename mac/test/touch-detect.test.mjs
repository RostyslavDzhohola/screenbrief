// Tests for mac/src/touch-detect.mjs.
//
//   /opt/homebrew/bin/node --test mac/test/touch-detect.test.mjs
//
// Synthesises phone-shaped screen recordings (886x1920 portrait, 30 fps, H.264 ~3 Mbps) of a
// busy, colourful fake app UI that scrolls and animates, and draws scripted touches on top with
// exactly the ScreenBrief overlay design (overlays/README.md). Then checks the detector finds
// each touch with the right kind, time and position, and reports nothing on control videos
// full of pinks, purples, magentas and look-alike circles.
//
// Set SCREENBRIEF_KEEP=/some/dir to keep the generated videos for inspection.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { detectTouches } = await import(join(here, "..", "src", "touch-detect.mjs"));

const FFMPEG = "/opt/homebrew/bin/ffmpeg";
const KEEP = process.env.SCREENBRIEF_KEEP;
const DIR = KEEP ? (mkdirSync(KEEP, { recursive: true }), KEEP) : mkdtempSync(join(tmpdir(), "screenbrief-touch-"));
if (!KEEP) process.on("exit", () => { try { rmSync(DIR, { recursive: true, force: true }); } catch {} });

// ---- the overlay design (must match overlays/README.md) ----------------------------------
const SPEC = {
  colour: [255, 0, 220], // #FF00DC
  white: [255, 255, 255],
  discR: 24, // magenta disc radius, pt
  ringOuterR: 28, // white ring 24..28 pt
  lpInnerR: 42, lpOuterR: 48, // long-press ring, magenta
  lpDelay: 0.5, lpSlop: 10, // s, pt
  trailDotR: 6, trailSpacing: 6, trailAlpha: 0.9, trailLife: 1.5,
  minHold: 0.25, fade: 0.25, fadeScale: 0.8,
};

// Phone: 393 x 852 pt screen recorded at 886 x 1920 px.
const VW = 886, VH = 1920, FPS = 30;
const PX = VW / 393; // px per pt
const SH = VH / PX; // screen height in pt (851.6)

// ---- tiny raster helpers ------------------------------------------------------------------
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
function hsv(h, s, v) {
  h = ((h % 360) + 360) % 360;
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

class Img {
  constructor(w, h) { this.w = w; this.h = h; this.d = Buffer.alloc(w * h * 3); }
  rect(x, y, w, h, c) {
    const x0 = Math.max(0, Math.round(x)), y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.w, Math.round(x + w)), y1 = Math.min(this.h, Math.round(y + h));
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { const p = (yy * this.w + xx) * 3; this.d[p] = c[0]; this.d[p + 1] = c[1]; this.d[p + 2] = c[2]; }
  }
  // anti-aliased disc/annulus with opacity
  ring(cx, cy, rOut, rIn, c, alpha = 1) {
    if (alpha <= 0 || rOut <= 0) return;
    const x0 = Math.max(0, Math.floor(cx - rOut - 1)), x1 = Math.min(this.w - 1, Math.ceil(cx + rOut + 1));
    const y0 = Math.max(0, Math.floor(cy - rOut - 1)), y1 = Math.min(this.h - 1, Math.ceil(cy + rOut + 1));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      let cov = Math.min(1, Math.max(0, rOut + 0.5 - d));
      if (rIn > 0) cov -= Math.min(1, Math.max(0, rIn + 0.5 - d));
      const a = cov * alpha;
      if (a <= 0) continue;
      const p = (y * this.w + x) * 3;
      this.d[p] += (c[0] - this.d[p]) * a; this.d[p + 1] += (c[1] - this.d[p + 1]) * a; this.d[p + 2] += (c[2] - this.d[p + 2]) * a;
    }
  }
  pill(x, y, w, h, c) { const r = h / 2; this.rect(x + r, y, w - h, h, c); this.ring(x + r, y + r, r, 0, c); this.ring(x + w - r, y + r, r, 0, c); }
}

// ---- fake app UI ----------------------------------------------------------------------------
const UI = ["#007AFF", "#34C759", "#FF9500", "#FF3B30", "#5856D6", "#5AC8FA", "#FFCC00", "#8E8E93", "#1C1C1E", "#F2F2F7"].map(hex);
const PINKS = ["#FF2D55", "#AF52DE", "#FF69B4", "#FF1493", "#EC4899", "#DB2777", "#D946EF", "#C026D3", "#E20074", "#C13584",
  "#FF00FF", "#E040FB", "#D500F9", "#F50057", "#FF4081", "#9C27B0", "#BA68C8", "#FF00BF", "#CC00CC", "#B4009E"].map(hex);

function buildContent(seed, height = 5200) {
  const R = rng(seed);
  const img = new Img(VW, height);
  img.rect(0, 0, VW, height, hex("#F2F2F7"));
  let y = 20;
  let k = 0;
  while (y < height - 100) {
    const h = Math.round((140 + R() * 300) * (PX / 2.25));
    const kind = k++ % 5;
    const bg = kind === 2 ? hex("#1C1C1E") : [255, 255, 255];
    img.rect(30, y, VW - 60, h, bg);
    if (kind === 0 || kind === 3) {
      // "photo": smooth multi-hue blobs + noise, includes saturated magenta regions
      const f1 = 0.004 + R() * 0.01, f2 = 0.004 + R() * 0.01, ph = R() * 6;
      for (let yy = y + 10; yy < y + h - 10; yy++) for (let xx = 40; xx < VW - 40; xx++) {
        const hue = 180 * (1 + Math.sin(xx * f1 + ph) * Math.cos(yy * f2 - ph)) + 40 * Math.sin((xx + yy) * 0.002);
        const v = 0.55 + 0.45 * Math.abs(Math.sin(xx * 0.003 + yy * 0.005));
        const c = hsv(hue, 0.95, v);
        const n = (R() - 0.5) * 30;
        const p = (yy * VW + xx) * 3;
        img.d[p] = Math.max(0, Math.min(255, c[0] + n)); img.d[p + 1] = Math.max(0, Math.min(255, c[1] + n)); img.d[p + 2] = Math.max(0, Math.min(255, c[2] + n));
      }
    } else {
      // list row: avatar circle (with a white ring, the same geometry as the mark) + text lines + chips
      const pal = R() < 0.6 ? PINKS : UI;
      for (let row = 0; row + 70 * PX / 2.25 < h; row += 80 * PX / 2.25) {
        const cy = y + row + 40 * PX / 2.25;
        const c = pal[Math.floor(R() * pal.length)];
        img.ring(110, cy, SPEC.ringOuterR * PX, SPEC.discR * PX, [255, 255, 255]);
        img.ring(110, cy, SPEC.discR * PX, 0, c);
        const tc = kind === 2 ? [230, 230, 235] : [40, 40, 45];
        img.rect(200, cy - 30, 300 + R() * 250, 18, tc);
        img.rect(200, cy + 5, 200 + R() * 300, 14, kind === 2 ? [150, 150, 160] : [120, 120, 128]);
        img.pill(VW - 260, cy - 24, 200, 48 * PX / 2.25, pal[Math.floor(R() * pal.length)]);
      }
    }
    y += h + 24;
  }
  return img;
}

function chrome() {
  const top = new Img(VW, 220);
  top.rect(0, 0, VW, 220, [250, 250, 252]);
  top.rect(40, 30, 120, 30, [20, 20, 20]); // clock
  top.rect(VW - 200, 34, 150, 24, [20, 20, 20]);
  top.rect(40, 120, 420, 60, [10, 10, 10]); // large title
  top.pill(VW - 230, 125, 190, 50, hex("#FF2D55"));
  const tab = new Img(VW, 190);
  tab.rect(0, 0, VW, 190, [248, 248, 248]);
  for (let i = 0; i < 4; i++) {
    const cx = 110 + i * 222;
    tab.ring(cx, 60, 34, 0, i === 1 ? hex("#FF00FF") : i === 2 ? hex("#AF52DE") : [150, 150, 155]);
    tab.rect(cx - 50, 110, 100, 16, [130, 130, 135]);
  }
  return { top, tab };
}

// ---- overlay model --------------------------------------------------------------------------
function tap(t, x, y, dur = 0.08) { return { down: t, up: t + dur, path: () => [x, y], expect: { kind: "tap", t, x, y } }; }
function press(t, x, y, dur = 1.2) { return { down: t, up: t + dur, path: (tt) => [x + Math.sin(tt * 20) * 1.5, y], expect: { kind: "longpress", t, x, y } }; }
function swipe(t, dur, [x0, y0], [x1, y1]) {
  const ease = (u) => u * u * (3 - 2 * u);
  return { down: t, up: t + dur, path: (tt) => { const u = ease(Math.min(1, Math.max(0, (tt - t) / dur))); return [x0 + (x1 - x0) * u, y0 + (y1 - y0) * u]; },
    expect: { kind: "drag", t, x: x0, y: y0, end: [x1, y1], closed: false } };
}
function loop(t, dur, cx, cy, rx, ry, sweep = 380) {
  const a0 = -Math.PI / 2;
  return { down: t, up: t + dur, path: (tt) => { const u = Math.min(1, Math.max(0, (tt - t) / dur)); const a = a0 + (sweep * Math.PI / 180) * u; return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)]; },
    expect: { kind: "drag", t, x: cx, y: cy - ry, closed: true, bbox: { x: cx - rx, y: cy - ry, w: 2 * rx, h: 2 * ry } } };
}

function prepareTouch(tc) {
  const ev = [];
  for (let te = tc.down; te <= tc.up + 1e-9; te += 1 / 120) ev.push([te, ...tc.path(te)]);
  const [sx, sy] = tc.path(tc.down);
  let moved = false;
  for (const [te, x, y] of ev) if (te <= tc.down + SPEC.lpDelay && Math.hypot(x - sx, y - sy) > SPEC.lpSlop) moved = true;
  tc.lpAt = !moved && tc.up > tc.down + SPEC.lpDelay ? tc.down + SPEC.lpDelay : Infinity;
  tc.rv = Math.max(tc.up, tc.down + SPEC.minHold);
  tc.dots = [];
  let lx = sx, ly = sy;
  for (const [te, x, y] of ev) {
    let d = Math.hypot(x - lx, y - ly);
    while (d >= SPEC.trailSpacing) {
      lx += ((x - lx) / d) * SPEC.trailSpacing; ly += ((y - ly) / d) * SPEC.trailSpacing;
      tc.dots.push([te, lx, ly]);
      d = Math.hypot(x - lx, y - ly);
    }
  }
  return tc;
}

function drawOverlay(img, touches, t) {
  for (const tc of touches) for (const [te, x, y] of tc.dots) {
    const age = t - te;
    if (age < 0 || age > SPEC.trailLife) continue;
    img.ring(x * PX, y * PX, SPEC.trailDotR * PX, 0, SPEC.colour, SPEC.trailAlpha * (1 - age / SPEC.trailLife));
  }
  for (const tc of touches) {
    if (t < tc.down || t >= tc.rv + SPEC.fade) continue;
    const u = t < tc.rv ? 0 : (t - tc.rv) / SPEC.fade;
    const alpha = 1 - u, sc = 1 - (1 - SPEC.fadeScale) * u;
    const [x, y] = tc.path(Math.min(t, tc.up));
    const cx = x * PX, cy = y * PX;
    if (t >= tc.lpAt) img.ring(cx, cy, SPEC.lpOuterR * PX * sc, SPEC.lpInnerR * PX * sc, SPEC.colour, alpha);
    img.ring(cx, cy, SPEC.ringOuterR * PX * sc, SPEC.discR * PX * sc, SPEC.white, alpha);
    img.ring(cx, cy, SPEC.discR * PX * sc, 0, SPEC.colour, alpha);
  }
}

// ---- video synthesis ------------------------------------------------------------------------
async function synth(file, { seconds, touches = [], scroll = () => 0, seed = 1, decoys = null, audio = false }) {
  touches.forEach(prepareTouch);
  const content = buildContent(seed);
  const { top, tab } = chrome();
  const args = ["-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${VW}x${VH}`, "-r", String(FPS), "-i", "pipe:0"];
  if (audio) args.push("-f", "lavfi", "-i", `sine=frequency=220:duration=${seconds}`);
  args.push("-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p", "-c:v", "libx264", "-preset", "veryfast",
    "-b:v", "3M", "-maxrate", "3.5M", "-bufsize", "6M", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv");
  if (audio) args.push("-c:a", "aac", "-shortest");
  args.push("-movflags", "+faststart", file);
  const ff = spawn(FFMPEG, args, { stdio: ["pipe", "ignore", "inherit"] });
  const closed = new Promise((res) => ff.on("close", res));
  const frame = new Img(VW, VH);
  const bodyTop = 220, bodyH = VH - 220 - 190;
  for (let i = 0; i < Math.round(seconds * FPS); i++) {
    const t = i / FPS;
    const off = Math.max(0, Math.min(content.h - bodyH, Math.round(scroll(t) * PX)));
    top.d.copy(frame.d, 0);
    content.d.copy(frame.d, bodyTop * VW * 3, off * VW * 3, (off + bodyH) * VW * 3);
    tab.d.copy(frame.d, (VH - 190) * VW * 3);
    // animated banner cycling through every hue, including the signal hue
    frame.rect(60, 250, 360, 130, hsv(t * 90, 1, 1));
    if (decoys) decoys(frame, t);
    drawOverlay(frame, touches, t);
    if (!ff.stdin.write(frame.d)) await new Promise((r) => ff.stdin.once("drain", r));
  }
  ff.stdin.end();
  const code = await closed;
  assert.equal(code, 0, "ffmpeg encode failed");
  return file;
}

function ffmpeg(args) {
  const r = spawnSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...args]);
  assert.equal(r.status, 0, String(r.stderr));
}

// ---- scripts --------------------------------------------------------------------------------
// One "session" with every gesture kind, in screen points (393 x 852).
function sessionTouches() {
  return [
    tap(1.0, 100, 330, 0.06), // very quick tap
    tap(2.0, 300, 640, 0.12),
    press(3.2, 200, 470, 1.2), // long press
    swipe(5.5, 0.8, [90, 720], [320, 260]), // swipe (content scrolls with it)
    loop(7.6, 1.6, 200, 450, 95, 120), // circling an area: closed loop
    tap(10.0, 90, 260, 0.06), tap(10.3, 300, 300, 0.06), // two taps 0.3 s apart
    tap(11.5, 100, 620, 0.15), tap(11.5, 290, 620, 0.15), // two fingers at once
    tap(12.6, 40, 520, 0.1), // near the left edge
  ];
}
const sessionScroll = (t) => (t < 5.5 ? 0 : t < 6.3 ? 460 * ((u) => u * u * (3 - 2 * u))((t - 5.5) / 0.8) : 460 + (t > 9.5 ? (t - 9.5) * 30 : 0));
const SESSION_SECONDS = 14;

function check(markers, touches, label) {
  const exp = touches.map((tc) => tc.expect);
  const lines = [];
  const used = new Set();
  for (const e of exp) {
    const ex = e.x / 393, ey = e.y / SH;
    const i = markers.findIndex((m, k) => !used.has(k) && Math.abs(m.t - e.t) <= 0.15 && Math.abs(m.x - ex) <= 0.03 && Math.abs(m.y - ey) <= 0.03);
    assert.ok(i >= 0, `${label}: no marker for ${e.kind} at t=${e.t} (${e.x},${e.y}pt). Got ${JSON.stringify(markers.map(({ path, ...m }) => m))}`);
    used.add(i);
    const m = markers[i];
    assert.equal(m.kind, e.kind, `${label}: kind at t=${e.t}`);
    if (e.end) {
      const [, lx, ly] = m.path.at(-1);
      assert.ok(Math.abs(lx - e.end[0] / 393) <= 0.03 && Math.abs(ly - e.end[1] / SH) <= 0.03, `${label}: drag end ${lx},${ly}`);
    }
    if (e.closed !== undefined) assert.equal(m.closed, e.closed, `${label}: closed at t=${e.t}`);
    if (e.bbox) {
      const b = m.bbox;
      for (const [k, v] of [["x", e.bbox.x / 393], ["y", e.bbox.y / SH], ["w", e.bbox.w / 393], ["h", e.bbox.h / SH]]) {
        assert.ok(Math.abs(b[k] - v) <= 0.03, `${label}: bbox.${k} ${b[k]} vs ${v.toFixed(3)}`);
      }
    }
    lines.push(`${e.kind.padEnd(9)} t=${m.t.toFixed(3)} (exp ${e.t.toFixed(2)}, dt ${(m.t - e.t >= 0 ? "+" : "") + (m.t - e.t).toFixed(3)})  ` +
      `x=${m.x.toFixed(3)} (exp ${ex.toFixed(3)})  y=${m.y.toFixed(3)} (exp ${ey.toFixed(3)})  tEnd=${m.tEnd.toFixed(2)}` +
      (m.kind === "drag" ? `  closed=${m.closed} pts=${m.path.length}` + (m.bbox ? ` bbox=${JSON.stringify(m.bbox)}` : "") : ""));
  }
  assert.equal(markers.length, exp.length, `${label}: extra markers ${JSON.stringify(markers.filter((_, k) => !used.has(k)))}`);
  console.log(`\n[${label}] ${markers.length} markers\n  ` + lines.join("\n  "));
}

// ---- tests ----------------------------------------------------------------------------------
const session = join(DIR, "session.mp4");
let sessionMarkers;

test("session: taps, long press, swipe, closed loop, close-in-time and two-finger touches", async () => {
  const touches = sessionTouches();
  await synth(session, { seconds: SESSION_SECONDS, touches, scroll: sessionScroll, seed: 7, audio: true });
  const t0 = performance.now();
  const { markers } = await detectTouches(session);
  console.log(`[session] detect ${(performance.now() - t0).toFixed(0)} ms for ${SESSION_SECONDS}s`);
  check(markers, touches, "session 886x1920 CFR");
  sessionMarkers = markers;
});

test("session re-encoded at 60% size with variable frame rate", async () => {
  const vfr = join(DIR, "session-vfr-60pct.mp4");
  // drop frames while nothing moves (like iOS does) and irregularly elsewhere, keep timestamps
  ffmpeg(["-i", session, "-vf", "select='not(between(t\\,0.2\\,0.8))*not(between(t\\,13.2\\,13.9))*not(eq(mod(n\\,3)\\,2)*between(t\\,6\\,9.6))*not(eq(mod(n\\,4)\\,1)*between(t\\,2.5\\,4.8))',scale=532:1152",
    "-fps_mode", "vfr", "-c:v", "libx264", "-preset", "veryfast", "-b:v", "3M", "-an", vfr]);
  const pr = spawnSync("/opt/homebrew/bin/ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=nb_read_frames,r_frame_rate,avg_frame_rate,width,height", "-of", "csv=p=0", vfr]);
  console.log(`[vfr] ffprobe width,height,r_frame_rate,avg_frame_rate,frames: ${String(pr.stdout).trim()}`);
  const { markers } = await detectTouches(vfr);
  check(markers, sessionTouches(), "session 532x1152 VFR");
});

test("control: colourful scrolling UI with pinks, purples and magentas, no overlay", async () => {
  const f = join(DIR, "control-ui.mp4");
  await synth(f, { seconds: 12, scroll: (t) => 900 * (0.5 - 0.5 * Math.cos(t * 0.8)) + t * 40, seed: 3 });
  const { markers } = await detectTouches(f);
  assert.deepEqual(markers, []);
});

test("control: look-alike decoys (exact hue without the white ring, wrong sizes, #FF00FF rings, #FF00BF chips)", async () => {
  const f = join(DIR, "control-decoys.mp4");
  const C = SPEC.colour;
  await synth(f, {
    seconds: 10, seed: 11, scroll: (t) => t * 60,
    decoys: (img, t) => {
      // exact signal colour disc on dark, no white ring, static then sliding
      img.rect(460, 420, 380, 300, [28, 28, 30]);
      img.ring(560, 560, 24 * PX, 0, C);
      img.ring(740 - (t % 2) * 120, 600, 24 * PX, 0, C);
      // exact colour + white ring but too small and too big
      img.ring(150, 1200, 14 * PX, 11 * PX, [255, 255, 255]); img.ring(150, 1200, 11 * PX, 0, C);
      img.ring(560, 1250, 60 * PX, 54 * PX, [255, 255, 255]); img.ring(560, 1250, 54 * PX, 0, C);
      // pure magenta and deep pink rings of exactly the mark geometry, appearing and moving
      if ((t * 3) % 2 < 1) { img.ring(200 + t * 40, 900, 28 * PX, 24 * PX, [255, 255, 255]); img.ring(200 + t * 40, 900, 24 * PX, 0, hex("#FF00FF")); }
      img.ring(700, 950 + t * 20, 28 * PX, 24 * PX, [255, 255, 255]); img.ring(700, 950 + t * 20, 24 * PX, 0, hex("#FF1493"));
      // signal-hue chips/pills (Lyft pink is inside the colour window: only shape rejects these)
      img.pill(80, 1500, 300, 48 * PX, hex("#FF00BF"));
      img.pill(450, 1520 - t * 10, 360, 40 * PX, C);
      img.rect(80, 1650, 108, 108, C); // a square of the right size
    },
  });
  const { markers } = await detectTouches(f);
  assert.deepEqual(markers, []);
});

test("odd input never throws and yields no markers", async () => {
  const empty = join(DIR, "empty.mp4"); writeFileSync(empty, "");
  const junk = join(DIR, "junk.mp4"); writeFileSync(junk, "this is not a video\n".repeat(100));
  const audioOnly = join(DIR, "audio.m4a");
  ffmpeg(["-f", "lavfi", "-i", "sine=duration=1", "-c:a", "aac", audioOnly]);
  const tiny = join(DIR, "tiny.mp4");
  ffmpeg(["-f", "lavfi", "-i", "color=c=black:s=64x64:d=0.1", "-c:v", "libx264", tiny]);
  const truncated = join(DIR, "truncated.mp4");
  const full = spawnSync("head", ["-c", "200000", session]).stdout; writeFileSync(truncated, full);
  for (const p of [empty, junk, audioOnly, tiny, join(DIR, "missing.mp4"), DIR, "", null, undefined, 42]) {
    const r = await detectTouches(p, { fps: "nonsense" });
    assert.deepEqual(r, { markers: [] }, `input ${p}`);
  }
  // A truncated recording is decoded as far as it goes: whatever is found must be real.
  const tr = await detectTouches(truncated);
  assert.ok(Array.isArray(tr.markers));
  for (const m of tr.markers) assert.ok(sessionMarkers.some((s) => s.kind === m.kind && Math.abs(s.t - m.t) < 0.1 && Math.abs(s.x - m.x) < 0.01), JSON.stringify(m));
  console.log(`[odd input] truncated file (first 200 kB): ${tr.markers.length} marker(s) recovered`);
  // binaries that exist but are not ffmpeg
  assert.deepEqual(await detectTouches(session, { ffmpegPath: "/usr/bin/false", ffprobePath: "/usr/bin/false" }), { markers: [] });
});

test("speed: 3-minute 886x1920 recording", async () => {
  assert.ok(sessionMarkers, "session test must run first");
  const loops = 13; // 13 x 14 s = 182 s
  const long = join(DIR, "long.mp4");
  ffmpeg(["-stream_loop", String(loops - 1), "-i", session, "-c", "copy", long]);
  const t0 = performance.now();
  const { markers } = await detectTouches(long);
  const ms = performance.now() - t0;
  console.log(`\n[speed] ${loops * SESSION_SECONDS}s of 886x1920 H.264 analysed in ${(ms / 1000).toFixed(2)} s ` +
    `(${((loops * SESSION_SECONDS) / (ms / 1000)).toFixed(1)}x realtime), ${markers.length} markers (expected ${loops * sessionMarkers.length})`);
  assert.equal(markers.length, loops * sessionMarkers.length);
  assert.ok(ms < 30000, `took ${ms} ms`);
});
