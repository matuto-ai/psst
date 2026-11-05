import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { writeFileSync } from 'node:fs';
import { Logger, log, FailureTracker, diagnostic, normalizedRoute, withLogContext } from '../src/logger.mjs';
import { createBrokerServer } from '../src/server.mjs';
import { CredentialStore } from '../src/auth.mjs';
import { fixture, registration, sendBody } from './helpers.mjs';
const capture = (options={}) => { const records=[]; const logger=new Logger({format:'json',...options,sink:line=>records.push(JSON.parse(line))});return {logger,records}; };
async function request(app,url,{method='GET',headers={},body}={}) {
  const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);
  Object.assign(req,{url,method,headers:{...(body===undefined?{}:{'content-type':'application/json'}),...headers},socket:{remoteAddress:'127.0.0.1'}});
  const result={headers:{},status:200};
  const res={statusCode:200,setHeader(k,v){result.headers[k]=v;},writeHead(status,headers){result.status=this.statusCode=status;Object.assign(result.headers,headers);},end(value){this.writableEnded=true;result.body=value?JSON.parse(value):null;}};
  await app.handler(req,res);return result;
}
test('logger filters all four levels and supports immediate changes',()=>{
  const {logger,records}=capture({level:'warning',clock:()=>0,version:'0.7.1'});
  for(const level of ['debug','info','warning','error'])log(logger,level,'PSST_TEST');
  assert.deepEqual(records.map(r=>r.level),['warning','error']);
  logger.setLevel('debug');log(logger,'debug','PSST_TEST');
  assert.equal(records.length,3);assert.equal(records[0].timestamp,'1970-01-01T00:00:00.000Z');
  assert.equal(records[0].version,'0.7.1');assert.match(records[0].run_id,/^[\da-f-]{36}$/);
  assert.throws(()=>logger.setLevel('trace'));assert.equal(logger.level,'debug');
});
test('diagnostics discard private messages, headers, arbitrary names/paths and SQL, retaining safe cause/locations',()=>{
  const {logger,records}=capture({level:'debug'}),secret='PRIVATE_TOKEN_abcdefghijk';
  const error=Object.assign(new Error(`SELECT '${secret}' FROM secret WHERE password='${secret}'`),{code:'ERR_SQLITE_ERROR',errcode:13});
  error.stack=`Error: ${secret}\n    at ${secret} (/private/${secret}/src/store.mjs:12:34)\n    at ${secret} (/private/${secret}/arbitrary-secret.mjs:9:2)\n    at bad (/tmp/token.mjs?password=${secret}:1:2)`;
  log(logger,'error','PSST_STORAGE_TRANSACTION_FAILED',{reason:secret,phase:'commit',request_id:randomUUID(),message_id:secret,code:secret,headers:{authorization:secret},content:secret,path:secret,sql:secret,token:secret},error);
  const raw=JSON.stringify(records);assert.ok(!raw.includes(secret));assert.ok(!raw.includes('/private/'));assert.ok(!raw.includes('SELECT'));
  assert.deepEqual(records[0].error,{reason:'sqlite_disk_full',sqlite_code:13,stack:['store.mjs:12:34']});
  assert.equal(records[0].phase,'commit');assert.equal(records[0].reason,undefined);
});
test('temporary-directory errors have an actionable safe diagnosis in JSON and default human-readable logs',()=>{
  const secret='PRIVATE_TOKEN_AND_PATH';
  const error=Object.assign(Error(secret),{errcode:6410});
  const {logger,records}=capture();
  const request_id=randomUUID(), fields={request_id,method:'POST',route:'/v1/messages',phase:'statement',effect:'not_applied',rollback_confirmed:true,poisoned:false};
  log(logger,'error','PSST_STORAGE_TRANSACTION_FAILED',fields,error);
  assert.equal(records[0].error.reason,'sqlite_temp_directory_unavailable');
  assert.equal(records[0].error.sqlite_name,'SQLITE_IOERR_GETTEMPPATH');
  assert.match(records[0].error.hint,/writable \/tmp/);
  assert.match(records[0].message,/nothing was saved/);
  const lines=[],human=new Logger({sink:line=>lines.push(line)});
  log(human,'error','PSST_STORAGE_TRANSACTION_FAILED',{...fields,content:secret,path:secret},error);
  assert.equal(lines.length,1);
  assert.match(lines[0],/ERROR PSST_STORAGE_TRANSACTION_FAILED/);
  assert.match(lines[0],/POST \/v1\/messages/);
  assert.ok(lines[0].includes(request_id));
  assert.match(lines[0],/SQLITE_IOERR_GETTEMPPATH\(6410\)/);
  assert.match(lines[0],/writable \/tmp/);
  assert.equal(lines[0].split('\n').length,2);
  assert.ok(!lines[0].includes(secret));assert.ok(!JSON.stringify(records).includes(secret));
  human.setFormat('json');log(human,'info','PSST_TEST');assert.equal(JSON.parse(lines[1]).event,'PSST_TEST');
  assert.throws(()=>human.setFormat('PRIVATE'),e=>e.code==='invalid_log_format');
});
test('known OS errors are classified without their filenames and exception accessors cannot break logging',()=>{
  assert.equal(diagnostic(Object.assign(new Error('/secret/file'),{code:'EACCES'})).reason,'permission_denied');
  assert.equal(diagnostic(Object.assign(new Error('private'),{code:'ENOSPC'})).reason,'disk_full');
  assert.equal(diagnostic(Object.assign(new Error('private'),{code:'arbitrary-secret'})).reason,'unexpected_error');
  assert.doesNotThrow(()=>diagnostic(new Proxy({}, {get(){throw Error('private');}})));
  const logger=new Logger({sink(){throw Error('sink failed');}});
  assert.doesNotThrow(()=>log(logger,'error','PSST_TEST',{},Error('private')));
  assert.doesNotThrow(()=>log({log(){throw Error('injected');}},'info','PSST_TEST'));
});
test('normalization never includes unknown route segments or query strings',()=>{
  assert.equal(normalizedRoute('/v1/messages/'+randomUUID()+'?token=secret'),'/v1/messages/:id');
  assert.equal(normalizedRoute('/admin/requests/private-secret/approve'),'/admin/*');
  assert.equal(normalizedRoute('/v1/secret-token'), 'unknown');
  assert.equal(normalizedRoute('/v1/sessions/'+randomUUID()+'/heartbeat'),'/v1/sessions/:id/heartbeat');
});
test('async request contexts remain isolated and cannot inject private fields',async()=>{
  const {logger,records}=capture({level:'debug'}),a=randomUUID(),b=randomUUID();
  await Promise.all([a,b].map(request_id=>withLogContext({request_id,token:'PRIVATE'},async()=>{await Promise.resolve();log(logger,'debug','PSST_CONTEXT');})));
  assert.deepEqual(records.map(r=>r.request_id).sort(),[a,b].sort());assert.ok(!JSON.stringify(records).includes('PRIVATE'));
  log(logger,'info','PSST_OUTSIDE');assert.equal(records.at(-1).request_id,undefined);
});
test('recurring failures are bounded, summarized and recovery is emitted once',()=>{
  let now=0;const {logger,records}=capture();const tracker=new FailureTracker(logger,{clock:()=>now});
  for(let n=0;n<100;n++)tracker.fail('sweep','PSST_SWEEP_FAILED',{operation:'sweep'},Error('private'));
  assert.equal(records.length,1);now=60000;tracker.fail('sweep','PSST_SWEEP_FAILED',{operation:'sweep'},Error());
  assert.equal(records[1].repeated,100);tracker.fail('sweep','PSST_SWEEP_FAILED',{},Error());tracker.recover('sweep','PSST_SWEEP_RECOVERED');tracker.recover('sweep','PSST_SWEEP_RECOVERED');
  assert.equal(records.length,3);assert.equal(records[2].repeated,1);
});
test('HTTP failure correlates request ID without exposing private cause or raw URL',async()=>{
  const {logger,records}=capture({level:'debug'});
  const auth={authenticate(){throw Object.assign(Error('password=PRIVATE'),{code:'ENOSPC'});}};
  const app=createBrokerServer({store:{limits:{}},auth,logger,insecureDevelopment:true});
  const result=await request(app,'/v1/private-secret?token=PRIVATE');
  assert.equal(result.status,503);assert.equal(result.body.error.effect,'unknown');assert.equal(result.body.error.code,'storage_unavailable');
  const failed=records.find(r=>r.event==='PSST_HTTP_REQUEST_FAILED');
  assert.equal(failed.request_id,result.headers['X-Request-ID']);assert.equal(failed.route,'unknown');assert.equal(failed.error.reason,'disk_full');
  assert.ok(!JSON.stringify({records,result}).includes('PRIVATE'));assert.ok(!JSON.stringify(records).includes('private-secret'));
});
test('HTTP request and message lifecycle diagnostics share correlation without message content',async t=>{
  const {logger,records}=capture({level:'debug'}),f=fixture(t,{logger}),a=registration(),b=registration();
  const app=createBrokerServer({store:f.store,auth:f.auth,logger,insecureDevelopment:true});
  const auth={authorization:`Bearer ${f.a.token}`};
  await request(app,'/v1/sessions',{method:'POST',headers:auth,body:a});
  await request(app,'/v1/sessions',{method:'POST',headers:{authorization:`Bearer ${f.b.token}`},body:b});records.length=0;
  const result=await request(app,'/v1/messages',{method:'POST',headers:{...auth,'x-client-id':a.client_id,'x-lease-epoch':'1','idempotency-key':'synthetic-key'},body:sendBody(b.client_id,'PRIVATE_MESSAGE_TEXT')});
  assert.equal(result.status,202);const id=result.headers['X-Request-ID'];
  assert.ok(records.some(r=>r.event==='PSST_HTTP_REQUEST_FINISHED'&&r.request_id===id));
  assert.ok(records.some(r=>r.message_id===result.body.message_id&&r.request_id===id));
  const raw=JSON.stringify(records);for(const secret of ['PRIVATE_MESSAGE_TEXT',f.a.token,f.b.token,'synthetic-key','same-name'])assert.ok(!raw.includes(secret));
});
test('long polling rechecks authentication but logs success only once and omits empty transaction noise',async t=>{
  const {logger,records}=capture({level:'debug'}),f=fixture(t,{logger}),a=registration();
  f.store.register(f.a.entry,a);records.length=0;
  let checks=0;
  const auth={authenticate(header){checks++;return f.auth.authenticate(header);}};
  const app=createBrokerServer({store:f.store,auth,logger,insecureDevelopment:true,pollIntervalMs:20});
  const result=await request(app,'/v1/mailbox/claim',{method:'POST',headers:{authorization:`Bearer ${f.a.token}`,'x-client-id':a.client_id,'x-lease-epoch':'1','idempotency-key':'empty-poll'},body:{wait_seconds:1}});
  assert.equal(result.status,204);assert.ok(checks>2);
  assert.equal(records.filter(r=>r.event==='PSST_AUTHENTICATION_ACCEPTED').length,1);
  assert.equal(records.filter(r=>r.event==='PSST_STORAGE_TRANSACTION_COMMITTED').length,0);
});
test('maintenance preserves sweep after reload failure, limits repeated reports and logs recovery/readiness',()=>{
  const {logger,records}=capture();let fails=true,sweeps=0;
  const auth={ready:true,reload(){if(fails){this.ready=false;throw Error('PRIVATE');}this.ready=true;}};
  const store={safe:()=>true,sweep(){sweeps++;}};
  const app=createBrokerServer({store,auth,logger,insecureDevelopment:true});
  app.maintenance();app.maintenance();assert.equal(sweeps,2);
  assert.equal(records.filter(r=>r.event==='PSST_AUTH_MAINTENANCE_FAILED').length,1);
  fails=false;app.maintenance();assert.ok(records.some(r=>r.event==='PSST_AUTH_MAINTENANCE_RECOVERED'));
  assert.deepEqual(records.filter(r=>r.event==='PSST_READINESS_CHANGED').map(r=>r.ready),[false,true]);
});
test('credential reload failure is safely reported once and recovery is observable',t=>{
  const f=fixture(t),{logger,records}=capture({level:'debug'});
  const auth=new CredentialStore({path:f.dir+'/credentials.json',clock:()=>f.now,logger});records.length=0;
  writeFileSync(f.dir+'/credentials.json','PRIVATE_INVALID_JSON');
  for(let n=0;n<3;n++)assert.throws(()=>auth.reload());
  assert.equal(records.filter(r=>r.event==='PSST_AUTH_RELOAD_FAILED').length,1);assert.equal(auth.ready,false);
  f.writeCreds([f.a.entry]);auth.reload();assert.equal(auth.ready,true);
  assert.ok(records.some(r=>r.event==='PSST_AUTH_RELOAD_RECOVERED'));assert.ok(!JSON.stringify(records).includes('PRIVATE_INVALID_JSON'));
});
test('background storage failures are summarized without suppressing request-correlated failures',async()=>{
  let now=0;const {logger,records}=capture({clock:()=>now});
  for(let n=0;n<10;n++)log(logger,'error','PSST_STORAGE_TRANSACTION_FAILED',{phase:'statement'},Object.assign(Error('private'),{errcode:13}));
  assert.equal(records.length,1);now=60000;
  log(logger,'error','PSST_STORAGE_TRANSACTION_FAILED',{phase:'statement'},Object.assign(Error(),{errcode:13}));assert.equal(records[1].repeated,10);
  for(let n=0;n<2;n++)withLogContext({request_id:randomUUID()},()=>log(logger,'error','PSST_STORAGE_TRANSACTION_FAILED',{phase:'statement'},Error()));
  assert.equal(records.length,4);
  log(logger,'debug','PSST_STORAGE_TRANSACTION_COMMITTED');
  assert.equal(records.length,4,'an unrelated commit does not establish recovery');assert.equal(logger.backgroundFailures.size,1);
});

test('successful sweep cannot clear recurring authorization transaction failures',t=>{
  const {logger,records}=capture(),f=fixture(t,{logger});records.length=0;let failing=true;
  const auth={ready:true,reload(){
    if(failing){this.ready=false;f.store.tx(()=>{throw Object.assign(Error('private'),{errcode:13});});}
    this.ready=true;
  }};
  const app=createBrokerServer({store:f.store,auth,logger,insecureDevelopment:true});
  for(let n=0;n<10;n++)app.maintenance();
  assert.equal(records.filter(r=>r.event==='PSST_STORAGE_TRANSACTION_FAILED').length,1);
  assert.equal(records.filter(r=>r.event.includes('RECOVERED')).length,0);
  failing=false;app.maintenance();
  assert.equal(records.filter(r=>r.event==='PSST_AUTH_MAINTENANCE_RECOVERED').length,1);
  failing=true;app.maintenance();
  assert.equal(records.filter(r=>r.event==='PSST_STORAGE_TRANSACTION_FAILED').length,2,'a new fault after real recovery is immediately visible');
});
