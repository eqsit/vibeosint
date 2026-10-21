import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('./index.mjs', import.meta.url), 'utf8');
let policy = {};
try { policy = await import('./model_policy.mjs'); } catch (e) { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; }
const fn = source.match(/function modelIdFor\(session\) \{[\s\S]*?\n\}/)[0];
const modelIdFor = vm.runInNewContext(`(${fn})`, { HERMES_MODEL: 'codex/gpt-6.1-sol', HERMES_PROVIDER: 'omniroute', ...policy });
test('DeepSeek via opencode-go keeps direct provider ACP prefix', () => {
 assert.equal(modelIdFor({hermesModel:'deepseek-v4.1-flash',hermesProvider:'opencode-go'}), 'opencode-go:deepseek-v4.1-flash');
});
test('stale models cannot silently continue or fallback', () => {
 assert.throws(() => modelIdFor({hermesModel:'cc/claude-sonnet-5'}), /устарела/);
 assert.match(source, /if \(!modelOk\) throw new Error/);
 assert.doesNotMatch(source, /legacy fallback|fallback to legacy spawn/);
});
