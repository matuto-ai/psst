import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { BrokerStore } from '../src/store.mjs';
import { CredentialStore } from '../src/auth.mjs';
import { ApprovalService } from '../src/approval.mjs';
import { beginApproval, pollApproval, readApprovalState } from '../reference/approval.mjs';
import { registration } from './helpers.mjs';
async function setup(t,{pendingMs,credentialMs}={}){
 const dir=mkdtempSync(join(tmpdir(),'psst-approval-test-'));let now=Date.now();
 const store=new BrokerStore({path:join(dir,'broker.sqlite'),clock:()=>now});
 const approval=await ApprovalService.create({store,pendingMs,credentialMs});
 const path=join(dir,'credentials.json');writeFileSync(path,'{"credentials":[]}',{mode:0o600});
 const auth=new CredentialStore({path,clock:()=>now,additionalCredentials:()=>approval.credentials(),onRevoke:ids=>store.revoke(ids),onPolicyChange:e=>store.applyAuthorizationPolicies(e)});
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 return{dir,store,approval,auth,tick:ms=>{now+=ms;}};
}
const candidate=()=>({token:randomBytes(32).toString('base64url'),body:{request_id:randomUUID(),client_type:'pi',label:'Synthetic installation'}});
test('approval gates all access, exact replay, denial, expiry, revocation and backup',async t=>{
 const s=await setup(t,{pendingMs:1000,credentialMs:2000}),c=candidate(),header=`Enrollment ${c.token}`;
 assert.equal(s.store.db.prepare('PRAGMA user_version').get().user_version,5);
 assert.equal(readdirSync(s.dir).filter(n=>n.startsWith('before-approval-')).length,1);
 assert.equal(s.approval.request(header,c.body).status,201);
 assert.equal(s.approval.request(header,c.body).status,200);
 assert.throws(()=>s.auth.authenticate(`Bearer ${c.token}`),e=>e.status===401);
 assert.throws(()=>s.approval.status(`Enrollment ${candidate().token}`,c.body.request_id),e=>e.status===401);
 assert.throws(()=>s.approval.request(header,{...c.body,label:'changed'}),e=>e.status===409);
 const approved=s.approval.decide(c.body.request_id,'approve');
 const principal=s.auth.authenticate(`Bearer ${c.token}`);
 assert.equal(principal.credential_id,approved.credential.credential_id);
 assert.throws(()=>s.store.register(principal,registration('opencode')),e=>e.status===403);
 s.store.register(principal,registration('pi'));
 s.approval.decide(c.body.request_id,'revoke');
 assert.throws(()=>s.auth.authenticate(`Bearer ${c.token}`),e=>e.status===401);
 assert.equal(s.approval.status(header,c.body.request_id).state,'revoked');
 const d=candidate();s.approval.request(`Enrollment ${d.token}`,d.body);s.approval.decide(d.body.request_id,'deny');
 assert.equal(s.approval.status(`Enrollment ${d.token}`,d.body.request_id).state,'denied');
 const e=candidate();s.approval.request(`Enrollment ${e.token}`,e.body);s.tick(1001);
 assert.equal(s.approval.status(`Enrollment ${e.token}`,e.body.request_id).state,'expired');
 assert.throws(()=>s.approval.decide(e.body.request_id,'approve'),e=>e.status===409);
});
test('approval helper persists unknown effects, resumes GET only and preserves replaced credential',async t=>{
 const s=await setup(t),opts={brokerUrl:'https://broker.example',directory:join(s.dir,'client'),clientType:'pi'};let posts=0,gets=0,first;
 assert.equal(readApprovalState(opts),null);
 await assert.rejects(pollApproval(opts),e=>e.code==='approval_setup_required');
 const transport=async(url,method,path,token,input)=>{
  if(method==='POST'){posts++;first??={token,input};const r=s.approval.request(`Enrollment ${token}`,input,s.auth.configuredEntries);return{status:r.status,body:r.result};}
  gets++;return{status:200,body:s.approval.status(`Enrollment ${token}`,path.split('/').at(-1))};
 };
 await assert.rejects(beginApproval(opts,{transport:async(...args)=>{await transport(...args);throw Error('synthetic unknown');}}),e=>e.code==='approval_local_error');
 const pending=await pollApproval(opts,{transport,pollIntervalMs:0});assert.equal(posts,1);assert.equal(gets,1);assert.equal(pending.requestId,first.input.request_id);
 s.approval.decide(pending.requestId,'approve');const result=await pollApproval(opts,{transport,pollIntervalMs:0});assert.equal(result.state,'approved');
 assert.equal(s.auth.authenticate(`Bearer ${first.token}`).credential_id,result.credentialId);
 const next=await beginApproval({...opts,replaceRequestId:pending.requestId},{transport});assert.equal(next.state,'pending');assert.notEqual(next.requestId,pending.requestId);
 assert.equal((await beginApproval({...opts,replaceRequestId:pending.requestId},{transport})).requestId,next.requestId);
 assert.equal(s.auth.authenticate(`Bearer ${first.token}`).credential_id,result.credentialId);
 assert.equal(JSON.parse(readFileSync(result.connectionFile)).enrollment_receipt_file,'enrollment.json');
});
test('legacy ticket and pending approval reserve hashes reciprocally, including revoked tickets',async t=>{
 const s=await setup(t),{EnrollmentService,secretHash}=await import('../src/enrollment.mjs');
 const policyFile=join(s.dir,'policy.json'),key=randomBytes(32).toString('base64url'),legacyToken=randomBytes(32).toString('base64url');
 const policy={format:'psst-enrollment-policy-v1',grants:[{grant_id:'synthetic-grant',secret_sha256:secretHash(key),principal_id:'owner',client_type:'pi',scopes:['psst'],expires_at:new Date(Date.now()+600000).toISOString(),credential_expires_at:new Date(Date.now()+3600000).toISOString()}],revoked_credentials:[]};
 writeFileSync(policyFile,JSON.stringify(policy),{mode:0o600});const legacy=new EnrollmentService({store:s.store,policyFile});
 assert.equal(s.store.db.prepare('PRAGMA user_version').get().user_version,5);
 const issued=legacy.redeem(`Pairing ${key}`,{enrollment_id:randomUUID(),client_type:'pi',token_sha256:secretHash(legacyToken)});
 policy.revoked_credentials.push(issued.result.credential_id);writeFileSync(policyFile,JSON.stringify(policy));assert.equal(legacy.credentials().length,0);
 assert.throws(()=>s.approval.request(`Enrollment ${legacyToken}`,candidate().body,legacy.reservations()),e=>e.status===409);
 const c=candidate();s.approval.request(`Enrollment ${c.token}`,c.body,legacy.reservations());
 const key2=randomBytes(32).toString('base64url');policy.grants.push({...policy.grants[0],grant_id:'synthetic-second',secret_sha256:secretHash(key2)});writeFileSync(policyFile,JSON.stringify(policy));
 assert.throws(()=>legacy.redeem(`Pairing ${key2}`,{enrollment_id:randomUUID(),client_type:'pi',token_sha256:secretHash(c.token)},s.approval.reservations()),e=>e.status===409);
 const approved=s.approval.decide(c.body.request_id,'approve',[...legacy.reservations(),...s.approval.reservations()]);
 s.auth.reload();assert.equal(s.auth.ready,true);
 assert.deepEqual(s.approval.decide(c.body.request_id,'approve',[...s.auth.configuredEntries,...s.approval.reservations()]),approved);
 const inactive=candidate();assert.throws(()=>s.approval.request(`Enrollment ${inactive.token}`,inactive.body,[{token_sha256:secretHash(inactive.token),revoked:true}]),e=>e.status===409);
});
test('shared poll timestamp bounds thirty resumptions without new POST or key',async t=>{
 const s=await setup(t),options={brokerUrl:'https://broker.example',directory:join(s.dir,'shared'),clientType:'pi'};let posts=0,gets=0;
 const transport=async(_url,method,path,token,input)=>{
  if(method==='POST'){posts++;const r=s.approval.request(`Enrollment ${token}`,input);return{status:r.status,body:r.result};}
  gets++;return{status:200,body:s.approval.status(`Enrollment ${token}`,path.split('/').at(-1))};
 };
 const initial=await beginApproval(options,{transport});
 for(let i=0;i<30;i++)assert.equal((await pollApproval(options,{transport})).requestId,initial.requestId);
 assert.equal(posts,1);assert.equal(gets,1);
});
test('helper exposes bounded Retry-After and persists shared backoff without changing UUID/key',async t=>{
 const s=await setup(t),base={brokerUrl:'https://broker.example',clientType:'pi'};
 for(const [header,expected] of [['60',60000],['999999',300000],['nonsense',60000]]){
  const opts={...base,directory:join(s.dir,'retry-'+expected+'-'+header)},seen=[];
  const transport=async(_url,_method,_path,key,body)=>{seen.push({key,body});return{status:429,retryAfter:header,body:{error:{code:'rate_limited',effect:'not_applied'}}};};
  await assert.rejects(beginApproval(opts,{transport}),e=>e.code==='rate_limited'&&e.retryable&&e.retryAfterMs===expected&&e.effect==='not_applied');
  const saved=readApprovalState(opts);assert.equal(saved.requestId,seen[0].body.request_id);
  await assert.rejects(beginApproval(opts,{transport}),e=>e.retryAfterMs<=expected&&e.retryAfterMs>expected-1000);
  await assert.rejects(pollApproval(opts,{transport}),e=>e.retryAfterMs<=expected);
  assert.equal(seen.length,1,'shared persisted backoff blocks further HTTP');
  const attempt=join(opts.directory,'approvals',createHash('sha256').update(base.brokerUrl+'\0pi').digest('hex'),saved.requestId,'attempt.json');
  const state=JSON.parse(readFileSync(attempt));state.retryAt=Date.now()-1;writeFileSync(attempt,JSON.stringify(state));
  await assert.rejects(beginApproval(opts,{transport}),e=>e.code==='rate_limited');
  assert.deepEqual(seen[1],seen[0]);
 }
 const opts={...base,directory:join(s.dir,'temporary-server')};
 await assert.rejects(beginApproval(opts,{transport:async()=>({status:503,body:{error:{code:'not_ready',effect:'unknown'}}})}),e=>e.retryAfterMs===5000&&e.effect==='unknown');
});
