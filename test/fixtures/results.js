import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { digest } from '../../src/contracts.js';

export const fixtureTime = seconds => `2026-11-11T10:00:${String(seconds).padStart(2, '0')}.000Z`;
export const fixtureProgress = (percent, won = false, revision = 'a'.repeat(64)) => ({
  state: 'tracked', game: 'flight-of-the-amazon-queen', percent, won,
  total: 2, completed: percent / 50, map_revision: revision,
});

export async function writeInteractive(root, { id = '11111111-1111-4111-8111-111111111111', active = false, won = true } = {}) {
  const directory = path.join(root, id);
  await mkdir(directory, { recursive: true });
  const rows = [
    { timestamp: fixtureTime(0), session_id: 'test-session', progress: fixtureProgress(0) },
    { timestamp: fixtureTime(2), session_id: 'test-session', progress: fixtureProgress(50) },
    ...(won ? [{ timestamp: fixtureTime(4), session_id: 'test-session', progress: fixtureProgress(100, true) }] : []),
  ];
  const content = rows.map(row => JSON.stringify(row)).join('\n') + '\n';
  await writeFile(path.join(directory, 'progress.jsonl'), content);
  const events = [{ timestamp: fixtureTime(0), type: 'mcp_request', params: { name: 'session', arguments: { operation: 'start', mode: 'beginning' } } },
    ...[1, 3, 5].map(second => ({ timestamp: fixtureTime(second), type: 'mcp_request', params: { name: 'act', arguments: { actions: [{ type: 'click', x: 1, y: 1 }] } } }))];
  await writeFile(path.join(directory, 'trajectory.jsonl'), events.map(row => JSON.stringify(row)).join('\n') + '\n');
  const manifest = { schema_version: 1, kind: 'interactive_mcp', run_id: id, game_id: 'flight-of-the-amazon-queen',
    status: active ? 'in_progress' : 'stopped', started_at: fixtureTime(0), ...(active ? {} : { finished_at: fixtureTime(6) }),
    track: 'unspecified', usage: { submitted_actions: 3 }, mechanics_session_id: 'test-session',
    scummbench: { commit_id: 'b'.repeat(40), dirty: false }, scummweb: { commit_id: 'c'.repeat(40), dirty: false },
    progress_capture: { state: 'available', sha256: digest(content) }, private_token: 'never-public-fixture-value' };
  await writeFile(path.join(directory, 'run.json'), JSON.stringify(manifest));
  return { directory, manifest, rows, events };
}
