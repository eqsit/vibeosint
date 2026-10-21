import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

// Integration tests require no Hermes, Serper or external network.
test('auth cookie, rate-limit, session confinement, persistence and report safety', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-sec-'));
  const port = 30000 + Math.floor(Math.random() * 20000);
  const password = 'test-' + 'x'.repeat(28);
  const env = { ...process.env, PANEL_PORT: String(port), PANEL_PASSWORD: password,
    PANEL_DATA_DIR: path.join(dir, 'sessions'), PANEL_UPLOADS_DIR: path.join(dir, 'uploads'),
    PANEL_WEB_DIST: path.join(dir, 'no-web'), PANEL_SETTINGS_FILE: path.join(dir, 'panel-settings.json') };
  let child; let cookie = '';
  const call = async (route, body, method = body ? 'POST' : 'GET', extraHeaders = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/${route}`, {
      method, headers: {'content-type': 'application/json', ...(cookie ? {cookie} : {}), ...extraHeaders},
      ...(body ? {body: JSON.stringify(body)} : {}) });
    return {status: res.status, headers: res.headers, json: await res.json()};
  };
  const start = async () => {
    child = spawn(process.execPath, [new URL('./index.mjs', import.meta.url).pathname], {env, stdio:'ignore'});
    let ready = false;
    for(let i=0;i<120;i++) {
      if(child.exitCode !== null) break;
      try { await fetch(`http://127.0.0.1:${port}/api/auth/check`); ready=true; break; }
      catch { await new Promise(r=>setTimeout(r,40)); }
    }
    assert.ok(ready, 'Node server failed to start');
  };
  const stop = async () => { if (child && child.exitCode === null) { child.kill(); await new Promise(r=>child.once('exit',r)); } child = null; };
  try {
    await start();
    assert.equal((await call('sessions')).status,401);
    assert.equal((await call('auth/login',{password:'wrong'})).status,403);
    const login = await call('auth/login',{password});
    assert.equal(login.status,200);
    assert.equal(login.json.success,true);
    assert.equal(login.json.token,undefined);
    assert.match(login.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);
    cookie=login.headers.get('set-cookie').split(';')[0];
    assert.equal((await call('auth/check')).json.authenticated,true);
    const x = await call('sessions',{title:'Example'});
    assert.equal(x.status,200);
    const id=x.json.session.id;
    assert.match(id,/^ses_[a-f0-9-]{36}$/);
    assert.equal((await call('sessions/'+id)).status,200);
    assert.equal((await call('sessions/%2e%2e%2foutside')).status,400);
    assert.equal((await call('sessions/ses_not_found')).status,404);
    assert.equal((await call('sessions/'+id,{title:'hi'},'PATCH', {origin:'https://evil.example'})).status,403);
    assert.equal((await call('sessions/'+id,{title:'renamed'},'PATCH')).status,200);
    await stop(); await start();
    assert.equal((await call('auth/check')).json.authenticated,true);
    assert.equal((await call('sessions/'+id)).json.title,'renamed');
    assert.equal((await call('sessions/'+id,undefined,'DELETE')).status,200);
    assert.equal((await call('sessions/'+id)).status,404);
    assert.equal((await call('auth/logout',{},'POST')).status,200);
    assert.equal((await call('sessions')).status,401);
  } finally { await stop(); fs.rmSync(dir,{recursive:true,force:true}); }
});
