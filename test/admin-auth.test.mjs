import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.mjs';
import { ApprovalService } from '../src/approval.mjs';
import { AdminUI } from '../src/admin.mjs';
import { adminRequest } from './admin-request.mjs';

async function setup(t) {
  const f = fixture(t);
  const approval = await ApprovalService.create({ store: f.store });
  const password = 'synthetic-password-only-123456';
  const admin = await AdminUI.create({ approval, auth: f.auth, password, insecureDevelopment: true, sessionMs: 1000 });
  return { ...f, admin, password };
}

test('admin login rejects origin/CSRF/password errors, rotates session and expires authenticated access', async t => {
  const f = await setup(t);
  const guest = f.admin.issue(false), cookie = `psst_admin=${guest.cookie}`;
  const post = (path, body, selectedCookie = cookie, origin = 'http://admin.test') => adminRequest(f.admin, path, {
    method: 'POST', headers: { cookie: selectedCookie, origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body),
  });
  for (const origin of ['https://evil.example', 'null']) assert.equal((await post('/admin/login', { csrf: guest.csrf, password: f.password }, cookie, origin)).status, 403);
  assert.equal((await post('/admin/login', { csrf: 'wrong', password: f.password })).status, 403);
  assert.equal((await post('/admin/login', { csrf: guest.csrf, password: 'wrong' })).status, 401);
  const login = await post('/admin/login', { csrf: guest.csrf, password: f.password });
  assert.equal(login.status, 303);
  const authenticatedCookie = login.headers.get('set-cookie').split(';')[0];
  assert.notEqual(authenticatedCookie, cookie);
  assert.equal(f.admin.session({ headers: { cookie } }), null);
  const session = f.admin.session({ headers: { cookie: authenticatedCookie } });
  assert.equal(session.authenticated, 1);
  f.advance(1001);
  assert.equal((await post('/admin/logout', { csrf: session.csrf }, authenticatedCookie)).status, 403);
  assert.equal(f.admin.session({ headers: { cookie: authenticatedCookie } }), null);
});

test('admin logout invalidates only the selected admin session', async t => {
  const f = await setup(t), session = f.admin.issue(true), other = f.admin.issue(true), cookie = `psst_admin=${session.cookie}`;
  const response = await adminRequest(f.admin, '/admin/logout', { method: 'POST', headers: { cookie, origin: 'http://admin.test', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf: session.csrf }) });
  assert.equal(response.status, 303);
  assert.equal(f.admin.session({ headers: { cookie } }), null);
  assert.match(response.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal(f.admin.session({ headers: { cookie: `psst_admin=${other.cookie}` } }).authenticated, 1);
});

test('admin login bounds the address map and rechecks the KDF gate after reading input', async t => {
  const f = await setup(t);
  for (let i = 0; i < 1000; i++) f.admin.loginRate({ socket: { remoteAddress: String(i) } });
  assert.throws(() => f.admin.loginRate({ socket: { remoteAddress: 'overflow' } }), e => e.status === 429);
  assert.equal(f.admin.loginAttempts.size, 1000);
  f.admin.loginAttempts.clear();
  const session = f.admin.issue(false), cookie = `psst_admin=${session.cookie}`;
  f.admin.input = async () => { f.admin.activeLogins = 2; return { csrf: session.csrf, password: f.password }; };
  const result = await adminRequest(f.admin, '/admin/login', { method: 'POST', headers: { cookie, origin: 'http://admin.test' } });
  assert.equal(result.status, 429);
  assert.equal(f.admin.activeLogins, 2);
});
