import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { writeFileSync, readFileSync, chmodSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, registration } from './helpers.mjs';
import { EnrollmentService, secretHash } from '../src/enrollment.mjs';
import { setup, revoke } from './pairing-helpers.mjs';
test('pairing unique credential, scope/type binding, exact retry after grant expiry, durable restart and revocation',t=>{
 const s=setup(t),r=s.redeem();assert.equal(r.status,201);assert.equal(s.redeem().status,200);assert.deepEqual(s.redeem().result,r.result);
 assert.equal(JSON.stringify(r).includes(s.token),false);assert.equal(JSON.stringify(r).includes(s.pair.pairing_secret),false);
 const entry=s.auth.authenticate(`Bearer ${s.token}`);assert.deepEqual(entry.client_types,['pi']);assert.deepEqual(entry.scopes,['default']);
 const session=registration();s.f.store.register(entry,session);
 assert.throws(()=>s.f.store.register(entry,registration('opencode')),e=>e.code==='forbidden');
 assert.throws(()=>s.redeem({...s.request,token_sha256:secretHash('different')}),e=>e.code==='idempotency_conflict');
 s.f.advance(601000);s.restart();assert.equal(s.redeem().status,200);assert.equal(s.redeem().result.expires_at,r.result.expires_at);
 revoke(s.policyFile,r.result.credential_id);
 assert.throws(()=>s.auth.authenticate(`Bearer ${s.token}`),e=>e.code==='unauthenticated');
 assert.throws(()=>s.redeem(),e=>e.code==='unauthenticated');assert.equal(s.f.store.db.prepare('SELECT lease_until FROM sessions WHERE id=?').get(session.client_id).lease_until,0);
 assert.equal(s.auth.authenticate(`Bearer ${s.f.a.token}`).credential_id,s.f.a.entry.credential_id);
});
test('expired unconsumed ticket cannot issue; credential expiry stops retry/auth; schema3 remains3 after restart',t=>{
 const s=setup(t);s.f.advance(600001);assert.throws(()=>s.redeem(),e=>e.code==='unauthenticated');
 const next=join(s.f.dir,'second.json');s.issue({outputFile:next,credentialDays:1});s.pair.pairing_secret=JSON.parse(readFileSync(next)).pairing_secret;
 s.redeem();s.f.advance(86400001);assert.throws(()=>s.redeem(),e=>e.code==='unauthenticated');assert.throws(()=>s.auth.authenticate(`Bearer ${s.token}`),e=>e.code==='unauthenticated');
 s.restart();assert.equal(s.f.store.db.prepare('PRAGMA user_version').get().user_version,5);
});
test('single-use race, token/enrollment collisions, invalid body and secret redaction',async t=>{
 const s=setup(t);const results=await Promise.allSettled([Promise.resolve().then(()=>s.redeem()),Promise.resolve().then(()=>s.redeem({...s.request,enrollment_id:randomUUID()}))]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 for(const body of [{},null,{...s.request,scopes:['admin']},{...s.request,token_sha256:'x'}])assert.throws(()=>s.redeem(body),e=>e.code==='invalid_request'&&!e.message.includes(s.pair.pairing_secret));
 const second=join(s.f.dir,'second.json');s.issue({outputFile:second});
 assert.throws(()=>s.enrollment.redeem(`Pairing ${JSON.parse(readFileSync(second)).pairing_secret}`,s.request),e=>e.code==='idempotency_conflict');
});
test('unknown commit outcome reconciles original issuance; rollback issues nothing',t=>{
 const s=setup(t);s.f.store.fault=point=>{if(point==='after_commit')throw Error('synthetic');};
 assert.throws(()=>s.redeem(),e=>e.effect==='unknown');s.f.store.fault=()=>{};assert.equal(s.redeem().status,200);
 const second=join(s.f.dir,'second.json');s.issue({outputFile:second});s.pair.pairing_secret=JSON.parse(readFileSync(second)).pairing_secret;s.request.enrollment_id=randomUUID();s.request.token_sha256=secretHash('synthetic-second');
 s.f.store.fault=point=>{if(point==='before_commit')throw Error('synthetic');};assert.throws(()=>s.redeem(),e=>e.effect==='not_applied');s.f.store.fault=()=>{};assert.equal(s.redeem().status,201);
});
test('private files and malformed policy fail closed',t=>{
 const s=setup(t);
 chmodSync(s.policyFile,0o644);assert.throws(()=>s.auth.authenticate(`Bearer ${s.f.a.token}`),e=>e.code==='not_ready');chmodSync(s.policyFile,0o600);
 const alias=join(s.f.dir,'alias.json');symlinkSync(s.policyFile,alias);assert.throws(()=>new EnrollmentService({store:s.f.store,policyFile:alias}));
 writeFileSync(s.policyFile,'{}');assert.throws(()=>s.auth.authenticate(`Bearer ${s.token}`),e=>e.code==='not_ready');
});
test('enrollment remains optional; current schema and backup retain consumed grants and messages',async t=>{
 const {BrokerStore}=await import('../src/store.mjs');const f=fixture(t);assert.equal(f.store.db.prepare('PRAGMA user_version').get().user_version,5);
 const s=setup(t);const legacy=s.f.store.register(s.f.a.entry,registration());const issued=s.redeem();
 const path=join(s.f.dir,'backup.sqlite');await s.f.store.backup(path);
 const restored=new BrokerStore({path,clock:()=>s.f.now});t.after(()=>restored.close());const service=new EnrollmentService({store:restored,policyFile:s.policyFile});
 assert.equal(restored.db.prepare('PRAGMA user_version').get().user_version,5);assert.equal(restored.session(s.f.a.entry,legacy.client_id).client_id,legacy.client_id);
 const replay=service.redeem(`Pairing ${s.pair.pairing_secret}`,s.request);assert.equal(replay.status,200);assert.deepEqual(replay.result,issued.result);
 assert.equal(restored.db.prepare('SELECT count(*) n FROM enrolled_credentials').get().n,1);
});

test('re-pair creates distinct installation and cannot adopt former native-session mailbox',t=>{
 const s=setup(t),first=s.redeem(),entry=s.auth.authenticate(`Bearer ${s.token}`),session=registration();s.f.store.register(entry,session);
 const second=join(s.f.dir,'next-installation.json');s.issue({outputFile:second});const secret=JSON.parse(readFileSync(second)).pairing_secret;
 const token=randomBytes(32).toString('base64url'),request={enrollment_id:randomUUID(),client_type:'pi',token_sha256:secretHash(token)};
 const result=s.enrollment.redeem(`Pairing ${secret}`,request,s.auth.configuredEntries);const newEntry=s.auth.authenticate(`Bearer ${token}`);
 assert.notEqual(result.result.credential_id,first.result.credential_id);assert.notEqual(result.result.adapter_id,first.result.adapter_id);
 assert.throws(()=>s.f.store.register(newEntry,session),e=>e.code==='identity_conflict');assert.throws(()=>s.f.store.session(newEntry,session.client_id),e=>e.code==='recipient_not_found');
 assert.ok(s.f.store.register(newEntry,registration()).client_id);
});

test('finite grant and live issuance caps fail without consuming pending grant',t=>{
 const s=setup(t),p=JSON.parse(readFileSync(s.policyFile));p.grants=Array(1001).fill(p.grants[0]);writeFileSync(s.policyFile,JSON.stringify(p));assert.throws(()=>s.enrollment.policy());
 p.grants=p.grants.slice(0,1);writeFileSync(s.policyFile,JSON.stringify(p));
 const expires=s.f.now+86400000;
 s.f.store.tx(()=>{for(let i=0;i<1000;i++)s.f.store.db.prepare('INSERT INTO enrolled_credentials VALUES(?,?,?,?,?,?,?,?)').run('synthetic-'+i,'synthetic-'+i,'{}','synthetic-'+i,'synthetic-'+i,'{}','{}',expires);});
 assert.throws(()=>s.redeem(),e=>e.code==='rate_limited');assert.equal(s.f.store.db.prepare('SELECT count(*) n FROM enrolled_credentials WHERE grant_hash=?').get(secretHash(s.pair.pairing_secret)).n,0);
});

test('pairing preflight is non-mutating and final redemption rechecks expiry and revocation',t=>{
 const s=setup(t),header=`Pairing ${s.pair.pairing_secret}`;s.enrollment.preflight(header);
 assert.equal(s.f.store.db.prepare('SELECT count(*) n FROM enrolled_credentials').get().n,0);
 s.f.advance(600001);assert.throws(()=>s.redeem(),{code:'unauthenticated'});
 const next=join(s.f.dir,'preflight-next.json');s.issue({outputFile:next});s.pair.pairing_secret=JSON.parse(readFileSync(next)).pairing_secret;
 const issued=s.redeem();s.f.advance(600001);s.enrollment.preflight(`Pairing ${s.pair.pairing_secret}`);
 revoke(s.policyFile,issued.result.credential_id);assert.throws(()=>s.redeem(),{code:'unauthenticated'});
 assert.throws(()=>s.enrollment.preflight(`Pairing ${s.pair.pairing_secret}`),{code:'unauthenticated'});
});
