import test from 'node:test';
import assert from 'node:assert/strict';
import { releasePlan } from '../scripts/release-plan.mjs';
const commit='a'.repeat(40);
const valid={eventName:'release',action:'published',tag:'v0.1.0',prerelease:false,draft:false,packageVersion:'0.1.0',repository:'brunoorsolon/ai-agent-msg-broker',commit,checkoutCommit:commit};
test('only published release matching package version and exact tested commit plans registry tags',()=>{
 const p=releasePlan(valid);assert.equal(p.publish,true);assert.equal(p.latest,true);assert.deepEqual(p.tags,['ghcr.io/brunoorsolon/ai-agent-msg-broker:0.1.0','ghcr.io/brunoorsolon/ai-agent-msg-broker:latest']);
 for(const eventName of ['push','pull_request','workflow_run','release_request'])assert.throws(()=>releasePlan({...valid,eventName}));
 for(const changes of [{action:'created'},{draft:true},{tag:'v9.0.0'},{tag:'v0.1.0\nBAD=x'},{checkoutCommit:'b'.repeat(40)},{commit:'main'},{repository:'bad/../../secret'},{packageVersion:'01.1.0'}])assert.throws(()=>releasePlan({...valid,...changes}));
});
test('manual dry run cannot publish and prereleases never update latest',()=>{
 const dry=releasePlan({...valid,eventName:'workflow_dispatch',tag:'v999.0.0'});assert.equal(dry.publish,false);assert.equal(dry.latest,false);assert.deepEqual(dry.tags,[]);
 assert.equal(releasePlan({...valid,prerelease:true}).latest,false);
 const pre=releasePlan({...valid,tag:'v0.1.0-rc.1',packageVersion:'0.1.0-rc.1'});assert.equal(pre.latest,false);assert.equal(pre.tags.length,1);
 assert.throws(()=>releasePlan({...valid,tag:'v0.1.0-01',packageVersion:'0.1.0-01'}));
});

test('current release metadata uses the current repository and matching Compose image',async()=>{
 const {readFileSync}=await import('node:fs');
 const pkg=JSON.parse(readFileSync(new URL('../package.json',import.meta.url)));
 const plan=releasePlan({...valid,repository:'matuto-ai/psst',packageVersion:pkg.version,tag:`v${pkg.version}`});
 assert.equal(plan.image,'ghcr.io/matuto-ai/psst');
 assert.ok(readFileSync(new URL('../compose.yaml',import.meta.url),'utf8').includes(`${plan.image}:${pkg.version}`));
 assert.ok(readFileSync(new URL('../Containerfile',import.meta.url),'utf8').includes('https://github.com/matuto-ai/psst'));
});

test('source candidate documentation stays aligned without claiming publication or activation',async()=>{
 const {readFileSync}=await import('node:fs');
 const read=path=>readFileSync(new URL(`../${path}`,import.meta.url),'utf8');
 const pkg=JSON.parse(read('package.json'));
 assert.equal(pkg.name,'ai-agent-msg-broker');assert.equal(pkg.private,true);
 const guide=read('docs/docker-release.md'),changelog=read('CHANGELOG.md'),readme=read('README.md');
 assert.ok(guide.includes(`## ${pkg.version} source candidate`));
 assert.ok(guide.includes(`GitHub Release \`v${pkg.version}\``));
 assert.ok(guide.includes(`ghcr.io/matuto-ai/psst:${pkg.version}`));
 assert.ok(changelog.startsWith(`# Changelog\n\n## ${pkg.version} (source candidate; publish separately)`));
 assert.match(guide,/disabled by default/);assert.match(guide,/schema advances to \*\*5\*\*/);
 assert.match(guide,/separate operator decision/);assert.match(guide,/Do not open the upgraded database with an older binary/);
 assert.match(readme,/git clone https:\/\/github.com\/matuto-ai\/psst\.git/);
 assert.doesNotMatch(readme,/feat\/durable-broker-v1|main` still holds the specification|brunoorsolon\/ai-agent-msg-broker/);
});
