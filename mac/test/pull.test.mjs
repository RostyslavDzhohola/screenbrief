// screenbrief pull: choosing the device and the recording from devicectl's JSON.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickDevices, fileNames, chooseRecording } from '../src/pull.mjs';

const devices = {
  result: {
    devices: [
      { identifier: 'A', hardwareProperties: { deviceType: 'iPad', marketingName: 'iPad (9th generation)', udid: 'u-a' }, deviceProperties: { name: 'Tablet' }, connectionProperties: { tunnelState: 'connected' } },
      { identifier: 'B', hardwareProperties: { deviceType: 'iPhone', marketingName: 'iPhone 13 Pro Max', udid: 'u-b' }, deviceProperties: { name: 'My Phone' }, connectionProperties: { tunnelState: 'unavailable' } },
      { identifier: 'C', hardwareProperties: { deviceType: 'iPhone', marketingName: 'iPhone 15', udid: 'u-c' }, deviceProperties: { name: 'Other' }, connectionProperties: { tunnelState: 'disconnected' } },
      { identifier: 'M', hardwareProperties: { deviceType: 'Mac', marketingName: 'MacBook Air' }, deviceProperties: { name: 'Mac' }, connectionProperties: { tunnelState: 'connected' } },
    ],
  },
};

test('pull: reachable devices first, iPhones before iPads, Macs ignored, --device filters', () => {
  assert.deepEqual(pickDevices(devices).map((d) => d.identifier), ['C', 'A', 'B']);
  assert.equal(pickDevices(devices).find((d) => d.identifier === 'B').reachable, false);
  assert.deepEqual(pickDevices(devices, 'my phone').map((d) => d.identifier), ['B']);
  assert.deepEqual(pickDevices(devices, 'u-c').map((d) => d.identifier), ['C']);
  assert.deepEqual(pickDevices({}), []);
});

test('pull: only files directly in Documents/Recordings count; latest is the greatest id', () => {
  const listing = { result: { files: [
    { name: 'Documents', relativePath: 'Documents' },
    { name: 'Recordings', relativePath: 'Documents/Recordings' },
    { name: '20261111-224105.mp4', relativePath: 'Documents/Recordings/20261111-224105.mp4' },
    { name: '20261111-224105.json', relativePath: 'Documents/Recordings/20261111-224105.json' },
    { name: '20261112-090000.mov', relativePath: 'Documents/Recordings/20261112-090000.mov' },
    { name: 'thumb.jpg', relativePath: 'Documents/Recordings/thumb.jpg' },
    { name: 'x.mp4', relativePath: 'Documents/Recordings/cache/x.mp4' },
    { name: 'other.mp4', relativePath: 'Library/Caches/other.mp4' },
  ] } };
  const names = fileNames(listing);
  assert.deepEqual(names.sort(), ['20261111-224105.json', '20261111-224105.mp4', '20261112-090000.mov']);
  assert.equal(chooseRecording(names, 'latest'), '20261112-090000.mov');
  assert.equal(chooseRecording(names, '20261111-224105'), '20261111-224105.mp4');
  assert.equal(chooseRecording(names, '20261111'), null);
  assert.equal(chooseRecording([], 'latest'), null);
  assert.deepEqual(fileNames({}), []);
});

// ---- finding the video among T3 Code attachments ------------------------------------------------
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { idTime, findAttachedVideo } from '../src/pull.mjs';

const FFMPEG = '/opt/homebrew/bin/ffmpeg';
const TOOLS = { ffprobe: '/opt/homebrew/bin/ffprobe', ffmpeg: FFMPEG };

test('pull: an id is the local start time; other id shapes have none', () => {
  const t = idTime('20261111-225720');
  assert.deepEqual([t.getFullYear(), t.getMonth() + 1, t.getDate(), t.getHours(), t.getMinutes(), t.getSeconds()], [2026, 11, 11, 22, 57, 20]);
  assert.equal(idTime('latest'), null);
  assert.equal(idTime('abc-123'), null);
});

test('pull: the attached video is found by its recorded start time, others are ignored', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sb-att-'));
  const make = (name, when) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=64x128:d=1', '-pix_fmt', 'yuv420p'];
    if (when) args.push('-metadata', `creation_time=${when.toISOString()}`);
    execFileSync(FFMPEG, [...args, path.join(dir, name)]);
  };
  const id = '20261111-225720';
  const start = idTime(id);
  make('thread-aaa-mov.mov', new Date(start.getTime() + 1000)); // within tolerance
  make('thread-bbb-mov.mov', new Date(start.getTime() + 60_000)); // another recording
  make('thread-ccc-mp4.mp4', null); // no timestamp
  fs.writeFileSync(path.join(dir, 'thread-ddd-png.png'), 'not a movie');
  fs.writeFileSync(path.join(dir, 'thread-eee-mov.mov'), 'garbage');
  assert.equal(await findAttachedVideo(id, { attachmentsDir: dir, tools: TOOLS }), path.join(dir, 'thread-aaa-mov.mov'));
  assert.equal(await findAttachedVideo('20261111-000000', { attachmentsDir: dir, tools: TOOLS }), null);
  assert.equal(await findAttachedVideo('latest', { attachmentsDir: dir, tools: TOOLS }), null);
  assert.equal(await findAttachedVideo(id, { attachmentsDir: path.join(dir, 'missing'), tools: TOOLS }), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
