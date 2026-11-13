#!/usr/bin/env node
// Stands in for `xcrun devicectl` in tests. DEVICECTL_STUB_PHONE is a folder that plays the
// app's Documents/Recordings; DEVICECTL_STUB_MODE picks what goes wrong:
//   short-copy     the movie arrives cut off
//   sidecar-fails  copying <id>.json fails
//   bad-sidecar    <id>.json arrives as broken JSON
//   no-sidecar     the listing shows no <id>.json (the app has not finished its copy)
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const phone = process.env.DEVICECTL_STUB_PHONE;
const mode = process.env.DEVICECTL_STUB_MODE || 'ok';
const after = (flag) => args[args.indexOf(flag) + 1];
const reply = (json) => fs.writeFileSync(after('--json-output'), JSON.stringify(json));

if (args[0] === 'list') {
  reply({ result: { devices: [{ identifier: 'STUB', hardwareProperties: { deviceType: 'iPhone', marketingName: 'iPhone' }, deviceProperties: { name: 'Test phone' }, connectionProperties: { tunnelState: 'connected' } }] } });
} else if (args[1] === 'info') {
  const names = fs.readdirSync(phone).filter((n) => !(mode === 'no-sidecar' && n.endsWith('.json')));
  reply({ result: { files: names.map((n) => ({ name: n, relativePath: `Documents/Recordings/${n}` })) } });
} else if (args[1] === 'copy') {
  const name = path.basename(after('--source'));
  const data = fs.readFileSync(path.join(phone, name));
  if (name.endsWith('.json')) {
    if (mode === 'sidecar-fails') {
      console.error('ERROR: The operation couldn’t be completed.');
      process.exit(1);
    }
    fs.writeFileSync(after('--destination'), mode === 'bad-sidecar' ? '{"id": ' : data);
  } else {
    fs.writeFileSync(after('--destination'), mode === 'short-copy' ? data.subarray(0, Math.floor(data.length / 2)) : data);
  }
} else {
  process.exit(64);
}
