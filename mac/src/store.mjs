// The server's recordings: one bundle directory per recording with record.json
// (server state) next to the pipeline's status.json. A single worker processes the
// queue one recording at a time; everything needed to resume is on disk.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { processVideo, readStatus, loadBundle, bundleDirName } from './pipeline.mjs';
import { deliverBundle } from './deliver.mjs';
import { writeJsonAtomic, readJsonSync, log } from './util.mjs';

export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

export class Store {
  constructor({ recordingsDir, incomingDir, cfg, tools, t3 }) {
    this.recordingsDir = recordingsDir;
    this.incomingDir = incomingDir;
    this.cfg = cfg;
    this.tools = tools;
    this.t3 = t3;
    this.records = new Map();
    this.queue = [];
    this.working = false;
    this.current = null;
    this.idle = Promise.resolve();
    this.closed = false;
  }

  recordFile(rec) {
    return path.join(rec.dir, 'record.json');
  }

  async save(rec) {
    await writeJsonAtomic(this.recordFile(rec), rec);
  }

  /** Load records from disk; resume interrupted work. */
  async load() {
    await fsp.mkdir(this.recordingsDir, { recursive: true });
    await fsp.mkdir(this.incomingDir, { recursive: true });
    // Partial uploads from a previous run are never processed.
    for (const f of await fsp.readdir(this.incomingDir)) await fsp.rm(path.join(this.incomingDir, f), { force: true, recursive: true });
    const dirs = (await fsp.readdir(this.recordingsDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    const resumeDeliveries = [];
    for (const name of dirs) {
      const dir = path.join(this.recordingsDir, name);
      const rec = readJsonSync(path.join(dir, 'record.json'), null);
      if (!rec || !rec.id) continue;
      rec.dir = dir;
      if (rec.state === 'processing') {
        if (rec.inputPath && fs.existsSync(rec.inputPath)) {
          rec.stage = 'queued';
          rec.resumedAt = new Date().toISOString();
          this.queue.push(rec.id);
        } else {
          rec.state = 'failed';
          rec.error = 'Processing was interrupted and the uploaded file is gone.';
        }
        await this.save(rec);
      }
      if (rec.delivery && rec.delivery.state === 'pending') {
        if (rec.delivery.attemptAt) {
          // We may or may not have reached T3 before stopping: never risk a duplicate message.
          rec.delivery = { ...rec.delivery, state: 'failed', error: 'The server stopped while sending; not retried to avoid a duplicate message. Send it again.' };
          delete rec.delivery.attemptAt;
          await this.save(rec);
        } else if (rec.state === 'ready') resumeDeliveries.push(rec);
        else if (rec.state === 'failed') {
          rec.delivery = { state: 'failed', error: 'The recording failed to process.' };
          await this.save(rec);
        }
      }
      this.records.set(rec.id, rec);
    }
    for (const rec of resumeDeliveries) this.deliver(rec).catch((e) => log('delivery error', e.message));
    this.kick();
  }

  get(id) {
    return this.records.get(id);
  }

  list() {
    return [...this.records.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  /** Register a fully received upload and queue it. */
  async create({ id, meta, uploadPath, contentType }) {
    const created = new Date();
    const recordedAt = meta.startedAt && !Number.isNaN(Date.parse(meta.startedAt)) ? new Date(meta.startedAt) : created;
    let dir = path.join(this.recordingsDir, bundleDirName(id, recordedAt));
    if (fs.existsSync(dir)) dir = path.join(this.recordingsDir, bundleDirName(id, created));
    await fsp.mkdir(dir, { recursive: true });
    const ext = /mp4/i.test(contentType || '') ? '.mp4' : '.mov';
    const inputPath = path.join(dir, 'original' + ext);
    await fsp.rename(uploadPath, inputPath);
    const rec = {
      id,
      createdAt: created.toISOString(),
      dir,
      inputPath,
      state: 'processing',
      stage: 'queued',
      meta,
      delivery: null,
      deliveryRequest: null,
    };
    if (meta.send && (meta.send.threadId || meta.send.projectPath)) {
      rec.deliveryRequest = { threadId: meta.send.threadId, projectPath: meta.send.projectPath, note: meta.send.note };
      rec.delivery = { state: 'pending', ...(meta.send.threadId ? { threadId: meta.send.threadId } : {}) };
    }
    await this.save(rec);
    this.records.set(id, rec);
    this.queue.push(id);
    this.kick();
    return rec;
  }

  kick() {
    if (this.working || this.closed) return;
    this.working = true;
    this.idle = this.work().finally(() => {
      this.working = false;
    });
  }

  async work() {
    while (this.queue.length && !this.closed) {
      const id = this.queue.shift();
      const rec = this.records.get(id);
      if (!rec || rec.state !== 'processing') continue;
      this.current = id;
      rec.stage = 'transcoding';
      await this.save(rec);
      const started = Date.now();
      try {
        const bundle = await processVideo(rec.inputPath, {
          outDir: rec.dir,
          id: rec.id,
          meta: rec.meta || {},
          cfg: this.cfg,
          tools: this.tools,
          onStatus: (s) => {
            rec.stage = s.stage;
          },
        });
        rec.state = 'ready';
        rec.stage = 'done';
        rec.processedAt = new Date().toISOString();
        rec.processingSec = Number(((Date.now() - started) / 1000).toFixed(2));
        rec.durationSec = bundle.durationSec;
        if (!this.cfg.keepOriginal) {
          await fsp.rm(rec.inputPath, { force: true });
          rec.inputPath = null;
        }
        await this.save(rec);
        log(`processed ${id} in ${rec.processingSec}s -> ${bundle.feedbackPath}`);
      } catch (err) {
        if (this.closed) return; // shutting down mid-job: leave it 'processing' so a restart resumes it
        rec.state = 'failed';
        rec.stage = 'failed';
        rec.error = String(err.message || err).slice(0, 2000);
        if (rec.delivery && rec.delivery.state === 'pending') rec.delivery = { state: 'failed', error: 'The recording failed to process.' };
        await this.save(rec);
        log(`processing ${id} failed: ${rec.error}`);
      }
      this.current = null;
      if (rec.state === 'ready' && rec.deliveryRequest) await this.deliver(rec).catch((e) => log('delivery error', e.message));
    }
  }

  /** Ask for delivery; sends now if ready, otherwise once processing finishes. */
  async requestSend(rec, target) {
    if (rec.state === 'failed') {
      const e = new Error(rec.error ? `The recording failed to process: ${rec.error}` : 'The recording failed to process.');
      e.code = 'recording_failed';
      e.status = 409;
      throw e;
    }
    rec.deliveryRequest = target;
    if (rec.state === 'processing') {
      rec.delivery = { state: 'pending', ...(target.threadId ? { threadId: target.threadId } : {}) };
      await this.save(rec);
      return { status: 202, delivery: rec.delivery };
    }
    await this.deliver(rec);
    return { status: 200, delivery: rec.delivery };
  }

  /** One delivery per recording at a time: an overlapping request joins the one in flight. */
  deliver(rec) {
    if (!this.delivering) this.delivering = new Map();
    const running = this.delivering.get(rec.id);
    if (running) return running;
    const p = this.deliverOnce(rec).finally(() => this.delivering.delete(rec.id));
    this.delivering.set(rec.id, p);
    return p;
  }

  async deliverOnce(rec) {
    const target = rec.deliveryRequest;
    if (!target) return;
    rec.delivery = { state: 'pending', ...(target.threadId ? { threadId: target.threadId } : {}), attemptAt: new Date().toISOString() };
    await this.save(rec);
    const result = await deliverBundle(this.t3, rec.dir, target);
    delete result.messagePath;
    rec.delivery = result;
    rec.deliveryRequest = null;
    await this.save(rec);
    log(`delivery for ${rec.id}: ${result.state}${result.threadId ? ' -> ' + result.threadId : ''}${result.error ? ' (' + result.error + ')' : ''}`);
  }

  /** API shape. */
  view(rec) {
    const status = rec.state === 'processing' ? readStatus(rec.dir) : null;
    const bundle = rec.state === 'ready' ? loadBundle(rec.dir) : null;
    let preview = '';
    if (bundle) {
      const text = bundle.transcript.phrases.map((p) => p.text).join(' ');
      preview = text ? (text.length > 280 ? text.slice(0, 277).trimEnd() + '...' : text) : bundle.transcript.audio.note || '';
    }
    const out = {
      id: rec.id,
      state: rec.state,
      ...(rec.state === 'processing' ? { stage: rec.stage === 'queued' ? 'queued' : (status && status.stage) || rec.stage } : {}),
      createdAt: rec.createdAt,
      durationSec: bundle ? bundle.durationSec : (rec.meta && Number(rec.meta.durationSec)) || null,
      bundlePath: rec.dir,
      feedbackPath: path.join(rec.dir, 'FEEDBACK.md'),
      frameCount: bundle ? bundle.frames.length : 0,
      transcriptPreview: preview,
    };
    if (status && typeof status.progress === 'number' && out.stage === 'transcoding') out.progress = status.progress;
    if (rec.error) out.error = rec.error;
    if (rec.delivery) {
      const { attemptAt, ...d } = rec.delivery;
      out.delivery = d;
    }
    return out;
  }

  async close() {
    this.closed = true;
  }
}
