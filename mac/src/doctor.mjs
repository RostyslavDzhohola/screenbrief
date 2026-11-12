// `screenbrief doctor`: pass/fail checks of everything the service depends on.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { run } from './util.mjs';
import { loadConfig, tools as toolPaths, paths } from './config.mjs';
import { lanAddress, localHostName } from './net.mjs';
import { projectsFromDb, threadsFromDb } from './t3.mjs';
import { plistPath } from './service.mjs';

function portState(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', (e) => resolve(e.code === 'EADDRINUSE' ? 'in-use' : `error: ${e.code}`));
    srv.listen(port, '0.0.0.0', () => srv.close(() => resolve('free')));
  });
}

async function health(port, token) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000) });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

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
  check(fs.existsSync('/opt/homebrew/bin/node'), 'node for launchd', '/opt/homebrew/bin/node');
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
  const t3v = await tryRun(t.t3, ['--version']);
  check(t3v.ok, 't3 CLI', t3v.ok ? `${t.t3} (${t3v.out.split('\n').pop()})` : `${t.t3}: ${t3v.out.slice(0, 200)}`);
  try {
    const projects = await projectsFromDb();
    const threads = await threadsFromDb(60);
    check(projects.length > 0, 'T3 discovery (read-only sqlite)', `${projects.length} projects, ${threads.length} recent threads`);
  } catch (e) {
    check(false, 'T3 discovery (read-only sqlite)', `${e.message}; will fall back to config.json projectPaths (${(cfg.projectPaths || []).length})`, 'WARN');
  }
  const qr = await tryRun(t.qrencode, ['--version']);
  check(qr.ok || /qrencode/i.test(qr.out), 'qrencode', t.qrencode, 'WARN');
  check(fs.existsSync('/usr/bin/dns-sd'), 'dns-sd (Bonjour)', '/usr/bin/dns-sd', 'WARN');
  const ip = lanAddress();
  check(!!ip, 'LAN address', ip ? `${ip}; Bonjour name ${localHostName()}.local` : 'no LAN IPv4 found');
  const ps = await portState(cfg.port);
  if (ps === 'free') check(true, `port ${cfg.port}`, 'free (service not running)');
  else {
    const h = await health(cfg.port, cfg.token);
    check(!!h, `port ${cfg.port}`, h ? `ScreenBrief is running (host ${h.host})` : `${ps} by another program`);
  }
  check(fs.existsSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'touch-detect.mjs')), 'touch detector', 'src/touch-detect.mjs (optional)', 'WARN');
  check(fs.existsSync(plistPath()), 'launchd service', fs.existsSync(plistPath()) ? plistPath() : 'not installed (run: screenbrief install-service)', 'WARN');
  check(!!cfg.token, 'config', paths().config);
  return failed ? 1 : 0;
}
