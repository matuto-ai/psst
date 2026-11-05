import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, registration, sendBody, uuid } from './helpers.mjs';
import { canonical } from '../src/protocol.mjs';
import { Logger } from '../src/logger.mjs';

function observed(t, options = {}) {
  const records = [];
  const logger = new Logger({level:'debug', format:'json', sink:line=>records.push(JSON.parse(line))});
  const f = fixture(t, {logger, ...options});
  records.length = 0;
  return {f, records};
}
const event = (records, name) => records.filter(r=>r.event === `PSST_${name}`);
function pair(f) {
  const a=registration(), b=registration();
  f.store.register(f.a.entry,a); f.store.register(f.b.entry,b);
  return [a,b];
}

test('real SQLITE_FULL automatic rollback is not_applied and does not poison subsequent writes', t=>{
  const {f,records}=observed(t), db=f.store.db;
  db.exec('CREATE TABLE disk_test(data BLOB)');
  const pages=db.prepare('PRAGMA page_count').get().page_count;
  db.exec(`PRAGMA max_page_count=${pages}`);
  let original;
  assert.throws(()=>f.store.tx(()=>{
    try { db.prepare('INSERT INTO disk_test VALUES(zeroblob(1048576))').run(); }
    catch(error) { original=error; assert.equal(db.isTransaction,false); throw error; }
  }), error=>error.code==='storage_unavailable' && error.effect==='not_applied');
  assert.equal(original.errcode & 255,13);
  assert.equal(f.store.safe(),true);
  assert.equal(event(records,'STORAGE_ROLLBACK_FAILED').length,0);
  const failure=event(records,'STORAGE_TRANSACTION_FAILED').at(-1);
  assert.equal(failure.phase,'statement');
  assert.equal(failure.error.sqlite_code & 255,13);
  assert.equal(failure.rollback_confirmed,true);
  db.exec('PRAGMA max_page_count=100000');
  f.store.tx(()=>db.prepare('INSERT INTO disk_test VALUES(?)').run('recovered'));
  assert.equal(db.prepare('SELECT count(*) n FROM disk_test').get().n,1);
});

for (const stage of ['before_begin','before_commit','commit_attempt','after_commit']) {
  test(`${stage} failure preserves outcome and suppresses unconfirmed lifecycle success`, t=>{
    const {f,records}=observed(t);
    f.store.fault=point=>{if(point===stage) throw Error('private content /secret/path');};
    const a=registration();
    assert.throws(()=>f.store.register(f.a.entry,a),e=>e.effect===(stage==='after_commit'?'unknown':'not_applied'));
    assert.equal(event(records,'CLIENT_CONNECTED').length,0);
    assert.equal(f.store.safe(),true);
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM sessions').get().n,stage==='after_commit'?1:0);
    assert.equal(event(records,'STORAGE_TRANSACTION_FAILED').at(-1).phase,stage==='before_begin'?'begin':stage==='commit_attempt'?'commit':stage);
    assert.ok(!JSON.stringify(records).includes('private content'));
  });
}

test('real BEGIN failure is normalized with original SQLite diagnostics', t=>{
  const {f,records}=observed(t);
  f.store.db.exec('PRAGMA query_only=ON');
  assert.throws(()=>f.store.tx(()=>assert.fail('must not execute')),e=>e.code==='storage_unavailable'&&e.effect==='not_applied');
  const failure=event(records,'STORAGE_TRANSACTION_FAILED').at(-1);
  assert.equal(failure.phase,'begin'); assert.equal(failure.error.sqlite_code & 255,8);
  f.store.db.exec('PRAGMA query_only=OFF');
  assert.equal(f.store.tx(()=>42),42);
});

test('inactive transaction after attempted commit stays unknown without poisoning',t=>{
  const {f,records}=observed(t);
  f.store.fault=point=>{if(point==='commit_attempt'){f.store.db.exec('COMMIT'); throw Error('lost commit acknowledgement');}};
  const a=registration();
  assert.throws(()=>f.store.register(f.a.entry,a),e=>e.effect==='unknown');
  assert.equal(f.store.safe(),true);
  assert.equal(event(records,'CLIENT_CONNECTED').length,0);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM sessions').get().n,1);
});

test('actual ROLLBACK failure poisons active writer and retains both original diagnostics',t=>{
  const {f,records}=observed(t), originalExec=f.store.db.exec.bind(f.store.db);
  f.store.db.exec=sql=>{if(sql==='ROLLBACK') throw Object.assign(Error('private rollback'),{code:'EIO'});return originalExec(sql);};
  assert.throws(()=>f.store.tx(()=>{throw Object.assign(Error('private statement'),{code:'ENOSPC'});}),e=>e.effect==='unknown');
  assert.equal(f.store.db.isTransaction,true); assert.equal(f.store.safe(),false);
  assert.equal(event(records,'STORAGE_ROLLBACK_FAILED').at(-1).error.reason,'io_failure');
  assert.equal(event(records,'STORAGE_TRANSACTION_FAILED').at(-1).error.reason,'disk_full');
  f.store.db.exec=originalExec; originalExec('ROLLBACK');
});

test('lifecycle events are committed, metadata-only and replays do not duplicate connections or sends',t=>{
  const {f,records}=observed(t),[a,b]=pair(f);
  f.store.register(f.a.entry,a);
  const body=sendBody(b.client_id,'SECRET MESSAGE');
  const m=f.store.send(f.a.entry,a.client_id,1,'send',body);
  f.store.send(f.a.entry,a.client_id,1,'send',body);
  f.store.heartbeat(f.b.entry,b.client_id,1);
  const claim=f.store.claim(f.b.entry,b.client_id,1,'claim',{});
  f.store.complete(f.b.entry,b.client_id,1,m.message_id,{claim_id:claim.claim_id,outcome:'delivered'});
  f.store.disconnect(f.a.entry,a.client_id,1);
  assert.equal(event(records,'CLIENT_CONNECTED').length,2);
  assert.equal(event(records,'MESSAGE_ACCEPTED').length,1);
  assert.equal(event(records,'MESSAGE_CLAIMED').length,1);
  assert.equal(event(records,'MESSAGE_COMPLETED').length,1);
  assert.equal(event(records,'CLIENT_DISCONNECTED').length,1);
  assert.ok(!JSON.stringify(records).includes('SECRET MESSAGE'));
  assert.ok(!JSON.stringify(records).includes('same-name'));
});

test('throwing injected logger cannot change committed store outcomes', t=>{
  const f=fixture(t,{logger:{log(){throw Error('broken logger');}}});
  const [a,b]=pair(f);
  const result=f.store.send(f.a.entry,a.client_id,1,'send',sendBody(b.client_id));
  assert.equal(f.store.receipt(f.a.entry,a.client_id,result.message_id).delivery_state,'queued');
  f.store.fault=point=>{if(point==='before_commit')throw Error('before commit');};
  assert.throws(()=>f.store.heartbeat(f.a.entry,a.client_id,1),e=>e.effect==='not_applied');
});

test('storage safety reports state change once and recovery without leaking disk error',t=>{
  let healthy=true;
  const {f,records}=observed(t,{diskCheck:()=>{if(!healthy)throw Error('PRIVATE DISK PATH');return true;}});
  healthy=false;
  for(let i=0;i<10;i++)assert.equal(f.store.safe(),false);
  assert.equal(event(records,'STORAGE_UNAVAILABLE').length,1);
  healthy=true; assert.equal(f.store.safe(),true);assert.equal(f.store.safe(),true);
  assert.equal(event(records,'STORAGE_RECOVERED').length,1);
  assert.ok(!JSON.stringify(records).includes('PRIVATE DISK PATH'));
});

test('session and message success records are emitted only outside an active transaction',t=>{
  const f=fixture(t), records=[];
  // Assertions in a logger would be swallowed by the no-throw boundary, so
  // independently capture any active-transaction observation.
  let active=false;
  f.store.logger={log(level,name){records.push(name);active ||= f.store.db.isTransaction;}};
  const [a,b]=pair(f);
  f.store.send(f.a.entry,a.client_id,1,'outside',sendBody(b.client_id));
  assert.equal(active,false);assert.ok(records.includes('PSST_MESSAGE_ACCEPTED'));
});

test('expiry diagnostics are debug-only and discarded when sweep rolls back',t=>{
  const {f,records}=observed(t),[a,b]=pair(f);
  f.store.send(f.a.entry,a.client_id,1,'expiry',sendBody(b.client_id,'secret',{ttl_seconds:60}));
  f.advance(60001);
  f.store.fault=point=>{if(point==='before_commit')throw Error('failed sweep');};
  assert.throws(()=>f.store.sweep());
  assert.equal(event(records,'MESSAGES_EXPIRED').length,0);
  f.store.fault=()=>{};f.store.sweep();
  assert.equal(event(records,'MESSAGES_EXPIRED').length,1);
  assert.equal(event(records,'MESSAGES_EXPIRED')[0].level,'debug');
  assert.equal(event(records,'MESSAGES_EXPIRED')[0].count,1);
});

test('failed rollback of a conflict never reports a harmless API rejection',t=>{
  const {f,records}=observed(t),[a]=pair(f);
  f.store.fault=point=>{if(point==='before_rollback')throw Error('rollback failed');};
  assert.throws(()=>f.store.register(f.a.entry,{...a,metadata:{...a.metadata,name:'conflict'}}),e=>e.code==='storage_unavailable'&&e.effect==='unknown');
  assert.equal(f.store.safe(),false);
  assert.equal(event(records,'STORAGE_TRANSACTION_FAILED').at(-1).level,'error');
  assert.equal(event(records,'STORAGE_OPERATION_REJECTED').length,0);
});

for (const version of [1,2]) {
  test(`v${version} send/resend retries retain default normalization across runtime TTL changes and restart`,t=>{
    const f=fixture(t), a=registration(),b=registration();
    if(version===2)Object.assign(a,{registration_version:2,requested_at:f.now});
    const ar=f.store.register(f.a.entry,a);f.store.register(f.b.entry,b);
    const body=sendBody(b.client_id), send=(key,value)=>f.store.send(f.a.entry,a.client_id,ar.lease_epoch,key,value);
    const omitted=send('omitted',body);
    const matching=send('matching',{...body,ttl_seconds:86400});
    send('different',{...body,ttl_seconds:300});
    const resent=f.store.resend(f.a.entry,a.client_id,ar.lease_epoch,'resend',omitted.message_id,{});
    f.store.limits.default_ttl_seconds=120;
    assert.deepEqual(send('omitted',body),omitted);
    assert.deepEqual(send('matching',body),matching);
    assert.throws(()=>send('different',body),e=>e.code==='idempotency_conflict');
    assert.throws(()=>send('omitted',{...body,ttl_seconds:120}),e=>e.code==='idempotency_conflict');
    assert.deepEqual(f.store.resend(f.a.entry,a.client_id,ar.lease_epoch,'resend',omitted.message_id,{}),resent);
    const newer=send('new',body);
    assert.equal(Date.parse(newer.expires_at)-f.now,120000);
    f.restart();
    const reconnect=f.store.register(f.a.entry,{...a,connection_id:uuid(),previous_epoch:ar.lease_epoch});
    f.store.limits.default_ttl_seconds=600;
    assert.deepEqual(f.store.send(f.a.entry,a.client_id,reconnect.lease_epoch,'new',body),newer);
    assert.deepEqual(f.store.send(f.a.entry,a.client_id,reconnect.lease_epoch,'omitted',body),omitted);
    // Foreign-key cleanup is inseparable from removal of its idempotency row.
    f.store.db.prepare('DELETE FROM sends WHERE message=?').run(omitted.message_id);
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM send_defaults WHERE key=?').get('omitted').n,0);
  });
}

test('legacy sends acquire startup default exactly once before dynamic settings apply',t=>{
  const f=fixture(t),[a,b]=pair(f),body=sendBody(b.client_id);
  const first=f.store.send(f.a.entry,a.client_id,1,'legacy',body);
  f.store.db.exec('DROP TABLE send_defaults');f.restart();
  const ar=f.store.register(f.a.entry,{...a,connection_id:uuid(),previous_epoch:1});
  f.store.limits.default_ttl_seconds=120;
  assert.deepEqual(f.store.send(f.a.entry,a.client_id,ar.lease_epoch,'legacy',body),first);
  assert.equal(f.store.db.prepare('SELECT default_ttl FROM send_defaults').get().default_ttl,86400);
});

test('recipient retirement hashes legacy request without losing original default for retry',t=>{
  const f=fixture(t,{requireRegistrationV2:true,limits:{session_retention_seconds:172800,default_ttl_seconds:604800}});
  const a={...registration(),registration_version:2,requested_at:f.now},b={...registration(),registration_version:2,requested_at:f.now};
  const ar=f.store.register(f.a.entry,a),br=f.store.register(f.b.entry,b),body=sendBody(b.client_id);
  const first=f.store.send(f.a.entry,a.client_id,ar.lease_epoch,'retired',body);
  // A legacy canonical row is converted by real retirement, while its default
  // record remains independent of the privacy-preserving request hash.
  const normalized={...body,ttl_seconds:604800,correlation_id:null,reply_to_message_id:null};
  f.store.db.prepare('UPDATE sends SET request=? WHERE message=?').run(canonical(normalized),first.message_id);
  f.store.disconnect(f.b.entry,b.client_id,br.lease_epoch);
  f.advance(172800000);
  const reconnected=f.store.register(f.a.entry,{...a,requested_at:f.now,previous_epoch:ar.lease_epoch,connection_id:uuid()});
  f.store.sweep();
  assert.ok(f.store.db.prepare('SELECT request FROM sends WHERE message=?').get(first.message_id).request.startsWith('sha256:'));
  f.store.limits.default_ttl_seconds=120;
  assert.deepEqual(f.store.send(f.a.entry,a.client_id,reconnected.lease_epoch,'retired',body),first);
});

test('migration preserves the primary failure after automatic rollback and after failed active rollback',t=>{
  const f=fixture(t),db=f.store.db,prepare=db.prepare.bind(db),exec=db.exec.bind(db);
  const primary=Object.assign(new Error('synthetic private primary'),{errcode:13});
  for(const automatic of [true,false]){
    db.prepare=sql=>{
      if(sql.includes('INSERT OR IGNORE INTO send_defaults'))return {run(){if(automatic)exec('ROLLBACK');throw primary;}};
      return prepare(sql);
    };
    db.exec=sql=>{if(!automatic&&sql==='ROLLBACK')throw Error('synthetic private rollback');return exec(sql);};
    assert.throws(()=>f.store.migrate(),error=>error===primary);
    if(db.isTransaction)exec('ROLLBACK');
  }
  db.prepare=prepare;db.exec=exec;
  assert.equal(f.store.safe(),true);
});
test('real SQLite disk-full during migration retains errcode 13 after automatic rollback',t=>{
  const f=fixture(t),db=f.store.db,prepare=db.prepare.bind(db);
  db.exec('CREATE TABLE migration_full(payload BLOB)');
  const pages=db.prepare('PRAGMA page_count').get().page_count;
  db.exec(`PRAGMA max_page_count=${pages}`);
  let original;
  db.prepare=sql=>{
    if(sql.includes('INSERT OR IGNORE INTO send_defaults'))return {run(){
      try{prepare('INSERT INTO migration_full VALUES(zeroblob(1048576))').run();}
      catch(error){original=error;throw error;}
    }};
    return prepare(sql);
  };
  assert.throws(()=>f.store.migrate(),error=>error===original&&error.errcode===13);
  assert.equal(db.isTransaction,false);db.prepare=prepare;
  db.exec('PRAGMA max_page_count=2147483646');
  f.store.migrate();assert.equal(f.store.safe(),true);
});
