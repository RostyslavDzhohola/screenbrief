// HTTP API end to end: a real `screenbrief serve` child process on a test port, a throwaway
// SCREENBRIEF_HOME, and the stub t3 binary (never the real one) for delivery.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixtures, tempHome, startServer, freePort, upload, truncatedUpload, waitFor, stubCalls, uuid, cli, testEnv } from './helpers.mjs';

let fx;
let home;
let port;
let srv;

before(async () => {
  fx = await fixtures();
  home = await tempHome('sb-srv-');
  port = await freePort();
  srv = await startServer(home, port);
});
after(async () => {
  if (srv) await srv.stop();
});

const ready = (id) =>
  waitFor(async () => {
    const r = await srv.api(`/api/recordings/${id}`);
    if (r.body.state === 'failed') throw new Error(`failed: ${r.body.error}`);
    return r.body.state === 'ready' && (!r.body.delivery || r.body.delivery.state !== 'pending') ? r.body : null;
  }, { timeoutMs: 300_000, intervalMs: 500, what: `recording ${id} ready` });

test('auth, health, web page, threads and projects', async () => {
  const noAuth = await fetch(`${srv.base}/api/health`);
  assert.equal(noAuth.status, 401);
  assert.deepEqual(await noAuth.json(), { error: 'unauthorized', message: 'Missing or wrong bearer token.' });
  const wrong = await fetch(`${srv.base}/api/recordings`, { headers: { Authorization: 'Bearer nope' } });
  assert.equal(wrong.status, 401);

  const h = await srv.api('/api/health');
  assert.equal(h.status, 200);
  assert.equal(h.body.ok, true);
  assert.equal(h.body.name, 'ScreenBrief');
  assert.equal(h.body.version, '1');
  assert.ok(h.body.host);

  const page = await fetch(`${srv.base}/?token=abc`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /ScreenBrief/);

  // Real T3 data, read-only.
  const th = await srv.api('/api/threads');
  assert.equal(th.status, 200);
  assert.ok(Array.isArray(th.body.threads) && th.body.threads.length <= 60);
  if (th.body.threads.length) {
    const t = th.body.threads[0];
    for (const k of ['threadId', 'title', 'projectId', 'projectName', 'projectPath', 'updatedAt']) assert.ok(k in t, `thread has ${k}`);
    const times = th.body.threads.map((x) => x.updatedAt);
    assert.deepEqual(times, [...times].sort().reverse(), 'newest first');
  }
  console.log(`# /api/threads: ${th.body.threads.length} threads${th.body.warning ? ' (' + th.body.warning + ')' : ''}`);
  const pr = await srv.api('/api/projects');
  assert.equal(pr.status, 200);
  assert.ok(pr.body.projects.every((p) => p.projectId && p.name && path.isAbsolute(p.path)));
  console.log(`# /api/projects: ${pr.body.projects.length} projects`);
});

test('upload with queued send, idempotent re-upload, truncated upload, previews, send to a new thread', async () => {
  const id = uuid();
  const meta = {
    id,
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    endedAt: new Date().toISOString(),
    durationSec: 40,
    device: { name: 'Test iPhone', model: 'iPhone 15 Pro', os: 'iOS 26.1' },
    source: 'broadcast',
    width: 886,
    height: 1920,
    hasMicAudio: true,
    note: 'Typed on the phone',
    markers: [{ t: 9.0, tEnd: 9.1, kind: 'tap', x: 0.42, y: 0.71 }, { t: 24, tEnd: 25.5, kind: 'drag', x: 0.5, y: 0.8, path: [[24, 0.5, 0.8], [25.5, 0.5, 0.3]] }],
    send: { threadId: 'stub-thread-1', note: 'Please fix these' },
  };
  const up = await upload(srv, fx.scenario, meta);
  assert.equal(up.status, 202);
  assert.deepEqual(up.body, { id, state: 'processing' });

  // Repeat upload of a known id: 200 with the existing record, no second job.
  const again = await upload(srv, fx.scenario, meta);
  assert.equal(again.status, 200);
  assert.equal(again.body.id, id);
  assert.ok(['processing', 'ready'].includes(again.body.state));

  // Truncated upload: discarded, never becomes a recording.
  const tid = uuid();
  const resp = await truncatedUpload(port, srv.token, fx.scenario, { id: tid }, 100_000);
  const gone = await srv.api(`/api/recordings/${tid}`);
  assert.equal(gone.status, 404, `truncated upload must not be kept (server said: ${resp.split('\r\n')[0] || 'connection closed'})`);
  await waitFor(() => fs.readdirSync(path.join(home, 'incoming')).length === 0, { timeoutMs: 5000, what: 'incoming/ empty' });

  // While processing, the API reports the stage.
  const during = await srv.api(`/api/recordings/${id}`);
  if (during.body.state === 'processing') assert.ok(['queued', 'transcoding', 'transcribing', 'frames', 'writing'].includes(during.body.stage), `stage ${during.body.stage}`);
  else assert.equal(during.body.stage, undefined);

  const rec = await ready(id);
  assert.equal(rec.id, id);
  assert.ok(rec.frameCount >= 6);
  assert.ok(Math.abs(rec.durationSec - 40) < 0.5);
  assert.match(rec.transcriptPreview, /login button/i);
  assert.ok(fs.existsSync(rec.feedbackPath));
  assert.equal(rec.delivery.state, 'sent');
  assert.equal(rec.delivery.threadId, 'stub-thread-1');
  assert.ok(rec.delivery.sentAt);

  // Exactly one recording, processed once; exactly one send to the stub.
  const list = await srv.api('/api/recordings');
  assert.equal(list.body.recordings.filter((r) => r.id === id).length, 1);
  assert.equal(list.body.recordings.length, 1);
  const sends = stubCalls(home).filter((c) => c.argv[1] === 'send');
  assert.equal(sends.length, 1);
  assert.deepEqual(sends[0].argv, ['thread', 'send', 'stub-thread-1', '-', '--json']);
  const msg = sends[0].stdin;
  assert.match(msg, /^Phone feedback recording: 40s, recorded /);
  assert.ok(msg.includes(rec.feedbackPath), 'message points at FEEDBACK.md');
  assert.match(msg, /My note: Typed on the phone \/ Please fix these/);
  assert.match(msg, /\[00:0[12]\] The login button is too small/);
  assert.ok(msg.length <= 6000);

  // Touch markers from meta land in FEEDBACK.md.
  const md = fs.readFileSync(rec.feedbackPath, 'utf8');
  assert.match(md, /00:09\.0 tapped at 42% across, 71% down; frame `\/.+\.jpg`/);
  assert.match(md, /dragged from 50% across, 80% down to 50% across, 30% down/);
  assert.match(md, /iPhone 15 Pro, iOS 26\.1/);

  // Previews.
  const sheet = await srv.api(`/api/recordings/${id}/contact-sheet.jpg`);
  assert.equal(sheet.status, 200);
  assert.equal(sheet.headers.get('content-type'), 'image/jpeg');
  assert.ok(sheet.body.length > 1000);
  const tl = JSON.parse(fs.readFileSync(path.join(rec.bundlePath, 'timeline.json'), 'utf8'));
  const frameName = path.basename(tl.frames[0].file);
  const frame = await srv.api(`/api/recordings/${id}/frames/${frameName}`);
  assert.equal(frame.status, 200);
  assert.equal(frame.body[0], 0xff);
  assert.equal((await srv.api(`/api/recordings/${id}/frames/..%2Fmeta.json`)).status, 400);

  // Send again, this time to a new thread in a project.
  const s2 = await srv.api(`/api/recordings/${id}/send`, { method: 'POST', json: { projectPath: '/Users/Rostyslav/Projects/phone agent context', note: 'second look' } });
  assert.equal(s2.status, 200);
  assert.equal(s2.body.delivery.state, 'sent');
  assert.equal(s2.body.delivery.threadId, 'stub-new-thread-0001');
  const start = stubCalls(home).find((c) => c.argv[1] === 'start');
  assert.deepEqual(start.argv.slice(0, 5), ['thread', 'start', '/Users/Rostyslav/Projects/phone agent context', '-', '--title']);
  assert.match(start.argv[5], /^Phone feedback \d{4}-\d{2}-\d{2} \d{2}:\d{2} \(40s\)$/);
  assert.equal(start.argv[6], '--json');

  // Bad requests.
  assert.equal((await srv.api(`/api/recordings/${id}/send`, { method: 'POST', json: {} })).body.error, 'missing_target');
  assert.equal((await srv.api('/api/recordings/nope')).status, 404);
  const badMeta = await fetch(`${srv.base}/api/recordings?id=${uuid()}`, { method: 'POST', headers: { Authorization: `Bearer ${srv.token}`, 'X-ScreenBrief-Meta': '%%%', 'Content-Length': '3' }, body: 'abc' });
  assert.equal(badMeta.status, 400);
  assert.equal((await badMeta.json()).error, 'bad_meta');
});

test('restart mid-queue: interrupted job resumes, queued send happens once', async () => {
  const a = uuid();
  const b = uuid();
  assert.equal((await upload(srv, fx.scenario, { id: a })).status, 202);
  assert.equal((await upload(srv, fx.noaudio, { id: b, send: { threadId: 'stub-thread-restart' } }, { contentType: 'video/mp4' })).status, 202);
  // Kill hard while the first job is mid-pipeline.
  await waitFor(async () => {
    const r = await srv.api(`/api/recordings/${a}`);
    return ['transcribing', 'frames'].includes(r.body.stage);
  }, { timeoutMs: 60_000, intervalMs: 100, what: 'job A mid-pipeline' });
  const viewB = await srv.api(`/api/recordings/${b}`);
  assert.equal(viewB.body.state, 'processing');
  assert.equal(viewB.body.stage, 'queued');
  assert.equal(viewB.body.delivery.state, 'pending');
  await srv.stop('SIGKILL');

  srv = await startServer(home, port);
  const ra = await ready(a);
  const rb = await ready(b);
  assert.equal(ra.state, 'ready');
  assert.equal(rb.state, 'ready');
  assert.match(fs.readFileSync(rb.feedbackPath, 'utf8'), /no audio track/);
  assert.equal(rb.delivery.state, 'sent');
  const record = JSON.parse(fs.readFileSync(path.join(ra.bundlePath, 'record.json'), 'utf8'));
  assert.ok(record.resumedAt, 'job A was resumed after the restart');
  const sendsB = stubCalls(home).filter((c) => c.argv[2] === 'stub-thread-restart');
  assert.equal(sendsB.length, 1, 'queued send delivered exactly once');
  assert.match(sendsB[0].stdin, /no audio track/);
  // Originals are removed once processed.
  assert.ok(!fs.existsSync(path.join(ra.bundlePath, 'original.mov')));
});

test('CLI send: stub failure is reported and recorded, success updates the record', async () => {
  const list = await srv.api('/api/recordings');
  const rec = list.body.recordings.find((r) => r.state === 'ready');
  const fail = await cli(['send', rec.id, '--thread', 'stub-thread-cli'], testEnv(home, { T3_STUB_FAIL: '1' }), { allowFail: true });
  assert.notEqual(fail.code, 0);
  assert.match(fail.stderr, /delivery failed/);
  const ok = await cli(['send', rec.bundlePath, '--thread', 'stub-thread-cli', '--note', 'from the CLI'], testEnv(home));
  assert.match(ok.stdout, /sent to thread stub-thread-cli/);
  const msgFile = ok.stdout.trim().split('\n').pop();
  assert.match(fs.readFileSync(msgFile, 'utf8'), /My note: .*from the CLI/);
  const after = await srv.api(`/api/recordings/${rec.id}`);
  assert.equal(after.body.delivery.state, 'sent');
});

test('Bonjour advertisement runs as a dns-sd child', async () => {
  const h2 = await tempHome('sb-bonjour-');
  const p2 = await freePort();
  const s2 = await startServer(h2, p2, { SCREENBRIEF_NO_BONJOUR: '0' });
  try {
    const { execFileSync } = await import('node:child_process');
    const found = await waitFor(() => {
      try {
        return execFileSync('/usr/bin/pgrep', ['-f', `dns-sd -R ScreenBrief _screenbrief._tcp local ${p2}`], { encoding: 'utf8' }).trim();
      } catch {
        return null;
      }
    }, { timeoutMs: 10_000, what: 'dns-sd child' });
    assert.ok(found);
  } finally {
    await s2.stop();
  }
});
