import { chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
export type Job = {
  id: string;
  number: number;
  prompt: string;
  state: string;
  thread: string | null;
  branch: string | null;
  pr: number | null;
  result: string | null;
  due: number;
  attempts: number;
};
export class State {
  db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
  CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,number INTEGER NOT NULL,prompt TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'queued',thread TEXT,branch TEXT,pr INTEGER,result TEXT,due INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS conversations(number INTEGER PRIMARY KEY,branch TEXT NOT NULL,pr INTEGER,thread TEXT);
  PRAGMA user_version=1;`);
    if (path !== ":memory:")
      for (const suffix of ["-wal", "-shm"])
        try {
          chmodSync(path + suffix, 0o600);
        } catch {}
    this.db.exec("UPDATE jobs SET state='queued' WHERE state='running'");
  }
  get(key: string) {
    return (
      this.db.prepare("SELECT value FROM meta WHERE key=?").get(key) as
        | { value: string }
        | undefined
    )?.value;
  }
  set(key: string, value: string) {
    this.db
      .prepare(
        "INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, value);
  }
  enqueue(id: string, number: number, prompt: string) {
    this.db
      .prepare("INSERT OR IGNORE INTO jobs(id,number,prompt) VALUES(?,?,?)")
      .run(id, number, prompt);
  }
  next(now = Date.now()) {
    return this.db
      .prepare(
        "SELECT * FROM jobs j WHERE state IN ('queued','waiting','publishing') AND due<=? AND NOT EXISTS (SELECT 1 FROM jobs earlier WHERE earlier.number=j.number AND earlier.rowid<j.rowid AND earlier.state!='done') ORDER BY rowid LIMIT 1",
      )
      .get(now) as Job | undefined;
  }
  update(id: string, fields: Partial<Job>) {
    const keys = Object.keys(fields);
    if (
      keys.some(
        (k) =>
          ![
            "state",
            "thread",
            "branch",
            "pr",
            "result",
            "due",
            "attempts",
          ].includes(k),
      )
    )
      throw Error("Invalid field");
    this.db
      .prepare(
        `UPDATE jobs SET ${keys.map((k) => `${k}=?`).join(",")} WHERE id=?`,
      )
      .run(...keys.map((k) => (fields as any)[k]), id);
  }
  conversation(number: number) {
    return this.db
      .prepare("SELECT * FROM conversations WHERE number=?")
      .get(number) as
      | { branch: string; pr: number | null; thread: string | null }
      | undefined;
  }
  saveConversation(
    number: number,
    branch: string,
    pr: number | null,
    thread: string | null,
  ) {
    this.db
      .prepare(
        "INSERT INTO conversations VALUES(?,?,?,?) ON CONFLICT(number) DO UPDATE SET branch=excluded.branch,pr=excluded.pr,thread=excluded.thread",
      )
      .run(number, branch, pr, thread);
  }
}
export function quotaDelay(data: any, attempt = 0, now = Date.now()): number {
  const limits = Object.values(
    data?.rateLimitsByLimitId ?? { codex: data?.rateLimits },
  ).filter(Boolean) as any[];
  const resets = limits.flatMap((l) =>
    [l.primary, l.secondary]
      .filter((b) => b?.usedPercent >= 100 && b.resetsAt)
      .map((b) => b.resetsAt * 1000),
  );
  return resets.length
    ? Math.max(now + 60_000, ...resets) + 30_000
    : now + Math.min(3600_000, 60_000 * 2 ** Math.min(attempt, 6));
}
export function exhausted(data: any) {
  return (
    Object.values(
      data?.rateLimitsByLimitId ?? { codex: data?.rateLimits },
    ) as any[]
  ).some(
    (l) =>
      l &&
      (l.rateLimitReachedType ||
        [l.primary, l.secondary].some((b) => b?.usedPercent >= 100)),
  );
}
export function classify(error: unknown) {
  const s =
    JSON.stringify(error, Object.getOwnPropertyNames(error ?? {})) ??
    String(error);
  return /usageLimitExceeded|rateLimitExceeded|usage limit|quota|rate.limit/i.test(
    s,
  )
    ? "quota"
    : /unauthorized|authentication|401|refresh.token|sign.in/i.test(s)
      ? "auth"
      : "retry";
}
