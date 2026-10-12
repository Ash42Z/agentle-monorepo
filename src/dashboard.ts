import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

export function dashboardServer(options: {
  token: string;
  username: string;
  password: string;
  upstream: string;
  release: string;
  previews?: string;
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
    if (options.previews && req.method === "GET" && req.url?.startsWith("/previews/")) {
      const match = /^\/previews\/pr-([1-9][0-9]*)(\/[^?]*)?(?:\?.*)?$/.exec(req.url);
      if (!match) { res.writeHead(404).end(); return; }
      if (!match[2] || !match[2].endsWith("/") && !match[2].split("/").pop()!.includes(".")) {
        res.writeHead(308, { Location: `/previews/pr-${match[1]}${match[2] ?? ""}/` }).end(); return;
      }
      let path: string;
      try { path = decodeURIComponent(match[2].slice(1)); }
      catch { res.writeHead(404).end(); return; }
      if (path.split("/").some(p => p === ".." || p === ".") || path.includes("\\")) {
        res.writeHead(404).end(); return;
      }
      if (!path || path.endsWith("/")) path += "index.html";
      try {
        const preview = JSON.parse(await readFile(`${options.previews}/${match[1]}.json`, "utf8"));
        if (!Object.hasOwn(preview.files, path)) { res.writeHead(404).end(); return; }
        const types: Record<string, string> = {
          html: "text/html; charset=utf-8", css: "text/css", js: "text/javascript", mjs: "text/javascript",
          json: "application/json", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg",
          jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", ico: "image/x-icon", woff: "font/woff", woff2: "font/woff2",
        };
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("X-Agentle-Preview-Commit", preview.commit);
        res.writeHead(200, { "Content-Type": types[path.split(".").pop()!] ?? "application/octet-stream" });
        res.end(Buffer.from(preview.files[path], "base64"));
      } catch { res.writeHead(404).end(); }
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
