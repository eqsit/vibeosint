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
const image = {name:'synthetic.png',data:'data:image/png;base64,iVBORw0KGgo='};

test('normal active follow-up steers the same native run with safe image paths',async t => {
  const f=fixture(t);
  const initial=await f.start();
  const res=await f.send('Synthetic active correction',[image]);
  assert.equal(res.code,200);
  assert.equal(res.result.status,'running');
  assert.equal(f.main.length,1);
  assert.equal(f.steers.length,1);
  assert.equal(f.steers[0].active,true);
  assert.equal(f.steers[0].run,initial.run);
  const message=f.read().messages.at(-1);
  assert.equal(message.images.length,1);
  assert.ok(f.steers[0].text.includes(message.images[0].url));
  const upload=fs.readdirSync(path.join(f.dir,'uploads',sid))[0];
  assert.ok(f.steers[0].text.includes(path.join(f.dir,'uploads',sid,upload)));
  assert.equal(f.read().report,f.base.report);
});

test('completion while follow-up waits on the real persistence lock starts a new tracked prompt with text and images',async t => {
  const f=fixture(t);
  const initial=await f.start();
  const lock=f.hold();
  t.after(lock.release);
  const pending=f.send('Synthetic correction after completion',[image]);
  await until(lock.waiting,'follow-up must wait on the held directory lock');
  initial.done.resolve({stopReason:'end_turn'});
  await until(() => initial.client.current===null,'real native prompt must finish before releasing persistence lock');
  assert.equal(f.clients[0].mainStarted,false,'cached mainStarted must describe current activity, not historical startup');
  // Simulate a Python dossier update under the same lock.
  const live=f.read();
  live.report='# Synthetic dossier updated during wait';
  live.reportState.sections[0].rows.push(['new live fact']);
  fs.writeFileSync(f.file,JSON.stringify(live));
  lock.release();
  const res=await pending;
  await until(() => f.main.length===2,'accepted follow-up must start a new native prompt, not an idle /steer queue');
  assert.equal(res.code,200);
  assert.notEqual(f.main[1].run,initial.run,'new native prompt needs its own tracked run');
  assert.equal(f.activeRuns.get(sid),f.main[1].run);
  assert.equal(res.result.status,'running');
  assert.equal(f.steers.length,0,'finished native turn must never be steered');
  assert.match(f.main[1].text,/Synthetic correction after completion/);
  const attachment=f.builds[1].attachments[0];
  assert.ok(fs.existsSync(attachment.path));
  assert.equal(f.read().messages.filter(m => m.text==='Synthetic correction after completion').length,1);
  assert.equal(f.read().report,live.report);
  assert.deepEqual(f.read().reportState,live.reportState);
  f.main[1].done.resolve({stopReason:'end_turn'});
  await until(() => !f.activeRuns.size,'follow-up prompt must finish and clear its run');
});

test('multiple follow-ups survive completion during persistence without losing text, images or live dossier edits',async t => {
  const f=fixture(t);
  const initial=await f.start();
  const lock=f.hold();
  t.after(lock.release);
  const corrections=['Synthetic correction one','Synthetic correction two','Synthetic correction three'];
  const pending=corrections.map((text,i) => f.send(text,[{...image,name:`synthetic-${i}.png`}]));
  await until(lock.waiting,'concurrent follow-ups must wait on the real lock');
  initial.done.resolve({stopReason:'end_turn'});
  await until(() => initial.client.current===null,'initial native prompt must finish');
  const live=f.read();
  live.report='# Synthetic concurrent dossier';
  live.reportState.sections[0].rows.push(['concurrent fact']);
  fs.writeFileSync(f.file,JSON.stringify(live));
  lock.release();
  const results=await Promise.all(pending);
  assert.ok(results.every(res => res.code===200));
  assert.equal(f.main.length,2,'only one replacement run may be reserved');
  const delivered=f.main.slice(1).map(entry => entry.text).concat(f.steers.map(entry => entry.text));
  for (const text of corrections) {
    assert.equal(delivered.filter(entry => entry.includes(text)).length,1,`deliver ${text} exactly once`);
    assert.equal(f.read().messages.filter(message => message.text===text).length,1);
  }
  assert.ok(f.steers.every(entry => entry.active && entry.run===f.main[1].run));
  const messages=f.read().messages.filter(message => corrections.includes(message.text));
  assert.equal(messages.length,3);
  for (const message of messages) assert.ok(delivered.some(text => text.includes(message.images[0].url)));
  assert.equal(f.read().report,live.report);
  assert.deepEqual(f.read().reportState,live.reportState);
});

test('follow-up delivery failure is returned honestly and persisted as a session error/log',async t => {
  const f=fixture(t);
  await f.start();
  f.failSteer('synthetic transport failure');
  const res=await f.send('Synthetic undeliverable correction');
  assert.equal(res.code,500);
  assert.notEqual(res.result.success,true);
  assert.match(res.result.error,/synthetic transport failure/);
  const saved=f.read();
  assert.ok(saved.messages.some(message => message.role==='assistant' && /уточнен.*synthetic transport failure/i.test(message.text)),
    'the persisted transcript must not pretend that the correction was delivered');
  assert.ok(saved.logs.some(log => /synthetic transport failure/.test(log.text)),'delivery failure must appear in session logs');
  assert.ok(f.errors.some(line => /synthetic transport failure/.test(line)));
  assert.equal(saved.report,f.base.report);
});

test('native Steer failed acknowledgment is not silently stripped into a successful delivery',async t => {
  const f=fixture(t);
  await f.start();
  f.failAck('synthetic native refusal');
  const res=await f.send('Synthetic refused correction');
  assert.equal(res.code,500,'RPC end_turn alone is not a delivery acknowledgment');
  assert.match(res.result.error,/synthetic native refusal/);
  assert.ok(f.read().logs.some(log => /synthetic native refusal/.test(log.text)));
  assert.ok(f.read().messages.some(message => message.role==='assistant' && /synthetic native refusal/.test(message.text)));
});

test('concurrent ACP follow-ups serialize untagged acknowledgments without cross-contaminating failures',async () => {
  const client=new AcpClient({hermesBin:'/never-executed',cwd:'/unused',env:{}});
  const sent=[];
  client._request=async () => {const done=deferred();sent.push(done);return done.promise;};
  const ack=text => client._onLine(JSON.stringify({method:'session/update',params:{update:{
    sessionUpdate:'agent_message_chunk',content:{type:'text',text}}}}));
  const first=client.followupText('/steer first');
  const firstFailure=assert.rejects(first,/synthetic first refusal/);
  const second=client.followupText('/steer second');
  await new Promise(resolve => setImmediate(resolve));
  const countBeforeAck=sent.length;
  ack('⚠️ Steer failed: synthetic first refusal');
  sent[0].resolve({stopReason:'end_turn'});
  await firstFailure;
  await until(() => sent.length===2,'second follow-up must run after the first acknowledgment');
  ack('⏩ Steer queued for the active turn: second');
  sent[1].resolve({stopReason:'end_turn'});
  await second;
  assert.equal(countBeforeAck,1,'ACP session/update acknowledgments have no request id; concurrent sends cannot be correlated');
});

test('follow-up waiting for another delivery revalidates the exact run immediately before sending',async t => {
  const f=fixture(t);
  const initial=await f.start();
  const gate=f.holdNextSteer();
  t.after(() => gate.resolve());
  const first=f.send('Synthetic active first correction');
  await until(() => f.steers.length===1,'first delivery must be in flight');
  const firstTail=initial.client.followupTail;
  const second=f.send('Synthetic late second correction',[image]);
  await until(() => initial.client.followupTail!==firstTail,'second delivery must reach the client serialization queue');
  initial.done.resolve({stopReason:'end_turn'});
  await until(() => !f.activeRuns.size,'real prior run must fully finalize while second delivery waits');
  gate.resolve();
  const results=await Promise.all([first,second]);
  await until(() => f.main.length===2,'late delivery needs a new tracked native prompt');
  assert.ok(results.every(res => res.code===200));
  assert.equal(f.steers.length,1,'queued delivery may not steer the old now-idle run');
  assert.equal(f.steers[0].active,true);
  assert.notEqual(f.main[1].run,initial.run);
  assert.match(f.main[1].text,/Synthetic late second correction/);
  assert.equal(f.builds[1].attachments.length,1);
});

test('a native no-active-turn acknowledgment cannot be reported as successful running delivery',async t => {
  const f=fixture(t);
  await f.start();
  f.setAck('No active turn — queued for the next turn. (1 queued)');
  const res=await f.send('Synthetic correction rejected at native boundary');
  assert.equal(res.code,500,'native queue-only delivery is not active-turn acceptance');
  assert.notEqual(res.result.success,true);
  assert.ok(f.read().logs.some(log => /No active turn/.test(log.text)));
  assert.ok(f.read().messages.some(message => message.role==='assistant' && /No active turn/.test(message.text)));
});

test('successful delivery finishing after the native run returns idle rather than stale running',async t => {
  const f=fixture(t);
  const initial=await f.start();
  const gate=f.holdNextSteer();
  t.after(() => gate.resolve());
  const pending=f.send('Synthetic acknowledged active correction');
  await until(() => f.steers.length===1,'correction must reach the active native turn');
  initial.done.resolve({stopReason:'end_turn'});
  await until(() => !f.activeRuns.size,'prior run must finish before delivery response');
  gate.resolve();
  const res=await pending;
  assert.equal(res.code,200);
  assert.equal(res.result.status,'idle');
  assert.equal(f.main.length,1,'a successfully delivered correction must not be replayed');
});

test('post-persistence delivery uses the replacement run and ACP identity instead of the stale captured client',async t => {
  const f=fixture(t);
  const initial=await f.start();
  const gate=deferred();
  t.after(() => gate.resolve());
  const mutate=f.context.mutateSession;
  let persisted=false;
  f.context.mutateSession=async (...args) => {
    const result=await mutate(...args);
    if (!persisted) {persisted=true;await gate.promise;}
    return result;
  };
  const pending=f.send('Synthetic pending correction for replacement',[image]);
  await until(() => persisted,'follow-up input must be persisted before pausing its continuation');
  initial.done.resolve({stopReason:'end_turn'});
  await until(() => !f.activeRuns.size,'old run must really finalize');
  // Equivalent to the old idle ACP being evicted by a changed global selection.
  initial.client.dispose();
  f.acpSessions.delete(sid);
  const next=await f.send('Synthetic independently started next turn');
  assert.equal(next.code,200);
  await until(() => f.main.length===2,'replacement native run must really start');
  gate.resolve();
  const res=await pending;
  assert.equal(res.code,200);
  assert.equal(f.main.length,2);
  assert.equal(f.steers.length,1);
  assert.equal(f.steers[0].run,f.main[1].run);
  assert.equal(f.steers[0].client,f.main[1].client);
  assert.notEqual(f.steers[0].client,initial.client);
  assert.equal(f.steers[0].active,true);
});
