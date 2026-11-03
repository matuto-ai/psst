// Real prior/current broker processes and SQLite journals. No native host/model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { Inbox } from '../reference/inbox.mjs';
import { backupDatabase } from '../scripts/backup.mjs';
import { credential, registration, sendBody, uuid } from '../test/helpers.mjs';

const previous = process.env.PSST_PREVIOUS_BROKER_SOURCE && resolve(process.env.PSST_PREVIOUS_BROKER_SOURCE);
if (!previous) throw Error('PSST_PREVIOUS_BROKER_SOURCE must name the pinned prior broker checkout');
const priorRevision = 'bd2dd445de4bf3105f20caafb471f280bf981b63';
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: previous, encoding: 'utf8' }).trim(), priorRevision);
const current = fileURLToPath(new URL('..', import.meta.url));
const types = ['pi', 'antigravity-cli', 'claude-code', 'opencode'];

test('real prior release upgrades and restores pending mail, epochs, receipts, dedupe and four local journals', { timeout: 45000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'psst-upgrade-recovery-'));
  const auth = credential('upgrade-fixture'), authFile = join(directory, 'credentials.json');
  const original = join(directory, 'original'), backup = join(directory, 'snapshot');
  mkdirSync(original, { mode: 0o700 }); mkdirSync(backup, { mode: 0o700 });
  writeFileSync(authFile, JSON.stringify({ credentials: [auth.entry] }), { mode: 0o600 });
  const reserve = createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = reserve.address().port; await new Promise(done => reserve.close(done));
  const base = `http://127.0.0.1:${port}`;
  let child, childClosed, output = '', phase = 'prior';
  const journals = [];
  async function stop(signal = 'SIGTERM') {
    if (!child) return;
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    const kill = setTimeout(() => child.kill('SIGKILL'), 5000);
    try { await childClosed; } finally { clearTimeout(kill); }
  }
  t.after(async () => { await stop(); for (const inbox of journals) inbox.close(); rmSync(directory, { recursive: true, force: true }); });
  async function start(root, database) {
    const config = join(directory, `config-${phase}.json`);
    writeFileSync(config, JSON.stringify({ database, credential_file: authFile, host: '127.0.0.1', port,
      insecure_development: true }), { mode: 0o600 });
    output = '';
    child = spawn(process.execPath, [join(root, 'src/main.mjs')], {
      env: { PATH: process.env.PATH, BROKER_CONFIG_FILE: config }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    childClosed = new Promise((done, reject) => { child.once('error', reject); child.once('close', done); });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', b => { output = (output + b).slice(-8192); });
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      assert.equal(child.exitCode, null, `${phase} broker exited: ${output}`);
      try { if ((await fetch(base + '/readyz', { signal: AbortSignal.timeout(200) })).status === 200) return; } catch {}
      await delay(20);
    }
    assert.fail(`${phase} broker readiness timeout: ${output}`);
  }
  async function request(path, { method = 'GET', body, client, epoch = 1, key } = {}) {
    const response = await fetch(base + path, { method, headers: { Authorization: `Bearer ${auth.token}`,
      ...(client ? { 'X-Client-ID': client.client_id, 'X-Lease-Epoch': String(epoch) } : {}),
      ...(key ? { 'Idempotency-Key': key } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(3000) });
    return { status: response.status, body: response.status === 204 ? null : await response.json() };
  }
  function journal(root, session) {
    const inbox = new Inbox({ directory: root, identity: { client_id: session.client_id,
      session_instance_id: session.session_instance_id, client_type: session.client_type } });
    journals.push(inbox); return inbox;
  }
  const sender = registration('pi'), peers = types.map(type => ({ session: registration(type), rows: [] }));
  const outgoing = journal(join(original, 'outgoing'), sender);
  await start(previous, join(original, 'broker.sqlite'));
  for (const session of [sender, ...peers.map(p => p.session)]) {
    const registered = await request('/v1/sessions', { method: 'POST', body: session });
    assert.equal(registered.status, 200); assert.equal(registered.body.lease_epoch, 1);
  }
  for (const peer of peers) {
    peer.inbox = journal(join(original, peer.session.client_type), peer.session);
    for (const kind of ['consumed', 'injecting', 'pending', 'claimed', 'queued']) {
      const body = sendBody(peer.session.client_id, `disposable ${peer.session.client_type} ${kind}`);
      const key = outgoing.prepareSend(body, { key: `${peer.session.client_type}-${kind}` });
      outgoing.markOutgoingAttempt(key);
      const sent = await request('/v1/messages', { method: 'POST', client: sender, key, body });
      assert.equal(sent.status, 202);
      // A lost send response is deliberately retained as unknown in the sender journal.
      if (kind !== 'queued') outgoing.recordSendResult(key, sent.body);
      const row = { kind, key, body, sent: sent.body };
      peer.rows.push(row);
      if (kind === 'queued') continue;
      const claim = await request('/v1/mailbox/claim', { method: 'POST', client: peer.session, key: `claim-${kind}`, body: {} });
      assert.equal(claim.status, 200); assert.equal(claim.body.envelope.message_id, sent.body.message_id);
      row.claim = claim.body;
      if (kind === 'claimed') continue; // Unconfirmed final transport hop at broker crash.
      peer.inbox.accept(claim.body.envelope);
      const complete = await request(`/v1/mailbox/${sent.body.message_id}/complete`, { method: 'POST', client: peer.session,
        body: { claim_id: claim.body.claim_id, outcome: 'delivered' } });
      assert.equal(complete.body.delivery_state, 'delivered');
      if (kind === 'consumed') {
        const injection = peer.inbox.beginInjection(sent.body.message_id);
        peer.inbox.recordNativeAcceptance(sent.body.message_id, injection, { accepted: true, receipt_id: 'fixture-not-a-native-host' });
      } else if (kind === 'injecting') peer.inbox.beginInjection(sent.body.message_id);
    }
  }
  const priorDb = new DatabaseSync(join(original, 'broker.sqlite'), { readOnly: true });
  const oldSchema = priorDb.prepare('PRAGMA user_version').get().user_version;
  priorDb.close(); assert.equal(oldSchema, 2, 'actual pinned prior entrypoint creates the expected old schema');
  // Snapshot every actual live SQLite WAL through the supported API, never raw-copy WAL files.
  await backupDatabase(join(original, 'broker.sqlite'), join(backup, 'broker.sqlite'));
  for (const [name, inbox] of [['outgoing', outgoing], ...peers.map(p => [p.session.client_type, p.inbox])]) {
    await backupDatabase(join(inbox.directory, 'inbox.sqlite'), join(backup, `${name}.sqlite`));
  }
  await stop('SIGKILL'); for (const inbox of journals) inbox.close();

  for (phase of ['upgrade-original', 'restore-snapshot']) {
    const root = phase === 'upgrade-original' ? original : join(directory, 'restored');
    if (phase === 'restore-snapshot') {
      mkdirSync(root, { mode: 0o700 });
      copyFileSync(join(backup, 'broker.sqlite'), join(root, 'broker.sqlite'));
      for (const name of ['outgoing', ...types]) {
        mkdirSync(join(root, name), { mode: 0o700 });
        copyFileSync(join(backup, `${name}.sqlite`), join(root, name, 'inbox.sqlite'));
      }
    }
    await start(current, join(root, 'broker.sqlite'));
    const upgraded = new DatabaseSync(join(root, 'broker.sqlite'), { readOnly: true });
    assert.equal(upgraded.prepare('PRAGMA user_version').get().user_version, 5); upgraded.close();
    const migration = readdirSync(root).filter(name => name.startsWith('before-approval-'));
    assert.equal(migration.length, 1);
    const preserved = new DatabaseSync(join(root, migration[0], 'broker.sqlite'), { readOnly: true });
    assert.equal(preserved.prepare('PRAGMA user_version').get().user_version, 2); preserved.close();
    assert.equal((await request(`/v1/sessions/${sender.client_id}/heartbeat`, { method: 'POST', client: sender, body: {} })).body.error.code, 'stale_lease_epoch');
    for (const session of [sender, ...peers.map(p => p.session)]) {
      assert.equal((await request(`/v1/sessions/${session.client_id}`)).body.connected, false);
      const registered = await request('/v1/sessions', { method: 'POST', body: { ...session, previous_epoch: 1, connection_id: uuid() } });
      assert.equal(registered.body.lease_epoch, 2);
    }
    const senderInbox = journal(join(root, 'outgoing'), sender);
    for (const peer of peers) {
      const inbox = journal(join(root, peer.session.client_type), peer.session);
      for (const row of peer.rows) {
        const receipt = await request(`/v1/messages/${row.sent.message_id}`, { client: sender, epoch: 2 });
        const local = inbox.db.prepare('SELECT * FROM inbox WHERE message_id=?').get(row.sent.message_id);
        assert.equal(receipt.status, 200);
        if (['consumed', 'injecting', 'pending'].includes(row.kind)) {
          assert.equal(receipt.body.delivery_state, 'delivered'); assert.equal(receipt.body.delivery_uncertain, false);
          assert.equal(local.state, row.kind === 'injecting' ? 'uncertain' : row.kind);
          assert.equal(JSON.parse(local.envelope).content.text, row.body.content.text);
          assert.equal(local.native_receipt, row.kind === 'consumed' ? 'fixture-not-a-native-host' : null);
          assert.equal(inbox.accept(row.claim.envelope).duplicate, true, 'late transport redelivery does not reinsert or consume');
        } else {
          assert.equal(local, undefined); assert.equal(receipt.body.delivery_state, 'queued');
          assert.equal(receipt.body.delivery_uncertain, row.kind === 'claimed');
        }
        const replay = await request('/v1/messages', { method: 'POST', client: sender, epoch: 2, key: row.key, body: row.body });
        assert.equal(replay.body.message_id, row.sent.message_id); assert.equal(replay.body.recipient_sequence, row.sent.recipient_sequence);
        const saved = senderInbox.outgoing(row.key);
        assert.equal(saved.uncertain, row.kind === 'queued' ? 1 : 0);
        assert.equal(saved.result?.message_id ?? null, row.kind === 'queued' ? null : row.sent.message_id);
      }
      const unknown = peer.rows.find(row => row.kind === 'injecting');
      assert.throws(() => inbox.beginInjection(unknown.sent.message_id), { code: 'injection_uncertain' });
      const claimed = peer.rows.find(row => row.kind === 'claimed');
      const stale = await request(`/v1/mailbox/${claimed.sent.message_id}/complete`, { method: 'POST', client: peer.session,
        body: { claim_id: claimed.claim.claim_id, outcome: 'delivered' } });
      assert.equal(stale.body.error.code, 'stale_lease_epoch');
      const retried = await request('/v1/mailbox/claim', { method: 'POST', client: peer.session, epoch: 2, key: 'after-recovery', body: {} });
      assert.equal(retried.body.envelope.message_id, claimed.sent.message_id); assert.equal(retried.body.attempt, 2);
      const rejected = await request(`/v1/mailbox/${claimed.sent.message_id}/complete`, { method: 'POST', client: peer.session, epoch: 2,
        body: { claim_id: retried.body.claim_id, outcome: 'permanent_not_stored', reason: 'unsupported_envelope' } });
      assert.equal(rejected.body.delivery_uncertain, true, 'a later negative ACK cannot erase the earlier unconfirmed hop');
      inbox.close();
    }
    senderInbox.close(); await stop(); assert.equal(child.exitCode, 0);
  }
  const untouched = new DatabaseSync(join(backup, 'broker.sqlite'), { readOnly: true });
  assert.equal(untouched.prepare('PRAGMA user_version').get().user_version, 2); untouched.close();
  t.diagnostic('20 real broker messages; schema2→5 migration and independent SQLite restore; four type-family local journals. Synthetic native receipt only; no native-host certification.');
});
