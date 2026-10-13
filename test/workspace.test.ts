import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { command, Workspaces } from "../src/workspace.js";
import type { GitHub } from "../src/github.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "agentle-publish-"));
  const remote = join(root, "remote.git"),
    seed = join(root, "seed"),
    workRoot = join(root, "workspaces");
  const git = (dir: string, ...args: string[]) =>
    command(
      [
        "git",
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        ...args,
      ],
      dir,
    );
  await git(root, "init", "--bare", remote);
  await git(root, "clone", remote, seed);
  await git(seed, "checkout", "-b", "main");
  await writeFile(join(seed, "shared.txt"), "base\n");
  await git(seed, "add", "-A");
  await git(seed, "commit", "-m", "base");
  await git(seed, "push", "origin", "main");
  await git(seed, "checkout", "-b", "existing-pr");
  await git(seed, "push", "origin", "existing-pr");
  await mkdir(workRoot);
  const dir = join(workRoot, "19");
  await git(root, "clone", "--branch", "existing-pr", remote, dir);
  await git(dir, "config", "user.name", "Test");
  await git(dir, "config", "user.email", "test@example.com");
  const pushes: string[][] = [];
  class LocalWorkspaces extends Workspaces {
    override async authenticated(args: string[], cwd: string) {
      if (args.includes("push")) pushes.push(args);
      return git(
        cwd,
        ...args.map((a) =>
          a === "https://github.com/owner/repo.git" ? remote : a,
        ),
      );
    }
  }
  const work = new LocalWorkspaces(
    workRoot,
    { config: { repository: "owner/repo" } } as GitHub,
    process.getuid?.() ?? 10001,
  );
  return { root, seed, remote, dir, git, work, pushes };
}

test("existing PR publication preserves local edits and the advanced remote head", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.dir, "local.txt"), "implementation\n");
    await writeFile(join(f.seed, "remote.txt"), "review changes\n");
    await f.git(f.seed, "add", "-A");
    await f.git(f.seed, "commit", "-m", "remote update");
    await f.git(f.seed, "push", "origin", "existing-pr");
    const remoteHead = await f.git(f.seed, "rev-parse", "HEAD");
    await f.work.publish(19, "existing-pr", "main", "job", true);
    await f.git(f.dir, "merge-base", "--is-ancestor", remoteHead, "HEAD");
    assert.equal(
      await readFile(join(f.dir, "local.txt"), "utf8"),
      "implementation\n",
    );
    assert.equal(
      await readFile(join(f.dir, "remote.txt"), "utf8"),
      "review changes\n",
    );
    assert.equal(await f.git(f.dir, "status", "--porcelain"), "");
    const head = await f.git(f.dir, "rev-parse", "HEAD");
    assert.equal(
      await f.git(f.remote, "rev-parse", "refs/heads/existing-pr"),
      head,
    );
    assert.ok(f.pushes.every((args) => !args.some((a) => a.includes("force"))));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("publication conflicts preserve both histories and resume after the agent edits files", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.dir, "shared.txt"), "local implementation\n");
    await writeFile(join(f.seed, "shared.txt"), "remote change\n");
    await f.git(f.seed, "add", "-A");
    await f.git(f.seed, "commit", "-m", "remote update");
    await f.git(f.seed, "push", "origin", "existing-pr");
    const remoteHead = await f.git(f.seed, "rev-parse", "HEAD");
    await assert.rejects(
      f.work.publish(19, "existing-pr", "main", "job", true),
      /Publication paused.*merge conflicts/,
    );
    const localHead = await f.git(f.dir, "rev-parse", "HEAD");
    assert.match(
      await f.git(f.dir, "diff", "--name-only", "--diff-filter=U"),
      /shared.txt/,
    );
    assert.equal(f.pushes.length, 0);
    assert.equal(
      await f.git(f.remote, "rev-parse", "refs/heads/existing-pr"),
      remoteHead,
    );
    // The agent only edits worktree files; the controller stages and commits resolution.
    await writeFile(
      join(f.dir, "shared.txt"),
      "local implementation and remote change\n",
    );
    await f.work.publish(19, "existing-pr", "main", "resolution", true);
    await f.git(f.dir, "merge-base", "--is-ancestor", localHead, "HEAD");
    await f.git(f.dir, "merge-base", "--is-ancestor", remoteHead, "HEAD");
    assert.equal(f.pushes.length, 1);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("new branch publication does not require a pre-existing remote ref", async () => {
  const f = await fixture();
  try {
    await f.git(f.dir, "checkout", "-b", "new-pr");
    await writeFile(join(f.dir, "local.txt"), "implementation\n");
    await f.work.publish(19, "new-pr", "main", "job");
    assert.equal(
      await f.git(f.remote, "rev-parse", "refs/heads/new-pr"),
      await f.git(f.dir, "rev-parse", "HEAD"),
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("Git errors identify the operation without exposing raw diagnostics", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentle-diagnostics-"));
  try {
    const bin = join(root, "git");
    await writeFile(
      bin,
      "#!/bin/sh\necho 'https://secret-token@example.com non-fast-forward' >&2\nexit 1\n",
      { mode: 0o700 },
    );
    await assert.rejects(
      command(["git", "-c", "safe.directory=/tmp", "push"], root, {
        ...process.env,
        PATH: `${root}:${process.env.PATH}`,
      }),
      (error) => {
        assert.match(String(error), /git push failed.*remote branch advanced/);
        assert.ok(!String(error).includes("secret-token"));
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
