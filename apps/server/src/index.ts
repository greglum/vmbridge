import { homedir } from "node:os";
import { join } from "node:path";
import dashboard from "@vmbridge/web/index.html";
import { version } from "../../../package.json" with { type: "json" };
import { Admin } from "./admin.ts";
import { Clients } from "./auth/clients.ts";
import { DashboardAuth } from "./auth/dashboard.ts";
import { openDatabase } from "./db.ts";
import { Fleet } from "./fleet.ts";
import { Clones } from "./gateway/clones.ts";
import { isT3Path, T3Gateway, type SocketData } from "./gateway/http.ts";
import { Hub } from "./gateway/hub.ts";
import { RemoteBranches } from "./gateway/repos.ts";
import { Rpc } from "./gateway/rpc.ts";
import { networkInfo } from "./network.ts";
import { Secrets, Settings } from "./settings.ts";
import { Store } from "./store.ts";
import { Traffic } from "./traffic.ts";
import type { VmCredentials } from "./vm/runtime.ts";

export { version };
export const defaultPort = 3774;
export const defaultHost = "0.0.0.0";
export const dataDir = () => process.env.VMBRIDGE_HOME || join(homedir(), ".vmbridge");
export const databasePath = (dir = dataDir()) => join(dir, "main.db");

/** Dashboard key setup, for the CLI to run before the server starts. */
export function dashboardKey(dir = dataDir()) {
  const db = openDatabase(databasePath(dir));
  const auth = new DashboardAuth(db, new Settings(db));
  return {
    isSet: () => auth.hasKey(),
    set: (key: string) => auth.setKey(key),
    close: () => db.close(),
  };
}

export interface StartOptions {
  dir?: string;
  host?: string;
  port?: number;
}

export async function start(options: StartOptions = {}) {
  const host = options.host ?? defaultHost;
  const port = options.port ?? defaultPort;
  const db = openDatabase(databasePath(options.dir));
  const settings = new Settings(db);
  const secrets = new Secrets(db);
  const store = new Store(db);
  const traffic = new Traffic();

  const credentials = (): VmCredentials => {
    const token = secrets.get("github.token");
    const github = settings.get("github");
    return {
      github: token && github ? { token, ...github } : undefined,
      anthropicApiKey: secrets.get("agent.anthropicApiKey"),
      claudeOAuthToken: secrets.get("agent.claudeOAuthToken"),
      openaiApiKey: secrets.get("agent.openaiApiKey"),
      codexAuthJson: secrets.get("agent.codexAuthJson"),
    };
  };

  const fleet = new Fleet(store, settings, secrets, traffic, credentials);
  const hub = new Hub(store, settings, fleet, traffic);
  const clones = new Clones(hub);
  const branches = new RemoteBranches(() => secrets.get("github.token"));
  const clients = new Clients(db);
  const rpc = new Rpc(hub, clones, branches, traffic, () => secrets.has("github.token"));
  const gateway = new T3Gateway(hub, rpc, clients);
  const auth = new DashboardAuth(db, settings);
  const admin = new Admin({ version, startedAt: Date.now(), host, port, settings, secrets, store, fleet, hub, traffic, clients, auth, gateway });

  const server = Bun.serve<SocketData>({
    hostname: host,
    port,
    maxRequestBodySize: 2 * 1024 * 1024,
    // Long enough for the dashboard's event stream between heartbeats.
    idleTimeout: 60,
    development: process.env.VMBRIDGE_DEV === "1",
    // The dashboard lives under /dashboard, a path T3 clients never request.
    routes: { "/dashboard": dashboard, "/": new Response(null, { status: 302, headers: { location: "/dashboard" } }) },
    fetch(request, server) {
      const path = new URL(request.url).pathname;
      if (path.startsWith("/admin/api/")) return admin.fetch(request, server);
      if (isT3Path(path)) return gateway.fetch(request, server);
      return new Response("Not found", { status: 404 });
    },
    websocket: gateway.websocket,
  });

  let sweeping = false;
  const sweep = setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    hub
      .sweep()
      .catch(() => {})
      .finally(() => (sweeping = false));
  }, 15_000);
  void fleet.resume();
  traffic.record({ kind: "system", operation: "VM Bridge started" });

  return {
    port: server.port ?? port,
    host,
    network: () => networkInfo(host, server.port ?? port),
    async stop() {
      clearInterval(sweep);
      gateway.close();
      await server.stop(true);
      hub.close();
      fleet.close();
      db.close();
    },
  };
}
