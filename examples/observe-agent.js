// Protocol demonstration only: observes once, then stops. No model or puzzle
// logic; its expected outcome on the real game is failure/agent_stopped.
import { createInterface } from 'node:readline';
let messages = 0;
for await (const line of createInterface({ input: process.stdin })) {
  JSON.parse(line);
  process.stdout.write(JSON.stringify({ type: ++messages === 1 ? 'observe' : 'finish' }) + '\n');
}
