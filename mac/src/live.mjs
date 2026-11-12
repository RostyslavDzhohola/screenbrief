// Live segment ingest: the phone's broadcast extension streams a recording while it is
// being made, as fragmented-MP4 segments (seq 0 = initialization segment, 1..n media).
// One directory per session under live/<id>/ holds session.json and seg-NNNNNN.m4s; it
// survives restarts. Finishing concatenates 0..n-1, remuxes to a regular MP4 and hands
// it to the Store exactly like an uploaded recording.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { remux } from './media.mjs';
import { writeJsonAtomic, readJsonSync, log } from './util.mjs';

export const SEQ_MAX = 999_999;
const SEG_RE = /^seg-(\d{6})\.m4s$/;
const segName = (seq) => `seg-${String(seq).padStart(6, '0')}.m4s`;

export class LiveError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export class LiveStore {
  constructor({ liveDir, incomingDir, store, tools, cfg }) {
    this.liveDir = liveDir;
    this.incomingDir = incomingDir;
    this.store = store;
    this.tools = tools;
    this.cfg = cfg;
    this.idleSec = Number(cfg.liveIdleSec) > 0 ? Number(cfg.liveIdleSec) : 1800;
    this.sessions = new Map();
    this.timer = null;
    this.closed = false;
  }

  sessionFile(sess) {
    return path.join(sess.dir, 'session.json');
  }

  /** Writes are serialised per session and always write the latest state. */
  save(sess) {
    sess.saving = (sess.saving || Promise.resolve()).then(() => writeJsonAtomic(this.sessionFile(sess), this.snapshot(sess))).catch((e) => log(`live ${sess.id}: could not save session: ${e.message}`));
    return sess.saving;
  }

  snapshot(sess) {
    return {
      id: sess.id,
      createdAt: sess.createdAt,
      lastAt: sess.lastAt,
      meta: sess.meta,
      segmentCount: sess.segmentCount,
      finished: sess.finished,
      finishedAt: sess.finishedAt,
      recordingId: sess.recordingId,
      interrupted: sess.interrupted,
    };
  }

  async load() {
    await fsp.mkdir(this.liveDir, { recursive: true });
    const dirs = (await fsp.readdir(this.liveDir, { withFileTypes: true })).filter((d) => d.isDirectory());
    for (const d of dirs) {
      const dir = path.join(this.liveDir, d.name);
      const saved = readJsonSync(path.join(dir, 'session.json'), null) || {};
      const id = saved.id || d.name;
      const sess = this.blank(id, dir);
      Object.assign(sess, {
        createdAt: saved.createdAt || sess.createdAt,
        lastAt: saved.lastAt || null,
        meta: saved.meta || null,
        segmentCount: saved.segmentCount || null,
        finished: !!saved.finished,
        finishedAt: saved.finishedAt || null,
        recordingId: saved.recordingId || null,
        interrupted: !!saved.interrupted,
      });
      for (const f of await fsp.readdir(dir)) {
        if (f.endsWith('.part') || f.endsWith('.tmp')) {
          await fsp.rm(path.join(dir, f), { force: true });
          continue;
        }
        const m = SEG_RE.exec(f);
        if (m) sess.segments.set(Number(m[1]), (await fsp.stat(path.join(dir, f))).size);
      }
      // Stopped after the recording was created but before the session was marked finished.
      if (!sess.finished && this.store.get(id)) {
        sess.finished = true;
        sess.finishedAt = new Date().toISOString();
        sess.recordingId = id;
        await this.dropSegments(sess);
      }
      if (!sess.lastAt) sess.lastAt = sess.createdAt;
      this.sessions.set(id, sess);
      await this.save(sess);
    }
  }

  blank(id, dir = path.join(this.liveDir, id)) {
    const now = new Date().toISOString();
    return { id, dir, createdAt: now, lastAt: now, meta: null, segmentCount: null, finished: false, finishedAt: null, recordingId: null, interrupted: false, segments: new Map(), finishing: null, saving: null, autoFailed: false };
  }

  async session(id) {
    let sess = this.sessions.get(id);
    if (!sess) {
      sess = this.blank(id);
      // Registered before the first await: two first segments arriving together must share it.
      this.sessions.set(id, sess);
      sess.ready = (async () => {
        await fsp.mkdir(sess.dir, { recursive: true });
        await this.save(sess);
      })();
    }
    if (sess.ready) await sess.ready;
    return sess;
  }

  /** Finalised (or an id that already exists as an uploaded recording). */
  isFinished(id) {
    const sess = this.sessions.get(id);
    return !!((sess && (sess.finished || sess.finishing)) || this.store.get(id));
  }

  bytes(sess) {
    let n = 0;
    for (const v of sess.segments.values()) n += v;
    return n;
  }

  /** Longest run 0..k-1 of present segments; returns k. */
  contiguous(sess) {
    let k = 0;
    while (sess.segments.has(k)) k++;
    return k;
  }

  status(id) {
    const sess = this.sessions.get(id);
    const finished = this.isFinished(id);
    if (!sess) return { id, received: [], bytes: 0, lastAt: null, finished };
    return { id, received: [...sess.segments.keys()].sort((a, b) => a - b), bytes: this.bytes(sess), lastAt: sess.lastAt, finished };
  }

  /** Store one segment from a request body; Content-Length already validated by the caller. */
  async putSegment(id, seq, req, expected) {
    if (this.isFinished(id)) throw new LiveError(409, 'already_finished', `Live recording ${id} was already finalised.`);
    const sess = await this.session(id);
    const part = path.join(sess.dir, `${segName(seq)}.${crypto.randomBytes(4).toString('hex')}.part`);
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
        if (e && /^E(NOSPC|ACCES|ROFS|IO)$/.test(e.code || '')) throw new LiveError(507, 'storage_error', `Could not store the segment on the Mac: ${e.message}`);
        throw new LiveError(400, 'truncated', `Segment ${seq} interrupted after ${received} of ${expected} bytes; discarded.`);
      }
      if (received !== expected) throw new LiveError(400, 'truncated', `Segment ${seq}: received ${received} of ${expected} bytes; discarded.`);
      // Finalised while this body was arriving: too late to be part of it.
      if (sess.finished || sess.finishing) throw new LiveError(409, 'already_finished', `Live recording ${id} was already finalised.`);
      await fsp.rename(part, path.join(sess.dir, segName(seq)));
    } catch (e) {
      await fsp.rm(part, { force: true });
      throw e;
    }
    sess.segments.set(seq, received);
    sess.lastAt = new Date().toISOString();
    sess.autoFailed = false;
    await this.save(sess);
    return { id, seq, received: sess.segments.size, bytes: this.bytes(sess) };
  }

  /**
   * POST /finish. Returns { status, body }.
   * body: { meta, segmentCount } or { force: true [, meta] }.
   */
  async finish(id, body) {
    const existing = this.store.get(id);
    if (existing) return { status: 200, body: this.store.view(existing) };
    let sess = this.sessions.get(id);
    if (sess && sess.finishing) {
      await sess.finishing.catch(() => {});
      const rec = this.store.get(id);
      if (rec) return { status: 200, body: this.store.view(rec) };
    }
    const force = body.force === true;
    if (body.meta !== undefined && (!body.meta || typeof body.meta !== 'object' || Array.isArray(body.meta))) throw new LiveError(400, 'bad_meta', 'meta must be an object.');
    if (body.meta && body.meta.id && body.meta.id !== id) throw new LiveError(400, 'id_mismatch', 'meta.id does not match the live id.');
    let count = null;
    if (!force || body.segmentCount !== undefined) {
      count = Number(body.segmentCount);
      if (!Number.isSafeInteger(count) || count < 2 || count > SEQ_MAX + 1) throw new LiveError(400, 'bad_segment_count', 'segmentCount must be an integer >= 2 (the init segment plus at least one media segment).');
    }
    sess = sess || (await this.session(id));
    if (body.meta) sess.meta = body.meta;
    if (count) sess.segmentCount = count;
    sess.lastAt = new Date().toISOString();
    sess.autoFailed = false;
    if (force) {
      const run = this.contiguous(sess);
      if (run < 2) {
        await this.save(sess);
        throw new LiveError(409, 'nothing_to_finish', 'Need the init segment (0) and media segment 1 before a forced finish.', { missing: [0, 1].filter((q) => !sess.segments.has(q)) });
      }
      await this.finalize(sess, run, true);
    } else {
      const missing = [];
      for (let q = 0; q < count; q++) if (!sess.segments.has(q)) missing.push(q);
      if (missing.length) {
        await this.save(sess);
        throw new LiveError(409, 'missing_segments', `${missing.length} of ${count} segments have not arrived yet.`, { missing });
      }
      await this.finalize(sess, count, false);
    }
    return { status: 202, body: { id, state: 'processing' } };
  }

  /** Concatenate seq 0..count-1, remux, and queue it as a recording. */
  finalize(sess, count, interrupted) {
    if (sess.finishing) return sess.finishing;
    sess.finishing = (async () => {
      const tag = crypto.randomBytes(4).toString('hex');
      const cat = path.join(this.incomingDir, `${sess.id}.${tag}.live.fmp4`);
      const out = path.join(this.incomingDir, `${sess.id}.${tag}.live.mp4`);
      try {
        await fsp.writeFile(cat, '');
        for (let q = 0; q < count; q++) {
          await pipeline(fs.createReadStream(path.join(sess.dir, segName(q))), fs.createWriteStream(cat, { flags: 'a' }));
        }
        let upload = out;
        try {
          await remux(this.tools, cat, out, { timeoutMs: 600_000 });
          await fsp.rm(cat, { force: true });
        } catch (e) {
          log(`live ${sess.id}: remux failed, processing the raw concatenation: ${e.message}`);
          await fsp.rm(out, { force: true });
          upload = cat;
        }
        const meta = { ...(sess.meta || {}), id: sess.id };
        if (interrupted) meta.interrupted = true;
        if (meta.diagnostics) log(`live ${sess.id}: phone diagnostics ${JSON.stringify(meta.diagnostics)}`);
        const rec = await this.store.create({ id: sess.id, meta, uploadPath: upload, contentType: 'video/mp4' });
        sess.finished = true;
        sess.finishedAt = new Date().toISOString();
        sess.recordingId = rec.id;
        sess.interrupted = !!meta.interrupted;
        const bytes = this.bytes(sess);
        await this.save(sess);
        await this.dropSegments(sess);
        log(`live ${sess.id}: finalised ${count} segments (${bytes} bytes)${interrupted ? ', interrupted' : ''} -> ${rec.dir}`);
      } catch (e) {
        await fsp.rm(cat, { force: true });
        await fsp.rm(out, { force: true });
        throw e;
      } finally {
        sess.finishing = null;
      }
    })();
    return sess.finishing;
  }

  /** Segment files are not needed once the recording exists; session.json stays as the record. */
  async dropSegments(sess) {
    for (const q of sess.segments.keys()) await fsp.rm(path.join(sess.dir, segName(q)), { force: true });
  }

  /** Recording-shaped view of a session that has segments and is not finalised. */
  receivingView(id) {
    const sess = this.sessions.get(id);
    if (!sess || sess.finished || !sess.segments.size || this.store.get(id)) return null;
    const meta = sess.meta || {};
    return {
      id,
      state: 'receiving',
      createdAt: sess.createdAt,
      durationSec: Number(meta.durationSec) || null,
      bundlePath: sess.dir,
      feedbackPath: path.join(sess.dir, 'FEEDBACK.md'),
      frameCount: 0,
      transcriptPreview: '',
      receivedBytes: this.bytes(sess),
      lastAt: sess.lastAt,
    };
  }

  receivingViews() {
    return [...this.sessions.keys()].map((id) => this.receivingView(id)).filter(Boolean);
  }

  /** Auto-finalise sessions idle past the limit (needs segments 0 and 1). */
  async sweep() {
    const cutoff = Date.now() - this.idleSec * 1000;
    for (const sess of this.sessions.values()) {
      if (this.closed) return;
      if (sess.finished || sess.finishing || sess.autoFailed || this.store.get(sess.id)) continue;
      if (!(Date.parse(sess.lastAt) < cutoff)) continue;
      const run = this.contiguous(sess);
      if (run < 2) continue;
      log(`live ${sess.id}: idle since ${sess.lastAt}; finalising ${run} contiguous segments as interrupted`);
      await this.finalize(sess, run, true).catch((e) => {
        sess.autoFailed = true;
        log(`live ${sess.id}: auto-finalise failed: ${e.message}`);
      });
    }
  }

  start() {
    const every = Math.max(250, Math.min(60_000, (this.idleSec * 1000) / 4));
    const tick = () => {
      if (this.closed) return;
      this.sweep().catch((e) => log('live sweep error:', e.message)).finally(() => {
        if (!this.closed) {
          this.timer = setTimeout(tick, every);
          this.timer.unref?.();
        }
      });
    };
    this.timer = setTimeout(tick, Math.min(every, 1000));
    this.timer.unref?.();
  }

  async close() {
    this.closed = true;
    clearTimeout(this.timer);
  }
}
