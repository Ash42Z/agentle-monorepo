import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

export function dashboardServer(options: {
  token: string;
  username: string;
  password: string;
  upstream: string;
  release: string;
}) {
  if (!options.token.trim() || !options.username.trim() || !options.password.trim())
    throw Error("Dashboard server credentials must be configured");
  const digest = (value: string) => createHash("sha256").update(value).digest();
  const expected = digest("Basic " + Buffer.from(`${options.username}:${options.password}`).toString("base64"));
  return createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    // Internal probe only; Caddy does not expose this path.
    if (req.method === "GET" && req.url === "/health") {
      res.end(options.release);
      return;
    }
    if (!timingSafeEqual(digest(req.headers.authorization ?? ""), expected)) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Agentle dashboard", charset="UTF-8"' }).end();
      return;
    }
    if (req.method !== "GET" || !/^\/api\/worker(?:\/conversation\/[1-9][0-9]*)?$/.test(req.url ?? "")) {
      res.writeHead(404).end();
      return;
    }
    try {
      const response = await fetch(options.upstream + req.url, {
        headers: { Authorization: "Bearer " + options.token },
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
      });
      // Never forward upstream authentication headers or credential-bearing errors.
      if (!response.ok) {
        res.writeHead(response.status === 404 ? 404 : 503).end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(await response.text());
    } catch {
      res.writeHead(503).end();
    }
  });
}
