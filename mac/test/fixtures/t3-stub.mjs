#!/usr/bin/env node
// Stand-in for the t3 CLI in tests: records argv and stdin, never talks to T3.
// T3_STUB_LOG: JSONL file to append to. T3_STUB_FAIL=1: exit 1 like a failed send.
import fs from 'node:fs';

const argv = process.argv.slice(2);
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const stdin = Buffer.concat(chunks).toString('utf8');
  if (process.env.T3_STUB_LOG) fs.appendFileSync(process.env.T3_STUB_LOG, JSON.stringify({ argv, stdin, at: new Date().toISOString() }) + '\n');
  if (process.env.T3_STUB_FAIL === '1') {
    process.stderr.write('stub: simulated failure\n');
    process.exit(1);
  }
  const [group, cmd] = argv;
  if (group === 'thread' && cmd === 'send') {
    console.log(JSON.stringify({ threadId: argv[2], runId: 'run:stub:1', delivery: 'queued' }));
  } else if (group === 'thread' && cmd === 'start') {
    console.log(JSON.stringify({ threadId: 'stub-new-thread-0001', runId: 'run:stub:2' }));
  } else if (group === 'thread' && cmd === 'list') {
    console.log(JSON.stringify([{ threadId: 'stub-listed-thread', projectId: 'p1', title: 'Stub thread', updatedAt: '2026-01-01T00:00:00.000Z' }]));
  } else if (argv[0] === '--version') {
    console.log('t3-stub 0.0.0');
  } else {
    console.log('{}');
  }
});
