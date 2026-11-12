// T3 Code integration.
// Discovery (read-only): T3's own state database, ~/.t3/userdata/statev2.sqlite, opened
// with readOnly: true. Its projection tables are what the T3 server itself serves to the
// CLI (`t3 thread list` goes through the server's t3_project_list / t3_thread_list tools,
// and there is no `t3 project list` command). If the database can't be read or its
// schema changes, fall back to `t3 thread list --project <path> --json` for the project
// paths in config.json.
// Delivery: `t3 thread send <id> -` and `t3 thread start <path> - --title`, with the
// binary overridable through SCREENBRIEF_T3_BIN.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, mapLimit } from './util.mjs';

export function t3Home() {
  return process.env.T3CODE_HOME || path.join(os.homedir(), '.t3');
}

function dbPath() {
  return process.env.SCREENBRIEF_T3_DB || path.join(t3Home(), 'userdata', 'statev2.sqlite');
}

export function environmentId() {
  try {
    const v = fs.readFileSync(path.join(t3Home(), 'userdata', 'environment-id'), 'utf8').trim();
    return /^[0-9a-f-]{8,}$/i.test(v) ? v : null;
  } catch {
    return null;
  }
}

export function threadLink(threadId) {
  const env = environmentId();
  return env && threadId ? `https://app.t3.codes/threads/${env}/${threadId}` : undefined;
}

async function withDb(fn) {
  const file = dbPath();
  if (!fs.existsSync(file)) throw new Error(`T3 database not found at ${file}`);
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('PRAGMA query_only = ON');
    db.exec('PRAGMA busy_timeout = 2000');
    return fn(db);
  } finally {
    db.close();
  }
}

export async function projectsFromDb() {
  return withDb((db) =>
    db
      .prepare(
        `SELECT project_id, title, workspace_root FROM projection_projects
         WHERE deleted_at IS NULL AND archived_at IS NULL ORDER BY updated_at DESC`,
      )
      .all()
      .map((r) => ({ projectId: r.project_id, name: r.title, path: r.workspace_root })),
  );
}

export async function threadsFromDb(limit = 60) {
  return withDb((db) =>
    db
      .prepare(
        `SELECT t.thread_id, t.title, t.project_id, t.updated_at, p.title AS project_name, p.workspace_root
         FROM orchestration_v2_projection_threads t
         JOIN projection_projects p ON p.project_id = t.project_id
         WHERE t.deleted_at IS NULL AND t.archived_at IS NULL
           AND p.deleted_at IS NULL AND p.archived_at IS NULL
           AND COALESCE(json_extract(t.payload_json, '$.lineage.relationshipToParent'), '') <> 'subagent'
         ORDER BY t.updated_at DESC LIMIT ?`,
      )
      .all(limit)
      .map((r) => ({
        threadId: r.thread_id,
        title: r.title,
        projectId: r.project_id,
        projectName: r.project_name,
        projectPath: r.workspace_root,
        updatedAt: r.updated_at,
        link: threadLink(r.thread_id),
      })),
  );
}

export async function threadsFromCli(t3Bin, projectPaths, limit = 60) {
  const lists = await mapLimit(projectPaths, 3, async (p) => {
    try {
      const { stdout } = await run(t3Bin, ['thread', 'list', '--project', p, '--json'], { timeoutMs: 30_000, cwd: os.homedir() });
      const rows = JSON.parse(stdout);
      return (Array.isArray(rows) ? rows : []).map((r) => ({
        threadId: r.threadId,
        title: r.title,
        projectId: r.projectId,
        projectName: path.basename(p),
        projectPath: p,
        updatedAt: r.updatedAt,
        link: r.link || threadLink(r.threadId),
      }));
    } catch {
      return [];
    }
  });
  return lists
    .flat()
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, limit);
}

/** Discovery with a short cache (the CLI is slow to start; the db is cheap but not free). */
export class T3 {
  constructor({ t3Bin, projectPaths = [], cacheMs = 15_000 } = {}) {
    this.t3Bin = t3Bin;
    this.projectPaths = projectPaths;
    this.cacheMs = cacheMs;
    this.cache = new Map();
  }

  async cached(key, fn) {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.cacheMs) return hit.value;
    const value = await fn();
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  async projects() {
    return this.cached('projects', async () => {
      try {
        return { projects: await projectsFromDb(), source: 'sqlite' };
      } catch (err) {
        return {
          projects: this.projectPaths.map((p) => ({ projectId: p, name: path.basename(p), path: p })),
          source: 'config',
          warning: `T3 database unreadable (${err.message}); using config.json projectPaths`,
        };
      }
    });
  }

  async threads(limit = 60) {
    return this.cached(`threads:${limit}`, async () => {
      try {
        return { threads: await threadsFromDb(limit), source: 'sqlite' };
      } catch (err) {
        let paths = this.projectPaths;
        if (!paths.length) {
          try {
            paths = (await projectsFromDb()).map((p) => p.path).slice(0, 12);
          } catch {}
        }
        return { threads: await threadsFromCli(this.t3Bin, paths, limit), source: 'cli', warning: `T3 database unreadable (${err.message}); listed threads with the t3 CLI` };
      }
    });
  }

  invalidate() {
    this.cache.clear();
  }

  /** Send a message to an existing thread. */
  async send(threadId, message) {
    const { stdout } = await run(this.t3Bin, ['thread', 'send', threadId, '-', '--json'], { input: message, timeoutMs: 90_000, cwd: os.homedir() });
    const parsed = parseJsonOut(stdout);
    this.invalidate();
    return { threadId, link: threadLink(threadId), result: parsed };
  }

  /** Start a new thread in a project with the message as its first turn. */
  async start(projectPath, message, title) {
    const { stdout } = await run(this.t3Bin, ['thread', 'start', projectPath, '-', '--title', title, '--json'], { input: message, timeoutMs: 120_000, cwd: os.homedir() });
    const parsed = parseJsonOut(stdout);
    const threadId = parsed && (parsed.threadId || (parsed.thread && parsed.thread.threadId));
    if (!threadId) throw new Error(`t3 thread start returned no thread id: ${String(stdout).slice(0, 300)}`);
    this.invalidate();
    return { threadId, link: threadLink(threadId), result: parsed };
  }
}

function parseJsonOut(stdout) {
  const s = String(stdout || '').trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {}
  const lines = s.split('\n').reverse();
  for (const l of lines) {
    try {
      return JSON.parse(l);
    } catch {}
  }
  return { text: s.slice(0, 500) };
}
