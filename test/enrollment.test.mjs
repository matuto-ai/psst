import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, symlinkSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { enrollClients, parseArguments, CLIENT_TYPES } from '../scripts/enroll-clients.mjs';
import { CredentialStore } from '../src/auth.mjs';
import { BrokerStore } from '../src/store.mjs';
import { registration, sendBody } from './helpers.mjs';

function fixture(t) {
  const parent = mkdtempSync(join(tmpdir(), 'psst-enroll-test-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  return { parent, directory: join(parent, 'new'), brokerUrl: 'https://broker.example', createCredentials: true };
}
const json = path => JSON.parse(readFileSync(path, 'utf8'));

test('offline enrollment creates four isolated, private and usable credentials, no plaintext verifier', t => {
  const f = fixture(t);
  assert.deepEqual(enrollClients(f), { clients: 4, activationRequired: true });
  const file = join(f.directory, 'broker/credentials.json');
  const auth = new CredentialStore({ path: file });
  assert.equal(auth.ready, true);
  const tokens = new Set();
  for (const type of CLIENT_TYPES) {
    const dir = join(f.directory, 'clients', type);
    const token = readFileSync(join(dir, 'token'), 'utf8').trim();
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    tokens.add(token);
    const entry = auth.authenticate(`Bearer ${token}`);
    assert.deepEqual(entry.client_types, [type]);
    assert.deepEqual(entry.scopes, ['psst']);
    assert.equal(entry.token_sha256, createHash('sha256').update(token).digest('hex'));
    const config = json(join(dir, 'connection.json'));
    assert.equal(config.format, 'broker-client-bundle-v1');
    assert.equal(config.token_file, 'token');
    assert.equal(config.broker_url, 'https://broker.example');
    assert.deepEqual(config.allowed_client_types, [type]);
    assert.equal(config.insecure_development, false);
    assert.ok(!readFileSync(file, 'utf8').includes(token));
    assert.ok(!readFileSync(join(dir, 'connection.json'), 'utf8').includes(token));
  }
  assert.equal(tokens.size, 4);
  function permissions(path) {
    const info = statSync(path);
    assert.equal(info.mode & 0o777, info.isDirectory() ? 0o700 : 0o600);
    if (info.isDirectory()) for (const name of readdirSync(path)) permissions(join(path, name));
  }
  permissions(f.directory);
});

test('generated authorization supports each type, cross-family scoped delivery and rejects mismatched type', t => {
  const f = fixture(t); enrollClients(f);
  const auth = new CredentialStore({ path: join(f.directory, 'broker/credentials.json') });
  const store = new BrokerStore({ path: join(f.parent, 'state', 'broker.sqlite') });
  t.after(() => store.close());
  const clients = CLIENT_TYPES.map(type => {
    const token = readFileSync(join(f.directory, 'clients', type, 'token'), 'utf8').trim();
    const entry = auth.authenticate(`Bearer ${token}`);
    const request = registration(type);
    const session = store.register(entry, request);
    assert.throws(() => store.register(entry, registration(type === 'pi' ? 'opencode' : 'pi')), error => error.code === 'forbidden');
    return { entry, session };
  });
  for (let i = 0; i < clients.length; i++) {
    const sender = clients[i], recipient = clients[(i + 1) % clients.length];
    const receipt = store.send(sender.entry, sender.session.client_id, 1, `enrollment-${i}`, sendBody(recipient.session.client_id));
    assert.equal(receipt.delivery_state, 'queued');
  }
});

test('configuration points at existing data without opening, modifying or replacing it', t => {
  const f = fixture(t);
  const existing = join(f.parent, 'existing-data'); mkdirSync(existing, { mode: 0o700 });
  const database = join(existing, 'broker.sqlite'); writeFileSync(database, 'existing data sentinel');
  enrollClients(f);
  assert.equal(readFileSync(database, 'utf8'), 'existing data sentinel');
  assert.deepEqual(json(join(f.directory, 'broker/config.json')), { database: '/data/broker.sqlite', credential_file: '/run/broker/credentials.json', host: '0.0.0.0', port: 8787, proxy_transport: true });
  assert.ok(!existsSync(join(f.directory, 'broker.sqlite')));
  const oldToken = readFileSync(join(f.directory, 'clients/pi/token'), 'utf8');
  assert.throws(() => enrollClients(f), /destination_already_exists/);
  assert.equal(readFileSync(join(f.directory, 'clients/pi/token'), 'utf8'), oldToken);
});

test('invalid origins and missing explicit credential consent are rejected before any output', t => {
  const f = fixture(t);
  for (const brokerUrl of ['http://broker.example', 'https://user:password@broker.example', 'https://broker.example/api', 'https://broker.example/?token=abc', 'https://broker.example/#x', 'not a url']) {
    assert.throws(() => enrollClients({ ...f, brokerUrl }), /https_origin_required/);
    assert.ok(!existsSync(f.directory));
  }
  assert.throws(() => enrollClients({ ...f, createCredentials: false }), /explicit_create_credentials_required/);
  assert.throws(() => enrollClients({ ...f, scope: 'bad scope' }), /scope_invalid/);
  assert.throws(() => enrollClients({ ...f, directory: './relative' }), /absolute_private_directory_required/);
  assert.ok(!existsSync(f.directory));
});

test('public parents and symlink parents/destinations are refused without chmod or overwrite', t => {
  const f = fixture(t);
  const publicParent = join(f.parent, 'public'); mkdirSync(publicParent, { mode: 0o755 });
  assert.throws(() => enrollClients({ ...f, directory: join(publicParent, 'new') }), /private_parent_required/);
  assert.equal(statSync(publicParent).mode & 0o777, 0o755);
  const alias = join(f.parent, 'alias'); symlinkSync(f.parent, alias);
  assert.throws(() => enrollClients({ ...f, directory: join(alias, 'new') }), /private_parent_required/);
  symlinkSync(join(f.parent, 'absent'), f.directory);
  assert.throws(() => enrollClients(f), /destination_already_exists/);
  assert.ok(!existsSync(join(f.parent, 'absent')));
});

test('argument parser rejects unknown, missing and repeated flags', () => {
  for (const args of [['--unknown','x'], ['--directory'], ['--scope','a','--scope','b'], ['--create-credentials','--create-credentials'], ['--directory','--create-credentials']]) assert.throws(() => parseArguments(args), /arguments_invalid/);
  assert.deepEqual(parseArguments(['--directory','/private/new','--broker-url','https://broker.example','--scope','review','--create-credentials']), { directory:'/private/new', brokerUrl:'https://broker.example', scope:'review', createCredentials:true });
});
