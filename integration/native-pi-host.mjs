// Owned official Pi PTY transport shared by native integration probes.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
export async function startNative(control) {
  const controlFile = join(control.home, 'control.json');
  writeFileSync(controlFile, JSON.stringify(control), { mode: 0o600 });
  const child = spawn('python3', [fileURLToPath(new URL('./native-pi-presence-pty.py', import.meta.url)), controlFile],
    { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH } });
  let sequence = 0, stderr = '', resolveReady, rejectReady, ended = false, nativeReady = false, nativeExit;
  const pending = new Map();
  const ready = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });
  const closed = new Promise(res => child.once('close', res));
  const fail = error => {
    rejectReady(error);
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
  };
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-8192); });
  child.on('error', fail);
  child.stdin.on('error', fail);
  child.on('close', code => { ended = true; fail(Error(`Owned Pi PTY driver exited ${code}: ${stderr}`)); });
  createInterface({ input: child.stdout }).on('line', line => {
    let frame;
    try { frame = JSON.parse(line); } catch { fail(Error('Invalid owned Pi control frame')); if (nativeReady) child.kill(); return; }
    if (frame.ready) { nativeReady = true; resolveReady(frame.pid); return; }
    if (frame.exited) { nativeExit = frame.code; return; }
    const request = pending.get(frame.id);
    if (request) { clearTimeout(request.timer); pending.delete(frame.id); request.resolve(frame.value); }
  });
  const timer = setTimeout(() => fail(Error('Owned Pi PTY startup timeout')), 10000);
  let pid;
  try { pid = await ready; }
  catch (error) {
    // A failed readiness handshake still owns the Python/native processes.
    // Wait for its finally block before outer hooks can remove fixture storage.
    child.kill('SIGTERM');
    await closed;
    throw error;
  } finally { clearTimeout(timer); }
  const call = (operation, values = {}) => new Promise((resolve, reject) => {
    if (ended) { reject(Error('Owned Pi PTY driver is closed')); return; }
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`Owned Pi ${operation} timeout`)); child.kill(); }, 15000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, operation, ...values }) + '\n');
  });
  return { ...control, pid, call, get nativeExit() { return nativeExit; },
    async close() {
      if (ended) return;
      try { await call('close'); } finally { child.stdin.end(); await closed; }
    },
  };
}
