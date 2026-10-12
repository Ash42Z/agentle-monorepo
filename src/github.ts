import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
export class GitHub {
  token = "";
  expires = 0;
  constructor(
    public config: {
      githubAppId: number;
      githubInstallationId: number;
      repository: string;
      allowedUser: string;
      githubAppSlug: string;
    },
    private keyPath: string,
  ) {}
  async installationToken() {
    if (Date.now() < this.expires) return this.token;
    const enc = (x: object) =>
      Buffer.from(JSON.stringify(x)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const body =
      enc({ alg: "RS256", typ: "JWT" }) +
      "." +
      enc({
        iat: now - 60,
        exp: now + 540,
        iss: String(this.config.githubAppId),
      });
    const jwt =
      body +
      "." +
      sign(
        "RSA-SHA256",
        Buffer.from(body),
        createPrivateKey(readFileSync(this.keyPath)),
      ).toString("base64url");
    const r = await this.raw(
      `/app/installations/${this.config.githubInstallationId}/access_tokens`,
      "POST",
      {
        permissions: {
          contents: "write",
          issues: "write",
          pull_requests: "write",
          workflows: "write",
          actions: "read",
        },
      },
      jwt,
    );
    this.token = r.token;
    this.expires = Date.parse(r.expires_at) - 300_000;
    return this.token;
  }
  async raw(
    path: string,
    method: string,
    data: unknown,
    token: string,
  ): Promise<any> {
    const response = await fetch("https://api.github.com" + path, {
      method,
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: data === undefined ? undefined : JSON.stringify(data),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok)
      throw Error(`GitHub ${method} ${path.split("?")[0]}: ${response.status}`);
    return response.status === 204 ? null : response.json();
  }
  async api(path: string, method = "GET", data?: unknown) {
    return this.raw(
      "/repos/" + this.config.repository + path,
      method,
      data,
      await this.installationToken(),
    );
  }
  async artifact(id: number): Promise<Buffer> {
    const response = await fetch(`https://api.github.com/repos/${this.config.repository}/actions/artifacts/${id}/zip`, {
      headers: { Authorization: "Bearer " + await this.installationToken() },
      redirect: "manual", signal: AbortSignal.timeout(30_000),
    });
    const location = response.headers.get("location");
    if (response.status !== 302 || !location || new URL(location).protocol !== "https:")
      throw Error("Artifact download unavailable");
    // The signed storage URL needs no GitHub credential.
    const download = await fetch(location, { signal: AbortSignal.timeout(30_000) });
    if (!download.ok || Number(download.headers.get("content-length")) > 30_000_000)
      throw Error("Artifact download rejected");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of download.body!) {
      size += chunk.length;
      if (size > 30_000_000) throw Error("Artifact too large");
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  async pages(path: string) {
    let out: any[] = [];
    for (let page = 1; ; page++) {
      const values = await this.api(
        path + (path.includes("?") ? "&" : "?") + `per_page=100&page=${page}`,
      );
      out.push(...values);
      if (values.length < 100) return out;
    }
  }
  async comment(number: number, id: string, text: string) {
    const marker = `<!-- agentle:${id} -->`;
    const existing = (await this.pages(`/issues/${number}/comments`)).find(
      (c) =>
        c.user?.login === this.config.githubAppSlug + "[bot]" &&
        c.body?.includes(marker),
    );
    if (existing) return;
    await this.api(`/issues/${number}/comments`, "POST", {
      body: text.slice(0, 60_000) + "\n\n" + marker,
    });
  }
}
