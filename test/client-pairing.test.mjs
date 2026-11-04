import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, chmodSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { secretHash } from '../src/enrollment.mjs';
import { setup } from './pairing-helpers.mjs';
import { connectPairingFile, readEnrollmentReceipt } from '../reference/enrollment.mjs';
import { manageEnrollment, argumentsFor } from '../scripts/manage-enrollment.mjs';
test('client helper persists before request, redacts failures, retries after unknown, writes legacy bundle and isolates attempts',async t=>{
 const s=setup(t),directory=join(s.f.dir,'installation');let firstBody;
 const transport=async(url,secret,body)=>{assert.equal(url,'https://broker.example');assert.equal(secret,s.pair.pairing_secret);firstBody??=body;assert.equal(body,firstBody);return s.enrollment.redeem(`Pairing ${secret}`,JSON.parse(body),s.auth.entries);};
 // Adapt service response shape to HTTP helper.
 const success=async(...args)=>{const r=await transport(...args);return{status:r.status,body:r.result};};
 await assert.rejects(connectPairingFile({pairingFile:s.pairingFile,directory,clientType:'pi'},{transport:async(...args)=>{await success(...args);throw Error(`do not leak ${s.pair.pairing_secret}`);}}),e=>e.code==='enrollment_local_error'&&!e.message.includes(s.pair.pairing_secret));
 const result=await connectPairingFile({pairingFile:s.pairingFile,directory,clientType:'pi'},{transport:success});assert.equal(result.connectionFile,join(directory,'enrollments',secretHash(s.pair.pairing_secret),'connection.json'));
 const bundle=JSON.parse(readFileSync(result.connectionFile));assert.equal(bundle.format,'broker-client-bundle-v1');assert.equal(bundle.insecure_development,false);
 const token=readFileSync(join(dirname(result.connectionFile),bundle.token_file),'utf8').trim();assert.equal(s.auth.authenticate(`Bearer ${token}`).credential_id,result.credentialId);
 const r2=await connectPairingFile({pairingFile:s.pairingFile,directory,clientType:'pi'},{transport:success});assert.deepEqual(r2,result);
 await assert.rejects(connectPairingFile({pairingFile:s.pairingFile,directory,clientType:'pi',brokerUrl:'https://wrong.example'},{transport:success}),e=>e.code==='broker_origin_mismatch');
 chmodSync(s.pairingFile,0o644);await assert.rejects(connectPairingFile({pairingFile:s.pairingFile,directory,clientType:'pi'},{transport:success}),e=>e.code==='private_file_required');
});

test('operator explicit consent, bounded TTL, safe output, and local revocation',t=>{
 const s=setup(t);assert.throws(()=>manageEnrollment({action:'pair',policyFile:s.policyFile}));
 const opts={action:'pair',policyFile:s.policyFile,outputFile:join(s.f.dir,'operator-ticket.json'),brokerUrl:'https://broker.example',clientType:'pi',principalId:'owner',scope:'default',approve:true};
 for(const bad of [{ticketSeconds:0},{ticketSeconds:3601},{credentialDays:366},{brokerUrl:'http://broker.example'},{clientType:'unknown'}])assert.throws(()=>manageEnrollment({...opts,...bad}));
 const result=manageEnrollment(opts,{clock:()=>s.f.now});assert.equal(result.action,'pair');const pair=JSON.parse(readFileSync(opts.outputFile));assert.equal(JSON.stringify(result).includes(pair.pairing_secret),false);
 assert.throws(()=>manageEnrollment(opts,{clock:()=>s.f.now}));
 const issued=s.enrollment.redeem(`Pairing ${pair.pairing_secret}`,s.request);
 manageEnrollment({action:'revoke',policyFile:s.policyFile,credentialId:issued.result.credential_id,approve:true});assert.throws(()=>s.auth.authenticate(`Bearer ${s.token}`),e=>e.code==='unauthenticated');
 assert.throws(()=>argumentsFor(['pair','--token','never-allowed']));
});

test('saved enrollment receipt binds credential partition to broker, type and private token',async t=>{
 const s=setup(t),directory=join(s.f.dir,'receipt-installation');
 const result=await connectPairingFile({pairingFile:s.pairingFile,directory,clientType:'pi'},{transport:async(_url,secret,body)=>{const r=s.enrollment.redeem(`Pairing ${secret}`,JSON.parse(body));return{status:r.status,body:r.result};}});
 assert.deepEqual(readEnrollmentReceipt({connectionFile:result.connectionFile,clientType:'pi'}),{credentialId:result.credentialId,expiresAt:result.expiresAt});
 const receiptFile=join(dirname(result.connectionFile),'enrollment.json'),original=JSON.parse(readFileSync(receiptFile));
 for(const patch of [{token_sha256:'0'.repeat(64)},{broker_url:'https://wrong.example'},{client_type:'opencode'},{credential_id:'user-supplied-name'}]){
   writeFileSync(receiptFile,JSON.stringify({...original,...patch}));assert.throws(()=>readEnrollmentReceipt({connectionFile:result.connectionFile,clientType:'pi'}),e=>e.code==='invalid_enrollment_receipt');
 }
 writeFileSync(receiptFile,JSON.stringify({...original,expires_at:new Date(0).toISOString()}));assert.throws(()=>readEnrollmentReceipt({connectionFile:result.connectionFile,clientType:'pi'}),e=>e.code==='credential_expired');
 unlinkSync(receiptFile);assert.throws(()=>readEnrollmentReceipt({connectionFile:result.connectionFile,clientType:'pi'}),e=>e.code==='invalid_enrollment_receipt');
});

test('native private-input helper shares file retries without writing the pairing secret',async t=>{
 const {connectPairingSecret}=await import('../reference/enrollment.mjs');
 const {readdirSync}=await import('node:fs');
 const s=setup(t),directory=join(s.f.dir,'native-input');let bodyFirst;
 const options={directory,brokerUrl:'https://broker.example',clientType:'pi',pairingSecret:s.pair.pairing_secret};
 const transport=async(_url,secret,body)=>{bodyFirst??=body;assert.equal(body,bodyFirst);const r=s.enrollment.redeem(`Pairing ${secret}`,JSON.parse(body));return{status:r.status,body:r.result};};
 await assert.rejects(connectPairingSecret(options,{transport:async(...args)=>{await transport(...args);throw Error(options.pairingSecret);}}),e=>e.code==='enrollment_local_error'&&!e.message.includes(options.pairingSecret));
 const result=await connectPairingSecret(options,{transport});
 assert.deepEqual(await connectPairingFile({pairingFile:s.pairingFile,directory,clientType:'pi'},{transport}),result);
 const scan=path=>{for(const entry of readdirSync(path,{withFileTypes:true})){const child=join(path,entry.name);if(entry.isDirectory())scan(child);else assert.equal(readFileSync(child).includes(Buffer.from(options.pairingSecret)),false);}};
 scan(directory);
 assert.equal(readEnrollmentReceipt({connectionFile:result.connectionFile,clientType:'pi'}).credentialId,result.credentialId);
 for(const change of [{pairingSecret:'short'},{brokerUrl:'http://broker.example'},{clientType:'wrong'}]) await assert.rejects(connectPairingSecret({...options,...change},{transport:()=>{throw Error('must not request');}}));
});
