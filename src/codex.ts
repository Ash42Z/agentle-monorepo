import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
export class Codex extends EventEmitter {
  child: ChildProcessWithoutNullStreams;
  seq = 0;
  pending = new Map<
    number,
    {
      resolve: (v: any) => void;
      reject: (v: any) => void;
      timer: NodeJS.Timeout;
    }
  >();
  constructor(bin: string, home: string, uid?: number) {
    super();
    this.child = spawn(bin, ["app-server", "--listen", "stdio://"], {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        CODEX_HOME: home,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "safe.directory",
        GIT_CONFIG_VALUE_0: "*",
      },
      ...(uid === undefined ? {} : { uid, gid: uid }),
    });
    this.child.stderr.on("data", () => {});
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      let m: any;
      try {
        m = JSON.parse(line);
      } catch {
        return;
      }
      if (m.id !== undefined && m.method) {
        this.child.stdin.write(
          JSON.stringify({
            id: m.id,
            error: {
              code: -32601,
              message:
                "Interactive requests are unavailable; report the blocker.",
            },
          }) + "\n",
        );
        return;
      }
      if (m.id !== undefined) {
        const p = this.pending.get(m.id);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(m.id);
          m.error ? p.reject(m.error) : p.resolve(m.result);
        }
      } else this.emit("notification", m);
    });
    const fail = () => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(Error("Codex process exited"));
      }
      this.pending.clear();
      this.emit("stopped");
    };
    this.child.on("exit", fail);
    this.child.on("error", fail);
  }
  rpc(method: string, params: unknown = {}) {
    const id = ++this.seq;
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Error("Codex request timed out: " + method));
      }, 120_000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }
  async init() {
    await this.rpc("initialize", {
      clientInfo: { name: "agentle", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.child.stdin.write('{"method":"initialized"}\n');
  }
  async run(threadId: string, prompt: string) {
    return new Promise<string>(async (resolve, reject) => {
      let text = "";
      const timer = setTimeout(() => {
        this.close();
        finish(Error("Turn exceeded 6 hours"));
      }, 6 * 3600_000);
      const stopped = () => finish(Error("Codex process exited"));
      const handler = (m: any) => {
        if (m.params?.threadId !== threadId) return;
        if (
          m.method === "item/completed" &&
          m.params.item.type === "agentMessage"
        )
          text = m.params.item.text;
        if (m.method === "turn/completed") {
          const t = m.params.turn;
          t.status === "completed"
            ? finish(null, text)
            : finish(t.error ?? Error("Turn interrupted"));
        }
      };
      const finish = (error: unknown, value = "") => {
        clearTimeout(timer);
        this.off("notification", handler);
        this.off("stopped", stopped);
        error ? reject(error) : resolve(value);
      };
      this.on("notification", handler);
      this.on("stopped", stopped);
      try {
        await this.rpc("turn/start", {
          threadId,
          input: [{ type: "text", text: prompt, text_elements: [] }],
        });
      } catch (e) {
        finish(e);
      }
    });
  }
  close() {
    this.child.kill("SIGTERM");
  }
}
