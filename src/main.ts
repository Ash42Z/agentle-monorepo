import { readFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { State, classify, quotaDelay, Job } from "./state.js";
import { GitHub } from "./github.js";
import { Codex } from "./codex.js";
import { workerSnapshot, transcript } from "./worker.js";
import { execute } from "./execute.js";
import { Workspaces } from "./workspace.js";
const data = process.env.AGENTLE_DATA ?? "/data";
mkdirSync(data, { recursive: true });
const cfg = JSON.parse(
  readFileSync(process.env.AGENTLE_CONFIG ?? "/config/config.json", "utf8"),
);
const gh = new GitHub(cfg, process.env.AGENTLE_KEY ?? "/config/github-app.pem");
const state = new State(data + "/state.sqlite");
const work = new Workspaces(data + "/workspaces", gh);
const admin = readFileSync(
  process.env.AGENTLE_ADMIN_TOKEN_FILE ?? "/config/admin-token",
  "utf8",
).trim();
const release = process.env.AGENTLE_RELEASE ?? "development";
let draining = state.get("activatedRelease") !== release,
  stopping = false,
  activeJobs = 0,
  ready = false,
  authReady = false,
  lastPoll: string | null = null,
  lastError: string | null = null;
let activeJobId: string | null = null;
let codex: Codex | null = null;
async function connect() {
  if (codex) return codex;
  const c = new Codex(
    process.env.CODEX_BIN ?? "codex",
    process.env.AGENTLE_CODEX_HOME ?? "/codex",
    process.getuid?.() === 0 ? 10001 : undefined,
  );
  c.on("stopped", () => {
    if (codex === c) codex = null;
    authReady = false;
  });
  try {
    await c.init();
    const account = await c.rpc("account/read", { refreshToken: true });
    if (account.account?.type !== "chatgpt")
      throw Error("ChatGPT authentication required; API fallback is disabled");
    authReady = true;
    codex = c;
    return c;
  } catch (error) {
    c.close();
    throw error;
  }
}
async function poll() {
  const since = state.get("pollSince") ?? new Date(0).toISOString();
  const until = new Date().toISOString();
  const issues = await gh.pages(
    "/issues?state=open&sort=updated&direction=asc&since=" +
      encodeURIComponent(since),
  );
  for (const issue of issues) {
    if (issue.user?.login === cfg.allowedUser)
      state.enqueue(
        `issue-${issue.id}`,
        issue.number,
        `${issue.title}\n\n${issue.body ?? ""}`,
      );
  }
  const comments = await gh.pages(
    "/issues/comments?sort=updated&direction=asc&since=" +
      encodeURIComponent(since),
  );
  for (const c of comments) {
    if (c.user?.login === cfg.allowedUser) {
      const n = Number(c.issue_url.split("/").pop());
      const origin = state.originNumber(n);
      state.enqueue(
        `comment-${c.id}-${c.updated_at}`,
        origin,
        c.body,
        n,
      );
    }
  }
  // Review comments and submitted reviews also carry user requests on existing PRs.
  for (const pr of issues.filter((i) => i.pull_request)) {
    for (const c of await gh.pages(`/pulls/${pr.number}/comments`))
      if (c.user?.login === cfg.allowedUser && c.updated_at >= since)
        state.enqueue(
          `review-comment-${c.id}-${c.updated_at}`,
          state.originNumber(pr.number),
          `${c.path}:${c.line ?? c.original_line}\n${c.body}`,
          pr.number,
        );
    for (const r of await gh.pages(`/pulls/${pr.number}/reviews`))
      if (
        r.user?.login === cfg.allowedUser &&
        r.body &&
        r.submitted_at >= since
      )
        state.enqueue(`review-${r.id}`, state.originNumber(pr.number), r.body, pr.number);
  }
  state.set("pollSince", new Date(Date.parse(until) - 120_000).toISOString());
  lastPoll = until;
}
async function tick() {
  try {
    await poll();
    ready = true;
  } catch {
    ready = false;
    lastError = "GitHub polling failed";
  }
  if (!codex)
    try {
      await connect();
    } catch {
      authReady = false;
      lastError = "Codex sign-in required";
    }
  if (draining || stopping) return;
  const job = state.next();
  if (!job) return;
  activeJobs = 1;
  activeJobId = job.id;
  try {
    await execute(job, { gh, state, work, connect, cfg });
    lastError = null;
  } catch (error) {
    const kind = classify(error);
    lastError =
      kind === "auth"
        ? "Codex sign-in required"
        : kind === "quota"
          ? "Waiting for Codex quota"
          : "Job failed; retry scheduled";
    let limits;
    if (kind === "quota")
      try {
        limits = await codex?.rpc("account/rateLimits/read");
      } catch {}
    const current = state.db
      .prepare("SELECT state FROM jobs WHERE id=?")
      .get(job.id) as { state: string };
    state.update(job.id, {
      state: current.state === "publishing" ? "publishing" : "waiting",
      attempts: job.attempts + 1,
      due: quotaDelay(limits, job.attempts),
    });
    if (kind === "auth") {
      authReady = false;
      codex?.close();
      codex = null;
    }
    try {
      await gh.comment(
        job.number,
        job.id + "-" + kind,
        lastError + ". Existing work is preserved.",
      );
    } catch {}
  } finally {
    activeJobs = 0;
    activeJobId = null;
  }
}
const server = createServer(async (req, res) => {
  const supplied = Buffer.from(req.headers.authorization ?? "");
  const expected = Buffer.from("Bearer " + admin);
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  ) {
    res.writeHead(401).end();
    return;
  }
  if (req.method === "GET" && req.url?.startsWith("/api/worker")) {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    if (req.url === "/api/worker") {
      res.end(JSON.stringify({
        ...workerSnapshot(state, cfg.repository, activeJobId),
        state: stopping ? "stopping" : draining ? "draining" : "running",
        ready: ready && authReady, lastError, lastPoll,
      }));
      return;
    }
    const match = /^\/api\/worker\/conversation\/([1-9][0-9]*)$/.exec(req.url);
    const conversation = match ? state.conversation(Number(match[1])) : undefined;
    if (!conversation?.thread) {
      res.writeHead(404).end(JSON.stringify({ error: "Conversation not available" }));
      return;
    }
    try {
      // Read only: fetching a transcript must never resume or start a turn.
      const c = codex;
      if (!c) throw Error("Codex unavailable");
      const result = await c.rpc("thread/read", { threadId: conversation.thread, includeTurns: true });
      res.end(JSON.stringify({ fetchedAt: new Date().toISOString(), messages: transcript(result.thread) }));
    } catch {
      res.writeHead(503).end(JSON.stringify({ error: "Conversation temporarily unavailable; retry when Codex is connected." }));
    }
    return;
  }
  if (req.method === "POST" && req.url === "/admin/drain") draining = true;
  else if (req.method === "POST" && req.url === "/admin/resume") {
    state.set("activatedRelease", release);
    draining = false;
  } else if (
    req.method !== "GET" ||
    !["/admin/status", "/ready"].includes(req.url ?? "")
  ) {
    res.writeHead(404).end();
    return;
  }
  const healthy = ready && authReady;
  res
    .writeHead(req.url === "/ready" && !healthy ? 503 : 200, {
      "Content-Type": "application/json",
    })
    .end(
      JSON.stringify({
        state: draining ? "draining" : "running",
        activeJobs,
        ready: healthy,
        authReady,
        lastPoll,
        lastError,
        release: process.env.AGENTLE_RELEASE ?? "development",
      }),
    );
});
server.listen(Number(process.env.PORT ?? 8080), "0.0.0.0");
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    stopping = true;
    draining = true;
  });
try {
  await connect();
} catch {
  lastError = "Codex sign-in required";
}
while (!stopping) {
  await tick();
  await new Promise((r) =>
    setTimeout(r, Number(process.env.POLL_MS ?? 30_000)),
  );
}
(codex as Codex | null)?.close();
server.close();
state.db.close();
