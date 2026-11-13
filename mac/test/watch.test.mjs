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

import { FFMPEG } from './tools.mjs';
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

test('watch: a pull by hand from another thread leaves the waiting thread to be told', async () => {
  const { home, attachments, env } = await setup();
  await cli(['pull', ID], env, { allowFail: true });
  attach(attachments, ID);
  await cli(['pull', ID], { ...env, T3CODE_THREAD_ID: 'thread-other' });
  assert.equal(waiter(home).threadId, 'thread-123');
  const pass = await cli(['watch'], env);
  assert.match(pass.stdout, /processed and thread thread-123 told/);
  assert.deepEqual(stubCalls(home).map((c) => c.argv[2]), ['thread-123']);
});

test('watch: a pull by hand that fails while processing keeps the request', async () => {
  const { home, attachments, env } = await setup();
  await cli(['pull', ID], env, { allowFail: true });
  attach(attachments, ID);
  // The bundle cannot be written: a file sits where its folder goes.
  fs.writeFileSync(path.join(home, 'recordings', `phone-${ID}`), 'in the way');
  const r = await cli(['pull', ID], env, { allowFail: true });
  assert.notEqual(r.code, 0);
  assert.ok(waiter(home));
});

// ---- races, with the watcher's functions called directly -----------------------------------------
import { rememberWaiter, settleWaiter, watchOnce, withWatchLock, waitingDir } from '../src/watch.mjs';
import { spawn } from 'node:child_process';

async function inHome(fn) {
  const before = process.env.SCREENBRIEF_HOME;
  process.env.SCREENBRIEF_HOME = await tempHome('sb-watch-race-');
  try {
    return await fn(process.env.SCREENBRIEF_HOME);
  } finally {
    if (before === undefined) delete process.env.SCREENBRIEF_HOME;
    else process.env.SCREENBRIEF_HOME = before;
  }
}

test('watch: a thread that asks while the pull runs is the one told, and nothing of it is lost', async () => {
  await inHome(async (home) => {
    rememberWaiter(ID, { threadId: 'thread-a' });
    const told = [];
    const res = await watchOnce({
      pull: async () => {
        rememberWaiter(ID, { threadId: 'thread-b' });
        return { ok: true, feedbackPath: '/x/FEEDBACK.md' };
      },
      notify: async (w) => told.push(w.threadId),
    });
    assert.deepEqual(told, ['thread-b']);
    assert.equal(res[0].state, 'delivered');
    assert.equal(fs.existsSync(path.join(home, 'waiting', `${ID}.json`)), false);
  });
});

test('watch: a thread that asks while the message is being sent keeps its request', async () => {
  await inHome(async (home) => {
    rememberWaiter(ID, { threadId: 'thread-a' });
    const told = [];
    await watchOnce({
      pull: async () => ({ ok: true, feedbackPath: '/x/FEEDBACK.md' }),
      notify: async (w) => {
        told.push(w.threadId);
        rememberWaiter(ID, { threadId: 'thread-b' });
      },
    });
    assert.deepEqual(told, ['thread-a']);
    assert.equal(waiter(home).threadId, 'thread-b');
    // The next pass tells the newer thread.
    await watchOnce({ pull: async () => ({ ok: true, feedbackPath: '/x/FEEDBACK.md' }), notify: async (w) => told.push(w.threadId) });
    assert.deepEqual(told, ['thread-a', 'thread-b']);
    assert.equal(fs.existsSync(path.join(home, 'waiting', `${ID}.json`)), false);
  });
});

test('watch: a request settled by hand while the pull runs is not announced', async () => {
  await inHome(async () => {
    rememberWaiter(ID, { threadId: 'thread-a' });
    const told = [];
    const res = await watchOnce({
      pull: async () => {
        assert.equal(settleWaiter(ID, { threadId: 'thread-other' }), false);
        assert.equal(settleWaiter(ID, { threadId: 'thread-a' }), true);
        return { ok: true, feedbackPath: '/x/FEEDBACK.md' };
      },
      notify: async (w) => told.push(w.threadId),
    });
    assert.deepEqual(told, []);
    assert.equal(res[0].state, 'settled');
  });
});

test('watch: one pass at a time; a dead pass is taken over; only the owner releases the lock', async () => {
  await inHome(async () => {
    const lock = path.join(waitingDir(), '.lock');
    const outer = await withWatchLock(async () => {
      assert.equal(await withWatchLock(async () => 'second'), null);
      return 'first';
    });
    assert.equal(outer, 'first');
    assert.equal(fs.existsSync(lock), false);
    // Left by a process that no longer exists.
    fs.writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 12345, at: Date.now(), token: 'gone' }));
    assert.equal(await withWatchLock(async () => 'took over'), 'took over');
    // Another pass owns the lock by the time this one ends: it is left alone.
    await withWatchLock(async () => fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now(), token: 'someone else' })));
    assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).token, 'someone else');
  });
});

test('watch: of several passes started together, exactly one runs', async () => {
  await inHome(async (home) => {
    const log = path.join(home, 'lock.log');
    fs.writeFileSync(log, '');
    const holder = path.join(MAC_DIR, 'test', 'fixtures', 'lock-holder.mjs');
    const kids = Array.from({ length: 6 }, () => spawn(process.execPath, [holder], { env: { ...process.env, LOCK_LOG: log }, stdio: 'ignore' }));
    await Promise.all(kids.map((k) => new Promise((r) => k.on('exit', r))));
    assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 1, fs.readFileSync(log, 'utf8'));
    assert.equal(fs.existsSync(path.join(home, 'waiting', '.lock')), false);
  });
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
