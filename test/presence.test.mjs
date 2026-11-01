import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { fixture, httpFixture, registration, sendBody, uuid } from './helpers.mjs';
import { presenceSnapshot } from '../src/presence.mjs';
import { AdapterRuntime } from '../reference/runtime.mjs';
import { Inbox, newSessionIdentity } from '../reference/inbox.mjs';
import { BrokerClient } from '../reference/client.mjs';
import { createTools } from '../reference/tools.mjs';

function pair(f) {
  const sender = registration(), recipient = registration();
  f.store.register(f.a.entry, sender); f.store.register(f.b.entry, recipient);
  return { sender, recipient };
}
function send(f, sender, recipient, key = uuid(), extra = {}) {
  return f.store.send(f.a.entry, sender.client_id, 1, key, sendBody(recipient.client_id, 'opaque never included in notices', extra));
}
const code = (fn, expected) => assert.throws(fn, error => error.code === expected);

test('presence is explicit lease freshness; historical rows remain and expired active rows disappear', t => {
  const f = fixture(t), { sender } = pair(f);
  const live = f.store.list(f.a.entry).clients.find(row => row.client_id === sender.client_id);
  assert.equal(live.presence_state, 'connected'); assert.equal(live.connected, true);
  assert.equal(live.observed_at, new Date(f.now).toISOString());
  assert.equal(live.last_heartbeat_at, new Date(f.now).toISOString());
  f.advance(180000);
  assert.equal(f.store.list(f.a.entry).clients.length, 0);
  const historical = f.store.list(f.a.entry, { connected: 'false' }).clients;
  assert.equal(historical.length, 2);
  assert.ok(historical.every(row => row.presence_state === 'disconnected' && !row.connected));
  assert.equal(f.store.session(f.a.entry, sender.client_id).presence_state, 'disconnected');
  assert.equal(presenceSnapshot({ closed: 1, heartbeat_at: f.now, lease_until: f.now + 999 }, f.now).presence_state, 'closed');
});

test('resumable disconnect is idempotent and epoch fenced; claimed mail stays queued and uncertain', t => {
  const f = fixture(t), { sender, recipient } = pair(f), message = send(f, sender, recipient);
  f.store.claim(f.b.entry, recipient.client_id, 1, 'claim', {});
  const stopped = f.store.disconnect(f.b.entry, recipient.client_id, 1);
  assert.equal(stopped.connected, false);
  assert.equal(f.store.disconnect(f.b.entry, recipient.client_id, 1).presence_state, 'disconnected');
  assert.equal(f.store.session(f.b.entry, recipient.client_id).closed, false);
  assert.equal(f.store.receipt(f.a.entry, sender.client_id, message.message_id).delivery_state, 'queued');
  assert.equal(f.store.receipt(f.a.entry, sender.client_id, message.message_id).delivery_uncertain, true);
  code(() => f.store.heartbeat(f.b.entry, recipient.client_id, 1), 'stale_lease_epoch');
  f.store.register(f.b.entry, { ...recipient, connection_id: uuid(), previous_epoch: 1 });
  code(() => f.store.disconnect(f.b.entry, recipient.client_id, 1), 'stale_lease_epoch');
  assert.equal(f.store.session(f.b.entry, recipient.client_id).connected, true);
  code(() => f.store.disconnect(f.a.entry, recipient.client_id, 2), 'recipient_not_found');
});

test('discovery and exact-session freshness use one coherent clock observation at lease expiry', t => {
  const f = fixture(t), { sender } = pair(f);
  const expiry = Date.parse(f.store.session(f.a.entry, sender.client_id).lease_expires_at);
  let calls = 0;
  f.store.clock = () => expiry - 1 + calls++;
  const listing = f.store.list(f.a.entry);
  assert.equal(calls, 1);
  assert.equal(listing.clients.length, 2);
  assert.ok(listing.clients.every(row => row.connected && row.presence_state === 'connected' && row.observed_at === listing.server_time));
  calls = 0;
  const state = f.store.session(f.a.entry, sender.client_id);
  assert.equal(calls, 1); assert.equal(state.observed_at, state.server_time); assert.equal(state.connected, true);
});

test('sequential and concurrent runtime terminal-stop escalation closes only the explicitly disconnected epoch', async t => {
  for (const concurrent of [false, true]) {
    const f = fixture(t), { sender } = pair(f), diagnostics = [];
    const client = { inbox: { identity: sender }, attachment: { lease_epoch: 1 }, policy: f.store.policy(),
      async disconnectSession() { return f.store.disconnect(f.a.entry, sender.client_id, 1); },
      async closeSession() { return f.store.closeSession(f.a.entry, sender.client_id, 1); } };
    const runtime = new AdapterRuntime({ client, verifySession: () => true, isAlive: () => true, onDiagnostic: d => diagnostics.push(d) });
    if (concurrent) await Promise.all([runtime.stop({ closeSession: false }), runtime.stop({ closeSession: true })]);
    else { await runtime.stop({ closeSession: false }); await runtime.stop({ closeSession: true }); }
    assert.equal(f.store.session(f.a.entry, sender.client_id).closed, true);
    assert.deepEqual(diagnostics, []);
  }
  const f = fixture(t), { sender } = pair(f);
  f.store.disconnect(f.a.entry, sender.client_id, 1);
  f.store.register(f.a.entry, { ...sender, previous_epoch: 1, connection_id: uuid() });
  code(() => f.store.closeSession(f.a.entry, sender.client_id, 1), 'stale_lease_epoch');
  assert.equal(f.store.session(f.a.entry, sender.client_id).closed, false);
  f.advance(180000);
  code(() => f.store.closeSession(f.a.entry, sender.client_id, 2), 'stale_lease_epoch');
  f.store.disconnect(f.a.entry, sender.client_id, 2);
  code(() => f.store.closeSession(f.a.entry, sender.client_id, 2), 'stale_lease_epoch');
  assert.equal(f.store.session(f.a.entry, sender.client_id).closed, false);
});

test('explicit live-epoch disconnect marker survives retry/restart but never bypasses current scope authorization', t => {
  const f = fixture(t), { sender } = pair(f);
  f.store.disconnect(f.a.entry, sender.client_id, 1);
  f.advance(180000); f.store.disconnect(f.a.entry, sender.client_id, 1);
  f.restart();
  code(() => f.store.closeSession({ ...f.a.entry, scopes: ['private'] }, sender.client_id, 1), 'forbidden');
  assert.equal(f.store.session(f.a.entry, sender.client_id).closed, false);
  f.store.closeSession(f.a.entry, sender.client_id, 1);
  assert.equal(f.store.session(f.a.entry, sender.client_id).closed, true);
});

test('notice grace is 600 seconds from last heartbeat, not another 600 after lease expiry', t => {
  const f = fixture(t), { sender, recipient } = pair(f), message = send(f, sender, recipient);
  f.advance(180000); assert.deepEqual(f.store.presence.page(f.a.entry, sender.client_id).events, []);
  f.advance(419999); assert.deepEqual(f.store.presence.page(f.a.entry, sender.client_id).events, []);
  f.advance(1);
  const first = f.store.presence.page(f.a.entry, sender.client_id).events[0];
  assert.equal(first.type, 'recipient_offline'); assert.equal(first.recipient_id, recipient.client_id);
  assert.deepEqual(first.messages, [{ message_id: message.message_id, delivery_state: 'queued', delivery_uncertain: false }]);
  assert.ok(!JSON.stringify(first).includes('opaque'));
  assert.equal(f.store.presence.page(f.a.entry, sender.client_id).events[0].event_id, first.event_id);
  assert.equal(f.store.presence.acknowledge(f.a.entry, sender.client_id, first.event_id.toUpperCase()).acknowledged, true);
  assert.equal(f.store.presence.acknowledge(f.a.entry, sender.client_id, first.event_id).acknowledged, true);
  assert.deepEqual(f.store.presence.page(f.a.entry, sender.client_id).events, []);
  assert.equal(f.store.receipt(f.a.entry, sender.client_id, message.message_id).delivery_state, 'queued');
});

test('real HTTP client serializes terminal escalation during an in-flight resumable stop', async t => {
  for (const concurrent of [false, true]) {
    const f = await httpFixture(t), tokenFile = join(f.dir, 'test-token'), diagnostics = [];
    writeFileSync(tokenFile, f.a.token, { mode: 0o600 });
    const inbox = new Inbox({ directory: join(f.dir, 'escalation'), identity: newSessionIdentity('pi') });
    t.after(() => inbox.close());
    const client = new BrokerClient({ url: f.base, tokenFile, insecureDevelopment: true, inbox });
    await client.register(registration().metadata);
    const id = inbox.identity.client_id, epoch = client.attachment.lease_epoch;
    const runtime = new AdapterRuntime({ client, verifySession: () => true, isAlive: () => true, onDiagnostic: d => diagnostics.push(d) });
    if (concurrent) {
      const original = client.disconnectSession.bind(client);
      let started, release;
      const disconnected = new Promise(resolve => { started = resolve; });
      const barrier = new Promise(resolve => { release = resolve; });
      client.disconnectSession = async options => { const result = await original(options); started(); await barrier; return result; };
      const first = runtime.stop({ closeSession: false });
      await disconnected;
      assert.equal(f.store.session(f.a.entry, id).closed, false);
      const terminal = runtime.stop({ closeSession: true });
      release(); await Promise.all([first, terminal]);
    } else {
      await runtime.stop({ closeSession: false });
      assert.equal(f.store.session(f.a.entry, id).connected, false);
      assert.equal(f.store.session(f.a.entry, id).closed, false);
      await runtime.stop({ closeSession: true });
    }
    assert.equal(f.store.session(f.a.entry, id).closed, true);
    assert.equal(client.attachment.lease_epoch, epoch);
    assert.deepEqual(diagnostics, []);
  }
});

test('reference facade polls and acknowledges owned notices through real HTTP without a live sender lease', async t => {
  const f = await httpFixture(t), tokenFile = join(f.dir, 'test-token');
  writeFileSync(tokenFile, f.a.token, { mode: 0o600 });
  const inbox = new Inbox({ directory: join(f.dir, 'notice-client'), identity: newSessionIdentity('pi') });
  t.after(() => inbox.close());
  const client = new BrokerClient({ url: f.base, tokenFile, insecureDevelopment: true, inbox });
  await client.register(registration().metadata);
  const recipient = registration(); f.store.register(f.b.entry, recipient);
  f.store.send(f.a.entry, inbox.identity.client_id, 1, uuid(), sendBody(recipient.client_id));
  f.advance(600000);
  const tools = createTools({ client });
  const page = await tools.broker_presence_events({ limit: 10 });
  assert.equal(page.events.length, 1);
  assert.equal((await tools.broker_acknowledge_presence_event({ event_id: page.events[0].event_id })).acknowledged, true);
  assert.deepEqual((await tools.broker_presence_events()).events, []);
});

test('notices and suppression survive restart; reconnect starts a fresh absence episode', t => {
  const f = fixture(t), { sender, recipient } = pair(f); send(f, sender, recipient);
  f.advance(600000);
  const old = f.store.presence.page(f.a.entry, sender.client_id).events[0];
  f.restart(); assert.equal(f.store.presence.page(f.a.entry, sender.client_id).events[0].event_id, old.event_id);
  f.store.presence.acknowledge(f.a.entry, sender.client_id, old.event_id);
  f.restart(); assert.deepEqual(f.store.presence.page(f.a.entry, sender.client_id).events, []);
  f.store.register(f.b.entry, { ...recipient, previous_epoch: 1, connection_id: uuid() });
  assert.deepEqual(f.store.presence.page(f.a.entry, sender.client_id).events, []);
  f.advance(600000);
  const next = f.store.presence.page(f.a.entry, sender.client_id).events[0];
  assert.notEqual(next.event_id, old.event_id);
});

test('configured grace never makes a still-valid lease disconnected; no duplicate for later mail in same absence', t => {
  const f = fixture(t, { limits: { offline_notice_seconds: 60 } }), { sender, recipient } = pair(f);
  send(f, sender, recipient); f.advance(60000);
  assert.equal(f.store.presence.page(f.a.entry, sender.client_id).events.length, 0);
  f.advance(120000);
  const event = f.store.presence.page(f.a.entry, sender.client_id).events[0];
  f.store.presence.acknowledge(f.a.entry, sender.client_id, event.event_id);
  f.store.register(f.a.entry, { ...sender, previous_epoch: 1, connection_id: uuid() });
  f.store.send(f.a.entry, sender.client_id, 2, 'later', sendBody(recipient.client_id));
  assert.deepEqual(f.store.presence.page(f.a.entry, sender.client_id).events, []);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM presence_events').get().n, 1);
});

test('delivered/unanswered, expired, failed and cancelled messages never trigger pending-delivery alerts', t => {
  for (const state of ['delivered', 'failed', 'cancelled']) {
    const f = fixture(t), { sender, recipient } = pair(f), message = send(f, sender, recipient);
    f.store.db.prepare('UPDATE messages SET state=? WHERE id=?').run(state, message.message_id);
    f.advance(600000); assert.deepEqual(f.store.presence.page(f.a.entry, sender.client_id).events, []);
  }
  const f = fixture(t), { sender, recipient } = pair(f); send(f, sender, recipient, 'ttl', { ttl_seconds: 60 });
  f.advance(600000); assert.deepEqual(f.store.presence.page(f.a.entry, sender.client_id).events, []);
});

test('claimed/unconfirmed delivery is reported as uncertain and is suppressed after reconnect/completion', t => {
  const f = fixture(t), { sender, recipient } = pair(f), message = send(f, sender, recipient);
  f.store.claim(f.b.entry, recipient.client_id, 1, 'claim', {});
  f.advance(600000);
  const event = f.store.presence.page(f.a.entry, sender.client_id).events[0];
  assert.equal(event.messages[0].delivery_uncertain, true);
  f.store.register(f.b.entry, { ...recipient, previous_epoch: 1, connection_id: uuid() });
  assert.deepEqual(f.store.presence.page(f.a.entry, sender.client_id).events, []);
  const retry = f.store.claim(f.b.entry, recipient.client_id, 2, 'retry', {});
  f.store.complete(f.b.entry, recipient.client_id, 2, message.message_id, { claim_id: retry.claim_id, outcome: 'delivered' });
  f.advance(600000); assert.deepEqual(f.store.presence.page(f.a.entry, sender.client_id).events, []);
});

test('notice ownership and current scope authorization apply to reads and acknowledgements', t => {
  const f = fixture(t), { sender, recipient } = pair(f); send(f, sender, recipient); f.advance(600000);
  const event = f.store.presence.page(f.a.entry, sender.client_id).events[0];
  code(() => f.store.presence.page(f.b.entry, sender.client_id), 'recipient_not_found');
  code(() => f.store.presence.acknowledge(f.b.entry, recipient.client_id, event.event_id), 'message_not_found');
  const narrowed = { ...f.a.entry, scopes: ['private'] };
  assert.deepEqual(f.store.presence.page(narrowed, sender.client_id).events, []);
  code(() => f.store.presence.acknowledge(narrowed, sender.client_id, event.event_id), 'message_not_found');
  assert.equal(f.store.presence.page(f.a.entry, sender.client_id).events[0].event_id, event.event_id);
});

test('bounded metadata samples and cursor pages do not leak text or lose events', t => {
  const f = fixture(t, { limits: { send_burst: 100 } }), { sender, recipient } = pair(f);
  for (let i = 0; i < 12; i++) send(f, sender, recipient, `sample-${i}`);
  for (let i = 0; i < 10; i++) { const r = registration(); f.store.register(f.b.entry, r); send(f, sender, r); }
  f.advance(600000);
  const first = f.store.presence.page(f.a.entry, sender.client_id);
  assert.equal(first.events.length, 10); assert.ok(first.next_cursor);
  const second = f.store.presence.page(f.a.entry, sender.client_id, { cursor: first.next_cursor });
  assert.equal(second.events.length, 1); assert.equal(second.next_cursor, null);
  const events = [...first.events, ...second.events];
  assert.equal(new Set(events.map(e => e.event_id)).size, 11);
  const sampled = events.find(e => e.recipient_id === recipient.client_id);
  assert.equal(sampled.messages.length, 10); assert.equal(sampled.has_more_messages, true);
  assert.ok(Buffer.byteLength(JSON.stringify(first)) < 65536);
  assert.ok(!JSON.stringify(events).includes('opaque'));
  for (const query of [{ limit: 0 }, { limit: 101 }, { cursor: '-1' }, { cursor: '1e3' }, { text: 'anything' }])
    code(() => f.store.presence.page(f.a.entry, sender.client_id, query), 'invalid_request');
});

test('notification capacity is explicit and never changes accepted mail', t => {
  const f = fixture(t), { sender, recipient } = pair(f), message = send(f, sender, recipient);
  f.store.db.prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10000)
    INSERT INTO presence_events(id,sender,recipient,epoch,heartbeat,created,scopes)
    SELECT 'cap-'||x,'synthetic-'||x,?,1,?,?, '["default"]' FROM n`).run(recipient.client_id, f.now, f.now);
  f.advance(600000);
  const page = f.store.presence.page(f.a.entry, sender.client_id);
  assert.equal(page.capacity_limited, true); assert.equal(page.events.length, 0);
  assert.equal(f.store.receipt(f.a.entry, sender.client_id, message.message_id).delivery_state, 'queued');
});

test('lost notification response reconciles the same durable event rather than duplicating', t => {
  const f = fixture(t), { sender, recipient } = pair(f); send(f, sender, recipient); f.advance(600000);
  f.store.fault = stage => { if (stage === 'after_commit') throw new Error('lost response'); };
  assert.throws(() => f.store.presence.page(f.a.entry, sender.client_id), error => error.effect === 'unknown');
  f.store.fault = () => {};
  const row = f.store.db.prepare('SELECT * FROM presence_events').get();
  assert.equal(f.store.presence.page(f.a.entry, sender.client_id).events[0].event_id, row.id);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM presence_events').get().n, 1);
});

test('HTTP presence APIs authenticate, reject browser/query abuse and work for an offline sender', async t => {
  const f = await httpFixture(t), { sender, recipient } = pair(f); send(f, sender, recipient);
  const disconnected = await f.request(`/v1/sessions/${recipient.client_id}/disconnect`, { token: f.b.token, method: 'POST', session: recipient.client_id, body: {} });
  assert.equal(disconnected.status, 200); assert.equal(disconnected.body.presence_state, 'disconnected');
  assert.equal((await f.request(`/v1/sessions/${recipient.client_id}/disconnect`, { method: 'POST', session: sender.client_id, body: {} })).status, 403);
  f.advance(600000);
  const result = await f.request('/v1/presence-events', { headers: { 'X-Client-ID': sender.client_id } });
  assert.equal(result.status, 200); const event = result.body.events[0];
  assert.equal((await f.request('/v1/presence-events', { token: null })).status, 401);
  assert.equal((await f.request('/v1/presence-events', { session: sender.client_id, headers: { Origin: 'https://example.invalid' } })).status, 403);
  assert.equal((await f.request('/v1/presence-events?token=no', { session: sender.client_id })).status, 400);
  const ack = await f.request(`/v1/presence-events/${event.event_id}/ack`, { method: 'POST', headers: { 'X-Client-ID': sender.client_id }, body: {} });
  assert.equal(ack.status, 200); assert.equal(ack.body.acknowledged, true);
});

test('real reference adapter process exits gracefully without terminally closing its resumable identity', { timeout: 15000 }, async t => {
  const f = await httpFixture(t), tokenFile = join(f.dir, 'test-token');
  writeFileSync(tokenFile, f.a.token, { mode: 0o600 });
  const root = new URL('../', import.meta.url).href;
  const script = `import {Inbox,newSessionIdentity} from '${root}reference/inbox.mjs';
    import {BrokerClient} from '${root}reference/client.mjs';
    import {AdapterRuntime} from '${root}reference/runtime.mjs';
    const inbox=new Inbox({directory:${JSON.stringify(join(f.dir, 'native-fixture'))},identity:newSessionIdentity('pi')});
    const client=new BrokerClient({url:${JSON.stringify(f.base)},tokenFile:${JSON.stringify(tokenFile)},insecureDevelopment:true,inbox});
    const runtime=new AdapterRuntime({client,verifySession:()=>true,isAlive:()=>true});
    process.on('SIGTERM',async()=>{await runtime.stop({closeSession:false});inbox.close();process.exit(0)});
    await runtime.start({name:'reference-process',model:{provider:null,id:null,source:'unknown'},project:null});
    console.log(inbox.identity.client_id);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let stderr = ''; child.stderr.on('data', data => { stderr += data; });
  const exited = once(child, 'exit');
  const [data] = await Promise.race([once(child.stdout, 'data'), exited.then(() => { throw new Error(`Reference child exited before readiness: ${stderr}`); })]); const id = String(data).trim();
  assert.equal(f.store.session(f.a.entry, id).connected, true, stderr);
  child.kill('SIGTERM');
  assert.equal((await exited)[0], 0, stderr);
  const state = f.store.session(f.a.entry, id);
  assert.equal(state.connected, false); assert.equal(state.closed, false);
});
