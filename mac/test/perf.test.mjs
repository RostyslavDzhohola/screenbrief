// Performance: a 3-minute, 60 fps HEVC phone recording must process in well under 3 minutes.
// Opt-in (slow to generate): SCREENBRIEF_PERF=1 node --test test/perf.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeRecording } from './synth.mjs';
import { tempHome, testEnv, cli } from './helpers.mjs';

const LINES = [
  'The onboarding title is cut off on this screen.',
  'Make the continue button full width.',
  'This spinner shows for too long, add a skeleton instead.',
  'The search field should be focused automatically.',
  'Results need to show the price next to each item.',
  'I cannot tell which tab is selected, make it bolder.',
  'The back gesture does not work here.',
  'Move the filter button to the top right corner.',
  'This empty state needs a friendlier message.',
  'The settings toggles are too close together.',
  'Use the system font size so it respects dynamic type.',
  'The profile picture looks stretched.',
  'Add a confirmation before deleting an item.',
  'The keyboard covers the send button.',
  'Dark mode makes this text unreadable.',
  'Overall the flow is good, just fix these details.',
];

test('3-minute recording processes in well under its length', { skip: process.env.SCREENBRIEF_PERF !== '1' }, async () => {
  const dir = path.join(os.tmpdir(), 'screenbrief-test-fixtures-v3');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'three-minutes-60fps.mov');
  if (!fs.existsSync(file)) {
    const screenTimes = Array.from({ length: 16 }, (_, i) => i * 11.25);
    const phrases = LINES.map((text, i) => ({ t: 1 + i * 11.1, text }));
    await makeRecording({ out: file + '.tmp.mov', duration: 180, screenTimes, phrases, codec: 'hevc', fps: 60 });
    fs.renameSync(file + '.tmp.mov', file);
  }
  const home = await tempHome('sb-perf-');
  const t0 = Date.now();
  const { stdout } = await cli(['process', file], testEnv(home));
  const secs = (Date.now() - t0) / 1000;
  const feedback = stdout.trim().split('\n').pop();
  const meta = JSON.parse(fs.readFileSync(path.join(path.dirname(feedback), 'meta.json'), 'utf8'));
  const tr = JSON.parse(fs.readFileSync(path.join(path.dirname(feedback), 'transcript.json'), 'utf8'));
  console.log(`# 180s recording processed in ${secs.toFixed(1)}s wall; stages ${JSON.stringify(meta.timings)}; model ${tr.model}; ${meta.frameCount} frames; ${tr.phrases.length} phrases; recording.mp4 ${(fs.statSync(path.join(path.dirname(feedback), 'recording.mp4')).size / 1048576).toFixed(1)} MB`);
  assert.ok(secs < 120, `took ${secs}s`);
  const found = LINES.filter((l) => tr.phrases.some((p) => p.text.toLowerCase().includes(l.toLowerCase().split(' ').slice(1, 4).join(' '))));
  assert.ok(found.length >= 14, `recognised ${found.length}/16 lines`);
  assert.ok(meta.frameCount >= 16 && meta.frameCount <= 40);
});
