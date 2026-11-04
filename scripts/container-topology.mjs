// Disposable same-host CI topology. No host ports, shared client journals or native-model claim.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { randomBytes, randomUUID, createHash } from 'node:crypto';

const execute = promisify(execFile), engine = process.argv[2], image = process.argv[3];
assert.ok(['docker', 'podman'].includes(engine));
assert.match(image ?? '', /^[a-zA-Z0-9][a-zA-Z0-9./:_@-]{0,255}$/);
const uid = process.getuid(), gid = process.getgid(); assert.ok(uid > 0);
const run = async args => (await execute(engine, args, { timeout: 30000, maxBuffer: 1024 * 1024 })).stdout.trim();
if (engine === 'podman') assert.equal(await run(['info', '--format', '{{.Host.Security.Rootless}}']), 'true');
const directory = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), 'psst-topology-'));
const prefix = `psst-topology-${randomBytes(6).toString('hex')}`, network = `${prefix}-net`, broker = `${prefix}-broker`;
const types = ['pi', 'antigravity-cli', 'claude-code', 'opencode'];
const brokerData = join(directory, 'broker-data'), brokerPrivate = join(directory, 'broker-private');
for (const path of [brokerData, brokerPrivate]) mkdirSync(path, { mode: 0o700 });
const peers = types.flatMap(type => [0, 1].map(index => ({ type, index, name: `${prefix}-${type}-${index}`,
  data: join(directory, `${type}-${index}-data`), private: join(directory, `${type}-${index}-private`) })));
const hardening = [...(engine === 'podman' ? ['--userns=keep-id'] : []), '--user', `${uid}:${gid}`,
  '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--network', network, '--pull=never'];
// Rootless engines mutate one shared unprivileged networking namespace. Avoid
// concurrent provisioning/teardown races; message exchange still runs concurrently.
async function lifecycle(items, operation) {
  if (engine === 'podman') { const values = []; for (const item of items) values.push(await operation(item)); return values; }
  return Promise.all(items.map(operation));
}
async function healthy(peers, phase) {
  for (const peer of peers) {
    const probe = await peer.call('probe');
    assert.ok(probe.dns.address, `${phase} ${peer.type} fresh name resolution: ${JSON.stringify(probe)}`);
    assert.equal(probe.https.status, 200, `${phase} ${peer.type} fresh verified TLS: ${JSON.stringify(probe)}`);
  }
}
const children = new Set(); let networkCreated = false, brokerAddress;
const startBroker = () => run(['run', '--detach', '--name', broker, '--network-alias', 'broker', ...hardening,
  '--volume', `${brokerData}:/data:rw`, '--volume', `${brokerPrivate}:/run/broker:ro`, image,
  ...(engine === 'podman' ? ['node', 'scripts/topology-broker-supervisor.mjs'] : [])]);
async function startPeer(peer) {
  const child = spawn(engine, ['run', '--interactive', '--name', peer.name, ...hardening,
    '--add-host', `broker:${brokerAddress}`,
    '--volume', `${peer.data}:/data:rw`, '--volume', `${peer.private}:/run/client:ro`, image, 'node', 'scripts/topology-client.mjs'],
  { stdio: ['pipe', 'pipe', 'pipe'] });
  children.add(child);
  let sequence = 0, stderr = '', resolveReady, rejectReady;
  const pending = new Map();
  const ready = new Promise((yes, no) => { resolveReady = yes; rejectReady = no; });
  const done = new Promise(resolve => child.once('close', resolve));
  const fail = error => { rejectReady(error); for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); } pending.clear(); };
  child.on('error', fail); child.stdin.on('error', fail);
  child.on('close', code => { children.delete(child); fail(Error(`topology ${peer.type} exited ${code}: ${stderr}`)); });
  child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-4096); });
  createInterface({ input: child.stdout }).on('line', line => {
    let response; try { response = JSON.parse(line); } catch { fail(Error('invalid topology control response')); return; }
    if (response.ready) { resolveReady(response); return; }
    const request = pending.get(response.id); if (!request) return;
    clearTimeout(request.timer); pending.delete(response.id);
    if (response.error) request.reject(Error(`topology ${peer.type} ${request.command}: ${response.error} ${JSON.stringify(response.diagnostics ?? {})}`)); else request.resolve(response.value);
  });
  const startup = setTimeout(() => fail(Error(`topology startup timeout: ${stderr}`)), 20000);
  let initial; try { initial = await ready; } finally { clearTimeout(startup); }
  assert.equal(initial.uid, uid, 'actual probe runs as the explicitly selected nonroot operator');
  peer.identity = initial.identity; peer.epoch = initial.epoch;
  peer.call = (command, args = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`topology ${command} timed out`)); }, 15000);
    pending.set(id, { resolve, reject, timer, command });
    child.stdin.write(JSON.stringify({ id, command, args }) + '\n');
  });
  peer.stop = async () => {
    await peer.call('close'); child.stdin.end();
    assert.equal(await done, 0); await run(['rm', peer.name]);
  };
}
try {
  await execute('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(brokerPrivate, 'key.pem'),
    '-out', join(brokerPrivate, 'cert.pem'), '-days', '1', '-subj', '/CN=broker', '-addext', 'subjectAltName=DNS:broker'], { timeout: 10000 });
  const credentials = [];
  for (const peer of peers) {
    for (const path of [peer.data, peer.private]) mkdirSync(path, { mode: 0o700 });
    const token = randomBytes(32).toString('base64url');
    credentials.push({ credential_id: peer.name, adapter_id: peer.name, principal_id: 'disposable-topology',
      client_types: [peer.type], scopes: ['topology'], token_sha256: createHash('sha256').update(token).digest('hex') });
    writeFileSync(join(peer.private, 'token'), token, { mode: 0o600 });
    copyFileSync(join(brokerPrivate, 'cert.pem'), join(peer.private, 'ca.pem'));
    writeFileSync(join(peer.private, 'config.json'), JSON.stringify({ type: peer.type, url: 'https://broker:8787',
      token: '/run/client/token', ca: '/run/client/ca.pem' }), { mode: 0o600 });
  }
  writeFileSync(join(brokerPrivate, 'credentials.json'), JSON.stringify({ credentials }), { mode: 0o600 });
  writeFileSync(join(brokerPrivate, 'config.json'), JSON.stringify({ database: '/data/broker.sqlite', credential_file: '/run/broker/credentials.json',
    host: '0.0.0.0', port: 8787, tls: { certFile: '/run/broker/cert.pem', keyFile: '/run/broker/key.pem' } }), { mode: 0o600 });
  await run(['network', 'create', '--internal', network]); networkCreated = true;
  await startBroker();
  brokerAddress = JSON.parse(await run(['inspect', broker]))[0].NetworkSettings.Networks[network].IPAddress;
  assert.match(brokerAddress, /^\d+\.\d+\.\d+\.\d+$/);
  await lifecycle(peers, startPeer);
  await healthy(peers, 'initial topology');
  assert.equal(new Set(peers.map(peer => peer.identity.client_id)).size, 8);
  const inspections = JSON.parse(await run(['inspect', broker, ...peers.map(peer => peer.name)]));
  for (const item of inspections) {
    assert.ok(!item.HostConfig?.PidMode || item.HostConfig.PidMode === 'private');
    assert.equal(Object.keys(item.HostConfig?.PortBindings ?? {}).length, 0);
    assert.equal(item.HostConfig.ReadonlyRootfs, true);
  }
  const networkInfo = JSON.parse(await run(['network', 'inspect', network]))[0];
  assert.equal(networkInfo.Internal ?? networkInfo.internal, true);
  const sent = [];
  async function send(sender, receiver, label) {
    const text = `disposable ${label} ${randomUUID()}`, key = randomUUID();
    const receipt = await sender.call('send', { recipient: receiver.identity.client_id, text, key });
    assert.ok(receipt.message_id); const item = { sender, receiver, receipt, text, key }; sent.push(item); return item;
  }
  async function verify(item) {
    assert.equal((await item.sender.call('status', { message_id: item.receipt.message_id })).delivery_state, 'delivered');
    const stored = await item.receiver.call('observe', { message_id: item.receipt.message_id });
    assert.equal(stored.state, 'pending'); assert.equal(stored.native_receipt, null);
    assert.equal(stored.envelope.sender.client_id, item.sender.identity.client_id);
    assert.equal(stored.envelope.recipient_id, item.receiver.identity.client_id);
    assert.equal(stored.envelope.content.text, item.text);
    assert.equal(stored.envelope.origin, 'broker_agent'); assert.equal(stored.envelope.authority, 'untrusted_agent_input');
  }
  for (const sender of peers.filter(peer => peer.index === 0)) {
    for (const receiver of peers.filter(peer => peer.index === 1)) await send(sender, receiver, `${sender.type} to ${receiver.type}`);
  }
  await Promise.all(peers.filter(peer => peer.index === 1).map(async peer => {
    for (let index = 0; index < 4; index++) assert.equal((await peer.call('receive')).stored, true);
    assert.equal(await peer.call('receive'), null);
  }));
  await Promise.all(sent.map(verify));
  for (const sender of peers.filter(peer => peer.index === 0)) {
    for (const item of sent) assert.equal(await sender.call('observe', { message_id: item.receipt.message_id }), null);
  }
  const receivers = peers.filter(peer => peer.index === 1), originalIds = receivers.map(peer => peer.identity.client_id);
  await lifecycle(receivers, peer => peer.stop());
  const offline = [];
  for (const receiver of receivers) {
    const sender = peers.find(peer => peer.type === receiver.type && peer.index === 0);
    const item = await send(sender, receiver, 'offline recipient'); offline.push(item);
    assert.equal(item.receipt.recipient_connected_at_acceptance, false);
  }
  await healthy(peers.filter(peer => peer.index === 0), 'before broker restart');
  if (engine === 'docker') {
    await run(['kill', '--signal', 'KILL', broker]); await run(['wait', broker]);
    await run(['start', broker]);
  } else {
    // The hosted Podman runtime loses surviving-peer connectivity when its
    // network namespace is replaced. Crash the actual production broker child
    // while retaining the namespace; do not call this container-runtime recovery.
    const state = ['exec', broker, 'node', '-e', "process.stdout.write(require('node:fs').readFileSync('/data/topology-process.json','utf8'))"];
    const before = JSON.parse(await run(state)); assert.equal(before.generation, 1);
    await run(['exec', broker, 'node', '-e', `process.kill(${before.pid}, 'SIGKILL')`]);
    const deadline = Date.now() + 5000;
    let after;
    while (Date.now() < deadline) {
      after = JSON.parse(await run(state)); if (after.generation === 2) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(after.generation, 2); assert.equal(after.previousExit, 'SIGKILL');
    assert.notEqual(after.pid, before.pid);
  }
  const afterAddress = JSON.parse(await run(['inspect', broker]))[0].NetworkSettings.Networks[network].IPAddress;
  assert.equal(afterAddress, brokerAddress, 'explicit service endpoint remains unchanged');
  for (const sender of peers.filter(peer => peer.index === 0)) await sender.call('reconnect');
  await healthy(peers.filter(peer => peer.index === 0), 'after broker restart before recipient recreation');
  await lifecycle(receivers, startPeer);
  assert.deepEqual(receivers.map(peer => peer.identity.client_id), originalIds);
  await healthy(peers, 'after recipient recreation');
  await Promise.all(receivers.map(async peer => { assert.equal((await peer.call('receive')).stored, true); }));
  await Promise.all(sent.map(verify));
  for (const item of offline) {
    const replay = await item.sender.call('send', { recipient: item.receiver.identity.client_id, text: item.text, key: item.key });
    assert.equal(replay.message_id, item.receipt.message_id);
  }
  const cycle = peers.filter(peer => peer.index === 0).slice(0, 3);
  const concurrent = await Promise.all(cycle.map((sender, index) => send(sender, cycle[(index + 1) % cycle.length], 'concurrent exchange')));
  await Promise.all(cycle.map(peer => peer.call('receive'))); await Promise.all(concurrent.map(verify));
  const modelPeer = cycle[0], identity = modelPeer.identity.client_id;
  await modelPeer.call('model', { id: 'after' });
  const listing = await modelPeer.call('list');
  assert.equal(listing.clients.find(peer => peer.client_id === identity).model.id, 'after');
  assert.equal(listing.clients.length, 8);
  await lifecycle(peers, peer => peer.stop());
  await run(['stop', '--time', '5', broker]);
  assert.equal(await run(['inspect', '--format', '{{.State.ExitCode}}', broker]), '0');
  console.log(JSON.stringify({ result: 'passed', engine, topology: 'eight separate reference adapter containers and one TLS broker',
    directedRoutes: 16, offlineRoutes: 4, concurrentRoutes: 3, brokerCrashRecovery: true, inboxRecreation: true,
    modelMetadataSwitch: true, publishedPorts: 0, explicitPrivateHostMapping: true, brokerContainerRestart: engine === 'docker', brokerProcessRestart: true, rootlessNamespaceRestartCertified: false, nativeHostCertification: false, twoPhysicalHosts: false }));
} finally {
  const removed = await lifecycle([broker, ...peers.map(peer => peer.name)], async name => {
    try { await run(['rm', '--force', name]); return { status: 'fulfilled' }; }
    catch (reason) { return { status: 'rejected', reason }; }
  });
  for (const child of children) { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
  if (networkCreated) await run(['network', 'rm', network]);
  // Removal must complete before any owned bind-mounted data is discarded.
  for (let index = 0; index < removed.length; index++) {
    if (removed[index].status === 'rejected') {
      const name = [broker, ...peers.map(peer => peer.name)][index];
      const existing = await run(['ps', '--all', '--filter', `name=^${name}$`, '--format', '{{.ID}}']);
      assert.equal(existing, '', 'owned container remains; retain its private fixture data');
    }
  }
  rmSync(directory, { recursive: true, force: true });
}
