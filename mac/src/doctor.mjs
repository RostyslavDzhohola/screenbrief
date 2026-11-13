// `screenbrief doctor`: pass/fail checks of everything `screenbrief pull` depends on.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { run } from './util.mjs';
import { loadConfig, tools as toolPaths, paths } from './config.mjs';
import { attachmentsDir, APP_BUNDLE_ID } from './pull.mjs';

export async function doctor() {
  const cfg = loadConfig();
  const t = toolPaths(cfg);
  const lines = [];
  let failed = 0;
  const check = (ok, name, detail, level = 'FAIL') => {
    const tag = ok ? 'PASS' : level;
    if (!ok && level === 'FAIL') failed++;
    lines.push(`${tag.padEnd(4)}  ${name}${detail ? ': ' + detail : ''}`);
    console.log(lines[lines.length - 1]);
  };
  const tryRun = async (cmd, args) => {
    try {
      const r = await run(cmd, args, { timeoutMs: 15_000, allowFail: true });
      return { ok: r.code === 0, out: (r.stdout + r.stderr).trim() };
    } catch (e) {
      return { ok: false, out: e.message };
    }
  };

  check(Number(process.versions.node.split('.')[0]) >= 22, 'node', `${process.version} at ${process.execPath}`);
  const ff = await tryRun(t.ffmpeg, ['-hide_banner', '-version']);
  check(ff.ok, 'ffmpeg', ff.ok ? `${t.ffmpeg} (${ff.out.split('\n')[0].split(' ').slice(0, 3).join(' ')})` : ff.out);
  const fp = await tryRun(t.ffprobe, ['-hide_banner', '-version']);
  check(fp.ok, 'ffprobe', fp.ok ? t.ffprobe : fp.out);
  const vt = ff.ok ? await tryRun(t.ffmpeg, ['-hide_banner', '-encoders']) : { ok: false, out: '' };
  check(/h264_videotoolbox/.test(vt.out), 'hardware H.264 encoder', /h264_videotoolbox/.test(vt.out) ? 'h264_videotoolbox' : 'not available; will use libx264', 'WARN');
  const wh = await tryRun(t.whisper, ['--help']);
  check(wh.ok || /usage/i.test(wh.out), 'whisper-cli', t.whisper);
  let modelOk = false;
  let modelDetail = t.model;
  try {
    const st = fs.statSync(t.model);
    const flags = execFileSync('/bin/ls', ['-lO', t.model], { encoding: 'utf8' });
    modelOk = st.size > 50 * 1024 * 1024 && !/dataless/.test(flags);
    modelDetail = `${t.model} (${Math.round(st.size / 1048576)} MB${/dataless/.test(flags) ? ', iCloud placeholder: not downloaded' : ''})`;
  } catch {
    modelDetail = `${t.model} missing`;
  }
  check(modelOk, 'whisper model', modelDetail);
  const dc = await tryRun('/usr/bin/xcrun', ['devicectl', '--version']);
  check(dc.ok, 'devicectl (copies recordings from the iPhone)', dc.ok ? `Xcode's devicectl ${dc.out.split('\n').pop()}; app ${APP_BUNDLE_ID}` : 'not available: install Xcode. Attached videos still work.', 'WARN');
  const att = attachmentsDir();
  check(fs.existsSync(att), 'T3 Code attachments folder', fs.existsSync(att) ? att : `${att} missing: videos attached in T3 Code will not be found`, 'WARN');
  check(fs.existsSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'touch-detect.mjs')), 'touch detector', 'src/touch-detect.mjs (optional)', 'WARN');
  const store = canStore(paths().recordings);
  check(store.ok, 'bundles folder', store.ok ? paths().recordings : `${paths().recordings}: ${store.why}`);
  return failed ? 1 : 0;
}

/** Whether `dir` can hold bundles: it is a writable folder, or its nearest existing parent is. */
export function canStore(dir) {
  let at = path.resolve(dir);
  for (;;) {
    let st = null;
    try {
      st = fs.statSync(at);
    } catch {
      /* not there yet: look at the parent */
    }
    if (st) {
      if (!st.isDirectory()) return { ok: false, why: `${at} is a file, not a folder` };
      try {
        fs.accessSync(at, fs.constants.W_OK | fs.constants.X_OK);
        return { ok: true };
      } catch {
        return { ok: false, why: `${at} cannot be written to` };
      }
    }
    const up = path.dirname(at);
    if (up === at) return { ok: false, why: 'no existing parent folder' };
    at = up;
  }
}
