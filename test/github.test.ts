import { test } from "node:test";
import assert from "node:assert/strict";
import { GitHub } from "../src/github.js";
test("publication reconciles an existing bot comment after retry, ignoring forged markers", async () => {
  const gh = new GitHub(
    {
      githubAppId: 1,
      githubInstallationId: 1,
      repository: "owner/repo",
      allowedUser: "owner",
      githubAppSlug: "agentle",
    },
    "/unused",
  );
  let comments: any[] = [
    { user: { login: "outsider" }, body: "<!-- agentle:event -->" },
  ];
  let posts = 0;
  gh.pages = async () => comments;
  gh.api = async (_path, method, data: any) => {
    assert.equal(method, "POST");
    posts++;
    comments.push({ user: { login: "agentle[bot]" }, body: data.body });
  };
  await gh.comment(1, "event", "result");
  await gh.comment(1, "event", "retry result");
  assert.equal(posts, 1);
  assert.ok(comments[1].body.includes("result"));
});
