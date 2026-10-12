import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { githubTools, serveTools } from "../src/agent-tools.js";

test("stdio MCP adapter discovers tools and carries repeated calls without GitHub credentials", async () => {
  const calls: string[] = [];
  const bridge = await serveTools(async (name, args) => { calls.push(name); return { received: args }; });
  const config = bridge.config["mcp_servers.agentle_github"];
  const child = spawn(config.command, config.args, { env: { PATH: process.env.PATH, ...config.env }, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map<number, (value: any) => void>();
  createInterface({ input: child.stdout }).on("line", line => { const m = JSON.parse(line); pending.get(m.id)?.(m); pending.delete(m.id); });
  let id = 0;
  const rpc = (method: string, params: unknown = {}) => new Promise<any>((resolve, reject) => {
    const seq = ++id;
    const timer = setTimeout(() => reject(Error("MCP adapter timed out")), 5000);
    pending.set(seq, value => { clearTimeout(timer); resolve(value); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: seq, method, params }) + "\n");
  });
  try {
    assert.equal((await rpc("initialize", { protocolVersion: "2024-11-05" })).result.serverInfo.name, "agentle-github");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    assert.deepEqual((await rpc("tools/list")).result.tools, githubTools);
    for (const name of ["github_read", "github_comment", "github_publish", "github_comment"]) {
      const result = await rpc("tools/call", { name, arguments: { example: true } });
      assert.deepEqual(JSON.parse(result.result.content[0].text), { received: { example: true } });
    }
    assert.deepEqual(calls, ["github_read", "github_comment", "github_publish", "github_comment"]);
    assert.deepEqual(Object.keys(config.env).sort(), ["AGENTLE_TOOL_BEARER", "AGENTLE_TOOL_ENDPOINT"]);
  } finally { child.kill(); await bridge.close(); }
});

test("bridge rejects unauthorized access and serializes actions", async () => {
  let active = 0, maxActive = 0;
  const bridge = await serveTools(async () => {
    active++; maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 10));
    active--; return { ok: true };
  });
  const env = bridge.config["mcp_servers.agentle_github"].env;
  try {
    assert.equal((await fetch(env.AGENTLE_TOOL_ENDPOINT, { method: "POST" })).status, 401);
    await Promise.all([1, 2].map(() => fetch(env.AGENTLE_TOOL_ENDPOINT, {
      method: "POST", headers: { Authorization: `Bearer ${env.AGENTLE_TOOL_BEARER}` },
      body: JSON.stringify({ method: "tools/call", params: { name: "github_read", arguments: {} } }),
    }).then(response => response.json())));
    assert.equal(maxActive, 1);
  } finally { await bridge.close(); }
});
