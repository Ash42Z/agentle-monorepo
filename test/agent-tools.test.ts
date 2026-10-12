import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Codex } from "../src/codex.js";
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


const codexBin = process.env.CODEX_BIN ?? "codex";
test("cold resume refreshes real app-server MCP tools while keeping the saved thread", {
  skip: spawnSync(codexBin, ["--version"], { stdio: "ignore" }).status !== 0,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), "agentle-offline-resume-"));
  const id = randomUUID(), now = new Date().toISOString();
  const sessions = join(home, "sessions", now.slice(0, 4), now.slice(5, 7), now.slice(8, 10));
  await mkdir(sessions, { recursive: true });
  // An offline saved-thread fixture exercises resume without account credentials,
  // model generation, GitHub writes or any production state.
  await writeFile(join(sessions, `rollout-${now.slice(0, 19).replaceAll(":", "-")}-${id}.jsonl`), [
    { timestamp: now, type: "session_meta", payload: { id, timestamp: now, cwd: home, originator: "agentle", cli_version: "0.160.0", source: "cli", model_provider: "openai", base_instructions: { text: "Offline lifecycle test." } } },
    { timestamp: now, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Offline saved conversation" }] } },
  ].map(value => JSON.stringify(value)).join("\n") + "\n");
  const first = await serveTools(async () => ({ bridge: "first" }));
  const current = await serveTools(async () => ({ bridge: "current" }));
  let c = new Codex(codexBin, home);
  const resume = async (bridge: typeof first) => {
    const result = await c.rpc("thread/resume", {
      threadId: id, cwd: home, approvalPolicy: "never", sandbox: "danger-full-access",
      developerInstructions: "Use current GitHub tools.", config: bridge.config,
    });
    assert.equal(result.thread.id, id);
  };
  const read = async () => {
    const result = await c.rpc("mcpServer/tool/call", {
      threadId: id, server: "agentle_github", tool: "github_read", arguments: { path: "/issues/1" },
    });
    return JSON.parse(result.content[0].text).bridge;
  };
  try {
    await c.init();
    await resume(first);
    assert.equal(await read(), "first");
    // The previous job's bridge is gone. A fresh process must attach today's bridge
    // even though it is resuming the same thread from the same workspace.
    await c.stop();
    await first.close();
    c = new Codex(codexBin, home);
    await c.init();
    await resume(current);
    assert.equal(await read(), "current");
  } finally {
    await c.stop();
    await first.close();
    await current.close();
    await rm(home, { recursive: true, force: true });
  }
});
