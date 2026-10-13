// Credential-free stdio adapter. Only the controller can perform GitHub actions.
import { createInterface } from "node:readline";
const endpoint = process.env.AGENTLE_TOOL_ENDPOINT;
const bearer = process.env.AGENTLE_TOOL_BEARER;
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
for await (const line of createInterface({ input: process.stdin })) {
  let request;
  try {
    request = JSON.parse(line);
    if (request.id === undefined) continue;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw Error("Controller tools unavailable");
    send({ jsonrpc: "2.0", id: request.id, result: await response.json() });
  } catch {
    if (request?.id !== undefined)
      send({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32603, message: "Controller tools unavailable" },
      });
  }
}
