// Run inside the runtime image with a disposable /data, never a live volume.
import assert from 'node:assert/strict';
import { registration, sendBody } from './helpers.mjs';
import { BrokerStore } from '../src/store.mjs';
import { Logger } from '../src/logger.mjs';

const records=[],logger=new Logger({format:'json',sink:line=>records.push(JSON.parse(line))});
const options={path:'/data/smoke/broker.sqlite',logger};
if (process.argv.includes('--expect-temp-failure')) {
  await assert.rejects(BrokerStore.open(options),error=>error.errcode===6410);
  assert.equal(records.at(-1).event,'PSST_STORAGE_STARTUP_FAILED');
  assert.equal(records.at(-1).error.sqlite_name,'SQLITE_IOERR_GETTEMPPATH');
  console.log('PASS: startup detects missing writable temporary storage (SQLite 6410).');
} else {
  const store=await BrokerStore.open(options);
  try {
    const auth={principal_id:'smoke',adapter_id:'smoke',credential_id:'smoke',client_types:['pi'],scopes:['default']};
    const a=registration(),b=registration();
    const sender=store.register(auth,a),recipient=store.register(auth,b);
    const body=sendBody(b.client_id,'x'.repeat(65536));
    const sent=store.send(auth,a.client_id,sender.lease_epoch,'smoke-send',body);
    assert.equal(store.send(auth,a.client_id,sender.lease_epoch,'smoke-send',body).message_id,sent.message_id);
    assert.equal(store.receipt(auth,a.client_id,sent.message_id).delivery_state,'queued');
    const claim=store.claim(auth,b.client_id,recipient.lease_epoch,'smoke-claim',{});
    assert.equal(claim.envelope.message_id,sent.message_id);
    assert.equal(claim.envelope.content.text,body.content.text);
    store.complete(auth,b.client_id,recipient.lease_epoch,sent.message_id,{claim_id:claim.claim_id,outcome:'delivered'});
    assert.equal(store.receipt(auth,a.client_id,sent.message_id).delivery_state,'delivered');
    assert.equal(store.db.prepare("SELECT count(*) n FROM sqlite_temp_master WHERE name='psst_temp_probe'").get().n,0);
    assert.equal(store.db.prepare('PRAGMA temp_store').get().temp_store,0);
    console.log(`PASS: SQLite temporary storage, send, idempotent retry, claim, completion and receipt (Node ${process.versions.node}).`);
  } finally { store.close(); }
}
