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

test('actual Pi-to-Pi matrix: native send, busy queue, human draft and pending model switch', { timeout: 150000 }, async t => {
  const children = [];
  let phase = 'setup';
  let peerRuntime, peerInbox;
  const report = { official_host: 'Pi 1.4.0', authenticated_model: false, provider: 'local faux',
    clock: 'real wall clock', negotiated_heartbeat_seconds: 2, negotiated_lease_seconds: 6,
    production_defaults_changed: false, completed: false, observations: [], sends: [],
    scope: 'Pi to Pi only; not the complete four-host 16-route matrix',
    final_hop_crash_window: 'not exercised; no supported deterministic observation barrier' };
  const retain = () => {
    if (process.env.PSST_NATIVE_MATRIX_EVIDENCE) writeFileSync(resolve(process.env.PSST_NATIVE_MATRIX_EVIDENCE), JSON.stringify(report, null, 2) + '\n');
  };
  // Owners are stopped before fixture hooks close/remove the broker and storage.
  t.after(async () => {
    report.last_phase = phase;
    const outcomes = await Promise.allSettled(children.map(child => child.close()));
    const errors = outcomes.filter(x => x.status === 'rejected').map(x => x.reason);
    try { await peerRuntime?.stop({ closeSession: false }); } catch (error) { errors.push(error); }
    try { peerInbox?.close(); } catch (error) { errors.push(error); }
    for (const child of children) {
      try {
        assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' }, 'owned native process was reaped');
        assert.throws(() => process.kill(-child.pid, 0), { code: 'ESRCH' }, 'owned native process group is gone');
      } catch (error) { errors.push(error); }
    }
    report.owned_native_cleanup_verified = errors.length === 0;
    report.completed = report.scenarios_passed === true && errors.length === 0;
    if (errors.length) report.cleanup_failure_count = errors.length;
    retain();
    if (errors.length) throw new AggregateError(errors, 'Owned matrix cleanup failed');
  });
  try {
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
    const child = await startNative({ home, agent, project, label, session, host, nativeTools: true, node: process.execPath,
      cli: join(hostRoot, 'dist/cli.js'), cert: f.certFile,
      observer: fileURLToPath(new URL('./native-pi-matrix-observer.mjs', import.meta.url)),
      extension: join(packageRoot, 'extensions/psst.ts'), observations: join(home, 'observations.jsonl'), terminal: join(home, 'terminal.bin') });
    children.push(child);
    const event = await until(() => records(child.observations).filter(x => x.event === 'session_start').at(-1), Boolean, `${label} actual session_start`);
    child.sessionId = event.sessionId; child.sessionFile = event.sessionFile;
    await bind(child);
    return child;
  }
  async function bind(child) {
    const identityFile = await until(() => files(join(agent, 'psst'), 'identity.json').find(file => JSON.parse(readFileSync(file)).hostSessionId === child.sessionId), Boolean, `${child.label} persisted native identity`);
    child.identityFile = identityFile;
    child.savedIdentity = JSON.parse(readFileSync(identityFile));
    child.clientId = child.savedIdentity.identity.client_id;
    child.inboxFile = join(identityFile, '..', 'inbox.sqlite');
    await until(() => all(), list => list.clients.some(row => row.client_id === child.clientId && row.connected), `${child.label} connected`);
  }
  const all = () => tools.broker_list_clients({ connected: false });
  const events = child => records(child.observations);
  const state = child => events(child).filter(x => x.event === 'state').at(-1);
  const calls = child => events(child).filter(x => x.event === 'provider_call').length;
  const entries = (child, id) => records(child.sessionFile).filter(x => x.type === 'custom_message' && x.customType === 'psst-agent-message' && x.details?.message_id === id);
  async function command(child, text) { await child.call('write', { text: text + '\r' }); }
  async function nativeSend(sender, recipient, text) {
    await until(() => state(sender), x => x?.idle && x.draft === '', 'sender idle');
    await command(sender, 'SEND ' + JSON.stringify({ recipient_id: recipient.clientId, text }));
    const result = await until(() => {
      const rows = records(sender.sessionFile), ids = rows.flatMap(x => x.message?.content ?? []).filter(x => x.type === 'toolCall' && x.name === 'broker_send' && x.arguments?.text === text).map(x => x.id);
      assert.ok(ids.length <= 1, 'native send tool is not duplicated');
      return rows.map(x => x.message).find(x => x?.role === 'toolResult' && ids.includes(x.toolCallId));
    }, Boolean, 'correlated native broker_send result');
    assert.equal(result.isError, false, JSON.stringify(result));
    const body = result.details ?? JSON.parse(result.content.filter(x => x.type === 'text').map(x => x.text).join(''));
    assert.ok(body.message_id, JSON.stringify(result));
    const item = { sender, recipient, text, id: body.message_id };
    report.sends.push({ phase, native_tool_result_correlated: true, sender: sender.label, recipient: recipient.label }); retain();
    return item;
  }
  async function pendingMail(item) {
    await until(() => readInbox(item.recipient.inboxFile, item.id), x => x?.state === 'pending', 'durable pending inbox');
    assert.equal(entries(item.recipient, item.id).length, 0);
  }
  async function received(item, model) {
    const stored = await until(() => readInbox(item.recipient.inboxFile, item.id), x => x?.state === 'consumed' && x.native_receipt?.startsWith('pi:'), 'actual native receipt');
    assert.equal(JSON.parse(stored.envelope).content.text, item.text);
    const journal = await until(() => entries(item.recipient, item.id), x => x.length === 1, 'one native journal entry');
    assert.equal(stored.native_receipt, 'pi:' + journal[0].id, 'receipt identifies the exact persisted native entry');
    const input = await until(() => events(item.recipient).find(x => x.event === 'provider_call' && JSON.stringify(x.content).includes(item.id)), Boolean, 'actual provider context');
    const serialized = JSON.stringify(input.content);
    assert.ok(serialized.includes('Broker message from AI agent ' + item.sender.clientId));
    assert.ok(serialized.includes(item.text));
    if (model) assert.equal(input.model, model);
    report.observations.push({ phase, sender: item.sender.label, recipient: item.recipient.label, native_receipt_correlated: true, journal_entries: 1, provider_model: input.model, source_label_verified: true, provider_context_verified: true }); retain();
    await until(() => state(item.recipient), x => x?.idle, 'recipient settled');
  }
  const a = await launch('native-A'), b = await launch('native-B');
  assert.notEqual(a.pid, b.pid); assert.notEqual(a.sessionId, b.sessionId); assert.notEqual(a.clientId, b.clientId);
  // Pi persists a session file on the first actual turn.
  for (const child of [a, b]) { await command(child, 'seed'); await until(() => state(child), x => x?.idle && calls(child) > 0, 'seed settled'); }
  assert.notEqual(a.sessionFile, b.sessionFile);
  const delivered = [];
  phase = 'bidirectional-native-tool';
  for (const [sender, recipient] of [[a, b], [b, a]]) { const item = await nativeSend(sender, recipient, 'native roundtrip ' + sender.label); await received(item, 'faux-1'); delivered.push(item); }
  phase = 'busy-arrival';
  await command(a, 'HOLD busy'); await until(() => events(a).some(x => x.event === 'holding' && x.marker === 'busy'), Boolean, 'native provider busy');
  const count = calls(a), busy = await nativeSend(b, a, 'mail while native provider is busy'); await pendingMail(busy);
  await delay(600); assert.equal(calls(a), count); assert.equal(state(a).idle, false); await pendingMail(busy);
  assert.equal(events(a).some(x => x.event === 'released' && x.marker === 'busy'), false, 'mail did not abort the running provider');
  writeFileSync(join(a.home, 'release-busy'), 'release local provider fixture');
  await received(busy, 'faux-1'); delivered.push(busy);
  assert.equal(events(a).find(x => x.event === 'released' && x.marker === 'busy').aborted, false);
  phase = 'human-draft';
  const draft = 'unfinished human draft'; await a.call('write', { text: draft }); await until(() => state(a), x => x?.draft === draft, 'actual editor draft');
  const draftCount = calls(a), draftMail = await nativeSend(b, a, 'mail while human draft is pending'); await pendingMail(draftMail); await delay(600);
  assert.equal(state(a).draft, draft); assert.equal(calls(a), draftCount); await pendingMail(draftMail);
  await a.call('write', { text: '\x15' }); await received(draftMail, 'faux-1'); delivered.push(draftMail);
  phase = 'model-switch-with-pending-mail';
  await command(a, 'HOLD abort'); await until(() => events(a).some(x => x.event === 'holding' && x.marker === 'abort'), Boolean, 'native abortable turn');
  await a.call('write', { text: '\x1b' }); await until(() => events(a).some(x => x.event === 'agent_settled' && x.aborted), Boolean, 'actual human Escape abort');
  const switchedMail = await nativeSend(b, a, 'mail pending across native model switch'); await pendingMail(switchedMail);
  const oldCalls = calls(a); await command(a, '/model faux-2');
  const selectionEvent = await until(() => events(a).filter(x => x.event === 'model_select').at(-1), x => x?.model_id === 'faux-2', 'native model switch');
  await delay(600); await pendingMail(switchedMail); assert.equal(calls(a), oldCalls); assert.equal(selectionEvent.sessionId, a.sessionId);
  const listing = await until(all, x => x.clients.find(y => y.client_id === a.clientId)?.model.id === 'faux-2', 'broker model metadata');
  assert.ok(listing.clients.find(x => x.client_id === a.clientId).connected);
  await command(a, 'continue'); await received(switchedMail, 'faux-2'); delivered.push(switchedMail);
  phase = 'final-duplicate-and-identity-check'; await delay(750);
  for (const item of delivered) {
    assert.equal(records(item.sender.sessionFile).flatMap(x => x.message?.content ?? []).filter(x => x.type === 'toolCall' && x.name === 'broker_send' && x.arguments?.text === item.text).length, 1, 'one native send invocation per message');
    assert.equal(entries(item.recipient, item.id).length, 1); assert.equal(readInbox(item.recipient.inboxFile, item.id).state, 'consumed'); }
  for (const child of [a, b]) {
    assert.equal(events(child).filter(x => x.event === 'session_start').length, 1);
    assert.equal(events(child).find(x => x.event === 'session_start').sessionId, child.sessionId);
    assert.deepEqual(JSON.parse(readFileSync(child.identityFile)), child.savedIdentity, 'model selection preserves the complete persisted identity');
    assert.equal(existsSync(join(child.identityFile, '..', 'current-incarnation.json')), false, 'model selection must not replace the mailbox incarnation');
  }
  assert.deepEqual((await all()).clients.map(x => x.client_id).sort(), [peerInbox.identity.client_id, a.clientId, b.clientId].sort(), 'model selection cannot silently register an additional mailbox');
  assert.deepEqual(selection.snapshot(), selected); assert.equal(f.approval.list().length, 1);
  report.busy_arrival_without_interruption = true; report.human_draft_preserved = true;
  report.pending_model_switch_identity_preserved = true; report.exactly_once_native_journals = true;
  report.scenarios_passed = true; retain();
  } catch (error) {
    // Keep phase and decisive assertion type without exporting raw provider input,
    // credentials, terminal output, or generated fixture filesystem locations.
    report.failure = { phase, name: error.name, code: error.code ?? null, operator: error.operator ?? null };
    retain();
    throw error;
  }
});
