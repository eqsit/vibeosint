import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';

test('all Node regression fixture directories honor the current writable TMPDIR',()=>{
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'fixture-temp-portability-'));
  const previous=process.env.TMPDIR;
  process.env.TMPDIR=temporary;
  try {
    for (const name of ['acp_dispose_20261021.test.mjs','active_followup_race_20261021.test.mjs','active_followup_ack_inflight_20261021.test.mjs','panel_robustness_20261021.test.mjs']) {
      const source=fs.readFileSync(new URL(name,import.meta.url),'utf8');
      const call=source.match(/const dir = (fs\.mkdtempSync\([^\n]*\));/);
      assert.ok(call,`actual fixture directory call missing: ${name}`);
      const context={fs,path,os,process};
      const scratch=source.match(/const scratch = ([^;\n]+);/);
      if (scratch) context.scratch=vm.runInNewContext(scratch[1],context);
      let created;
      try {
        // Only execute the checked-in fixture's directory expression, not its tests.
        created=vm.runInNewContext(call[1],context);
        assert.equal(path.dirname(created),temporary,`${name} ignores writable TMPDIR`);
        fs.writeFileSync(path.join(created,'synthetic'),'ok');
      } finally { if (created) fs.rmSync(created,{recursive:true,force:true}); }
    }
  } finally {
    if (previous===undefined) delete process.env.TMPDIR; else process.env.TMPDIR=previous;
    fs.rmSync(temporary,{recursive:true,force:true});
  }
});
