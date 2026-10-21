import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

test('panel selection is global, rejects invalid models and persists across restart', async () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-global-'));
 const data = path.join(root, 'sessions'); fs.mkdirSync(data);
 fs.writeFileSync(path.join(data, 'ses_old.json'), JSON.stringify({id:'ses_old',hermesModel:'cc/obsolete',hermesReasoning:'none',report:'untouched',messages:[]}));
 const port = 31987; let child; let token;
 const api = async (route, body, method = body ? 'POST' : 'GET') => {
  const r = await fetch(`http://127.0.0.1:${port}/api/${route}`, {method,headers:{'Content-Type':'application/json',...(token ? {cookie:token} : {})},...(body ? {body:JSON.stringify(body)} : {})});
  return {...await r.json(), httpStatus:r.status};
 };
 const start = async () => {
  child = spawn(process.execPath, [new URL('./index.mjs', import.meta.url).pathname], {env:{...process.env,PANEL_PORT:String(port),PANEL_PASSWORD:'test-only-strong-long-password',PANEL_DATA_DIR:data,PANEL_SETTINGS_FILE:path.join(root,'panel-settings.json'),PANEL_UPLOADS_DIR:path.join(root,'uploads'),PANEL_WEB_DIST:path.join(root,'no-web')},stdio:'ignore'});
  for(let i=0;i<100;i++){try{await api('auth/check');break;}catch{await new Promise(r=>setTimeout(r,30));}}
  const login=await fetch(`http://127.0.0.1:${port}/api/auth/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'test-only-strong-long-password'})}); token=login.headers.get('set-cookie').split(';')[0];
 };
 const stop = async () => {if(child){child.kill();await new Promise(r=>child.once('exit',r));child=null;}};
 try {
  await start();
  const a=(await api('sessions',{title:'A'})).session.id;
  const result=await api(`sessions/${a}/chat`,{text:'/model agy/gemini-3.8-flash-high'});
  assert.equal((await api('health')).hermesModel,'agy/gemini-3.8-flash-high');
  assert.match(result.messages.at(-1).text,/глобальн/i);
  const old=await api('sessions/ses_old'); assert.equal(old.hermesModel,'agy/gemini-3.8-flash-high'); assert.equal(old.hermesReasoning,'high'); assert.equal(old.hermesProvider,'omniroute'); assert.equal(old.report,'untouched');
  const b=(await api('sessions',{title:'B'})).session; assert.equal(b.hermesModel,old.hermesModel);
  assert.equal((await api(`sessions/${a}/chat`,{text:'/model invalid-model'})).httpStatus,400);
  assert.equal((await api('health')).hermesModel,old.hermesModel);
  await stop();await start();assert.equal((await api('health')).hermesModel,old.hermesModel);
  assert.equal((await api(`sessions/${b.id}/chat`,{text:'/reasoning medium'})).httpStatus,200);
  assert.equal((await api('sessions/ses_old')).hermesReasoning,'medium');
  await stop();await start();assert.equal((await api('health')).hermesReasoning,'medium');
 } finally {await stop();fs.rmSync(root,{recursive:true,force:true});}
});
