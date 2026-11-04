import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, registration, sendBody, uuid } from './helpers.mjs';
const code=(fn,c)=>assert.throws(fn,e=>e.code===c);
function pair(f){const a=registration(),b=registration();f.store.register(f.a.entry,a);f.store.register(f.b.entry,b);return [a,b];}
const send=(f,a,b,key=uuid(),extra={})=>f.store.send(f.a.entry,a.client_id,1,key,sendBody(b.client_id,'opaque\n🧪 <script>no authority</script>',extra));

test('explicit resend is owned, retains exact content, creates new identity/lineage and retries one intent',t=>{
 const f=fixture(t),[a,b]=pair(f),original=send(f,a,b),key=uuid();
 const resent=f.store.resend(f.a.entry,a.client_id,1,key,original.message_id,{});
 assert.notEqual(resent.message_id,original.message_id);assert.equal(resent.resent_from_message_id,original.message_id);
 assert.deepEqual(f.store.resend(f.a.entry,a.client_id,1,key,original.message_id,{}),resent);
 assert.equal(f.store.messageContent(f.a.entry,a.client_id,resent.message_id).envelope.content.text,f.store.messageContent(f.a.entry,a.client_id,original.message_id).envelope.content.text);
 assert.notEqual(f.store.resend(f.a.entry,a.client_id,1,uuid(),original.message_id,{}).message_id,resent.message_id);
 code(()=>f.store.resend(f.a.entry,a.client_id,1,key,original.message_id,{ttl_seconds:120}),'idempotency_conflict');
 code(()=>f.store.send(f.a.entry,a.client_id,1,key,sendBody(b.client_id)),'idempotency_conflict');
 code(()=>f.store.resend(f.b.entry,b.client_id,1,uuid(),original.message_id,{}),'message_not_found');
 const sibling=registration();f.store.register(f.a.entry,sibling);code(()=>f.store.resend(f.a.entry,sibling.client_id,1,uuid(),original.message_id,{}),'message_not_found');
 f.store.db.prepare('UPDATE messages SET envelope=NULL WHERE id=?').run(original.message_id);
 code(()=>f.store.resend(f.a.entry,a.client_id,1,uuid(),original.message_id,{}),'content_unavailable');
 assert.equal(f.store.resend(f.a.entry,a.client_id,1,key,original.message_id,{}).message_id,resent.message_id,'known replay needs no source body');
});

test('queued cancel is idempotent, terminal, audited and stops claim without closing recipient',t=>{
 const f=fixture(t),[a,b]=pair(f),message=send(f,a,b);
 const cancel=f.store.cancel(f.a.entry,a.client_id,1,message.message_id);
 assert.equal(cancel.delivery_state,'cancelled');assert.equal(cancel.cancel_result,'cancelled');assert.equal(cancel.delivery_may_have_occurred,false);assert.ok(cancel.cancelled_at);
 assert.deepEqual(f.store.cancel(f.a.entry,a.client_id,1,message.message_id),cancel);
 assert.equal(f.store.claim(f.b.entry,b.client_id,1,uuid(),{}),null);assert.equal(f.store.session(f.b.entry,b.client_id).closed,false);
 assert.equal(f.store.history(f.a.entry,a.client_id,{status:'cancelled'}).messages.length,1);
 assert.notEqual(f.store.resend(f.a.entry,a.client_id,1,uuid(),message.message_id,{}).message_id,message.message_id);
 code(()=>f.store.cancel(f.b.entry,b.client_id,1,message.message_id),'message_not_found');
});

test('claimed cancellation preserves uncertainty, and valid late completion truthfully records delivery',t=>{
 for(const outcome of ['delivered','retryable_not_stored','permanent_not_stored']){
  const f=fixture(t),[a,b]=pair(f),message=send(f,a,b),claim=f.store.claim(f.b.entry,b.client_id,1,uuid(),{});
  const cancel=f.store.cancel(f.a.entry,a.client_id,1,message.message_id);assert.equal(cancel.delivery_uncertain,true);assert.equal(cancel.delivery_may_have_occurred,true);
  code(()=>f.store.renew(f.b.entry,b.client_id,1,message.message_id,{claim_id:claim.claim_id}),'claim_conflict');
  const completion={claim_id:claim.claim_id,outcome,...(outcome==='retryable_not_stored'?{reason:'storage_unavailable'}:outcome==='permanent_not_stored'?{reason:'unsupported_envelope'}:{})};
  const result=f.store.complete(f.b.entry,b.client_id,1,message.message_id,completion);
  assert.equal(result.delivery_state,outcome==='delivered'?'delivered':'cancelled');assert.equal(result.delivery_uncertain,false);assert.ok(result.cancelled_at);
  assert.deepEqual(f.store.complete(f.b.entry,b.client_id,1,message.message_id,completion),result);
  assert.equal(f.store.claim(f.b.entry,b.client_id,1,uuid(),{}),null);
 }
});

test('complete-before-cancel, expiry, failure and earlier uncertainty never claim undo',t=>{
 const f=fixture(t),[a,b]=pair(f),message=send(f,a,b),claim=f.store.claim(f.b.entry,b.client_id,1,uuid(),{});
 f.store.complete(f.b.entry,b.client_id,1,message.message_id,{claim_id:claim.claim_id,outcome:'delivered'});
 const delivered=f.store.cancel(f.a.entry,a.client_id,1,message.message_id);assert.equal(delivered.cancel_result,'already_delivered');assert.equal(delivered.delivery_may_have_occurred,true);
 const second=send(f,a,b);f.store.claim(f.b.entry,b.client_id,1,uuid(),{});f.advance(120001);f.store.heartbeat(f.a.entry,a.client_id,1);f.store.heartbeat(f.b.entry,b.client_id,1);f.store.sweep();
 const uncertain=f.store.cancel(f.a.entry,a.client_id,1,second.message_id);assert.equal(uncertain.delivery_state,'cancelled');assert.equal(uncertain.delivery_uncertain,true);
 const third=send(f,a,b,uuid(),{ttl_seconds:60});f.advance(60000);assert.equal(f.store.cancel(f.a.entry,a.client_id,1,third.message_id).delivery_state,'expired');
 const fourth=send(f,a,b);f.store.closeSession(f.b.entry,b.client_id,1);assert.equal(f.store.cancel(f.a.entry,a.client_id,1,fourth.message_id).cancel_result,'already_terminal');
 code(()=>f.store.resend(f.a.entry,a.client_id,1,uuid(),fourth.message_id,{}),'session_closed');
});

test('restart and timestamped recovery guards never turn a recovered old send into fresh delivery',t=>{
 const f=fixture(t),[a,b]=pair(f),key=`op_${f.now}_${uuid().replaceAll('-','')}`,body=sendBody(b.client_id,'retained',{ttl_seconds:60}),sent=f.store.send(f.a.entry,a.client_id,1,key,body);
 f.store.cancel(f.a.entry,a.client_id,1,sent.message_id);f.advance(8*86400000);f.store.sweep();
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM messages').get().n,0);
 f.restart();f.store.register(f.a.entry,{...a,previous_epoch:1,connection_id:uuid()});
 code(()=>f.store.send(f.a.entry,a.client_id,2,key,body),'retry_window_elapsed');
 code(()=>f.store.send(f.a.entry,a.client_id,2,key,{...body,content:{type:'text/plain',text:'changed'}}),'retry_window_elapsed');
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM messages').get().n,0);
});

test('timestamped unknown keys enforce retry window and future clock bound without permanent ledger',t=>{
 const f=fixture(t),[a,b]=pair(f),operation=at=>`op_${at}_${uuid().replaceAll('-','')}`;
 code(()=>send(f,a,b,operation(f.now-86400000)),'retry_window_elapsed');
 code(()=>send(f,a,b,operation(f.now+300001)),'invalid_request');
 code(()=>send(f,a,b,'op_malformed'),'invalid_request');
 assert.ok(send(f,a,b,operation(f.now-86399999)).message_id);
 assert.ok(send(f,a,b,operation(f.now+300000)).message_id);
 assert.equal(f.store.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='send_tombstones'").get().n,0);
});

test('lost commit ACK for resend and cancel reconciles after restart without duplicates',t=>{
 let armed=false;const f=fixture(t,{fault:point=>{if(armed&&point==='after_commit'){armed=false;throw Error('lost');}}}),[a,b]=pair(f),first=send(f,a,b),key=uuid();
 armed=true;assert.throws(()=>f.store.resend(f.a.entry,a.client_id,1,key,first.message_id,{}),e=>e.effect==='unknown');
 const replay=f.store.resend(f.a.entry,a.client_id,1,key,first.message_id,{});assert.equal(f.store.db.prepare('SELECT count(*) n FROM messages').get().n,2);
 armed=true;assert.throws(()=>f.store.cancel(f.a.entry,a.client_id,1,replay.message_id),e=>e.effect==='unknown');
 f.restart();f.store.register(f.a.entry,{...a,previous_epoch:1,connection_id:uuid()});
 assert.equal(f.store.cancel(f.a.entry,a.client_id,2,replay.message_id).cancel_result,'cancelled');
 assert.equal(f.store.resend(f.a.entry,a.client_id,2,key,first.message_id,{}).message_id,replay.message_id);
});
