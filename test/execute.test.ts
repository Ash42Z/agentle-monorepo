import { test } from "node:test";
import assert from "node:assert/strict";
import { State } from "../src/state.js";
import { execute } from "../src/execute.js";

function fixture({ merged = false, closedIssue = false, changed = true, closedPR = false } = {}) {
  const state = new State(":memory:");
  state.saveConversation(1, "agentle/1", 10, "saved-thread");
  state.enqueue("old", 1, "original");
  state.update("old", { state: "done", pr: 10 });
  state.enqueue("comment-2", 1, "followup", merged ? 1 : 10);
  const comments: [number, string, string][] = [];
  const branches: string[] = [];
  const resumed: string[] = [];
  const published: number[] = [];
  let ran = false;
  const context = {
    state, cfg: { repository: "Ash42Z/agentle-monorepo", allowedUser: "Ash42Z" },
    gh: {
      async api(path: string, method?: string) {
        if (path === "/issues/1") return { state: closedIssue ? "closed" : "open", title: "Task" };
        if (path === "") return { default_branch: "main" };
        if (path === "/pulls/11") return { state: "open" };
        if (path === "/pulls/10") return { state: merged || closedPR ? "closed" : "open", merged };
        if (path.startsWith("/pulls?")) return merged ? [] : [{ number: 10 }];
        if (path === "/pulls" && method === "POST") return { number: 11 };
        throw Error(path);
      },
      async comment(number: number, id: string, text: string) { comments.push([number, id, text]); },
    },
    work: {
      async prepare() { return "/workspace/1"; }, async refresh() {}, path() { return "/workspace/1"; },
      async changed() { return changed; },
      async snapshot() { return ran && changed ? "after" : "before"; },
      async publish() { published.push(1); },
      async continueFromBase(_number: number, branch: string, base: string) { branches.push(`${branch}:${base}`); },
    },
    async connect() {
      return {
        async rpc(method: string, params?: any) {
          if (method === "thread/resume") resumed.push(params.threadId);
          return {};
        },
        async run(_thread: string, _prompt: string, onPlan?: (text: string) => Promise<void>) {
          ran = true;
          await onPlan?.("I’ll inspect the request, implement it, and verify the changes.");
          return "Implemented and verified.";
        },
      };
    },
  };
  return { state, context, comments, branches, resumed, published };
}

test("PR comments receive a plan and result without repeated issue links", async () => {
  const f = fixture();
  try {
    await execute(f.state.next()!, f.context);
    assert.deepEqual(f.comments.map(c => c[0]), [10, 10]);
    assert.equal(f.state.next(), undefined);
    assert.deepEqual(f.resumed, ["saved-thread"]);
  } finally { f.state.db.close(); }
});

test("followups on a closed issue after merge create another PR and preserve thread and old PR routing", async () => {
  const f = fixture({ merged: true, closedIssue: true });
  try {
    await execute(f.state.next()!, f.context);
    assert.deepEqual(f.branches, ["agentle/1-comment-2:main"]);
    assert.deepEqual(f.resumed, ["saved-thread"]);
    assert.equal(f.state.conversation(1)?.pr, 11);
    assert.equal(f.state.originNumber(10), 1);
    assert.equal(f.state.originNumber(11), 1);
    assert.deepEqual(f.comments.map(c => c[0]), [1, 11, 1]);
    assert.match(f.comments[2][2], /#11/);
  } finally { f.state.db.close(); }
});

test("a merged PR followup with no file changes replies without creating a PR", async () => {
  const f = fixture({ merged: true, changed: false });
  try {
    await execute(f.state.next()!, f.context);
    assert.equal(f.state.conversation(1)?.pr, null);
    assert.deepEqual(f.comments.map(c => c[0]), [1, 1]);
  } finally { f.state.db.close(); }
});

test("publication retry reconciles the new PR link without rerunning implementation", async () => {
  const f = fixture({ merged: true });
  const comment = f.context.gh.comment;
  let fail = true;
  f.context.gh.comment = async (number, id, text) => {
    if (id.endsWith("-link") && fail) { fail = false; throw Error("temporary failure"); }
    await comment(number, id, text);
  };
  try {
    await assert.rejects(execute(f.state.next()!, f.context), /temporary failure/);
    assert.equal(f.state.next()?.state, "publishing");
    // The newly created PR is now discoverable on the remote.
    const api = f.context.gh.api;
    f.context.gh.api = async (path, method) => path.startsWith("/pulls?") ? [{ number: 11 }] : api(path, method);
    await execute(f.state.next()!, f.context);
    assert.deepEqual(f.resumed, ["saved-thread"]);
    assert.equal(f.comments.filter(c => c[1].endsWith("-link")).length, 1);
    assert.equal(f.state.next(), undefined);
  } finally { f.state.db.close(); }
});

for (const closedPR of [false, true]) {
  test(`conversation on ${closedPR ? "closed" : "open"} PR replies at source without publication`, async () => {
    const f = fixture({ changed: false, closedPR });
    try {
      await execute(f.state.next()!, f.context);
      assert.deepEqual(f.comments.map(c => c[0]), [10, 10]);
      assert.deepEqual(f.published, []);
      assert.deepEqual(f.resumed, ["saved-thread"]);
      assert.equal(f.state.next(), undefined);
    } finally { f.state.db.close(); }
  });
}

test("resumption retains the baseline of interrupted work", async () => {
  const f = fixture({ changed: false });
  f.state.set("comment-2-workspace-baseline", "original-before-interruption");
  f.state.update("comment-2", { thread: "interrupted-thread" });
  try {
    await execute(f.state.next()!, f.context);
    assert.deepEqual(f.published, [1]);
    assert.deepEqual(f.resumed, ["interrupted-thread"]);
    assert.equal(f.state.get("comment-2-workspace-baseline"), "original-before-interruption");
  } finally { f.state.db.close(); }
});

test("quota pause stops execution before the agent turn and publication", async () => {
  const f = fixture();
  const connect = f.context.connect;
  f.context.connect = async () => {
    const c = await connect();
    return { ...c, async rpc() { return { rateLimits: { primary: { usedPercent: 100 } } }; } };
  };
  try {
    await execute(f.state.next()!, f.context);
    const waiting = f.state.next(Number.MAX_SAFE_INTEGER)!;
    assert.equal(waiting.state, "waiting");
    assert.equal(waiting.attempts, 1);
    assert.equal(f.state.conversation(1)?.thread, "saved-thread");
    assert.deepEqual(f.resumed, []);
    assert.deepEqual(f.published, []);
    assert.equal(f.comments.length, 1);
    assert.match(f.comments[0][2], /usage limit/);
  } finally { f.state.db.close(); }
});

test("closed PR with local edits reports the blocker without publishing", async () => {
  const f = fixture({ closedPR: true });
  try {
    await execute(f.state.next()!, f.context);
    assert.deepEqual(f.published, []);
    assert.match(f.comments[1][2], /Publication is blocked/);
    assert.equal(f.state.next(), undefined);
  } finally { f.state.db.close(); }
});
