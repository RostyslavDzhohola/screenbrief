// A recording too large to attach as one file arrives as parts titled
// "ScreenBrief-<id>-part<k>of<n>". pull finds them, joins them in order, and the timeline of
// the joined movie matches the original's.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fixtures, tempHome, testEnv, cli } from './helpers.mjs';
import { SCENARIO } from './synth.mjs';
import { findAttached, joinParts, partOf, titleFor } from '../src/pull.mjs';

const FFMPEG = '/opt/homebrew/bin/ffmpeg';
const FFPROBE = '/opt/homebrew/bin/ffprobe';
const TOOLS = { ffmpeg: FFMPEG, ffprobe: FFPROBE };
const ID = '20261112-101500';
const quiet = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y'];

let dir;
let parts;

const duration = (file) => Number(execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim());

before(async () => {
  const fx = await fixtures();
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sb-parts-'));
  // The recording as the phone writes it: H.264 with sparse key frames, AAC.
  const whole = path.join(dir, 'whole.mov');
  execFileSync(FFMPEG, [...quiet, '-i', fx.scenario, '-c:v', 'libx264', '-preset', 'veryfast', '-r', '30', '-g', '60', '-c:a', 'aac', '-b:a', '64k', whole]);
  // Three parts, each starting on a key frame with its own timestamps from zero.
  const raw = path.join(dir, 'raw');
  fs.mkdirSync(raw);
  execFileSync(FFMPEG, [...quiet, '-i', whole, '-c', 'copy', '-f', 'segment', '-segment_time', '14', '-reset_timestamps', '1', '-segment_format', 'mov', path.join(raw, 'p%d.mov')]);
  const made = fs.readdirSync(raw).sort();
  assert.equal(made.length, 3, `expected three segments, got ${made.join(', ')}`);
  const att = path.join(dir, 'attachments');
  fs.mkdirSync(att);
  // Attached out of order, under names that say nothing (as T3 Code stores them).
  parts = [];
  const names = ['thread-zzz-mov.mov', 'thread-aaa-mov.mov', 'thread-mmm-mov.mov'];
  made.forEach((m, i) => {
    const out = path.join(att, names[i]);
    execFileSync(FFMPEG, [...quiet, '-i', path.join(raw, m), '-c', 'copy', '-metadata', `title=${titleFor(ID)}-part${i + 1}of3`, out]);
    parts.push(out);
  });
  const now = Date.now();
  fs.utimesSync(parts[0], new Date(now - 1000), new Date(now - 1000));
  fs.utimesSync(parts[1], new Date(now), new Date(now));
  fs.utimesSync(parts[2], new Date(now - 5000), new Date(now - 5000));
  // An unrelated attachment and a part of another recording.
  execFileSync(FFMPEG, [...quiet, '-f', 'lavfi', '-i', 'color=c=red:s=64x128:d=1', '-pix_fmt', 'yuv420p', '-metadata', `title=${titleFor('20261112-090000')}-part1of2`, path.join(att, 'thread-other-mov.mov')]);
});

test('parts: titles are parsed strictly', () => {
  assert.deepEqual(partOf(`ScreenBrief-${ID}-part2of3`, ID), { part: 2, total: 3 });
  assert.deepEqual(partOf(`screenbrief-${ID}-PART10of12 `, ID), { part: 10, total: 12 });
  assert.equal(partOf(`ScreenBrief-${ID}`, ID), null);
  assert.equal(partOf(`ScreenBrief-${ID}-part4of3`, ID), null);
  assert.equal(partOf(`ScreenBrief-${ID}-part0of3`, ID), null);
  assert.equal(partOf(`ScreenBrief-${ID}-part1of1`, ID), null);
  assert.equal(partOf(`ScreenBrief-20261112-090000-part1of2`, ID), null);
  assert.equal(partOf(`ScreenBrief-${ID}-2-part1of2`, ID), null);
});

test('parts: all parts are found in order, however they were attached', async () => {
  const found = await findAttached(ID, { attachmentsDir: path.join(dir, 'attachments'), tools: TOOLS });
  assert.deepEqual(found, { parts, total: 3 });
});

test('parts: joined without re-encoding, the movie is as long as the original', async () => {
  const joined = await joinParts(TOOLS, parts, path.join(dir, "joined it's.mov"));
  const want = duration(path.join(dir, 'whole.mov'));
  assert.ok(Math.abs(duration(joined) - want) < 0.5, `joined ${duration(joined)}s, original ${want}s`);
});

test('parts: pull joins them and the transcript keeps its timing', async () => {
  const home = await tempHome('sb-parts-home-');
  const env = testEnv(home, { SCREENBRIEF_T3_ATTACHMENTS: path.join(dir, 'attachments') });
  const r = await cli(['pull', ID, '--no-phone'], env);
  const feedback = r.stdout.trim().split('\n').pop();
  assert.ok(feedback.endsWith('FEEDBACK.md') && fs.existsSync(feedback), feedback);
  assert.match(r.stderr, /joining the 3 attached parts/);
  const bundle = path.dirname(feedback);
  const meta = JSON.parse(fs.readFileSync(path.join(bundle, 'meta.json'), 'utf8'));
  assert.ok(Math.abs(meta.durationSec - SCENARIO.duration) < 1, `duration ${meta.durationSec}`);
  const tr = JSON.parse(fs.readFileSync(path.join(bundle, 'transcript.json'), 'utf8'));
  for (const p of SCENARIO.phrases) {
    const hit = tr.phrases.find((q) => p.keywords.every((k) => q.text.toLowerCase().includes(k)));
    assert.ok(hit, `phrase "${p.text}" is in the transcript`);
    assert.ok(Math.abs(hit.start - p.t) < 1.5, `"${p.text}" at ${hit.start}s, spoken at ${p.t}s`);
  }
  // Nothing of the join is left in the staging folder.
  assert.deepEqual(fs.readdirSync(path.join(home, 'incoming')), []);
});

test('parts: a missing part is named, and pull tells the agent to wait', async () => {
  const hidden = `${parts[1]}.hidden`;
  fs.renameSync(parts[1], hidden);
  try {
    const found = await findAttached(ID, { attachmentsDir: path.join(dir, 'attachments'), tools: TOOLS });
    assert.deepEqual(found, { missing: [2], total: 3 });
    const home = await tempHome('sb-parts-home-');
    const env = testEnv(home, { SCREENBRIEF_T3_ATTACHMENTS: path.join(dir, 'attachments') });
    const r = await cli(['pull', ID, '--no-phone'], env, { allowFail: true });
    assert.equal(r.code, 2);
    assert.match(r.stderr, new RegExp(`2 of them are here; missing: ScreenBrief-${ID}-part2of3`));
    assert.match(r.stderr, /do not work from the transcript alone/);
    assert.match(r.stderr, /attach the missing part \(ScreenBrief-20261112-101500-part2of3\)/);
  } finally {
    fs.renameSync(hidden, parts[1]);
  }
});
