import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {AcpClient} from './acp_client.mjs';

const scratch = '/root/.hermes/cache/scratch';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function ignoringAcp(t) {
  const dir = fs.mkdtempSync(path.join(scratch, 'acp-dispose-regression-'));
  const fake = path.join(dir, 'fake-acp');
  fs.writeFileSync(fake, '#!/usr/bin/python3\nimport signal,time\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\nprint("READY",flush=True)\nwhile True: time.sleep(.05)\n', {mode:0o700});
  const client = new AcpClient({hermesBin:fake, cwd:dir, env:{PATH:'/usr/bin:/bin'}});
  client._spawnProc();
  const proc = client.proc;
  t.after(async () => {
    if (proc.exitCode === null && proc.signalCode === null) {const exit=once(proc,'exit');proc.kill('SIGKILL');await exit;}
    fs.rmSync(dir, {recursive:true,force:true});
  });
  await once(proc.stdout, 'data');
  return {client,proc};
}

test('dispose immediately rejects all pending ACP calls and refuses new requests', async t => {
  const {client} = await ignoringAcp(t);
  const outcome = request => request.then(() => 'resolved', error => error);
  const main = outcome(client.promptText('synthetic prompt'));
  const followup = outcome(client.followupText('/steer synthetic correction'));
  assert.equal(client.pending.size, 2);
  client.dispose();
  const results = await Promise.race([Promise.all([main,followup]),delay(100).then(() => ['pending','pending'])]);
  assert.ok(results.every(result => result instanceof Error), 'all pending calls must reject immediately, not on process close');
  assert.equal(client.pending.size, 0);
  assert.equal(client.current, null);
  assert.equal(client.isAlive(), false);
  await assert.rejects(client._request('fixture/new', {}), /not running|disposed/i);
});

test('dispose cancels request deadlines instead of leaving long-lived timer resources', async t => {
  const {client} = await ignoringAcp(t);
  const originalTimeout = globalThis.setTimeout;
  let requestTimer;
  t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => {
    const timer = originalTimeout(callback, ms, ...args);
    if (ms === 60000) requestTimer = timer;
    return timer;
  });
  t.after(() => clearTimeout(requestTimer));
  const pending = client._request('fixture/long-deadline', {}, {timeoutMs:60000});
  const rejected = assert.rejects(pending, /disposed/i);
  client.dispose();
  await rejected;
  assert.equal(requestTimer._destroyed, true, 'dispose must cancel the pending deadline');
});

test('dispose escalates a TERM-ignoring child to KILL within a bounded delay, never another process', async t => {
  const {client, proc} = await ignoringAcp(t);
  const unrelated = spawn('/usr/bin/python3', ['-c', 'import time;print("READY",flush=True);time.sleep(60)'], {stdio:['ignore','pipe','ignore']});
  t.after(async () => {
    if (unrelated.exitCode === null && unrelated.signalCode === null) {const exit=once(unrelated,'exit');unrelated.kill('SIGKILL');await exit;}
  });
  await once(unrelated.stdout, 'data');
  const exited = once(proc, 'exit');
  client.dispose();
  client.dispose(); // idempotence must not postpone escalation.
  // A later/replacement proc must not be targeted by the old disposal timer.
  client.proc = unrelated;
  const result = await Promise.race([exited, delay(2500).then(() => null)]);
  assert.notEqual(result, null, 'noncooperative child must not outlive the disposal grace period');
  assert.equal(result[1], 'SIGKILL');
  assert.equal(unrelated.exitCode, null);
  assert.equal(unrelated.signalCode, null);
  assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
});
