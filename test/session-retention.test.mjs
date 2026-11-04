import test from 'node:test';
import assert from 'node:assert/strict';
import { BrokerStore } from '../src/store.mjs';
import { fixture, registration, sendBody, uuid } from './helpers.mjs';
const R=172800000;
const options={requireRegistrationV2:true,limits:{session_retention_seconds:R/1000}};
const reg=(f,b=registration())=>({...b,registration_version:2,requested_at:f.now});
const err=(fn,code)=>assert.throws(fn,e=>e.code===code);

test('v1 defaults remain compatible; opt-in and strict freshness are explicit',t=>{
 const f=fixture(t),a=registration();assert.equal(f.store.register(f.a.entry,a).lease_epoch,1);
 assert.equal(f.store.policy().session_retention_seconds,0);f.advance(R*2);f.store.sweep();assert.equal(f.store.session(f.a.entry,a.client_id).client_id,a.client_id);
 const e=fixture(t,options);err(()=>e.store.register(e.a.entry,registration()),'registration_upgrade_required');
 err(()=>e.store.register(e.a.entry,{...reg(e),requested_at:e.now-86400000}),'retry_window_elapsed');
 err(()=>e.store.register(e.a.entry,{...reg(e),requested_at:e.now+300001}),'retry_window_elapsed');
 assert.ok(e.store.register(e.a.entry,{...reg(e),requested_at:e.now+300000}).lease_epoch>0);
 assert.throws(()=>fixture(t,{limits:{session_retention_seconds:172800}}),/enforcement/);
 assert.throws(()=>fixture(t,{...options,limits:{session_retention_seconds:86700}}),/exceed/);
});

test('global epochs, exact retry, explicit absence boundary, and old operations fenced after reuse',t=>{
 const f=fixture(t,options),a=reg(f),b=reg(f);
 const aa=f.store.register(f.a.entry,a),bb=f.store.register(f.b.entry,b);
 assert.ok(bb.lease_epoch>aa.lease_epoch);assert.deepEqual(f.store.register(f.a.entry,a),aa);
 f.store.disconnect(f.a.entry,a.client_id,aa.lease_epoch);f.advance(R-1);f.store.sweep();assert.equal(f.store.session(f.a.entry,a.client_id).client_id,a.client_id);
 f.advance(1);f.store.sweep();err(()=>f.store.session(f.a.entry,a.client_id),'recipient_not_found');
 err(()=>f.store.register(f.a.entry,a),'retry_window_elapsed');
 const fresh=f.store.register(f.a.entry,{...a,requested_at:f.now,connection_id:uuid()});assert.ok(fresh.lease_epoch>bb.lease_epoch);
 err(()=>f.store.heartbeat(f.a.entry,a.client_id,aa.lease_epoch),'stale_lease_epoch');
 err(()=>f.store.metadata(f.a.entry,a.client_id,aa.lease_epoch,{metadata_patch:{name:'old'},expected_metadata_revision:1}),'stale_lease_epoch');
 err(()=>f.store.claim(f.a.entry,a.client_id,aa.lease_epoch,'old',{}),'stale_lease_epoch');
 err(()=>f.store.complete(f.a.entry,a.client_id,aa.lease_epoch,uuid(),{claim_id:uuid(),outcome:'delivered'}),'stale_lease_epoch');
 err(()=>f.store.register(f.b.entry,{...a,requested_at:f.now,connection_id:uuid()}),'identity_conflict');
});

test('absence survives restart; legacy rows are not retired; v2 reconnect resets timer',t=>{
 const f=fixture(t),a=registration();f.store.register(f.a.entry,a);f.advance(R*2);
 f.store.close();let s=new BrokerStore({path:f.path,clock:()=>f.now,...options});t.after(()=>s.close());
 s.sweep();assert.equal(s.session(f.a.entry,a.client_id).client_id,a.client_id);
 const v2={...reg(f,a),previous_epoch:1,connection_id:uuid()};const r=s.register(f.a.entry,v2);s.disconnect(f.a.entry,a.client_id,r.lease_epoch);
 f.advance(R/2);s.close();s=new BrokerStore({path:f.path,clock:()=>f.now,limits:options.limits});
 assert.deepEqual(s.policy().registration_versions,[2]);f.advance(R/2-1);s.sweep();assert.equal(s.session(f.a.entry,a.client_id).client_id,a.client_id);
 const r2=s.register(f.a.entry,{...v2,requested_at:f.now,connection_id:uuid(),previous_epoch:r.lease_epoch});
 f.advance(180000+R-1);s.sweep();assert.equal(s.session(f.a.entry,a.client_id).client_id,a.client_id);
 f.advance(1);s.sweep();err(()=>s.session(f.a.entry,a.client_id),'recipient_not_found');assert.ok(r2.lease_epoch>r.lease_epoch);
});

test('retirement preserves peer idempotency without incoming content and prevents inherited history',t=>{
 const f=fixture(t,options),a=reg(f),b=reg(f),aa=f.store.register(f.a.entry,a),bb=f.store.register(f.b.entry,b);
 const body=sendBody(b.client_id,'private payload',{ttl_seconds:604800});const sent=f.store.send(f.a.entry,a.client_id,aa.lease_epoch,'once',body);
 f.store.claim(f.b.entry,b.client_id,bb.lease_epoch,'claim',{});f.store.disconnect(f.b.entry,b.client_id,bb.lease_epoch);
 f.advance(R);const ar=f.store.register(f.a.entry,{...a,requested_at:f.now,connection_id:uuid(),previous_epoch:aa.lease_epoch});f.store.sweep();
 const receipt=f.store.receipt(f.a.entry,a.client_id,sent.message_id);assert.equal(receipt.delivery_state,'failed');assert.equal(receipt.delivery_uncertain,true);
 assert.equal(f.store.db.prepare('SELECT envelope FROM messages WHERE id=?').get(sent.message_id).envelope,null);
 assert.ok(f.store.db.prepare('SELECT request FROM sends WHERE message=?').get(sent.message_id).request.startsWith('sha256:'));
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM claims WHERE client=?').get(b.client_id).n,0);
 assert.deepEqual(f.store.send(f.a.entry,a.client_id,ar.lease_epoch,'once',body),sent);
 err(()=>f.store.send(f.a.entry,a.client_id,ar.lease_epoch,'once',sendBody(b.client_id,'different',{ttl_seconds:604800})),'idempotency_conflict');
 err(()=>f.store.register(f.a.entry,{...b,requested_at:f.now,connection_id:uuid()}),'identity_conflict');
});

test('outbound accepted delivery survives sender retirement, then all peer records expire',t=>{
 const f=fixture(t,options),a=reg(f),b=reg(f),aa=f.store.register(f.a.entry,a),bb=f.store.register(f.b.entry,b);
 const sent=f.store.send(f.a.entry,a.client_id,aa.lease_epoch,'once',sendBody(b.client_id,'accepted',{ttl_seconds:604800}));
 f.store.disconnect(f.a.entry,a.client_id,aa.lease_epoch);f.advance(R);
 const br=f.store.register(f.b.entry,{...b,requested_at:f.now,connection_id:uuid(),previous_epoch:bb.lease_epoch});f.store.sweep();
 const claim=f.store.claim(f.b.entry,b.client_id,br.lease_epoch,'next',{});assert.equal(claim.envelope.message_id,sent.message_id);
 f.store.complete(f.b.entry,b.client_id,br.lease_epoch,sent.message_id,{claim_id:claim.claim_id,outcome:'delivered'});
 f.advance(15*86400000);f.store.sweep();assert.equal(f.store.db.prepare('SELECT count(*) n FROM messages').get().n,0);
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM sends').get().n,0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM history_revisions').get().n,0);
});

test('retirement rolls back atomically and global counter never wraps',t=>{
 let fail=false;const f=fixture(t,{...options,fault:stage=>{if(fail&&stage==='before_commit'){fail=false;throw Error('injected');}}});
 const a=reg(f),r=f.store.register(f.a.entry,a);f.store.disconnect(f.a.entry,a.client_id,r.lease_epoch);f.advance(R);fail=true;
 err(()=>f.store.sweep(),'storage_unavailable');assert.equal(f.store.session(f.a.entry,a.client_id).client_id,a.client_id);f.store.sweep();err(()=>f.store.session(f.a.entry,a.client_id),'recipient_not_found');
 f.store.db.prepare('UPDATE registration_control SET epoch=?').run(Number.MAX_SAFE_INTEGER);err(()=>f.store.register(f.a.entry,reg(f)),'not_ready');
});

test('request-side message maintenance does not retire a previously resolved caller',t=>{
 const f=fixture(t,options),a=reg(f),b=reg(f),aa=f.store.register(f.a.entry,a),bb=f.store.register(f.b.entry,b);
 const m=f.store.send(f.a.entry,a.client_id,aa.lease_epoch,'keep',sendBody(b.client_id,'retained',{ttl_seconds:604800}));
 f.store.disconnect(f.a.entry,a.client_id,aa.lease_epoch);f.advance(R);
 assert.equal(f.store.receipt(f.a.entry,a.client_id,m.message_id).message_id,m.message_id);
 assert.equal(f.store.session(f.a.entry,a.client_id).client_id,a.client_id);
 f.store.sweep();err(()=>f.store.receipt(f.a.entry,a.client_id,m.message_id),'recipient_not_found');
});

test('schema migration seeds counter above extant epochs and grants existing offline rows a fresh timer',t=>{
 const f=fixture(t),a=registration();f.store.register(f.a.entry,a);
 f.store.db.exec('UPDATE sessions SET epoch=900,lease_until=0; DROP TABLE registration_control; ALTER TABLE sessions DROP COLUMN disconnected_since; ALTER TABLE sessions DROP COLUMN registration_version; PRAGMA user_version=4');
 f.advance(R*10);f.restart();assert.equal(f.store.db.prepare('SELECT disconnected_since FROM sessions').get().disconnected_since,f.now);
 const r=f.store.register(f.a.entry,reg(f));assert.ok(r.lease_epoch>900);
});

test('disabling retirement does not retain orphan revisions after peer receipts age out',t=>{
 const f=fixture(t,options),a=reg(f),b=reg(f),aa=f.store.register(f.a.entry,a);f.store.register(f.b.entry,b);
 f.store.send(f.a.entry,a.client_id,aa.lease_epoch,'orphan',sendBody(b.client_id));f.store.disconnect(f.a.entry,a.client_id,aa.lease_epoch);f.advance(R);f.store.sweep();
 f.store.close();const s=new BrokerStore({path:f.path,clock:()=>f.now});t.after(()=>s.close());
 f.advance(16*86400000);s.sweep();assert.equal(s.db.prepare('SELECT count(*) n FROM history_revisions').get().n,0);
 assert.equal(s.db.prepare('SELECT count(*) n FROM history_state_revisions').get().n,0);assert.deepEqual(s.policy().registration_versions,[2]);
});

test('retirement processes one session per sweep and streams large dependent payload rows',t=>{
 const f=fixture(t,options),a=reg(f),b=reg(f);const ar=f.store.register(f.a.entry,a),br=f.store.register(f.b.entry,b);
 // Synthetic legacy canonical request rows exercise conversion without network
 // flooding/rate-limit changes or allocations proportional to all row contents.
 const body=JSON.stringify({recipient_id:b.client_id,content:{type:'text/plain',text:'x'.repeat(32768)}}),now=f.now;
 f.store.tx(()=>{
   for(let n=1;n<=400;n++){
     const id=uuid();f.store.db.prepare("INSERT INTO messages(id,sender,recipient,scope,sequence,envelope,bytes,state,accepted,expires) VALUES(?,?,?,?,?,?,?,'queued',?,?)").run(id,a.client_id,b.client_id,'default',n,body,32768,now,now+604800000);
     f.store.db.prepare('INSERT INTO sends VALUES(?,?,?,?,?,?,?)').run(f.a.entry.principal_id,a.client_id,`bulk-${n}`,body,id,'default','{}');
   }
 });
 f.store.disconnect(f.b.entry,b.client_id,br.lease_epoch);f.advance(R);
 f.store.register(f.a.entry,{...a,requested_at:f.now,previous_epoch:ar.lease_epoch,connection_id:uuid()});f.store.sweep();
 assert.equal(f.store.db.prepare("SELECT count(*) n FROM sends WHERE request NOT LIKE 'sha256:%'").get().n,0);
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM messages WHERE envelope IS NOT NULL').get().n,0);
 const c=reg(f),d=reg(f),cr=f.store.register(f.a.entry,c),dr=f.store.register(f.b.entry,d);
 f.store.disconnect(f.a.entry,c.client_id,cr.lease_epoch);f.store.disconnect(f.b.entry,d.client_id,dr.lease_epoch);f.advance(R);
 // Keep sender a alive, so only c/d are newly eligible.
 const alive=f.store.session(f.a.entry,a.client_id);f.store.register(f.a.entry,{...a,requested_at:f.now,previous_epoch:alive.lease_epoch,connection_id:uuid()});
 f.store.sweep();assert.equal(f.store.db.prepare('SELECT count(*) n FROM sessions WHERE id IN (?,?)').get(c.client_id,d.client_id).n,1);
 f.store.sweep();assert.equal(f.store.db.prepare('SELECT count(*) n FROM sessions WHERE id IN (?,?)').get(c.client_id,d.client_id).n,0);
});
