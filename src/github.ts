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
