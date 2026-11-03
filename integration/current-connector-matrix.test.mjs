// Current packed connector conformance. Native host inputs/receipts/model reads
// are synthetic: this is NOT official CLI or authenticated-model certification.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { mkdirSync, symlinkSync, readFileSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { backupDatabase } from '../scripts/backup.mjs';
import { approvalTlsFixture } from '../test/approval-tls-fixture.mjs';

const execute = promisify(execFile);
const types = ['pi', 'claude-code', 'antigravity-cli', 'opencode'];
const sources = JSON.parse(process.env.PSST_CURRENT_MATRIX_SOURCES || 'null');
if (!sources || types.some(type => typeof sources[type] !== 'string')) {
  throw Error('PSST_CURRENT_MATRIX_SOURCES must identify all four pinned connector checkouts');
}
const packagesByType = { pi: 'pi', 'claude-code': 'claude', 'antigravity-cli': 'antigravity', opencode: 'opencode' };
const helpers = { pi: 'vendor/broker/reference/approval.mjs', 'claude-code': 'vendor/approval.mjs',
  'antigravity-cli': 'vendor/psst/approval.mjs', opencode: 'vendor/enrollment/approval.mjs' };

async function eventually(fn, predicate, label) {
  let value;
  const deadline = Date.now() + 12000;
  do { value = await fn(); if (predicate(value)) return value; await delay(25); } while (Date.now() < deadline);
  assert.fail(`${label}: ${JSON.stringify(value)}`);
}

async function startDriver(f, options) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./current-connector-driver.mjs', import.meta.url)), JSON.stringify(options)], {
    env: { PATH: process.env.PATH, HOME: join(options.runtime, 'home'), NODE_EXTRA_CA_CERTS: f.certFile },
    stdio: ['pipe', 'pipe', 'pipe'], detached: true,
  });
  // Every descendant is an isolated test-owned child (not a user native host).
  // Kill the owned group on failure so Claude MCP/monitor children cannot outlive
  // a timed-out wrapper and continue touching a fixture being removed.
  const kill = () => {
    if (!child.pid) return;
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  let stderr = '', sequence = 0, readyResolve, readyReject;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const exited = new Promise(resolve => child.once('close', resolve));
  const fail = error => {
    readyReject(error);
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
    pending.clear();
  };
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
  child.on('error', fail);
  child.stdin.on('error', fail);
  child.on('close', code => fail(Error(`matrix ${options.type} exited ${code}: ${stderr}`)));
  createInterface({ input: child.stdout }).on('line', line => {
    let response;
    try { response = JSON.parse(line); } catch { fail(Error(`matrix invalid child frame: ${options.type}`)); kill(); return; }
    if (response.ready) { readyResolve(); return; }
    const item = pending.get(response.id);
    if (!item) return;
    clearTimeout(item.timer); pending.delete(response.id);
    if (response.error) item.reject(Error(`${options.type}: ${response.error}`));
    else item.resolve(response.value);
  });
  const startup = setTimeout(() => { fail(Error(`matrix ${options.type} startup timeout: ${stderr}`)); kill(); }, 15000);
  try { await ready; } catch (error) { kill(); throw error; } finally { clearTimeout(startup); }
  const call = (name, args = {}, operationId) => new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode || child.stdin.destroyed) { reject(Error('matrix_driver_closed')); return; }
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`matrix ${options.type} ${name} timeout: ${stderr}`)); kill(); }, 15000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, name, args, operationId }) + '\n');
  });
  return { call, async close() {
    if (child.exitCode !== null || child.signalCode || child.stdin.destroyed) return;
    await call('close'); child.stdin.end(); await exited;
  }, kill };
}

test('current four packages: directed transport, synthetic native boundaries, pending restart and installation reuse', { timeout: 180000 }, async t => {
  const drivers = [];
  // Node's after hooks run in registration order: stop owners before the broker
  // fixture closes its database and removes its private directories.
  t.after(async () => { for (const driver of drivers) try { await driver.close(); } catch { driver.kill(); } });
  const f = await approvalTlsFixture(t);
  let enrollmentPosts = 0;
  f.app.server.prependListener('request', request => {
    if (request.method === 'POST' && request.url === '/v1/enrollment-requests') enrollmentPosts++;
  });
  const packages = {}, approved = {}, installations = {}, hashes = {};
  for (const type of types) {
    const source = resolve(sources[type]), out = join(f.directory, 'packages', type);
    mkdirSync(out, { recursive: true, mode: 0o700 });
    const { stdout } = await execute('npm', ['pack', '--json', '--ignore-scripts', '--cache', join(f.directory, 'npm-cache'), '--pack-destination', out], { cwd: source, timeout: 30000 });
    const packed = JSON.parse(stdout)[0];
    assert.equal(packed.name, `@matuto-ai/${packagesByType[type]}-psst-connector`);
    t.diagnostic(`current package ${type}: ${packed.version}, integrity ${packed.integrity}`);
    await execute('tar', ['-xzf', join(out, packed.filename), '-C', out]);
    packages[type] = join(out, 'package');
    if (['pi', 'opencode'].includes(type)) symlinkSync(join(source, 'node_modules'), join(packages[type], 'node_modules'));
    const helper = pathToFileURL(join(packages[type], helpers[type])).href;
    installations[type] = join(f.directory, 'persistent', type);
    mkdirSync(installations[type], { recursive: true, mode: 0o700 });
    const options = { brokerUrl: f.brokerUrl, directory: join(installations[type], 'credentials'), clientType: type };
    const run = async operation => JSON.parse((await f.runNode(`import * as h from ${JSON.stringify(helper)};process.stdout.write(JSON.stringify(await h[process.argv[1]](JSON.parse(process.argv[2]))));`, [operation, JSON.stringify(options)])).stdout);
    const pending = await run('beginApproval');
    assert.equal(pending.state, 'pending');
    assert.equal(f.approval.list().find(item => item.id === pending.requestId).state, 'pending');
    await f.decide(pending.requestId);
    approved[type] = await run('pollApproval');
    assert.equal(approved[type].state, 'approved');
    hashes[type] = createHash('sha256').update(readFileSync(join(approved[type].connectionFile, '..', 'token'))).digest('hex');
  }
  assert.equal(enrollmentPosts, 4);
  assert.equal(new Set(Object.values(approved).map(item => item.credentialId)).size, 4);
  const identities = new Set();
  let deliveries = 0;
  async function send(sender, recipient, label) {
    const text = `current matrix ${label}: ${randomUUID()}`;
    const sent = await sender.call('broker_send', { recipient_id: recipient.id, text }, randomUUID());
    assert.ok(sent.message_id, JSON.stringify(sent));
    assert.equal(sent.recipient_connected_at_acceptance, true, 'native tool ACK describes current transport presence, not completion');
    assert.equal(Object.hasOwn(sent, 'send_key'), false, 'retry keys stay inside the native connector');
    return { sender, recipient, text, messageId: sent.message_id };
  }
  async function stored(item) {
    await eventually(() => item.sender.call('broker_message_status', { message_id: item.messageId }), result => result.delivery_state === 'delivered', 'broker durable destination-inbox acceptance');
    const observed = await eventually(() => item.recipient.call('observe', { message_id: item.messageId }), Boolean, 'actual package inbox record');
    assert.equal(observed.envelope.message_id, item.messageId);
    assert.equal(observed.envelope.recipient_id, item.recipient.id);
    assert.equal(observed.envelope.sender.client_id, item.sender.id);
    assert.equal(observed.envelope.origin, 'broker_agent');
    assert.equal(observed.envelope.authority, 'untrusted_agent_input');
    assert.equal(observed.envelope.content.text, item.text);
    return observed;
  }
  async function finish(item) {
    await stored(item);
    const observation = await eventually(() => item.recipient.call('observe', { message_id: item.messageId }), result => result?.native?.observed === true, 'synthetic native boundary observation');
    assert.equal(observation.native.model_read_recorded, false, 'no authenticated model is running');
    assert.ok(JSON.stringify(observation.native.body).includes(item.text), 'exact agent content reaches the modeled native boundary');
    await item.recipient.call('acknowledge', { message_id: item.messageId });
    const consumed = await eventually(() => item.recipient.call('observe', { message_id: item.messageId }), result => result?.local_state === 'consumed', 'exact native receipt or explicit synthetic model read ACK advances only this inbox item');
    const automaticAdmission = ['pi', 'opencode'].includes(item.recipient.type);
    if (automaticAdmission) assert.equal(consumed.native.capture_count, 1, 'exactly one modeled automatic native admission of this message');
    else assert.ok(consumed.native.capture_count >= 1, 'explicit ACK follows at least one exact modeled read; repeat reads are allowed');
    assert.equal(consumed.native.native_acceptance_recorded, automaticAdmission, 'synthetic host receipts and explicit model-read ACKs remain distinct');
    deliveries++;
    return observation;
  }
  for (let generation = 0; generation < 2; generation++) {
    const sessions = {};
    for (const type of types) {
      sessions[type] = [];
      for (let index = 0; index < 2; index++) {
        const runtime = join(f.directory, 'ephemeral', String(generation), type, String(index));
        const driver = await startDriver(f, { type, packageRoot: packages[type], installation: installations[type], runtime,
          nativeId: randomUUID(), brokerUrl: f.brokerUrl, ...(generation === 0 && index === 0 ? { approved: approved[type] } : {}) });
        drivers.push(driver);
        const identity = await eventually(() => driver.call('broker_identity'), result => Boolean(result?.client_id), `${type} saved-authorization attachment`);
        assert.ok(identity.client_id, JSON.stringify(identity));
        assert.equal(identities.has(identity.client_id), false, 'distinct native lifetimes get distinct addresses');
        identities.add(identity.client_id);
        const storedSession = f.store.db.prepare('SELECT credential FROM sessions WHERE id=?').get(identity.client_id);
        assert.equal(storedSession.credential, approved[type].credentialId);
        sessions[type].push({ ...driver, id: identity.client_id, type });
      }
    }
    const all = Object.values(sessions).flat();
    assert.equal(new Set(all.map(session => session.id)).size, 8);
    // Exercise each production native tool's serialized result. The host
    // contexts remain synthetic; no broker-only shortcut can hide field loss.
    for (const type of types) {
      const listing = await sessions[type][0].call('broker_list_clients');
      assert.deepEqual(listing.clients.map(row => row.client_id).sort(), all.map(session => session.id).sort(),
        `${type} active native output excludes all prior disconnected lifetimes`);
      for (const row of listing.clients) {
        assert.equal(row.connected, true);
        assert.equal(row.presence_state, 'connected');
        assert.equal(row.observed_at, listing.server_time);
        assert.ok(Date.parse(row.last_heartbeat_at) <= Date.parse(row.observed_at));
        assert.ok(Date.parse(row.lease_expires_at) > Date.parse(row.observed_at));
      }
    }
    for (const from of types) for (const to of types) {
      const recipient = sessions[to][from === to ? 1 : 0];
      const item = await send(sessions[from][0], recipient, `${generation}: ${from} -> ${to}`);
      await finish(item);
      for (const other of all.filter(session => session.id !== recipient.id)) {
        assert.equal(await other.call('observe', { message_id: item.messageId }), null, 'no same-installation or cross-session inbox leakage');
      }
    }
    if (generation === 0) {
      // Restart the connector under the SAME modeled native owner, never forge a
      // Claude owner PID/lifetime or turn a genuinely new conversation into resume.
      for (let index = 0; index < types.length; index++) {
        const recipient = sessions[types[index]][0], sender = sessions[types[(index + 1) % types.length]][0];
        await recipient.call('set_admission', { enabled: false });
        const item = await send(sender, recipient, `pending restart ${recipient.type}`);
        const before = await stored(item);
        assert.equal(before.local_state, 'pending');
        assert.equal(before.native.observed, false);
        await recipient.call('restart');
        const resumed = await eventually(() => recipient.call('broker_identity'), result => Boolean(result?.client_id), `${recipient.type} resumed attachment`);
        assert.equal(resumed.client_id, recipient.id, 'same native owner resumes exact inbox identity');
        const after = await stored(item);
        assert.deepEqual(after.envelope, before.envelope);
        assert.equal(after.native.observed, false, 'restarting does not bypass the held native boundary');
        await recipient.call('set_admission', { enabled: true });
        await finish(item);
      }
      // An online SQLite snapshot retains delivered-but-native-pending mail.
      // Restore the broker immediately, before any new connector attachment, so
      // journals and snapshot describe the same recovery point. Each connector
      // must reconcile the fenced epoch itself; no test changes its journal.
      const retained = [];
      const epochs = new Map(all.map(peer => [peer.id, f.store.db.prepare('SELECT epoch FROM sessions WHERE id=?').get(peer.id).epoch]));
      for (let index = 0; index < types.length; index++) {
        const recipient = sessions[types[index]][0], sender = sessions[types[(index + 1) % types.length]][0];
        await recipient.call('set_admission', { enabled: false });
        const item = await send(sender, recipient, `broker snapshot recovery ${recipient.type}`);
        const before = await stored(item);
        assert.equal(before.local_state, 'pending'); assert.equal(before.native.observed, false);
        retained.push({ item, before });
      }
      const snapshot = join(f.directory, 'current-cohort-snapshot.sqlite');
      await backupDatabase(f.store.path, snapshot);
      await f.restart({ snapshot });
      for (const peer of all) {
        await eventually(() => f.store.db.prepare('SELECT epoch FROM sessions WHERE id=?').get(peer.id).epoch,
          epoch => epoch > epochs.get(peer.id), `${peer.type} connector reconciles restored broker epoch`);
        assert.equal((await peer.call('broker_identity')).client_id, peer.id);
      }
      for (const { item, before } of retained) {
        const after = await stored(item);
        assert.deepEqual(after.envelope, before.envelope);
        assert.equal(after.local_state, 'pending'); assert.equal(after.native.observed, false);
        await item.recipient.call('set_admission', { enabled: true });
        await finish(item);
      }
      const cycle = [sessions.pi[0], sessions.opencode[0], sessions['claude-code'][0]];
      const concurrent = await Promise.all(cycle.map((sender, index) => send(sender, cycle[(index + 1) % cycle.length], 'concurrent three-party exchange')));
      await Promise.all(concurrent.map(finish));
    }
    for (const driver of all) await driver.close();
    for (const session of all) {
      const row = f.store.db.prepare('SELECT closed,lease_until FROM sessions WHERE id=?').get(session.id);
      assert.equal(row.closed, 0, `${session.type} modeled native shutdown preserves resumability`);
      assert.ok(row.lease_until <= Date.now(), `${session.type} modeled native shutdown ends transport presence promptly`);
    }
    assert.equal(enrollmentPosts, 4, 'connector restart and fresh native lifetimes never reenroll');
    for (const type of types) assert.equal(createHash('sha256').update(readFileSync(join(approved[type].connectionFile, '..', 'token'))).digest('hex'), hashes[type]);
  }
  assert.equal(identities.size, 16);
  assert.equal(deliveries, 43);
  assert.equal(f.approval.list().length, 4);
  t.diagnostic('43 real transport deliveries: 32 directed routes, four same-native-owner pending restarts, four broker-snapshot recoveries, three concurrent routes. Native boundaries/model reads are synthetic; no authenticated CLI/model or deployment acceptance.');
});
