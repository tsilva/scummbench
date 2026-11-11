import { createInterface } from 'node:readline';
const mode = process.argv[2];
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (JSON.stringify(message).includes('room_id') || JSON.stringify(message).includes('evaluator')) process.exit(7);
  if (mode === 'timeout') continue;
  if (mode === 'malformed') { process.stdout.write('not-json\n'); continue; }
  const decision = mode === 'finish' ? { type: 'finish' }
    : mode === 'observe' ? { type: 'observe' }
    : mode === 'load' ? { type: 'act', actions: [{ type: 'load', id: 1 }] }
    : mode === 'bad-input' ? { type: 'act', actions: [{ type: 'wait_ticks', ticks: -1 }] }
    : mode === 'overflow' ? { type: 'act', actions: [{ type: 'wait', ms: 1 }, { type: 'wait', ms: 1 }] }
    : { type: 'act', actions: [{ type: 'click', x: 1, y: 1 }] };
  process.stdout.write(JSON.stringify(decision) + '\n');
}
