import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const entry=path.join(path.dirname(fileURLToPath(import.meta.url)),'standalone.mjs');
async function resolver() {
  assert.ok(fs.existsSync(entry),'standalone entry must resolve project-local paths without using production');
  return (await import(pathToFileURL(entry).href)).resolvePanelEnvironment;
}
test('standalone defaults isolate project data and Hermes home',async()=>{
  const resolve=await resolver();const root='/fixture/panel';const value=resolve({},root);
  assert.equal(value.PANEL_DATA_DIR,root+'/data/sessions');
  assert.equal(value.OSINT_DATA_DIR,value.PANEL_DATA_DIR);
  assert.equal(value.PANEL_WORKSPACE_DIR,root+'/workspace');
  assert.equal(value.PANEL_PROMPTS_DIR,root+'/prompts');
  assert.equal(value.HERMES_HOME,root+'/.hermes-home');
  assert.equal(value.HERMES_RUNTIME_DIR,root+'/.hermes-home/tools');
  assert.equal(value.HERMES_BIN,'hermes');
});
test('standalone resolves relative overrides independently of child cwd',async()=>{
  const resolve=await resolver();const env={HERMES_HOME:'profile',PANEL_WORKSPACE_DIR:'work',OSINT_DATA_DIR:'records',HERMES_RUNTIME_DIR:'tools-custom'};
  const before={...env};const value=resolve(env,'/fixture/panel');
  assert.equal(value.HERMES_HOME,'/fixture/panel/profile');
  assert.equal(value.PANEL_WORKSPACE_DIR,'/fixture/panel/work');
  assert.equal(value.OSINT_DATA_DIR,'/fixture/panel/records');
  assert.equal(value.HERMES_RUNTIME_DIR,'/fixture/panel/tools-custom');
  assert.deepEqual(env,before);
});
test('standalone preserves explicit absolute paths and operator binary',async()=>{
  const resolve=await resolver();const value=resolve({PANEL_DATA_DIR:'/custom/data',HERMES_HOME:'/custom/home',HERMES_BIN:'/custom/bin/hermes'},'/fixture/panel');
  assert.equal(value.PANEL_DATA_DIR,'/custom/data');assert.equal(value.HERMES_HOME,'/custom/home');assert.equal(value.HERMES_BIN,'/custom/bin/hermes');
  assert.equal(value.HERMES_RUNTIME_DIR,'/custom/home/tools');
});
