import { openSync, closeSync, readFileSync, fstatSync, constants } from 'node:fs';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { log } from './logger.mjs';
import { ApiError, TYPES, canonical, validateUuid } from './protocol.mjs';

export const ENROLLMENT_LIMIT = 1000;
const identity = value => typeof value === 'string' && /^[-a-zA-Z0-9_.]{1,128}$/.test(value);
const hashPattern = /^[a-f0-9]{64}$/;
export const secretHash = value => createHash('sha256').update(value).digest('hex');
export function readPrivateJson(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = fstatSync(fd);
    if (!s.isFile() || s.size > 1024 * 1024 || (s.mode & 0o077) || (process.getuid && ![process.getuid(), 0].includes(s.uid))) throw new Error('private_file_required');
    return JSON.parse(readFileSync(fd, 'utf8'));
  } finally { closeSync(fd); }
}
export function validateEnrollmentPolicy(value) {
  if (!value || Object.keys(value).some(k => !['format','grants','revoked_credentials'].includes(k)) || value.format !== 'psst-enrollment-policy-v1'
    || !Array.isArray(value.grants) || value.grants.length > ENROLLMENT_LIMIT || !Array.isArray(value.revoked_credentials)
    || value.revoked_credentials.length > 10000 || value.revoked_credentials.some(v => !identity(v))) throw new Error('invalid_enrollment_policy');
  const ids = new Set(), hashes = new Set();
  for (const g of value.grants) {
    if (!g || Object.keys(g).some(k => !['grant_id','secret_sha256','principal_id','client_type','scopes','expires_at','credential_expires_at'].includes(k))
      || !identity(g.grant_id) || !identity(g.principal_id) || !TYPES.includes(g.client_type) || typeof g.secret_sha256 !== 'string' || !hashPattern.test(g.secret_sha256)
      || ids.has(g.grant_id) || hashes.has(g.secret_sha256) || !Array.isArray(g.scopes) || !g.scopes.length || g.scopes.length > 32 || g.scopes.some(v => !identity(v))
      || typeof g.expires_at !== 'string' || !Number.isFinite(Date.parse(g.expires_at)) || typeof g.credential_expires_at !== 'string'
      || !Number.isFinite(Date.parse(g.credential_expires_at)) || Date.parse(g.credential_expires_at) < Date.parse(g.expires_at)) throw new Error('invalid_enrollment_policy');
    ids.add(g.grant_id); hashes.add(g.secret_sha256);
  }
  return value;
}

/** Optional authority: policy is operator-owned; issuance and replay are one durable transaction. */
export class EnrollmentService {
  constructor({ store, policyFile }) {
    this.store = store; this.policyFile = policyFile;
    this.policy(); // fail before migration if policy is unsafe
    store.tx(() => {
      store.db.exec(`CREATE TABLE IF NOT EXISTS enrolled_credentials (
        grant_hash TEXT PRIMARY KEY, enrollment_id TEXT UNIQUE NOT NULL, request TEXT NOT NULL,
        credential_id TEXT UNIQUE NOT NULL, token_hash TEXT UNIQUE NOT NULL, entry TEXT NOT NULL,
        result TEXT NOT NULL, expires INTEGER NOT NULL);
        PRAGMA user_version=${Math.max(3,store.db.prepare('PRAGMA user_version').get().user_version)};`);
    });
  }
  policy() { return validateEnrollmentPolicy(readPrivateJson(this.policyFile)); }
  reservations() { return this.store.db.prepare('SELECT token_hash FROM enrolled_credentials').all().map(r=>({token_sha256:r.token_hash})); }
  credentials() {
    const p = this.policy(), now = this.store.clock();
    return this.store.db.prepare('SELECT entry FROM enrolled_credentials WHERE expires>?').all(now)
      .map(row => JSON.parse(row.entry)).filter(c => !p.revoked_credentials.includes(c.credential_id));
  }
  // Cheap possession check before accepting an upload. Never consumes or issues.
  preflight(header) {
    const match=typeof header==='string'&&/^Pairing ([A-Za-z0-9_-]{43})$/.exec(header);
    if(!match)throw new ApiError(401,'unauthenticated','headers.Authorization');
    const hash=secretHash(match[1]),p=this.policy(),now=this.store.clock();
    const prior=this.store.db.prepare('SELECT credential_id,expires FROM enrolled_credentials WHERE grant_hash=?').get(hash);
    if(prior){
      if(prior.expires>now&&!p.revoked_credentials.includes(prior.credential_id))return;
      throw new ApiError(401,'unauthenticated');
    }
    let grant;
    for(const g of p.grants)if(timingSafeEqual(Buffer.from(hash,'hex'),Buffer.from(g.secret_sha256,'hex')))grant=g;
    if(!grant||Date.parse(grant.expires_at)<=now||Date.parse(grant.credential_expires_at)<=now)throw new ApiError(401,'unauthenticated');
  }
  redeem(header, input, existingCredentials = []) {
    const match = typeof header === 'string' && /^Pairing ([A-Za-z0-9_-]{43})$/.exec(header);
    if (!match) throw new ApiError(401, 'unauthenticated', 'headers.Authorization');
    if (!input || Array.isArray(input) || Object.keys(input).some(k => !['enrollment_id','client_type','token_sha256'].includes(k))
      || !TYPES.includes(input.client_type) || typeof input.token_sha256 !== 'string' || !hashPattern.test(input.token_sha256)) throw new ApiError(400,'invalid_request','body');
    const b = { enrollment_id: validateUuid(input.enrollment_id, 'enrollment_id'), client_type: input.client_type, token_sha256: input.token_sha256 };
    const request = canonical(b), hash = secretHash(match[1]), p = this.policy(), now = this.store.clock();
    const outcome = this.store.tx(() => {
      const prior = this.store.db.prepare('SELECT * FROM enrolled_credentials WHERE grant_hash=?').get(hash);
      if (prior) {
        if (prior.expires <= now || p.revoked_credentials.includes(prior.credential_id)) throw new ApiError(401,'unauthenticated');
        if (prior.request !== request) throw new ApiError(409,'idempotency_conflict');
        return { status: 200, result: JSON.parse(prior.result) };
      }
      // Constant-time comparison against bounded policy; possession never expands scope.
      let grant;
      for (const g of p.grants) if (timingSafeEqual(Buffer.from(hash,'hex'), Buffer.from(g.secret_sha256,'hex'))) grant = g;
      if (!grant || Date.parse(grant.expires_at) <= now || Date.parse(grant.credential_expires_at) <= now) throw new ApiError(401,'unauthenticated');
      if (grant.client_type !== b.client_type) throw new ApiError(403,'forbidden','client_type');
      if (existingCredentials.some(c => c.token_sha256 === b.token_sha256)
        || this.store.db.prepare('SELECT 1 FROM enrolled_credentials WHERE enrollment_id=? OR token_hash=?').get(b.enrollment_id,b.token_sha256)) throw new ApiError(409,'idempotency_conflict');
      // Expired rows cannot be reissued: grant expiry never exceeds credential expiry.
      this.store.db.prepare('DELETE FROM enrolled_credentials WHERE expires<=?').run(now);
      if (this.store.db.prepare('SELECT count(*) n FROM enrolled_credentials').get().n >= ENROLLMENT_LIMIT) throw new ApiError(429,'rate_limited',null,{retry_after:60});
      const credential_id = `enrolled-${randomUUID()}`, adapter_id = `installation-${randomUUID()}`;
      if(existingCredentials.some(c=>c.credential_id===credential_id||c.adapter_id===adapter_id))throw new ApiError(409,'idempotency_conflict');
      const entry = { credential_id, adapter_id, principal_id: grant.principal_id, token_sha256: b.token_sha256,
        client_types: [grant.client_type], scopes: grant.scopes, expires_at: grant.credential_expires_at };
      const result = { credential_id, adapter_id, client_type: grant.client_type, scopes: grant.scopes, expires_at: grant.credential_expires_at, protocol_version:'1' };
      this.store.db.prepare('INSERT INTO enrolled_credentials VALUES(?,?,?,?,?,?,?,?)').run(hash,b.enrollment_id,request,credential_id,b.token_sha256,canonical(entry),canonical(result),Date.parse(entry.expires_at));
      return { status: 201, result };
    });
    log(this.store.logger,outcome.status===201?'info':'debug',outcome.status===201?'PSST_ENROLLMENT_ISSUED':'PSST_ENROLLMENT_REPLAYED',{operation:'authorization',status:outcome.status});
    return outcome;
  }
}
