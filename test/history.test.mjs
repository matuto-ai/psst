import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, httpFixture, registration, sendBody, uuid } from './helpers.mjs';
const code=(fn,c)=>assert.throws(fn,e=>e.code===c);
function pair(f){const a=registration(),b=registration();f.store.register(f.a.entry,a);f.store.register(f.b.entry,b);return [a,b];}
function send(f,a,b,n=1){return Array.from({length:n},(_,i)=>f.store.send(f.a.entry,a.client_id,1,uuid(),sendBody(b.client_id,`private body ${i}`)));}

test('history defaults to ten metadata-only records, count/bytes bounded and owned exact session',t=>{
 const f=fixture(t,{limits:{send_burst:100}}),[a,b]=pair(f),other=registration();f.store.register(f.a.entry,other);
 const sent=send(f,a,b,90),page=f.store.history(f.a.entry,a.client_id);
 assert.equal(page.messages.length,10);assert.ok(page.next_cursor);assert.ok(!JSON.stringify(page).includes('private body'));
 assert.ok(page.messages.every(m=>m.sender_id===a.client_id&&!('envelope'in m)&&!('content'in m)));
 const larger=f.store.history(f.a.entry,a.client_id,{limit:'100'});assert.ok(larger.messages.length>10&&larger.messages.length<90);assert.ok(larger.next_cursor);assert.ok(Buffer.byteLength(JSON.stringify(larger))<=32768);
 assert.equal(f.store.history(f.a.entry,other.client_id).messages.length,0);
 code(()=>f.store.history(f.b.entry,a.client_id),'recipient_not_found');
 code(()=>f.store.messageContent(f.a.entry,other.client_id,sent[0].message_id),'message_not_found');
 code(()=>f.store.messageContent(f.b.entry,b.client_id,sent[0].message_id),'message_not_found');
 assert.equal(f.store.history({...f.a.entry,scopes:['private']},a.client_id).messages.length,0);
 for(const limit of ['0','101','-1','NaN','1.5','01',''])code(()=>f.store.history(f.a.entry,a.client_id,{limit}),'invalid_request');
});

test('equal-time keyset pages exclude concurrent inserts without duplication and retain across restart',t=>{
 const f=fixture(t,{limits:{send_burst:100}}),[a,b]=pair(f),sent=send(f,a,b,25);
 let page=f.store.history(f.a.entry,a.client_id),all=page.messages.map(x=>x.message_id);
 send(f,a,b,1); // same timestamp; rowid snapshot excludes even a lexically later ID
 f.restart();
 while(page.next_cursor){page=f.store.history(f.a.entry,a.client_id,{cursor:page.next_cursor});all.push(...page.messages.map(x=>x.message_id));}
 assert.deepEqual(all,[...sent.map(x=>x.message_id)].sort().reverse());assert.equal(new Set(all).size,25);
});

test('filters validate timestamps/cursors and state changes explicitly invalidate instead of skipping',t=>{
 const f=fixture(t,{limits:{send_burst:100}}),[a,b]=pair(f),other=registration();f.store.register(f.b.entry,other);
 send(f,a,b,13);send(f,a,other,2);
 const filters={recipient_id:b.client_id,status:'queued',accepted_after:new Date(f.now).toISOString(),accepted_before:new Date(f.now+1).toISOString()};
 const first=f.store.history(f.a.entry,a.client_id,filters);assert.equal(first.messages.length,10);
 code(()=>f.store.history(f.a.entry,a.client_id,{...filters,status:'failed',cursor:first.next_cursor}),'invalid_request');
 code(()=>f.store.history(f.a.entry,a.client_id,{cursor:'garbage'}),'invalid_request');
 for(const q of [{unknown:'x'},{status:'read'},{accepted_after:'2026-02-30T00:00:00.000Z'},{accepted_after:'2026-01-01'},{accepted_after:filters.accepted_before,accepted_before:filters.accepted_after}])code(()=>f.store.history(f.a.entry,a.client_id,q),'invalid_request');
 f.store.claim(f.b.entry,b.client_id,1,uuid(),{});
 code(()=>f.store.history(f.a.entry,a.client_id,{...filters,cursor:first.next_cursor}),'history_changed');
 assert.equal(f.store.history(f.a.entry,a.client_id,{status:'claimed'}).messages.length,1);
});

test('sparse authorized history scans bounded candidates and continues through empty pages',t=>{
 const f=fixture(t,{limits:{send_burst:100,principal_send_burst:100,global_send_burst:100}}),[a,b]=pair(f);
 // Build sanitized fixtures directly to avoid spending rate budget on a 1005-row index test.
 const seed=send(f,a,b)[0];const original=f.store.db.prepare('SELECT * FROM messages WHERE id=?').get(seed.message_id);
 const insert=f.store.db.prepare('INSERT INTO messages(id,sender,recipient,scope,sequence,envelope,bytes,state,accepted,expires) VALUES(?,?,?,?,?,?,?,?,?,?)');
 for(let i=2;i<=1005;i++)insert.run(uuid(),a.client_id,b.client_id,'default',i,original.envelope,original.bytes,'queued',f.now+i,original.expires);
 const page=f.store.history(f.a.entry,a.client_id,{status:'delivered'});assert.deepEqual(page.messages,[]);assert.ok(page.next_cursor);
 const final=f.store.history(f.a.entry,a.client_id,{status:'delivered',cursor:page.next_cursor});assert.deepEqual(final.messages,[]);assert.equal(final.next_cursor,null);
});

test('content preserves original bytes and receipt-only route, retention/purge/restart do not reconstruct',async t=>{
 const f=await httpFixture(t),[a,b]=pair(f),text='opaque\n🧪 <script>private</script>\u001b[31m';
 const sent=f.store.send(f.a.entry,a.client_id,1,uuid(),sendBody(b.client_id,text,{ttl_seconds:60}));
 const list=await f.request('/v1/messages',{session:a.client_id});assert.equal(list.status,200);assert.ok(!JSON.stringify(list.body).includes('private'));
 const detail=await f.request(`/v1/messages/${sent.message_id}/content`,{session:a.client_id});assert.equal(detail.status,200);assert.equal(detail.body.envelope.content.text,text);
 const receipt=await f.request(sent.status_url,{session:a.client_id});assert.equal(receipt.status,200);assert.ok(!('envelope'in receipt.body));
 assert.equal((await f.request('/v1/messages?limit=10&limit=11',{session:a.client_id})).status,400);
 assert.equal((await f.request(`/v1/messages/${sent.message_id}/content`,{session:b.client_id,token:f.b.token})).status,404);
 f.advance(60001);assert.equal(f.store.messageContent(f.a.entry,a.client_id,sent.message_id).delivery_state,'expired');
 assert.equal(f.store.messageContent(f.a.entry,a.client_id,sent.message_id).envelope.content.text,text);
 f.store.db.prepare('UPDATE messages SET envelope=NULL WHERE id=?').run(sent.message_id);code(()=>f.store.messageContent(f.a.entry,a.client_id,sent.message_id),'content_unavailable');
 f.advance(8*86400000);f.store.sweep();code(()=>f.store.messageContent(f.a.entry,a.client_id,sent.message_id),'message_not_found');
});


test('busy unfiltered paging remains usable while receipt states change; purge is explicit and cannot admit reused row IDs',t=>{
 const f=fixture(t,{limits:{send_burst:100}}),[a,b]=pair(f),sent=send(f,a,b,15);
 const first=f.store.history(f.a.entry,a.client_id);f.store.claim(f.b.entry,b.client_id,1,uuid(),{});
 const next=f.store.history(f.a.entry,a.client_id,{cursor:first.next_cursor});
 assert.equal(next.messages.length,5);assert.equal(new Set([...first.messages,...next.messages].map(m=>m.message_id)).size,15);
 const oldCursor=first.next_cursor;f.store.db.prepare('DELETE FROM sends').run();f.store.db.prepare('DELETE FROM messages').run();
 send(f,a,b,1);
 const purged=f.store.history(f.a.entry,a.client_id,{cursor:oldCursor});assert.equal(purged.retention_changed,true);assert.equal(purged.messages.length,0);
});


test('history reports expiry exactly beyond cleanup batch and time-filter membership cannot silently shift',t=>{
 const f=fixture(t,{limits:{send_burst:1000,principal_send_burst:1000}}),[a,b]=pair(f);
 for(let n=0;n<210;n++)f.store.send(f.a.entry,a.client_id,1,uuid(),sendBody(b.client_id,'opaque',{ttl_seconds:60}));
 const before=f.store.history(f.a.entry,a.client_id,{status:'queued'});f.advance(60000);
 code(()=>f.store.history(f.a.entry,a.client_id,{status:'queued',cursor:before.next_cursor}),'history_changed');
 let page=f.store.history(f.a.entry,a.client_id,{status:'expired',limit:'100'}),seen=[];
 do{seen.push(...page.messages.map(m=>m.message_id));page=page.next_cursor?f.store.history(f.a.entry,a.client_id,{status:'expired',limit:'100',cursor:page.next_cursor}):null;}while(page);
 assert.equal(new Set(seen).size,210);assert.equal(f.store.history(f.a.entry,a.client_id,{status:'queued'}).messages.length,0);
});
