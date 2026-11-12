import fs from 'node:fs';
import crypto from 'node:crypto';
// LAN address, Bonjour name, pairing link and QR code.
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { run } from './util.mjs';

/** "Rostyslav-MacBook-Air" (the Bonjour .local name), falling back to os.hostname(). */
export function localHostName() {
  try {
    const v = execFileSync('/usr/sbin/scutil', ['--get', 'LocalHostName'], { encoding: 'utf8', timeout: 3000 }).trim();
    if (v) return v;
  } catch {}
  return os.hostname().replace(/\.local$/, '');
}

/** Current LAN IPv4, preferring en0/en1 (Wi-Fi/Ethernet) over VPN and bridge interfaces. */
export function lanAddress() {
  const ifs = os.networkInterfaces();
  const cands = [];
  for (const [name, addrs] of Object.entries(ifs)) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (/^(utun|awdl|llw|bridge|anpi|ap|gif|stf)/.test(name)) continue;
      if (a.address.startsWith('169.254.')) continue;
      const rank = /^en0$/.test(name) ? 0 : /^en\d+$/.test(name) ? 1 : 2;
      cands.push({ name, address: a.address, rank });
    }
  }
  cands.sort((a, b) => a.rank - b.rank);
  return cands[0] ? cands[0].address : null;
}

export function pairingInfo(cfg) {
  const host = localHostName();
  const url = `http://${host}.local:${cfg.port}`;
  const ip = lanAddress();
  const alt = ip ? `http://${ip}:${cfg.port}` : url;
  const link = `screenbrief://pair?url=${encodeURIComponent(url)}&alt=${encodeURIComponent(alt)}&token=${cfg.token}`;
  return { host, url, alt, ip, link, webUrl: `${alt}/?token=${cfg.token}` };
}

export async function qrTerminal(tools, text) {
  const { stdout } = await run(tools.qrencode, ['-t', 'UTF8', '-m', '2', text], { timeoutMs: 10_000 });
  return stdout;
}

export async function qrPng(tools, text, file) {
  await run(tools.qrencode, ['-o', file, '-s', '10', '-m', '3', text], { timeoutMs: 10_000 });
  return file;
}

// --- Tap-to-pair codes -------------------------------------------------------------------------
// A short-lived code stands in for the token in a link that can be pasted into a chat: the page
// at /pair/<code> hands the phone the real pairing link. Codes live in a small file so the CLI
// can mint one while the service (another process) is running.
const PAIR_CODE_TTL_MS = 30 * 60 * 1000;
const PAIR_CODE_MAX_USES = 10;

function readPairCodes(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(j.codes) ? j.codes : [];
  } catch {
    return [];
  }
}

function writePairCodes(file, codes) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ codes }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function createPairCode(file, now = Date.now(), ttlMs = PAIR_CODE_TTL_MS) {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(10);
  let code = '';
  for (const b of bytes) code += alphabet[b % alphabet.length];
  const codes = readPairCodes(file).filter((c) => c.expiresAt > now);
  codes.push({ code, expiresAt: now + ttlMs, uses: 0 });
  writePairCodes(file, codes);
  return { code, expiresAt: now + ttlMs };
}

/** True once per use while the code is valid; counts the use. */
export function redeemPairCode(file, code, now = Date.now()) {
  if (typeof code !== 'string' || !/^[a-z0-9]{6,32}$/.test(code)) return false;
  const codes = readPairCodes(file);
  let ok = false;
  for (const c of codes) {
    if (typeof c.code !== 'string' || c.code.length !== code.length) continue;
    if (!crypto.timingSafeEqual(Buffer.from(c.code), Buffer.from(code))) continue;
    if (c.expiresAt > now && (c.uses || 0) < PAIR_CODE_MAX_USES) {
      c.uses = (c.uses || 0) + 1;
      ok = true;
    }
  }
  if (ok) writePairCodes(file, codes.filter((c) => c.expiresAt > now));
  return ok;
}
