// Disposable synthetic HTML fixtures for local visual QA, not a deployment or live admin session.
// node scripts/admin-ui-preview.mjs /absolute/empty/output-directory
import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { fixture, registration, sendBody } from '../test/helpers.mjs';
import { ApprovalService } from '../src/approval.mjs';
import { AdminUI } from '../src/admin.mjs';
import { document, loginPage, sessionsPage, messagesPage, messagePage, approvalsPage, errorPage } from '../src/admin-pages.mjs';

if (!process.argv[2]) throw Error('Supply an output directory for disposable synthetic HTML.');
const root = resolve(process.argv[2]), output = join(root, 'dist');
mkdirSync(output, { recursive: true }); mkdirSync(join(root, '.openai'), { recursive: true });
const cleanups = [], f = fixture({ after: fn => cleanups.push(fn) }, { limits: { send_burst: 100 } });
f.advance(9 * 86400000);
try {
  const approval = await ApprovalService.create({ store: f.store });
  const password = 'synthetic-browser-only-password';
  const admin = await AdminUI.create({ approval, auth: f.auth, password, insecureDevelopment: true });
  const names = ['Transport QA', 'Release notes', 'Protocol review', 'Local workspace', 'Integration checks', 'Registry review'];
  const clients = [];
  for (let i = 0; i < 14; i++) {
    const type = ['pi', 'claude-code', 'opencode', 'antigravity-cli'][i % 4], owner = i % 3 ? f.a.entry : f.b.entry;
    const input = registration(type, { metadata: { name: names[i % names.length], model: { id: i % 2 ? 'GPT-6.1' : 'Claude Sonnet', provider: i % 2 ? 'OpenAI' : 'Anthropic', source: 'observed' }, project: i % 5 ? 'psst / transport' : '/private/synthetic/project' } });
    f.store.register(owner, input); clients.push({ ...input, owner });
  }
  for (let i = 0; i < 23; i++) {
    const msg = f.store.send(clients[0].owner, clients[0].client_id, 1, randomUUID(), sendBody(clients[1].client_id, `SYNTHETIC-DETAIL-ONLY ${i}\nOriginal opaque message. <script>must remain text</script>`));
    if (i % 3 === 0) f.store.db.prepare("UPDATE messages SET state='delivered',attempts=1 WHERE id=?").run(msg.message_id);
    if (i % 5 === 0) f.store.db.prepare('UPDATE messages SET uncertain=1,attempts=2 WHERE id=?').run(msg.message_id);
  }
  for (let i = 2; i < clients.length; i += 3) f.store.db.prepare('UPDATE sessions SET lease_until=0 WHERE id=?').run(clients[i].client_id);
  f.store.db.prepare('UPDATE sessions SET closed=1,lease_until=0 WHERE id=?').run(clients.at(-1).client_id);
  for (let i = 0; i < 4; i++) {
    const request = { request_id: randomUUID(), client_type: ['pi', 'claude-code', 'opencode', 'pi'][i], label: ['Development laptop', 'Workspace connector', 'Release workstation', 'Previous installation'][i] };
    approval.request(`Enrollment ${randomBytes(32).toString('base64url')}`, request);
    if (i > 0) approval.decide(request.request_id, 'approve');
    if (i === 3) approval.decide(request.request_id, 'revoke');
  }
  const snapshotSession = { csrf: 'synthetic-csrf-not-a-real-session' };
  for (const [name, content, active] of [
    ['login', loginPage(snapshotSession.csrf), null],
    ['sessions', sessionsPage(admin.data.sessions(new URLSearchParams())), 'sessions'],
    ['messages', messagesPage(admin.data.messages(new URLSearchParams())), 'messages'],
    ['message-detail', messagePage(admin.data.message(admin.data.messages(new URLSearchParams()).messages[0].message_id)), 'messages'],
    ['approvals', approvalsPage(approval.list({ limit: 100 }), 0, snapshotSession), 'approvals'],
    ['messages-empty', messagesPage(admin.data.messages(new URLSearchParams({ sender_id: randomUUID() }))), 'messages'],
    ['filters-error', errorPage(400, '/admin/messages'), 'messages']
  ]) writeFileSync(join(output, name + '.html'), document(content, { active, csrf: snapshotSession.csrf }));

  copyFileSync(join(output, 'sessions.html'), join(output, 'index.html'));
  writeFileSync(join(root, '.openai', 'hosting.json'), JSON.stringify({ static: { directory: 'dist' } }) + '\n');
  console.log('Synthetic static HTML written to ' + output + '. No live session, credentials or service retained.');
} finally { for (const fn of cleanups.reverse()) await fn(); }
