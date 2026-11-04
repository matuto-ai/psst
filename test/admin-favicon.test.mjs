import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.mjs';
import { ApprovalService } from '../src/approval.mjs';
import { AdminUI } from '../src/admin.mjs';
import { document, errorPage } from '../src/admin-pages.mjs';
import { adminFavicon, adminFaviconPath } from '../src/admin-favicon.mjs';
import { adminRequest } from './admin-request.mjs';

test('all shared documents include the same local, font-independent brand favicon',()=>{
 for(const options of [{},{active:'sessions'},{active:'messages'},{active:'approvals'}]){
  const html=document('synthetic content',options);
  assert.ok(html.includes(`<link rel="icon" type="image/svg+xml" sizes="any" href="${adminFaviconPath}">`));
 }
 assert.ok(document(errorPage(404,'/admin')).includes(adminFaviconPath));
 assert.match(adminFavicon,/viewBox="0 0 32 32"/);
 assert.match(adminFavicon,/#176d59/);
 assert.doesNotMatch(adminFavicon,/<(?:script|text|foreignObject|image)|href=|onload=|url\(/i);
 assert.ok(Buffer.byteLength(adminFavicon)<1024);
});
test('favicon serves GET and HEAD before login without creating sessions or reading credentials',async t=>{
 const f=fixture(t),approval=await ApprovalService.create({store:f.store});
 const admin=await AdminUI.create({approval,auth:f.auth,password:'synthetic-favicon-password',insecureDevelopment:true});
 admin.session=()=>{throw Error('static icon must not inspect session');};
 admin.auth.reload=()=>{throw Error('static icon must not inspect credentials');};
 for(const method of ['GET','HEAD']){
  const response=await adminRequest(admin,adminFaviconPath,{method});
  assert.equal(response.status,200);assert.equal(response.html,method==='GET'?adminFavicon:'');
  assert.equal(response.headers.get('content-type'),'image/svg+xml; charset=utf-8');
  assert.equal(response.headers.get('x-content-type-options'),'nosniff');
  assert.equal(response.headers.get('content-security-policy'),"default-src 'none'; sandbox");
  assert.equal(response.headers.get('cache-control'),'public, max-age=86400');
  assert.equal(response.headers.get('set-cookie'),null);
 }
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM admin_sessions').get().n,0);
 for(const method of ['POST','PUT','DELETE']){
  const response=await adminRequest(admin,adminFaviconPath,{method});
  assert.equal(response.status,405);assert.equal(response.html,'');
  assert.equal(response.headers.get('allow'),'GET, HEAD');
  assert.equal(response.headers.get('cache-control'),'no-store');
 }
});
test('login links favicon under same-origin image CSP while protected content remains private',async t=>{
 const f=fixture(t),approval=await ApprovalService.create({store:f.store});
 const admin=await AdminUI.create({approval,auth:f.auth,password:'synthetic-favicon-password',insecureDevelopment:true});
 const response=await adminRequest(admin,'/admin/sessions');
 assert.equal(response.status,200);assert.match(response.html,/Administrator login/);
 assert.ok(response.html.includes(adminFaviconPath));
 assert.equal(response.headers.get('cache-control'),'no-store');
 const csp=response.headers.get('content-security-policy');
 assert.match(csp,/default-src 'none'; img-src 'self';/);
 assert.match(csp,/script-src 'sha256-/);assert.match(csp,/frame-ancestors 'none'/);
 assert.doesNotMatch(csp,/img-src[^;]*(?:\*|data:|https:)/);
 assert.equal((await adminRequest(admin,'/admin/favicon.svg.extra')).status,404);
});
