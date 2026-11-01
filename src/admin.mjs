import { createHash, randomBytes, timingSafeEqual, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
import { ApiError } from './protocol.mjs';
import { AdminData } from './admin-data.mjs';
import { document, loginPage, sessionsPage, messagesPage, messagePage, approvalsPage, errorPage } from './admin-pages.mjs';
const scrypt=promisify(scryptCallback),hash=s=>createHash('sha256').update(s).digest('hex');
const token=()=>randomBytes(32).toString('base64url');
export class AdminUI {
  static async create(options){
    const password=options.password;
    if(typeof password!=='string'||password.length<16||password.length>1024)throw Error('admin_password_minimum_16_characters');
    const salt=randomBytes(16),verifier=await scrypt(password,salt,32);
    return new AdminUI({...options,password:undefined,salt,verifier});
  }
  constructor({approval,auth,salt,verifier,reservations=()=>[],publicOrigin,insecureDevelopment=false,sessionMs=28800000}){
    Object.assign(this,{approval,auth,salt,verifier,reservations,insecureDevelopment,sessionMs});
    if(publicOrigin){const u=new URL(publicOrigin);if(u.origin!==publicOrigin||u.username||u.password||u.protocol!==(insecureDevelopment?'http:':'https:'))throw Error('invalid_public_origin');this.publicOrigin=u.origin;}
    this.boot=token();this.loginAttempts=new Map();this.activeLogins=0;
    approval.store.db.exec('DELETE FROM admin_sessions'); // restart requires a fresh login
    this.data=new AdminData(this.store);
  }
  get store(){return this.approval.store;}
  origin(req){
    if(this.publicOrigin)return this.publicOrigin;
    const host=req.headers.host;
    if(typeof host!=='string'||!host||/[\s/@\\]/.test(host))throw new ApiError(400,'invalid_request');
    const u=new URL(`${this.insecureDevelopment?'http':'https'}://${host}`);
    if(u.host!==host)throw new ApiError(400,'invalid_request');return u.origin;
  }
  session(req){
    const values=(req.headers.cookie??'').split(';').map(s=>s.trim()).filter(s=>s.startsWith('psst_admin='));
    if(values.length!==1)return null;
    const value=values[0].slice('psst_admin='.length);if(!/^[A-Za-z0-9_-]{43}$/.test(value))return null;
    const row=this.store.db.prepare('SELECT * FROM admin_sessions WHERE hash=? AND expires>? AND password_hash=?').get(hash(value),this.store.clock(),this.boot);
    return row?{...row,cookie:value}:null;
  }
  issue(authenticated){
    return this.store.tx(()=>{
      this.store.db.prepare('DELETE FROM admin_sessions WHERE expires<=? OR password_hash<>?').run(this.store.clock(),this.boot);
      if(this.store.db.prepare('SELECT count(*) n FROM admin_sessions').get().n>=1000)throw new ApiError(429,'rate_limited');
      const cookie=token(),csrf=token(),expires=this.store.clock()+(authenticated?this.sessionMs:600000);
      this.store.db.prepare('INSERT INTO admin_sessions VALUES(?,?,?,?,?)').run(hash(cookie),csrf,authenticated?1:0,expires,this.boot);
      return {cookie,csrf,authenticated,expires,hash:hash(cookie)};
    });
  }
  cookie(session){return `psst_admin=${session?.cookie??''}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${session?Math.max(0,Math.floor((session.expires-this.store.clock())/1000)):0}${this.insecureDevelopment?'':'; Secure'}`;}
  headers(){return {'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",'Referrer-Policy':'same-origin'};}
  html(res,status,content,session,options={}){
    res.writeHead(status,{...this.headers(),...(session?{'Set-Cookie':this.cookie(session)}:{})});
    res.end(document(content,{...options,csrf:session?.csrf}));
  }
  async input(req){
    if(req.headers['content-encoding']||!/^application\/x-www-form-urlencoded(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type']??''))throw new ApiError(400,'invalid_request');
    if(Number(req.headers['content-length'])>4096)throw new ApiError(413,'payload_too_large');
    const chunks=[];let size=0;const timer=setTimeout(()=>req.destroy(),10000);timer.unref();
    try{for await(const chunk of req){size+=chunk.length;if(size>4096)throw new ApiError(413,'payload_too_large');chunks.push(chunk);}}finally{clearTimeout(timer);}
    const p=new URLSearchParams(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))),result={};
    for(const[k,v]of p){if(Object.hasOwn(result,k))throw new ApiError(400,'invalid_request');result[k]=v;}return result;
  }
  loginRate(req){
    const now=this.store.clock(),key=req.socket.remoteAddress??'unknown';
    for(const[k,v]of this.loginAttempts)if(now-v.at>=60000)this.loginAttempts.delete(k);
    if(!this.loginAttempts.has(key)&&this.loginAttempts.size>=1000)throw new ApiError(429,'rate_limited',null,{retry_after:60});
    const value=this.loginAttempts.get(key)??{at:now,count:0};value.count++;this.loginAttempts.set(key,value);
    if(value.count>5||this.loginAttempts.size>1000||this.activeLogins>=2)throw new ApiError(429,'rate_limited',null,{retry_after:60});
  }
  redirect(res,session){res.writeHead(303,{...this.headers(),Location:'/admin','Set-Cookie':this.cookie(session)});res.end();}
  async handle(req,res,url){
    if(!url.pathname.startsWith('/admin'))return false;
    const session=this.session(req);
    if(req.method==='GET'){
      const path=url.pathname,known=path==='/admin'||path==='/admin/approvals'||path==='/admin/sessions'||path==='/admin/messages'||/^\/admin\/messages\/[^/]+$/.test(path);
      if(!known)throw new ApiError(404,'invalid_request');
      if(!session?.authenticated){const fresh=session??this.issue(false);this.html(res,200,loginPage(fresh.csrf),fresh);return true;}
      const active=path.startsWith('/admin/messages')?'messages':path==='/admin/sessions'?'sessions':'approvals';
      try{
        let content;
        if(active==='sessions')content=sessionsPage(this.data.sessions(url.searchParams));
        else if(path==='/admin/messages')content=messagesPage(this.data.messages(url.searchParams));
        else if(active==='messages'){
          if(url.search)throw new ApiError(400,'invalid_request');
          content=messagePage(this.data.message(path.split('/').at(-1)));
        }else{
          let page=0;
          if(url.search){
            if([...url.searchParams.keys()].some(k=>k!=='page')||url.searchParams.getAll('page').length!==1||!/^(0|[1-9][0-9]?)$/.test(url.searchParams.get('page')))throw new ApiError(400,'invalid_request');
            page=Number(url.searchParams.get('page'));
          }
          content=approvalsPage(this.approval.list({offset:page*100,limit:100}),page,session,path);
        }
        this.html(res,200,content,session,{active,title:`Psst · ${active==='sessions'?'Clients & sessions':active==='messages'?'Messages':'Approvals'}`});
      }catch(error){
        if(!(error instanceof ApiError)||![400,404,503].includes(error.status))throw error;
        this.html(res,error.status,errorPage(error.status,`/admin/${active}`),session,{active,title:'Psst · Request unavailable'});
      }
      return true;
    }
    if(url.search)throw new ApiError(400,'invalid_request');
    if(req.method!=='POST')throw new ApiError(404,'invalid_request');
    // Origin and session are checked before accepting a password/form upload.
    if(req.headers.origin!==this.origin(req)||!session)throw new ApiError(403,'forbidden');
    if(url.pathname==='/admin/login')this.loginRate(req);
    else if(!session.authenticated)throw new ApiError(401,'unauthenticated');
    const input=await this.input(req);
    if(!this.session(req))throw new ApiError(401,'unauthenticated');
    if(typeof input.csrf!=='string'||input.csrf!==session.csrf)throw new ApiError(403,'forbidden');
    if(url.pathname==='/admin/login'){
      if(Object.keys(input).some(k=>!['csrf','password'].includes(k))||typeof input.password!=='string'||input.password.length>1024)throw new ApiError(400,'invalid_request');
      if(this.activeLogins>=2)throw new ApiError(429,'rate_limited',null,{retry_after:60});
      this.activeLogins++;let valid;
      try{valid=timingSafeEqual(await scrypt(input.password,this.salt,32),this.verifier);}finally{this.activeLogins--;}
      if(!this.session(req))throw new ApiError(401,'unauthenticated');
      if(!valid){this.html(res,401,loginPage(session.csrf,true),session);return true;}
      this.store.tx(()=>this.store.db.prepare('DELETE FROM admin_sessions WHERE hash=?').run(session.hash));
      this.redirect(res,this.issue(true));return true;
    }
    if(Object.keys(input).some(k=>k!=='csrf'))throw new ApiError(400,'invalid_request');
    if(url.pathname==='/admin/logout'){
      this.store.tx(()=>this.store.db.prepare('DELETE FROM admin_sessions WHERE hash=?').run(session.hash));this.redirect(res,null);return true;
    }
    const action=/^\/admin\/requests\/([^/]+)\/(approve|deny|revoke)$/.exec(url.pathname);
    if(!action)throw new ApiError(404,'invalid_request');
    this.auth.reload();this.approval.decide(action[1],action[2],[...this.auth.configuredEntries,...this.reservations()]);this.auth.reload();
    this.redirect(res,session);return true;
  }
}
