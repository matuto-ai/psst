import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, symlinkSync } from 'node:fs';
import { CredentialStore } from '../src/auth.mjs';
import { fixture } from './helpers.mjs';

test('credential files fail closed for broad mode and symlinks',t=>{
 const f=fixture(t),file=`${f.dir}/credentials.json`;
 chmodSync(file,0o644);assert.throws(()=>new CredentialStore({path:file}),/private/);chmodSync(file,0o600);
 const link=`${f.dir}/linked.json`;symlinkSync(file,link);assert.throws(()=>new CredentialStore({path:link}));
});

test('authentication is deny-all for empty or malformed configuration and malformed bearer headers', t => {
 const f=fixture(t);
 assert.equal(f.auth.authenticate(`Bearer ${f.a.token}`).credential_id,f.a.entry.credential_id);
 for(const header of [undefined,'',f.a.token,`Basic ${f.a.token}`,`bearer ${f.a.token}`,`Bearer ${f.a.token} `]) assert.throws(()=>f.auth.authenticate(header),e=>e.status===401);
 f.writeCreds([]);
 assert.throws(()=>f.auth.authenticate(`Bearer ${f.a.token}`),e=>e.status===401);
 assert.equal(f.auth.ready,false);
 f.writeCreds([{...f.a.entry,scopes:[]}]);
 assert.throws(()=>f.auth.authenticate(`Bearer ${f.a.token}`),e=>e.status===503&&e.code==='not_ready');
 assert.equal(f.auth.ready,false);
});

test('revocation and expiry reject previously accepted credentials on the next authentication', t => {
 const f=fixture(t);
 f.writeCreds([{...f.a.entry,expires_at:new Date(f.now+1000).toISOString()}]);
 assert.equal(f.auth.authenticate(`Bearer ${f.a.token}`).credential_id,f.a.entry.credential_id);
 f.advance(1000);
 assert.throws(()=>f.auth.authenticate(`Bearer ${f.a.token}`),e=>e.status===401);
 f.writeCreds([{...f.a.entry,revoked:true}]);
 assert.throws(()=>f.auth.authenticate(`Bearer ${f.a.token}`),e=>e.status===401);
 assert.equal(f.auth.configuredEntries.length,1,'inactive verifiers remain reserved against issuance collisions');
});
