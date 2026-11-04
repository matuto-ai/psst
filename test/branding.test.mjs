import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { releasePlan } from '../scripts/release-plan.mjs';
const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

test('Psst display branding explains the retained private technical identity', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.name, 'ai-agent-msg-broker');
  assert.equal(pkg.private, true);
  assert.match(pkg.description, /^Psst:/);
  assert.match(read('README.md'), /^# Psst\n/);
  assert.match(read('README.md'), /former \*\*AI Agent Message Broker\*\*/);
  assert.match(read('README.md'), /docs\/branding-migration\.md/);
  assert.match(read('Containerfile'), /org\.opencontainers\.image\.title="Psst"/);
  assert.match(read('Containerfile'), /org\.opencontainers\.image\.source="https:\/\/github\.com\/matuto-ai\/psst"/);
});

test('branding preserves deployment configuration and persistent storage selectors', () => {
  const container = read('Containerfile'), compose = read('compose.yaml');
  assert.match(container, /ENV BROKER_CONFIG_FILE=\/run\/broker\/config\.json/);
  assert.match(container, /VOLUME \["\/data"\]/);
  assert.match(compose, /^services:\n  broker:/);
  assert.match(compose, /- broker-data:\/data/);
  assert.match(compose, /\$\{BROKER_IMAGE:-ghcr\.io\/matuto-ai\/psst:/);
  assert.match(compose, /\$\{BROKER_BIND_IP:-127\.0\.0\.1\}:\$\{BROKER_PORT:-8787\}:8787/);
  const config = JSON.parse(read('deploy/config.proxy-container.example.json'));
  assert.equal(config.database, '/data/broker.sqlite');
  assert.equal(config.credential_file, '/run/broker/credentials.json');
  assert.equal(config.proxy_transport, true);
  assert.match(read('src/main.mjs'), /BROKER_CONFIG_FILE/);
});

test('historical v0.1.0 namespace remains a valid release plan, not a new alias', () => {
  const commit='a'.repeat(40), old='ghcr.io/brunoorsolon/ai-agent-msg-broker';
  const plan=releasePlan({eventName:'release',action:'published',tag:'v0.1.0',prerelease:false,draft:false,packageVersion:'0.1.0',repository:'brunoorsolon/ai-agent-msg-broker',commit,checkoutCommit:commit});
  assert.deepEqual(plan.tags, [`${old}:0.1.0`, `${old}:latest`]);
  const guide=read('docs/branding-migration.md');
  assert.ok(guide.includes(`docker pull ${old}:0.1.0`));
  assert.match(guide, /-v ai-agent-msg-broker-data:\/data/);
  assert.match(guide, /not confirmation that the registry currently serves the tag/);
  assert.match(guide, /No new alias,/);
  assert.match(guide, /COMPOSE_PROJECT_NAME/);
  assert.match(guide, /never open an upgraded database\nwith an older binary/);
  assert.match(guide, /Do not delete the current volume or journals/);
  assert.match(read('docs/docker-release.md'), /branding-migration\.md/);
});
