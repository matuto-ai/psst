import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes,randomUUID } from 'node:crypto';
import { fixture } from './helpers.mjs';
import { ApprovalService,approvalOptionsFromEnvironment } from '../src/approval.mjs';

test('startup environment seam validates defaults and explicit settings before creating approval service',async t=>{
 assert.deepEqual(approvalOptionsFromEnvironment({}),{credentialMs:90*86400000});
 for(const value of ['0','3651','unlimited','']){
  assert.throws(()=>approvalOptionsFromEnvironment({PSST_AUTHORIZATION_DAYS:value}),e=>e.code==='invalid_authorization_days'&&/PSST_AUTHORIZATION_DAYS must be a whole number from 1 to 3650/.test(e.message));
 }
 const f=fixture(t),options=approvalOptionsFromEnvironment({PSST_AUTHORIZATION_DAYS:'730'});
 const approval=await ApprovalService.create({store:f.store,...options});
 const token=randomBytes(32).toString('base64url'),id=randomUUID();
 approval.request(`Enrollment ${token}`,{request_id:id,client_type:'pi',label:'Configuration unit test'});
 const result=approval.decide(id,'approve');
 assert.equal(Date.parse(result.credential.expires_at),f.now+730*86400000);
});
test('Compose forwards lifetime to the normal entrypoint using the validated environment seam',()=>{
 const compose=readFileSync(new URL('../compose.yaml',import.meta.url),'utf8');
 assert.match(compose,/PSST_AUTHORIZATION_DAYS: \$\{PSST_AUTHORIZATION_DAYS:-90\}/);
 const main=readFileSync(new URL('../src/main.mjs',import.meta.url),'utf8');
 assert.ok(main.indexOf('approvalOptionsFromEnvironment(process.env)')<main.indexOf('await BrokerStore.open'));
 assert.match(main,/ApprovalService\.create\(\{store,\.\.\.approvalOptions\}\)/);
 assert.match(readFileSync(new URL('../Containerfile',import.meta.url),'utf8'),/CMD \["node", "src\/main.mjs"\]/);
});
