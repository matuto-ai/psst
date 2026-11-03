// Test-only native Claude host: real packaged hooks, MCP and monitor subprocesses.
// The model response to a real monitor notice is synthetic. Stdout, tool output and
// synthetic read ACK never certify that an authenticated Claude model read/acted.
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {appendFileSync,existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {DatabaseSync} from 'node:sqlite';

export async function createDriver({packageRoot,installation,runtime,nativeId,brokerUrl,approved,admitNative=true}) {
  const load=path=>import(pathToFileURL(join(packageRoot,path)));
  const [{installationRoot,saveSelection,selectedConfig},{processIdentity,readPrivateJson},{nativeStateConfig,journalName},{resolveNativeBinding}]=await Promise.all([
    load('src/installation-selection.mjs'),load('src/launch-state.mjs'),load('src/plugin-state.mjs'),load('src/native-binding.mjs'),
  ]);
  mkdirSync(runtime,{recursive:true,mode:0o700});
  const env={...process.env,CLAUDE_CONFIG_DIR:installation,PSST_CLAUDE_CONFIG:'',PSST_CONFIG_FILE:'',PSST_CLAUDE_NATIVE_STATE_ROOT:'',
    PSST_PLUGIN_BROKER_URL:brokerUrl??'',PSST_BROKER_URL:brokerUrl??'',CLAUDE_PID:String(process.pid),CLAUDE_CODE_SESSION_ID:nativeId};
  const root=installationRoot(env);
  if(approved&&!saveSelection(approved.connectionFile,null,root).saved)throw Error('matrix_selection_changed');
  const transcriptFile=join(runtime,'claude-transcript.jsonl');
  if(!existsSync(transcriptFile))writeFileSync(transcriptFile,JSON.stringify({type:'session',sessionId:nativeId})+'\n',{mode:0o600,flag:'wx'});
  const transcript=readFileSync(transcriptFile,'utf8').trim().split('\n').map(line=>JSON.parse(line));
  if(transcript[0]?.sessionId!==nativeId)throw Error('matrix_native_session_mismatch');
  const append=row=>{appendFileSync(transcriptFile,JSON.stringify(row)+'\n',{mode:0o600});transcript.push(row);};
  const captures=new Map(),acknowledgments=new Map();
  for(const row of transcript) {
    if(row.type==='matrix_native_receive')captures.set(row.value.message_id,row);
    if(row.type==='matrix_native_acknowledge')acknowledgments.set(row.value.message_id,row.value);
  }
  let closed=false,stopping=false,admission=admitNative!==false,mcp,monitor,operations=Promise.resolve(),pendingNotice=null,nativeRead=null,lastError=null;
  const host=processIdentity(process.pid);
  const nativeConfig=nativeStateConfig(env,host,nativeId);
  const resolve=()=>resolveNativeBinding({nativeConfig,legacyConfig:selectedConfig(root),host,sessionId:nativeId});

  async function hook(event) {
    return new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,[join(packageRoot,'bin/plugin-hook.mjs')],{env,cwd:runtime,stdio:['pipe','pipe','pipe']});
      let stdout='',stderr='';
      const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('matrix_native_hook_timeout'));},10000);
      child.stdout.on('data',chunk=>{stdout+=chunk;});
      child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-4096);});
      child.on('error',error=>{clearTimeout(timer);reject(error);});
      child.on('close',code=>{
        clearTimeout(timer);
        if(code!==0){const error=Error(`matrix_native_hook_failed (${code}): ${stderr.trim()}`);error.code='native_call_provenance_unavailable';reject(error);return;}
        try{resolve(stdout.trim()?JSON.parse(stdout):null);}catch{reject(Error('matrix_native_hook_invalid_output'));}
      });
      child.stdin.on('error',()=>{});
      child.stdin.end(JSON.stringify({...event,session_id:nativeId,transcript_path:transcriptFile}));
    });
  }

  function createMcp() {
    const child=spawn(process.execPath,[join(packageRoot,'bin/plugin-mcp.mjs')],{env,cwd:runtime,stdio:['pipe','pipe','pipe']});
    let next=0,stderr='';const pending=new Map();
    const ended=new Promise(resolve=>child.once('close',resolve));
    const rejectPending=error=>{for(const {reject,timer} of pending.values()){clearTimeout(timer);reject(error);}pending.clear();};
    child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-8192);});
    child.on('error',rejectPending);
    child.stdin.on('error',rejectPending);
    child.on('close',code=>rejectPending(Error(`matrix_mcp_closed (${code}): ${stderr.trim()}`)));
    createInterface({input:child.stdout}).on('line',line=>{
      let response;try{response=JSON.parse(line);}catch{rejectPending(Error('matrix_mcp_invalid_frame'));child.kill('SIGKILL');return;}
      const waiter=pending.get(response.id);if(!waiter)return;
      pending.delete(response.id);clearTimeout(waiter.timer);waiter.resolve(response);
    });
    const rpc=(method,params)=>new Promise((resolve,reject)=>{
      if(child.exitCode!==null||child.signalCode||child.stdin.destroyed){reject(Error('matrix_mcp_closed'));return;}
      const id=++next,timer=setTimeout(()=>{pending.delete(id);reject(Error('matrix_mcp_timeout_outcome_unknown'));},15000);
      pending.set(id,{resolve,reject,timer});
      child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
    });
    return {child,rpc,ended,get stderr(){return stderr;}};
  }

  function nativeTool(name,args={},operationId=randomUUID()) {
    const operation=operations.then(async()=>{
      if(closed||stopping)throw Error('matrix_driver_closed');
      const toolUseId=String(operationId);
      let entry=transcript.find(row=>row.type==='assistant'&&row.message?.content?.some(block=>block.type==='tool_use'&&block.id===toolUseId));
      if(!entry) {
        entry={type:'assistant',uuid:randomUUID(),sessionId:nativeId,timestamp:new Date().toISOString(),message:{role:'assistant',content:[{type:'tool_use',id:toolUseId,name:'mcp__plugin_psst_psst__'+name,input:structuredClone(args)}]}};
        append(entry);
      }
      // Actual PreToolUse enforces native owner/lifetime and one-use identity.
      // Replays never mint a different permit or silently retry an ambiguous call.
      const issued=await hook({hook_event_name:'PreToolUse',tool_use_id:toolUseId,tool_name:'mcp__plugin_psst_psst__'+name,tool_input:args});
      const output=issued?.hookSpecificOutput;
      if(output?.permissionDecision||!output?.updatedInput)throw Error('matrix_native_tool_denied');
      const response=await mcp.rpc('tools/call',{name,arguments:output.updatedInput});
      if(response.error){const error=Error(response.error.message);error.code=response.error.code;throw error;}
      const value=response.result.structuredContent??JSON.parse(response.result.content[0].text);
      append({type:'user',uuid:randomUUID(),sessionId:nativeId,timestamp:new Date().toISOString(),message:{role:'user',content:[{type:'tool_result',tool_use_id:toolUseId,content:response.result.content}]}});
      return {value,response:response.result};
    });
    operations=operation.catch(()=>{});
    return operation;
  }

  function respondToNotice() {
    if(closed||stopping||!admission||!pendingNotice||nativeRead)return;
    const notice=pendingNotice;pendingNotice=null;
    // Simulate a native model response only after real monitor output. observe()
    // never calls receive and no diagnostic polling loop substitutes for notices.
    nativeRead=nativeTool('broker_receive').then(({value,response})=>{
      if(value.error)throw Error(`matrix_native_receive_${value.error.code}`);
      if(!value.message_id)return;
      const capture={type:'matrix_native_receive',timestamp:new Date().toISOString(),value,response,notice};
      append(capture);captures.set(value.message_id,capture);
    }).catch(error=>{lastError=error.code??error.message;}).finally(()=>{nativeRead=null;});
  }

  function startMonitor() {
    const child=spawn(process.execPath,[join(packageRoot,'bin/plugin-monitor.mjs')],{env,cwd:runtime,stdio:['ignore','pipe','pipe']});
    let stderr='';const ended=new Promise(resolve=>child.once('close',resolve));
    child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-4096);});
    child.on('error',error=>{lastError=error.code??error.message;});
    createInterface({input:child.stdout}).on('line',line=>{
      if(!line.startsWith('Psst: authorized collaboration mailbox has pending AGENT data.'))return;
      pendingNotice={text:line,observed_at:new Date().toISOString(),boundary:'actual plugin-monitor stdout; synthetic host, not model acceptance'};
      respondToNotice();
    });
    return {child,ended,get stderr(){return stderr;}};
  }

  async function startChildren() {
    mcp=createMcp();
    const initialized=await mcp.rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'synthetic-current-matrix-host',version:'1'}});
    if(initialized.error)throw Error('matrix_mcp_initialize_failed');
    mcp.child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
    monitor=startMonitor();
  }
  async function stopChildren() {
    stopping=true;
    if(monitor&&monitor.child.exitCode===null&&!monitor.child.signalCode){monitor.child.kill('SIGTERM');await monitor.ended;}
    await operations;
    await nativeRead;
    if(mcp&&mcp.child.exitCode===null&&!mcp.child.signalCode) {
      mcp.child.stdin.end();
      const timer=setTimeout(()=>mcp.child.kill('SIGKILL'),10000);
      try{await mcp.ended;}finally{clearTimeout(timer);}
    }
    pendingNotice=null;
  }
  await hook({hook_event_name:'SessionStart',source:'startup'});
  try{await startChildren();}catch(error){await stopChildren();await hook({hook_event_name:'SessionEnd'});throw error;}

  return {
    async call(name,args={},operationId) {
      if(name==='broker_receive')throw Error('matrix_receive_requires_automatic_monitor_notice');
      if(name==='broker_acknowledge'&&!captures.has(args.message_id))throw Error('matrix_native_read_not_observed');
      return (await nativeTool(name,args,operationId)).value;
    },
    observe(messageId) {
      if(closed)throw Error('matrix_driver_closed');
      const binding=resolve();if(!binding)return null;
      let db;
      try {
        const activation=readPrivateJson(join(binding.directory,'activation.json'));
        if(!activation.config)return null;
        let journal=join(binding.directory,journalName(binding.binding.lifetime,activation.config));
        try{const pointer=readPrivateJson(join(journal,'incarnation.json'));if(!/^generation-[0-9a-f-]{36}$/.test(pointer.name))throw Error('matrix_invalid_incarnation');journal=join(journal,pointer.name);}catch(error){if(error.code!=='ENOENT')throw error;}
        db=new DatabaseSync(join(journal,'inbox.sqlite'),{readOnly:true});
        const row=db.prepare('SELECT envelope,state,native_receipt FROM inbox WHERE message_id=?').get(messageId);
        if(!row)return null;
        const capture=captures.get(messageId);
        return {message_id:messageId,envelope:JSON.parse(row.envelope),local_state:row.state,
          native:{kind:'claude-monitor-native-tools',observed:!!capture,
            capture_count:transcript.filter(entry=>entry.type==='matrix_native_receive'&&entry.value.message_id===messageId).length,
            ...(capture?{body:capture.response.content.map(block=>block.text??'').join('\n'),message:capture.value.message,notice:capture.notice.text,structuredContent:capture.value}:{}),
            native_acceptance_recorded:typeof row.native_receipt==='string',model_read_recorded:false,
            synthetic_model_read_acknowledged:acknowledgments.get(messageId)?.acknowledged===true,
            evidence:'actual monitor and MCP output with synthetic native-model response; stdout is not model acceptance',
            ...(lastError?{error:lastError}:{})}};
      }catch(error){if(error.code==='ENOENT')return null;throw error;}finally{db?.close();}
    },
    async acknowledge(messageId) {
      if(!captures.has(messageId))throw Error('matrix_native_read_not_observed');
      const {value}=await nativeTool('broker_acknowledge',{message_id:messageId});
      append({type:'matrix_native_acknowledge',value});acknowledgments.set(messageId,value);
      return value;
    },
    setAdmission(enabled) {
      if(typeof enabled!=='boolean')throw Error('matrix_invalid_admission');
      // Hold only the synthetic native model before a receive invocation. A
      // monitor notice and durable broker receipt remain independent evidence.
      admission=enabled;if(enabled)respondToNotice();return {admission};
    },
    async restart() {
      if(closed)throw Error('matrix_driver_closed');
      // The native host and its verified binding survive an MCP/monitor reload.
      // A fresh owner process is a new lifetime, even with the same session ID.
      await stopChildren();stopping=false;await startChildren();return {restarted:true};
    },
    async close() {
      if(closed)return;
      await stopChildren();closed=true;await hook({hook_event_name:'SessionEnd'});
    },
  };
}
