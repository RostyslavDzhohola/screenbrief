// Live segment ingest end to end: fragmented-MP4 segments made by ffmpeg's HLS muxer (one
// init segment, then moof+mdat media segments, non-zero timestamps, audio starting after the
// picture or no audio at all), uploaded to a real `screenbrief serve` child on a test port
// with a throwaway SCREENBRIEF_HOME and the stub t3 binary.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fixtures, liveFixtures, LIVE_PHRASES, EARLY_PHRASES, tempHome, startServer, freePort, waitFor, stubCalls, uuid, cli, testEnv, patchColor, hexRgb } from './helpers.mjs';
import { fmp4Segments, SCREENS } from './synth.mjs';
import { run } from '../src/util.mjs';

const FFPROBE = '/opt/homebrew/bin/ffprobe';
let lf;
let home;
let port;
let srv;
const segs = {};

before(async () => {
  await fixtures();
  lf = await liveFixtures();
  for (const k of ['av', 'vonly', 'land']) segs[k] = await fmp4Segments(lf[k]);
  home = await tempHome('sb-live-');
  port = await freePort();
  srv = await startServer(home, port);
});
after(async () => {
  if (srv) await srv.stop();
});

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

async function put(s, id, seq, buf) {
  const r = await fetch(`${s.base}/api/live/${id}/segments/${seq}`, { method: 'PUT', headers: { Authorization: `Bearer ${s.token}`, 'Content-Type': 'video/mp4' }, body: buf });
  return { status: r.status, body: await r.json() };
}
const finish = (s, id, json) => s.api(`/api/live/${id}/finish`, { method: 'POST', json });

const ready = (s, id) =>
  waitFor(async () => {
    const r = await s.api(`/api/recordings/${id}`);
    if (r.body.state === 'failed') throw new Error(`failed: ${r.body.error}`);
    return r.body.state === 'ready' && (!r.body.delivery || r.body.delivery.state !== 'pending') ? r.body : null;
  }, { timeoutMs: 300_000, intervalMs: 500, what: `recording ${id} ready` });

async function probeStreams(file) {
  const { stdout } = await run(FFPROBE, ['-v', 'error', '-show_entries', 'stream=codec_type,start_time,width,height:stream_side_data=rotation:format=start_time,duration', '-of', 'json', file]);
  return JSON.parse(stdout);
}

/** Process a source file with the CLI, as an upload of the finished file would be. */
async function processOriginal(file, name) {
  const out = path.join(home, name);
  await cli(['process', file, '--out', out], testEnv(home));
  return out;
}

/** The parts of a bundle that must not depend on how the video arrived. */
function bundleSummary(dir) {
  const tr = readJson(path.join(dir, 'transcript.json'));
  const tl = readJson(path.join(dir, 'timeline.json'));
  const meta = readJson(path.join(dir, 'meta.json'));
  return {
    durationSec: meta.durationSec,
    width: meta.width,
    height: meta.height,
    audio: tr.audio.state,
    phrases: tr.phrases,
    frames: tl.frames.map((f) => ({ t: f.t, label: f.label })),
    sections: tl.sections.map((s) => ({ kind: s.kind, start: s.start, end: s.end, frames: s.frames.length })),
  };
}

function assertSameBundle(a, b) {
  assert.ok(Math.abs(a.durationSec - b.durationSec) <= 0.1, `duration ${a.durationSec} vs ${b.durationSec}`);
  assert.equal(a.width, b.width);
  assert.equal(a.height, b.height);
  assert.equal(a.audio, b.audio);
  assert.deepEqual(a.phrases.map((p) => p.text), b.phrases.map((p) => p.text));
  a.phrases.forEach((p, i) => assert.ok(Math.abs(p.start - b.phrases[i].start) <= 0.15, `phrase ${i} at ${p.start} vs ${b.phrases[i].start}`));
  assert.equal(a.frames.length, b.frames.length, `frames ${JSON.stringify(a.frames)} vs ${JSON.stringify(b.frames)}`);
  a.frames.forEach((f, i) => assert.ok(Math.abs(f.t - b.frames[i].t) <= 0.1, `frame ${i} at ${f.t} vs ${b.frames[i].t}`));
  assert.deepEqual(a.sections.map((s) => s.kind), b.sections.map((s) => s.kind));
}

/** Each screen of the synthetic recording has a frame during it that shows it. */
async function assertScreens(dir, screenTimes, duration) {
  const tl = readJson(path.join(dir, 'timeline.json'));
  const times = [...screenTimes, duration];
  for (let i = 0; i < screenTimes.length; i++) {
    const inScreen = tl.frames.filter((f) => f.t >= times[i] && f.t < times[i + 1]);
    assert.ok(inScreen.length >= 1, `a frame during screen ${i}`);
    for (const f of inScreen) {
      const rgb = await patchColor(f.file, 0.022, 0.78);
      const want = hexRgb(SCREENS[i].bg);
      assert.ok(Math.max(...rgb.map((v, k) => Math.abs(v - want[k]))) <= 24, `frame at ${f.t}s shows screen ${i}: got ${rgb}, want ${want}`);
    }
  }
}

test('A/V fMP4 segments in order: finish, auto-send, same bundle as the original file, times from the start of the picture', async () => {
  const id = uuid();
  const parts = segs.av;
  assert.ok(parts.length >= 8, `${parts.length} segments`);
  let total = 0;
  for (let q = 0; q < parts.length; q++) {
    const r = await put(srv, id, q, parts[q]);
    total += parts[q].length;
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { id, seq: q, received: q + 1, bytes: total });
  }
  const st = await srv.api(`/api/live/${id}`);
  assert.deepEqual(st.body.received, parts.map((_, i) => i));
  assert.equal(st.body.bytes, total);
  assert.equal(st.body.finished, false);
  assert.ok(Date.parse(st.body.lastAt) > Date.now() - 60_000);

  const meta = { id, startedAt: new Date(Date.now() - 30_000).toISOString(), durationSec: 20, source: 'broadcast', device: { model: 'iPhone 16 Pro', os: 'iOS 26.1' }, send: { threadId: 'stub-live-1' } };
  const f = await finish(srv, id, { meta, segmentCount: parts.length });
  assert.equal(f.status, 202);
  assert.deepEqual(f.body, { id, state: 'processing' });
  const rec = await ready(srv, id);
  assert.equal(rec.delivery.state, 'sent');
  assert.equal(rec.delivery.threadId, 'stub-live-1');
  assert.equal(stubCalls(home).filter((c) => c.argv[2] === 'stub-live-1').length, 1, 'delivered exactly once');
  assert.equal((await srv.api(`/api/live/${id}`)).body.finished, true);
  // Segment files are gone once the recording exists.
  assert.deepEqual(fs.readdirSync(path.join(home, 'live', id)).filter((n) => n.endsWith('.m4s')), []);

  // Times are from the first video frame: speech that starts 1.5 s into the picture is at +1.5 s.
  const live = bundleSummary(rec.bundlePath);
  assert.equal(live.audio, 'speech');
  for (const p of LIVE_PHRASES) {
    const hit = live.phrases.find((q) => p.keywords.every((k) => q.text.toLowerCase().includes(k)));
    assert.ok(hit, `"${p.text}" transcribed; got ${JSON.stringify(live.phrases)}`);
    assert.ok(Math.abs(hit.start - (p.t + 1.5)) <= 1.0, `"${hit.text}" at ${hit.start}, expected about ${p.t + 1.5}`);
  }
  await assertScreens(rec.bundlePath, [0, 6, 13], 20);
  const out = await probeStreams(path.join(rec.bundlePath, 'recording.mp4'));
  assert.ok(Math.abs(Number(out.format.duration) - 20) < 0.3, `recording.mp4 is ${out.format.duration}s`);
  assert.equal(Number(out.format.start_time), 0);
  assert.ok(out.streams.every((s) => Math.abs(Number(s.start_time)) < 0.05), `both tracks start at 0: ${JSON.stringify(out.streams)}`);

  // The original file through the same pipeline gives the same bundle.
  const orig = bundleSummary(await processOriginal(lf.av, 'orig-av'));
  assertSameBundle(live, orig);
});

test('video-only, out of order with a gap: missing_segments, then filled; duplicates replace', async () => {
  const id = uuid();
  const parts = segs.vonly;
  assert.ok(parts.length >= 4);
  const order = [0, ...parts.map((_, i) => i).slice(2).reverse()]; // 0, n-1, ..., 2 (1 is missing)
  for (const q of order) assert.equal((await put(srv, id, q, parts[q])).status, 200);
  // Duplicate: re-sending seq 2 replaces it; counts unchanged.
  const dup = await put(srv, id, 2, parts[2]);
  assert.equal(dup.status, 200);
  assert.equal(dup.body.received, parts.length - 1);
  assert.equal(dup.body.bytes, parts.reduce((s, b, i) => s + (i === 1 ? 0 : b.length), 0));
  const meta = { id, durationSec: 8 };
  const miss = await finish(srv, id, { meta, segmentCount: parts.length });
  assert.equal(miss.status, 409);
  assert.equal(miss.body.error, 'missing_segments');
  assert.deepEqual(miss.body.missing, [1]);
  assert.equal((await srv.api(`/api/recordings/${id}`)).body.state, 'receiving', 'still waiting');
  assert.equal((await put(srv, id, 1, parts[1])).body.received, parts.length);
  const f = await finish(srv, id, { meta, segmentCount: parts.length });
  assert.equal(f.status, 202);
  const rec = await ready(srv, id);
  const live = bundleSummary(rec.bundlePath);
  assert.equal(live.audio, 'none');
  assert.match(fs.readFileSync(rec.feedbackPath, 'utf8'), /no audio track/);
  assert.doesNotMatch(fs.readFileSync(rec.feedbackPath, 'utf8'), /interrupted/);
  await assertScreens(rec.bundlePath, [0, 4], 8);
  assertSameBundle(live, bundleSummary(await processOriginal(lf.vonly, 'orig-vonly')));
});

test('audio that starts before the picture is trimmed: times are from the first video frame', async () => {
  const dir = await processOriginal(lf.early, 'orig-early');
  const s = bundleSummary(dir);
  assert.ok(Math.abs(s.durationSec - 16) <= 0.2, `duration ${s.durationSec} (the picture is 16 s; the audio starts 1.5 s before it)`);
  for (const p of EARLY_PHRASES) {
    const hit = s.phrases.find((q) => p.keywords.every((k) => q.text.toLowerCase().includes(k)));
    assert.ok(hit, `"${p.text}" transcribed; got ${JSON.stringify(s.phrases)}`);
    assert.ok(Math.abs(hit.start - (p.t - 1.5)) <= 1.0, `"${hit.text}" at ${hit.start}, expected about ${p.t - 1.5}`);
  }
  // Screen 1 starts 7 s into the picture.
  await assertScreens(dir, [0, 7], 16);
});

test('truncated segment, missing Content-Length, receiving state, finish twice, PUT after finish', async () => {
  const id = uuid();
  const parts = segs.vonly;
  assert.equal((await put(srv, id, 0, parts[0])).status, 200);

  // A body shorter than Content-Length is discarded.
  const full = parts[1];
  const reply = await new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(`PUT /api/live/${id}/segments/1 HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${srv.token}\r\nContent-Length: ${full.length}\r\n\r\n`);
      sock.write(full.subarray(0, 1000), () => setTimeout(() => sock.end(), 200));
    });
    let resp = '';
    sock.on('data', (d) => (resp += d));
    sock.on('close', () => resolve(resp));
    sock.on('error', () => {});
  });
  await waitFor(async () => (await srv.api(`/api/live/${id}`)).body.received.length === 1, { timeoutMs: 5000, what: 'truncated segment discarded' });
  assert.deepEqual((await srv.api(`/api/live/${id}`)).body.received, [0], `truncated body not stored (server said: ${reply.split('\r\n')[0] || 'connection closed'})`);
  await waitFor(() => fs.readdirSync(path.join(home, 'live', id)).every((n) => !n.endsWith('.part')), { timeoutMs: 5000, what: 'no .part files' });

  // No Content-Length (chunked): 411.
  const chunked = await fetch(`${srv.base}/api/live/${id}/segments/1`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${srv.token}` },
    body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(full)); c.close(); } }),
    duplex: 'half',
  });
  assert.equal(chunked.status, 411);
  assert.equal((await chunked.json()).error, 'length_required');
  assert.equal((await srv.api(`/api/live/${id}/segments/abc`, { method: 'PUT', body: 'x' })).body.error, 'bad_seq');

  for (let q = 1; q < parts.length; q++) assert.equal((await put(srv, id, q, parts[q])).status, 200);

  // Receiving: listed with its byte count, and readable by id.
  const bytes = parts.reduce((s, b) => s + b.length, 0);
  const list = await srv.api('/api/recordings');
  const row = list.body.recordings.find((r) => r.id === id);
  assert.equal(row.state, 'receiving');
  assert.equal(row.receivedBytes, bytes);
  assert.ok(row.lastAt);
  const one = await srv.api(`/api/recordings/${id}`);
  assert.equal(one.body.state, 'receiving');
  assert.equal(one.body.receivedBytes, bytes);
  assert.equal((await srv.api(`/api/recordings/${id}/send`, { method: 'POST', json: { threadId: 'x' } })).status, 409);

  assert.equal((await finish(srv, id, { meta: { id }, segmentCount: 1 })).body.error, 'bad_segment_count');
  const first = await finish(srv, id, { meta: { id, durationSec: 8 }, segmentCount: parts.length });
  assert.equal(first.status, 202);
  const second = await finish(srv, id, { meta: { id, durationSec: 8 }, segmentCount: parts.length });
  assert.equal(second.status, 200);
  assert.equal(second.body.id, id);
  assert.ok(['processing', 'ready'].includes(second.body.state));
  const late = await put(srv, id, 1, parts[1]);
  assert.equal(late.status, 409);
  assert.equal(late.body.error, 'already_finished');
  await ready(srv, id);
  assert.equal((await srv.api('/api/recordings')).body.recordings.filter((r) => r.id === id).length, 1, 'listed once');
  const third = await finish(srv, id, { force: true });
  assert.equal(third.status, 200);
  assert.equal(third.body.state, 'ready');
});

test('force finish: contiguous segments from 0, whatever meta is known, marked interrupted', async () => {
  const id = uuid();
  const parts = segs.av;
  for (const q of [0, 1, 2, 3, 5]) assert.equal((await put(srv, id, q, parts[q])).status, 200); // 4 never arrives
  const meta = { id, durationSec: 20, note: 'Known before the force' };
  assert.equal((await finish(srv, id, { meta, segmentCount: parts.length })).status, 409);
  const f = await finish(srv, id, { force: true });
  assert.equal(f.status, 202);
  const rec = await ready(srv, id);
  const record = readJson(path.join(rec.bundlePath, 'record.json'));
  assert.equal(record.meta.interrupted, true);
  assert.equal(record.meta.note, 'Known before the force');
  const md = fs.readFileSync(rec.feedbackPath, 'utf8');
  assert.match(md, /^This recording was interrupted: .+$/m);
  assert.match(md, /Note from the user: Known before the force/);
  // Media segments 1..3 only: the picture stops where segment 3 ends.
  const cut = await probeStreams(path.join(rec.bundlePath, 'recording.mp4'));
  const expected = (await probeStreams(await (async () => {
    const f2 = path.join(home, 'first4.mp4');
    fs.writeFileSync(f2 + '.fmp4', Buffer.concat(parts.slice(0, 4)));
    await run('/opt/homebrew/bin/ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', f2 + '.fmp4', '-c', 'copy', f2]);
    return f2;
  })())).format.duration;
  assert.ok(Math.abs(Number(cut.format.duration) - Number(expected)) < 0.3, `interrupted recording is ${cut.format.duration}s, contiguous part is ${expected}s`);
  assert.ok(Number(cut.format.duration) < 10);
});

test('restart between segments: received segments survive, upload resumes and finishes', async () => {
  const id = uuid();
  const parts = segs.vonly;
  for (const q of [0, 1, 3]) assert.equal((await put(srv, id, q, parts[q])).status, 200);
  await srv.stop('SIGKILL');
  srv = await startServer(home, port);
  const st = await srv.api(`/api/live/${id}`);
  assert.deepEqual(st.body.received, [0, 1, 3]);
  assert.equal(st.body.finished, false);
  assert.equal((await srv.api(`/api/recordings/${id}`)).body.state, 'receiving');
  for (let q = 0; q < parts.length; q++) if (![0, 1, 3].includes(q)) assert.equal((await put(srv, id, q, parts[q])).status, 200);
  assert.equal((await finish(srv, id, { meta: { id }, segmentCount: parts.length })).status, 202);
  const rec = await ready(srv, id);
  await assertScreens(rec.bundlePath, [0, 4], 8);
});

test('rotation: meta.rotation 90 turns frames and recording.mp4 upright', async () => {
  const id = uuid();
  const parts = segs.land;
  for (let q = 0; q < parts.length; q++) assert.equal((await put(srv, id, q, parts[q])).status, 200);
  assert.equal((await finish(srv, id, { meta: { id, rotation: 90 }, segmentCount: parts.length })).status, 202);
  const rec = await ready(srv, id);
  const meta = readJson(path.join(rec.bundlePath, 'meta.json'));
  assert.ok(meta.height > meta.width, `portrait after rotation: ${meta.width}x${meta.height}`);
  const v = (await probeStreams(path.join(rec.bundlePath, 'recording.mp4'))).streams.find((s) => s.codec_type === 'video');
  assert.ok(v.height > v.width && !(v.side_data_list || []).some((d) => d.rotation), `recording.mp4 stored upright: ${JSON.stringify(v)}`);
  // Stored top-left red square, turned 90 degrees clockwise, is at the top right.
  const tl = readJson(path.join(rec.bundlePath, 'timeline.json'));
  const frame = tl.frames[0].file;
  const red = await patchColor(frame, 0.97, 0.02);
  const white = await patchColor(frame, 0.03, 0.02);
  assert.ok(red[0] > 200 && red[1] < 60 && red[2] < 60, `top right is red: ${red}`);
  assert.ok(white.every((c) => c > 200), `top left is white: ${white}`);
  assert.ok(!fs.readdirSync(rec.bundlePath).some((n) => n.startsWith('input.rotated')), 'temporary rotated copy removed');
});

test('recording.mp4 with Range requests; ?token= works on media routes only', async () => {
  const rec = (await srv.api('/api/recordings')).body.recordings.find((r) => r.state === 'ready' && r.frameCount > 0);
  const file = path.join(rec.bundlePath, 'recording.mp4');
  const data = fs.readFileSync(file);
  const size = data.length;
  const auth = { Authorization: `Bearer ${srv.token}` };
  const url = `${srv.base}/api/recordings/${rec.id}/recording.mp4`;

  const whole = await fetch(url, { headers: auth });
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get('content-type'), 'video/mp4');
  assert.equal(whole.headers.get('accept-ranges'), 'bytes');
  assert.ok(Buffer.from(await whole.arrayBuffer()).equals(data));

  const cases = [
    ['bytes=0-1', 0, 1],
    ['bytes=100-1099', 100, 1099],
    [`bytes=${size - 10}-`, size - 10, size - 1],
    ['bytes=-500', size - 500, size - 1],
    [`bytes=10-${size + 1000}`, 10, size - 1],
  ];
  for (const [range, a, b] of cases) {
    const r = await fetch(url, { headers: { ...auth, Range: range } });
    assert.equal(r.status, 206, range);
    assert.equal(r.headers.get('content-range'), `bytes ${a}-${b}/${size}`);
    assert.equal(Number(r.headers.get('content-length')), b - a + 1);
    assert.ok(Buffer.from(await r.arrayBuffer()).equals(data.subarray(a, b + 1)), `${range} body`);
  }
  const bad = await fetch(url, { headers: { ...auth, Range: `bytes=${size}-` } });
  assert.equal(bad.status, 416);
  assert.equal(bad.headers.get('content-range'), `bytes */${size}`);
  await bad.arrayBuffer();
  const head = await fetch(url, { method: 'HEAD', headers: auth });
  assert.equal(head.status, 200);
  assert.equal(Number(head.headers.get('content-length')), size);

  // ?token= on the three media routes, no header.
  const q = `token=${srv.token}`;
  const tl = readJson(path.join(rec.bundlePath, 'timeline.json'));
  const frameName = path.basename(tl.frames[0].file);
  const viaQuery = await fetch(`${url}?${q}`, { headers: { Range: 'bytes=0-99' } });
  assert.equal(viaQuery.status, 206);
  await viaQuery.arrayBuffer();
  const frame = await fetch(`${srv.base}/api/recordings/${rec.id}/frames/${frameName}?${q}`);
  assert.equal(frame.status, 200);
  assert.equal(Buffer.from(await frame.arrayBuffer())[0], 0xff);
  const sheet = await fetch(`${srv.base}/api/recordings/${rec.id}/contact-sheet.jpg?${q}`);
  assert.equal(sheet.status, 200);
  await sheet.arrayBuffer();
  assert.equal((await fetch(`${url}?token=${'0'.repeat(64)}`)).status, 401);
  assert.equal((await fetch(url)).status, 401);
  // Every other route still needs the header, even with a valid ?token=.
  for (const p of ['/api/health', '/api/recordings', `/api/recordings/${rec.id}`, `/api/live/${rec.id}`]) {
    const r = await fetch(`${srv.base}${p}?${q}`);
    assert.equal(r.status, 401, p);
    assert.equal((await r.json()).error, 'unauthorized');
  }
  const put401 = await fetch(`${srv.base}/api/live/${uuid()}/segments/0?${q}`, { method: 'PUT', body: Buffer.from('abc') });
  assert.equal(put401.status, 401);
  await put401.arrayBuffer();
});

test('idle rule: a session silent past the limit is finalised as interrupted; init-only sessions are left alone', async () => {
  const h2 = await tempHome('sb-live-idle-');
  const p2 = await freePort();
  const s2 = await startServer(h2, p2, { SCREENBRIEF_LIVE_IDLE_SEC: '3' });
  try {
    const id = uuid();
    const lonely = uuid();
    const parts = segs.vonly;
    for (const q of [0, 1, 2]) assert.equal((await put(s2, id, q, parts[q])).status, 200);
    assert.equal((await put(s2, lonely, 0, parts[0])).status, 200);
    assert.equal((await s2.api(`/api/recordings/${id}`)).body.state, 'receiving');
    const rec = await ready(s2, id);
    const record = readJson(path.join(rec.bundlePath, 'record.json'));
    assert.equal(record.meta.interrupted, true);
    assert.match(fs.readFileSync(rec.feedbackPath, 'utf8'), /^This recording was interrupted/m);
    assert.ok(rec.durationSec > 3 && rec.durationSec < 7, `segments 1-2 only: ${rec.durationSec}s`);
    assert.equal((await s2.api(`/api/live/${id}`)).body.finished, true);
    assert.equal((await put(s2, id, 3, parts[3])).body.error, 'already_finished');
    const l = await s2.api(`/api/live/${lonely}`);
    assert.equal(l.body.finished, false);
    assert.deepEqual(l.body.received, [0]);
  } finally {
    await s2.stop();
  }
});
