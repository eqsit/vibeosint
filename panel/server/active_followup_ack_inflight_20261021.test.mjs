// Independent final review regressions: real public handlers + native AcpClient.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { AcpClient } from './acp_client.mjs';

// No Hermes process, network, production data or user sessions. Only the native
// RPC boundary is controlled; the handler, run lifecycle and disk locks are real.
const source = fs.readFileSync(new URL('./index.mjs', import.meta.url), 'utf8');
const sid = 'ses_followup_race_fixture';
function extract(name) {
  const match = source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`));
  assert.ok(match, `missing function ${name}`);
  return match[0];
}
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
async function until(predicate, message) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(message);
}
function response() {
  return {code:200, result:null, status(code) {this.code=code;return this;}, json(value) {this.result=value;return this;}};
}
function fixture(t) {
  const dir = fs.mkdtempSync('/root/.hermes/cache/scratch/followup-race-');
  const file = path.join(dir, `${sid}.json`);
  const base = {id:sid, title:'Synthetic fixture', messages:[], report:'# Synthetic dossier',
    reportState:{sections:[{id:'fixture', rows:[['saved fact']]}]}, logs:[]};
  fs.writeFileSync(file, JSON.stringify(base));
  const main = [], steers = [], builds = [], errors = [], clients = [];
  const activeRuns = new Map(), acpSessions = new Map();
  let steerFailure = null, steerAckFailure = null, steerGate = null, ackOverride = null;
  function makeRec() {
    const client = new AcpClient({hermesBin:'/never-executed', cwd:dir, env:{}});
    client.isAlive = () => !client.closed;
    client.dispose = () => {client.closed=true;};
    client._request = async (method, params) => {
      assert.equal(method, 'session/prompt');
      const text = params.prompt[0].text;
      if (text.startsWith('/steer ')) {
        steers.push({text, active:client.current !== null, run:activeRuns.get(sid), client});
        if (steerFailure) throw new Error(steerFailure);
        client._onLine(JSON.stringify({method:'session/update',params:{update:{sessionUpdate:'agent_message_chunk',
          content:{type:'text',text:ackOverride || (steerAckFailure ? `⚠️ Steer failed: ${steerAckFailure}` : '⏩ Steer queued for the active turn: synthetic')}}}}));
        if (steerGate) {const gate=steerGate;steerGate=null;await gate.promise;}
        return {stopReason:'end_turn'};
      }
      const done = deferred();
      main.push({text, done, run:activeRuns.get(sid), client});
      return done.promise;
    };
    const rec = {client, hasNativeContext:false, mainStarted:false};
    clients.push(rec);
    return rec;
  }
  const context = vm.createContext({fs,path,crypto,process,Buffer,setTimeout,clearTimeout,setInterval,clearInterval,
    console:{...console,error:(...args) => errors.push(args.join(' ')),warn:(...args) => errors.push(args.join(' '))},
    DATA_DIR:dir,UPLOADS_DIR:path.join(dir,'uploads'),activeRuns,acpSessions,
    ACP_ENABLED:true,HERMES_TIMEOUT_MS:10000,requireAuth() {},panelModel() {},
    selectedSession:s => s,globalSelection:() => ({}),cleanConciseTitle:() => 'Synthetic fixture',
    isValidSessionId:id => /^ses_[A-Za-z0-9_-]{1,80}$/.test(id),
    getAcpClient:async () => {
      let rec=acpSessions.get(sid);
      if (!rec || !rec.client.isAlive()) {rec=makeRec();acpSessions.set(sid,rec);}
      return rec;
    },
    buildHermesPrompt:options => {builds.push(options);return JSON.stringify({text:options.text,attachments:options.attachments});}});
  for (const name of ['getSessionPath','withSessionLock','readSession','writeAtomic','mutateSession','saveUploads',
    'sanitizeAgentReply','looksLikeAgentError','looksLikeDossier','finalizeRun','runHermesInvestigation']) {
    vm.runInContext(extract(name),context);
  }
  // Include bounded follow-up helpers when the implementation introduces them.
  const helpers=source.slice(source.indexOf('// Follow-up delivery helpers'),source.indexOf('// Chat endpoint'));
  if (helpers) vm.runInContext(helpers,context);
  let chat;
  context.app={post(_route,_auth,fn) {chat=fn;}};
  vm.runInContext(source.slice(source.indexOf('app.post("/api/sessions/:id/chat"'),source.indexOf('// Reset chat transcript ONLY')),context);
  let lockAttempts=0;
  const withLock=context.withSessionLock;
  context.withSessionLock=(...args) => {lockAttempts++;return withLock(...args);};
  const read=() => JSON.parse(fs.readFileSync(file,'utf8'));
  async function send(text, images) {
    const res=response();
    await chat({params:{id:sid},body:{text,...(images ? {images} : {})}},res);
    return res;
  }
  async function start() {
    const res=await send('Synthetic initial question');
    assert.equal(res.code,200);
    await until(() => main.length===1,'initial native prompt must start');
    return main[0];
  }
  function hold() {
    const lock=path.join(dir,'.locks',`${sid}.lock`);
    fs.mkdirSync(lock,{recursive:true});
    const before=lockAttempts;
    return {waiting:() => lockAttempts>before,release:() => {if(fs.existsSync(lock)) fs.rmdirSync(lock);}};
  }
  t.after(async () => {
    // Drain only synthetic prompts and real finalize writes before removing data.
    for (let i=0;i<20;i++) {
      for (const entry of main) entry.done.resolve({stopReason:'end_turn'});
      if (!activeRuns.size) break;
      await new Promise(resolve => setTimeout(resolve,10));
    }
    fs.rmSync(dir,{recursive:true,force:true});
  });
  return {context,dir,file,base,main,steers,builds,errors,clients,activeRuns,acpSessions,read,start,send,hold,
    failSteer:message => {steerFailure=message;}, failAck:message => {steerAckFailure=message;},
    holdNextSteer:() => {steerGate=deferred();return steerGate;}, setAck:text => {ackOverride=text;}};
}



function stopEndpoint(f) {
  vm.runInContext(extract('stopRunAcp'),f.context);
  let stop;
  f.context.app={post(_route,_auth,fn){stop=fn;}};
  vm.runInContext(source.slice(source.indexOf('app.post("/api/sessions/:id/stop"'),source.indexOf('// Backend health')),f.context);
  return async () => {const res=response();await stop({params:{id:sid}},res);return res;};
}

test('public stop cancels follow-up still waiting behind another ACK owner',async t => {
  const f=fixture(t);
  const initial=await f.start();
  const stop=stopEndpoint(f);
  const gate=f.holdNextSteer();
  t.after(()=>gate.resolve());
  initial.client.cancel=()=>{initial.done.resolve({stopReason:'cancelled'});return true;};
  const first=f.send('first synthetic guidance');
  await until(()=>f.steers.length===1,'first delivery should own ACK channel');
  const tail=initial.client.followupTail;
  const second=f.send('must not deliver after stop');
  await until(()=>initial.client.followupTail!==tail,'second delivery should be serialized');
  const stopped=await stop();
  assert.equal(stopped.result.stopped,true);
  await until(()=>!f.activeRuns.size,'cancelled native run must finalize');
  gate.resolve();
  const [a,b]=await Promise.all([first,second]);
  assert.equal(a.code,200,'first guidance was positively acknowledged before stop');
  assert.equal(b.code,500,'queued guidance must fail honestly when stopped before send');
  assert.equal(f.steers.length,1);
  assert.equal(f.main.length,1);
});

test('native idle-steer fallback must not silently lose its completed assistant reply',async t => {
  const f=fixture(t);
  const initial=await f.start();
  const gate=deferred();
  let inFlight=false;
  const nativeRequest=initial.client._request;
  initial.client._request=async(method,params)=>{
    if(params.prompt[0].text.startsWith('/steer ')) {
      inFlight=true;
      return gate.promise;
    }
    return nativeRequest(method,params);
  };
  const pending=f.send('synthetic correction across native completion boundary');
  await until(()=>inFlight,'follow-up must pass the local active check');
  initial.done.resolve({stopReason:'end_turn'});
  await until(()=>!f.activeRuns.size,'original main prompt must fully finalize');
  // Native idle /steer runs as a prompt rather than emitting a steer ACK. Its
  // update is received after the original RPC response cleared client.current.
  initial.client._onLine(JSON.stringify({method:'session/update',params:{update:{
    sessionUpdate:'agent_message_chunk',content:{type:'text',text:'SYNTHETIC_FOLLOWUP_ASSISTANT_RESULT'}}}}));
  gate.resolve({stopReason:'end_turn'});
  const result=await pending;
  const saved=f.read();
  console.log('IDLE_STEER_RECEIPT',JSON.stringify({httpStatus:result.code,response:result.result,
    savedMessages:saved.messages,trackedRuns:f.activeRuns.size}));
  assert.equal(result.code,500,'idle fallback without an active-turn ACK must fail closed');
  assert.notEqual(result.result.success,true);
  assert.ok(saved.messages.some(message=>message.role==='assistant' && /уточнен/.test(message.text)),
    'the delivery error must be persisted, not replaced with silent success');
  assert.ok(saved.logs.some(log=>log.type==='error' && /уточнен/.test(log.text)));
  assert.equal(saved.report,f.base.report);
  assert.equal(f.main.length,1,'ambiguous native delivery must not be replayed');
});

test('cancelled follow-up RPC without ACK must not become HTTP successful delivery',async t => {
  const f=fixture(t);
  const initial=await f.start();
  const stop=stopEndpoint(f);
  const nativeRequest=initial.client._request;
  const ackRace=deferred();
  let inFlight=false;
  initial.client._request=async(method,params)=>{
    if(params.prompt[0].text.startsWith('/steer ')){
      inFlight=true;
      return ackRace.promise;
    }
    return nativeRequest(method,params);
  };
  initial.client.cancel=()=>{
    initial.done.resolve({stopReason:'cancelled'});
    ackRace.resolve({stopReason:'cancelled'});
    return true;
  };
  const pending=f.send('synthetic guidance cancelled before native ACK');
  await until(()=>inFlight,'follow-up RPC must be sent before cancel');
  const stopped=await stop();
  const result=await pending;
  await until(()=>!f.activeRuns.size,'cancelled initial prompt must finalize');
  console.log('CANCEL_ACK_RACE_RECEIPT',JSON.stringify({stop:stopped.result,httpStatus:result.code,
    followup:result.result,logs:f.read().logs,finalMessages:f.read().messages}));
  assert.equal(result.code,500,'native cancelled without active-turn ACK cannot count as delivery');
  assert.ok(f.read().logs.some(log=>/уточнен/.test(log.text)),'undelivered follow-up needs persisted error');
  assert.ok(f.read().messages.some(message=>message.role==='assistant' && /уточнен/.test(message.text)));
  assert.equal(f.read().report,f.base.report);
});

for (const {name,ack,stopReason} of [
  {name:'missing ACK cannot reuse a previous successful follow-up receipt',ack:null,stopReason:'end_turn'},
  {name:'queue-only ACK is not native active-turn acceptance',ack:'Queued for the next turn. (1 queued)',stopReason:'end_turn'},
  {name:'cancelled RPC fails even if an active-turn ACK was received',ack:'⏩ Steer queued for the active turn: synthetic\n',stopReason:'cancelled'}
]) {
  test(name,async t => {
    const f=fixture(t);
    const initial=await f.start();
    const acknowledged=await f.send('Synthetic acknowledged control');
    assert.equal(acknowledged.code,200);
    const nativeRequest=initial.client._request;
    initial.client._request=async(method,params)=>{
      if (params.prompt[0].text.startsWith('/steer ')) {
        if (ack) initial.client._onLine(JSON.stringify({method:'session/update',params:{update:{
          sessionUpdate:'agent_message_chunk',content:{type:'text',text:ack}}}}));
        return {stopReason};
      }
      return nativeRequest(method,params);
    };
    const result=await f.send('Synthetic unconfirmed correction');
    assert.equal(result.code,500,'resolved session/prompt alone must never prove delivery');
    assert.notEqual(result.result.success,true);
    const saved=f.read();
    assert.ok(saved.logs.some(log=>log.type==='error' && /уточнен/.test(log.text)));
    assert.ok(saved.messages.some(message=>message.role==='assistant' && /уточнен/.test(message.text)));
    assert.equal(saved.report,f.base.report);
    assert.equal(f.main.length,1,'unconfirmed delivery is not automatically replayed');
    assert.equal(f.activeRuns.get(sid),initial.run,'delivery refusal must not replace or stop the main run');
  });
}
