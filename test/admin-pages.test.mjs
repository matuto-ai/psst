import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { fixture, registration, sendBody } from './helpers.mjs';
import { ApprovalService } from '../src/approval.mjs';
import { adminClient } from '../src/admin-client.mjs';
import { AdminUI } from '../src/admin.mjs';
import { AdminData, ADMIN_PAGE_BYTES, publicLabel } from '../src/admin-data.mjs';
import { createBrokerServer } from '../src/server.mjs';

const params = value => new URLSearchParams(value);
function register(f, owner = f.a.entry, extra = {}) {
  const input = registration(extra.client_type ?? 'pi', extra);
  f.store.register(owner, input);
  return input;
}
async function web(t) {
  const f = fixture(t), approval = await ApprovalService.create({ store: f.store });
  const admin = await AdminUI.create({ approval, auth: f.auth, password: 'synthetic-password-only-123456', insecureDevelopment: true });
  const app = createBrokerServer({ store: f.store, auth: f.auth, approval, admin, host: '127.0.0.1', port: 0, insecureDevelopment: true });
  const address = await app.listen(); t.after(() => app.close());
  const session = admin.issue(true), cookie = `psst_admin=${session.cookie}`;
  return { ...f, approval, admin, app, session, cookie, base: `http://127.0.0.1:${address.port}`,
    async page(path, authenticated = true) { const r = await fetch(`http://127.0.0.1:${address.port}${path}`, { headers: authenticated ? { cookie } : {} }); return { status: r.status, html: await r.text(), headers: r.headers }; } };
}

test('admin sessions distinguish same names/installation and derive lease freshness including restart', t => {
  const f = fixture(t), a = register(f), b = register(f), other = register(f, f.b.entry), data = new AdminData(f.store);
  const first = data.sessions(params());
  assert.equal(first.clients.length, 3);
  assert.equal(first.clients.find(s => s.client_id === a.client_id).name, first.clients.find(s => s.client_id === b.client_id).name);
  assert.equal(first.clients.find(s => s.client_id === a.client_id).installation_id, first.clients.find(s => s.client_id === b.client_id).installation_id);
  assert.notEqual(first.clients.find(s => s.client_id === a.client_id).installation_id, first.clients.find(s => s.client_id === other.client_id).installation_id);
  assert.ok(first.clients.every(s => s.connected && s.presence_state === 'connected' && s.last_heartbeat_at && s.lease_expires_at && s.observed_at === first.server_time));
  f.store.closeSession(f.a.entry, a.client_id, 1);
  f.advance(180000);
  assert.equal(data.sessions(params({ state: 'connected' })).clients.length, 0);
  assert.equal(data.sessions(params({ state: 'disconnected' })).clients.length, 2);
  assert.equal(data.sessions(params({ state: 'closed' })).clients[0].client_id, a.client_id);
  assert.equal(f.store.db.prepare('SELECT closed FROM sessions WHERE id=?').get(b.client_id).closed, 0);
  const restarted = new AdminData(f.restart()).sessions(params({ state: 'all' }));
  assert.ok(restarted.clients.every(s => !s.connected));
  assert.ok(restarted.clients.every(s => s.lease_expires_at === null));
});

test('admin registry uses exact bounded SQL pagination, validated filters and bound cursors', t => {
  const f = fixture(t), data = new AdminData(f.store), ids = [];
  for (let i = 0; i < 24; i++) ids.push(register(f, i % 2 ? f.a.entry : f.b.entry, { client_type: i % 3 ? 'pi' : 'opencode' }).client_id);
  const seen = []; let query = params();
  do { const page = data.sessions(query); assert.ok(page.clients.length <= 10); seen.push(...page.clients.map(s => s.client_id)); query = page.next_cursor ? params({ cursor: page.next_cursor }) : null; } while (query);
  assert.deepEqual(seen, ids.sort());
  const exact = data.sessions(params({ client_id: ids[4] })); assert.deepEqual(exact.clients.map(s => s.client_id), [ids[4]]);
  assert.ok(data.sessions(params({ client_type: 'opencode' })).clients.every(s => s.client_type === 'opencode'));
  assert.ok(data.sessions(params({ installation_id: f.a.entry.adapter_id })).clients.every(s => s.installation_id === f.a.entry.adapter_id));
  assert.equal(data.sessions(params({ limit: '25' })).clients.length, 24);
  const cursor = data.sessions(params()).next_cursor;
  for (const query of [{ limit: '0' }, { limit: '101' }, { limit: '1.5' }, { limit: '01' }, { state: 'active' }, { client_type: 'unknown' }, { client_id: "' OR 1=1" }, { installation_id: '../private' }, { cursor: cursor + 'x' }, { cursor, state: 'all' }, { unexpected: 'x' }]) assert.throws(() => data.sessions(params(query)), e => e.status === 400);
  assert.throws(() => data.sessions(params('limit=10&limit=10')), e => e.status === 400);
});

test('session projection excludes private credentials, arbitrary fields and recognizable private paths', t => {
  const f = fixture(t), secret = 'PRIVATE-MESSAGE-NOT-IN-REGISTRY';
  register(f, f.a.entry, { metadata: { name: '<script>alert("name")</script>', model: { id: 'safe-model', provider: 'provider', source: 'observed' }, project: '/home/private/project' } });
  const data = new AdminData(f.store), serialized = JSON.stringify(data.sessions(params()));
  for (const forbidden of [f.a.token, f.a.entry.token_sha256, 'token_hash', 'credential', '/home/private/project', secret, 'session_instance_id', 'connection_id', 'capabilities']) assert.ok(!serialized.includes(forbidden), forbidden);
  assert.ok(serialized.includes('[private path hidden]'));
  for (const path of ['C:\\Users\\private', '\\\\host\\private', '~/private', 'file:///private', 'project at /Users/private']) assert.equal(publicLabel(path), '[private path hidden]');
  assert.equal(publicLabel('team/project-label'), 'team/project-label');
});

test('message listing is metadata-only, newest-first/default10 with stable equal-time tie-break and insert boundary', t => {
  const f = fixture(t, { limits: { send_burst: 100 } }), a = register(f), b = register(f, f.b.entry), data = new AdminData(f.store), ids = [];
  for (let i = 0; i < 23; i++) ids.push(f.store.send(f.a.entry, a.client_id, 1, randomUUID(), sendBody(b.client_id, `PRIVATE BODY ${i}`)).message_id);
  const first = data.messages(params()); assert.equal(first.messages.length, 10); assert.equal(first.limit, 10);
  assert.deepEqual(first.messages.map(m => m.message_id), [...ids].sort().reverse().slice(0, 10));
  assert.ok(Buffer.byteLength(JSON.stringify(first.messages)) <= ADMIN_PAGE_BYTES);
  assert.ok(!JSON.stringify(first).match(/PRIVATE BODY|envelope|content|snippet|summary/));
  f.store.send(f.a.entry, a.client_id, 1, randomUUID(), sendBody(b.client_id, 'concurrent insert'));
  const all = [...first.messages]; let cursor = first.next_cursor;
  while (cursor) { const next = data.messages(params({ cursor })); all.push(...next.messages); cursor = next.next_cursor; }
  assert.deepEqual(all.map(m => m.message_id), [...ids].sort().reverse());
  assert.equal(new Set(all.map(m => m.message_id)).size, 23);
  assert.equal(data.messages(params({ limit: '25' })).messages.length, 24);
  const detail = data.message(ids[0]); assert.equal(detail.content.text, 'PRIVATE BODY 0');
  assert.equal(detail.sender_id, a.client_id); assert.equal(detail.recipient_id, b.client_id);
  f.store.db.prepare('UPDATE messages SET envelope=NULL WHERE id=?').run(ids[0]);
  assert.equal(data.message(ids[0]).content, null);
  assert.throws(() => data.message(randomUUID()), e => e.status === 404);
});

test('message filters are exact, validated and cannot be changed midway through a cursor', t => {
  const f = fixture(t), a = register(f), b = register(f, f.b.entry), data = new AdminData(f.store);
  const old = f.store.send(f.a.entry, a.client_id, 1, randomUUID(), sendBody(b.client_id)); f.advance(1000);
  const newer = f.store.send(f.a.entry, a.client_id, 1, randomUUID(), sendBody(b.client_id));
  f.store.db.prepare("UPDATE messages SET state='delivered',attempts=2,uncertain=1 WHERE id=?").run(old.message_id);
  assert.deepEqual(data.messages(params({ status: 'delivered' })).messages.map(m => m.message_id), [old.message_id]);
  assert.equal(data.messages(params({ sender_id: b.client_id })).messages.length, 0);
  assert.equal(data.messages(params({ recipient_id: a.client_id })).messages.length, 0);
  const now = new Date(f.now).toISOString();
  assert.deepEqual(data.messages(params({ accepted_after: now })).messages.map(m => m.message_id), [newer.message_id]);
  assert.equal(data.messages(params({ accepted_before: now })).messages.length, 2);
  const first = data.messages(params({ limit: '1' }));
  assert.throws(() => data.messages(params({ cursor: first.next_cursor, limit: '1', status: 'queued' })), e => e.status === 400);
  for (const query of [{ limit: '101' }, { status: 'read' }, { sender_id: 'not-uuid' }, { accepted_after: 'yesterday' }, { accepted_after: '2026-11-01T00:00:00Z', accepted_before: '2026-10-01T00:00:00Z' }]) assert.throws(() => data.messages(params(query)), e => e.status === 400);
});

test('admin pages authenticate every read, preserve security headers and keep separate navigation/content', async t => {
  const f = await web(t), a = register(f), b = register(f, f.b.entry);
  const message = f.store.send(f.a.entry, a.client_id, 1, randomUUID(), sendBody(b.client_id, 'PRIVATE-TEXT-ONLY-IN-DETAIL <script>evil()</script>'));
  for (const path of ['/admin', '/admin/approvals', '/admin/sessions', '/admin/messages', `/admin/messages/${message.message_id}`]) {
    const page = await f.page(path, false); assert.equal(page.status, 200); assert.match(page.html, /Administrator login/);
    assert.ok(!page.html.includes(a.client_id)); assert.ok(!page.html.includes('PRIVATE-TEXT-ONLY-IN-DETAIL'));
  }
  const sessions = await f.page('/admin/sessions'); assert.equal(sessions.status, 200);
  assert.match(sessions.html, /aria-current="page"[^>]*>[^]*Clients &amp; sessions|Clients & sessions/);
  assert.match(sessions.html, /Session identifiers/); assert.match(sessions.html, /transport observation/);
  assert.ok(!sessions.html.includes('data-message-id')); assert.ok(!sessions.html.includes('data-request-id'));
  const list = await f.page('/admin/messages'); assert.match(list.html, /data-message-id=/); assert.ok(!list.html.includes('PRIVATE-TEXT-ONLY-IN-DETAIL'));
  assert.ok(!list.html.includes('data-client-id=')); assert.ok(!list.html.includes('data-request-id='));
  const detail = await f.page(`/admin/messages/${message.message_id}`); assert.match(detail.html, /PRIVATE-TEXT-ONLY-IN-DETAIL &lt;script&gt;evil\(\)&lt;\/script&gt;/); assert.equal((detail.html.match(/<script>/g) ?? []).length, 1); assert.ok(!detail.html.includes('<script>evil()'));
  for (const page of [sessions, list, detail]) {
    assert.equal(page.headers.get('cache-control'), 'no-store'); assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    assert.match(page.headers.get('content-security-policy'), /default-src 'none'/); assert.match(page.headers.get('content-security-policy'), /form-action 'self'/);
    assert.ok(page.headers.get('content-security-policy').includes("script-src 'sha256-" + createHash('sha256').update(adminClient).digest('base64') + "'"));
    assert.match(page.headers.get('content-security-policy'), /connect-src 'self'/);
    assert.ok(!page.headers.get('content-security-policy').includes("script-src 'unsafe-inline'"));
    assert.ok(!page.html.includes(f.cookie)); assert.ok(!page.html.includes(f.a.token));
  }
});

test('admin handles escaping, empty/error/retained-content states and exposes installation rather than credential', async t => {
  const f = await web(t);
  assert.match((await f.page('/admin/sessions')).html, /No sessions found/);
  assert.match((await f.page('/admin/messages')).html, /No messages found/);
  assert.match((await f.page('/admin/approvals')).html, /No installation requests/);
  const a = register(f, f.a.entry, { metadata: { name: '<img src=x onerror=alert(1)>', model: { id: null, provider: null, source: 'unknown' }, project: '/private/path' } });
  const b = register(f, f.b.entry);
  const sessionPage = await f.page('/admin/sessions'); assert.match(sessionPage.html, /&lt;img src=x onerror=alert\(1\)&gt;/); assert.ok(!sessionPage.html.includes('<img')); assert.ok(!sessionPage.html.includes('/private/path'));
  const request = { request_id: randomUUID(), client_type: 'pi', label: '<svg/onload=alert(1)>' };
  f.approval.request(`Enrollment ${randomBytes(32).toString('base64url')}`, request);
  const result = f.approval.decide(request.request_id, 'approve');
  const approvals = await f.page('/admin/approvals'); assert.ok(approvals.html.includes(result.credential.adapter_id)); assert.ok(!approvals.html.includes(result.credential.credential_id)); assert.match(approvals.html, /&lt;svg\/onload=alert\(1\)&gt;/);
  const message = f.store.send(f.a.entry, a.client_id, 1, randomUUID(), sendBody(b.client_id));
  f.store.db.prepare('UPDATE messages SET envelope=NULL WHERE id=?').run(message.message_id);
  assert.match((await f.page(`/admin/messages/${message.message_id}`)).html, /Content is no longer retained/);
  for (const path of ['/admin/sessions?state=bogus', '/admin/messages?limit=101', '/admin/messages?limit=10&limit=10', '/admin/messages/not-uuid']) {
    const error = await f.page(path); assert.equal(error.status, 400); assert.match(error.html, /role="alert"/); assert.match(error.html, /Back to first page/);
  }
  const missing = await f.page(`/admin/messages/${randomUUID()}`); assert.equal(missing.status, 404); assert.match(missing.html, /No message content has been loaded/);
});

test('new read pages add no mutation routes and expired admin cookies reveal no metadata', async t => {
  const f = await web(t), a = register(f);
  const before = f.store.db.prepare('SELECT id,closed,lease_until FROM sessions WHERE id=?').get(a.client_id);
  for (const path of ['/admin/sessions', '/admin/messages', '/admin/approvals']) await f.page(path);
  assert.deepEqual(f.store.db.prepare('SELECT id,closed,lease_until FROM sessions WHERE id=?').get(a.client_id), before);
  const r = await fetch(f.base + '/admin/sessions', { method: 'POST', headers: { cookie: f.cookie, origin: f.base, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf: f.session.csrf }) });
  assert.equal(r.status, 404);
  f.store.db.prepare('UPDATE admin_sessions SET expires=0').run();
  const page = await f.page('/admin/sessions'); assert.match(page.html, /Administrator login/); assert.ok(!page.html.includes(a.client_id));
});


test('admin history high-water remains stable after purge and SQLite row-id reuse', t => {
  const f = fixture(t), a = register(f), b = register(f, f.b.entry), data = new AdminData(f.store);
  for (let i = 0; i < 3; i++) f.store.send(f.a.entry, a.client_id, 1, randomUUID(), sendBody(b.client_id));
  const first = data.messages(params({ limit: '1' }));
  f.store.db.exec('DELETE FROM sends; DELETE FROM messages;');
  f.store.send(f.a.entry, a.client_id, 1, randomUUID(), sendBody(b.client_id, 'new-after-purge'));
  assert.equal(data.messages(params({ limit: '1', cursor: first.next_cursor })).messages.length, 0);
});

test('admin metadata and status filters expose expired deadlines beyond the sweep batch', t => {
  const f = fixture(t, { limits: { send_burst: 300, principal_send_burst: 300 } }), a = register(f), b = register(f, f.b.entry), data = new AdminData(f.store);
  for (let i = 0; i < 210; i++) f.store.send(f.a.entry, a.client_id, 1, randomUUID(), sendBody(b.client_id, 'opaque', { ttl_seconds: 60 }));
  f.advance(60001);
  assert.equal(data.messages(params({ status: 'queued' })).messages.length, 0);
  const expired = data.messages(params({ status: 'expired', limit: '100' }));
  assert.equal(expired.messages.length, 100); assert.ok(expired.messages.every(m => m.delivery_state === 'expired'));
  assert.equal(data.message(expired.messages[0].message_id).delivery_state, 'expired');
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM messages WHERE state='queued'").get().n, 210, 'read projection does not write the registry or message lifecycle');
});

test('admin cursor expiry, timestamp calendar validation and safe participant names', t => {
  const f = fixture(t), a = register(f, f.a.entry, { metadata: { name: '<b>same-name</b>', model: { id: null, provider: null, source: 'unknown' }, project: null } }), b = register(f, f.b.entry), data = new AdminData(f.store);
  for (let i = 0; i < 2; i++) f.store.send(f.a.entry, a.client_id, 1, randomUUID(), sendBody(b.client_id));
  const page = data.messages(params({ limit: '1' })); assert.equal(page.messages[0].sender_name, '<b>same-name</b>'); assert.equal(page.messages[0].sender_type, 'pi');
  assert.throws(() => data.messages(params({ accepted_after: '2026-02-30T00:00:00Z' })), e => e.status === 400);
  f.advance(900001); assert.throws(() => data.messages(params({ limit: '1', cursor: page.next_cursor })), e => e.status === 400);
});

 test('session presentation omits provider without mutating protocol metadata', async t => {
  const f=await web(t);
  register(f,f.a.entry,{metadata:{name:'metadata-display',project:'shared-project',model:{provider:'provider-hidden-sentinel',id:'visible-model',source:'observed'}}});
  const page=await f.page('/admin/sessions');
  assert.equal(page.status,200);assert(page.html.includes('visible-model'));assert(page.html.includes('shared-project'));
  assert(!page.html.includes('provider-hidden-sentinel'));
  const listed=new AdminData(f.store).sessions(new URLSearchParams());
  assert.equal(listed.clients[0].model_provider,'provider-hidden-sentinel');
 });
