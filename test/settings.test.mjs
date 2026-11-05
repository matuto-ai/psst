import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { fixture, registration, sendBody } from './helpers.mjs';
import { SettingsService, validateSettingsOverrides } from '../src/settings.mjs';
import { ApprovalService } from '../src/approval.mjs';
import { AdminUI } from '../src/admin.mjs';
import { adminRequest } from './admin-request.mjs';

const request = approval => approval.request(`Enrollment ${randomBytes(32).toString('base64url')}`, {request_id:randomUUID(),client_type:'pi',label:'synthetic'}).result;
const fields = {log_level:'debug',authorization_days:'3650',pending_request_hours:'1',admin_session_hours:'168',default_message_ttl_seconds:'60'};
async function setup(t, options = {}) {
  const f=fixture(t),settings=new SettingsService({store:f.store,...options});
  const approval=await ApprovalService.create({store:f.store,settings});
  const admin=await AdminUI.create({approval,auth:f.auth,settings,password:'synthetic-settings-password',insecureDevelopment:true});
  const session=admin.issue(true),cookie=`psst_admin=${session.cookie}`;
  const post = (patch, headers = {}) => adminRequest(admin,'/admin/settings',{method:'POST',headers:{cookie,origin:'http://admin.test','content-type':'application/x-www-form-urlencoded',...headers},body:new URLSearchParams({csrf:session.csrf,...patch})});
  return {f,settings,approval,admin,session,cookie,post};
}
test('settings persist across restart without changing schema version',t=>{
  const f=fixture(t),version=f.store.db.prepare('PRAGMA user_version').get().user_version;
  const settings=new SettingsService({store:f.store});
  assert.equal(settings.get('authorization_days'),90);
  settings.update(fields);
  assert.equal(f.store.db.prepare('PRAGMA user_version').get().user_version,version);
  const next=new SettingsService({store:f.restart()});
  for(const [key,value] of Object.entries(fields))assert.equal(String(next.get(key)),value);
  assert.equal(f.store.limits.default_ttl_seconds,60);
  assert.ok(next.snapshot().every(x=>x.source==='Saved in Settings'&&!x.locked));
});
test('environment overrides file, file overrides persisted, and locks reject even same value',t=>{
  const f=fixture(t);new SettingsService({store:f.store}).update({log_level:'debug',authorization_days:7});
  const settings=new SettingsService({store:f.store,config:{log_level:'warning',authorization_days:30},env:{PSST_LOG_LEVEL:'error'}});
  assert.equal(settings.get('log_level'),'error');assert.equal(settings.get('authorization_days'),30);
  assert.equal(settings.snapshot().find(x=>x.key==='log_level').source,'Environment: PSST_LOG_LEVEL');
  assert.throws(()=>settings.update({pending_request_hours:2,log_level:'error'}));
  assert.equal(settings.get('pending_request_hours'),24);
  assert.equal(JSON.parse(f.store.db.prepare("SELECT value FROM broker_settings WHERE key='log_level'").get().value),'debug');
  assert.equal(new SettingsService({store:f.store}).get('authorization_days'),7);
});
test('all settings validate strict values and atomic boundaries; transport retention remains unchanged',t=>{
  const f=fixture(t),settings=new SettingsService({store:f.store}),before={...f.store.limits};
  for(const patch of [{authorization_days:0},{authorization_days:3651},{authorization_days:'1e2'},{authorization_days:1.5},{pending_request_hours:25},{pending_request_hours:0},{admin_session_hours:0},{admin_session_hours:169},{default_message_ttl_seconds:59},{default_message_ttl_seconds:604801},{log_level:'trace'},{log_level:'INFO'},{retention_seconds:10},{toString:2},JSON.parse('{"__proto__":1}'),null,[]]){
    assert.throws(()=>settings.update(patch));
  }
  assert.throws(()=>settings.update({log_level:'error',authorization_days:3651}));
  assert.equal(settings.get('log_level'),'info');
  settings.update({authorization_days:1,pending_request_hours:1,admin_session_hours:1,default_message_ttl_seconds:604800});
  settings.update({authorization_days:3650,pending_request_hours:24,admin_session_hours:168,default_message_ttl_seconds:60});
  for(const key of Object.keys(before).filter(k=>k!=='default_ttl_seconds'))assert.equal(f.store.limits[key],before[key]);
  assert.throws(()=>validateSettingsOverrides({env:{PSST_LOG_LEVEL:''}}));
  assert.throws(()=>validateSettingsOverrides({config:{unknown:1}}));
  assert.throws(()=>validateSettingsOverrides({config:{default_message_ttl_seconds:60},limits:{min_ttl_seconds:120}}));
});
test('failed durable save does not publish runtime changes or invoke callback',t=>{
  const f=fixture(t);let calls=0;
  const settings=new SettingsService({store:f.store,onChange:()=>calls++});
  f.store.fault=phase=>{if(phase==='before_commit')throw Error('synthetic');};
  assert.throws(()=>settings.update({log_level:'error',default_message_ttl_seconds:60}));
  f.store.fault=()=>{};
  assert.equal(settings.get('log_level'),'info');assert.equal(f.store.limits.default_ttl_seconds,86400);assert.equal(calls,0);
  settings.onChange=()=>{throw Error('synthetic callback');};
  assert.doesNotThrow(()=>settings.update({log_level:'debug'}));assert.equal(settings.get('log_level'),'debug');
});
test('new approval requests, grants and admin logins use new clocks without renewing existing records',async t=>{
  const {f,settings,approval,admin,session}=await setup(t);
  const old=request(approval),grant=approval.decide(old.request_id,'approve'),pending=request(approval);
  const oldExpiry=grant.credential.expires_at;
  settings.update({authorization_days:1,pending_request_hours:1,admin_session_hours:1});
  assert.equal(approval.decide(old.request_id,'approve').credential.expires_at,oldExpiry);
  const current=request(approval),newGrant=approval.decide(current.request_id,'approve');
  assert.equal(Date.parse(current.request_expires_at)-f.now,3600000);
  assert.equal(Date.parse(newGrant.credential.expires_at)-f.now,86400000);
  assert.equal(f.store.db.prepare('SELECT deadline FROM approval_requests WHERE id=?').get(pending.request_id).deadline,Date.parse(pending.request_expires_at));
  assert.equal(admin.issue(true).expires-f.now,3600000);
  assert.equal(f.store.db.prepare('SELECT expires FROM admin_sessions WHERE hash=?').get(session.hash).expires,session.expires);
});
test('Settings reuses login, origin, CSRF, no-store and CSP protections and rejects unknown form keys',async t=>{
  const {admin,cookie,post,settings}=await setup(t);
  const anonymous=await adminRequest(admin,'/admin/settings');
  assert.match(anonymous.html,/Administrator login/);assert.doesNotMatch(anonymous.html,/name="authorization_days"/);
  const page=await adminRequest(admin,'/admin/settings',{headers:{cookie}});
  assert.equal(page.status,200);assert.match(page.html,/<html lang="en">/);assert.match(page.html,/aria-current="page"[^>]*>.*?Settings/s);
  assert.equal(page.headers.get('cache-control'),'no-store');assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  assert.match(page.html,/Whole numbers from 1 to 3650 days/);assert.match(page.html,/Built-in default/);
  assert.equal((await post(fields,{origin:'http://evil.test'})).status,403);
  assert.equal((await post({...fields,csrf:'wrong'})).status,403);
  assert.equal((await post(fields,{cookie:''})).status,403);
  assert.equal((await post({...fields,unknown:'anything'})).status,400);assert.equal(settings.get('log_level'),'info');
  const saved=await post(fields);assert.equal(saved.status,200);assert.match(saved.html,/Settings saved/);assert.equal(settings.get('log_level'),'debug');
  assert.equal((await adminRequest(admin,'/admin/settings?x=1',{headers:{cookie}})).status,400);
});
test('externally managed inputs show effective source and cannot be overwritten through forged forms',async t=>{
  const {admin,cookie,post,settings}=await setup(t,{env:{PSST_AUTHORIZATION_DAYS:'14'}});
  const page=await adminRequest(admin,'/admin/settings',{headers:{cookie}});
  assert.match(page.html,/name="authorization_days"[^>]*disabled/);assert.match(page.html,/Environment: PSST_AUTHORIZATION_DAYS · Locked/);
  assert.equal((await post({authorization_days:'90',log_level:'debug'})).status,400);
  assert.equal(settings.get('authorization_days'),14);assert.equal(settings.get('log_level'),'info');
  assert.equal((await post({log_level:'warning'})).status,200);
});

test('message lifetime applies only to future omitted TTLs and never changes retained receipts',t=>{
  const f=fixture(t),settings=new SettingsService({store:f.store});
  const a=registration(),b=registration();f.store.register(f.a.entry,a);f.store.register(f.b.entry,b);
  const first=f.store.send(f.a.entry,a.client_id,1,'before',sendBody(b.client_id));
  const before=f.store.receipt(f.a.entry,a.client_id,first.message_id);
  settings.update({default_message_ttl_seconds:120});
  const second=f.store.send(f.a.entry,a.client_id,1,'after',sendBody(b.client_id));
  const explicit=f.store.send(f.a.entry,a.client_id,1,'explicit',sendBody(b.client_id,'synthetic',{ttl_seconds:300}));
  assert.equal(Date.parse(f.store.receipt(f.a.entry,a.client_id,second.message_id).expires_at)-f.now,120000);
  assert.equal(Date.parse(f.store.receipt(f.a.entry,a.client_id,explicit.message_id).expires_at)-f.now,300000);
  assert.equal(f.store.receipt(f.a.entry,a.client_id,first.message_id).expires_at,before.expires_at);
  assert.deepEqual(f.store.send(f.a.entry,a.client_id,1,'before',sendBody(b.client_id)),first);
});
test('startup overrides resolve TTL before finite store limit validation and reject conflicting deployment controls',async t=>{
  const {settingsOptionsFromConfiguration}=await import('../src/settings.mjs');
  const options=settingsOptionsFromConfiguration({limits:{max_ttl_seconds:3600},settings:{default_message_ttl_seconds:1800}},{PSST_DEFAULT_MESSAGE_TTL_SECONDS:'60'});
  assert.equal(options.limits.default_ttl_seconds,60);
  const f=fixture(t,{limits:options.limits});
  const settings=new SettingsService({store:f.store,config:options.config,env:{PSST_DEFAULT_MESSAGE_TTL_SECONDS:'60'}});
  assert.equal(settings.get('default_message_ttl_seconds'),60);
  for(const settings of [null,[],1,'x'])assert.throws(()=>settingsOptionsFromConfiguration({settings}));
  assert.throws(()=>settingsOptionsFromConfiguration({limits:{default_ttl_seconds:60},settings:{default_message_ttl_seconds:120}}));
  assert.equal(settingsOptionsFromConfiguration({limits:{default_ttl_seconds:60}}).config.default_message_ttl_seconds,60);
});
