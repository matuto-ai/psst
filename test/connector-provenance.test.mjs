import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { CONNECTORS, parseRemoteHead, resolveCurrentCohort, validateCohort, verifyCheckout, packVerifiedConnector, verifyPackedArtifact } from '../scripts/connector-provenance.mjs';

const run = (cwd, command, args) => execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'psst-provenance-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = join(directory, 'source'); mkdirSync(source);
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name: '@matuto-ai/pi-psst-connector', version: '0.6.0', type: 'module', files: ['index.mjs'] }));
  writeFileSync(join(source, 'index.mjs'), "import p from './package.json' with {type:'json'}; export const version=p.version; export const marker='current';\n");
  run(source, 'git', ['init', '-q']);
  const commit = () => { run(source, 'git', ['add', '.']); run(source, 'git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']); return run(source, 'git', ['rev-parse', 'HEAD']); };
  const expected = { repository: 'matuto-ai/pi-psst-connector', commit: commit() };
  const pack = name => packVerifiedConnector({ source, expected, type: 'pi', directory: join(directory, name) });
  return { directory, source, expected, commit, pack };
}
function rawPack(f, name) {
  const directory = join(f.directory, name); mkdirSync(directory);
  const artifact = JSON.parse(run(f.source, 'npm', ['pack', '--ignore-scripts', '--json', '--cache', join(directory, 'npm-cache'), '--pack-destination', directory]))[0];
  return { artifact, archive: join(directory, artifact.filename) };
}

test('current cohort freezes each main once and rejects ambiguous/missing refs', async () => {
  const calls = [], owner = '1'.repeat(40);
  const cohort = await resolveCurrentCohort({ brokerCommit: owner, resolveHead: async repo => { calls.push(repo); return String(calls.length + 1).repeat(40); }, now: () => '2026-11-04T00:00:00Z' });
  assert.equal(calls.length, 4); assert.equal(new Set(calls).size, 4);
  assert.equal(cohort.broker.commit, owner);
  assert.equal(validateCohort(cohort, 'current'), cohort);
  assert.throws(() => validateCohort(cohort, 'pinned-candidate'), /lane/);
  assert.equal(parseRemoteHead(`${owner}\trefs/heads/main\n`), owner);
  for (const value of ['', `${owner}\trefs/heads/main\n${owner}\trefs/heads/main`, `${owner}\trefs/tags/v0.6.0`]) assert.throws(() => parseRemoteHead(value));
  for (const type of Object.keys(CONNECTORS)) assert.equal(cohort.connectors[type].ref, 'refs/heads/main');
});

test('connector caller retains its exact candidate while only siblings resolve main', async () => {
  const candidate = { repository: 'matuto-ai/pi-psst-connector', commit: 'a'.repeat(40) }, calls = [];
  const cohort = await resolveCurrentCohort({ brokerCommit: 'b'.repeat(40), candidate,
    resolveHead: async repo => { calls.push(repo); return 'c'.repeat(40); } });
  assert.equal(cohort.mode, 'source-candidate'); assert.equal(calls.length, 3);
  assert.ok(!calls.includes(candidate.repository));
  assert.equal(cohort.connectors.pi.commit, candidate.commit);
  assert.equal(cohort.connectors.pi.ref, 'ci-candidate');
  assert.equal(cohort.broker.commit, 'b'.repeat(40));
  const wrong = structuredClone(cohort); wrong.connectors.pi.commit = 'c'.repeat(40);
  assert.throws(() => validateCohort(wrong, 'source-candidate'), /must not be replaced by main/);
  await assert.rejects(() => resolveCurrentCohort({ brokerCommit: 'b'.repeat(40), candidate: { repository: 'untrusted/other', commit: 'a'.repeat(40) } }), /supported connector/);
});

test('a real source-built npm artifact loads current runtime bytes and version', async t => {
  const f = fixture(t), packed = f.pack('valid');
  const loaded = await import(pathToFileURL(join(packed.root, 'index.mjs')));
  assert.equal(loaded.version, '0.6.0'); assert.equal(loaded.marker, 'current');
  assert.equal(packed.evidence.commit, f.expected.commit);
  assert.equal(packed.evidence.files['index.mjs'], createHash('sha256').update(readFileSync(join(f.source, 'index.mjs'))).digest('hex'));
  assert.ok(packed.evidence.integrity.startsWith('sha512-'));
});

test('stale checkout, modified source, untracked packed code and metadata mismatch fail closed', t => {
  const f = fixture(t);
  assert.throws(() => verifyCheckout(f.source, { ...f.expected, commit: 'f'.repeat(40) }), /stale or wrong source/);
  writeFileSync(join(f.source, 'index.mjs'), 'export const stale=true;');
  assert.throws(() => f.pack('dirty'), /modified tracked source/);
  run(f.source, 'git', ['checkout', '--', 'index.mjs']);
  const { artifact, archive } = rawPack(f, 'metadata');
  const checkout = verifyCheckout(f.source, f.expected);
  assert.throws(() => verifyPackedArtifact({ checkout, type: 'pi', artifact: { ...artifact, version: '0.5.1' }, archive, destination: join(f.directory, 'wrong-version') }), /version mismatch/);
  assert.throws(() => verifyPackedArtifact({ checkout, type: 'pi', artifact: { ...artifact, name: '@matuto-ai/old-package' }, archive, destination: join(f.directory, 'wrong-name') }), /name mismatch/);
  assert.throws(() => verifyPackedArtifact({ checkout, type: 'pi', artifact: { ...artifact, integrity: 'sha512-wrong' }, archive, destination: join(f.directory, 'wrong-digest') }), /integrity mismatch/);
  const manifest = JSON.parse(readFileSync(join(f.source, 'package.json'))); manifest.files.push('untracked.mjs');
  writeFileSync(join(f.source, 'package.json'), JSON.stringify(manifest)); f.expected.commit = f.commit();
  writeFileSync(join(f.source, 'untracked.mjs'), 'export const hidden=true;');
  assert.throws(() => f.pack('untracked'), /untracked or unsafe packaged file/);
});

test('an older artifact with the same version cannot qualify a newer source commit', t => {
  const f = fixture(t), old = rawPack(f, 'old');
  writeFileSync(join(f.source, 'index.mjs'), "export const marker='newer same-version source';\n");
  f.expected.commit = f.commit();
  const checkout = verifyCheckout(f.source, f.expected);
  assert.throws(() => verifyPackedArtifact({ checkout, type: 'pi', ...old, destination: join(f.directory, 'stale') }), /packed bytes differ from tested commit/);
  assert.equal(f.pack('new').evidence.version, '0.6.0');
});

test('archive tampering is rejected even if the filename is unchanged', t => {
  const f = fixture(t), packed = rawPack(f, 'tampered');
  const checkout = verifyCheckout(f.source, f.expected);
  const bytes = readFileSync(packed.archive); bytes[bytes.length - 1] ^= 1; writeFileSync(packed.archive, bytes);
  assert.throws(() => verifyPackedArtifact({ checkout, type: 'pi', ...packed, destination: join(f.directory, 'tampered-out') }), /integrity mismatch/);
});

test('add-only same-version changes cannot be hidden by a complete-looking older archive', t => {
  const f = fixture(t), manifest = JSON.parse(readFileSync(join(f.source, 'package.json')));
  manifest.files = ['*.mjs']; writeFileSync(join(f.source, 'package.json'), JSON.stringify(manifest));
  f.expected.commit = f.commit();
  const old = rawPack(f, 'before-addition');
  writeFileSync(join(f.source, 'added-current-feature.mjs'), "export const currentFeature = true;\n");
  f.expected.commit = f.commit();
  const checkout = verifyCheckout(f.source, f.expected);
  assert.throws(() => verifyPackedArtifact({ checkout, type: 'pi', ...old, destination: join(f.directory, 'omitted') }), /current source pack list/);
  assert.ok(f.pack('complete').evidence.files['added-current-feature.mjs']);
});

test('same-byte executable-mode changes cannot be hidden by an older archive', t => {
  const f = fixture(t), old = rawPack(f, 'before-mode-change');
  chmodSync(join(f.source, 'index.mjs'), 0o755); f.expected.commit = f.commit();
  const checkout = verifyCheckout(f.source, f.expected);
  assert.throws(() => verifyPackedArtifact({ checkout, type: 'pi', ...old, destination: join(f.directory, 'old-mode') }), /executable mode differs/);
  assert.equal(f.pack('new-mode').evidence.commit, f.expected.commit);
});

test('required CI freezes current refs once, consumes them and keeps historical lanes explicit', () => {
  const workflow = readFileSync(new URL('../.github/workflows/verify.yaml', import.meta.url), 'utf8');
  assert.match(workflow, /resolve-current-cohort:/);
  assert.match(workflow, /node scripts\/connector-provenance\.mjs resolve/);
  const current = workflow.split('  current-transport:')[1].split('\n  # Explicit PR dependencies:')[0];
  for (const type of Object.keys(CONNECTORS)) assert.ok(current.includes(`connectors['${type}'].commit`), `resolved immutable checkout for ${type}`);
  assert.match(current, /PSST_CURRENT_COHORT:/);
  assert.match(current, /PSST_COHORT_EVIDENCE:/);
  const native = workflow.split('  native-presence:')[1].split('  local-tests:')[0];
  assert.ok(native.includes("connectors['pi'].commit"));
  assert.match(native, /PSST_CURRENT_COHORT:/);
  assert.match(workflow, /PSST_COHORT_MODE: pinned-candidate/);
  assert.match(workflow, /cooperative-transport:/);
  assert.match(workflow, /ref: f3d3bfc5cd17c10697d52e892f88c06a22ee2b16/);
  const reusable = readFileSync(new URL('../.github/workflows/connector-cohort.yaml', import.meta.url), 'utf8');
  assert.match(reusable, /workflow_call:/); assert.match(reusable, /contents: read/);
  assert.doesNotMatch(reusable, /pull_request_target|secrets:|id-token:|contents: write|secrets\.inherit/);
  assert.equal((reusable.match(/ref: main/g) ?? []).length, 1, 'only initial broker resolution can use a moving ref');
  assert.match(reusable, /broker\.commit/); assert.match(reusable, /resolve-candidate/);
  assert.match(reusable, /PSST_COHORT_MODE: source-candidate/);
  assert.equal((reusable.match(/uses: actions\/checkout@/g) ?? []).length, (reusable.match(/persist-credentials: false/g) ?? []).length);
  const container = readFileSync(new URL('../Containerfile', import.meta.url), 'utf8');
  assert.match(container.split(' AS test\n')[1].split('FROM base AS runtime')[0], /COPY \.github\/workflows\/verify\.yaml \.github\/workflows\/connector-cohort\.yaml \.\/\.github\/workflows\//);
  assert.doesNotMatch(container.split('FROM base AS runtime')[1], /\.github/);
});
