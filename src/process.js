import { spawn } from 'node:child_process';

export class TimeoutError extends Error {}
export class ProtocolError extends Error {}

export function cleanEnv() {
  return Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'LANG', 'DISPLAY',
    'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
}

// Each child owns a process group on Unix. Cleanup is scoped to that group,
// including browser/model-runner descendants; unrelated instances are untouched.
export class LineProcess {
  constructor(command, args = [], { cwd, maxBytes = 24 * 1024 * 1024, maxQueue = 256 } = {}) {
    this.buffer = ''; this.lines = []; this.waiters = []; this.maxBytes = maxBytes; this.maxQueue = maxQueue;
    this.child = spawn(command, args, { cwd, env: cleanEnv(), detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    this.closed = new Promise(resolve => { this.resolveClosed = resolve; });
    this.child.stderr.resume(); // Never persist potentially credential-bearing diagnostics.
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => {
      if (this.error) return;
      this.buffer += chunk;
      if (Buffer.byteLength(this.buffer) > this.maxBytes) return this.fail(new ProtocolError('Process output exceeds line limit'));
      let index;
      while ((index = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, index).replace(/\r$/, '');
        this.buffer = this.buffer.slice(index + 1);
        if (!line) continue;
        if (this.waiters.length) this.waiters.shift().resolve(line);
        else this.lines.push(line);
        if (this.lines.length > this.maxQueue) return this.fail(new ProtocolError('Unsolicited process output exceeds queue limit'));
      }
    });
    this.child.once('error', () => this.fail(new Error('Unable to start process')));
    this.child.stdin.on('error', () => this.fail(new Error('Process input closed')));
    this.child.once('close', (code, signal) => {
      this.exitCode = code; this.exitSignal = signal;
      this.fail(new Error(`Process closed (${code ?? signal})`)); this.resolveClosed();
    });
  }
  fail(error) {
    this.error ??= error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(this.error);
  }
  send(value) {
    if (this.error) throw this.error;
    this.child.stdin.write(JSON.stringify(value) + '\n');
  }
  line(timeoutMs = 60000) {
    if (this.lines.length) return Promise.resolve(this.lines.shift());
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => {
      const waiter = { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter(item => item !== waiter);
        reject(new TimeoutError('Process response timed out'));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }
  async close() {
    const kill = signal => {
      try {
        if (process.platform !== 'win32' && this.child.pid) process.kill(-this.child.pid, signal);
        else this.child.kill(signal);
      } catch (error) { if (error.code !== 'ESRCH') throw error; }
    };
    this.fail(new Error('Process closed by runner'));
    kill('SIGTERM');
    let timer;
    await Promise.race([this.closed, new Promise(resolve => { timer = setTimeout(resolve, 2000); })]);
    clearTimeout(timer);
    kill('SIGKILL'); // Also reap descendants if the group leader exited first.
    await this.closed;
  }
}

// Minimal MCP stdio client: newline-delimited JSON-RPC, no HTTP transport or
// server-initiated sampling. Methods are serialized by the benchmark runner.
export class McpClient {
  constructor(command, args, options) { this.process = new LineProcess(command, args, options); this.id = 0; }
  async request(method, params = {}, timeoutMs = 60000) {
    const id = ++this.id;
    this.process.send({ jsonrpc: '2.0', id, method, params });
    for (;;) {
      const message = JSON.parse(await this.process.line(timeoutMs));
      if (message.method) {
        if (message.id !== undefined) this.process.send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Server requests are not supported' } });
        continue;
      }
      if (message.id !== id) throw new ProtocolError('Unexpected MCP response ID');
      if (message.error) throw new Error(`MCP ${method} failed`);
      return message.result;
    }
  }
  async connect() {
    const result = await this.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'scummbench', version: '0.1.0-dev.0' } });
    if (!['2024-11-05', '2025-03-26', '2025-06-18'].includes(result.protocolVersion)) throw new Error('Unsupported MCP protocol version');
    this.process.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return result;
  }
  call(name, args = {}) { return this.request('tools/call', { name, arguments: args }); }
  close() { return this.process.close(); }
}

export function textResult(result) {
  if (result?.isError) throw new Error('AgentSCUMM tool failed; inspect the private runtime artifacts');
  const block = result?.content?.find(item => item.type === 'text');
  if (!block) throw new Error('Missing MCP text result');
  return JSON.parse(block.text);
}
