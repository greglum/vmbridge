// VM Bridge on Bun: the server, timers and files on this machine. Bun-only pieces live here and in bun/, so the rest
// can run elsewhere too.
import { homedir } from "node:os";
import { join } from "node:path";
import dashboard from "@vmbridge/web/index.html";
import { version } from "../../../package.json" with { type: "json" };
import { Admin } from "./admin.ts";
import { AgentAuth } from "./agent-auth/profiles.ts";
import { Clients } from "./auth/clients.ts";
import { DashboardAuth } from "./auth/dashboard.ts";
import { importAuthFiles } from "./bun/auth-files.ts";
import { runJobs } from "./bun/jobs.ts";
import { openSocket } from "./bun/socket.ts";
import { openDatabase } from "./bun/sqlite.ts";
import { localKey, openEncryption } from "./encryption.ts";
import { Fleet } from "./fleet.ts";
import { bridgeJobs } from "./jobs.ts";
import { fetchGitHubAccount } from "./github.ts";
import { Clones } from "./gateway/clones.ts";
import { isT3Path, T3Gateway, type SocketData } from "./gateway/http.ts";
import { Hub } from "./gateway/hub.ts";
import { RemoteBranches } from "./gateway/repos.ts";
import { Rpc } from "./gateway/rpc.ts";
import { networkInfo } from "./bun/network.ts";
import { Secrets, Settings } from "./settings.ts";
import { Skills } from "./skills.ts";
import { Store } from "./store.ts";
import { Traffic } from "./traffic.ts";
import { CloudflareTunnel } from "./bun/tunnel.ts";
import { Usage } from "./usage.ts";
import { Stats } from "./vm/stats.ts";

export { version };
export const defaultPort = 3774;
export const defaultHost = "0.0.0.0";
export const dataDir = () => process.env.VMBRIDGE_HOME || join(homedir(), ".vmbridge");
export const databasePath = (dir = dataDir()) => join(dir, "main.db");

/** Dashboard password setup, for the CLI to run before the server starts. */
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
  const dir = options.dir ?? dataDir();
  const db = openDatabase(databasePath(dir));
  const settings = new Settings(db);
  const { encryption, key: encryptionKey } = openEncryption(db, (create) => localKey(dir, create));
  const secrets = new Secrets(db, encryption);
  const store = new Store(db, encryption);
  const traffic = new Traffic(db);

  importAuthFiles(join(dir, "auths"), db, encryption);
  const agents = new AgentAuth(db, settings, encryption);
  const skills = new Skills(db, encryption);
  // Data saved before encryption existed. Each table moves in one transaction, so a start cut short finishes the rest
  // next time.
  const sealed = secrets.sealPlaintext() + store.sealPlaintext() + skills.sealPlaintext();
  if (sealed > 0) {
    // Rewrites the database so the replaced plain text is not left behind in free pages or the write-ahead log.
    db.exec("VACUUM");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }
  const fleet = new Fleet(store, settings, secrets, traffic, agents, skills, openSocket);
  skills.on("changed", () => {
    fleet.emit("changed");
    void fleet.shareSkills();
  });
  const stats = new Stats(fleet);
  const usage = new Usage(store, () => fleet.connected());
  for (const event of ["changed", "awake", "offline"] as const) fleet.on(event, () => usage.sync());
  const hub = new Hub(store, settings, fleet, traffic, stats);
  agents.onChange = () => {
    fleet.emit("changed");
    void hub.credentialsChanged().catch(() => {});
  };
  const clones = new Clones(hub);
  const branches = new RemoteBranches(() => secrets.get("github.token"));
  const clients = new Clients(db);
  const rpc = new Rpc(hub, clones, branches, traffic, () => secrets.has("github.token"));
  const gateway = new T3Gateway(hub, rpc, clients);
  const auth = new DashboardAuth(db, settings);
  // Defined before the server starts listening; its listener only opens once the tunnel is on.
  let tunnel: CloudflareTunnel;
  const admin = new Admin({ version, startedAt: Date.now(), host, port, settings, secrets, store, fleet, hub, traffic, clients, auth, gateway, agents, stats, skills, usage, tunnel: () => tunnel });

  /** `viaTunnel` marks the loopback listener only cloudflared forwards to, whose proxy headers can be trusted. */
  const serve = (hostname: string, port: number, viaTunnel: boolean) =>
    Bun.serve<SocketData>({
      hostname,
      port,
      maxRequestBodySize: 2 * 1024 * 1024,
      // Long enough for the dashboard's event stream between heartbeats.
      idleTimeout: 60,
      development: process.env.VMBRIDGE_DEV === "1",
      // The dashboard lives under /dashboard, a path T3 clients never request.
      routes: {
        "/dashboard": dashboard,
        "/dashboard/onboarding": dashboard,
        "/": new Response(null, { status: 302, headers: { location: "/dashboard" } }),
      },
      fetch(request, server) {
        const { pathname: path, search } = new URL(request.url);
        // Routes match exactly, so /dashboard/ would miss. The browser keeps the fragment (onboarding's #code=) across the redirect.
        if (path.startsWith("/dashboard/") && path.endsWith("/")) {
          return new Response(null, { status: 302, headers: { location: `${path.replace(/\/+$/, "")}${search}` } });
        }
        if (path.startsWith("/admin/api/")) return admin.fetch(request, server, viaTunnel);
        if (isT3Path(path)) return gateway.fetch(request, server);
        return new Response("Not found", { status: 404 });
      },
      websocket: gateway.websocket,
    });
  const server = serve(host, port, false);
  tunnel = new CloudflareTunnel({ settings, secrets, traffic, dir, listen: (tunnelPort) => serve("127.0.0.1", tunnelPort, true) });
  void tunnel.apply();

  // Installed local skills and instructions files follow edits on this machine. Reading a few small files is cheaper than watching them reliably.
  skills.instructions.refresh();
  const localSkills = {
    name: "local skills",
    everyMs: 5_000,
    run: async () => {
      try {
        skills.refreshLocal();
        skills.instructions.refresh();
      } catch {}
    },
  };
  const stopJobs = runJobs([...bridgeJobs({ hub, fleet, stats, usage, traffic }), localSkills]);
  void fleet.resume();
  // Accounts saved by older versions lack the details the dashboard shows.
  const githubToken = secrets.get("github.token");
  if (githubToken && !settings.get("github")?.checkedAt) {
    void fetchGitHubAccount(githubToken).then((account) => settings.set("github", account), () => {});
  }
  traffic.record({ kind: "system", operation: "VM Bridge started" });

  return {
    port: server.port ?? port,
    host,
    /** Opens first password setup in the dashboard. Null when a password exists. Show it only to whoever started VM Bridge. */
    setupCode: auth.createSetupCode(),
    /** Where this install's encryption key lives, and whether this start made it. */
    encryptionKey: { location: encryptionKey.location, created: encryptionKey.created },
    network: () => networkInfo(host, server.port ?? port, tunnel.info()),
    /** Waits a little for the Cloudflare Tunnel's address, so it can be printed with the others. */
    tunnelReady: () => tunnel.ready(20_000),
    async stop() {
      stopJobs();
      gateway.close();
      await tunnel.stop();
      await server.stop(true);
      // Some providers have no idle timeout of their own: a VM left awake here would run until VM Bridge starts again.
      await hub.sleepIdle(15_000);
      hub.close();
      fleet.close();
      usage.close();
      db.close();
    },
  };
}
