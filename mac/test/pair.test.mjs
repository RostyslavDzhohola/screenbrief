// Tap-to-pair codes: minted by the CLI side, redeemed by the service at /pair/<code>.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPairCode, redeemPairCode } from '../src/net.mjs';

test('pair codes: valid within 30 minutes, limited uses, unknown and malformed rejected', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-pair-'));
  const file = path.join(dir, 'pair-codes.json');
  const t0 = 1_000_000;
  const { code } = createPairCode(file, t0);
  assert.match(code, /^[a-z0-9]{10}$/);
  assert.equal(redeemPairCode(file, code, t0 + 1000), true);
  assert.equal(redeemPairCode(file, 'zzzzzzzzzz', t0 + 1000), false);
  assert.equal(redeemPairCode(file, '../../etc/passwd', t0 + 1000), false);
  assert.equal(redeemPairCode(file, undefined, t0 + 1000), false);
  assert.equal(redeemPairCode(file, code, t0 + 31 * 60 * 1000), false, 'expired');
  const second = createPairCode(file, t0).code;
  for (let i = 0; i < 10; i++) assert.equal(redeemPairCode(file, second, t0 + 5), true);
  assert.equal(redeemPairCode(file, second, t0 + 5), false, 'used up');
  assert.equal(fs.statSync(file).mode & 0o077, 0, 'codes file is private');
  fs.rmSync(dir, { recursive: true, force: true });
});
