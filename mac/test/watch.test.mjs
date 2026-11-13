// "Fetch it later": a pull that cannot get the video is remembered, and `screenbrief watch`
// finishes it when the video becomes available, then tells the thread that asked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tempHome, testEnv, cli, MAC_DIR } from './helpers.mjs';
import { titleFor } from '../src/pull.mjs';

const FFMPEG = '/opt/homebrew/bin/ffmpeg';
const STUB = path.join(MAC_DIR, 'test', 'fixtures', 't3-stub.mjs');
const ID = '20261112-175115';

/** A fresh home, an empty attachments folder, and an environment that never reaches for a phone. */
async function setup(extra = {}) {
  const home = await tempHome('sb-watch-');
  const attachments = path.join(home, 'attachments');
  fs.mkdirSync(attachments);
  const env = testEnv(home, {
    SCREENBRIEF_T3_ATTACHMENTS: attachments,
    SCREENBRIEF_NO_PHONE: '1',
    SCREENBRIEF_WATCH_PLIST: path.join(home, 'not-installed.plist'),
    SCREENBRIEF_T3_BIN: STUB,
    T3_STUB_LOG: path.join(home, 't3.log'),
    T3CODE_THREAD_ID: 'thread-123',
    ...extra,
  });
  delete env.SCREENBRIEF_WATCHER;
  return { home, attachments, env };
}

const stubCalls = (home) => (fs.existsSync(path.join(home, 't3.log')) ? fs.readFileSync(path.join(home, 't3.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
const waiter = (home, id = ID) => JSON.parse(fs.readFileSync(path.join(home, 'waiting', `${id}.json`), 'utf8'));

function attach(dir, id) {
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=64x128:d=2', '-pix_fmt', 'yuv420p', '-metadata', `title=${titleFor(id)}`, path.join(dir, 'thread-x-mov.mov')]);
}

test('watch: a pull that cannot get the video is remembered with the thread that asked', async () => {
  const { home, env } = await setup();
  const r = await cli(['pull', ID], env, { allowFail: true });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /Fetching it automatically later is off on this Mac/);
  assert.match(r.stderr, /screenbrief watch --install/);
  const w = waiter(home);
  assert.equal(w.id, ID);
  assert.equal(w.threadId, 'thread-123');
  const status = await cli(['watch', '--status'], env);
  assert.match(status.stdout, /background check: off/);
  assert.match(status.stdout, new RegExp(`waiting: ${ID} .*thread thread-123`));
});

test('watch: with the background check on, the agent is told the video will follow', async () => {
  const { home, env } = await setup();
  fs.writeFileSync(env.SCREENBRIEF_WATCH_PLIST, '<plist/>');
  const r = await cli(['pull', ID], env, { allowFail: true });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /This request is remembered/);
  assert.match(r.stderr, /this thread gets a message with the FEEDBACK.md path/);
  assert.doesNotMatch(r.stderr, /is off on this Mac/);
  assert.ok(waiter(home));
});

test('watch: nothing waiting means nothing happens', async () => {
  const { home, env } = await setup();
  const r = await cli(['watch'], env);
  assert.equal(r.stdout.trim(), '');
  assert.deepEqual(stubCalls(home), []);
});

test('watch: when the video turns up it is processed and the thread is told once', async () => {
  const { home, attachments, env } = await setup();
  await cli(['pull', ID], env, { allowFail: true });
  // Still nothing: the request keeps waiting and the thread hears nothing.
  await cli(['watch'], env);
  assert.ok(waiter(home));
  assert.deepEqual(stubCalls(home), []);
  // The video arrives (here as an attachment; on the real Mac usually the phone coming home).
  attach(attachments, ID);
  const pass = await cli(['watch'], env);
  assert.match(pass.stdout, new RegExp(`${ID}: processed and thread thread-123 told`));
  const calls = stubCalls(home);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].argv, ['thread', 'send', 'thread-123', '-']);
  const feedback = path.join(home, 'recordings', `phone-${ID}`, 'FEEDBACK.md');
  assert.ok(fs.existsSync(feedback));
  assert.ok(calls[0].input.includes(feedback), calls[0].input);
  assert.match(calls[0].input, new RegExp(`recording ${ID} is on the Mac now`));
  assert.equal(fs.existsSync(path.join(home, 'waiting', `${ID}.json`)), false);
  // A later pass has nothing to do.
  await cli(['watch'], env);
  assert.equal(stubCalls(home).length, 1);
});

test('watch: if the thread cannot be told, the request stays and is tried again', async () => {
  const { home, attachments, env } = await setup({ T3_STUB_FAIL: '1' });
  await cli(['pull', ID], env, { allowFail: true });
  attach(attachments, ID);
  const pass = await cli(['watch'], env);
  assert.match(pass.stdout, /processed, but telling thread thread-123 failed/);
  assert.ok(waiter(home));
  const again = await cli(['watch'], { ...env, T3_STUB_FAIL: '0' });
  assert.match(again.stdout, /processed and thread thread-123 told/);
  assert.equal(fs.existsSync(path.join(home, 'waiting', `${ID}.json`)), false);
});

test('watch: a pull that succeeds by hand clears the request, and old requests expire', async () => {
  const { home, attachments, env } = await setup();
  await cli(['pull', ID], env, { allowFail: true });
  attach(attachments, ID);
  await cli(['pull', ID], env);
  assert.equal(fs.existsSync(path.join(home, 'waiting', `${ID}.json`)), false);
  // Fifteen days old: dropped without being tried.
  const old = '20261001-101010';
  fs.writeFileSync(path.join(home, 'waiting', `${old}.json`), JSON.stringify({ id: old, threadId: 't', requestedAt: new Date(Date.now() - 15 * 86_400_000).toISOString() }));
  const status = await cli(['watch', '--status'], env);
  assert.match(status.stdout, /waiting: nothing/);
  assert.equal(fs.existsSync(path.join(home, 'waiting', `${old}.json`)), false);
});

test('watch: the launchd job runs `screenbrief watch` every two minutes and is valid', async () => {
  const { watchPlistXml } = await import('../src/watch.mjs');
  const body = watchPlistXml();
  assert.match(body, /<key>StartInterval<\/key>\s*<integer>120<\/integer>/);
  assert.match(body, /<string>watch<\/string>/);
  const file = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'sb-plist-')), 'x.plist');
  fs.writeFileSync(file, body);
  execFileSync('/usr/bin/plutil', ['-lint', file]);
});
