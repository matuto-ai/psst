import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './helpers.mjs';
import { ApprovalService, authorizationDurationMs } from '../src/approval.mjs';
import { approvalsPage } from '../src/admin-pages.mjs';
import { beginApproval, pollApproval, readApprovalState, readEnrollmentReceipt } from '../reference/approval.mjs';

const DAY=86400000;
const candidate=()=>({header:`Enrollment ${randomBytes(32).toString('base64url')}`,body:{request_id:randomUUID(),client_type:'pi',label:'Lifetime fixture'}});
test('authorization days validate finite documented bounds without changing pending defaults',async t=>{
 assert.equal(authorizationDurationMs(),90*DAY);
 for(const n of [1,365,366,730,3650])assert.equal(authorizationDurationMs(String(n)),n*DAY);
 for(const value of ['',null,0,365,NaN,'0','-1','3651','1.5',' 365','365 ','01','1e3','Infinity','unlimited','9999999999'])assert.throws(()=>authorizationDurationMs(value),e=>e.code==='invalid_authorization_days'&&/1 to 3650/.test(e.message));
 const f=fixture(t),a=await ApprovalService.create({store:f.store,credentialMs:authorizationDurationMs('730')}),c=candidate();
 a.request(c.header,c.body);assert.equal(Date.parse(a.status(c.header,c.body.request_id).request_expires_at),f.now+DAY);
 f.advance(DAY);
 assert.equal(a.status(c.header,c.body.request_id).state,'expired');
 assert.throws(()=>a.decide(c.body.request_id,'approve'),e=>e.status===409);
});

test('approval time, exact expiry, replay and restart preserve existing grants under a changed policy',async t=>{
 const f=fixture(t);let a=await ApprovalService.create({store:f.store,credentialMs:authorizationDurationMs('730')});
 f.auth.additionalCredentials=()=>a.credentials();
 const c=candidate();a.request(c.header,c.body);f.advance(DAY-1);
 const approvedAt=f.now,grant=a.decide(c.body.request_id,'approve'),expiry=Date.parse(grant.credential.expires_at);
 assert.equal(expiry,approvedAt+730*DAY);
 const bearer=c.header.replace('Enrollment','Bearer');assert.equal(f.auth.authenticate(bearer).credential_id,grant.credential.credential_id);
 f.advance(DAY);
 f.restart();a=await ApprovalService.create({store:f.store,credentialMs:authorizationDurationMs('3650')});
 assert.deepEqual(a.decide(c.body.request_id,'approve'),grant);
 assert.deepEqual(a.request(c.header,c.body).result,grant);
 assert.equal(f.auth.authenticate(bearer).adapter_id,grant.credential.adapter_id);
 f.advance(expiry-f.now-1);assert.equal(a.status(c.header,c.body.request_id).state,'approved');f.auth.authenticate(bearer);
 f.advance(1);
 assert.throws(()=>f.auth.authenticate(bearer),e=>e.status===401);
 assert.equal(a.status(c.header,c.body.request_id).state,'expired');
 assert.throws(()=>a.decide(c.body.request_id,'approve'),e=>e.status===409);
});

test('UI distinguishes finite active grants, inactive history and never-granted requests',async t=>{
 const f=fixture(t),a=await ApprovalService.create({store:f.store,credentialMs:authorizationDurationMs('730')});
 const pending=candidate(),revoked=candidate(),active=candidate();
 for(const c of [pending,revoked,active])a.request(c.header,c.body);
 const grant=a.decide(revoked.body.request_id,'approve');a.decide(active.body.request_id,'approve');a.decide(revoked.body.request_id,'revoke');
 f.auth.additionalCredentials=()=>a.credentials();
 assert.throws(()=>f.auth.authenticate(revoked.header.replace('Enrollment','Bearer')),e=>e.status===401);
 const html=approvalsPage(a.list(),0,{csrf:'synthetic'});
 assert.ok(!html.includes('Request expires'));assert.ok(!html.includes('Request deadline'));
 assert.match(html,/No authorization granted/);assert.match(html,/Requested/);
 assert.match(html,/Authorization expires/);assert.match(html,/Historical authorization expiry \(inactive\)/);
 assert.ok(Date.parse(grant.credential.expires_at)>f.now);
 const revokedRow=html.split(`data-request-id="${revoked.body.request_id}"`)[1].split('</tr>')[0];
 assert.match(revokedRow,/Revoked/);assert.ok(!revokedRow.includes('Authorization expires'));
 f.advance(731*DAY);
 const expired=approvalsPage(a.list(),0,{csrf:'synthetic'});
 assert.match(expired,/Historical authorization expiry \(inactive\)/);
 assert.ok(!expired.includes('Authorization expires'));
});

test('all shared-helper client types retain existing receipts and agree at exact finite expiry',async t=>{
 const f=fixture(t);t.mock.method(Date,'now',()=>f.now);
 let a=await ApprovalService.create({store:f.store,credentialMs:authorizationDurationMs('730')});
 const bundles=[];
 for(const clientType of ['pi','claude-code','opencode','antigravity-cli']){
  const options={brokerUrl:'https://broker.example',directory:join(f.dir,clientType),clientType};
  const transport=async(_url,method,path,token,input)=>{
   if(method==='POST'){const r=a.request(`Enrollment ${token}`,input);return{status:r.status,body:r.result};}
   return{status:200,body:a.status(`Enrollment ${token}`,path.split('/').at(-1))};
  };
  const pending=await beginApproval(options,{transport});a.decide(pending.requestId,'approve');
  const result=await pollApproval(options,{transport,pollIntervalMs:0});
  assert.equal(Date.parse(result.expiresAt),f.now+730*DAY);
  bundles.push({options,result,bytes:readFileSync(join(result.connectionFile,'..','enrollment.json'),'utf8')});
 }
 f.restart();a=await ApprovalService.create({store:f.store,credentialMs:authorizationDurationMs('3650')});
 for(const {options,result,bytes}of bundles){
  const local=readEnrollmentReceipt({connectionFile:result.connectionFile,clientType:options.clientType});
  assert.equal(local.expiresAt,result.expiresAt);
  assert.equal(readApprovalState(options).credentialId,result.credentialId);
  assert.equal(readFileSync(join(result.connectionFile,'..','enrollment.json'),'utf8'),bytes);
 }
 f.advance(730*DAY-1);
 for(const {options,result}of bundles)assert.equal(readEnrollmentReceipt({connectionFile:result.connectionFile,clientType:options.clientType}).credentialId,result.credentialId);
 f.advance(1);
 for(const {options,result}of bundles){
  assert.throws(()=>readEnrollmentReceipt({connectionFile:result.connectionFile,clientType:options.clientType}),e=>e.code==='credential_expired');
  assert.equal(readApprovalState(options).state,'expired');
 }
});
