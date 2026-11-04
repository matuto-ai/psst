import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { credential } from './helpers.mjs';

test('topology supervisor reaps SIGKILL and restarts the actual broker once, then forwards graceful shutdown', { timeout: 10000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'psst-topology-supervisor-'));
  const stateFile = join(directory, 'process.json'), config = join(directory, 'config.json');
  const reserve = createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = reserve.address().port; await new Promise(done => reserve.close(done));
  const credentials = join(directory, 'credentials.json');
  writeFileSync(credentials, JSON.stringify({ credentials: [credential('topology-supervisor').entry] }), { mode: 0o600 });
  writeFileSync(config, JSON.stringify({ database: join(directory, 'broker.sqlite'), credential_file: credentials,
    host: '127.0.0.1', port, insecure_development: true }), { mode: 0o600 });
  const owner = spawn(process.execPath, [fileURLToPath(new URL('../scripts/topology-broker-supervisor.mjs', import.meta.url)), stateFile],
    { env: { PATH: process.env.PATH, BROKER_CONFIG_FILE: config }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let output = ''; for (const stream of [owner.stdout, owner.stderr]) stream.on('data', bytes => { output = (output + bytes).slice(-4096); });
  const closed = new Promise((resolve, reject) => { owner.once('error', reject); owner.once('close', resolve); });
  t.after(async () => {
    if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGTERM');
    const timer = setTimeout(() => { try { process.kill(-owner.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }, 1000);
    try { await closed; } finally { clearTimeout(timer); rmSync(directory, { recursive: true, force: true }); }
  });
  async function ready(generation) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      assert.equal(owner.exitCode, null, output);
      try {
        const state = JSON.parse(readFileSync(stateFile));
        if (state.generation === generation && (await fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(150) })).status === 200) return state;
      } catch {}
      await delay(20);
    }
    assert.fail(`broker generation ${generation} not ready: ${output}`);
  }
  const before = await ready(1); assert.equal(before.previousExit, null);
  process.kill(before.pid, 'SIGKILL');
  const after = await ready(2);
  assert.notEqual(after.pid, before.pid); assert.equal(after.previousExit, 'SIGKILL');
  assert.throws(() => process.kill(before.pid, 0), { code: 'ESRCH' }, 'old broker process is reaped');
  owner.kill('SIGTERM'); assert.equal(await closed, 0);
  assert.throws(() => process.kill(after.pid, 0), { code: 'ESRCH' }, 'new broker process exits with its supervisor');
});
