import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Codex } from "../src/codex.js";
test("stdio handshake, streamed completion and classified quota error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentle-rpc-"));
  const bin = join(dir, "fake");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const rl=require('readline').createInterface({input:process.stdin});let initialized=false;let turns=0;const send=x=>console.log(JSON.stringify(x));rl.on('line',line=>{const m=JSON.parse(line);if(m.method==='initialized'){initialized=true;return;}if(m.method==='initialize'){send({id:m.id,result:{}});return;}if(!initialized){send({id:m.id,error:{message:'Not initialized'}});return;}if(m.method==='turn/start'){send({id:m.id,result:{turn:{id:'t'}}});turns++;setTimeout(()=>{if(turns===1){send({method:'item/completed',params:{threadId:'thread',item:{type:'agentMessage',text:'verified'}}});send({method:'turn/completed',params:{threadId:'thread',turn:{status:'completed'}}});}else send({method:'turn/completed',params:{threadId:'thread',turn:{status:'failed',error:{codexErrorInfo:'usageLimitExceeded',message:'quota'}}}});},10);return;}send({id:m.id,result:{ok:true}});});`,
    { mode: 0o700 },
  );
  const c = new Codex(bin, dir);
  try {
    await c.init();
    assert.equal((await c.rpc("account/read")).ok, true);
    assert.equal(await c.run("thread", "first"), "verified");
    await assert.rejects(
      c.run("thread", "second"),
      (e: any) => e.codexErrorInfo === "usageLimitExceeded",
    );
  } finally {
    c.close();
    rmSync(dir, { recursive: true });
  }
});
