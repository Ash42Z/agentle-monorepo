import { readFileSync, writeFileSync } from "node:fs";
import { GitHub } from "./github.js";
import { Previews } from "./previews.js";
const cfg = JSON.parse(readFileSync("/config/config.json", "utf8"));
const previews = new Previews(
  new GitHub(cfg, "/config/github-app.pem"),
  "/previews",
);
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    stopping = true;
  });
while (!stopping) {
  try {
    await previews.reconcile();
    writeFileSync(
      "/tmp/preview-ready.json",
      JSON.stringify({
        release: process.env.AGENTLE_RELEASE,
        time: Date.now(),
      }),
    );
  } catch {
    console.error("Preview reconciliation failed; existing previews retained");
  }
  await new Promise((resolve) => setTimeout(resolve, 30_000));
}
