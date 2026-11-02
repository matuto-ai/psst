import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { BrokerStore } from '../src/store.mjs';
import { fixture, registration, sendBody, uuid } from './helpers.mjs';
const code=(fn,c)=>assert.throws(fn,e=>e.code===c);
function pair(f){const a=registration(),b=registration();f.store.register(f.a.entry,a);f.store.register(f.b.entry,b);return [a,b];}

test('registry identity, metadata, exact discovery and idempotent registration',t=>{
 const f=fixture(t),[a,b]=pair(f);const first=f.store.session(f.a.entry,a.client_id);
 assert.equal(first.lease_epoch,1);assert.equal(f.store.list(f.a.entry).clients.length,2);
 const retried=f.store.register(f.a.entry,a);assert.equal(retried.lease_epoch,1);
 code(()=>f.store.register(f.a.entry,{...a,metadata:{...a.metadata,name:'changed'}}),'idempotency_conflict');
 code(()=>f.store.register(f.b.entry,a),'identity_conflict');
 code(()=>f.store.register(f.a.entry,{...a,client_type:'opencode',capabilities:{...a.capabilities,client_type:'opencode'}}),'identity_conflict');
 f.store.metadata(f.a.entry,a.client_id,1,{metadata_patch:{name:'new',project:null},expected_metadata_revision:1});
 assert.equal(f.store.list(f.a.entry,{name:'new'}).clients[0].client_id,a.client_id);
 code(()=>f.store.metadata(f.a.entry,a.client_id,1,{metadata_patch:{name:'x'},expected_metadata_revision:1}),'metadata_conflict');
 assert.equal(f.store.list(f.c.entry).clients.length,0);assert.equal(f.store.list(f.a.entry,{client_type:'pi',limit:'1'}).clients.length,1);
});

test('lease expiry, genuine reconnect, close and restart fencing',t=>{
 const f=fixture(t),[a,b]=pair(f);f.advance(180001);
 assert.equal(f.store.list(f.a.entry).clients.length,0);
 code(()=>f.store.heartbeat(f.a.entry,a.client_id,1),'stale_lease_epoch');
 f.store.register(f.a.entry,a);code(()=>f.store.heartbeat(f.a.entry,a.client_id,1),'stale_lease_epoch');
 const reconnect={...a,connection_id:uuid(),previous_epoch:1};assert.equal(f.store.register(f.a.entry,reconnect).lease_epoch,2);
 code(()=>f.store.heartbeat(f.a.entry,a.client_id,1),'stale_lease_epoch');
 f.restart();code(()=>f.store.heartbeat(f.a.entry,a.client_id,2),'stale_lease_epoch');
 f.store.register(f.a.entry,{...a,connection_id:uuid(),previous_epoch:2});
 assert.equal(f.store.closeSession(f.a.entry,a.client_id,3).closed,true);
 assert.equal(f.store.closeSession(f.a.entry,a.client_id,3).closed,true);
 code(()=>f.store.register(f.a.entry,{...a,connection_id:uuid(),previous_epoch:3}),'session_closed');
 assert.equal(f.store.session(f.b.entry,b.client_id).connected,false);
});

test('send idempotency wins over mutable metadata, recipient close, quota and rate checks',t=>{
 const f=fixture(t,{limits:{max_pending_messages:1,send_burst:1}}),[a,b]=pair(f);
 const body=sendBody(b.client_id,'hello',{metadata_patch:{name:'atomic'},expected_metadata_revision:1});
 const first=f.store.send(f.a.entry,a.client_id,1,'key',body);
 f.store.closeSession(f.b.entry,b.client_id,1);
 assert.deepEqual(f.store.send(f.a.entry,a.client_id,1,'key',body),first);
 assert.equal(f.store.session(f.a.entry,a.client_id).metadata_revision,2);
 code(()=>f.store.send(f.a.entry,a.client_id,1,'key',sendBody(b.client_id,'changed')),'idempotency_conflict');
 const status=f.store.receipt(f.a.entry,a.client_id,first.message_id);assert.equal(status.delivery_state,'failed');assert.equal(status.delivery_uncertain,false);
 code(()=>f.store.receipt(f.c.entry,a.client_id,first.message_id),'recipient_not_found');
});

test('FIFO claims, lost-response replay, renew, exact recipient ACK and duplicate completion',t=>{
 const f=fixture(t),[a,b]=pair(f),s=f.store;
 const first=s.send(f.a.entry,a.client_id,1,'a',sendBody(b.client_id)),second=s.send(f.a.entry,a.client_id,1,'b',sendBody(b.client_id));
 const claim=s.claim(f.b.entry,b.client_id,1,'c',{});assert.equal(claim.envelope.message_id,first.message_id);
 assert.deepEqual(s.claim(f.b.entry,b.client_id,1,'c',{}),claim);
 assert.equal(s.claim(f.b.entry,b.client_id,1,'other',{}),null);
 assert.equal(s.renew(f.b.entry,b.client_id,1,first.message_id,{claim_id:claim.claim_id}).claim_id,claim.claim_id);
 code(()=>s.complete(f.a.entry,a.client_id,1,first.message_id,{claim_id:claim.claim_id,outcome:'delivered'}),'message_not_found');
 const complete={claim_id:claim.claim_id,outcome:'delivered'};const receipt=s.complete(f.b.entry,b.client_id,1,first.message_id,complete);assert.equal(receipt.delivery_state,'delivered');assert.equal(receipt.delivery_uncertain,false);
 assert.deepEqual(s.complete(f.b.entry,b.client_id,1,first.message_id,complete),receipt);
 code(()=>s.claim(f.b.entry,b.client_id,1,'c',{}),'claim_conflict');
 code(()=>s.complete(f.b.entry,b.client_id,1,first.message_id,{...complete,outcome:'retryable_not_stored'}),'claim_conflict');
 assert.equal(s.claim(f.b.entry,b.client_id,1,'next',{}).envelope.message_id,second.message_id);
});

test('unconfirmed transport remains uncertain through expiry, retry, close and restart',t=>{
 const f=fixture(t),[a,b]=pair(f);const m=f.store.send(f.a.entry,a.client_id,1,'a',sendBody(b.client_id,'x',{ttl_seconds:60}));
 f.store.claim(f.b.entry,b.client_id,1,'c',{});f.advance(60001);
 assert.equal(f.store.receipt(f.a.entry,a.client_id,m.message_id).delivery_uncertain,true);assert.equal(f.store.receipt(f.a.entry,a.client_id,m.message_id).delivery_state,'expired');
 const n=f.store.send(f.a.entry,a.client_id,1,'b',sendBody(b.client_id));const before=f.store.claim(f.b.entry,b.client_id,1,'d',{});
 f.restart();f.store.register(f.a.entry,{...a,connection_id:uuid(),previous_epoch:1});f.store.register(f.b.entry,{...b,connection_id:uuid(),previous_epoch:1});
 code(()=>f.store.complete(f.b.entry,b.client_id,1,n.message_id,{claim_id:before.claim_id,outcome:'delivered'}),'stale_lease_epoch');
 const after=f.store.claim(f.b.entry,b.client_id,2,'e',{});assert.equal(after.envelope.message_id,n.message_id);assert.equal(after.attempt,2);
 f.store.complete(f.b.entry,b.client_id,2,n.message_id,{claim_id:after.claim_id,outcome:'permanent_not_stored',reason:'unsupported_envelope'});
 assert.equal(f.store.receipt(f.a.entry,a.client_id,n.message_id).delivery_uncertain,true);
});

test('transaction failure before commit rolls back; after commit reports unknown and replay is durable',t=>{
 let stage;const f=fixture(t,{fault:where=>{if(stage===where){stage=null;throw new Error('injected');}}}),[a,b]=pair(f);
 stage='before_commit';code(()=>f.store.send(f.a.entry,a.client_id,1,'pre',sendBody(b.client_id)),'storage_unavailable');
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM messages').get().n,0);
 stage='after_commit';assert.throws(()=>f.store.send(f.a.entry,a.client_id,1,'post',sendBody(b.client_id)),e=>e.code==='storage_unavailable'&&e.effect==='unknown');
 const replay=f.store.send(f.a.entry,a.client_id,1,'post',sendBody(b.client_id));assert.equal(replay.recipient_sequence,1);
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM messages').get().n,1);
});

test('single writer, schema durability, safe backup restore and disk safety',async t=>{
 let safe=true;const f=fixture(t,{diskCheck:()=>safe}),[a,b]=pair(f);const message=f.store.send(f.a.entry,a.client_id,1,'persist',sendBody(b.client_id));
 assert.throws(()=>new BrokerStore({path:f.path}),/locked/);
 assert.equal(f.store.db.prepare('PRAGMA synchronous').get().synchronous,2);assert.equal(f.store.db.prepare('PRAGMA journal_mode').get().journal_mode,'wal');
 const target=`${f.dir}/backup.sqlite`;await f.store.backup(target);const restored=new BrokerStore({path:target,clock:()=>f.now});t.after(()=>restored.close());
 assert.equal(restored.session(f.a.entry,a.client_id).connected,false);assert.equal(restored.receipt(f.a.entry,a.client_id,message.message_id).delivery_state,'queued');
 safe=false;assert.equal(f.store.safe(),false);code(()=>f.store.send(f.a.entry,a.client_id,1,'unsafe',sendBody(b.client_id)),'storage_unavailable');
});

// Backup and restore must share logical time; never compare fixture mail to wall time.
test('restored backup TTL is deterministic before and at expiry across fixture dates',async t=>{
 for(const start of ['2000-01-01T00:00:00Z','2100-01-01T00:00:00Z']){
  const f=fixture(t);f.advance(Date.parse(start)-f.now);const [a,b]=pair(f);
  const body=sendBody(b.client_id,'saved',{ttl_seconds:60});
  const sent=f.store.send(f.a.entry,a.client_id,1,'ttl-boundary',body);
  const target=`${f.dir}/ttl-backup.sqlite`;await f.store.backup(target);
  f.advance(30000); // Restoring an older snapshot must not restart its message TTL.
  const restored=new BrokerStore({path:target,clock:()=>f.now});
  try{
   assert.equal(restored.session(f.a.entry,a.client_id).connected,false);
   const pending=restored.receipt(f.a.entry,a.client_id,sent.message_id);
   assert.equal(pending.delivery_state,'queued');assert.equal(pending.expires_at,sent.expires_at);
   const connection=restored.register(f.a.entry,{...a,previous_epoch:1,connection_id:uuid()});
   assert.deepEqual(restored.send(f.a.entry,a.client_id,connection.lease_epoch,'ttl-boundary',body),sent);
   f.advance(29999);assert.equal(restored.receipt(f.a.entry,a.client_id,sent.message_id).delivery_state,'queued');
   f.advance(1);const expired=restored.receipt(f.a.entry,a.client_id,sent.message_id);
   assert.equal(expired.delivery_state,'expired');assert.equal(expired.terminal_at,sent.expires_at);
   assert.equal(expired.delivery_uncertain,false);
  }finally{restored.close();}
 }
});

test('finite mailbox and byte bounds, unknown scopes, capability and sender protection',t=>{
 const f=fixture(t,{limits:{max_pending_bytes:4}}),[a,b]=pair(f);
 code(()=>f.store.send(f.a.entry,a.client_id,1,'large',sendBody(b.client_id,'12345')),'mailbox_full');
 code(()=>f.store.send(f.c.entry,a.client_id,1,'wrong',sendBody(b.client_id)),'recipient_not_found');
 const other=registration();f.store.register(f.c.entry,other);code(()=>f.store.send(f.a.entry,a.client_id,1,'hidden',sendBody(other.client_id)),'recipient_not_found');
 const off=registration('opencode');off.capabilities.receive_enabled=false;f.store.register(f.b.entry,off);code(()=>f.store.send(f.a.entry,a.client_id,1,'off',sendBody(off.client_id)),'receiving_disabled');
 code(()=>f.store.send(f.a.entry,a.client_id,1,'forged',{...sendBody(b.client_id),sender:{client_id:b.client_id}}),'invalid_request');
});

test('retention waits past both terminal age and TTL plus retry window',t=>{
 const f=fixture(t),[a,b]=pair(f);const m=f.store.send(f.a.entry,a.client_id,1,'retain',sendBody(b.client_id,'x',{ttl_seconds:604800}));
 f.store.closeSession(f.b.entry,b.client_id,1);f.advance(604801000);assert.equal(f.store.receipt(f.a.entry,a.client_id,m.message_id).delivery_state,'failed');
 f.advance(86401000);code(()=>f.store.receipt(f.a.entry,a.client_id,m.message_id),'message_not_found');
});

test('scope removal never discloses a queued or replayed claim envelope',t=>{
 const f=fixture(t),wide={...f.a.entry,scopes:['secret','public']},narrow={...wide,scopes:['public']};const a=registration(),b=registration();
 f.store.register(wide,a);f.store.register(wide,b);f.store.send(wide,a.client_id,1,'secret',sendBody(b.client_id,'private'));
 code(()=>f.store.claim(narrow,b.client_id,1,'no-leak',{}),'forbidden');
 const claim=f.store.claim(wide,b.client_id,1,'original',{});assert.equal(claim.envelope.content.text,'private');
 code(()=>f.store.claim(narrow,b.client_id,1,'original',{}),'forbidden');
});

test('expired head is never claimed even beyond global cleanup batch',t=>{
 const f=fixture(t,{limits:{send_burst:1000,principal_send_burst:1000}}),[a,b]=pair(f);
 const other=registration();f.store.register(f.b.entry,other);
 for(let i=0;i<110;i++)f.store.send(f.a.entry,a.client_id,1,`old-${i}`,sendBody(other.client_id,'x',{ttl_seconds:60}));
 const expired=f.store.send(f.a.entry,a.client_id,1,'last',sendBody(b.client_id,'secret',{ttl_seconds:60}));
 f.advance(60001);assert.equal(f.store.claim(f.b.entry,b.client_id,1,'head',{}),null);
 assert.equal(f.store.receipt(f.a.entry,a.client_id,expired.message_id).delivery_state,'expired');
});

test('lowered configured message bytes and TTL defaults apply',t=>{
 const f=fixture(t,{limits:{max_message_bytes:4,default_ttl_seconds:60}}),[a,b]=pair(f);
 code(()=>f.store.send(f.a.entry,a.client_id,1,'lowered',sendBody(b.client_id,'12345')),'payload_too_large');
 const sent=f.store.send(f.a.entry,a.client_id,1,'default',sendBody(b.client_id,'1234'));
 assert.equal(Date.parse(sent.expires_at)-f.now,60000);
});

test('completion replay does not bypass narrowed scope authorization',t=>{
 const f=fixture(t),wide={...f.a.entry,scopes:['secret','public']},narrow={...wide,scopes:['public']};const a=registration(),b=registration();
 f.store.register(wide,a);f.store.register(wide,b);const sent=f.store.send(wide,a.client_id,1,'secret',sendBody(b.client_id));
 const claim=f.store.claim(wide,b.client_id,1,'c',{}),completion={claim_id:claim.claim_id,outcome:'delivered'};
 f.store.complete(wide,b.client_id,1,sent.message_id,completion);
 code(()=>f.store.complete(narrow,b.client_id,1,sent.message_id,completion),'message_not_found');
 code(()=>f.store.receipt(narrow,a.client_id,sent.message_id),'message_not_found');
});

test('commit-stage failure is not_applied only after confirmed rollback',t=>{
 let enabled=false;const f=fixture(t,{fault:where=>{if(enabled&&where==='commit_attempt')throw new Error('commit failure');}}),[a,b]=pair(f);
 enabled=true;assert.throws(()=>f.store.send(f.a.entry,a.client_id,1,'commit',sendBody(b.client_id)),e=>e.effect==='not_applied');enabled=false;
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM messages').get().n,0);
});

test('rollback uncertainty poisons writer readiness until restart and never claims no effect',t=>{
 let enabled=false;const f=fixture(t,{fault:where=>{if(enabled&&['commit_attempt','before_rollback'].includes(where))throw new Error('I/O fault');}}),[a,b]=pair(f);
 enabled=true;assert.throws(()=>f.store.send(f.a.entry,a.client_id,1,'uncertain',sendBody(b.client_id)),e=>e.effect==='unknown');
 assert.equal(f.store.safe(),false);enabled=false;f.restart();assert.equal(f.store.safe(),true);assert.equal(f.store.db.prepare('SELECT count(*) n FROM messages').get().n,0);
});

test('receipt expiry is exact beyond cleanup batch and empty claim replay stays empty',t=>{
 const f=fixture(t,{limits:{send_burst:1000,principal_send_burst:1000}}),[a,b]=pair(f);const other=registration();f.store.register(f.b.entry,other);
 for(let i=0;i<210;i++)f.store.send(f.a.entry,a.client_id,1,`old-${i}`,sendBody(other.client_id,'x',{ttl_seconds:60}));
 const old=f.store.send(f.a.entry,a.client_id,1,'old',sendBody(b.client_id,'x',{ttl_seconds:60}));f.advance(60001);
 assert.equal(f.store.receipt(f.a.entry,a.client_id,old.message_id).delivery_state,'expired');
 assert.equal(f.store.claim(f.b.entry,b.client_id,1,'empty',{}),null);
 f.store.send(f.a.entry,a.client_id,1,'new',sendBody(b.client_id));
 assert.equal(f.store.claim(f.b.entry,b.client_id,1,'empty',{}),null);
 assert.ok(f.store.claim(f.b.entry,b.client_id,1,'new-claim',{}));
});

test('unsafe or unknown policy configuration cannot start a broker',t=>{
 const f=fixture(t);for(const limits of [{typo:1},{retention_seconds:1},{registration_retention_seconds:1},{lease_seconds:100},{max_wait_seconds:31},{max_message_bytes:100000},{default_ttl_seconds:50}])assert.throws(()=>new BrokerStore({path:`${f.dir}/invalid.sqlite`,limits}));
});

test('per-token allowed types constrain all exact-session operations despite shared installation',t=>{
 const f=fixture(t),[a,b]=pair(f),limited={...f.a.entry,client_types:['claude-code']};
 const sent=f.store.send(f.a.entry,a.client_id,1,'type',sendBody(b.client_id));
 code(()=>f.store.session(limited,a.client_id),'recipient_not_found');
 code(()=>f.store.heartbeat(limited,a.client_id,1),'recipient_not_found');
 code(()=>f.store.send(limited,a.client_id,1,'type',sendBody(b.client_id)),'recipient_not_found');
 code(()=>f.store.claim(limited,a.client_id,1,'claim',{}),'recipient_not_found');
 code(()=>f.store.metadata(limited,a.client_id,1,{metadata_patch:{name:'wrong'},expected_metadata_revision:1}),'recipient_not_found');
 code(()=>f.store.receipt(limited,a.client_id,sent.message_id),'recipient_not_found');
 code(()=>f.store.closeSession(limited,a.client_id,1),'recipient_not_found');
});

test('negative ACK resolves only its own uncertainty, retaining earlier unconfirmed attempts',t=>{
 const f=fixture(t),[a,b]=pair(f),sent=f.store.send(f.a.entry,a.client_id,1,'certainty',sendBody(b.client_id));
 for(let i=0;i<2;i++){
  const claim=f.store.claim(f.b.entry,b.client_id,1,`negative-${i}`,{});
  const result=f.store.complete(f.b.entry,b.client_id,1,sent.message_id,{claim_id:claim.claim_id,outcome:'retryable_not_stored',reason:'inbox_full'});
  assert.equal(result.delivery_uncertain,false);
 }
 const lost=f.store.claim(f.b.entry,b.client_id,1,'lost',{});f.advance(120001);
 f.store.heartbeat(f.b.entry,b.client_id,1);
 const next=f.store.claim(f.b.entry,b.client_id,1,'after-lost',{});assert.notEqual(next.claim_id,lost.claim_id);
 const result=f.store.complete(f.b.entry,b.client_id,1,sent.message_id,{claim_id:next.claim_id,outcome:'permanent_not_stored',reason:'unsupported_envelope'});
 assert.equal(result.delivery_uncertain,true);
});

test('v1 to current schema migration preserves pending mail, epoch identities and idempotency records',t=>{
 const f=fixture(t),[a,b]=pair(f),sent=f.store.send(f.a.entry,a.client_id,1,'migrate',sendBody(b.client_id));
 f.store.db.exec('ALTER TABLE messages DROP COLUMN claim_prior_uncertain; PRAGMA user_version=1;');f.restart();
 assert.equal(f.store.db.prepare('PRAGMA user_version').get().user_version,5);
 assert.equal(f.store.receipt(f.a.entry,a.client_id,sent.message_id).delivery_state,'queued');
 f.store.register(f.a.entry,{...a,previous_epoch:1,connection_id:uuid()});
 assert.equal(f.store.send(f.a.entry,a.client_id,2,'migrate',sendBody(b.client_id)).message_id,sent.message_id);
 assert.equal(f.store.session(f.b.entry,b.client_id).connected,false);
});
