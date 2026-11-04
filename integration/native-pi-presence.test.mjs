// Actual official Pi CLI processes + production packed connector + real TLS
// broker and wall clock. The provider is local faux, not an authenticated model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { startNative } from './native-pi-host.mjs';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { approvalTlsFixture } from '../test/approval-tls-fixture.mjs';
import { Inbox, newSessionIdentity } from '../reference/inbox.mjs';
import { BrokerClient } from '../reference/client.mjs';
import { AdapterRuntime } from '../reference/runtime.mjs';
import { createTools } from '../reference/tools.mjs';

const execute = promisify(execFile);
const source = process.env.PSST_NATIVE_PI_SOURCE && resolve(process.env.PSST_NATIVE_PI_SOURCE);
const host = process.env.PI_TEST_INSTALL && resolve(process.env.PI_TEST_INSTALL);
if (!source || !host) throw Error('Set PSST_NATIVE_PI_SOURCE and PI_TEST_INSTALL to the pinned connector and official Pi 1.4.0');
const hostRoot = join(host, 'node_modules/@earendil-works/pi-coding-agent');
assert.equal(JSON.parse(readFileSync(join(hostRoot, 'package.json'))).version, '1.4.0');
const limits = { heartbeat_seconds: 2, lease_seconds: 6 };

async function until(read, accept, label, timeout = 15000) {
  const end = Date.now() + timeout;
  do { const value = await read(); if (accept(value)) return value; await delay(25); } while (Date.now() < end);
  throw Error(`Native Pi lifecycle timed out: ${label}`);
}
function records(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; } // An observer append can be in flight.
  });
}
function files(directory, name) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap(item =>
    item.isDirectory() ? files(join(directory, item.name), name) : item.name === name ? [join(directory, item.name)] : []);
}
function readInbox(file, id) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare('SELECT state,envelope,native_receipt FROM inbox WHERE message_id=?').get(id); }
  finally { db.close(); }
}

test('actual Pi lifecycle preserves resumable mail and truthful real-time presence', { timeout: 150000 }, async t => {
  const children = [];
  let peerRuntime, peerInbox;
  const report = { official_host: 'Pi 1.4.0', authenticated_model: false, provider: 'local faux',
    clock: 'real wall clock', negotiated_heartbeat_seconds: 2, negotiated_lease_seconds: 6,
    production_defaults_changed: false, completed: false, observations: [], sends: [],
    active_discovery_filter: { connected: true, limit: 1 } };
  const retain = () => {
    if (process.env.PSST_NATIVE_PRESENCE_EVIDENCE) writeFileSync(resolve(process.env.PSST_NATIVE_PRESENCE_EVIDENCE), JSON.stringify(report, null, 2) + '\n');
  };
  // Owners are stopped before fixture hooks close/remove the broker and storage.
  t.after(async () => {
    const outcomes = await Promise.allSettled(children.map(child => child.close()));
    try { await peerRuntime?.stop({ closeSession: false }); } finally { peerInbox?.close(); }
    for (const child of children) {
      assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' }, 'owned native process was reaped');
      assert.throws(() => process.kill(-child.pid, 0), { code: 'ESRCH' }, 'owned native process group is gone');
    }
    report.owned_native_cleanup_verified = true;
    const failed = outcomes.find(result => result.status === 'rejected');
    report.completed = report.scenarios_passed === true && !failed;
    retain();
    if (failed) throw failed.reason;
  });
  const f = await approvalTlsFixture(t, { limits });
  const agent = join(f.directory, 'persistent-agent'), project = join(f.directory, 'project');
  for (const path of [agent, project]) mkdirSync(path, { mode: 0o700 });
  const packedDir = join(f.directory, 'packed'); mkdirSync(packedDir);
  const { stdout } = await execute('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', packedDir,
    '--cache', join(f.directory, 'npm-cache')], { cwd: source, timeout: 30000 });
  const packed = JSON.parse(stdout)[0];
  assert.equal(packed.name, '@matuto-ai/pi-psst-connector');
  await execute('tar', ['-xzf', join(packedDir, packed.filename), '-C', packedDir]);
  const packageRoot = join(packedDir, 'package');
  symlinkSync(join(source, 'node_modules'), join(packageRoot, 'node_modules'));
  report.connector_package = `${packed.name}@${packed.version}`;
  report.connector_integrity = packed.integrity;
  const options = { brokerUrl: f.brokerUrl, directory: join(agent, 'psst/installation-credentials'), clientType: 'pi' };
  const pending = await f.helper('beginApproval', options);
  await f.decide(pending.requestId);
  const approved = await f.helper('pollApproval', options);
  assert.equal(approved.state, 'approved');
  const { createConfigPathStore } = await import(pathToFileURL(join(packageRoot, 'src/config-path.mjs')));
  const selection = createConfigPathStore(f.directory, { PI_CODING_AGENT_DIR: agent });
  selection.write(approved.connectionFile, f.brokerUrl);
  const selected = selection.snapshot();
  const bundle = JSON.parse(readFileSync(approved.connectionFile));
  const tokenFile = join(approved.connectionFile, '..', bundle.token_file);
  peerInbox = new Inbox({ directory: join(f.directory, 'peer-inbox'), identity: newSessionIdentity('pi') });
  const client = new BrokerClient({ url: f.brokerUrl, tokenFile, caFile: f.certFile, inbox: peerInbox });
  peerRuntime = new AdapterRuntime({ client, verifySession: () => true, isAlive: () => true });
  await peerRuntime.start({ name: 'fixture observer', model: { provider: null, id: null, source: 'unknown' }, project: null });
  const tools = createTools({ client, inbox: peerInbox });
  async function launch(label, session) {
    const home = join(f.directory, `home-${children.length}`); mkdirSync(home, { mode: 0o700 });
    const child = await startNative({ home, agent, project, label, session, host, node: process.execPath,
      cli: join(hostRoot, 'dist/cli.js'), cert: f.certFile,
      observer: fileURLToPath(new URL('./native-pi-presence-observer.mjs', import.meta.url)),
      extension: join(packageRoot, 'extensions/psst.ts'), observations: join(home, 'observations.jsonl'), terminal: join(home, 'terminal.bin') });
    children.push(child);
    const event = await until(() => records(child.observations).filter(x => x.event === 'session_start').at(-1), Boolean, `${label} actual session_start`);
    child.sessionId = event.sessionId; child.sessionFile = event.sessionFile;
    await bind(child);
    return child;
  }
  async function bind(child) {
    const identityFile = await until(() => files(join(agent, 'psst'), 'identity.json').find(file => JSON.parse(readFileSync(file)).hostSessionId === child.sessionId), Boolean, `${child.label} persisted native identity`);
    child.clientId = JSON.parse(readFileSync(identityFile)).identity.client_id;
    child.inboxFile = join(identityFile, '..', 'inbox.sqlite');
    await until(() => all(), list => list.clients.some(row => row.client_id === child.clientId && row.connected), `${child.label} connected`);
  }
  const all = () => tools.broker_list_clients({ connected: false });
  async function row(child) { return (await all()).clients.find(row => row.client_id === child.clientId); }
  async function observe(phase, child) {
    const listed = await all(), snapshot = listed.clients.find(row => row.client_id === child.clientId);
    assert.ok(snapshot, 'historical registration remains visible');
    assert.equal(snapshot.observed_at, listed.server_time);
    for (const field of ['last_heartbeat_at', 'lease_expires_at', 'observed_at']) assert.ok(Number.isFinite(Date.parse(snapshot[field])));
    const live = (await child.call('status')).live;
    const observation = { phase, native_label: child.label, process_live: live,
      discovery_filter: { connected: false },
      presence_state: snapshot.presence_state, connected: snapshot.connected,
      last_heartbeat_at: snapshot.last_heartbeat_at, lease_expires_at: snapshot.lease_expires_at,
      observed_at: snapshot.observed_at, server_time: listed.server_time };
    report.observations.push(observation);
    retain();
    t.diagnostic(JSON.stringify(observation));
    return snapshot;
  }
  async function pagedActive() {
    const found = []; let cursor;
    do { const page = await tools.broker_list_clients({ connected: true, limit: 1, ...(cursor ? { cursor } : {}) });
      found.push(...page.clients); cursor = page.next_cursor;
    } while (cursor);
    assert.equal(new Set(found.map(row => row.client_id)).size, found.length);
    return found;
  }
  async function send(child, text) {
    const result = await tools.broker_send({ recipient_id: child.clientId, text });
    assert.ok(result.message_id, JSON.stringify(result));
    return result;
  }
  async function received(child, sent, text) {
    await until(() => tools.broker_message_status({ message_id: sent.message_id }), result => result.delivery_state === 'delivered', 'durable broker delivery');
    const stored = await until(() => readInbox(child.inboxFile, sent.message_id), result => result?.state === 'consumed' && result?.native_receipt?.startsWith('pi:'), 'actual native receipt');
    assert.equal(JSON.parse(stored.envelope).content.text, text);
    await until(() => records(child.sessionFile).filter(row => row.type === 'custom_message' && row.customType === 'psst-agent-message' && row.details?.message_id === sent.message_id), rows => rows.length === 1, 'one actual session JSONL entry');
    const input = await until(() => records(child.observations).filter(event => event.event === 'provider_call').find(event => JSON.stringify(event.content).includes(text)), Boolean, 'source content in actual local-provider context');
    const serialized = JSON.stringify(input.content);
    assert.ok(serialized.includes('Broker message from AI agent ' + peerInbox.identity.client_id), 'actual model input labels the peer source');
    assert.ok(serialized.includes(sent.message_id), 'actual model input identifies the exact message');
  }
  const a = await launch('native-A'), b = await launch('native-B');
  assert.notEqual(a.pid, b.pid); assert.notEqual(a.sessionId, b.sessionId); assert.notEqual(a.clientId, b.clientId);
  const initialA = await observe('two-native-sessions', a); await observe('two-native-sessions', b);
  const seedA = await send(a, 'native lifecycle seed A'), seedB = await send(b, 'native lifecycle seed B');
  await received(a, seedA, 'native lifecycle seed A'); await received(b, seedB, 'native lifecycle seed B');
  // Real negotiated heartbeats renew while both native hosts remain idle. They
  // must not consume any provider call or start an artificial model turn.
  for (const child of [a, b]) await until(() => records(child.observations).filter(event => event.event === 'agent_settled'), events => events.length > 0, 'native model turn settled');
  const calls = child => records(child.observations).filter(event => event.event === 'provider_call').length;
  const beforeCalls = [calls(a), calls(b)], idleHeartbeat = Date.parse((await row(a)).last_heartbeat_at);
  await until(() => row(a), snapshot => Date.parse(snapshot.last_heartbeat_at) >= idleHeartbeat + limits.heartbeat_seconds * 1000, 'real idle heartbeat renewal');
  assert.deepEqual([calls(a), calls(b)], beforeCalls, 'heartbeat renewal uses zero model/provider calls');
  report.zero_token_heartbeat = { verified: true, provider_calls_during_renewal: 0, negotiated_seconds: limits.heartbeat_seconds };
  retain();
  const selectedIdentity = a.clientId, selectedSession = a.sessionId;
  await a.call('write', { text: '/model faux-2\r' });
  const modelSelection = await until(() => records(a.observations).filter(event => event.event === 'model_select').at(-1), event => event?.model_id === 'faux-2', 'actual native model selection');
  const switched = await until(() => row(a), snapshot => snapshot.model.id === 'faux-2', 'native model selection updates broker metadata');
  assert.equal(switched.client_id, selectedIdentity);
  assert.equal(modelSelection.sessionId, selectedSession);
  const afterSwitch = await send(a, 'native delivery after actual model switch');
  await received(a, afterSwitch, 'native delivery after actual model switch');
  report.native_model_switch = { verified: true, preserved_native_conversation: true, preserved_broker_identity: true,
    actual_provider_context_after_switch: true, model: 'faux-2' };
  report.native_source_labels_verified = true;
  retain();
  const starts = records(a.observations).filter(event => event.event === 'session_start').length;
  const epoch = f.store.db.prepare('SELECT epoch FROM sessions WHERE id=?').get(a.clientId).epoch;
  await a.call('write', { text: '/reload\r' });
  await until(() => records(a.observations).filter(event => event.event === 'session_start'), events => events.length > starts, 'actual extension reload');
  const reloaded = records(a.observations).filter(event => event.event === 'session_start').at(-1);
  assert.equal(reloaded.sessionId, a.sessionId);
  await until(() => f.store.db.prepare('SELECT epoch FROM sessions WHERE id=?').get(a.clientId).epoch, value => value > epoch, 'reload reconnects same identity');
  assert.ok(records(a.observations).some(event => event.event === 'session_shutdown'));
  await observe('same-conversation-reload', a);
  // An actual unsubmitted editor draft keeps a durable local item pending.
  const draft = 'unfinished fixture human draft';
  await a.call('write', { text: draft });
  await until(() => records(a.observations).filter(event => event.event === 'editor').at(-1), event => event?.text === draft, 'real native editor draft');
  const retained = await send(a, 'retain local inbox through graceful exit');
  await until(() => tools.broker_message_status({ message_id: retained.message_id }), result => result.delivery_state === 'delivered', 'pending local inbox accepted');
  assert.equal(readInbox(a.inboxFile, retained.message_id).state, 'pending');
  assert.equal(records(a.observations).filter(event => event.event === 'editor').at(-1).text, draft);
  report.sends.push({ label: 'local-pending-before-graceful-exit', recipient_connected_at_acceptance: retained.recipient_connected_at_acceptance,
    broker_receipt_before_exit: 'delivered', local_inbox_before_exit: 'pending', native_receipt_before_exit: false });
  retain();
  await a.call('signal', { signal: 'SIGTERM' });
  await b.call('write', { text: '/quit\r' });
  for (const child of [a, b]) {
    const stopped = await until(() => child.call('status'), status => !status.live, 'confirmed graceful native exit');
    assert.equal(stopped.code, 0);
    assert.equal(records(child.observations).filter(event => event.event === 'session_shutdown').at(-1).sessionId, child.sessionId);
    const offline = await observe('after-graceful-exit', child);
    assert.equal(offline.connected, false); assert.equal(offline.presence_state, 'disconnected');
    assert.equal(f.store.db.prepare('SELECT closed FROM sessions WHERE id=?').get(child.clientId).closed, 0);
  }
  const stoppedHeartbeats = [await row(a), await row(b)].map(value => value.last_heartbeat_at);
  await delay(2300);
  assert.deepEqual([await row(a), await row(b)].map(value => value.last_heartbeat_at), stoppedHeartbeats, 'no orphan renewal after native exit');
  assert.equal((await pagedActive()).some(row => [a.clientId, b.clientId].includes(row.client_id)), false);
  const c = await launch('native-C');
  assert.ok(![a.clientId, b.clientId].includes(c.clientId), 'new conversation receives independent identity');
  await observe('one-new-conversation', c);
  const queued = await send(a, 'queued while native A absent');
  assert.equal(queued.recipient_connected_at_acceptance, false);
  assert.equal((await tools.broker_message_status({ message_id: queued.message_id })).delivery_state, 'queued');
  report.sends.push({ label: 'offline-queued-before-resume', recipient_connected_at_acceptance: queued.recipient_connected_at_acceptance,
    broker_receipt_before_resume: 'queued' });
  retain();
  assert.equal(readInbox(a.inboxFile, retained.message_id).state, 'pending');
  const resumedA = await launch('native-A-resumed', a.sessionFile);
  assert.equal(resumedA.sessionId, a.sessionId); assert.equal(resumedA.clientId, a.clientId);
  await received(resumedA, retained, 'retain local inbox through graceful exit');
  await received(resumedA, queued, 'queued while native A absent');
  report.sends[0].local_inbox_after_resume = 'consumed-with-actual-native-receipt';
  report.sends[1].broker_receipt_after_resume = 'delivered';
  report.sends[1].native_history_count_after_resume = 1;
  await observe('exact-native-conversation-resumed', resumedA);
  const seedC = await send(c, 'native lifecycle seed C'); await received(c, seedC, 'native lifecycle seed C');
  const beforeHeartbeat = (await row(c)).last_heartbeat_at;
  await until(() => row(c), value => value.last_heartbeat_at !== beforeHeartbeat, 'confirmed native renewal before abrupt kill');
  const renewed = await observe('immediately-before-SIGKILL', c);
  await c.call('signal', { signal: 'SIGKILL' });
  const killed = await until(() => c.call('status'), status => !status.live, 'confirmed abrupt native exit');
  const grace = await observe('immediately-after-SIGKILL', c);
  assert.equal(killed.code, -9); assert.equal(grace.connected, true, 'valid lease is not a live-process probe');
  assert.equal(grace.last_heartbeat_at, renewed.last_heartbeat_at);
  assert.equal(records(c.observations).some(event => event.event === 'session_shutdown'), false, 'SIGKILL did not forge graceful lifecycle');
  await until(() => row(c), value => !value.connected, 'real negotiated lease expiry', 8000);
  const expired = await observe('after-real-lease-expiry', c);
  assert.equal(expired.last_heartbeat_at, renewed.last_heartbeat_at, 'no process remains to renew');
  assert.equal(Date.parse(expired.lease_expires_at) - Date.parse(expired.last_heartbeat_at), 6000);
  assert.ok(Date.parse(expired.observed_at) >= Date.parse(expired.lease_expires_at));
  assert.ok(Date.parse(expired.observed_at) - Date.parse(expired.lease_expires_at) < 1000);
  assert.equal((await pagedActive()).some(row => row.client_id === c.clientId), false);
  const stillExited = await observe('original-exited-owner-after-negotiated-interval', b);
  assert.equal(stillExited.connected, false);
  assert.equal(stillExited.last_heartbeat_at, stoppedHeartbeats[1]);
  assert.ok(Date.parse(stillExited.observed_at) - Date.parse(stillExited.last_heartbeat_at) >= limits.lease_seconds * 1000,
    'original exited owner remains offline after its full negotiated lease interval');
  const afterCrash = await send(c, 'queued after abrupt native exit');
  assert.equal(afterCrash.recipient_connected_at_acceptance, false);
  assert.equal((await tools.broker_message_status({ message_id: afterCrash.message_id })).delivery_state, 'queued');
  report.sends.push({ label: 'offline-queued-after-crash', recipient_connected_at_acceptance: false, broker_receipt_before_resume: 'queued' });
  retain();
  const resumedC = await launch('native-C-resumed', c.sessionFile);
  assert.equal(resumedC.sessionId, c.sessionId); assert.equal(resumedC.clientId, c.clientId);
  await received(resumedC, afterCrash, 'queued after abrupt native exit');
  report.sends[2].broker_receipt_after_resume = 'delivered';
  report.sends[2].native_history_count_after_resume = 1;
  await observe('exact-conversation-after-crash', resumedC);
  const oldSession = resumedC.sessionId, oldClient = resumedC.clientId;
  await resumedC.call('write', { text: '/new\r' });
  const next = await until(() => records(resumedC.observations).filter(event => event.event === 'session_start').at(-1), event => event?.sessionId !== oldSession, 'actual /new native conversation');
  resumedC.sessionId = next.sessionId; resumedC.sessionFile = next.sessionFile;
  await bind(resumedC); assert.notEqual(resumedC.clientId, oldClient);
  assert.equal((await all()).clients.find(row => row.client_id === oldClient).connected, false);
  await observe('new-conversation-same-process', resumedC);
  assert.deepEqual(selection.snapshot(), selected, 'shared installation selection was not replaced');
  assert.equal(f.approval.list().length, 1, 'all native lifetimes reuse one installation approval');
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM sessions WHERE closed=1').get().n, 0);
  assert.equal(initialA.presence_state, 'connected');
  report.preserved_pending_local_item = true; report.preserved_offline_queued_mail = true;
  report.same_session_identity_on_resume = true; report.new_session_identity_is_distinct = true;
  report.single_installation_reused = true;
  report.scenarios_passed = true;
  retain();
  t.diagnostic('Official Pi processes, real TLS/SQLite and real negotiated lease time. Local faux provider only; no authenticated user-model or other native-host lifecycle certification.');
});
