// Disposable test-only supervisor: preserve the container network namespace
// while crashing and relaunching the real production broker entrypoint once.
import { spawn } from 'node:child_process';
import { writeFileSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const stateFile = process.argv[2] ?? '/data/topology-process.json';
let child, generation = 0, stopping = false, timer, previousExit = null;
function launch() {
  generation++;
  child = spawn(process.execPath, [fileURLToPath(new URL('../src/main.mjs', import.meta.url))], {
    env: process.env, stdio: 'inherit',
  });
  child.once('spawn', () => {
    writeFileSync(stateFile + '.next', JSON.stringify({ pid: child.pid, generation, previousExit }), { mode: 0o600 });
    renameSync(stateFile + '.next', stateFile);
  });
  child.once('error', () => { clearTimeout(timer); process.exit(1); });
  child.once('close', (code, signal) => {
    clearTimeout(timer);
    if (!stopping && generation === 1 && signal === 'SIGKILL') {
      previousExit = signal; launch();
    } else process.exit(stopping && code === 0 ? 0 : code || 1);
  });
}
function stop() {
  if (stopping) return;
  stopping = true;
  child.kill('SIGTERM');
  timer = setTimeout(() => child.kill('SIGKILL'), 5000);
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
launch();
