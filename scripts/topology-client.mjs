// Disposable transport probe, not a native harness. No inbound network listener.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { Inbox, newSessionIdentity } from '../reference/inbox.mjs';
import { BrokerClient } from '../reference/client.mjs';
import { AdapterRuntime } from '../reference/runtime.mjs';
import { TYPES } from '../src/protocol.mjs';
import { lookup } from 'node:dns/promises';
import { get } from 'node:https';

const config = JSON.parse(readFileSync(process.argv[2] ?? '/run/client/config.json'));
assert.ok(TYPES.includes(config.type));
assert.equal(new URL(config.url).protocol, 'https:');
const directory = config.data ?? '/data';
mkdirSync(directory, { recursive: true, mode: 0o700 });
const identityFile = join(directory, 'identity.json');
if (!existsSync(identityFile)) writeFileSync(identityFile, JSON.stringify(newSessionIdentity(config.type)), { mode: 0o600, flag: 'wx' });
const identity = JSON.parse(readFileSync(identityFile));
assert.equal(identity.client_type, config.type);
const inbox = new Inbox({ directory: join(directory, 'journal'), identity });
const client = new BrokerClient({ url: config.url, tokenFile: config.token, caFile: config.ca, inbox, requestTimeoutMs: 2000, maxAttempts: 3 });
const runtime = new AdapterRuntime({ client, verifySession: () => true, isAlive: () => true });
const metadata = { name: 'disposable-topology-probe', model: { provider: 'fixture', id: 'before', source: 'configured' }, project: null };
async function networkProbe() {
  const host = new URL(config.url).hostname;
  let timer;
  const dns = await Promise.race([lookup(host).then(value => ({ address: value.address }), reason => ({ error: reason.code })),
    new Promise(resolve => { timer = setTimeout(() => resolve({ error: 'timeout' }), 1500); })]);
  clearTimeout(timer);
  const https = await new Promise(resolve => {
    const request = get(new URL('/healthz', config.url), { ca: client.ca, agent: false, signal: AbortSignal.timeout(1500) }, response => {
      response.resume(); resolve({ status: response.statusCode });
    });
    request.on('error', reason => resolve({ error: reason.code }));
  });
  let neighbor = null;
  try {
    const row = readFileSync('/proc/net/arp', 'utf8').split('\n').map(line => line.trim().split(/\s+/)).find(row => row[0] === dns.address);
    if (row) neighbor = { mac: row[3], flags: row[2], device: row[5] };
  } catch {}
  return { dns, https, neighbor };
}
let closed = false;
async function close() {
  if (closed) return;
  closed = true;
  try { await client.disconnectSession(); } finally { inbox.close(); }
}
process.on('SIGTERM', () => close().then(() => process.exit(0), () => process.exit(1)));
try {
  let connected = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    try { await client.register(inbox.getState('metadata') ?? metadata); connected = true; break; }
    catch (error) { if (!['request_failed', 'not_ready'].includes(error.code)) throw error; await delay(100); }
  }
  assert.ok(connected, 'broker readiness timeout');
  process.stdout.write(JSON.stringify({ ready: true, uid: process.getuid(), identity, epoch: client.attachment.lease_epoch }) + '\n');
  for await (const line of createInterface({ input: process.stdin })) {
    const { id, command, args = {} } = JSON.parse(line);
    let value;
    try {
      if (command === 'send') {
        const key = client.prepareSend({ recipient_id: args.recipient, content: { type: 'text/plain', text: args.text } }, { key: args.key });
        value = await client.sendPrepared(key);
      } else if (command === 'probe') value = await networkProbe();
      else if (command === 'receive') value = await runtime.receiveOnce({ waitSeconds: 0 });
      else if (command === 'status') value = await client.messageStatus(args.message_id);
      else if (command === 'observe') {
        const row = inbox.db.prepare('SELECT state,envelope,native_receipt FROM inbox WHERE message_id=?').get(args.message_id);
        value = row ? { state: row.state, envelope: JSON.parse(row.envelope), native_receipt: row.native_receipt } : null;
      } else if (command === 'reconnect') value = await client.reconnect({ verifySession: () => true });
      else if (command === 'model') value = await client.updateMetadata({ model: { provider: 'fixture', id: args.id, source: 'configured' } });
      else if (command === 'list') value = await client.listClients({ connected: false });
      else if (command === 'close') { await close(); value = { closed: true }; }
      else throw Error('unknown_topology_command');
      process.stdout.write(JSON.stringify({ id, value }) + '\n');
    } catch (error) {
      // Disposable-fixture diagnostics only: no credential, message, path or
      // untrusted free-text output. A fresh no-auth TLS request isolates socket
      // reuse from DNS/network failure after an engine namespace restart.
      let diagnostics;
      if (error.code === 'request_failed') {
        diagnostics = await networkProbe();
      }
      process.stdout.write(JSON.stringify({ id, error: error.code ?? 'topology_probe_failed', diagnostics }) + '\n');
    }
    if (closed) break;
  }
} finally { await close(); }
