// Synthetic disposable authority. All network traffic remains local with verified TLS.
import { mkdtempSync,writeFileSync,readFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import https from 'node:https';
import { BrokerStore } from '../src/store.mjs';
import { ApprovalService } from '../src/approval.mjs';
import { AdminUI } from '../src/admin.mjs';
import { CredentialStore } from '../src/auth.mjs';
import { createBrokerServer } from '../src/server.mjs';
const execute=promisify(execFile);
export async function approvalTlsFixture(t, { limits = {} } = {}) {
 const directory=mkdtempSync(join(tmpdir(),'psst-real-approval-tls-'));
 const certFile=join(directory,'ca.pem'),keyFile=join(directory,'key.pem'),credentialFile=join(directory,'credentials.json');
 let store,app;
 t.after(async()=>{try{await app?.close();}finally{try{store?.close();}finally{rmSync(directory,{recursive:true,force:true});}}});
 await execute('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',keyFile,'-out',certFile,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1'],{timeout:10000});
 writeFileSync(credentialFile,'{"credentials":[]}',{mode:0o600});
 store=new BrokerStore({path:join(directory,'broker.sqlite'),limits});
 const approval=await ApprovalService.create({store});
 const auth=new CredentialStore({path:credentialFile,additionalCredentials:()=>approval.credentials(),onRevoke:ids=>store.revoke(ids),onPolicyChange:e=>store.applyAuthorizationPolicies(e)});
 const password='synthetic-fixture-password-only';
 const admin=await AdminUI.create({approval,auth,password});
 app=createBrokerServer({store,auth,approval,admin,host:'127.0.0.1',port:0,tls:{certFile,keyFile},pollIntervalMs:5});
 const address=await app.listen(),brokerUrl=`https://127.0.0.1:${address.port}`;
 const request=(path,{method='GET',headers={},body}={})=>new Promise((resolve,reject)=>{
  const req=https.request(new URL(path,brokerUrl),{method,ca:readFileSync(certFile),headers},res=>{const parts=[];res.on('data',c=>parts.push(c));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text:Buffer.concat(parts).toString()}));res.on('error',reject);});req.on('error',reject);req.end(body);
 });
 const loginPage=await request('/admin'),csrf=/name="csrf" value="([^"]+)"/.exec(loginPage.text)[1];
 const login=await request('/admin/login',{method:'POST',headers:{cookie:loginPage.headers['set-cookie'][0].split(';')[0],origin:brokerUrl,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,password}).toString()});
 if(login.status!==303)throw Error('synthetic_admin_login_failed');
 const cookie=login.headers['set-cookie'][0].split(';')[0];
 async function decide(id,action='approve'){
  const page=await request('/admin',{headers:{cookie}}),csrf=/name="csrf" value="([^"]+)"/.exec(page.text)[1];
  const result=await request(`/admin/requests/${id}/${action}`,{method:'POST',headers:{cookie,origin:brokerUrl,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf}).toString()});
  if(result.status!==303)throw Error('synthetic_admin_decision_failed');
 }
 const env={...process.env,NODE_EXTRA_CA_CERTS:certFile};delete env.NODE_TLS_REJECT_UNAUTHORIZED;
 const runNode=(source,args=[],options={})=>execute(process.execPath,['--input-type=module','-e',source,...args],{env,timeout:15000,maxBuffer:65536,...options});
 async function helper(operation,options){
  const source=`import * as h from ${JSON.stringify(new URL('../reference/approval.mjs',import.meta.url).href)};process.stdout.write(JSON.stringify(await h[process.argv[1]](JSON.parse(process.argv[2]))));`;
  const {stdout}=await runNode(source,[operation,JSON.stringify(options)]);return JSON.parse(stdout);
 }
 return {directory,certFile,brokerUrl,store,auth,approval,admin,app,request,decide,helper,runNode};
}
