import { readFile, realpath, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { digest } from './contracts.js';

// Capture only the private, native progress channel. Nothing is added to MCP
// observations, and no game or agent process is launched by the results reader.
export function runtimeDescriptor(result, game, allowedRoot) {
  for (const block of result?.content ?? []) {
    if (block.type !== 'text') continue;
    let value; try { value = JSON.parse(block.text); } catch { continue; }
    if (value.game !== game || !/^[A-Za-z0-9_-]{1,128}$/.test(value.sessionId ?? '')
      || typeof value.dataDir !== 'string' || !path.isAbsolute(value.dataDir)) continue;
    const directory = path.resolve(value.dataDir), root = path.resolve(allowedRoot);
    if (directory !== root && !directory.startsWith(root + path.sep)) continue;
    return { directory, allowed_root: root, session_id: value.sessionId };
  }
  return null;
}

export async function captureProgress(directory, descriptor) {
  if (!descriptor) return { state: 'unavailable', reason: 'native_progress_not_recorded' };
  try {
    const root = await realpath(descriptor.allowed_root);
    const file = await realpath(path.join(descriptor.directory, 'runs', `${descriptor.session_id}.jsonl`));
    if (!file.startsWith(root + path.sep)) throw new Error('Outside native store');
    if ((await stat(file)).size > 64 * 1024 * 1024) throw new Error('Native journal exceeds capture limit');
    const rows = [];
    for (const line of (await readFile(file, 'utf8')).split('\n').filter(Boolean)) {
      const event = JSON.parse(line);
      if (event.type !== 'progress' || !event.progress) continue;
      if (event.sessionId !== descriptor.session_id) throw new Error('Native session mismatch');
      const p = event.progress;
      rows.push({ timestamp: event.timestamp, session_id: descriptor.session_id,
        progress: { state: p.state, game: p.game, percent: p.percent, won: p.won,
          total: p.total, completed: p.completed, map_revision: p.map_revision } });
    }
    if (!rows.length) return { state: 'unavailable', reason: 'native_progress_not_recorded' };
    const content = rows.map(row => JSON.stringify(row)).join('\n') + '\n';
    await writeFile(path.join(directory, 'progress.jsonl'), content, { flag: 'wx', mode: 0o600 });
    return { state: 'available', sha256: digest(content) };
  } catch { return { state: 'unavailable', reason: 'native_progress_capture_unavailable' }; }
}
