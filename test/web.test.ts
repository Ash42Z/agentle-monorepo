import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

test("dashboard authenticates, renders untrusted text safely, fetches snapshots and disconnects", async () => {
  class Element {
    textContent = "";
    value = "";
    children: any[] = [];
    disabled = false;
    href = "";
    onclick: any;
    onsubmit: any;
    append(...children: any[]) { this.children.push(...children); }
    replaceChildren(...children: any[]) { this.children = children; }
  }
  const nodes = new Map<string, Element>();
  const node = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, new Element());
    return nodes.get(id)!;
  };
  const requests: any[] = [];
  const job = { number: 12, pr: 15, state: "running", url: "https://github.com/owner/repo/pull/15", conversationAvailable: true };
  const script = readFileSync("web/index.html", "utf8").split("<script>")[1].split("</script>")[0];
  runInNewContext(script, {
    document: { getElementById: node, createElement: () => new Element(), createTextNode: (text: string) => ({ textContent: text }) },
    setInterval: () => {},
    fetch: async (path: string, options: any) => {
      requests.push({ path, options });
      return { ok: true, status: 200, json: async () => path.includes("conversation")
        ? { fetchedAt: "2026-01-01T00:00:00Z", messages: [{ role: "assistant", text: "<script>untrusted</script>" }] }
        : { state: "running", ready: true, current: job, queue: [{ ...job, state: "queued" }] } };
    },
  });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  node("token").value = "test-token";
  node("auth").onsubmit({ preventDefault() {} });
  await settle();
  assert.equal(requests[0].options.headers.Authorization, "Bearer test-token");
  assert.equal(node("token").value, "");
  assert.equal(node("current").children[0].children[0].textContent, "PR #15 (request #12)");
  assert.equal(node("queue").children.length, 1);
  node("number").value = "12";
  node("conversation-form").onsubmit({ preventDefault() {} });
  await settle();
  assert.equal(requests[1].path, "/api/worker/conversation/12");
  assert.equal(node("messages").children[0].children[1].textContent, "<script>untrusted</script>");
  node("disconnect").onclick();
  assert.equal(node("messages").children.length, 0);
  node("conversation-form").onsubmit({ preventDefault() {} });
  await settle();
  assert.equal(requests.length, 2);
  assert.match(node("snapshot").textContent, /Connect/);
});
