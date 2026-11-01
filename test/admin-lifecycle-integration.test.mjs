import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, registration, sendBody } from './helpers.mjs';
import { ApprovalService } from '../src/approval.mjs';
import { AdminUI } from '../src/admin.mjs';
import { createBrokerServer } from '../src/server.mjs';

async function composed(t) {
  const f = fixture(t, { limits: { send_burst: 100 } });
  const approval = await ApprovalService.create({ store: f.store });
  const password = 'synthetic-composed-http-password';
  const admin = await AdminUI.create({ approval, auth: f.auth, password, insecureDevelopment: true });
  const app = createBrokerServer({ store: f.store, auth: f.auth, approval, admin, host: '127.0.0.1', port: 0, insecureDevelopment: true });
  const address = await app.listen(), base = `http://127.0.0.1:${address.port}`; t.after(() => app.close());
  const page = await fetch(base + '/admin/sessions'), loginHtml = await page.text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(loginHtml)[1], guestCookie = page.headers.get('set-cookie').split(';')[0];
  const login = await fetch(base + '/admin/login', { method: 'POST', redirect: 'manual', headers: { cookie: guestCookie, origin: base, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, password }) });
  assert.equal(login.status, 303); const cookie = login.headers.get('set-cookie').split(';')[0]; assert.notEqual(cookie, guestCookie);
  return { ...f, admin,
    async api(path, { method = 'GET', owner = f.a, id, epoch = 1, key, body } = {}) {
      const response = await fetch(base + path, { method, headers: { Authorization: `Bearer ${owner.token}`, ...(id ? { 'X-Client-ID': id, 'X-Lease-Epoch': String(epoch) } : {}), ...(key ? { 'Idempotency-Key': key } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      const text = await response.text(); return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
    },
    async html(path) { const response = await fetch(base + path, { headers: { cookie } }); return { status: response.status, text: await response.text() }; },
  };
}

test('composed HTTP admin reflects offline acceptance, cancelled/resend identity, notice suppression and resumed delivery', async t => {
  const f = await composed(t), a = registration(), sibling = registration(), b = registration();
  for (const [input, owner] of [[a, f.a], [sibling, f.a], [b, f.b]]) assert.equal((await f.api('/v1/sessions', { method: 'POST', owner, body: input })).status, 200);
  const initial = await f.html('/admin/sessions'); assert.equal(initial.status, 200);
  for (const input of [a, sibling, b]) assert.ok(initial.text.includes(`data-client-id="${input.client_id}"`));
  assert.equal((initial.text.match(/class="name">same-name/g) ?? []).length, 3, 'same names remain independent session rows');
  const disconnected = await f.api(`/v1/sessions/${b.client_id}/disconnect`, { method: 'POST', owner: f.b, id: b.client_id, body: {} });
  assert.equal(disconnected.body.presence_state, 'disconnected'); assert.equal(disconnected.body.connected, false);
  assert.ok(!(await f.api('/v1/clients')).body.clients.some(row => row.client_id === b.client_id));
  assert.equal((await f.api('/v1/clients?connected=false')).body.clients.find(row => row.client_id === b.client_id).presence_state, 'disconnected');
  const offline = await f.html('/admin/sessions?state=all&client_id=' + b.client_id); assert.match(offline.text, /state-disconnected/); assert.match(offline.text, /Offline · resumable identity/);

  const originalText = 'COMPOSED-OPAQUE-CONTENT <script>not authority</script>', operation = randomUUID();
  const sent = await f.api('/v1/messages', { method: 'POST', id: a.client_id, key: operation, body: sendBody(b.client_id, originalText) });
  assert.equal(sent.status, 202); assert.equal(sent.body.recipient_connected_at_acceptance, false);
  const replay = await f.api('/v1/messages', { method: 'POST', id: a.client_id, key: operation, body: sendBody(b.client_id, originalText) });
  assert.equal(replay.body.message_id, sent.body.message_id); assert.equal(replay.headers.get('idempotency-replayed'), 'true');
  const queue = await f.html('/admin/messages?recipient_id=' + b.client_id + '&status=queued');
  assert.ok(queue.text.includes(sent.body.message_id)); assert.ok(!queue.text.includes(originalText)); assert.ok(!queue.text.includes('COMPOSED-OPAQUE-CONTENT'));
  const history = await f.api('/v1/messages', { id: a.client_id }); assert.equal(history.status, 200); assert.ok(!JSON.stringify(history.body).includes('COMPOSED-OPAQUE-CONTENT'));
  assert.equal((await f.api('/v1/messages', { id: sibling.client_id })).body.messages.length, 0, 'shared installation does not share outgoing ownership');
  const cancelled = await f.api(`/v1/messages/${sent.body.message_id}/cancel`, { method: 'POST', id: a.client_id, body: {} });
  assert.equal(cancelled.body.delivery_state, 'cancelled'); assert.equal(cancelled.body.delivery_may_have_occurred, false);
  assert.ok((await f.html('/admin/messages?status=cancelled')).text.includes(sent.body.message_id));
  assert.match((await f.html('/admin/messages/' + sent.body.message_id)).text, /COMPOSED-OPAQUE-CONTENT &lt;script&gt;not authority&lt;\/script&gt;/);

  const resent = await f.api(`/v1/messages/${sent.body.message_id}/resend`, { method: 'POST', id: a.client_id, key: randomUUID(), body: {} });
  assert.equal(resent.status, 202); assert.notEqual(resent.body.message_id, sent.body.message_id); assert.equal(resent.body.resent_from_message_id, sent.body.message_id);
  assert.equal((await f.api(`/v1/messages/${resent.body.message_id}/content`, { id: a.client_id })).body.envelope.content.text, originalText);
  f.advance(600000);
  const notices = await f.api('/v1/presence-events?limit=10', { id: a.client_id }); assert.equal(notices.status, 200);
  assert.equal(notices.body.events.length, 1); assert.deepEqual(notices.body.events[0].messages.map(m => m.message_id), [resent.body.message_id]);
  assert.ok(!JSON.stringify(notices.body).includes('COMPOSED-OPAQUE-CONTENT'));
  assert.equal((await f.api('/v1/presence-events', { id: a.client_id })).body.events[0].event_id, notices.body.events[0].event_id);
  assert.match((await f.html('/admin/sessions?state=all&client_id=' + a.client_id)).text, /state-disconnected/, 'fresh admin read does not present the expired sender lease as active');
  assert.equal((await f.api('/v1/sessions', { method: 'POST', body: { ...a, previous_epoch: 1, connection_id: randomUUID() } })).body.lease_epoch, 2);
  assert.equal((await f.api(`/v1/messages/${resent.body.message_id}/cancel`, { method: 'POST', id: a.client_id, epoch: 2, body: {} })).body.delivery_state, 'cancelled');
  assert.deepEqual((await f.api('/v1/presence-events', { id: a.client_id })).body.events, [], 'no stale notice after cancellation removes all relevant pending mail');
  assert.equal((await f.api('/v1/sessions', { method: 'POST', owner: f.b, body: { ...b, previous_epoch: 1, connection_id: randomUUID() } })).body.client_id, b.client_id);
  assert.match((await f.html('/admin/sessions?state=all&client_id=' + b.client_id)).text, /state-connected/);

  const fresh = await f.api('/v1/messages', { method: 'POST', id: a.client_id, epoch: 2, key: randomUUID(), body: sendBody(b.client_id, originalText) });
  const claim = await f.api('/v1/mailbox/claim', { method: 'POST', owner: f.b, id: b.client_id, epoch: 2, key: randomUUID(), body: {} });
  assert.equal(claim.body.envelope.message_id, fresh.body.message_id);
  const racingCancel = await f.api(`/v1/messages/${fresh.body.message_id}/cancel`, { method: 'POST', id: a.client_id, epoch: 2, body: {} });
  assert.equal(racingCancel.body.delivery_uncertain, true);
  const uncertainPage = await f.html('/admin/messages/' + fresh.body.message_id); assert.match(uncertainPage.text, /Delivery uncertain: recipient may already have received it/);
  const completed = await f.api(`/v1/mailbox/${fresh.body.message_id}/complete`, { method: 'POST', owner: f.b, id: b.client_id, epoch: 2, body: { claim_id: claim.body.claim_id, outcome: 'delivered' } });
  assert.equal(completed.body.delivery_state, 'delivered'); assert.equal(completed.body.delivery_uncertain, false);
  const finalPage = await f.html('/admin/messages/' + fresh.body.message_id); assert.match(finalPage.text, /state-delivered/); assert.ok(!finalPage.text.includes('Delivery uncertain: recipient may already have received it'));
});

test('composed HTTP explicit close stays distinct from graceful disconnect in registry and message admission', async t => {
  const f = await composed(t), a = registration(), b = registration();
  await f.api('/v1/sessions', { method: 'POST', body: a }); await f.api('/v1/sessions', { method: 'POST', owner: f.b, body: b });
  await f.api(`/v1/sessions/${b.client_id}/disconnect`, { method: 'POST', owner: f.b, id: b.client_id, body: {} });
  const closed = await f.api(`/v1/sessions/${b.client_id}/close`, { method: 'POST', owner: f.b, id: b.client_id, body: {} }); assert.equal(closed.status, 200);
  const page = await f.html('/admin/sessions?client_id=' + b.client_id + '&state=closed'); assert.ok(page.text.includes(b.client_id)); assert.match(page.text, /Terminally closed/);
  assert.ok(!(await f.html('/admin/sessions?client_id=' + b.client_id + '&state=disconnected')).text.includes('data-client-id='));
  const send = await f.api('/v1/messages', { method: 'POST', id: a.client_id, key: randomUUID(), body: sendBody(b.client_id) }); assert.equal(send.status, 410); assert.equal(send.body.error.code, 'session_closed');
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM messages').get().n, 0);
});
