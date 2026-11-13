// screenbrief pull from the phone, against a stand-in for devicectl: a copy is used only when
// the app's sidecar says the movie is complete and the copy has the size the sidecar names.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pullRecording, PullError } from '../src/pull.mjs';
import { canStore } from '../src/doctor.mjs';

const STUB = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'devicectl-stub.mjs');
const ID = '20261112-175115';
let phone;

before(async () => {
  phone = await fsp.mkdtemp(path.join(os.tmpdir(), 'sb-phone-'));
  const movie = Buffer.alloc(4096, 7);
  fs.writeFileSync(path.join(phone, `${ID}.mov`), movie);
  fs.writeFileSync(path.join(phone, `${ID}.json`), JSON.stringify({ id: ID, sizeBytes: movie.length, durationSec: 38 }));
  process.env.SCREENBRIEF_DEVICECTL = STUB;
  process.env.DEVICECTL_STUB_PHONE = phone;
});

after(() => {
  delete process.env.SCREENBRIEF_DEVICECTL;
  delete process.env.DEVICECTL_STUB_PHONE;
  delete process.env.DEVICECTL_STUB_MODE;
});

async function pull(mode, id = ID) {
  process.env.DEVICECTL_STUB_MODE = mode;
  const destDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sb-phone-dest-'));
  return pullRecording(id, { destDir, sidecarRetries: 1, sidecarWaitMs: 10 });
}

test('phone: a complete copy is returned with the app’s details', async () => {
  const got = await pull('ok', 'latest');
  assert.equal(got.id, ID);
  assert.equal(fs.statSync(got.moviePath).size, 4096);
  assert.equal(got.meta.durationSec, 38);
  assert.equal(got.device.name, 'Test phone');
});

test('phone: a copy that arrived cut off is refused', async () => {
  await assert.rejects(pull('short-copy'), (e) => e instanceof PullError && /is incomplete \(2048 of 4096 bytes\)/.test(e.message));
});

test('phone: a movie whose details cannot be copied is refused', async () => {
  await assert.rejects(pull('sidecar-fails'), (e) => e instanceof PullError && /cannot be checked/.test(e.message));
});

test('phone: a movie whose details are not valid JSON is refused', async () => {
  await assert.rejects(pull('bad-sidecar'), (e) => e instanceof PullError && /cannot be checked/.test(e.message));
});

test('phone: a movie the app has not finished copying is refused', async () => {
  await assert.rejects(pull('no-sidecar'), (e) => e instanceof PullError && /has not finished saving recording/.test(e.message));
});

test('doctor: the bundles folder must be a writable folder, or creatable under one', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sb-store-'));
  assert.deepEqual(canStore(dir), { ok: true });
  assert.deepEqual(canStore(path.join(dir, 'not', 'made', 'yet')), { ok: true });
  const file = path.join(dir, 'a-file');
  fs.writeFileSync(file, 'x');
  assert.equal(canStore(file).ok, false);
  assert.match(canStore(path.join(file, 'recordings')).why, /is a file, not a folder/);
  const locked = path.join(dir, 'locked');
  fs.mkdirSync(locked, { mode: 0o555 });
  assert.match(canStore(path.join(locked, 'recordings')).why, /cannot be written to/);
});
