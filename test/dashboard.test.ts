import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { dashboardServer } from "../src/dashboard.js";
async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
test("dashboard authenticates and limits proxy access without exposing controller credentials", async () => {
  const calls: { path: string; auth: string | undefined }[] = [];
  const upstream = createServer((req, res) => {
    calls.push({ path: req.url!, auth: req.headers.authorization });
    if (req.url?.endsWith("/9")) res.writeHead(401, { "WWW-Authenticate": "secret" }).end("server-token");
    else res.end(JSON.stringify({ ready: true }));
  });
  const origin = await listen(upstream);
  const backend = dashboardServer({ token: "server-token", username: "owner", password: "password", upstream: origin, release: "release" });
  const url = await listen(backend);
  const headers = { Authorization: "Basic " + Buffer.from("owner:password").toString("base64") };
  try {
    for (const authorization of [undefined, "Bearer server-token", "Basic wrong"]) {
      const response = await fetch(url + "/api/worker", { headers: authorization ? { Authorization: authorization } : {} });
      assert.equal(response.status, 401);
      assert.match(response.headers.get("www-authenticate")!, /Basic/);
    }
    assert.equal(calls.length, 0);
    for (const path of ["/admin/drain", "/ready", "/api/worker?x=1", "/api/worker/conversation/../admin", "/api/worker/conversation/0"]) {
      assert.equal((await fetch(url + path, { headers })).status, 404);
    }
    assert.equal((await fetch(url + "/api/worker", { headers, method: "POST" })).status, 404);
    assert.equal(calls.length, 0);
    const response = await fetch(url + "/api/worker", { headers });
    assert.deepEqual(await response.json(), { ready: true });
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(calls[0], { path: "/api/worker", auth: "Bearer server-token" });
    assert.equal((await fetch(url + "/api/worker/conversation/12", { headers })).status, 200);
    const failed = await fetch(url + "/api/worker/conversation/9", { headers });
    assert.equal(failed.status, 503);
    assert.equal(failed.headers.get("www-authenticate"), null);
    assert.equal(await failed.text(), "");
    assert.equal(await (await fetch(url + "/health")).text(), "release");
    await close(upstream);
    assert.equal((await fetch(url + "/api/worker", { headers })).status, 503);
  } finally {
    await close(backend);
    if (upstream.listening) await close(upstream);
  }
});
test("dashboard refuses empty secrets", () => {
  assert.throws(() => dashboardServer({ token: "", username: "owner", password: "password", upstream: "http://bot:8080", release: "test" }), /credentials/);
  assert.throws(() => dashboardServer({ token: "token", username: "owner", password: " ", upstream: "http://bot:8080", release: "test" }), /credentials/);
});
