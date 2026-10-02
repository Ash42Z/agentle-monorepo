import { State } from "./state.js";

// Only expose display fields; prompts, results and internal thread IDs stay private.
export function workerSnapshot(state: State, repository: string, activeId: string | null, now = Date.now()) {
  const jobs = state.db.prepare(`SELECT j.id,j.number,j.state,j.due,
    COALESCE(j.pr,c.pr) AS pr,
    EXISTS(SELECT 1 FROM jobs earlier WHERE earlier.number=j.number
      AND earlier.rowid<j.rowid AND earlier.state!='done') AS blocked
    FROM jobs j LEFT JOIN conversations c ON c.number=j.number
    WHERE j.state!='done' ORDER BY j.rowid`).all();
  const display = (j: any) => ({
    id: j.id, number: j.number, pr: j.pr, state: j.state,
    retryAt: j.due > now ? new Date(j.due).toISOString() : null,
    blocked: Boolean(j.blocked),
    url: `https://github.com/${repository}/${j.pr ? "pull" : "issues"}/${j.pr ?? j.number}`,
    conversationAvailable: Boolean(state.conversation(j.number)?.thread),
  });
  return {
    current: jobs.find((j: any) => j.id === activeId) ? display(jobs.find((j: any) => j.id === activeId)) : null,
    queue: jobs.filter((j: any) => j.id !== activeId).map(display),
  };
}

export function transcript(thread: any) {
  const messages: { role: string; text: string }[] = [];
  for (const turn of thread?.turns ?? []) {
    for (const item of turn.items ?? []) {
      if (item.type === "agentMessage" && typeof item.text === "string")
        messages.push({ role: "assistant", text: item.text });
      if (item.type === "userMessage") {
        const text = (item.content ?? []).filter((c: any) => c.type === "text" && typeof c.text === "string").map((c: any) => c.text).join("\n");
        if (text) messages.push({ role: "user", text });
      }
    }
  }
  return messages.slice(-30).map(m => ({ ...m, text: m.text.slice(0, 20000) }));
}
