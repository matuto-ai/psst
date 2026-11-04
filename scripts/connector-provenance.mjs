import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, lstatSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CONNECTORS = Object.freeze({
  pi: 'pi', 'claude-code': 'claude', 'antigravity-cli': 'antigravity', opencode: 'opencode',
});
const sha = /^[0-9a-f]{40}$/;
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const run = (command, args, cwd) => execFileSync(command, args, { cwd, encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
const git = (source, ...args) => run('git', args, source).trim();
const repository = type => `matuto-ai/${CONNECTORS[type]}-psst-connector`;
const packageName = type => `@matuto-ai/${CONNECTORS[type]}-psst-connector`;

export function validateCohort(value, mode) {
  assert.equal(value?.schema, 1, 'cohort schema');
  assert.ok(['current', 'pinned-candidate', 'source-candidate'].includes(value.mode), 'explicit cohort mode');
  if (mode) assert.equal(value.mode, mode, 'cohort mode does not match this verification lane');
  assert.equal(value.broker?.repository, 'matuto-ai/psst');
  assert.match(value.broker?.commit ?? '', sha, 'exact broker commit required');
  assert.deepEqual(Object.keys(value.connectors ?? {}).sort(), Object.keys(CONNECTORS).sort(), 'complete connector cohort required');
  const candidateType = Object.keys(CONNECTORS).find(type => repository(type) === value.candidate?.repository);
  if (value.mode === 'source-candidate') {
    assert.ok(candidateType, 'candidate repository must be a supported connector');
    assert.match(value.candidate.commit ?? '', sha, 'exact caller candidate required');
  } else assert.equal(value.candidate, undefined, 'candidate cannot override this lane');
  for (const type of Object.keys(CONNECTORS)) {
    const entry = value.connectors[type];
    assert.equal(entry.repository, repository(type));
    assert.match(entry.commit ?? '', sha, `exact ${type} commit required`);
    assert.equal(entry.ref, value.mode === 'pinned-candidate' ? 'pinned-candidate' : type === candidateType ? 'ci-candidate' : 'refs/heads/main');
    if (type === candidateType) assert.equal(entry.commit, value.candidate.commit, 'caller candidate must not be replaced by main');
  }
  return value;
}

export function parseRemoteHead(output) {
  const lines = output.trim().split('\n');
  assert.equal(lines.length, 1, 'exactly one main ref required');
  const [commit, ref, extra] = lines[0].split(/\s+/);
  assert.match(commit ?? '', sha, 'invalid remote head');
  assert.equal(ref, 'refs/heads/main');
  assert.equal(extra, undefined);
  return commit;
}

export async function resolveCurrentCohort({ brokerCommit, candidate, resolveHead = async repo => parseRemoteHead(run('git', ['ls-remote', '--refs', `https://github.com/${repo}.git`, 'refs/heads/main'])), now = () => new Date().toISOString() }) {
  assert.match(brokerCommit ?? '', sha, 'exact tested broker commit required');
  if (candidate) {
    assert.ok(Object.keys(CONNECTORS).some(type => repository(type) === candidate.repository), 'candidate repository must be a supported connector');
    assert.match(candidate.commit ?? '', sha, 'exact caller candidate required');
  }
  const resolvedAt = now();
  const entries = await Promise.all(Object.keys(CONNECTORS).map(async type => [type, {
    repository: repository(type), ref: candidate?.repository === repository(type) ? 'ci-candidate' : 'refs/heads/main',
    commit: candidate?.repository === repository(type) ? candidate.commit : await resolveHead(repository(type)),
  }]));
  return validateCohort({ schema: 1, mode: candidate ? 'source-candidate' : 'current', ...(candidate ? { candidate } : {}),
    resolved_at: resolvedAt, resolution_completed_at: now(),
    broker: { repository: 'matuto-ai/psst', commit: brokerCommit }, connectors: Object.fromEntries(entries) });
}

export function verifyCheckout(source, expected) {
  source = resolve(source);
  assert.match(expected.commit ?? '', sha);
  const commit = git(source, 'rev-parse', 'HEAD');
  assert.equal(commit, expected.commit, `stale or wrong source checkout: ${expected.repository}`);
  assert.equal(git(source, 'status', '--porcelain', '--untracked-files=no'), '', `modified tracked source: ${expected.repository}`);
  const tree = git(source, 'rev-parse', 'HEAD^{tree}');
  const files = new Map();
  for (const row of run('git', ['ls-tree', '-r', '-z', 'HEAD'], source).split('\0').filter(Boolean)) {
    const [header, path] = row.split('\t');
    const [mode, type, hash] = header.split(' ');
    files.set(path, { mode, type, hash });
  }
  return { source, repository: expected.repository, commit, tree, files };
}

function blobHash(bytes) {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}
function safeMember(member) {
  assert.match(member, /^package\/[A-Za-z0-9@._/-]+$/, 'unsafe package member');
  const path = member.slice(8);
  assert.ok(path && path.split('/').every(part => part && part !== '.' && part !== '..'), 'noncanonical package member');
  return path;
}

// npm is invoked on the selected checkout, never a registry version or a sibling
// source. The archive is verified before extraction and every packaged byte must
// be a tracked blob in that exact commit. Same-version stale artifacts fail too.
export function verifyPackedArtifact({ checkout, type, artifact, archive, destination }) {
  const manifest = JSON.parse(readFileSync(join(checkout.source, 'package.json')));
  assert.equal(manifest.name, packageName(type));
  assert.match(manifest.version, semver, 'source version must be SemVer');
  assert.equal(artifact.name, manifest.name, 'packed package name mismatch');
  assert.equal(artifact.version, manifest.version, 'packed package version mismatch');
  const bytes = readFileSync(archive);
  const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64');
  assert.equal(artifact.integrity, integrity, 'packed archive integrity mismatch');
  assert.equal(artifact.shasum, createHash('sha1').update(bytes).digest('hex'), 'packed archive digest mismatch');
  const members = run('tar', ['-tzf', archive]).trim().split('\n');
  const paths = members.map(safeMember);
  assert.equal(new Set(paths).size, paths.length, 'duplicate package member');
  const details = run('tar', ['-tvzf', archive, '--numeric-owner']).trim().split('\n');
  assert.equal(details.length, paths.length, 'unexpected package metadata');
  assert.ok(details.every(line => line.startsWith('-')), 'only regular package files are permitted');
  assert.deepEqual(paths.slice().sort(), artifact.files.map(file => file.path).sort(), 'archive differs from npm pack file list');
  // Archive-supplied metadata cannot prove completeness: an old same-version
  // archive could omit a newly added file while every remaining blob matches.
  const planned = JSON.parse(run('npm', ['pack', '--dry-run', '--json', '--ignore-scripts', '--cache', join(dirname(destination), 'npm-cache')], checkout.source));
  assert.equal(planned.length, 1, 'one current source package required');
  assert.equal(planned[0].name, manifest.name); assert.equal(planned[0].version, manifest.version);
  assert.deepEqual(paths.slice().sort(), planned[0].files.map(file => file.path).sort(), 'archive omits or adds files relative to current source pack list');
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  assert.equal(readdirSync(destination).length, 0, 'package destination must be empty');
  run('tar', ['-xzf', archive, '-C', destination, '--no-same-owner', '--no-same-permissions']);
  const root = join(destination, 'package');
  const hashes = {};
  for (const path of paths) {
    const expected = checkout.files.get(path);
    assert.ok(expected && expected.type === 'blob' && ['100644', '100755'].includes(expected.mode), `untracked or unsafe packaged file: ${path}`);
    const file = join(root, path);
    const stat = lstatSync(file);
    assert.ok(stat.isFile(), `non-file in package: ${path}`);
    assert.equal(Boolean(stat.mode & 0o111), expected.mode === '100755', `packed executable mode differs from tested commit: ${path}`);
    const content = readFileSync(file);
    assert.equal(blobHash(content), expected.hash, `packed bytes differ from tested commit: ${path}`);
    assert.equal(blobHash(readFileSync(join(checkout.source, path))), expected.hash, `source changed while packing: ${path}`);
    hashes[path] = createHash('sha256').update(content).digest('hex');
  }
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'package.json'))), manifest, 'installed package manifest mismatch');
  verifyCheckout(checkout.source, checkout);
  return { root, evidence: { repository: checkout.repository, commit: checkout.commit, tree: checkout.tree,
    name: manifest.name, version: manifest.version, integrity, files: hashes } };
}

export function packVerifiedConnector({ source, expected, type, directory }) {
  const checkout = verifyCheckout(source, expected);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const results = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--cache', join(directory, 'npm-cache'), '--pack-destination', directory], checkout.source));
  assert.equal(results.length, 1, 'exactly one source package required');
  const artifact = results[0];
  assert.equal(artifact.filename, `${artifact.name.replace('@', '').replace('/', '-')}-${artifact.version}.tgz`, 'noncanonical archive filename');
  return verifyPackedArtifact({ checkout, type, artifact, archive: join(directory, artifact.filename), destination: join(directory, 'extracted') });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, output] = process.argv.slice(2);
  assert.ok(['resolve', 'resolve-candidate'].includes(command));
  assert.ok(output, 'output path required');
  // A reusable workflow's GitHub context belongs to its caller. The broker was
  // checked out once from its own main; the caller SHA identifies only the
  // connector under test. Never overwrite that candidate with connector main.
  const candidate = command === 'resolve-candidate' ? { repository: process.env.GITHUB_REPOSITORY, commit: process.env.GITHUB_SHA } : undefined;
  if (candidate) assert.ok(['push', 'pull_request'].includes(process.env.GITHUB_EVENT_NAME), 'only unprivileged push/pull_request callers supported');
  const brokerCommit = candidate ? git(process.cwd(), 'rev-parse', 'HEAD') : process.env.GITHUB_SHA;
  verifyCheckout(process.cwd(), { repository: 'matuto-ai/psst', commit: brokerCommit });
  const cohort = await resolveCurrentCohort({ brokerCommit, candidate });
  writeFileSync(output, JSON.stringify(cohort) + '\n', { mode: 0o600 });
  if (process.env.GITHUB_OUTPUT) writeFileSync(process.env.GITHUB_OUTPUT, `cohort=${JSON.stringify(cohort)}\n`, { flag: 'a' });
  console.log(JSON.stringify(cohort));
}
