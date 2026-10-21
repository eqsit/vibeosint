import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import {PanelSettings, PANEL_MODELS, panelModel} from './model_policy.mjs';
const source=fs.readFileSync(new URL('./index.mjs',import.meta.url),'utf8');
test('model commands during active turns persist globally without steer, cancel or dispose',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'panel-active-'));
 try {
 const activeRuns=new Map([['ses_a',{running:true}]]);
 const panelSettings=new PanelSettings(path.join(dir,'settings.json'));
 fs.writeFileSync(path.join(dir,'ses_a.json'),JSON.stringify({id:'ses_a',messages:[],report:'original report'}));
 let handler; const clients=new Map([['ses_a',{client:{dispose(){assert.fail('disposed active client');},followupText(){assert.fail('steered model command');}}}]]);
 const app={post(route,auth,fn){handler=fn;}};
 const snippet=source.slice(source.indexOf('app.post("/api/sessions/:id/chat"'),source.indexOf('// Reset chat transcript ONLY'));
 vm.runInNewContext(snippet,{app,requireAuth(){},fs,path,DATA_DIR:dir,activeRuns,acpSessions:clients,panelSettings,PANEL_MODELS,globalSelection:()=>({...panelSettings.value}),console,
 getSessionPath:(id)=>path.join(dir,`${id}.json`),
 mutateSession:(p,fn)=>{const data=JSON.parse(fs.readFileSync(p,'utf8'));fn(data);fs.writeFileSync(p,JSON.stringify(data));return data;}});
 let result; const res={json(v){result=v;return this;},status(v){assert.equal(v,200);return this;}};
 await handler({params:{id:'ses_a'},body:{text:'/model agy/gemini-3.8-flash-high'}},res);
 assert.equal(result.status,'running'); assert.equal(panelSettings.value.hermesModel,'agy/gemini-3.8-flash-high');
 assert.equal(activeRuns.get('ses_a').running,true);assert.equal(clients.size,1);
 assert.match(result.messages.at(-1).text,/следующего/);
 assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'ses_a.json'))).report,'original report');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('idle cached ACP is recreated on changed selection and preserves native context',async()=>{
 const fn=source.match(/async function getAcpClient\([\s\S]*?\n\}/)[0];
 let disposed=0;let model;let loaded;
 const acpSessions=new Map([['ses_a',{selectionKey:JSON.stringify(['codex/gpt-6.1-sol','omniroute','xhigh']),client:{dispose(){disposed++;},isAlive(){return true;}}}]]);
 class AcpClient {isAlive(){return true;} async start(){} async loadSession(id){loaded=id;return true;} async setModel(id){model=id;return true;} dispose(){} }
 const get=vm.runInNewContext(`(${fn})`,{acpSessions,AcpClient,HERMES_BIN:'test',WORKSPACE_DIR:'test',acpEnv:()=>({}),spawnSync:()=>({status:0}),modelIdFor:s=>`custom:${panelModel(s)}`,updateSessionFile(){},Date,JSON,Error});
 const session={hermesModel:'agy/gemini-3.8-flash-high',hermesProvider:'omniroute',hermesReasoning:'high',hermesAcpSessionId:'native-original'};
 const rec=await get('ses_a',session,'test',()=>{});assert.equal(disposed,1);assert.equal(model,'custom:agy/gemini-3.8-flash-high');assert.equal(loaded,'native-original');assert.equal(rec.hasNativeContext,true);
 assert.equal(await get('ses_a',session,'test',()=>{}),rec);assert.equal(disposed,1);
});
test('frontend built bundle handles model refresh (source is absent in full archive)',()=>{
 const ui=fs.readFileSync(new URL('../web/dist/assets/index-C9itJIt5.js',import.meta.url),'utf8');
 assert.match(ui,/\/api\/health/);
 assert.match(ui,/addEventListener\("focus"/);
 assert.doesNotMatch(ui,/vibeosint_deep_mode/);
 assert.doesNotMatch(ui,/DEEP RESEARCH/);
});
