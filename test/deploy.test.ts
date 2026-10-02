import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  copyFileSync,
  symlinkSync,
  rmSync,
  readlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
function fixture(mode: string) {
  const root = mkdtempSync(join(tmpdir(), "agentle-deploy-"));
  const bin = join(root, "bin"),
    release = join(root, "new"),
    old = join(root, "old"),
    host = join(root, "host");
  for (const d of [bin, release, old, host, join(release, "scripts")])
    mkdirSync(d, { recursive: true });
  const sha = "a".repeat(40);
  copyFileSync(
    resolve("scripts/deploy.sh"),
    join(release, "scripts/deploy.sh"),
  );
  writeFileSync(join(root, "admin"), "test-token");
  writeFileSync(join(old, "release.env"), "old");
  writeFileSync(join(old, "compose.yaml"), "old");
  symlinkSync(old, join(host, "current"));
  const script = (name: string, body: string) =>
    writeFileSync(join(bin, name), "#!/bin/bash\n" + body, { mode: 0o700 });
  script("git", `echo ${sha}`);
  script(
    "docker",
    `echo "docker $*" >> "$TEST_LOG"\nif [[ "$*" == *"ps --status"* ]]; then echo container;fi\n`,
  );
  script(
    "curl",
    `for url; do :; done\necho "curl $url" >> "$TEST_LOG"\ncase "$url" in\n */admin/status) echo '{"activeJobs":${mode === "timeout" ? 1 : 0}}';;\n */ready) echo '{"ready":${mode === "rollback" ? "false" : "true"},"release":"${sha}"}';;\n *) echo '{}';;\nesac\n`,
  );
  script(
    "python3",
    `if [[ "$1" == "-c" ]]; then exec /usr/bin/python3 "$@"; fi\ncat >/dev/null\n`,
  );
  script("sleep", "exit 0\n");
  const env = {
    ...process.env,
    PATH: bin + ":" + process.env.PATH,
    TEST_LOG: join(root, "log"),
    AGENTLE_DEPLOY_ROOT: host,
    AGENTLE_ADMIN_TOKEN_FILE: join(root, "admin"),
    AGENTLE_DRAIN_TIMEOUT: "0",
    AGENTLE_READY_ATTEMPTS: "1",
  };
  return {
    root,
    old,
    host,
    release,
    run: () =>
      spawnSync("bash", [join(release, "scripts/deploy.sh"), sha], {
        env,
        encoding: "utf8",
        timeout: 10_000,
      }),
  };
}
test("deployment builds before drain and activates healthy exact release", () => {
  const f = fixture("success");
  try {
    const r = f.run();
    assert.equal(r.status, 0, r.stderr);
    const log = readFileSync(join(f.root, "log"), "utf8");
    assert.ok(log.indexOf("docker build") < log.indexOf("/admin/drain"));
    assert.equal(readlinkSync(join(f.host, "current")), f.release);
    assert.equal(readlinkSync(join(f.host, "previous")), f.old);
    assert.ok(log.includes("/admin/resume"));
  } finally {
    rmSync(f.root, { recursive: true });
  }
});
test("drain timeout cancels drain without replacing current container", () => {
  const f = fixture("timeout");
  try {
    const r = f.run();
    assert.notEqual(r.status, 0);
    const log = readFileSync(join(f.root, "log"), "utf8");
    assert.ok(log.includes("/admin/resume"));
    assert.ok(!log.includes("up -d"));
    assert.equal(readlinkSync(join(f.host, "current")), f.old);
  } finally {
    rmSync(f.root, { recursive: true });
  }
});
test("failed readiness restores previous release and resumes processing", () => {
  const f = fixture("rollback");
  try {
    const r = f.run();
    assert.notEqual(r.status, 0);
    const log = readFileSync(join(f.root, "log"), "utf8");
    assert.equal(log.split("up -d").length - 1, 2);
    assert.equal(readlinkSync(join(f.host, "current")), f.old);
    assert.ok(log.includes("/admin/resume"));
  } finally {
    rmSync(f.root, { recursive: true });
  }
});
