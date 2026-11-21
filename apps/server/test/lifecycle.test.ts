import { afterEach, describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import type { AgentAuth, AgentSecrets } from "../src/agent-auth/profiles.ts";
import { openDatabase } from "../src/db.ts";
import { Fleet } from "../src/fleet.ts";
import { Hub } from "../src/gateway/hub.ts";
import type { Shell, Wire } from "../src/gateway/types.ts";
import type { Box, Driver } from "../src/providers/index.ts";
import { Secrets, Settings } from "../src/settings.ts";
import { Store } from "../src/store.ts";
import type { Traffic } from "../src/traffic.ts";
import { T3Rejected } from "../src/vm/backend.ts";

/** Returned by a fake T3 answer to leave the request open, as T3 does for streams. */
const open = Symbol("open");
/** Returned by a fake T3 answer to fail the request, as T3 does when it rejects a command. */
const fail = Symbol("fail");

/** Just enough of a T3 server for a `Backend`: socket tickets, the RPC socket, and the shell read. */
function fakeT3() {
  const sockets = new Set<ServerWebSocket<unknown>>();
  const state = {
    sockets,
    shell: { threads: [{ id: "t1", status: "idle" }], archivedThreads: [], projects: [] } as Shell,
    answer: (tag: string, _payload: Wire): unknown => (tag.toLowerCase().includes("subscribe") ? open : null),
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      const path = new URL(request.url).pathname;
      if (path === "/api/auth/websocket-ticket/rpc") return Response.json({ ticket: "ticket" });
      if (path === "/api/orchestration/shell") return Response.json(state.shell);
      if (path === "/ws" && server.upgrade(request, { data: undefined })) return undefined;
      return new Response(null, { status: 404 });
    },
    websocket: {
      open: (socket) => void sockets.add(socket),
      close: (socket) => void sockets.delete(socket),
      async message(socket, raw) {
        const frame = JSON.parse(String(raw)) as Wire;
        if (frame._tag !== "Request") return;
        const value = await state.answer(String(frame.tag), frame.payload as Wire);
        if (value === open) return;
        const exit = value === fail ? { _tag: "Failure", cause: [] } : { _tag: "Success", value };
        socket.send(JSON.stringify({ _tag: "Exit", requestId: frame.id, exit }));
      },
    },
  });
  servers.push(server);
  return { ...state, state, url: `http://127.0.0.1:${server.port}` };
}

const servers: ReturnType<typeof Bun.serve>[] = [];
const fleets: Fleet[] = [];
afterEach(() => {
  for (const fleet of fleets.splice(0)) fleet.close();
  for (const server of servers.splice(0)) server.stop(true);
});

const ok = (stdout = "") => ({ ok: true, exitCode: 0, stdout, stderr: "", output: stdout });
const failed = { ok: false, exitCode: 1, stdout: "", stderr: "", output: "" };
const envPath = "/workspace/.vmbridge/env";

function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}

async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(5);
  expect(check()).toBe(true);
}

function setup() {
  const t3 = fakeT3();
  const db = openDatabase(":memory:");
  const settings = new Settings(db);
  settings.set("providers", ["boxd"]);
  settings.set("defaultProvider", "boxd");
  settings.set("t3Version", "1.0.0");
  const store = new Store(db);
  const secrets = new Secrets(db);
  const traffic = { record: () => {} } as unknown as Traffic;
  const signIns: AgentSecrets = {};
  const agents = { vmSecrets: async () => ({ ...signIns }), adoptCodex: () => {} } as unknown as AgentAuth;

  /** The VM's files, and its T3 server: whether it runs and the env file it started with, as agents inherit it. */
  const files: Record<string, string> = {};
  const server = { running: false, env: "", starts: 0, restarts: 0, failRestart: false };
  const startServer = () => {
    server.running = true;
    server.env = files[envPath] ?? "";
    // As start-t3.sh does.
    files["/workspace/.vmbridge/t3/credentials"] = /^VMBRIDGE_CREDENTIALS=(.*)$/m.exec(server.env)?.[1] ?? "";
  };
  const box = {
    id: "sb1",
    run: async (command: string) => {
      if (command.includes("auth session issue")) return ok("token");
      if (command.includes("well-known")) return server.running ? ok(JSON.stringify({ orchestrationProtocolVersion: 2 })) : failed;
      if (command.startsWith("rm -f ")) for (const path of command.slice(6).split(" ")) delete files[path];
      return ok();
    },
    files: {
      read: async (path: string) => {
        if (files[path] === undefined) throw new Error("No such file.");
        return files[path];
      },
      write: async (written: Record<string, string>) => void Object.assign(files, written),
    },
    start: async () => {
      server.starts++;
      startServer();
    },
    process: () => ({
      restart: async () => {
        server.restarts++;
        for (const socket of t3.sockets) socket.close();
        startServer();
        if (server.failRestart) throw new Error("T3 did not answer in time.");
      },
    }),
    preview: async () => ({ url: t3.url, headers: {} }),
  } as unknown as Box;
  const events: string[] = [];
  // Pauses by default, like boxd and Instabox: T3 keeps running through sleep.
  const driver = {
    create: async () => (events.push("create"), box),
    wake: async () => (events.push("wake"), box),
    sleep: async (): Promise<{ checkpoint?: string }> => (events.push("sleep"), {}),
    destroy: async (sandboxId: string) => void events.push(`destroy ${sandboxId}`),
    connect: async () => box,
    keepAlive: async () => {},
    deleteCheckpoint: async (checkpoint: string) => void events.push(`delete checkpoint ${checkpoint}`),
  };
  /** Another Fleet on the same database, as after VM Bridge restarts. */
  const newFleet = () => {
    const fleet = new Fleet(store, settings, secrets, traffic, agents);
    fleet.driver = () => driver as unknown as Driver;
    fleets.push(fleet);
    return fleet;
  };
  const fleet = newFleet();
  return { t3, store, settings, secrets, fleet, newFleet, driver, box, events, traffic, signIns, files, server };
}

describe("creating and deleting VMs", () => {
  test("deleting a VM still being created waits for it, then deletes it at the provider", async () => {
    const { fleet, store, driver, box, events } = setup();
    const created = gate();
    driver.create = async () => (events.push("create"), await created.promise, box);

    const creating = fleet.create();
    const [vm] = store.vms();
    expect(vm?.state).toBe("provisioning");
    const deleting = fleet.destroy(vm!.id);
    await Bun.sleep(5);
    expect(store.vm(vm!.id)).not.toBeNull();

    created.release();
    await creating;
    await deleting;
    expect(events).toEqual(["create", "destroy sb1"]);
    expect(store.vm(vm!.id)).toBeNull();
  });

  test("two requests for T3's configuration at once start one VM", async () => {
    const { fleet, store, events } = setup();
    const [a, b] = await Promise.all([fleet.any(), fleet.any()]);
    expect(a).toBe(b);
    expect(store.vms()).toHaveLength(1);
    expect(events).toEqual(["create", "wake"]);
  });
});

describe("waking", () => {
  test("a VM that wakes but fails setup is closed and put back to sleep", async () => {
    const { fleet, store, t3, events } = setup();
    fleet.onConnect = async () => {
      throw new Error("T3 sent something unexpected.");
    };
    const vm = await fleet.create();
    await expect(fleet.ensure(vm.id)).rejects.toThrow("T3 sent something unexpected.");
    expect(events).toEqual(["create", "wake", "sleep"]);
    expect(store.vm(vm.id)).toMatchObject({ state: "error", error: "T3 sent something unexpected." });
    expect(fleet.backend(vm.id)).toBeUndefined();
    await until(() => t3.sockets.size === 0);
  });

  test("T3 refusing a request is told apart from the socket dropping", async () => {
    const { fleet, t3 } = setup();
    const backend = await fleet.ensure((await fleet.create()).id);
    t3.state.answer = () => fail;
    expect(await backend.call("orchestration.dispatchCommand", {}).catch((error: unknown) => error)).toBeInstanceOf(T3Rejected);
    t3.state.answer = () => {
      for (const socket of t3.sockets) socket.close();
      return open;
    };
    const dropped = await backend.call("orchestration.dispatchCommand", {}).catch((error: unknown) => error);
    expect(dropped).toBeInstanceOf(Error);
    expect(dropped).not.toBeInstanceOf(T3Rejected);
  });
});

describe("checkpoints", () => {
  test("waking from a checkpoint deletes the checkpoint", async () => {
    const { fleet, store, driver, box, events } = setup();
    const vm = await fleet.create();
    await fleet.ensure(vm.id);
    driver.sleep = async () => (events.push("sleep"), { checkpoint: "cp1" });
    await fleet.sleep(vm.id);
    driver.wake = async () => (events.push("wake"), { ...box, id: "sb2" });
    await fleet.ensure(vm.id);
    expect(events).toEqual(["create", "wake", "sleep", "wake", "delete checkpoint cp1"]);
    expect(store.vm(vm.id)).toMatchObject({ sandboxId: "sb2", checkpoint: null });
  });

  test("deleting a VM asleep as a checkpoint deletes the checkpoint", async () => {
    const { fleet, driver, events } = setup();
    const vm = await fleet.create();
    await fleet.ensure(vm.id);
    driver.sleep = async () => (events.push("sleep"), { checkpoint: "cp1" });
    await fleet.sleep(vm.id);
    await fleet.destroy(vm.id);
    expect(events).toEqual(["create", "wake", "sleep", "destroy sb1", "delete checkpoint cp1"]);
  });

  test("a VM a failed wake put back to sleep as a checkpoint is not slept again", async () => {
    const { fleet, store, driver, events } = setup();
    fleet.onConnect = async () => {
      throw new Error("T3 sent something unexpected.");
    };
    driver.sleep = async () => (events.push("sleep"), { checkpoint: "cp1" });
    const vm = await fleet.create();
    await expect(fleet.ensure(vm.id)).rejects.toThrow("T3 sent something unexpected.");
    await fleet.sleep(vm.id);
    expect(events).toEqual(["create", "wake", "sleep"]);
    expect(store.vm(vm.id)).toMatchObject({ state: "error", checkpoint: "cp1" });
  });
});

function idleFleet() {
  const context = setup();
  const hub = new Hub(context.store, context.settings, context.fleet, context.traffic);
  // Only the fleet's own lifecycle is under test here, not T3's streams.
  context.fleet.onConnect = async () => {};
  return { ...context, hub };
}

describe("idle sleep", () => {
  const later = () => Date.now() + 24 * 60 * 60_000;

  test("is dropped when a request takes the VM while transcripts are being saved", async () => {
    const { fleet, hub, t3, events } = idleFleet();
    const vm = await fleet.create();
    await fleet.ensure(vm.id);
    let release = () => {};
    t3.state.answer = (tag) => {
      if (tag === "orchestration.getThreadProjection") release = fleet.lease(vm.id);
      return null;
    };

    await hub.sweep(later());
    expect(events).toEqual(["create", "wake"]);
    expect(fleet.backend(vm.id)).toBeDefined();
    release();
  });

  test("is dropped when the VM started work while transcripts were being saved", async () => {
    const { fleet, hub, t3, events } = idleFleet();
    const vm = await fleet.create();
    await fleet.ensure(vm.id);
    t3.state.answer = (tag) => {
      if (tag === "orchestration.getThreadProjection") t3.state.shell = { threads: [{ id: "t1", status: "running" }] };
      return null;
    };

    await hub.sweep(later());
    expect(events).toEqual(["create", "wake"]);
    expect(fleet.backend(vm.id)).toBeDefined();
  });

  test("a request arriving once the VM is going to sleep waits for it, then wakes the VM", async () => {
    const { fleet, hub, driver, events } = idleFleet();
    const vm = await fleet.create();
    const before = await fleet.ensure(vm.id);
    const asleep = gate();
    driver.sleep = async () => (events.push("sleep"), await asleep.promise, {});

    const sweeping = hub.sweep(later());
    await until(() => events.includes("sleep"));
    // The closing socket is no longer handed out.
    expect(fleet.backend(vm.id)).toBeUndefined();
    const waking = fleet.ensure(vm.id);
    asleep.release();
    await sweeping;
    const after = await waking;
    expect(after).not.toBe(before);
    expect(after.open).toBe(true);
    expect(events).toEqual(["create", "wake", "sleep", "wake"]);
  });

  test("streams the sleep ends see a sleeping VM, so T3 subscriptions stay open", async () => {
    const { fleet, store } = setup();
    const vm = await fleet.create();
    const backend = await fleet.ensure(vm.id);
    const seen: (string | undefined)[] = [];
    backend.request("orchestration.subscribeThread", { threadId: "t1" }, (frame) => {
      if (frame._tag === "Exit") seen.push(store.vm(vm.id)?.state);
    });
    await fleet.sleep(vm.id);
    expect(seen).toEqual(["sleeping"]);
  });
});

describe("sign-in changes", () => {
  const working: Shell = { threads: [{ id: "t1", status: "running" }] };
  const idle: Shell = { threads: [{ id: "t1", status: "idle" }] };

  test("an idle VM restarts T3 with the new sign-ins, and its streams see it starting rather than dropping", async () => {
    const { fleet, hub, store, server, signIns } = idleFleet();
    const vm = await fleet.create();
    const before = await fleet.ensure(vm.id);
    const ended: (string | undefined)[] = [];
    before.request("orchestration.subscribeThread", { threadId: "t1" }, (frame) => {
      if (frame._tag === "Exit") ended.push(store.vm(vm.id)?.state);
    });
    const awake: string[] = [];
    fleet.on("awake", (id) => awake.push(id));

    signIns.opencodeApiKey = "oc-new";
    await hub.credentialsChanged();
    expect(server.restarts).toBe(1);
    expect(server.env).toContain("export OPENCODE_API_KEY='oc-new'");
    expect(ended).toEqual(["starting"]);
    expect(awake).toEqual([vm.id]);
    expect(fleet.backend(vm.id)?.open).toBe(true);
    expect(fleet.backend(vm.id)).not.toBe(before);
    expect(store.vm(vm.id)?.state).toBe("ready");

    // Nothing changed since, so nothing restarts.
    await hub.credentialsChanged();
    await hub.sweep();
    expect(server.restarts).toBe(1);
  });

  test("a busy VM gets the files now and restarts T3 only once its work ends", async () => {
    const { fleet, hub, t3, files, server, signIns } = idleFleet();
    const vm = await fleet.create();
    await fleet.ensure(vm.id);
    t3.state.shell = working;

    signIns.opencodeApiKey = "oc-new";
    await hub.credentialsChanged();
    expect(files[envPath]).toContain("export OPENCODE_API_KEY='oc-new'");
    await hub.sweep();
    expect(server.restarts).toBe(0);
    expect(server.env).not.toContain("OPENCODE_API_KEY=");

    t3.state.shell = idle;
    await hub.sweep();
    expect(server.restarts).toBe(1);
    expect(server.env).toContain("export OPENCODE_API_KEY='oc-new'");
  });

  test("a VM held by a request restarts only once the request is done", async () => {
    const { fleet, hub, server, signIns } = idleFleet();
    const vm = await fleet.create();
    await fleet.ensure(vm.id);
    const release = fleet.lease(vm.id);

    signIns.opencodeApiKey = "oc-new";
    await hub.credentialsChanged();
    await hub.sweep();
    expect(server.restarts).toBe(0);

    release();
    await hub.sweep();
    expect(server.restarts).toBe(1);
  });

  test("a restart that reports failure after relaunching T3 still counts what T3 started with", async () => {
    const { fleet, hub, server, signIns } = idleFleet();
    const vm = await fleet.create();
    await fleet.ensure(vm.id);

    server.failRestart = true;
    signIns.opencodeApiKey = "oc-new";
    await hub.credentialsChanged();
    expect(server.env).toContain("export OPENCODE_API_KEY='oc-new'");

    // Going back to the old sign-ins must restart T3 again, as it now runs with the new ones.
    server.failRestart = false;
    delete signIns.opencodeApiKey;
    await hub.credentialsChanged();
    expect(server.restarts).toBe(2);
    expect(server.env).not.toContain("OPENCODE_API_KEY=");
  });

  test.each(["pause", "stop"])("a VM that sleeps by %s gets the new sign-ins when it wakes", async (style) => {
    const { fleet, hub, driver, events, server, signIns } = idleFleet();
    if (style === "stop") {
      driver.sleep = async () => {
        events.push("sleep");
        server.running = false;
        return {};
      };
    }
    const vm = await fleet.create();
    await fleet.ensure(vm.id);
    await fleet.sleep(vm.id);

    signIns.opencodeApiKey = "oc-new";
    await hub.credentialsChanged();
    expect(server.env).not.toContain("OPENCODE_API_KEY=");
    await fleet.ensure(vm.id);
    expect(server.env).toContain("export OPENCODE_API_KEY='oc-new'");
    expect([server.starts, server.restarts]).toEqual(style === "pause" ? [1, 1] : [2, 0]);
  });

  test("switching Codex accounts restarts T3, a Codex token refresh does not", async () => {
    const { fleet, hub, files, server, signIns } = idleFleet();
    Object.assign(signIns, { codexAuthJson: '{"account":"a","refresh":1}', codexSignIn: "codex-a@1" });
    const vm = await fleet.create();
    await fleet.ensure(vm.id);

    signIns.codexAuthJson = '{"account":"a","refresh":2}';
    await hub.credentialsChanged();
    expect(files["/workspace/.vmbridge/codex/auth.json"]).toBe(signIns.codexAuthJson);
    expect(server.restarts).toBe(0);

    Object.assign(signIns, { codexAuthJson: '{"account":"b","refresh":1}', codexSignIn: "codex-b@2" });
    await hub.credentialsChanged();
    expect(server.restarts).toBe(1);
  });

  test("after VM Bridge restarts, an idle VM with older sign-ins restarts T3 before it is used", async () => {
    const { fleet, newFleet, server, signIns } = setup();
    const vm = await fleet.create();
    await fleet.ensure(vm.id);
    fleet.close();

    signIns.opencodeApiKey = "oc-new";
    const restarted = newFleet();
    await restarted.ensure(vm.id);
    expect(server.restarts).toBe(1);
    expect(server.env).toContain("export OPENCODE_API_KEY='oc-new'");
  });

  test("after VM Bridge restarts, a busy VM with older sign-ins restarts T3 once its work ends", async () => {
    const { fleet, newFleet, store, settings, traffic, t3, server, signIns } = setup();
    const vm = await fleet.create();
    await fleet.ensure(vm.id);
    fleet.close();
    t3.state.shell = working;

    signIns.opencodeApiKey = "oc-new";
    const restarted = newFleet();
    const hub = new Hub(store, settings, restarted, traffic);
    restarted.onConnect = async () => {};
    await restarted.ensure(vm.id);
    await hub.sweep();
    expect(server.restarts).toBe(0);

    t3.state.shell = idle;
    await hub.sweep();
    expect(server.restarts).toBe(1);
    expect(server.env).toContain("export OPENCODE_API_KEY='oc-new'");
  });

  test("a removed GitHub token leaves the VM at once, even mid-turn", async () => {
    const { fleet, hub, t3, files, secrets, settings, server } = idleFleet();
    secrets.set("github.token", "github_pat_old");
    settings.set("github", { login: "octo", name: null, avatarUrl: "", profileUrl: "", email: "1+octo@users.noreply.github.com", scopes: null, expiresAt: null, checkedAt: 0 });
    const vm = await fleet.create();
    await fleet.ensure(vm.id);
    expect(files["/workspace/.vmbridge/git-credentials"]).toContain("github_pat_old");
    t3.state.shell = working;

    secrets.set("github.token", null);
    settings.set("github", null);
    await hub.credentialsChanged();
    expect(files["/workspace/.vmbridge/git-credentials"]).toBeUndefined();
    expect(files[envPath]).not.toContain("GH_TOKEN=");
    expect(server.restarts).toBe(0);
  });
});
