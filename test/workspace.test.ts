import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { command, Workspaces } from "../src/workspace.js";
import type { GitHub } from "../src/github.js";

test("workspace baseline detects tracked, staged, untracked and committed changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentle-snapshot-"));
  const dir = join(root, "1");
  try {
    await mkdir(dir);
    await command(["git", "init"], dir);
    await command(["git", "config", "user.name", "Test"], dir);
    await command(["git", "config", "user.email", "test@example.com"], dir);
    await writeFile(join(dir, "tracked"), "original\n");
    await command(["git", "add", "."], dir);
    await command(["git", "commit", "-m", "initial"], dir);
    const work = new Workspaces(root, {} as GitHub);
    const before = await work.snapshot(1);
    assert.equal(await work.snapshot(1), before);
    await writeFile(join(dir, "tracked"), "edited\n");
    assert.notEqual(await work.snapshot(1), before);
    await command(["git", "add", "."], dir);
    assert.notEqual(await work.snapshot(1), before);
    await command(["git", "commit", "-m", "edit"], dir);
    const committed = await work.snapshot(1);
    assert.notEqual(committed, before);
    await writeFile(join(dir, "untracked \n"), "new\n");
    const untracked = await work.snapshot(1);
    assert.notEqual(untracked, committed);
    await writeFile(join(dir, "untracked \n"), "different\n");
    assert.notEqual(await work.snapshot(1), untracked);
  } finally { await rm(root, { recursive: true, force: true }); }
});
