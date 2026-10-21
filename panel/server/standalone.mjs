// Portable entry point: never default to the operator's production data/profile.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export function resolvePanelEnvironment(env,root=ROOT) {
  const result={...env};
  const set=(key,fallback)=>{result[key]=path.resolve(root,env[key]||fallback);};
  set('PANEL_DATA_DIR','data/sessions');
  set('PANEL_WORKSPACE_DIR','workspace');
  set('PANEL_PROMPTS_DIR','prompts');
  set('PANEL_WEB_DIST','web/dist');
  set('PANEL_UPLOADS_DIR','data/uploads');
  set('OSINT_DATA_DIR',result.PANEL_DATA_DIR);
  set('OSINT_UPLOADS_DIR',result.PANEL_UPLOADS_DIR);
  set('OSINT_ENGINE_SCRIPT','workspace/osint_engine.py');
  set('OSINT_FRAMEWORK_PATH','server/osint_framework.json');
  set('HERMES_HOME','.hermes-home');
  set('HERMES_RUNTIME_DIR',path.join(result.HERMES_HOME,'tools'));
  result.HERMES_BIN=env.HERMES_BIN||'hermes';
  return result;
}
if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  Object.assign(process.env,resolvePanelEnvironment(process.env));
  fs.mkdirSync(process.env.PANEL_WORKSPACE_DIR,{recursive:true});
  process.chdir(ROOT);
  await import('./index.mjs');
}
