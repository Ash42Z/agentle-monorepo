import { readFileSync } from "node:fs";
import { dashboardServer } from "./dashboard.js";
const secret = (path: string) => readFileSync(path, "utf8").trim();
const server = dashboardServer({
  token: secret("/run/secrets/controller-token"),
  username: process.env.AGENTLE_DASHBOARD_USER ?? "Ash42Z",
  password: secret("/run/secrets/dashboard-password"),
  upstream: "http://bot:8080",
  release: process.env.AGENTLE_RELEASE ?? "development",
});
server.listen(8082, "0.0.0.0");
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => server.close());
