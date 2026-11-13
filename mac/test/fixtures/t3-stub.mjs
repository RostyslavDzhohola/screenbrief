#!/usr/bin/env node
// Stands in for the `t3` CLI in tests: appends its arguments and stdin to T3_STUB_LOG.
import fs from 'node:fs';

let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  fs.appendFileSync(process.env.T3_STUB_LOG, JSON.stringify({ argv: process.argv.slice(2), input }) + '\n');
  process.exit(process.env.T3_STUB_FAIL === '1' ? 1 : 0);
});
