// HTTP API shared with the iPhone app, plus the no-install web page at "/".
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Store, ID_RE } from './store.mjs';
import { LiveStore, LiveError, SEQ_MAX } from './live.mjs';
import { T3 } from './t3.mjs';
import { loadConfig, ensureDirs, tools as toolPaths, VERSION, PACKAGE_DIR } from './config.mjs';
import { localHostName, pairingInfo, redeemPairCode } from './net.mjs';
import { log, killAllChildren } from './util.mjs';

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function sendJson(res, status, body, headers = {}) {
  if (res.headersSent) return;
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data), 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}

const err = (res, status, code, message, extra = {}, headers = {}) => sendJson(res, status, { error: code, message, ...extra }, headers);

/** One "bytes=" range against a file size: null (serve it all), 'unsatisfiable', or { start, end }. */
export function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m || (m[1] === '' && m[2] === '')) return null; // multiple or malformed ranges: send the whole file
  let start;
  let end;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (!n || !size) return 'unsatisfiable';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
    if (start >= size || start > end) return 'unsatisfiable';
  }
  return { start, end };
}

function decodeMeta(header) {
  if (!header) return {};
  try {
    const json = Buffer.from(String(header).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const v = JSON.parse(json);
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    return v;
  } catch (e) {
    throw new HttpError(400, 'bad_meta', `X-ScreenBrief-Meta is not base64url JSON: ${e.message}`);
  }
}

async function readJsonBody(req, limit = 64 * 1024) {
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > limit) throw new HttpError(413, 'too_large', 'Request body too large.');
    chunks.push(c);
  }
  if (!n) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return v && typeof v === 'object' ? v : {};
  } catch {
    throw new HttpError(400, 'bad_json', 'The request body is not valid JSON.');
  }
}

function validTarget(body) {
  const target = {};
  if (body.threadId !== undefined && body.threadId !== null && body.threadId !== '') {
    if (typeof body.threadId !== 'string' || body.threadId.length > 600) throw new HttpError(400, 'bad_thread', 'threadId must be a string.');
    target.threadId = body.threadId;
  }
  if (!target.threadId && body.projectPath) {
    if (typeof body.projectPath !== 'string' || !path.isAbsolute(body.projectPath)) throw new HttpError(400, 'bad_project', 'projectPath must be an absolute path.');
    target.projectPath = body.projectPath;
  }
  if (!target.threadId && !target.projectPath) throw new HttpError(400, 'missing_target', 'Pass threadId (existing thread) or projectPath (new thread).');
  if (body.note !== undefined && body.note !== null) target.note = String(body.note).slice(0, 4000);
  return target;
}

/** Bonjour advertisement through dns-sd; restarted with backoff if it dies, never fatal. */
function advertise(port) {
  let child = null;
  let stopped = false;
  let delay = 2000;
  const start = () => {
    if (stopped) return;
    try {
      child = spawn('/usr/bin/dns-sd', ['-R', 'ScreenBrief', '_screenbrief._tcp', 'local', String(port), 'version=1', 'path=/'], { stdio: 'ignore' });
    } catch (e) {
      log('dns-sd failed to start:', e.message);
      child = null;
    }
    const started = Date.now();
    const retry = () => {
      child = null;
      if (stopped) return;
      if (Date.now() - started > 60_000) delay = 2000;
      setTimeout(start, delay).unref();
      delay = Math.min(delay * 2, 60_000);
    };
    if (child) {
      child.on('error', (e) => log('dns-sd error:', e.message));
      child.on('exit', (code) => {
        if (!stopped) log(`dns-sd exited (${code}); retrying`);
        retry();
      });
    } else retry();
  };
  start();
  return () => {
    stopped = true;
    if (child) child.kill('SIGTERM');
  };
}

export async function startServer({ port, host = '0.0.0.0', bonjour = true } = {}) {
  const cfg = loadConfig();
  const p = ensureDirs();
  const tools = toolPaths(cfg);
  const listenPort = port || cfg.port;
  const t3 = new T3({ t3Bin: tools.t3, projectPaths: cfg.projectPaths || [] });
  const store = new Store({ recordingsDir: p.recordings, incomingDir: p.incoming, cfg, tools, t3 });
  await store.load();
  const live = new LiveStore({ liveDir: p.live, incomingDir: p.incoming, store, tools, cfg });
  await live.load();
  live.start();
  const tokenBuf = Buffer.from(cfg.token);
  const hostName = localHostName();
  const uploading = new Set();
  const page = path.join(PACKAGE_DIR, 'web', 'index.html');

  const tokenOk = (s) => {
    const b = Buffer.from(String(s).trim());
    return b.length === tokenBuf.length && crypto.timingSafeEqual(b, tokenBuf);
  };
  const authorized = (req) => {
    const h = req.headers.authorization || '';
    const m = /^Bearer\s+(.+)$/i.exec(h);
    return !!m && tokenOk(m[1]);
  };
  // Media GETs (frames, contact sheet, recording.mp4) also take ?token= so an image view
  // or video player can load them without custom headers. Nothing else does.
  const isMediaRoute = (req, parts) =>
    (req.method === 'GET' || req.method === 'HEAD') && parts[1] === 'recordings' && parts[2] &&
    ((parts.length === 4 && (parts[3] === 'contact-sheet.jpg' || parts[3] === 'recording.mp4')) || (parts[3] === 'frames' && parts.length >= 5));

  const contentLength = (req, limit) => {
    const lenHeader = req.headers['content-length'];
    if (lenHeader === undefined) throw new HttpError(411, 'length_required', 'Content-Length is required.');
    const expected = Number(lenHeader);
    if (!Number.isSafeInteger(expected) || expected <= 0) throw new HttpError(400, 'bad_length', 'Content-Length must be a positive integer.');
    if (expected > limit) throw new HttpError(413, 'too_large', `Limited to ${limit} bytes.`);
    return expected;
  };

  async function handleLive(req, res, id, action, seq, extra) {
    if (!id || !ID_RE.test(id)) throw new HttpError(400, 'bad_id', 'Live ids are letters, digits, - and _.');
    if (req.method === 'GET' && !action) return sendJson(res, 200, live.status(id));
    if (action === 'segments' && seq !== undefined && !extra && req.method === 'PUT') {
      if (!/^\d{1,6}$/.test(seq) || Number(seq) > SEQ_MAX) throw new HttpError(400, 'bad_seq', `seq must be an integer 0..${SEQ_MAX}.`);
      if (live.isFinished(id)) {
        sendJson(res, 409, { error: 'already_finished', message: `Live recording ${id} was already finalised.` });
        req.resume();
        return;
      }
      // A ~2 s segment is about 1 MB; this bound keeps a broken client from filling the disk.
      const expected = contentLength(req, Math.min(cfg.maxUploadBytes, cfg.maxSegmentBytes || 64 * 1024 * 1024));
      return sendJson(res, 200, await live.putSegment(id, Number(seq), req, expected));
    }
    if (action === 'finish' && seq === undefined && req.method === 'POST') {
      const r = await live.finish(id, await readJsonBody(req, 1024 * 1024));
      return sendJson(res, r.status, r.body);
    }
    throw new HttpError(404, 'not_found', 'Not found.');
  }

  async function handleUpload(req, res, url) {
    const meta = decodeMeta(req.headers['x-screenbrief-meta']);
    const id = url.searchParams.get('id') || meta.id;
    if (!id || !ID_RE.test(id)) throw new HttpError(400, 'bad_id', 'Pass ?id=<client uuid> (letters, digits, - and _).');
    if (meta.id && meta.id !== id) throw new HttpError(400, 'id_mismatch', 'meta.id does not match ?id.');
    const existing = store.get(id);
    if (existing) {
      // Idempotent: never reprocess. Drain whatever the client still sends.
      sendJson(res, 200, store.view(existing));
      req.resume();
      return;
    }
    if (uploading.has(id)) {
      sendJson(res, 409, { error: 'upload_in_progress', message: 'An upload with this id is already in progress.' }, { Connection: 'close' });
      req.resume();
      return;
    }
    const lenHeader = req.headers['content-length'];
    if (lenHeader === undefined) throw new HttpError(411, 'length_required', 'Content-Length is required.');
    const expected = Number(lenHeader);
    if (!Number.isSafeInteger(expected) || expected <= 0) throw new HttpError(400, 'bad_length', 'Content-Length must be a positive integer.');
    if (expected > cfg.maxUploadBytes) throw new HttpError(413, 'too_large', `Uploads are limited to ${cfg.maxUploadBytes} bytes.`);
    uploading.add(id);
    const part = path.join(p.incoming, `${id}.${crypto.randomBytes(4).toString('hex')}.part`);
    let received = 0;
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        received += chunk.length;
        cb(null, chunk);
      },
    });
    try {
      try {
        await pipeline(req, counter, fs.createWriteStream(part));
      } catch (e) {
        if (e && /^E(NOSPC|ACCES|ROFS|IO)$/.test(e.code || '')) throw new HttpError(507, 'storage_error', `Could not store the upload on the Mac: ${e.message}`);
        throw new HttpError(400, 'truncated', `Upload interrupted after ${received} of ${expected} bytes; discarded.`);
      }
      if (received !== expected) throw new HttpError(400, 'truncated', `Received ${received} of ${expected} bytes; discarded.`);
      const contentType = String(req.headers['content-type'] || '');
      const rec = await store.create({ id, meta: { ...meta, id }, uploadPath: part, contentType });
      log(`upload ${id}: ${received} bytes -> ${rec.dir}`);
      sendJson(res, 202, { id, state: 'processing' });
    } catch (e) {
      await fsp.rm(part, { force: true });
      if (e instanceof HttpError) log(`upload ${id} rejected: ${e.message}`);
      throw e;
    } finally {
      uploading.delete(id);
    }
  }

  async function serveFile(req, res, file, type) {
    let st;
    try {
      st = await fsp.stat(file);
      if (!st.isFile()) throw new Error('not a file');
    } catch {
      throw new HttpError(404, 'not_found', 'No such file.');
    }
    const head = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=300', 'Last-Modified': st.mtime.toUTCString() };
    const range = parseRange(req.headers.range, st.size);
    if (range === 'unsatisfiable') {
      return err(res, 416, 'range_not_satisfiable', `The file is ${st.size} bytes.`, {}, { 'Content-Range': `bytes */${st.size}` });
    }
    if (range) {
      res.writeHead(206, { ...head, 'Content-Length': range.end - range.start + 1, 'Content-Range': `bytes ${range.start}-${range.end}/${st.size}` });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file, { start: range.start, end: range.end }).pipe(res);
      return;
    }
    res.writeHead(200, { ...head, 'Content-Length': st.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  }

  async function route(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = await fsp.readFile(page);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': html.length, 'Cache-Control': 'no-store' });
      res.end(html);
      return;
    }
    if (req.method === 'GET' && parts[0] === 'pair' && parts.length === 2) {
      // Tap-to-pair: a short-lived code (from `screenbrief pair`) opens the app already paired.
      const ok = redeemPairCode(p.pairCodes, parts[1]);
      const esc = (t) => String(t).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
      const body = ok
        ? `<h1>Pair ScreenBrief</h1><p>This links the ScreenBrief app on this iPhone to <b>${esc(hostName)}</b>.</p><p><a class="b" href="${esc(pairingInfo(cfg).link)}">Open ScreenBrief</a></p><p class="s">If nothing happens, the app is not installed on this phone yet.</p>`
        : '<h1>Link expired</h1><p>This pairing link is used up or has expired. Ask for a new one (on the Mac: <code>screenbrief pair</code>).</p>';
      const html = Buffer.from(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ScreenBrief pairing</title><style>body{font:17px -apple-system,system-ui,sans-serif;margin:0;padding:48px 24px;text-align:center;background:#111;color:#eee}h1{font-size:26px}.b{display:inline-block;margin:20px 0;padding:16px 28px;border-radius:14px;background:#e8173d;color:#fff;font-weight:600;text-decoration:none;font-size:19px}.s{color:#999;font-size:14px}code{background:#222;padding:2px 6px;border-radius:6px}</style>${body}`);
      res.writeHead(ok ? 200 : 410, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': html.length, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
      res.end(html);
      return;
    }
    if (parts[0] !== 'api') throw new HttpError(404, 'not_found', 'Not found.');
    if (!authorized(req) && !(isMediaRoute(req, parts) && url.searchParams.has('token') && tokenOk(url.searchParams.get('token')))) {
      sendJson(res, 401, { error: 'unauthorized', message: 'Missing or wrong bearer token.' });
      req.resume();
      return;
    }
    const [, a, b, c, d] = parts;
    if (req.method === 'GET' && a === 'health' && !b) return sendJson(res, 200, { ok: true, name: 'ScreenBrief', version: VERSION, host: hostName });
    if (req.method === 'GET' && a === 'threads' && !b) {
      const r = await t3.threads(60);
      return sendJson(res, 200, { threads: r.threads, ...(r.warning ? { warning: r.warning } : {}) });
    }
    if (req.method === 'GET' && a === 'projects' && !b) {
      const r = await t3.projects();
      return sendJson(res, 200, { projects: r.projects, ...(r.warning ? { warning: r.warning } : {}) });
    }
    if (a === 'live') return handleLive(req, res, b, c, d, parts[5]);
    if (a === 'recordings') {
      if (!b) {
        if (req.method === 'POST') return handleUpload(req, res, url);
        if (req.method === 'GET') {
          const all = [...store.list().map((r) => store.view(r)), ...live.receivingViews()];
          all.sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt)));
          return sendJson(res, 200, { recordings: all });
        }
        throw new HttpError(405, 'method_not_allowed', 'Use GET or POST.');
      }
      const rec = store.get(b);
      if (!rec) {
        const receiving = live.receivingView(b);
        if (receiving && !c && req.method === 'GET') return sendJson(res, 200, receiving);
        if (receiving && c === 'send') throw new HttpError(409, 'still_receiving', 'This recording is still arriving from the phone; send it once it has been processed.');
        throw new HttpError(404, 'not_found', `No recording with id ${b}.`);
      }
      if (!c && req.method === 'GET') return sendJson(res, 200, store.view(rec));
      if (c === 'send' && !d && req.method === 'POST') {
        const target = validTarget(await readJsonBody(req));
        const r = await store.requestSend(rec, target);
        const { attemptAt, ...delivery } = r.delivery || {};
        return sendJson(res, r.status, { delivery });
      }
      const getLike = req.method === 'GET' || req.method === 'HEAD';
      if (getLike && c === 'contact-sheet.jpg' && !d) return serveFile(req, res, path.join(rec.dir, 'contact-sheet.jpg'), 'image/jpeg');
      if (getLike && c === 'recording.mp4' && !d) {
        if (rec.state !== 'ready') throw new HttpError(404, 'not_found', 'recording.mp4 exists once processing has finished.');
        return serveFile(req, res, path.join(rec.dir, 'recording.mp4'), 'video/mp4');
      }
      if (getLike && c === 'frames' && d) {
        const name = parts.slice(4).join('/');
        if (!/^(extra\/)?[A-Za-z0-9._-]+\.jpg$/.test(name) || name.includes('..')) throw new HttpError(400, 'bad_name', 'Bad frame name.');
        return serveFile(req, res, path.join(rec.dir, 'frames', name), 'image/jpeg');
      }
    }
    throw new HttpError(404, 'not_found', 'Not found.');
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((e) => {
      if (e instanceof LiveError) {
        if (!res.headersSent) err(res, e.status, e.code, e.message, e.extra);
      } else if (e instanceof HttpError) {
        if (!res.headersSent) err(res, e.status, e.code, e.message);
      } else if (e && e.status && e.code) {
        if (!res.headersSent) err(res, e.status, e.code, e.message);
      } else {
        log('request error:', e && e.stack ? e.stack : e);
        if (!res.headersSent) err(res, 500, 'internal', String((e && e.message) || e));
      }
      req.resume();
    });
  });
  server.requestTimeout = 0; // big uploads over slow Wi-Fi
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 10_000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPort, host, resolve);
  });
  const stopAdvertising = bonjour && process.env.SCREENBRIEF_NO_BONJOUR !== '1' ? advertise(listenPort) : () => {};
  log(`ScreenBrief listening on http://${host}:${listenPort} (data in ${p.home})`);
  const close = async () => {
    stopAdvertising();
    await live.close();
    await store.close();
    killAllChildren();
    await new Promise((r) => server.close(() => r()));
    server.closeAllConnections?.();
  };
  return { server, store, live, port: listenPort, close };
}

export async function serveForever(opts) {
  const s = await startServer(opts);
  let stopping = false;
  const stop = async (sig) => {
    if (stopping) return;
    stopping = true;
    log(`${sig}: shutting down`);
    const force = setTimeout(() => process.exit(0), 5000);
    force.unref();
    try {
      await s.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
  return s;
}
