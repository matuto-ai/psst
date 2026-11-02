import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readdirSync,readFileSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {BrokerStore} from '../src/store.mjs';
import {ApprovalService} from '../src/approval.mjs';
import {fixture,registration,sendBody} from './helpers.mjs';

for(const version of [3,4])test(`production opening preserves schema${version} snapshot before any schema5 change`,async t=>{
 const f=fixture(t),a=registration(),b=registration();f.store.register(f.a.entry,a);f.store.register(f.b.entry,b);
 const m=f.store.send(f.a.entry,a.client_id,1,'kept',sendBody(b.client_id,'original payload'));
 f.store.db.exec(`DROP TABLE registration_control; ALTER TABLE sessions DROP COLUMN registration_version; ALTER TABLE sessions DROP COLUMN disconnected_since; PRAGMA user_version=${version}`);
 const before=f.store.db.prepare('SELECT * FROM sessions ORDER BY id').all();f.store.close();
 const s=await BrokerStore.open({path:f.path,clock:()=>f.now});t.after(()=>s.close());
 const prefix=version<4?'before-approval-':'before-retention-',folders=readdirSync(f.dir).filter(x=>x.startsWith(prefix));assert.equal(folders.length,1);
 const folder=join(f.dir,folders[0]),snapshot=new DatabaseSync(join(folder,'broker.sqlite'),{readOnly:true});
 try{
  assert.equal(snapshot.prepare('PRAGMA user_version').get().user_version,version);
  assert.deepEqual(snapshot.prepare('SELECT * FROM sessions ORDER BY id').all(),before);
  assert.equal(snapshot.prepare('SELECT envelope FROM messages WHERE id=?').get(m.message_id).envelope.includes('original payload'),true);
  assert.equal(snapshot.prepare("SELECT count(*) n FROM sqlite_master WHERE name='registration_control'").get().n,0);
 }finally{snapshot.close();}
 assert.equal(statSync(folder).mode&0o077,0);assert.equal(statSync(join(folder,'broker.sqlite')).mode&0o077,0);
 assert.equal(JSON.parse(readFileSync(join(folder,'manifest.json'),'utf8')).schema,version);
 assert.equal(s.db.prepare('PRAGMA user_version').get().user_version,5);
 assert.equal(s.session(f.a.entry,a.client_id).connected,false);
 assert.equal(s.receipt(f.a.entry,a.client_id,m.message_id).message_id,m.message_id);
 if(version===3){await ApprovalService.create({store:s});assert.equal(readdirSync(f.dir).filter(x=>x.startsWith('before-approval-')).length,1);}
 await assert.rejects(BrokerStore.open({path:f.path}),/locked/);
 s.close();const again=await BrokerStore.open({path:f.path,clock:()=>f.now});t.after(()=>again.close());assert.equal(readdirSync(f.dir).filter(x=>x.startsWith(prefix)).length,1);
});

test('failed schema migration leaves the original pre-migration snapshot intact',async t=>{
 const f=fixture(t);f.store.db.exec('PRAGMA user_version=4');f.store.close();
 await assert.rejects(BrokerStore.open({path:f.path,limits:{session_retention_seconds:172800}}),/enforcement/);
 const folders=readdirSync(f.dir).filter(x=>x.startsWith('before-retention-'));assert.equal(folders.length,1);
 const db=new DatabaseSync(join(f.dir,folders[0],'broker.sqlite'),{readOnly:true});assert.equal(db.prepare('PRAGMA user_version').get().user_version,4);db.close();
 const source=new DatabaseSync(f.path,{readOnly:true});assert.equal(source.prepare('PRAGMA user_version').get().user_version,4);source.close();
});

test('snapshot-finalization failure aborts before migration and releases the owner lock',async t=>{
 const f=fixture(t);f.store.db.exec('PRAGMA user_version=4');f.store.close();
 await assert.rejects(BrokerStore.open({path:f.path,clock:()=>{throw Error('snapshot-finalization-fault');}}),/snapshot-finalization-fault/);
 const source=new DatabaseSync(f.path,{readOnly:true});assert.equal(source.prepare('PRAGMA user_version').get().user_version,4);source.close();
 const recovered=await BrokerStore.open({path:f.path,clock:()=>f.now});t.after(()=>recovered.close());assert.equal(recovered.db.prepare('PRAGMA user_version').get().user_version,5);
});
