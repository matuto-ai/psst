// Disposable loopback-only broker for real-browser admin regression tests.
// stdout emits one JSON line containing ONLY synthetic fixture identities and a
// freshly issued test admin cookie. Never point this script at a real database.
import { randomUUID, randomBytes } from 'node:crypto';
import { fixture, registration, sendBody } from '../test/helpers.mjs';
import { ApprovalService } from '../src/approval.mjs';
import { AdminUI } from '../src/admin.mjs';
import { createBrokerServer } from '../src/server.mjs';

const cleanups = [], f = fixture({ after: fn => cleanups.push(fn) }, { limits: { send_burst: 100 } });
let app, stopping;
async function close() {
  if (stopping) return stopping;
  stopping = (async () => {
    try { if (app) await app.close(); }
    finally { for (const cleanup of cleanups.reverse()) await cleanup(); }
  })();
  return stopping;
}
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { close().catch(error => { console.error(error); process.exitCode = 1; }); });
try {
  // Fake time advances only while seeding, then stays fixed through the browser run.
  f.advance(9 * 86400000);
  const approval = await ApprovalService.create({ store: f.store });
  const admin = await AdminUI.create({ approval, auth: f.auth, password: 'synthetic-browser-only-password', insecureDevelopment: true });
  const names = ['Atlas', 'atlas', 'Boreal', 'Cedar', 'Delta', 'Echo', 'Finch', 'Grove', 'Harbor', 'Iris', 'Juniper', 'Kestrel', 'Lumen', 'Maple', 'North', 'Orchid', 'Pine', 'Quartz', 'River', 'Spruce', 'Tern', 'Umber', 'Vale', 'Willow', 'Offline review', 'Offline build', 'Offline notes', 'Closed task', 'Closed review'];
  const clients = [];
  for (const [n, name] of names.entries()) {
    const type = ['pi', 'claude-code', 'opencode', 'antigravity-cli'][n % 4], owner = n % 3 ? f.a.entry : f.b.entry;
    const input = registration(type, { metadata: { name, model: { id: n % 2 ? 'GPT fixture' : 'Claude fixture', provider: n % 2 ? 'OpenAI' : 'Anthropic', source: 'configured' }, project: n % 5 ? 'Synthetic QA' : '/private/synthetic/project' } });
    f.store.register(owner, input);
    clients.push({ client_id: input.client_id, installation_id: owner.adapter_id, name, client_type: type, owner });
    f.advance(1000);
  }
  const messages = [];
  for (let n = 0; n < 23; n++) {
    const text = `SYNTHETIC-DETAIL-ONLY ${n}\nThis body loads only on the message detail page. <script>text, not code</script>`;
    const result = f.store.send(clients[0].owner, clients[0].client_id, 1, randomUUID(), sendBody(clients[1].client_id, text));
    if (n % 5 === 0) f.store.cancel(clients[0].owner, clients[0].client_id, 1, result.message_id);
    // Display-only seeded terminal states. Browser reads still use real HTTP handlers.
    else if (n % 3 === 0) f.store.db.prepare("UPDATE messages SET state='delivered',attempts=1,delivered_at=?,terminal_at=? WHERE id=?").run(f.now, f.now, result.message_id);
    messages.push({ message_id: result.message_id, accepted_at: result.accepted_at, text });
    f.advance(1000);
  }
  for (let n = 24; n < 27; n++) f.store.disconnect(clients[n].owner, clients[n].client_id, 1);
  for (let n = 27; n < clients.length; n++) f.store.closeSession(clients[n].owner, clients[n].client_id, 1);
  const approvals = [];
  for (let n = 0; n < 4; n++) {
    const request = { request_id: randomUUID(), client_type: ['pi', 'claude-code', 'opencode', 'antigravity-cli'][n], label: ['QA laptop', 'QA workstation', 'QA terminal', 'QA retired installation'][n] };
    approval.request(`Enrollment ${randomBytes(32).toString('base64url')}`, request);
    if (n > 1) approval.decide(request.request_id, 'approve');
    if (n === 3) approval.decide(request.request_id, 'revoke');
    approvals.push({ ...request, state: n < 2 ? 'pending' : n === 2 ? 'approved' : 'revoked' });
  }
  app = createBrokerServer({ store: f.store, auth: f.auth, approval, admin, host: '127.0.0.1', port: 0, insecureDevelopment: true });
  const address = await app.listen(), origin = `http://127.0.0.1:${address.port}`, session = admin.issue(true);
  const state = new Map(admin.data.sessions(new URLSearchParams({ state: 'all', limit: '100' })).clients.map(client => [client.client_id, client.presence_state]));
  console.log(JSON.stringify({ origin, cookie: `psst_admin=${session.cookie}`, cookie_value: session.cookie, fallback_cookie: admin.issue(true).cookie, observed_at: new Date(f.now).toISOString(),
    clients: clients.map(({ owner: _owner, ...client }) => ({ ...client, state: state.get(client.client_id) })), messages, approvals,
    counts: { connected: 24, disconnected: 3, closed: 2, messages: 23 } }));
} catch (error) {
  await close(); throw error;
}
