import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { unzipSync } from "fflate";
import type { GitHub } from "./github.js";

export const previewLimit = 20_000_000;
export type Preview = {
  head: string;
  commit: string;
  files: Record<string, string>;
};
export function validatePreview(value: any, head: string): Preview {
  if (
    !value ||
    value.head !== head ||
    !/^[a-f0-9]{40}$/.test(value.commit) ||
    !value.files ||
    typeof value.files !== "object" ||
    Array.isArray(value.files)
  )
    throw Error("Invalid preview identity");
  const entries = Object.entries(value.files);
  if (entries.length > 500 || !Object.hasOwn(value.files, "index.html"))
    throw Error("Invalid preview files");
  let size = 0;
  for (const [path, content] of entries) {
    if (
      !/^[a-zA-Z0-9_./-]+\.(html|css|mjs|js|json|svg|png|jpg|jpeg|gif|webp|ico|woff2?)$/.test(
        path,
      ) ||
      path.startsWith("/") ||
      path.split("/").some((p) => !p || p === "." || p === "..") ||
      typeof content !== "string" ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        content,
      )
    )
      throw Error("Invalid preview path or content");
    size += content.length;
    if (size > previewLimit) throw Error("Preview too large");
  }
  return { head: value.head, commit: value.commit, files: value.files };
}
export function unpackPreview(zip: Buffer, head: string) {
  const files = unzipSync(zip, {
    filter: (entry) => {
      if (entry.name !== "preview.json" || entry.originalSize > previewLimit)
        throw Error("Invalid preview archive");
      return true;
    },
  });
  if (!files["preview.json"] || Object.keys(files).length !== 1)
    throw Error("Invalid preview archive");
  return validatePreview(
    JSON.parse(Buffer.from(files["preview.json"]).toString()),
    head,
  );
}

export class Previews {
  constructor(
    private gh: Pick<
      GitHub,
      "pages" | "api" | "artifact" | "comment" | "config"
    >,
    private directory: string,
  ) {
    mkdirSync(directory, { recursive: true });
  }
  async reconcile() {
    const prs = await this.gh.pages("/pulls?state=open&base=main");
    const eligible = prs.filter(
      (pr) =>
        Number.isSafeInteger(pr.number) &&
        pr.number > 0 &&
        /^[a-f0-9]{40}$/.test(pr.head?.sha) &&
        pr.head?.repo?.full_name === this.gh.config.repository,
    );
    const open = new Set(eligible.map((pr) => `${pr.number}.json`));
    // A successful complete listing is required before removing anything.
    for (const file of readdirSync(this.directory))
      if (/^[1-9][0-9]*\.json$/.test(file) && !open.has(file))
        rmSync(`${this.directory}/${file}`);
    for (const pr of eligible) {
      try {
        await this.update(pr);
      } catch {
        console.error(`Preview #${pr.number} update failed; will retry`);
      }
    }
  }
  private async update(pr: any) {
    const target = `${this.directory}/${pr.number}.json`;
    let current: Preview | undefined;
    try {
      current = JSON.parse(readFileSync(target, "utf8"));
    } catch {}
    if (
      !current &&
      readdirSync(this.directory).filter((f) => /^[1-9][0-9]*\.json$/.test(f))
        .length >= 20
    )
      return;
    if (current?.head !== pr.head.sha) {
      const runs = await this.gh.api(
        `/actions/workflows/ci.yaml/runs?event=pull_request&head_sha=${pr.head.sha}&per_page=100`,
      );
      const run = runs.workflow_runs.find(
        (r: any) =>
          r.conclusion === "success" &&
          r.event === "pull_request" &&
          r.path === ".github/workflows/ci.yaml" &&
          r.head_sha === pr.head.sha &&
          r.head_repository?.full_name === this.gh.config.repository &&
          r.pull_requests?.some(
            (p: any) => p.number === pr.number && p.head.sha === pr.head.sha,
          ),
      );
      if (!run) return;
      const artifacts = await this.gh.api(
        `/actions/runs/${run.id}/artifacts?per_page=100`,
      );
      const artifact = artifacts.artifacts.find(
        (a: any) =>
          a.name === "agentle-preview" &&
          !a.expired &&
          a.size_in_bytes <= 30_000_000,
      );
      if (!artifact) return;
      const candidate = unpackPreview(
        await this.gh.artifact(artifact.id),
        pr.head.sha,
      );
      const latest = await this.gh.api(`/pulls/${pr.number}`);
      if (
        latest.state !== "open" ||
        latest.head.sha !== candidate.head ||
        latest.base.ref !== "main" ||
        latest.head.repo?.full_name !== this.gh.config.repository
      )
        return;
      writeFileSync(target + ".tmp", JSON.stringify(candidate), {
        mode: 0o600,
      });
      renameSync(target + ".tmp", target);
      current = candidate;
    }
    // Retried independently of publication so a transient comment failure loses no link.
    await this.gh.comment(
      pr.number,
      `preview-${current!.head}`,
      `Web preview: https://agentle.cc/previews/pr-${pr.number}/\n\nTested merge commit: \`${current!.commit}\` (PR head \`${current!.head}\`). Uses the existing dashboard login and live read-only worker API. Removed automatically after closing or merging. Controller/server changes are not deployed by this preview.`,
    );
  }
}
