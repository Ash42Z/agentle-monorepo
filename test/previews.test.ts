import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  existsSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { Previews, unpackPreview, validatePreview } from "../src/previews.js";
import { dashboardServer } from "../src/dashboard.js";

const head = "a".repeat(40),
  commit = "b".repeat(40);
const bundle = {
  head,
  commit,
  files: {
    "index.html": Buffer.from("preview dashboard").toString("base64"),
    "songspot/index.html": Buffer.from("game").toString("base64"),
  },
};
function archive(value: unknown = bundle) {
  return Buffer.from(
    zipSync({ "preview.json": Buffer.from(JSON.stringify(value)) }),
  );
}
test("preview artifacts reject mismatched identities, unsafe paths and unexpected ZIP entries", () => {
  assert.deepEqual(unpackPreview(archive(), head), bundle);
  assert.throws(() => unpackPreview(archive(), "c".repeat(40)));
  for (const path of [
    "../index.html",
    "/index.html",
    "a/../../x.js",
    "a//x.js",
    "a.sh",
  ])
    assert.throws(() =>
      validatePreview(
        { ...bundle, files: { ...bundle.files, [path]: "YQ==" } },
        head,
      ),
    );
  assert.throws(() =>
    unpackPreview(Buffer.from(zipSync({ evil: Buffer.from("x") })), head),
  );
});
test("preview reconciliation publishes checked same-repository content, retries links and removes closed PRs", async () => {
  const directory = mkdtempSync(join(tmpdir(), "previews-"));
  const pr = {
    number: 19,
    state: "open",
    base: { ref: "main" },
    head: { sha: head, repo: { full_name: "owner/repo" } },
  };
  let prs = [pr],
    latest = pr,
    success = true,
    commentFails = true,
    downloads = 0,
    comments = 0;
  const gh = {
    config: { repository: "owner/repo" } as any,
    pages: async () => prs,
    api: async (path: string) => {
      if (path.startsWith("/pulls/")) return latest;
      if (path.includes("/artifacts"))
        return {
          artifacts: [{ id: 1, name: "agentle-preview", size_in_bytes: 500 }],
        };
      return {
        workflow_runs: [
          {
            id: 9,
            event: "pull_request",
            path: ".github/workflows/ci.yaml",
            head_sha: head,
            conclusion: success ? "success" : "failure",
            head_repository: { full_name: "owner/repo" },
            pull_requests: [{ number: 19, head: { sha: head } }],
          },
        ],
      };
    },
    artifact: async () => {
      downloads++;
      return archive();
    },
    comment: async () => {
      if (commentFails) throw Error("temporary");
      comments++;
    },
  };
  const previews = new Previews(gh, directory),
    target = join(directory, "19.json");
  try {
    success = false;
    await previews.reconcile();
    assert.equal(existsSync(target), false);
    success = true;
    latest = { ...pr, state: "closed" };
    await previews.reconcile();
    assert.equal(existsSync(target), false);
    latest = { ...pr, head: { ...pr.head, sha: "c".repeat(40) } };
    await previews.reconcile();
    assert.equal(existsSync(target), false);
    latest = pr;
    await previews.reconcile();
    assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), bundle);
    const previous = downloads;
    commentFails = false;
    await previews.reconcile();
    assert.equal(downloads, previous);
    assert.equal(comments, 1);
    prs = [{ ...pr, head: { ...pr.head, sha: "c".repeat(40) } }];
    await previews.reconcile();
    assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), bundle);
    prs = [{ ...pr, head: { ...pr.head, repo: { full_name: "fork/repo" } } }];
    await previews.reconcile();
    assert.equal(existsSync(target), false);
    assert.equal(downloads, previous);
    prs = [pr];
    await previews.reconcile();
    assert.equal(existsSync(target), true);
    prs = [];
    await previews.reconcile();
    assert.equal(existsSync(target), false);
  } finally {
    rmSync(directory, { recursive: true });
  }
});
test("preview serving requires the existing dashboard login and never exposes filesystem paths", async () => {
  const directory = mkdtempSync(join(tmpdir(), "preview-http-"));
  writeFileSync(join(directory, "19.json"), JSON.stringify(bundle));
  const server = dashboardServer({
    token: "controller",
    username: "owner",
    password: "password",
    upstream: "http://unused",
    release: "test",
    previews: directory,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers = {
    Authorization: "Basic " + Buffer.from("owner:password").toString("base64"),
  };
  try {
    assert.equal((await fetch(url + "/previews/pr-19/")).status, 401);
    const response = await fetch(url + "/previews/pr-19/", { headers });
    assert.equal(await response.text(), "preview dashboard");
    assert.equal(response.headers.get("x-agentle-preview-commit"), commit);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(
      await (
        await fetch(url + "/previews/pr-19/songspot/", { headers })
      ).text(),
      "game",
    );
    assert.equal(
      (await fetch(url + "/previews/pr-19/%2e%2e%2fsecret.html", { headers }))
        .status,
      404,
    );
    assert.equal(
      (await fetch(url + "/previews/pr-20/", { headers })).status,
      404,
    );
    assert.equal(
      (
        await fetch(url + "/previews/pr-19/songspot", {
          headers,
          redirect: "manual",
        })
      ).status,
      308,
    );
    rmSync(join(directory, "19.json"));
    assert.equal(
      (await fetch(url + "/previews/pr-19/", { headers })).status,
      404,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true });
  }
});
