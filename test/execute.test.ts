import { test } from "node:test";
import assert from "node:assert/strict";
import { State } from "../src/state.js";
import { execute } from "../src/execute.js";

function fixture({ source = 19, closed = false, changed = true } = {}) {
  const state = new State(":memory:");
  state.saveConversation(19, "agentle/19", 20, "saved-thread");
  state.enqueue("comment-2", 19, "followup", source);
  const comments: [number, string, string][] = [];
  const switches: string[] = [], resumes: string[] = [], publications: string[] = [];
  const reads: string[] = [];
  let config: any, prompt = "", created = false;
  const connections: boolean[] = [];
  const instructions: string[] = [];
  const reconciliations: boolean[] = [];
  const injections: any[] = [];
  let run: (call: (name: string, args: any) => Promise<any>) => Promise<string> = async () => "Verified.";
  const context = {
    state, cfg: { repository: "Ash42Z/agentle-monorepo", allowedUser: "Ash42Z" },
    gh: {
      async api(path: string, method?: string, data?: any): Promise<any> {
        reads.push(path);
        if (path === "/issues/19") return { state: "open", title: "Task" };
        if (path === "/issues/19/comments") return [{ body: "Issue context" }];
        if (path === "") return { default_branch: "main" };
        if (path === "/pulls/20") return { state: closed ? "closed" : "open", merged: closed, head: { ref: "agentle/19", repo: { full_name: "Ash42Z/agentle-monorepo" } } };
        if (path === "/pulls/21") return { state: "open", head: { ref: "existing", repo: { full_name: "Ash42Z/agentle-monorepo" } } };
        if (path.startsWith("/pulls?")) return path.endsWith(":agentle/19") ? [{ number: 20 }] : created ? [{ number: 22 }] : [];
        if (path === "/pulls" && method === "POST") { assert.equal(data.draft, true); created = true; return { number: 22 }; }
        throw Error(path);
      },
      async comment(number: number, id: string, text: string) {
        if (!comments.some(c => c[1] === id && c[0] === number)) comments.push([number, id, text]);
      },
    },
    work: {
      async prepare() { return "/workspace/19"; }, async refresh() {}, path() { return "/workspace/19"; },
      async changed() { return changed; }, async publish(_number: number, branch: string, _base: string, _job: string, reconcile = false) { publications.push(branch); reconciliations.push(reconcile); },
      async continueFromBase(_number: number, branch: string, base: string) { switches.push(`${branch}:${base}`); },
    },
    async connect(fresh = false) {
      connections.push(fresh);
      return {
        async rpc(method: string, params?: any) {
          if (method === "thread/inject_items") injections.push(params);
          if (method === "thread/resume") { resumes.push(params.threadId); instructions.push(params.developerInstructions); config = params.config["mcp_servers.agentle_github"]; }
          return {};
        },
        async run(_thread: string, text: string) {
          assert.equal(injections.at(-1)?.threadId, _thread);
          prompt = text;
          return run(async (name, args) => {
            const response = await fetch(config.env.AGENTLE_TOOL_ENDPOINT, {
              method: "POST", headers: { Authorization: `Bearer ${config.env.AGENTLE_TOOL_BEARER}` },
              body: JSON.stringify({ method: "tools/call", params: { name, arguments: args } }),
            });
            return response.json();
          });
        },
      };
    },
  };
  return { state, context, comments, switches, resumes, publications, reads, connections, instructions, injections, reconciliations, setRun(fn: typeof run) { run = fn; }, prompt: () => prompt };
}

test("issue replies stay on issue even with an associated PR; no automatic publication", async () => {
  const f = fixture();
  try {
    await execute(f.state.next()!, f.context);
    assert.deepEqual(f.comments.map(c => c[0]), [19]);
    assert.deepEqual(f.publications, []);
    assert.match(f.prompt(), /Source issue\/PR #19.*associated PR #20/);
    assert.deepEqual(f.resumes, ["saved-thread"]);
    assert.equal(f.state.next(), undefined);
  } finally { f.state.db.close(); }
});

test("PR requests retain their source", async () => {
  const f = fixture({ source: 20 });
  try {
    await execute(f.state.next()!, f.context);
    assert.deepEqual(f.comments.map(c => c[0]), [20]);
    assert.match(f.prompt(), /Source issue\/PR #20/);
  } finally { f.state.db.close(); }
});

test("agent reads issue context, comments, publishes existing PR and comments again", async () => {
  const f = fixture();
  f.setRun(async call => {
    const result = await call("github_read", { path: "/issues/19/comments" });
    assert.match(result.content[0].text, /Issue context/);
    await call("github_comment", { number: 19, key: "plan", body: "Starting." });
    assert.deepEqual(f.comments.map(c => c[0]), [19]);
    assert.deepEqual(f.publications, []);
    assert.equal((await call("github_publish", { title: "Change", body: "Description" })).isError, undefined);
    await call("github_comment", { number: 19, key: "result", body: "Verified; see #20." });
    await call("github_comment", { number: 20, key: "review", body: "Ready for review." });
    return "Done.";
  });
  try {
    await execute(f.state.next()!, f.context);
    assert.deepEqual(f.comments.map(c => c[0]), [19, 19, 20]);
    assert.deepEqual(f.publications, ["agentle/19"]);
    assert.deepEqual(f.reconciliations, [true]);
    assert.equal(f.state.conversation(19)?.thread, "saved-thread");
  } finally { f.state.db.close(); }
});

test("closed PR does not block discussion; agent chooses a new PR when needed", async () => {
  const f = fixture({ closed: true });
  f.setRun(async call => {
    assert.equal((await call("github_publish", { title: "Followup", body: "More work" })).isError, true);
    await call("github_workspace", { pr: null, key: "followup" });
    const result = await call("github_publish", { title: "Followup", body: "More work" });
    assert.match(result.content[0].text, /"pr":22/);
    await call("github_comment", { number: 19, key: "result", body: "See #22." });
    return "Done.";
  });
  try {
    await execute(f.state.next()!, f.context);
    assert.deepEqual(f.switches, ["agentle/19-comment-2-followup:main"]);
    assert.equal(f.state.conversation(19)?.pr, 22);
    assert.deepEqual(f.reconciliations, [false]);
    assert.equal(f.state.conversation(19)?.thread, "saved-thread");
    assert.equal(f.state.originNumber(22), 19);
    assert.deepEqual(f.comments.map(c => c[0]), [19]);
  } finally { f.state.db.close(); }
});

test("agent can select another existing PR without merging default branch into it", async () => {
  const f = fixture();
  f.setRun(async call => {
    await call("github_workspace", { pr: 21, key: "existing" });
    await call("github_publish", { title: "Update", body: "Existing work" });
    return "Verified.";
  });
  try {
    await execute(f.state.next()!, f.context);
    assert.deepEqual(f.switches, ["existing:existing"]);
    assert.deepEqual(f.publications, ["existing"]);
    assert.equal(f.state.conversation(19)?.pr, 21);
  } finally { f.state.db.close(); }
});

test("interruption preserves thread and workspace; repeated comment key is idempotent", async () => {
  const f = fixture();
  f.setRun(async call => {
    await call("github_comment", { number: 19, key: "plan", body: "Starting." });
    throw Error("interrupted");
  });
  try {
    await assert.rejects(execute(f.state.next()!, f.context), /interrupted/);
    assert.equal(f.state.conversation(19)?.thread, "saved-thread");
    assert.equal(f.state.conversation(19)?.branch, "agentle/19");
    f.state.update("comment-2", { state: "waiting" });
    f.setRun(async call => {
      await call("github_comment", { number: 19, key: "plan", body: "Starting." });
      await call("github_comment", { number: 19, key: "result", body: "Resumed and verified." });
      return "Done.";
    });
    await execute(f.state.next()!, f.context);
    assert.equal(f.comments.length, 2);
    assert.deepEqual(f.resumes, ["saved-thread", "saved-thread"]);
  } finally { f.state.db.close(); }
});

test("read tools reject paths outside repository state and unknown actions", async () => {
  const f = fixture();
  f.setRun(async call => {
    for (const path of ["/installation", "/issues/../../installation", "/issues/%2e%2e/secrets", "https://example.com", "/issues/19#fragment"]) {
      assert.equal((await call("github_read", { path })).isError, true);
      assert.ok(!f.reads.includes(path));
    }
    assert.equal((await call("merge", {})).isError, true);
    return "Verified.";
  });
  try { await execute(f.state.next()!, f.context); } finally { f.state.db.close(); }
});

test("dirty workspace failure leaves conversation attached to its original branch", async () => {
  const f = fixture();
  f.context.work.continueFromBase = async () => { throw Error("Cannot start a followup branch with uncommitted work"); };
  f.setRun(async call => {
    assert.equal((await call("github_workspace", { pr: null, key: "new" })).isError, true);
    assert.equal(f.state.conversation(19)?.branch, "agentle/19");
    return "Saved work needs inspection.";
  });
  try { await execute(f.state.next()!, f.context); } finally { f.state.db.close(); }
});

test("previous release publishing jobs finish without resuming implementation and reply at source", async () => {
  const f = fixture();
  f.state.update("comment-2", { state: "publishing", result: "Saved result" });
  try {
    await execute(f.state.next()!, f.context);
    assert.deepEqual(f.resumes, []);
    assert.deepEqual(f.publications, ["agentle/19"]);
    assert.deepEqual(f.comments.map(c => c[0]), [19]);
    assert.equal(f.state.next(), undefined);
  } finally { f.state.db.close(); }
});

test("multiple publications can occur within a turn and failed PR creation reconciles on retry", async () => {
  const f = fixture();
  const api = f.context.gh.api;
  let fail = true;
  f.context.gh.api = async (path, method, data) => {
    const result = await api(path, method, data);
    if (path === "/pulls" && method === "POST" && fail) { fail = false; throw Error("response lost after PR creation"); }
    return result;
  };
  f.setRun(async call => {
    await call("github_workspace", { pr: null, key: "new" });
    assert.equal((await call("github_publish", { title: "New PR", body: "Details" })).isError, true);
    assert.match((await call("github_publish", { title: "New PR", body: "Details" })).content[0].text, /"pr":22/);
    // Additional local work can be published again in this same turn.
    await call("github_publish", { title: "New PR", body: "Details" });
    return "Verified.";
  });
  // Fixture exposes the created PR for subsequent publication validation.
  f.context.gh.api = ((previous) => async (path, method, data) => path === "/pulls/22" ? { state: "open" } : previous(path, method, data))(f.context.gh.api);
  try {
    await execute(f.state.next()!, f.context);
    assert.equal(f.publications.length, 3);
    assert.equal(f.reads.filter(path => path === "/pulls").length, 1);
    assert.equal(f.state.conversation(19)?.pr, 22);
  } finally { f.state.db.close(); }
});

test("no-change publication creates no PR", async () => {
  const f = fixture({ changed: false });
  f.setRun(async call => {
    await call("github_workspace", { pr: null, key: "new" });
    assert.match((await call("github_publish", { title: "Discussion", body: "No code needed" })).content[0].text, /"changed":false/);
    return "Answered.";
  });
  try {
    await execute(f.state.next()!, f.context);
    assert.deepEqual(f.publications, []);
    assert.equal(f.state.conversation(19)?.pr, null);
  } finally { f.state.db.close(); }
});

test("failed final delivery retries without rerunning the completed agent", async () => {
  const f = fixture();
  const comment = f.context.gh.comment;
  let fail = true;
  f.context.gh.comment = async (number, id, text) => {
    if (fail) { fail = false; throw Error("temporary GitHub failure"); }
    await comment(number, id, text);
  };
  try {
    await assert.rejects(execute(f.state.next()!, f.context), /temporary GitHub failure/);
    f.state.update("comment-2", { state: "waiting" });
    await execute(f.state.next()!, f.context);
    assert.deepEqual(f.resumes, ["saved-thread"]);
    assert.deepEqual(f.comments.map(c => c[0]), [19]);
    assert.equal(f.state.next(), undefined);
  } finally { f.state.db.close(); }
});

test("quota waits keep source, thread and workspace", async () => {
  const f = fixture({ source: 20 });
  const connect = f.context.connect;
  f.context.connect = async () => {
    const c = await connect();
    c.rpc = async method => method === "account/rateLimits/read" ? { rateLimits: { primary: { usedPercent: 100 } } } : {};
    return c;
  };
  try {
    await execute(f.state.next()!, f.context);
    assert.deepEqual(f.comments.map(c => c[0]), [20]);
    assert.equal(f.state.conversation(19)?.thread, "saved-thread");
    assert.equal(f.state.conversation(19)?.branch, "agentle/19");
    assert.equal(f.state.next(), undefined);
  } finally { f.state.db.close(); }
});


test("every job cold-resumes the saved thread with current publication instructions", async () => {
  const f = fixture();
  f.setRun(async call => {
    assert.equal((await call("github_publish", {})).isError, undefined);
    return "Verified.";
  });
  try {
    await execute(f.state.next()!, f.context);
    f.state.enqueue("comment-3", 19, "Another update", 19);
    await execute(f.state.next()!, f.context);
    assert.deepEqual(f.connections, [true, true]);
    assert.deepEqual(f.resumes, ["saved-thread", "saved-thread"]);
    assert.deepEqual(f.publications, ["agentle/19", "agentle/19"]);
    assert.equal(f.reads.filter(path => path === "/pulls").length, 0);
    for (const instructions of f.instructions) {
      assert.match(instructions, /You decide.*create a new PR or update an existing PR/);
      assert.match(instructions, /github_publish performs the commit and push immediately/);
      assert.match(instructions, /does not publish automatically when your turn ends/);
    }
  } finally { f.state.db.close(); }
});

test("new PR publication needs metadata and does not push when it is missing", async () => {
  const f = fixture();
  f.setRun(async call => {
    await call("github_workspace", { pr: null, key: "new" });
    const result = await call("github_publish", {});
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Supply title and body/);
    assert.deepEqual(f.publications, []);
    return "Metadata needed.";
  });
  try { await execute(f.state.next()!, f.context); } finally { f.state.db.close(); }
});


test("resumed conversations receive current controller-tool authorization in developer history", async () => {
  const f = fixture();
  try {
    await execute(f.state.next()!, f.context);
    assert.equal(f.injections.length, 1);
    const injection = f.injections[0];
    assert.equal(injection.threadId, "saved-thread");
    assert.equal(injection.items[0].role, "developer");
    const policy = injection.items[0].content[0].text;
    assert.match(policy, /supersedes older publication instructions/);
    assert.match(policy, /authorized to invoke.*github_publish/);
    assert.match(policy, /This tool is the controller/);
    assert.match(policy, /Never merge, push to the default branch, access controller credentials/);
    assert.equal(f.state.conversation(19)?.thread, "saved-thread");
  } finally { f.state.db.close(); }
});

test("failed policy injection preserves the saved thread and never starts an unauthorized turn", async () => {
  const f = fixture();
  const connect = f.context.connect;
  f.context.connect = async (fresh = false) => {
    const c = await connect(fresh), rpc = c.rpc;
    c.rpc = async (method, params) => {
      if (method === "thread/inject_items") throw Error("Policy injection unavailable");
      return rpc(method, params);
    };
    return c;
  };
  f.setRun(async () => { assert.fail("Should not start generation without current policy"); });
  try {
    await assert.rejects(execute(f.state.next()!, f.context), /Policy injection unavailable/);
    assert.equal(f.state.conversation(19)?.thread, "saved-thread");
    assert.equal(f.state.conversation(19)?.branch, "agentle/19");
    assert.deepEqual(f.publications, []);
  } finally { f.state.db.close(); }
});
