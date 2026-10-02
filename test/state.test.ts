import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { State, quotaDelay, exhausted, classify } from "../src/state.js";
test("deduplication, durable recovery and publishing checkpoint", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentle-"));
  try {
    let s = new State(join(dir, "db"));
    s.enqueue("a", 1, "first");
    s.enqueue("a", 1, "duplicate");
    assert.equal(s.next()?.prompt, "first");
    s.update("a", {
      state: "running",
      thread: "thread-1",
      branch: "agentle/1",
    });
    s.enqueue("b", 1, "next");
    s.update("b", { state: "publishing", result: "saved result" });
    s.db.close();
    s = new State(join(dir, "db"));
    assert.equal(s.next()?.thread, "thread-1");
    s.update("a", { state: "done" });
    assert.equal(s.next()?.state, "publishing");
    assert.equal(s.next()?.result, "saved result");
    s.db.close();
  } finally {
    rmSync(dir, { recursive: true });
  }
});
test("quota respects every exhausted window and uses bounded backoff", () => {
  const d = {
    rateLimitsByLimitId: {
      codex: {
        primary: { usedPercent: 100, resetsAt: 1000 },
        secondary: { usedPercent: 100, resetsAt: 2000 },
      },
    },
  };
  assert.equal(exhausted(d), true);
  assert.equal(quotaDelay(d, 0, 0), 2030000);
  assert.equal(quotaDelay({}, 20, 0), 3600000);
  assert.equal(
    exhausted({ rateLimits: { primary: { usedPercent: 20 } } }),
    false,
  );
});
test("authentication and quota failures are distinct", () => {
  assert.equal(classify({ codexErrorInfo: "usageLimitExceeded" }), "quota");
  assert.equal(classify(Error("401 unauthorized")), "auth");
  assert.equal(classify(Error("GitHub 503")), "retry");
});
test("a waiting conversation blocks later requests on it, while other conversations proceed", () => {
  const s = new State(":memory:");
  s.enqueue("a", 1, "first");
  s.update("a", { state: "waiting", due: 10000 });
  s.enqueue("b", 1, "second");
  s.enqueue("c", 2, "independent");
  assert.equal(s.next(0)?.id, "c");
  s.update("c", { state: "done" });
  assert.equal(s.next(0), undefined);
  assert.equal(s.next(10000)?.id, "a");
  s.db.close();
});
