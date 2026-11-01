import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, registration } from './helpers.mjs';
import { AdminData, ADMIN_PAGE_BYTES } from '../src/admin-data.mjs';

const params = value => new URLSearchParams(value);
const ids = page => page.clients.map(client => client.client_id);
function register(f, n, name, type = 'pi') {
  const input = registration(type, {
    client_id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    metadata: { name, model: { provider: null, id: null, source: 'unknown' }, project: null },
  });
  f.store.register(f.a.entry, input);
  return input.client_id;
}
function collect(data, query = {}) {
  const clients = []; let cursor;
  do {
    const page = data.sessions(params({ ...query, ...(cursor ? { cursor } : {}) }));
    assert.ok(page.clients.length <= Number(query.limit ?? 10));
    assert.ok(Buffer.byteLength(JSON.stringify(page.clients)) <= ADMIN_PAGE_BYTES);
    clients.push(...page.clients); cursor = page.next_cursor;
  } while (cursor);
  return clients;
}

test('session defaults show connected agents by name; explicit All preserves closed and disconnected', t => {
  const f = fixture(t), data = new AdminData(f.store);
  const z = register(f, 1, 'Zulu'), a = register(f, 2, 'Alpha'), offline = register(f, 3, 'A disconnected'), closed = register(f, 4, 'A closed');
  f.store.disconnect(f.a.entry, offline, 1);
  f.store.closeSession(f.a.entry, closed, 1);
  const page = data.sessions(params());
  assert.deepEqual(ids(page), [a, z]);
  assert.deepEqual(page.query, { state: 'connected', sort: 'name', direction: 'asc', limit: '10' });
  assert.ok(page.clients.every(client => client.connected && client.observed_at === page.server_time));
  assert.deepEqual(ids(data.sessions(params({ state: 'all' }))), [closed, offline, a, z]);
  assert.deepEqual(ids(data.sessions(params({ state: 'disconnected' }))), [offline]);
  assert.deepEqual(ids(data.sessions(params({ state: 'closed' }))), [closed]);
  f.advance(180000);
  assert.equal(data.sessions(params()).clients.length, 0);
  assert.equal(data.sessions(params({ state: 'all' })).clients.length, 4);
});

test('case-insensitive name sort uses only ascending client-ID ties in either direction', t => {
  const f = fixture(t), data = new AdminData(f.store);
  const beta = register(f, 1, 'Beta'), alpha2 = register(f, 3, 'alpha'), alpha1 = register(f, 2, 'ALPHA'), omega = register(f, 4, 'omega');
  assert.deepEqual(ids(data.sessions(params())), [alpha1, alpha2, beta, omega]);
  assert.deepEqual(ids(data.sessions(params({ direction: 'desc' }))), [omega, beta, alpha1, alpha2]);
  // All does not silently group connected sessions ahead of a lower name.
  f.store.disconnect(f.a.entry, alpha1, 1);
  assert.deepEqual(ids(data.sessions(params({ state: 'all' }))), [alpha1, alpha2, beta, omega]);
});

test('type, state and heartbeat are explicit sortable columns with no hidden name ordering', t => {
  const f = fixture(t), data = new AdminData(f.store);
  const a = register(f, 1, 'Zulu', 'pi'), b = register(f, 2, 'Alpha', 'opencode'), c = register(f, 3, 'Charlie', 'claude-code'), d = register(f, 4, 'Beta', 'pi');
  f.store.disconnect(f.a.entry, b, 1); f.store.closeSession(f.a.entry, c, 1);
  f.store.db.prepare('UPDATE sessions SET heartbeat_at=? WHERE id=?').run(f.now - 2000, a);
  f.store.db.prepare('UPDATE sessions SET heartbeat_at=? WHERE id=?').run(f.now - 1000, b);
  f.store.db.prepare('UPDATE sessions SET heartbeat_at=? WHERE id=?').run(f.now - 3000, c);
  const rows = (sort, direction = 'asc') => collect(data, { state: 'all', sort, direction, limit: '1' }).map(client => client.client_id);
  assert.deepEqual(rows('type'), [c, b, a, d]);
  assert.deepEqual(rows('type', 'desc'), [a, d, b, c]);
  assert.deepEqual(rows('state'), [a, d, b, c]);
  assert.deepEqual(rows('state', 'desc'), [c, b, a, d]);
  assert.deepEqual(rows('heartbeat'), [c, a, b, d]);
  assert.deepEqual(rows('heartbeat', 'desc'), [d, b, a, c]);
});

test('name keyset pages repeat neither IDs nor equal-folded names and normalize explicit defaults', t => {
  const f = fixture(t), data = new AdminData(f.store), expected = [];
  for (let n = 35; n > 0; n--) expected.push(register(f, n, n % 2 ? 'Same agent' : 'SAME AGENT'));
  expected.sort();
  assert.deepEqual(collect(data).map(client => client.client_id), expected);
  assert.deepEqual(collect(data, { direction: 'desc', limit: '3' }).map(client => client.client_id), expected);
  const first = data.sessions(params());
  assert.deepEqual(ids(data.sessions(params({ cursor: first.next_cursor, state: 'connected', sort: 'name', direction: 'asc', limit: '10' }))), expected.slice(10, 20));
});

test('literal case-insensitive name prefix escapes SQL wildcards and retains exact ID filters', t => {
  const f = fixture(t), data = new AdminData(f.store);
  const literal = register(f, 1, 'Agent_%\\label'), other = register(f, 2, 'AgentXYZ'), quoted = register(f, 3, "x' OR 1=1 --");
  assert.deepEqual(ids(data.sessions(params({ name: 'aGeNt_%\\' }))), [literal]);
  assert.deepEqual(ids(data.sessions(params({ name: "x' OR 1=1" }))), [quoted]);
  assert.deepEqual(ids(data.sessions(params({ name: 'agent', client_id: other }))), [other]);
  assert.equal(data.sessions(params({ name: 'missing' })).clients.length, 0);
  assert.equal(data.sessions(params({ name: '😀'.repeat(256) })).clients.length, 0);
});

test('session cursors bind every normalized sort/filter, reject tampering and retain expiry', t => {
  const f = fixture(t), data = new AdminData(f.store);
  for (let n = 1; n <= 3; n++) register(f, n, 'Agent');
  const first = data.sessions(params({ limit: '1' }));
  const base = { cursor: first.next_cursor, limit: '1' };
  for (const change of [{ state: 'all' }, { sort: 'type' }, { direction: 'desc' }, { name: 'Agent' }, { client_type: 'pi' }, { client_id: first.clients[0].client_id }, { installation_id: f.a.entry.adapter_id }, { limit: '2' }, { cursor: first.next_cursor + 'x' }]) {
    assert.throws(() => data.sessions(params({ ...base, ...change })), error => error.status === 400, JSON.stringify(change));
  }
  f.advance(900001);
  assert.throws(() => data.sessions(params(base)), error => error.status === 400);
});

test('session inputs reject invalid sorting, duplicate fields, malformed filters and controls', t => {
  const f = fixture(t), data = new AdminData(f.store);
  for (const query of [{ sort: 'id' }, { sort: '__proto__' }, { direction: 'DESC' }, { state: 'any' }, { name: 'x'.repeat(257) }, { name: 'bad\nname' }, { name: 'bad\0name' }, { client_id: 'partial-id' }, { installation_id: '../secret' }, { limit: '101' }, { unknown: '1' }]) {
    assert.throws(() => data.sessions(params(query)), error => error.status === 400, JSON.stringify(query));
  }
  for (const raw of ['sort=name&sort=name', 'name=foo&name=bar', 'state=all&state=connected']) assert.throws(() => data.sessions(params(raw)), error => error.status === 400);
});

test('changed page anchor requires explicit restart; fresh requests remain a live registry', t => {
  const f = fixture(t), data = new AdminData(f.store);
  const a = register(f, 1, 'Alpha'); register(f, 2, 'Beta');
  const first = data.sessions(params({ limit: '1' }));
  f.store.metadata(f.a.entry, a, 1, { expected_metadata_revision: 1, metadata_patch: { name: 'Zulu' } });
  assert.throws(() => data.sessions(params({ cursor: first.next_cursor, limit: '1' })), error => error.status === 409 && error.code === 'registry_changed' && /restart/.test(error.action));
  assert.equal(data.sessions(params()).clients.at(-1).name, 'Zulu');
  const live = data.sessions(params({ limit: '1', state: 'all', sort: 'state' }));
  f.advance(180000);
  assert.throws(() => data.sessions(params({ cursor: live.next_cursor, limit: '1', state: 'all', sort: 'state' })), error => error.status === 409);
});

test('session list and readable cursor do not leak private sort labels or credentials; store survives reopen', t => {
  const f = fixture(t), data = new AdminData(f.store);
  const id = register(f, 1, '/home/private/secret-project'); register(f, 2, 'Zulu');
  const first = data.sessions(params({ limit: '1' }));
  assert.equal(first.clients[0].client_id, id);
  assert.equal(first.clients[0].name, '[private path hidden]');
  const readable = Buffer.from(first.next_cursor.split('.')[0], 'base64url').toString('utf8');
  const serialized = JSON.stringify(first) + readable;
  for (const forbidden of ['/home/private', f.a.token, f.a.entry.token_sha256, 'credential', 'connection_id', 'session_instance_id', 'capabilities', 'envelope', 'content']) assert.ok(!serialized.includes(forbidden), forbidden);
  // Query-only label functions never become a dependency of persisted indexes or store writes.
  f.restart();
  register(f, 3, 'After restart');
  assert.equal(new AdminData(f.store).sessions(params({ state: 'all' })).clients.length, 3);
});


test('prefix filtering and sorting use only visible labels, never hidden path values', t => {
  const f = fixture(t), data = new AdminData(f.store);
  const paths = ['/home/private/secret', 'C:\\Users\\hidden', '\\\\server\\secret', '~/private', 'file:///private', 'project at /Users/private'];
  const hidden = paths.map((name, n) => register(f, n + 1, name));
  const visible = register(f, 20, 'Alpha'), visiblePathLike = register(f, 21, 'team/project-label');
  for (const name of paths) assert.equal(data.sessions(params({ name })).clients.length, 0, name);
  assert.deepEqual(ids(data.sessions(params({ name: '[private path hidden]' }))), hidden);
  assert.deepEqual(ids(data.sessions(params())), [...hidden, visible, visiblePathLike]);
  assert.deepEqual(ids(data.sessions(params({ direction: 'desc' }))), [visiblePathLike, visible, ...hidden]);
});

test('public-name projection handles legacy empty names and multiple AdminData instances safely', t => {
  const f = fixture(t), first = new AdminData(f.store);
  const empty = register(f, 1, 'Empty placeholder'), missing = register(f, 2, 'Missing placeholder'), accentUpper = register(f, 3, 'Ágata'), accentLower = register(f, 4, 'ágata');
  f.store.db.prepare("UPDATE sessions SET metadata=json_set(metadata,'$.name','') WHERE id=?").run(empty);
  f.store.db.prepare("UPDATE sessions SET metadata=json_remove(metadata,'$.name') WHERE id=?").run(missing);
  const second = new AdminData(f.store);
  assert.deepEqual(ids(first.sessions(params())), [empty, missing, accentUpper, accentLower]);
  assert.deepEqual(ids(second.sessions(params())), [empty, missing, accentUpper, accentLower]);
  assert.equal(first.sessions(params()).clients[0].name, null);
  // SQLite's built-in lower/LIKE is ASCII-insensitive, not locale-aware Unicode collation.
  assert.deepEqual(ids(second.sessions(params({ name: 'Ág' }))), [accentUpper]);
  assert.deepEqual(ids(second.sessions(params({ name: 'ág' }))), [accentLower]);
});
