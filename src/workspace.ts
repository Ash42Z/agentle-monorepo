import { spawn } from "node:child_process";
import {
  mkdir,
  chown,
  chmod,
  writeFile,
  rm,
  stat,
  readdir,
  lchown,
} from "node:fs/promises";
import { join } from "node:path";
import type { GitHub } from "./github.js";
export async function command(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(args[0], args.slice(1), {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    p.stdout.on("data", (b) => {
      out += b;
      if (out.length > 4_000_000) p.kill();
    });
    p.stderr.on("data", () => {});
    p.on("error", reject);
    p.on("exit", (code) =>
      code === 0
        ? resolve(out.trim())
        : reject(Error(`${args[0]} ${args[1]} failed (${code})`)),
    );
  });
}
export class Workspaces {
  constructor(
    private root: string,
    private gh: GitHub,
    private uid = 10001,
  ) {}
  path(number: number) {
    return join(this.root, String(number));
  }
  async authenticated(args: string[], cwd: string) {
    const dir = join(this.root, "../git-auth");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const token = await this.gh.installationToken();
    await writeFile(join(dir, "token"), token, { mode: 0o600 });
    const ask = join(dir, "askpass");
    await writeFile(
      ask,
      `#!/bin/sh\ncase "$1" in *Username*) echo x-access-token;; *) cat '${dir}/token';; esac\n`,
      { mode: 0o700 },
    );
    try {
      return await command(
        [
          "git",
          "-c",
          "credential.helper=",
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "core.fsmonitor=false",
          ...args,
        ],
        cwd,
        {
          ...process.env,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
          GIT_ASKPASS: ask,
          GIT_TERMINAL_PROMPT: "0",
        },
      );
    } finally {
      await rm(join(dir, "token"), { force: true });
    }
  }
  async prepare(number: number, branch: string, remoteBranch: string) {
    const dir = this.path(number);
    await mkdir(this.root, { recursive: true });
    let exists = true;
    try {
      await stat(join(dir, ".git"));
    } catch {
      exists = false;
    }
    if (!exists) {
      await this.authenticated(
        [
          "clone",
          "--branch",
          remoteBranch,
          "https://github.com/" + this.gh.config.repository + ".git",
          dir,
        ],
        this.root,
      );
      await command(["git", "checkout", "-B", branch], dir);
      await command(
        ["chown", "-R", String(this.uid) + ":" + String(this.uid), dir],
        this.root,
      );
      await command(["chown", "-R", "0:0", join(dir, ".git")], this.root);
      await chown(dir, 0, 0);
      await chmod(dir, 0o1777);
    }
    await command(
      [
        "git",
        "-c",
        `safe.directory=${dir}`,
        "config",
        "user.name",
        "agentle-app[bot]",
      ],
      dir,
    );
    await command(
      [
        "git",
        "-c",
        `safe.directory=${dir}`,
        "config",
        "user.email",
        "agentle-app[bot]@users.noreply.github.com",
      ],
      dir,
    );
    return dir;
  }
  async refresh(number: number, branch: string) {
    const dir = this.path(number);
    await command(["git", "check-ref-format", "refs/heads/" + branch], dir);
    await this.authenticated(
      [
        "-c",
        `safe.directory=${dir}`,
        "fetch",
        "https://github.com/" + this.gh.config.repository + ".git",
        "refs/heads/" + branch,
      ],
      dir,
    );
    try {
      await command(
        [
          "git",
          "-c",
          `safe.directory=${dir}`,
          "-c",
          "core.hooksPath=/dev/null",
          "merge",
          "--no-edit",
          "FETCH_HEAD",
        ],
        dir,
      );
    } catch {
      /* Leave merge conflicts for Codex to inspect and resolve. */
    }
    const own = async (path: string) => {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        if (entry.name === ".git") continue;
        const child = join(path, entry.name);
        await lchown(child, this.uid, this.uid);
        if (entry.isDirectory()) await own(child);
      }
    };
    await own(dir);
  }
  async changed(number: number, base: string) {
    const dir = this.path(number);
    const args = ["git", "-c", `safe.directory=${dir}`];
    return Boolean(
      (await command([...args, "status", "--porcelain"], dir)) ||
        (await command(
          [...args, "diff", "--name-only", `origin/${base}...HEAD`],
          dir,
        )),
    );
  }
  async publish(number: number, branch: string, base: string, jobId: string) {
    if (branch === base || branch === "main" || branch.startsWith("-"))
      throw Error("Unsafe publishing branch");
    const dir = this.path(number);
    const args = ["git", "-c", `safe.directory=${dir}`];
    await command([...args, "add", "-A"], dir);
    if (await command([...args, "status", "--porcelain"], dir))
      await command(
        [
          ...args,
          "-c",
          "core.hooksPath=/dev/null",
          "commit",
          "-m",
          `Agentle: ${jobId}`,
        ],
        dir,
      );
    // Explicit refspec, no force, no repository hooks, no credential helper.
    await this.authenticated(
      [
        "-c",
        `safe.directory=${dir}`,
        "-c",
        "core.hooksPath=/dev/null",
        "push",
        "https://github.com/" + this.gh.config.repository + ".git",
        `HEAD:refs/heads/${branch}`,
      ],
      dir,
    );
  }
}
