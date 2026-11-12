// LaunchAgent install/uninstall. The plist runs /opt/homebrew/bin/node by absolute path
// (launchd's PATH has no Homebrew, so the #!/usr/bin/env node shebang would fail).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, BIN_PATH_PREFIX } from './util.mjs';
import { SERVICE_LABEL, CLI_PATH, PACKAGE_DIR, paths, tools } from './config.mjs';

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function plistPath() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
}

export function plistXml() {
  const p = paths();
  const node = tools().node;
  const env = { PATH: BIN_PATH_PREFIX, HOME: os.homedir() };
  if (process.env.SCREENBRIEF_HOME) env.SCREENBRIEF_HOME = p.home;
  const envXml = Object.entries(env).map(([k, v]) => `      <key>${xml(k)}</key>\n      <string>${xml(v)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${SERVICE_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${xml(node)}</string>
      <string>${xml(CLI_PATH)}</string>
      <string>serve</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${xml(PACKAGE_DIR)}</string>
    <key>EnvironmentVariables</key>
    <dict>
${envXml}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>ProcessType</key>
    <string>Interactive</string>
    <key>StandardOutPath</key>
    <string>${xml(path.join(p.logs, 'screenbrief.out.log'))}</string>
    <key>StandardErrorPath</key>
    <string>${xml(path.join(p.logs, 'screenbrief.err.log'))}</string>
  </dict>
</plist>
`;
}

const domain = () => `gui/${process.getuid()}`;

export async function installService({ dryRun = false } = {}) {
  const file = plistPath();
  const body = plistXml();
  if (dryRun) return { file, body, dryRun: true };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(paths().logs, { recursive: true });
  await run('/bin/launchctl', ['bootout', `${domain()}/${SERVICE_LABEL}`], { allowFail: true, timeoutMs: 20_000 });
  fs.writeFileSync(file, body);
  await run('/usr/bin/plutil', ['-lint', file], { timeoutMs: 10_000 });
  await run('/bin/launchctl', ['bootstrap', domain(), file], { timeoutMs: 20_000 });
  await run('/bin/launchctl', ['enable', `${domain()}/${SERVICE_LABEL}`], { allowFail: true, timeoutMs: 10_000 });
  return { file, body };
}

export async function uninstallService() {
  const file = plistPath();
  const r = await run('/bin/launchctl', ['bootout', `${domain()}/${SERVICE_LABEL}`], { allowFail: true, timeoutMs: 20_000 });
  const existed = fs.existsSync(file);
  if (existed) fs.rmSync(file);
  return { file, removed: existed, bootout: r.code === 0 };
}
