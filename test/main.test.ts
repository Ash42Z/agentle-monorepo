import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

async function fixture({
  auth = "signed-out",
  githubFailure = false,
}: {
  auth?: "signed-out" | "signed-in" | "unavailable";
  githubFailure?: boolean;
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agentle-readiness-"));
  // A root controller starts Codex as UID 10001, just as it does in production.
  chmodSync(dir, 0o755);
  const bin = join(dir, "codex");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const rl = require('readline').createInterface({input:process.stdin});
rl.on('line', line => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  if (${JSON.stringify(auth)} === 'unavailable') return;
  const result = m.method === 'account/read'
    ? {account: ${auth === "signed-in" ? "{type:'chatgpt'}" : "null"}, requiresOpenaiAuth: true}
    : {};
  console.log(JSON.stringify({id:m.id, result}));
});
rl.on('close', () => process.exit(0));
`,
    { mode: 0o755 },
  );
  writeFileSync(join(dir, "admin"), "test-admin-token");
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({
      githubAppId: 1,
      githubInstallationId: 1,
      repository: "owner/repo",
      allowedUser: "owner",
      githubAppSlug: "agentle",
    }),
  );
  const url = (path: string) => pathToFileURL(resolve(path)).href;
  const bootstrap = `
import {Server} from 'node:http';
const listen = Server.prototype.listen;
Server.prototype.listen = function (...args) {
  this.once('listening', () => console.log('TEST_PORT=' + this.address().port));
  return listen.apply(this, args);
};
const {GitHub} = await import(${JSON.stringify(url("src/github.ts"))});
GitHub.prototype.pages = async () => {
  if (${githubFailure}) throw Error('GitHub unavailable');
  return [];
};
await import(${JSON.stringify(url("src/main.ts"))});
`;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", bootstrap],
    {
      env: {
        ...process.env,
        AGENTLE_DATA: join(dir, "data"),
        AGENTLE_CONFIG: join(dir, "config.json"),
        AGENTLE_ADMIN_TOKEN_FILE: join(dir, "admin"),
        AGENTLE_CODEX_HOME: dir,
        AGENTLE_RELEASE: "test-release",
        CODEX_BIN: bin,
        POLL_MS: "25",
        PORT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const lines = createInterface({ input: child.stdout });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const close = async () => {
    lines.close();
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((done) => {
        child.once("exit", () => done());
        child.kill("SIGKILL");
      });
    }
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    const port = await new Promise<number>((done, reject) => {
      const timer = setTimeout(
        () => reject(Error(`Startup timed out: ${stderr}`)),
        5000,
      );
      lines.on("line", (line) => {
        if (line.startsWith("TEST_PORT=")) {
          clearTimeout(timer);
          done(Number(line.split("=")[1]));
        }
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(Error(`Controller exited: ${stderr}`));
      });
    });
    const request = (path: string, authenticated = true) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        headers: authenticated
          ? { Authorization: "Bearer test-admin-token" }
          : {},
        signal: AbortSignal.timeout(1000),
      });
    const status = async (matches: (body: any) => boolean) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const response = await request("/ready");
        const body = await response.json();
        if (matches(body)) return { status: response.status, body };
        await delay(25);
      }
      throw Error(`Expected readiness state not reached: ${stderr}`);
    };
    return { request, status, close };
  } catch (error) {
    await close();
    throw error;
  }
}

test("signed-out Codex does not block deployment readiness but stays visible in worker status", async () => {
  const f = await fixture();
  try {
    const { status, body } = await f.status(
      (body) => body.lastError === "Codex sign-in required",
    );
    assert.equal(status, 200);
    assert.equal(body.ready, true);
    assert.equal(body.authReady, false);
    assert.equal(body.release, "test-release");
    assert.equal(body.activeJobs, 0);
    const admin = await (await f.request("/admin/status")).json();
    assert.equal(admin.ready, true);
    assert.equal(admin.authReady, false);
    const worker = await (await f.request("/api/worker")).json();
    assert.equal(worker.ready, false);
    assert.equal(worker.lastError, "Codex sign-in required");
    assert.equal((await f.request("/ready", false)).status, 401);
  } finally {
    await f.close();
  }
});

test("an unresponsive Codex backend does not delay controller readiness", async () => {
  const f = await fixture({ auth: "unavailable" });
  try {
    const { status, body } = await f.status((body) => body.ready);
    assert.equal(status, 200);
    assert.equal(body.authReady, false);
  } finally {
    await f.close();
  }
});

test("GitHub polling failure still fails readiness even with authenticated Codex", async () => {
  const f = await fixture({ auth: "signed-in", githubFailure: true });
  try {
    const { status, body } = await f.status((body) => body.authReady);
    assert.equal(status, 503);
    assert.equal(body.ready, false);
    assert.equal(body.lastError, "GitHub polling failed");
  } finally {
    await f.close();
  }
});
