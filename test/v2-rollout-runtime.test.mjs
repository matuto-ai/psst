import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {writeFileSync} from 'node:fs';
import {httpFixture,registration,uuid} from './helpers.mjs';
import {Inbox,newSessionIdentity} from '../reference/inbox.mjs';
import {BrokerClient,BrokerError} from '../reference/client.mjs';
import {AdapterRuntime} from '../reference/runtime.mjs';
const R=172800000;
const stopSleep=(ms,value,{signal})=>new Promise((resolve,reject)=>{
 if(signal.aborted)return reject(Object.assign(Error('aborted'),{code:'request_aborted'}));
 signal.addEventListener('abort',()=>reject(Object.assign(Error('aborted'),{code:'request_aborted'})),{once:true});
});
async function setup(t,{version=2,retention=true,leaseSeconds=180}={}){
 let inbox,runtime;
 t.after(async()=>{await runtime?.stop({closeSession:false});inbox?.close();});
 const f=await httpFixture(t,{requireRegistrationV2:retention,limits:{session_retention_seconds:retention?R/1000:0,lease_seconds:leaseSeconds}});
 inbox=new Inbox({directory:join(f.dir,'original'),identity:newSessionIdentity('pi'),now:()=>f.now});
 const tokenFile=join(f.dir,'token');writeFileSync(tokenFile,f.a.token,{mode:0o600});
 const client=new BrokerClient({url:f.base,tokenFile,insecureDevelopment:true,inbox,now:()=>f.now,registrationVersion:version});
 const diagnostics=[];let alive=true;
 runtime=new AdapterRuntime({client,verifySession:()=>true,isAlive:()=>alive,receiveEnabled:false,sleep:stopSleep,onDiagnostic:x=>diagnostics.push(x.code),closeOnLostSession:false});
 await runtime.start(registration().metadata);
 return{...f,f,inbox,client,runtime,diagnostics,setAlive:v=>alive=v};
}

test('v2 owned404 pauses both loops after GET confirmation; old work is not replayed or rebound',async t=>{
 const x=await setup(t);x.inbox.setState('claim_pending',{key:'original-claim'});
 x.f.advance(R+180000);x.store.sweep();
 let observed;try{await x.runtime.heartbeatOnce();}catch(e){observed=e;}
 assert.equal(observed.status,404);
 const sameIdentity=x.client.identity.client_id;
 assert.equal(await x.runtime.handleTransportError(observed,x.runtime.controller.signal,{ownedSessionOperation:true}),false);
 await Promise.all(x.runtime.loops);
 assert.equal(x.runtime.paused,true);assert.equal(x.runtime.controller.signal.aborted,true);
 assert.ok(x.diagnostics.includes('session_expired'));assert.equal(x.client.expiredIdentityConfirmed,true);
 assert.equal(x.client.identity.client_id,sameIdentity);assert.deepEqual(x.inbox.getState('claim_pending'),{key:'original-claim'});
 assert.equal(x.store.db.prepare('SELECT count(*) n FROM sessions').get().n,0);
});

test('recipient-message404 and authentication errors never authorize identity replacement',async t=>{
 const x=await setup(t);const identity=x.client.identity.client_id;let error;
 try{await x.client.request('POST','/v1/messages',{key:'missing-target',body:{recipient_id:uuid(),content:{type:'text/plain',text:'missing target'}}});}catch(e){error=e;}
 assert.equal(error.status,404);assert.equal(error.code,'recipient_not_found');
 // A destination failure is outside the owned heartbeat/receive error boundary.
 assert.equal(await x.runtime.handleTransportError(error,x.runtime.controller.signal),true);
 assert.equal(x.client.expiredIdentityConfirmed,false);assert.equal(x.runtime.paused,false);
 await assert.rejects(x.client.createReplacementInbox({directory:join(x.dir,'forbidden-new'),verifySession:()=>true}),e=>e.code==='session_mismatch');
 const authError=new BrokerError(401,{error:{code:'unauthenticated',effect:'not_applied'}});
 assert.equal(await x.runtime.handleTransportError(authError,x.runtime.controller.signal,{ownedSessionOperation:true}),false);
 assert.equal(x.client.expiredIdentityConfirmed,false);assert.equal(x.client.identity.client_id,identity);
});

test('v1 and v2 without retention resume same identity after ordinary lease expiry',async t=>{
 for(const version of [1,2]){
  const x=await setup(t,{version,retention:false}),id=x.client.identity.client_id,old=x.client.attachment.lease_epoch;
  x.f.advance(180001);let e;try{await x.runtime.heartbeatOnce();}catch(error){e=error;}
  assert.equal(e.code,'stale_lease_epoch');assert.equal(await x.runtime.handleTransportError(e,x.runtime.controller.signal,{ownedSessionOperation:true}),true);
  assert.equal(x.client.identity.client_id,id);assert.ok(x.client.attachment.lease_epoch>old);assert.equal(x.client.expiredIdentityConfirmed,false);
 }
});

test('v1 own404 does not silently upgrade, generate an identity or migrate journals',async t=>{
 const x=await setup(t,{version:1,retention:false});const id=x.client.identity.client_id;
 const e=new BrokerError(404,{error:{code:'recipient_not_found',effect:'not_applied'}});
 assert.equal(await x.runtime.handleTransportError(e,x.runtime.controller.signal,{ownedSessionOperation:true}),true);
 assert.equal(x.client.identity.client_id,id);assert.equal(x.client.registrationVersion,1);assert.equal(x.client.expiredIdentityConfirmed,false);
});

test('native inactivity uses resumable stop, not terminal close; active lease survives retention threshold',async t=>{
 const active=await setup(t,{leaseSeconds:200000});const id=active.client.identity.client_id;
 active.f.advance(R);active.store.sweep();assert.equal(active.store.session(active.a.entry,id).connected,true);
 active.setAlive(false);assert.equal(await active.runtime.checkAlive(),false);await active.runtime.stop({closeSession:false});
 const disconnected=active.store.session(active.a.entry,id);assert.equal(disconnected.closed,false);assert.equal(disconnected.presence_state,'disconnected');
 active.f.advance(R);active.store.sweep();assert.throws(()=>active.store.session(active.a.entry,id),e=>e.code==='recipient_not_found');
});

test('explicit terminal close still escalates after resumable inactivity',async t=>{
 const x=await setup(t);const id=x.client.identity.client_id;x.setAlive(false);
 await x.runtime.checkAlive();await x.runtime.stop({closeSession:false});assert.equal(x.store.session(x.a.entry,id).closed,false);
 await x.runtime.stop({closeSession:true});assert.equal(x.store.session(x.a.entry,id).closed,true);
});
