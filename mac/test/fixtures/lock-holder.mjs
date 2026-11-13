#!/usr/bin/env node
// Tries to take the watch lock, holds it for a while, and records that it got it.
import fs from 'node:fs';
import { withWatchLock } from '../../src/watch.mjs';

await withWatchLock(async () => {
  fs.appendFileSync(process.env.LOCK_LOG, `${process.pid}\n`);
  await new Promise((r) => setTimeout(r, 2500));
});
