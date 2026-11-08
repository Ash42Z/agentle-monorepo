// Isolated integration test: never joins the production network or publishes a public port.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const webImage = process.argv[2];
assert.ok(webImage, "Usage: node scripts/test-relay.mjs <built-web-image>");
const id = `agentle-relay-test-${randomUUID()}`;
const relay = `${id}-relay`;
const caddy = `${id}-caddy`;
const volume = `${id}-data`;
const dir = mkdtempSync(join(tmpdir(), "agentle-relay-"));
const env = {
  ...process.env,
  AGENTLE_IMAGE: "agentle-test",
  AGENTLE_WEB_IMAGE: webImage,
  AGENTLE_RELEASE: "test",
};
function docker(...args) {
  const result = spawnSync("docker", args, { env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
async function waitForHealth(url) {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok && (await response.text()) === "OK") return;
    } catch {}
    await delay(1000);
  }
  throw Error(`Relay did not become healthy at ${url}`);
}
async function checkWebSocket(url) {
  const { publicKey } = generateKeyPairSync("ed25519");
  const pubkey = publicKey
    .export({ type: "spki", format: "der" })
    .subarray(-32)
    .toString("base64");
  const socket = new WebSocket(url);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error("WebSocket timed out")),
        5000,
      );
      const finish = (error) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({ type: "hello", pubkey }));
      });
      socket.addEventListener("error", () => finish(Error("WebSocket failed")));
      socket.addEventListener("message", ({ data }) => {
        try {
          const challenge = JSON.parse(data);
          assert.equal(challenge.type, "challenge");
          assert.equal(Buffer.from(challenge.nonce, "base64").length, 32);
          finish();
        } catch (error) {
          finish(error);
        }
      });
    });
  } finally {
    socket.close();
  }
}

try {
  const config = JSON.parse(docker("compose", "config", "--format", "json"));
  const service = config.services["remote-pi-relay"];
  assert.ok(!service.ports?.length, "Relay must not publish its backend port");
  assert.ok(service.volumes.some((mount) => mount.target === "/data"));
  docker("network", "create", id);
  docker("volume", "create", volume);
  docker(
    "run",
    "--detach",
    "--name",
    relay,
    "--network",
    id,
    "--network-alias",
    "remote-pi-relay",
    "--mount",
    `type=volume,source=${volume},target=/data`,
    service.image,
  );
  // Only change the listener: all route matchers and handlers are the real config.
  const caddyfile = readFileSync("Caddyfile", "utf8");
  assert.ok(caddyfile.includes("agentle.cc {"));
  writeFileSync(
    join(dir, "Caddyfile"),
    caddyfile.replace("agentle.cc {", "http://:8080 {"),
  );
  docker(
    "run",
    "--detach",
    "--name",
    caddy,
    "--network",
    id,
    "--publish",
    "127.0.0.1::8080",
    "--mount",
    `type=bind,source=${join(dir, "Caddyfile")},target=/etc/caddy/Caddyfile,readonly`,
    webImage,
  );
  const address = docker("port", caddy, "8080/tcp");
  const base = `http://${address}`;
  await waitForHealth(`${base}/remote-pi-relay/health`);
  for (const path of ["/remote-pi-relay", "/remote-pi-relay/"]) {
    await checkWebSocket(`${base.replace("http:", "ws:")}${path}`);
  }
  const mesh = `${base}/remote-pi-relay/mesh/${"0".repeat(64)}`;
  const missing = await fetch(`${mesh}?since=1`);
  assert.equal(missing.status, 404);
  assert.equal(await missing.text(), "not_found");
  const invalid = await fetch(mesh, { method: "POST", body: "not json" });
  assert.equal(invalid.status, 400);
  assert.match(await invalid.text(), /invalid json/);
  assert.equal(
    (await fetch(`${base}/remote-pi-relay-other/health`)).status,
    404,
  );
  docker("restart", relay);
  await waitForHealth(`${base}/remote-pi-relay/health`);
  console.log(
    "Relay health, WebSocket challenge (both URL forms), mesh GET/POST, path boundary and restart checks passed.",
  );
} catch (error) {
  for (const container of [relay, caddy]) {
    spawnSync("docker", ["logs", "--tail", "50", container], {
      stdio: "inherit",
    });
  }
  throw error;
} finally {
  for (const container of [caddy, relay]) {
    spawnSync("docker", ["rm", "--force", "--volumes", container]);
  }
  spawnSync("docker", ["network", "rm", id]);
  spawnSync("docker", ["volume", "rm", volume]);
  rmSync(dir, { recursive: true, force: true });
}
