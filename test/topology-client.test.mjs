import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { approvalTlsFixture } from './approval-tls-fixture.mjs';

test('topology probe uses real verified TLS and retains local mail on subprocess recreation', { timeout: 15000 }, async t => {
  const running = new Set();
  t.after(async () => { await Promise.all([...running].map(async child => { child.kill('SIGKILL'); await new Promise(done => child.once('close', done)); })); });
  const f = await approvalTlsFixture(t);
  async function configuration(type) {
    const directory = join(f.directory, type); mkdirSync(directory, { mode: 0o700 });
    const options = { brokerUrl: f.brokerUrl, directory: join(directory, 'credential'), clientType: type };
    const pending = await f.helper('beginApproval', options); await f.decide(pending.requestId);
    const approved = await f.helper('pollApproval', options);
    const file = join(directory, 'fixture.json');
    writeFileSync(file, JSON.stringify({ type, url: f.brokerUrl, token: join(approved.connectionFile, '..', 'token'), ca: f.certFile,
      data: join(directory, 'data') }), { mode: 0o600 }); return file;
  }
  async function launch(config) {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/topology-client.mjs', import.meta.url)), config],
      { env: { PATH: process.env.PATH }, stdio: ['pipe', 'pipe', 'pipe'] });
    running.add(child); let sequence = 0, error = '', readyResolve, readyReject;
    const pending = new Map(), ready = new Promise((yes, no) => { readyResolve = yes; readyReject = no; });
    const exited = new Promise(resolve => child.once('close', resolve));
    child.stderr.on('data', data => { error += data; });
    child.once('error', readyReject);
    child.once('close', code => { running.delete(child); readyReject(Error(error || `probe exit ${code}`)); for (const item of pending.values()) item.reject(Error(error)); });
    createInterface({ input: child.stdout }).on('line', line => {
      const frame = JSON.parse(line); if (frame.ready) { readyResolve(frame); return; }
      const item = pending.get(frame.id); if (!item) return; pending.delete(frame.id);
      if (frame.error) item.reject(Error(frame.error)); else item.resolve(frame.value);
    });
    const initial = await ready; assert.equal(initial.uid, process.getuid());
    const call = (command, args = {}) => new Promise((resolve, reject) => {
      const id = ++sequence; pending.set(id, { resolve, reject }); child.stdin.write(JSON.stringify({ id, command, args }) + '\n');
    });
    return { ...initial, call, async close() { await call('close'); child.stdin.end(); assert.equal(await exited, 0); } };
  }
  const sender = await launch(await configuration('pi')), config = await configuration('opencode');
  let receiver = await launch(config); const id = receiver.identity.client_id;
  const fresh = await sender.call('probe'); assert.ok(fresh.dns.address); assert.equal(fresh.https.status, 200);
  const first = await sender.call('send', { recipient: id, text: 'disposable pending message', key: 'same-operation' });
  assert.equal((await receiver.call('receive')).stored, true);
  const before = await receiver.call('observe', { message_id: first.message_id });
  assert.equal(before.state, 'pending'); assert.equal(before.native_receipt, null);
  await receiver.close();
  const offline = await sender.call('send', { recipient: id, text: 'disposable offline message', key: 'offline-operation' });
  assert.equal(offline.recipient_connected_at_acceptance, false);
  receiver = await launch(config); assert.equal(receiver.identity.client_id, id); assert.equal(receiver.epoch, 2);
  assert.deepEqual(await receiver.call('observe', { message_id: first.message_id }), before);
  assert.equal((await receiver.call('receive')).stored, true);
  assert.equal((await sender.call('status', { message_id: offline.message_id })).delivery_state, 'delivered');
  assert.equal((await sender.call('send', { recipient: id, text: 'disposable pending message', key: 'same-operation' })).message_id, first.message_id);
  await receiver.call('model', { id: 'after' });
  assert.equal((await receiver.call('list')).clients.find(row => row.client_id === id).model.id, 'after');
  assert.equal(await sender.call('observe', { message_id: first.message_id }), null);
  await Promise.all([sender.close(), receiver.close()]);
});
