import { test } from "node:test";
import assert from "node:assert/strict";
import { State } from "../src/state.js";
import { workerSnapshot, transcript } from "../src/worker.js";

test("dashboard separates active work and blocked/delayed queue, using conversation PR", () => {
  const s = new State(":memory:");
  try {
    s.enqueue("a", 1, "private prompt");
    s.enqueue("b", 1, "follow up");
    s.enqueue("c", 2, "other request");
    s.saveConversation(1, "branch", 42, "private-thread");
    s.update("a", { state: "running" });
    s.update("c", { state: "waiting", due: 10000 });
    const view = workerSnapshot(s, "Ash42Z/agentle-monorepo", "a", 0);
    assert.equal(view.current?.pr, 42);
    assert.equal(view.current?.conversationAvailable, true);
    assert.deepEqual(view.queue.map(j => [j.id, j.blocked, j.retryAt]), [["b", true, null], ["c", false, "1970-01-01T00:00:10.000Z"]]);
    assert.doesNotMatch(JSON.stringify(view), /private|prompt|branch/);
    s.update("a", { state: "done" });
    assert.equal(workerSnapshot(s, "owner/repo", null, 0).queue[0].blocked, false);
  } finally { s.db.close(); }
});

test("transcripts expose only bounded user and assistant text, excluding tools and metadata", () => {
  const items = [
    { type: "userMessage", content: [{ type: "text", text: "request" }, { type: "image", url: "private" }] },
    { type: "commandExecution", aggregatedOutput: "secret tool output" },
    ...Array.from({ length: 31 }, (_, i) => ({ type: "agentMessage", text: String(i) })),
  ];
  const messages = transcript({ turns: [{ items }] });
  assert.equal(messages.length, 30);
  assert.equal(messages[0].text, "1");
  assert.doesNotMatch(JSON.stringify(messages), /private|secret/);
  assert.deepEqual(transcript({ turns: [{ items: [items[0]] }] }), [{ role: "user", text: "request" }]);
  assert.equal(transcript({ turns: [{ items: [{ type: "agentMessage", text: "x".repeat(21000) }] }] })[0].text.length, 20000);
});
