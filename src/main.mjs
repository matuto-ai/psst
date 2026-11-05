import { readFileSync } from 'node:fs';
import { Logger, log } from './logger.mjs';
import { SettingsService, settingsOptionsFromConfiguration } from './settings.mjs';
import { BrokerStore } from './store.mjs';
import { ApprovalService, approvalOptionsFromEnvironment } from './approval.mjs';
import { AdminUI } from './admin.mjs';
import { EnrollmentService } from './enrollment.mjs';
import { CredentialStore } from './auth.mjs';
import { createBrokerServer } from './server.mjs';

process.umask(0o077);
const logger=new Logger({version:JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version});
const configFile=process.env.BROKER_CONFIG_FILE;
let store,app,phase='configuration';
try{
  if(!configFile){const error=new Error();error.code='missing_configuration';throw error;}
  const config=JSON.parse(readFileSync(configFile,'utf8'));
  const allowed=['database','credential_file','host','port','insecure_development','proxy_loopback','proxy_transport','tls','limits','enrollment_policy_file','require_registration_v2','settings'];
  if(Object.keys(config).some(k=>!allowed.includes(k)))throw new Error('Unknown broker configuration field.');
  if(typeof config.database!=='string'||typeof config.credential_file!=='string')throw new Error('Database and credential_file are required.');
  const password=process.env.PSST_ADMIN_PASSWORD;
  if(password!==undefined&&password!==''&&(password.length<16||password.length>1024))throw new Error('Invalid administrator password configuration.');
  const approvalOptions=approvalOptionsFromEnvironment(process.env);
  const {config:settingsConfig,overrides,limits}=settingsOptionsFromConfiguration(config,process.env);
  logger.setLevel(overrides.log_level?.value??'info');
  phase='startup';
  store=await BrokerStore.open({path:config.database,limits,requireRegistrationV2:config.require_registration_v2,logger});
  const settings=new SettingsService({store,env:process.env,config:settingsConfig,onChange:values=>logger.setLevel(values.log_level)});
  logger.setLevel(settings.get('log_level'));
  const enrollment=config.enrollment_policy_file===undefined?undefined:new EnrollmentService({store,policyFile:config.enrollment_policy_file});
  const approval=password?await ApprovalService.create({store,...approvalOptions,settings}):undefined;
  const auth=new CredentialStore({path:config.credential_file,logger,additionalCredentials:()=>[...(enrollment?.credentials()??[]),...(approval?.credentials()??[])],onRevoke:ids=>store.revoke(ids),onPolicyChange:entries=>store.applyAuthorizationPolicies(entries)});
  const reservations=()=>[...(enrollment?.reservations()??[]),...(approval?.reservations()??[])];
  const admin=approval?await AdminUI.create({approval,auth,password,settings,reservations,publicOrigin:process.env.PSST_PUBLIC_ORIGIN||undefined,insecureDevelopment:config.insecure_development??false}):undefined;
  app=createBrokerServer({store,auth,logger,enrollment,approval,admin,reservations,host:config.host,port:config.port,insecureDevelopment:config.insecure_development,proxyLoopback:config.proxy_loopback,proxyTransport:config.proxy_transport,tls:config.tls,maxPolls:store.limits.max_polls,requestRate:store.limits.request_per_minute});
  if(config.proxy_transport)log(logger,'warning','PSST_PROXY_TRANSPORT_ENABLED');
  await app.listen();log(logger,'info','PSST_BROKER_STARTED',{ready:auth.ready,reason:auth.ready?'ready':'no_credentials'});
  let closing=false;const stop=async()=>{if(closing)return;closing=true;await app.close();store.close();};
  const shutdown=()=>stop().catch(error=>{log(logger,'error','PSST_SHUTDOWN_FAILED',{phase:'shutdown'},error);process.exitCode=1;});
  process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
}catch(error){log(logger,'error','PSST_STARTUP_FAILED',{phase},error);try{await app?.close();store?.close();}catch(cleanup){log(logger,'error','PSST_STARTUP_CLEANUP_FAILED',{phase:'shutdown'},cleanup);}process.exitCode=1;}
