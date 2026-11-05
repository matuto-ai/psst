import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdtempSync, chmodSync, writeFileSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { backupDatabase } from '../scripts/backup.mjs';
import { log } from './logger.mjs';
import { ApiError, TYPES, canonical, validateUuid } from './protocol.mjs';

// Revocation visibility is separate from durable replay/collision protection.
export const REVOKED_RETENTION_MS=30*24*60*60*1000;
const DAY_MS=24*60*60*1000;
export const MAX_AUTHORIZATION_DAYS=3650;
export function authorizationDurationMs(value='90'){
  if(typeof value!=='string'||!/^[1-9][0-9]{0,3}$/.test(value)||Number(value)>MAX_AUTHORIZATION_DAYS){
    const error=new Error('PSST_AUTHORIZATION_DAYS must be a whole number from 1 to 3650 (default 90).');
    error.code='invalid_authorization_days';throw error;
  }
  return Number(value)*DAY_MS;
}
// Shared startup seam: validate before the caller opens storage.
export function approvalOptionsFromEnvironment(env={}){
  return {credentialMs:authorizationDurationMs(env.PSST_AUTHORIZATION_DAYS)};
}
const hash=s=>createHash('sha256').update(s).digest('hex');
const iso=n=>new Date(n).toISOString();
const deny=()=>{throw new ApiError(401,'unauthenticated');};
export class ApprovalService {
  static async create(options) {
    const {store}=options;
    const version=store.db.prepare('PRAGMA user_version').get().user_version;
    if(!store.preApprovalBackup && (version<4 || !store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='approval_requests'").get())){
      const parent=dirname(store.path),dir=mkdtempSync(join(parent,'before-approval-'));
      chmodSync(dir,0o700);
      await backupDatabase(store.path,join(dir,'broker.sqlite'));
      writeFileSync(join(dir,'manifest.json'),JSON.stringify({database:store.path,schema:version,created_at:iso(store.clock())})+'\n',{flag:'wx',mode:0o600});
      for(const path of [join(dir,'broker.sqlite'),join(dir,'manifest.json'),dir,parent]){const fd=openSync(path,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
    }
    return new ApprovalService(options);
  }
  constructor({store,scope='psst',principal='owner',pendingMs=86400000,credentialMs=7776000000,settings}) {
    if(!/^[-a-zA-Z0-9_.]{1,128}$/.test(scope)||!/^[-a-zA-Z0-9_.]{1,128}$/.test(principal)
      ||!Number.isSafeInteger(pendingMs)||pendingMs<1000||pendingMs>86400000
      ||!Number.isSafeInteger(credentialMs)||credentialMs<1000||credentialMs>MAX_AUTHORIZATION_DAYS*DAY_MS)throw Error('invalid_approval_settings');
    Object.assign(this,{store,scope,principal,pendingMs,credentialMs,settings});
    store.tx(()=>{store.db.exec(`CREATE TABLE IF NOT EXISTS approval_requests (
      id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, request TEXT NOT NULL,
      type TEXT NOT NULL, label TEXT NOT NULL, state TEXT NOT NULL,
      created INTEGER NOT NULL, deadline INTEGER NOT NULL, expires INTEGER,
      entry TEXT, result TEXT);
      CREATE TABLE IF NOT EXISTS admin_sessions (
      hash TEXT PRIMARY KEY, csrf TEXT NOT NULL, authenticated INTEGER NOT NULL,
      expires INTEGER NOT NULL, password_hash TEXT NOT NULL);
      PRAGMA user_version=${Math.max(4,store.db.prepare('PRAGMA user_version').get().user_version)};`);
      const columns=new Set(store.db.prepare('PRAGMA table_info(approval_requests)').all().map(c=>c.name));
      for(const column of ['revoked_at','revocation_observed_at']){
        if(!columns.has(column))store.db.exec(`ALTER TABLE approval_requests ADD COLUMN ${column} INTEGER`);
      }
      // Unknown historical revocation times stay unknown. Start a full grace period
      // at first observation, persisting it so restarts cannot extend retention.
      store.db.prepare("UPDATE approval_requests SET revocation_observed_at=? WHERE state='revoked' AND revoked_at IS NULL AND revocation_observed_at IS NULL").run(store.clock());
    });
  }
  proof(header){
    const m=typeof header==='string'&&/^Enrollment ([A-Za-z0-9_-]{43})$/.exec(header);
    if(!m)deny();return hash(m[1]);
  }
  expire(){
    const now=this.store.clock();
    const expired=this.store.db.prepare("UPDATE approval_requests SET state='expired' WHERE (state='pending' AND deadline<=?) OR (state='approved' AND expires<=?)").run(now,now);
    if(expired.changes)this.store.diagnostic('debug','PSST_APPROVAL_EXPIRED',{count:expired.changes});
  }
  view(row){
    const result={request_id:row.id,state:row.state,request_expires_at:iso(row.deadline)};
    if(row.state==='approved')result.credential=JSON.parse(row.result);
    return result;
  }
  request(header,input,existing=[]){
    const tokenHash=this.proof(header);
    if(!input||Array.isArray(input)||Object.keys(input).some(k=>!['request_id','client_type','label'].includes(k))
      ||!TYPES.includes(input.client_type)||typeof input.label!=='string'||input.label.length>80||/[\u0000-\u001f\u007f]/u.test(input.label))throw new ApiError(400,'invalid_request','body');
    const id=validateUuid(input.request_id,'request_id');const request=canonical(input);
    const outcome=this.store.tx(()=>{
      this.expire();
      const prior=this.store.db.prepare('SELECT * FROM approval_requests WHERE id=?').get(id);
      if(prior){
        if(prior.token_hash!==tokenHash)deny();
        if(prior.request!==request)throw new ApiError(409,'idempotency_conflict');
        return {status:200,result:this.view(prior)};
      }
      if(existing.some(c=>c.token_sha256===tokenHash)||this.store.db.prepare('SELECT 1 FROM approval_requests WHERE token_hash=?').get(tokenHash))throw new ApiError(409,'idempotency_conflict');
      // Denied/expired cleanup is unchanged. Revoked records are durable tombstones:
      // deleting them would lose replay and key/identity collision protection.
      this.store.db.prepare("DELETE FROM approval_requests WHERE state IN ('denied','expired') AND max(deadline,coalesce(expires,deadline))<?").run(this.store.clock()-2592000000);
      // Archived revocations reserve identities, not live admission capacity.
      if(this.store.db.prepare("SELECT count(*) n FROM approval_requests WHERE state!='revoked' OR coalesce(revoked_at,revocation_observed_at)>?").get(this.store.clock()-REVOKED_RETENTION_MS).n>=10000
        ||this.store.db.prepare("SELECT count(*) n FROM approval_requests WHERE state='pending'").get().n>=1000)throw new ApiError(429,'rate_limited',null,{retryable:true,retry_after:60});
      const now=this.store.clock();
      this.store.db.prepare('INSERT INTO approval_requests(id,token_hash,request,type,label,state,created,deadline) VALUES(?,?,?,?,?,?,?,?)').run(id,tokenHash,request,input.client_type,input.label,'pending',now,now+(this.settings ? this.settings.get('pending_request_hours')*3600000 : this.pendingMs));
      return {status:201,result:this.view(this.store.db.prepare('SELECT * FROM approval_requests WHERE id=?').get(id))};
    });
    log(this.store.logger, outcome.status===201?'info':'debug', 'PSST_APPROVAL_REQUEST_PROCESSED', {authorization_id:id,state:outcome.result.state,replayed:outcome.status!==201});
    return outcome;
  }
  status(header,id){
    const proof=this.proof(header);validateUuid(id,'path.request_id');
    return this.store.tx(()=>{
      this.expire();const row=this.store.db.prepare('SELECT * FROM approval_requests WHERE id=?').get(id);
      if(!row||!timingSafeEqual(Buffer.from(row.token_hash,'hex'),Buffer.from(proof,'hex')))deny();
      return this.view(row);
    });
  }
  list({offset=0,limit=1000}={}){
    if(!Number.isSafeInteger(offset)||offset<0||offset>10000||!Number.isSafeInteger(limit)||limit<1||limit>1000)throw new ApiError(400,'invalid_request');
    return this.store.tx(()=>{this.expire();return this.store.db.prepare("SELECT id,type,label,state,created,deadline,expires,result FROM approval_requests WHERE state!='revoked' OR coalesce(revoked_at,revocation_observed_at)>? ORDER BY CASE state WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,created DESC,id LIMIT ? OFFSET ?").all(this.store.clock()-REVOKED_RETENTION_MS,limit,offset);});
  }
  decide(id,action,existing=[]){
    validateUuid(id,'path.request_id');
    if(!['approve','deny','revoke'].includes(action))throw new ApiError(400,'invalid_request');
    const outcome=this.store.tx(()=>{
      this.expire();const row=this.store.db.prepare('SELECT * FROM approval_requests WHERE id=?').get(id);
      if(!row)throw new ApiError(404,'invalid_request');
      if((action==='approve'&&row.state==='approved')||(action==='deny'&&row.state==='denied')||(action==='revoke'&&row.state==='revoked'))return this.view(row);
      if(action==='revoke'&&row.state==='approved')this.store.db.prepare("UPDATE approval_requests SET state='revoked',revoked_at=? WHERE id=?").run(this.store.clock(),id);
      else if(action==='deny'&&row.state==='pending')this.store.db.prepare("UPDATE approval_requests SET state='denied' WHERE id=?").run(id);
      else if(action==='approve'&&row.state==='pending'){
        if(existing.some(c=>c.token_sha256===row.token_hash&&c.approval_request_id!==id))throw new ApiError(409,'idempotency_conflict');
        const credential_id=`enrolled-${randomUUID()}`,adapter_id=`installation-${randomUUID()}`,expires=this.store.clock()+(this.settings ? this.settings.get('authorization_days')*DAY_MS : this.credentialMs);
        if(existing.some(c=>c.credential_id===credential_id||c.adapter_id===adapter_id))throw new ApiError(409,'idempotency_conflict');
        const result={credential_id,adapter_id,client_type:row.type,scopes:[this.scope],expires_at:iso(expires),protocol_version:'1'};
        const entry={credential_id,adapter_id,principal_id:this.principal,client_types:[row.type],scopes:[this.scope],expires_at:result.expires_at,token_sha256:row.token_hash};
        this.store.db.prepare("UPDATE approval_requests SET state='approved',expires=?,entry=?,result=? WHERE id=?").run(expires,canonical(entry),canonical(result),id);
      }else throw new ApiError(409,'idempotency_conflict');
      return this.view(this.store.db.prepare('SELECT * FROM approval_requests WHERE id=?').get(id));
    });
    log(this.store.logger, 'info', 'PSST_APPROVAL_DECISION_APPLIED', {authorization_id:id,state:outcome.state});
    return outcome;
  }
  reservations(){return this.store.db.prepare('SELECT id,token_hash FROM approval_requests').all().map(r=>({token_sha256:r.token_hash,approval_request_id:r.id}));}
  credentials(){return this.store.db.prepare("SELECT entry FROM approval_requests WHERE state='approved' AND expires>?").all(this.store.clock()).map(r=>JSON.parse(r.entry));}
}

