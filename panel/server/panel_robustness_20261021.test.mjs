import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';

// Exercise real persistence/helpers and HTTP handlers without starting a server,
// reading real investigations or launching Hermes. All data is synthetic.
const source = fs.readFileSync(new URL('./index.mjs', import.meta.url), 'utf8');
const scratch = os.tmpdir();
const sid = 'ses_robustness_fixture';
function extract(name) {
  const match = source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`));
  assert.ok(match, `missing function ${name}`);
  return match[0];
}
function fixture(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(scratch, 'panel-regression-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, `${sid}.json`);
  const context = vm.createContext({fs, path, crypto, process, Buffer, console, setTimeout, clearTimeout, setInterval, clearInterval,
    DATA_DIR: dir, UPLOADS_DIR: path.join(dir, 'uploads'), activeRuns: new Map(), acpSessions: new Map(),
    isValidSessionId: id => /^ses_[A-Za-z0-9_-]{1,80}$/.test(id),
    requireAuth() {}, globalSelection: () => ({}), selectedSession: s => s, ...extra});
  vm.runInContext(['getSessionPath', 'withSessionLock', 'readSession', 'writeAtomic', 'mutateSession'].map(extract).join('\n'), context);
  vm.runInContext(source.slice(source.indexOf('// Follow-up delivery helpers'),source.indexOf('// Chat endpoint')),context);
  const base = {id: sid, title: 'Synthetic dossier', messages: [{role:'user', text:'old synthetic message'}],
    report: '# Saved synthetic dossier', reportState: {sections:[{id:'fixture',rows:[['synthetic fact']]}]},
    logs: [{text:'old synthetic tool'}], currentStep:'old synthetic step', hermesAcpSessionId:'native-fixture-id'};
  fs.writeFileSync(file, JSON.stringify(base));
  return {context, dir, file, base, read: () => JSON.parse(fs.readFileSync(file, 'utf8'))};
}
function handler(context, route, end) {
  let fn;
  context.app = {post(_route, _auth, callback) {fn = callback;}};
  vm.runInContext(source.slice(source.indexOf(`app.post("${route}"`), source.indexOf(end)), context);
  assert.equal(typeof fn, 'function');
  return fn;
}
function response() {
  return {code:200, result:null, status(code) {this.code=code;return this;}, json(value) {this.result=value;return this;}};
}
function activeNative(context, client) {
  const rec={mainStarted:true,client};
  context.activeRuns.set(sid,{running:true,nativeActive:true,acp:rec});
  context.acpSessions.set(sid,rec);
}

test('image-only follow-up delivers existing safe upload paths and attachment context to ACP steer', async t => {
  const f = fixture(t);
  vm.runInContext(extract('saveUploads'), f.context);
  let delivered;
  activeNative(f.context,{isAlive:() => true, async followupText(text) {delivered=text;}});
  const chat = handler(f.context, '/api/sessions/:id/chat', '// Reset chat transcript ONLY');
  const res = response();
  await chat({params:{id:sid}, body:{images:[{name:'../../synthetic\n/unsafe.png', data:'data:image/png;base64,iVBORw0KGgo='}]}}, res);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(res.code, 200);
  assert.match(delivered, /^\/steer /);
  assert.match(delivered, /ПРИКРЕПЛЁННЫЕ ИЗОБРАЖЕНИЯ/);
  const message = f.read().messages.at(-1);
  assert.equal(message.images.length, 1);
  const uploadDir = path.join(f.context.UPLOADS_DIR, sid);
  const names = fs.readdirSync(uploadDir);
  assert.equal(names.length, 1);
  const uploaded = path.join(uploadDir, names[0]);
  assert.ok(fs.statSync(uploaded).isFile());
  assert.ok(delivered.includes(uploaded), 'usable host path must reach native steer');
  assert.ok(delivered.includes(message.images[0].url), 'report insertion URL must reach native steer');
  assert.ok(delivered.includes(JSON.stringify(message.images[0].name)), 'attachment names must be escaped data');
  assert.equal(f.read().report, f.base.report);
});

test('invalid image-only follow-up is rejected instead of silently sending text', async t => {
  const f = fixture(t);
  vm.runInContext(extract('saveUploads'), f.context);
  let delivered = false;
  activeNative(f.context,{isAlive:() => true, async followupText() {delivered=true;}});
  const chat = handler(f.context, '/api/sessions/:id/chat', '// Reset chat transcript ONLY');
  const res = response();
  await chat({params:{id:sid}, body:{images:[{name:'fake.png', data:'data:image/png;base64,bm90LWFuLWltYWdl'}]}}, res);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(res.code, 400);
  assert.equal(delivered, false);
  assert.deepEqual(f.read(), f.base);
});

test('Python-compatible held directory lock waits without blocking event-loop timers', async t => {
  const f = fixture(t);
  const lock = path.join(f.dir, '.locks', `${sid}.lock`);
  fs.mkdirSync(lock, {recursive:true});
  let heartbeat = false;
  const timer = setTimeout(() => {heartbeat=true;fs.rmdirSync(lock);}, 30);
  t.after(() => clearTimeout(timer));
  let error;
  try {await f.context.mutateSession(f.file, obj => {obj.title='after external lock';});}
  catch (err) {error=err;}
  assert.equal(error, undefined, 'lock holder must be able to release while Node waits');
  assert.equal(heartbeat, true);
  assert.equal(f.read().title, 'after external lock');
  assert.equal(fs.existsSync(lock), false);
});

test('Node serializes with the actual isolated Python session-lock implementation', async t => {
  const f = fixture(t);
  const python = spawn('/usr/bin/python3', ['-c', `
import ast, contextlib, json, pathlib, sys, time
root, source, sid = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), sys.argv[3]
tree = ast.parse(source.read_text())
fn = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == '_session_lock')
scope = dict(contextlib=contextlib, DATA_DIR=root, time=time, _safe_id=lambda value: value)
exec(compile(ast.Module(body=[fn],type_ignores=[]),str(source),'exec'),scope)
with scope['_session_lock'](sid):
    print('READY',flush=True)
    sys.stdin.readline()
    target = root / (sid+'.json')
    data = json.loads(target.read_text())
    data['report'] = '# Synthetic Python update'
    tmp = target.with_suffix('.tmp')
    tmp.write_text(json.dumps(data))
    tmp.replace(target)
`, f.dir, new URL('./mcp_osint.py',import.meta.url).pathname, sid], {stdio:['pipe','pipe','pipe']});
  let stderr = '';
  python.stderr.on('data', data => {stderr+=data;});
  const exited = once(python, 'exit');
  t.after(async () => {if (python.exitCode === null && python.signalCode === null) {python.kill('SIGKILL');await exited;}});
  await once(python.stdout, 'data');
  const write = f.context.mutateSession(f.file, obj => {obj.title='synthetic Node update';});
  const timer = setTimeout(() => python.stdin.end('\n'),30);
  t.after(() => clearTimeout(timer));
  await write;
  assert.equal((await exited)[0], 0, stderr);
  assert.equal(f.read().report, '# Synthetic Python update');
  assert.equal(f.read().title, 'synthetic Node update');
  assert.equal(fs.existsSync(path.join(f.dir,'.locks',`${sid}.lock`)), false);
});

test('lock timeout never removes another owner or writes unlocked', async t => {
  const f = fixture(t);
  const lock = path.join(f.dir,'.locks',`${sid}.lock`);
  fs.mkdirSync(lock,{recursive:true});
  let now = Date.now();
  f.context.Date = {now() {now+=2501;return now;}};
  let called = false;
  await assert.rejects(f.context.withSessionLock(sid, () => {called=true;}), /Session is busy/);
  assert.equal(called,false);
  assert.equal(fs.existsSync(lock),true);
  assert.deepEqual(f.read(),f.base);
});

test('directory lock remains owned until an asynchronous critical section completes', async t => {
  const f = fixture(t);
  const lock = path.join(f.dir, '.locks', `${sid}.lock`);
  let owned;
  await f.context.withSessionLock(sid, async () => {
    await new Promise(resolve => setTimeout(resolve, 10));
    owned = fs.existsSync(lock);
  });
  assert.equal(owned, true);
  assert.equal(fs.existsSync(lock), false);
});

test('mutation entrypoints wait for persistence before replying or continuing', async t => {
  for (const operation of ['rename', 'delete', 'model', 'stop', 'followup', 'start', 'native-id', 'finalize']) {
    await t.test(operation, async t => {
      let release;
      const gate = new Promise(resolve => {release=resolve;});
      let persisted = false;
      const f = fixture(t, {panelModel() {}, PANEL_MODELS:[], panelSettings:{select() {}},
        saveUploads:() => [], cleanConciseTitle:() => 'synthetic',
        runHermesInvestigation() {assert.equal(persisted, true, 'run must wait for saved input');},
        stopRunAcp:() => ({ok:true}), sanitizeAgentReply:t => t, looksLikeAgentError:() => false, looksLikeDossier:() => false});
      const mutate = f.context.mutateSession;
      f.context.mutateSession = async (...args) => {await gate;const result=await mutate(...args);persisted=true;return result;};
      const res = response();
      const respond = res.json.bind(res);
      res.json = value => {assert.equal(persisted, true, 'success response must wait for saved data');return respond(value);};
      let fn, req = {params:{id:sid}, body:{text:'synthetic input',title:'renamed'}};
      if (operation === 'rename' || operation === 'delete') {
        const method = operation === 'rename' ? 'patch' : 'delete';
        f.context.app = {[method](_route, _auth, callback) {fn=callback;}};
        const start = source.indexOf(`app.${method}("/api/sessions/:id"`);
        const end = source.indexOf(operation === 'rename' ? '// Delete Session' : '// ---------- Attachments', start);
        vm.runInContext(source.slice(start, end), f.context);
        // Deletion uses the directory lock directly instead of mutateSession.
        if (operation === 'delete') {
          const withLock = f.context.withSessionLock;
          f.context.withSessionLock = async (...args) => {await gate;const result=await withLock(...args);persisted=true;return result;};
        }
      } else if (operation === 'native-id' || operation === 'finalize') {
        fn = vm.runInContext(`(${extract(operation === 'native-id' ? 'updateSessionFile' : 'finalizeRun')})`, f.context);
        f.context.activeRuns.set(sid, {running:true});
      } else {
        fn = handler(f.context, '/api/sessions/:id/chat', '// Reset chat transcript ONLY');
        if (operation === 'model') req.body.text='/model synthetic';
        if (operation === 'stop') req.body.text='/stop';
        if (operation === 'stop' || operation === 'followup') {
          activeNative(f.context,{isAlive:() => true, async followupText() {assert.equal(persisted,true);}});
        }
      }
      let settled = false;
      const result = Promise.resolve().then(() => operation === 'native-id' ? fn(f.file, {hermesAcpSessionId:'new-native'})
        : operation === 'finalize' ? fn(sid, f.file, 'synthetic assistant reply') : fn(req,res));
      const observed = result.then(() => {settled=true;}, error => {settled=true;throw error;});
      // Observe rejection immediately, but retain it for the assertion below.
      observed.catch(() => {});
      await new Promise(resolve => setImmediate(resolve));
      const early = settled;
      release();
      await observed;
      assert.equal(early, false, 'caller must return a promise covering persistence');
      assert.equal(persisted, true);
    });
  }
});

test('concurrent active follow-ups append without overwriting each other or live dossier updates', async t => {
  const f = fixture(t);
  activeNative(f.context,{isAlive:() => true, async followupText() {}});
  const chat = handler(f.context, '/api/sessions/:id/chat', '// Reset chat transcript ONLY');
  await Promise.all(['first synthetic correction', 'second synthetic correction'].map(text =>
    chat({params:{id:sid}, body:{text}}, response())));
  assert.deepEqual(f.read().messages.map(m => m.text), ['old synthetic message','first synthetic correction','second synthetic correction']);
  assert.equal(f.read().report, f.base.report);
});

test('new run reserves its slot before awaiting persistence and clears old transient state', async t => {
  let started = 0;
  const f = fixture(t, {panelModel() {}, cleanConciseTitle:() => 'synthetic', runHermesInvestigation() {started++;}});
  const chat = handler(f.context, '/api/sessions/:id/chat', '// Reset chat transcript ONLY');
  const responses = [response(), response()];
  await Promise.all(responses.map((res, index) => chat({params:{id:sid}, body:{text:`synthetic turn ${index}`}},res)));
  assert.equal(started, 1, 'only one investigation may start');
  assert.deepEqual(responses.map(res => res.code).sort(), [200,409]);
  assert.deepEqual(f.read().logs, [], 'old logs are intentionally cleared for a new run');
});

test('chat persistence failure returns an error without starting a run or leaving a busy slot', async t => {
  let started = 0;
  const f = fixture(t, {panelModel() {}, cleanConciseTitle:() => 'synthetic', runHermesInvestigation() {started++;}});
  f.context.mutateSession = async () => {throw new Error('Session is busy');};
  const chat = handler(f.context, '/api/sessions/:id/chat', '// Reset chat transcript ONLY');
  const res = response();
  await chat({params:{id:sid}, body:{text:'synthetic turn'}},res);
  assert.ok(res.code >= 400);
  assert.equal(started, 0);
  assert.equal(f.context.activeRuns.has(sid), false);
});

for (const command of ['/reset','reset-chat']) {
  test(`${command} prevents a concurrent run from starting while reset is waiting for its lock`, async t => {
    let started = 0, release;
    const gate = new Promise(resolve => {release=resolve;});
    const f = fixture(t, {panelModel() {}, cleanConciseTitle:() => 'synthetic', runHermesInvestigation() {started++;}});
    const mutate = f.context.mutateSession;
    f.context.mutateSession = async (...args) => {await gate;return mutate(...args);};
    const chat = handler(f.context, '/api/sessions/:id/chat', '// Reset chat transcript ONLY');
    const reset = command === '/reset' ? chat : handler(f.context, '/api/sessions/:id/reset-chat', '// Stop running investigation');
    const resetResult = reset({params:{id:sid}, body:{text:command}}, response());
    const res = response();
    const startResult = chat({params:{id:sid}, body:{text:'concurrent synthetic turn'}},res);
    release();
    await Promise.all([resetResult,startResult]);
    assert.equal(res.code, 409);
    assert.equal(started, 0);
    assert.equal(f.context.activeRuns.has(sid), false);
    assert.equal(Object.hasOwn(f.read(),'hermesAcpSessionId'),false);
  });
}

test('health distinguishes binary presence from unchecked readiness and counts only live runs', async t => {
  const f = fixture(t, {HERMES_BIN:'/unused', ACP_ENABLED:true, PANEL_MODELS:[], promptModulesInfo:() => ({loaded:10})});
  const fake = path.join(f.dir, 'configured-but-not-executable');
  fs.writeFileSync(fake, 'synthetic binary fixture', {mode:0o600});
  f.context.HERMES_BIN = fake;
  f.context.activeRuns.set('ses_running', {running:true});
  f.context.activeRuns.set('ses_idle', {running:false});
  f.context.activeRuns.set('ses_deleted', {running:true,deleted:true});
  let health;
  f.context.app = {get(_route, _auth, fn) {health=fn;}};
  vm.runInContext(source.slice(source.indexOf('app.get("/api/health"'),source.indexOf('// Uploaded images')), f.context);
  const res = response();
  await health({}, res);
  assert.equal(res.result.activeRuns, 1);
  assert.equal(res.result.hermesAvailable, true, 'legacy field means binary existence, not dependency readiness');
  assert.equal(res.result.hermesExecutable, false);
  assert.equal(res.result.readiness.status, 'not-checked');
  assert.equal(res.result.readiness.ready, null);
  assert.equal(res.result.dependencyHealth.cacheAvailable, false);
  assert.equal(res.result.dependencyHealth.checkedAt, null);
  assert.equal(res.result.fallbackEnabled, false);
});

test('successful first turn stops reinjecting transcript into live native context', async t => {
  const includesHistory = [];
  const rec = {hasNativeContext:false, client:{async promptText() {return {text:'synthetic reply', stopReason:'end_turn'};}}};
  const f = fixture(t, {ACP_ENABLED:true, HERMES_TIMEOUT_MS:5000, getAcpClient:async () => rec,
    buildHermesPrompt:options => {includesHistory.push(options.includeHistory);return 'synthetic prompt';}, finalizeRun() {}});
  f.context.activeRuns.set(sid, {running:true});
  const run = vm.runInContext(`(${extract('runHermesInvestigation')})`, f.context);
  await run(sid, f.file, f.base);
  await run(sid, f.file, f.base);
  assert.deepEqual(includesHistory, [true, false]);
  assert.equal(rec.hasNativeContext, true);
});

for (const command of ['reset-chat', '/reset', '/new', '/clear']) {
  test(`${command} deletes persisted native context, clears transient state, preserves dossier`, async t => {
    const f = fixture(t);
    let disposed = 0;
    f.context.acpSessions.set(sid, {client:{dispose() {disposed++;}}});
    const isRoute = command === 'reset-chat';
    const fn = handler(f.context, isRoute ? '/api/sessions/:id/reset-chat' : '/api/sessions/:id/chat',
      isRoute ? '// Stop running investigation' : '// Reset chat transcript ONLY');
    const res = response();
    await fn({params:{id:sid}, body:{text:command}}, res);
    assert.equal(res.code, 200);
    const saved = f.read();
    assert.equal(Object.hasOwn(saved, 'hermesAcpSessionId'), false, 'persisted native context must be deleted');
    assert.deepEqual(saved.logs, [], 'old logs must not reappear');
    assert.equal(saved.currentStep, '');
    assert.equal(saved.report, f.base.report);
    assert.deepEqual(saved.reportState, f.base.reportState);
    assert.equal(saved.title, f.base.title);
    assert.ok(saved.messages.every(m => m.role === 'assistant'), 'old transcript must be removed');
    assert.equal(saved.messages.length, isRoute ? 0 : 1);
    assert.equal(disposed, 1);
    assert.equal(f.context.acpSessions.size, 0);
  });
}
