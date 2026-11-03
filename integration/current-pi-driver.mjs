// Test-only Pi host. The packaged extension, session, SDK and NativeDelivery are real.
// Persisted synthetic custom messages are not evidence that a real model read them.
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {appendFileSync,existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';

export async function createDriver({packageRoot,installation,runtime,nativeId,brokerUrl,approved,admitNative=true}) {
  const load = path => import(pathToFileURL(join(packageRoot,path)));
  const [{installExtension},{createConfigPathStore},{PiBrokerSession}] = await Promise.all([
    load('src/extension.mjs'),load('src/config-path.mjs'),load('src/session.mjs'),
  ]);
  mkdirSync(runtime,{recursive:true,mode:0o700});
  const sessionFile=join(runtime,'pi-session.jsonl');
  if(!existsSync(sessionFile))writeFileSync(sessionFile,JSON.stringify({type:'session',id:nativeId,timestamp:new Date().toISOString()})+'\n',{mode:0o600,flag:'wx'});
  const history=readFileSync(sessionFile,'utf8').trim().split('\n').map(line=>JSON.parse(line));
  if(history[0]?.type!=='session'||history[0].id!==nativeId)throw Error('matrix_native_session_mismatch');
  const append=entry=>{appendFileSync(sessionFile,JSON.stringify(entry)+'\n',{mode:0o600});history.push(entry);};
  const env={PI_CODING_AGENT_DIR:installation,...(brokerUrl?{PSST_BROKER_URL:brokerUrl}:{})};
  const store=createConfigPathStore(undefined,env);
  if(approved) {
    const previous=store.snapshot();
    if(previous.connectionFile!==approved.connectionFile&&store.write(approved.connectionFile,brokerUrl??null,previous.revision)===false)throw Error('matrix_selection_changed');
  }
  const events={},tools={};
  let owner,closed=false,admission=admitNative!==false,activeBranch=null,operations=Promise.resolve();
  const ctx={
    hasUI:false,cwd:runtime,isIdle:()=>!closed&&admission,hasPendingMessages:()=>false,
    sessionManager:{getSessionId:()=>nativeId,getSessionFile:()=>sessionFile,getBranch:()=>activeBranch??history,getSessionName:()=>`Matrix Pi ${nativeId}`},
  };
  const pi={
    on:(name,handler)=>{events[name]=handler;},registerCommand:()=>{},registerTool:definition=>{tools[definition.name]=definition;},
    registerMessageRenderer:()=>{},
    sendMessage(message,options) {
      if(closed||!admission)throw Error('matrix_native_boundary_unavailable');
      if(options?.triggerTurn!==true||options.deliverAs!=='followUp')throw Error('matrix_unexpected_native_delivery');
      append({type:'custom_message',id:randomUUID(),timestamp:new Date().toISOString(),...structuredClone(message)});
    },
  };
  const schema={Object:()=>({}),String:()=>({}),Optional:()=>({}),Integer:()=>({})};
  installExtension(pi,schema,{env,pathStore:store,createSession:options=>{owner=new PiBrokerSession(options);return owner;}});
  if(tools.broker_receive||tools.broker_acknowledge)throw Error('matrix_diagnostic_tools_exposed');
  await events.session_start({},ctx);

  return {
    call(name,args={},operationId=randomUUID()) {
      const operation=operations.then(async()=>{
        if(closed)throw Error('matrix_driver_closed');
        if(!tools[name])throw Error('matrix_native_tool_unavailable');
        const callId=String(operationId);
        let entry=history.find(row=>row.type==='message'&&row.message?.role==='assistant'&&row.message.content?.some(block=>block.type==='toolCall'&&block.id===callId));
        if(!entry) {
          entry={type:'message',id:randomUUID(),timestamp:new Date().toISOString(),message:{role:'assistant',content:[{type:'toolCall',id:callId,name,arguments:structuredClone(args)}]}};
          append(entry);
        }
        // A replay uses the original persisted assistant entry and timestamp.
        // No new operation timestamp/key is invented for an old native call.
        activeBranch=history.slice(0,history.indexOf(entry)+1);
        try{return (await tools[name].execute(callId,args,new AbortController().signal,undefined,ctx)).details;}
        finally{activeBranch=null;}
      });
      operations=operation.catch(()=>{});
      return operation;
    },
    observe(messageId) {
      if(closed)throw Error('matrix_driver_closed');
      const row=owner?.inbox?.db.prepare('SELECT envelope,state,native_receipt FROM inbox WHERE message_id=?').get(messageId);
      if(!row)return null;
      const captures=history.filter(entry=>entry.type==='custom_message'&&entry.customType==='psst-agent-message'&&entry.details?.message_id===messageId);
      const captured=captures[0];
      return {message_id:messageId,envelope:JSON.parse(row.envelope),local_state:row.state,
        native:{kind:'pi-custom-message',observed:!!captured,capture_count:captures.length,...(captured?{body:captured.content,message:structuredClone(captured)}:{}),
          native_acceptance_recorded:typeof row.native_receipt==='string',model_read_recorded:false,
          evidence:'synthetic persisted Pi custom-message boundary, not authenticated CLI/model acceptance'}};
    },
    setAdmission(enabled) {
      if(typeof enabled!=='boolean')throw Error('matrix_invalid_admission');
      // Host idleness only; never switch the production extension to manual mode.
      admission=enabled;
      return {admission};
    },
    async close() {
      if(closed)return;
      closed=true;
      await operations;
      await events.session_shutdown({},ctx);
    },
  };
}
