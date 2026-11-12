// End-to-end pipeline tests through the CLI (`screenbrief process` / `frames`), no server.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixtures, tempHome, testEnv, cli, patchColor, hexRgb } from './helpers.mjs';
import { SCENARIO, SCREENS } from './synth.mjs';

let fx;
let home;
let env;
before(async () => {
  fx = await fixtures();
  home = await tempHome('sb-pipe-');
  env = testEnv(home);
});

const lastLine = (s) => s.trim().split('\n').pop();
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

test('speech recording: transcript timing, one frame per screen, no invented text in the silence', async () => {
  const started = Date.now();
  const { stdout, stderr } = await cli(['process', fx.scenario, '--note', 'Focus on the list screen'], env);
  const seconds = (Date.now() - started) / 1000;
  const feedback = lastLine(stdout);
  console.log(`# processed ${SCENARIO.duration}s scenario in ${seconds.toFixed(1)}s\n# ${stderr.trim().split('\n').pop()}`);
  assert.ok(path.isAbsolute(feedback) && feedback.endsWith('FEEDBACK.md'), `last stdout line is the FEEDBACK.md path: ${feedback}`);
  const dir = path.dirname(feedback);
  assert.match(path.basename(dir), /^\d{8}-\d{6}-[0-9a-z]{8}$/);
  for (const f of ['recording.mp4', 'contact-sheet.jpg', 'transcript.json', 'timeline.json', 'meta.json', 'status.json']) {
    assert.ok(fs.existsSync(path.join(dir, f)), `${f} exists`);
  }
  assert.equal(readJson(path.join(dir, 'status.json')).state, 'ready');
  // No temp files left behind.
  assert.deepEqual(fs.readdirSync(dir).filter((f) => /\.(wav|raw|tmp\.mp4)$/.test(f)), []);

  // Transcript: each spoken phrase near its real offset.
  const tr = readJson(path.join(dir, 'transcript.json'));
  assert.equal(tr.audio.state, 'speech');
  for (const p of SCENARIO.phrases) {
    const hit = tr.phrases.find((q) => p.keywords.every((k) => q.text.toLowerCase().includes(k)));
    assert.ok(hit, `phrase with ${p.keywords.join('+')} transcribed; got ${JSON.stringify(tr.phrases.map((q) => q.text))}`);
    assert.ok(Math.abs(hit.start - p.t) <= 1.0, `"${hit.text}" starts at ${hit.start}, expected about ${p.t}`);
  }
  // Silence: nothing transcribed inside it.
  const [s0, s1] = SCENARIO.silence;
  const invented = tr.phrases.filter((q) => q.start > s0 + 0.3 && q.start < s1 - 0.3);
  assert.deepEqual(invented, [], 'no phrases inside the silent stretch');

  // Frames: at least one frame per screen, and it really shows that screen
  // (sample the background at 2% across, 78% down, where no screen draws a box).
  const tl = readJson(path.join(dir, 'timeline.json'));
  assert.ok(tl.frames.length >= SCENARIO.screenTimes.length && tl.frames.length <= 40);
  const times = [...SCENARIO.screenTimes, SCENARIO.duration];
  for (let i = 0; i < SCENARIO.screenTimes.length; i++) {
    const inScreen = tl.frames.filter((f) => f.t >= times[i] && f.t < times[i + 1]);
    assert.ok(inScreen.length >= 1, `a frame during screen ${i} (${times[i]}-${times[i + 1]}s)`);
    const rgb = await patchColor(inScreen[0].file, 0.022, 0.78);
    const want = hexRgb(SCREENS[i].bg);
    const dist = Math.max(...rgb.map((v, k) => Math.abs(v - want[k])));
    assert.ok(dist <= 24, `frame ${path.basename(inScreen[0].file)} shows screen ${i}: got rgb ${rgb}, want ${want}`);
    // Frame names carry their timestamp.
    assert.match(path.basename(inScreen[0].file), /^f\d{3}-\d{2}m\d{2}s\d\.jpg$/);
  }
  // A screen change during the silence produces its own "no speech" section.
  assert.ok(tl.sections.some((s) => s.kind === 'silence' && s.start < 21 && s.end > 21 && s.frames.length));

  // FEEDBACK.md: intro, note, every phrase, absolute frame paths that exist.
  const md = fs.readFileSync(feedback, 'utf8');
  assert.match(md, /^# Phone feedback recording/);
  assert.match(md, /screenbrief frames/);
  assert.match(md, /Note from the user: Focus on the list screen/);
  assert.match(md, /## Timeline/);
  assert.match(md, /## Full transcript/);
  const paths = [...md.matchAll(/`(\/[^`]+\.jpg)`/g)].map((m) => m[1]);
  assert.ok(paths.length >= SCENARIO.screenTimes.length);
  for (const p of paths) assert.ok(fs.existsSync(p), `${p} exists`);
  for (const p of tr.phrases) assert.ok(md.includes(p.text));

  // Image sizes: longer side at most 1568 px.
  const meta = readJson(path.join(dir, 'meta.json'));
  assert.equal(meta.frameCount, tl.frames.length);
  assert.ok(Math.max(meta.width, meta.height) <= 1920);

  // `frames` gets more frames on demand.
  const at = await cli(['frames', dir, '--at', '3', '--at', '22.5'], env);
  const atFiles = at.stdout.trim().split('\n');
  assert.equal(atFiles.length, 2);
  for (const f of atFiles) assert.ok(fs.existsSync(f) && f.includes('/frames/extra/'));
  const range = await cli(['frames', dir, '--from', '10', '--to', '11', '--fps', '2'], env);
  assert.equal(range.stdout.trim().split('\n').length, 3);
  const rgb = await patchColor(atFiles[1], 0.022, 0.78);
  const want = hexRgb(SCREENS[3].bg);
  assert.ok(Math.max(...rgb.map((v, k) => Math.abs(v - want[k]))) <= 24, 'extra frame at 22.5s shows screen 3');
});

test('no audio track: frames-only bundle that says so', async () => {
  const out = path.join(home, 'noaudio-bundle');
  const { stdout } = await cli(['process', fx.noaudio, '--out', out], env);
  assert.equal(lastLine(stdout), path.join(out, 'FEEDBACK.md'));
  const tr = readJson(path.join(out, 'transcript.json'));
  assert.equal(tr.audio.state, 'none');
  assert.deepEqual(tr.phrases, []);
  const md = fs.readFileSync(path.join(out, 'FEEDBACK.md'), 'utf8');
  assert.match(md, /no audio track, so this is a frames-only bundle/);
  const tl = readJson(path.join(out, 'timeline.json'));
  assert.ok(tl.frames.length >= 3, `one frame per screen (got ${tl.frames.length})`);
  assert.ok(tl.sections.length >= 3 && tl.sections.every((s) => s.kind === 'silence'));
});

test('all-silent audio track: no invented text, frames-only bundle', async () => {
  const out = path.join(home, 'silent-bundle');
  const { stdout } = await cli(['process', fx.silent, '--out', out], env);
  assert.equal(lastLine(stdout), path.join(out, 'FEEDBACK.md'));
  const tr = readJson(path.join(out, 'transcript.json'));
  assert.equal(tr.audio.state, 'silent');
  assert.deepEqual(tr.phrases, []);
  const md = fs.readFileSync(path.join(out, 'FEEDBACK.md'), 'utf8');
  assert.match(md, /audio track is silent/);
  assert.doesNotMatch(md, /Thank you|BLANK_AUDIO/i);
});

test('a missing input fails cleanly with a non-zero exit', async () => {
  const r = await cli(['process', path.join(home, 'nope.mov'), '--out', path.join(home, 'nope')], env, { allowFail: true });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /input not found/);
  assert.equal(readJson(path.join(home, 'nope', 'status.json')).state, 'failed');
});

const DETECTOR = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'touch-detect.mjs');

test('touch detector (src/touch-detect.mjs) markers reach FEEDBACK.md', { skip: !fs.existsSync(decodeURIComponent(DETECTOR)) && 'touch-detect.mjs not present' }, async () => {
  const out = path.join(home, 'tap-bundle');
  await cli(['process', fx.tap, '--out', out], env);
  const meta = readJson(path.join(out, 'meta.json'));
  assert.match(meta.touchDetector, /^ok \(1\)/);
  const md = fs.readFileSync(path.join(out, 'FEEDBACK.md'), 'utf8');
  assert.match(md, /00:0[23]\.\d tapped at 42% across, 71% down; frame `\/.+\.jpg`/);
  const tl = readJson(path.join(out, 'timeline.json'));
  assert.equal(tl.markers.length, 1);
  assert.equal(tl.markers[0].source, 'detected');
});

test('a touch detector that throws does not stop processing', async () => {
  const out = path.join(home, 'tap-bundle-throwing');
  const throwing = path.join(path.dirname(decodeURIComponent(new URL(import.meta.url).pathname)), 'fixtures', 'throwing-detector.mjs');
  const { stdout } = await cli(['process', fx.tap, '--out', out], { ...env, SCREENBRIEF_TOUCH_DETECT: throwing });
  assert.equal(lastLine(stdout), path.join(out, 'FEEDBACK.md'));
  assert.match(readJson(path.join(out, 'meta.json')).touchDetector, /^failed: detector exploded on purpose/);
  assert.equal(readJson(path.join(out, 'status.json')).state, 'ready');
  const missing = path.join(home, 'tap-bundle-missing');
  await cli(['process', fx.tap, '--out', missing], { ...env, SCREENBRIEF_TOUCH_DETECT: path.join(home, 'no-such-detector.mjs') });
  assert.match(readJson(path.join(missing, 'meta.json')).touchDetector, /^absent/);
});
