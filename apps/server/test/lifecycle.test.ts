import { afterEach, describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import type { AgentAuth } from "../src/agent-auth/profiles.ts";
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
  const traffic = { record: () => {} } as unknown as Traffic;
  const agents = { vmSecrets: async () => ({}), adoptCodex: () => {} } as unknown as AgentAuth;
  const fleet = new Fleet(store, settings, new Secrets(db), traffic, agents);
  fleets.push(fleet);

  const box = {
    id: "sb1",
    run: async (command: string) => {
      if (command.includes("auth session issue")) return ok("token");
      if (command.includes("well-known")) return ok(JSON.stringify({ orchestrationProtocolVersion: 2 }));
      return ok();
    },
    files: {
      read: async () => {
        throw new Error("No such file.");
      },
      write: async () => {},
    },
    preview: async () => ({ url: t3.url, headers: {} }),
  } as unknown as Box;
  const events: string[] = [];
  const driver = {
    create: async () => (events.push("create"), box),
    wake: async () => (events.push("wake"), box),
    sleep: async (): Promise<{ checkpoint?: string }> => (events.push("sleep"), {}),
    destroy: async (sandboxId: string) => void events.push(`destroy ${sandboxId}`),
    connect: async () => box,
    keepAlive: async () => {},
    deleteCheckpoint: async (checkpoint: string) => void events.push(`delete checkpoint ${checkpoint}`),
  };
  fleet.driver = () => driver as unknown as Driver;
  return { t3, store, settings, fleet, driver, box, events, traffic };
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

});

describe("idle sleep", () => {
  const later = () => Date.now() + 24 * 60 * 60_000;

  function idleFleet() {
    const context = setup();
    const hub = new Hub(context.store, context.settings, context.fleet, context.traffic);
    // Only the fleet's own lifecycle is under test here, not T3's streams.
    context.fleet.onConnect = async () => {};
    return { ...context, hub };
  }

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
