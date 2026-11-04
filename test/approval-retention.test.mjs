import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { fixture, registration } from './helpers.mjs';
import { ApprovalService, REVOKED_RETENTION_MS } from '../src/approval.mjs';
import { AdminUI } from '../src/admin.mjs';
import { adminRequest } from './admin-request.mjs';

const candidate=()=>({header:`Enrollment ${randomBytes(32).toString('base64url')}`,body:{request_id:randomUUID(),client_type:'pi',label:'Retention fixture'}});
function enroll(approval,{approve=true}={}){
 const c=candidate();approval.request(c.header,c.body);
 if(approve)approval.decide(c.body.request_id,'approve');
 return c;
}
const row=(f,c)=>f.store.db.prepare('SELECT * FROM approval_requests WHERE id=?').get(c.body.request_id);
const denied=fn=>assert.throws(fn,e=>e.status===401);

test('revoked visibility ends exactly 30 days after first revoke without new enrollment, including UI and pagination',async t=>{
 const f=fixture(t),approval=await ApprovalService.create({store:f.store});
 const c=enroll(approval),live=enroll(approval);
 approval.decide(c.body.request_id,'revoke');const revokedAt=f.now;
 f.advance(REVOKED_RETENTION_MS-1);
 assert.ok(approval.list().some(r=>r.id===c.body.request_id));
 approval.decide(c.body.request_id,'revoke');assert.equal(row(f,c).revoked_at,revokedAt);
 // Add pending only before the boundary; no enrollment triggers the removal.
 const pending=enroll(approval,{approve:false});
 const preserved=[row(f,live),row(f,pending)];
 f.advance(1);
 assert.deepEqual(approval.list({limit:1}).map(r=>r.id),[pending.body.request_id]);
 assert.deepEqual(approval.list({limit:1,offset:1}).map(r=>r.id),[live.body.request_id]);
 assert.equal(approval.list({limit:1,offset:2}).length,0);
 assert.deepEqual([row(f,live),row(f,pending)],preserved);
 const admin=await AdminUI.create({approval,auth:f.auth,password:'synthetic-password-retention',insecureDevelopment:true});
 const session=admin.issue(true);
 for(const path of ['/admin','/admin/approvals']){
  const page=await adminRequest(admin,path,{headers:{cookie:`psst_admin=${session.cookie}`}});
  assert.equal(page.status,200);assert.ok(!page.html.includes(`data-request-id="${c.body.request_id}"`));
  assert.ok(page.html.includes(`data-request-id="${live.body.request_id}"`));
 }
 assert.equal(row(f,c).state,'revoked');
});

test('restart, cleanup, polling and replay preserve revocation and session authority',async t=>{
 const f=fixture(t);let approval=await ApprovalService.create({store:f.store});
 f.auth.additionalCredentials=()=>approval.credentials();
 const c=enroll(approval),bearer=c.header.replace('Enrollment','Bearer'),identity=f.auth.authenticate(bearer);
 const registrationInput=registration();f.store.register(identity,registrationInput);
 approval.decide(c.body.request_id,'revoke');denied(()=>f.auth.authenticate(bearer));
 const session=f.store.db.prepare('SELECT * FROM sessions WHERE id=?').get(registrationInput.client_id);
 assert.equal(session.lease_until,0);assert.equal(session.scopes,'[]');
 f.advance(121*86400000);
 assert.equal(approval.list().length,0);
 // A new request exercises old terminal cleanup, well beyond credential expiry.
 enroll(approval,{approve:false});
 assert.equal(row(f,c).state,'revoked');
 f.restart();approval=await ApprovalService.create({store:f.store});
 denied(()=>f.auth.authenticate(bearer));
 assert.equal(approval.status(c.header,c.body.request_id).state,'revoked');
 assert.deepEqual(approval.request(c.header,c.body),{status:200,result:approval.status(c.header,c.body.request_id)});
 assert.throws(()=>approval.request(c.header,{...c.body,label:'changed'}),e=>e.status===409);
 assert.throws(()=>approval.request(c.header,{...c.body,request_id:randomUUID()}),e=>e.status===409);
 denied(()=>approval.request(candidate().header,c.body));
 assert.throws(()=>approval.decide(c.body.request_id,'approve'),e=>e.status===409);
 assert.ok(approval.reservations().some(r=>r.approval_request_id===c.body.request_id));
 assert.equal(f.store.db.prepare('SELECT scopes FROM sessions WHERE id=?').get(registrationInput.client_id).scopes,'[]');
 // Reconnection must pass authentication, both for the old session and a fresh one.
 for(const input of [registrationInput,registration()])denied(()=>f.store.register(f.auth.authenticate(bearer),input));
});

test('legacy revoked rows get an explicit first-observed grace period, not an invented revocation time',async t=>{
 const f=fixture(t);let approval=await ApprovalService.create({store:f.store});
 const c=enroll(approval);approval.decide(c.body.request_id,'revoke');
 // Reproduce the exact pre-upgrade table shape, without either timestamp column.
 f.store.db.exec('ALTER TABLE approval_requests DROP COLUMN revoked_at; ALTER TABLE approval_requests DROP COLUMN revocation_observed_at;');
 f.advance(200*86400000);const observed=f.now;
 f.restart();approval=await ApprovalService.create({store:f.store});
 assert.equal(row(f,c).revoked_at,null);assert.equal(row(f,c).revocation_observed_at,observed);
 assert.equal(approval.list().length,1);
 f.advance(REVOKED_RETENTION_MS-1);
 f.restart();approval=await ApprovalService.create({store:f.store});
 assert.equal(row(f,c).revocation_observed_at,observed);assert.equal(approval.list().length,1);
 approval.decide(c.body.request_id,'revoke');
 assert.equal(row(f,c).revoked_at,null);
 f.advance(1);assert.equal(approval.list().length,0);
 assert.equal(approval.status(c.header,c.body.request_id).state,'revoked');
 assert.equal(row(f,c).revocation_observed_at,observed);
});

test('denied and expired cleanup policies remain separate from revoked visibility',async t=>{
 const f=fixture(t),approval=await ApprovalService.create({store:f.store});
 const deniedRequest=enroll(approval,{approve:false}),expired=enroll(approval,{approve:false}),revoked=enroll(approval);
 approval.decide(deniedRequest.body.request_id,'deny');approval.decide(revoked.body.request_id,'revoke');
 f.advance(REVOKED_RETENTION_MS);
 assert.deepEqual(new Set(approval.list().map(r=>r.state)),new Set(['denied','expired']));
 f.advance(86400001);enroll(approval,{approve:false});
 assert.equal(row(f,deniedRequest),undefined);assert.equal(row(f,expired),undefined);
 assert.equal(row(f,revoked).state,'revoked');
});

test('archived revocations release admission capacity without losing replay or identity reservations',async t=>{
 const f=fixture(t),approval=await ApprovalService.create({store:f.store});
 const original=enroll(approval);approval.decide(original.body.request_id,'revoke');
 // Model a long-lived installation history without 10,000 approval round trips.
 f.store.tx(()=>{
  const insert=f.store.db.prepare("INSERT INTO approval_requests(id,token_hash,request,type,label,state,created,deadline,revoked_at) VALUES(?,?,?,'pi','','revoked',?,?,?)");
  for(let i=0;i<9999;i++)insert.run(randomUUID(),i.toString(16).padStart(64,'0'),'{}',f.now,f.now+86400000,f.now);
 });
 const fresh=candidate();
 const request=()=>approval.request(fresh.header,fresh.body);
 assert.throws(request,e=>e.status===429);
 f.advance(REVOKED_RETENTION_MS-1);
 assert.throws(request,e=>e.status===429);
 f.advance(1);
 assert.equal(request().status,201);
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM approval_requests').get().n,10001);
 assert.equal(approval.request(original.header,original.body).result.state,'revoked');
 assert.throws(()=>approval.request(original.header,{...original.body,request_id:randomUUID()}),e=>e.status===409);
 assert.equal(approval.reservations().length,10001);
 assert.deepEqual(approval.list().map(r=>r.id),[fresh.body.request_id]);
 // Archival never relaxes the separate pending request bound.
 f.store.tx(()=>{
  const insert=f.store.db.prepare("INSERT INTO approval_requests(id,token_hash,request,type,label,state,created,deadline) VALUES(?,?,?,'pi','','pending',?,?)");
  for(let i=10000;i<10999;i++)insert.run(randomUUID(),i.toString(16).padStart(64,'0'),'{}',f.now,f.now+86400000);
 });
 const overflow=candidate();
 assert.throws(()=>approval.request(overflow.header,overflow.body),e=>e.status===429);
});
