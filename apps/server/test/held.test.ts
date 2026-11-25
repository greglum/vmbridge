import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";
import { openDatabase } from "../src/bun/sqlite.ts";
import type { Fleet } from "../src/fleet.ts";
import { applyHeldCommand } from "../src/gateway/held.ts";
import { Hub } from "../src/gateway/hub.ts";
import { Rpc, type RpcClient } from "../src/gateway/rpc.ts";
import type { ProviderEntry, ServerConfig, Shell, Wire } from "../src/gateway/types.ts";
import { Settings } from "../src/settings.ts";
import { Store } from "../src/store.ts";
import type { Traffic } from "../src/traffic.ts";
import { T3Rejected, type Backend } from "../src/vm/backend.ts";
import { testEncryption } from "./key.ts";

/** No resource readings: placement goes by thread counts and size labels alone. */
const unmeasured = { get: () => null, lastDisk: () => null };

function setup() {
  const store = new Store(openDatabase(":memory:"), testEncryption);
  store.insertVm({ id: "vm1", provider: "boxd", name: "vm1", size: "medium", state: "sleeping", createdAt: 0 });
  const thread = { id: "t1", title: "Fix login", settledOverride: null, settledAt: null, unsettledAt: null, archivedAt: null, pinnedAt: null, updatedAt: "2026-11-21T00:00:00.000Z" };
  store.saveSnapshot("vm1", "shell", { threads: [thread], archivedThreads: [], projects: [] } satisfies Shell);
  store.setThreadVm("t1", "vm1");

  const backends = new Map<string, Backend>();
  const fleet = Object.assign(new EventEmitter(), { backend: (id: string) => backends.get(id), touch: () => {} }) as unknown as Fleet;
  const traffic = { record: () => {} } as unknown as Traffic;
  const hub = new Hub(store, new Settings(store.db), fleet, traffic, unmeasured);
  const rpc = new Rpc(hub, {} as never, {} as never, traffic, () => false);
  const sent: { exit?: { _tag: string; value?: unknown } }[] = [];
  const client: RpcClient = { clientId: "c1", cancels: new Map(), send: (frame) => sent.push(frame as (typeof sent)[number]), open: () => true };
  const dispatch = (payload: object) =>
    rpc.handle(client, { _tag: "Request", id: sent.length, tag: "orchestration.dispatchCommand", payload: { commandId: crypto.randomUUID(), ...payload } });
  return { store, fleet, hub, backends, traffic, sent, dispatch, thread };
}

/**
 * Connects vm1 with a T3 server whose dispatch answers wait for the test, and whose shell stream the test drives.
 * Its first shell is `thread` at sequence 10.
 */
async function connect({ fleet, backends, thread }: ReturnType<typeof setup>) {
  const dispatched: { payload: Wire; answer: (sequence: number) => void; reject: (error: Error) => void }[] = [];
  let shellStream: (frame: unknown) => void = () => {};
  const backend = {
    call: (tag: string, payload: Wire) => {
      if (tag === "server.getConfig") return Promise.resolve({ environment: { orchestrationProtocolVersion: 2 } });
      if (tag !== "orchestration.dispatchCommand") return Promise.resolve(null);
      return new Promise((resolve, reject) => dispatched.push({ payload, answer: (sequence) => resolve({ sequence }), reject }));
    },
    request: (tag: string, _payload: unknown, handler: (frame: unknown) => void) => {
      if (tag === "orchestration.subscribeShell") shellStream = handler;
      return () => {};
    },
  } as unknown as Backend;
  backends.set("vm1", backend);
  await fleet.onConnect("vm1", backend);
  const push = (item: object) => shellStream({ _tag: "Chunk", values: [item] });
  push({ kind: "snapshot", snapshot: { snapshotSequence: 10, projects: [], threads: [thread], archivedThreads: [] } });
  fleet.emit("awake", "vm1");
  /** The VM's shell showing its thread changed, at a sequence. */
  const report = (sequence: number, change: Wire) => push({ kind: "thread.updated", sequence, location: "active", thread: { ...thread, ...change } });
  return { dispatched, report };
}

const settledOverride = (hub: Hub) => hub.shell().threads?.find((row) => row.id === "t1")?.settledOverride;

describe("thread commands while the VM is away", () => {
  test("settle succeeds without waking the VM, persists, and replays when the VM connects", async () => {
    const { store, fleet, hub, backends, traffic, sent, dispatch } = setup();

    await dispatch({ type: "thread.settle", threadId: "t1" });
    expect(sent.at(-1)?.exit?._tag).toBe("Success");
    expect(settledOverride(hub)).toBe("settled");
    // Saved, so a restart still shows it settled.
    const restarted = Object.assign(new EventEmitter(), { backend: () => undefined, touch: () => {} }) as unknown as Fleet;
    expect(settledOverride(new Hub(store, new Settings(store.db), restarted, traffic, unmeasured))).toBe("settled");

    const replayed: unknown[] = [];
    backends.set("vm1", { call: async (tag: string, payload: unknown) => (replayed.push([tag, payload]), { sequence: 0 }) } as unknown as Backend);
    fleet.emit("awake", "vm1");
    await Bun.sleep(0);
    expect(replayed).toEqual([["orchestration.dispatchCommand", expect.objectContaining({ type: "thread.settle", threadId: "t1" })]]);
    expect(store.heldCommands("vm1")).toEqual([]);
  });

  test("a replay that gets no answer stays for the next connect; one T3 refuses is dropped", async () => {
    const { store, fleet, backends, dispatch } = setup();
    await dispatch({ type: "thread.settle", threadId: "t1" });

    backends.set("vm1", { call: async () => Promise.reject(new Error("VM vm1 disconnected.")) } as unknown as Backend);
    fleet.emit("awake", "vm1");
    await Bun.sleep(0);
    expect(store.heldCommands("vm1")).toHaveLength(1);

    backends.set("vm1", { call: async () => Promise.reject(new T3Rejected("orchestration.dispatchCommand", "vm1")) } as unknown as Backend);
    fleet.emit("awake", "vm1");
    await Bun.sleep(0);
    expect(store.heldCommands("vm1")).toEqual([]);
  });

  test("snooze shows at once without waking the VM, and reaches it when it connects", async () => {
    const context = setup();
    const snoozedUntil = new Date(Date.now() + 60 * 60_000).toISOString();
    await context.dispatch({ type: "thread.snooze", threadId: "t1", snoozedUntil });
    expect(context.sent.at(-1)?.exit?._tag).toBe("Success");
    expect(context.hub.shell().threads?.[0]?.snoozedUntil).toBe(snoozedUntil);

    const { dispatched } = await connect(context);
    expect(dispatched.map((entry) => entry.payload)).toEqual([expect.objectContaining({ type: "thread.snooze", threadId: "t1", snoozedUntil })]);
    // Shown until the VM's own shell shows it.
    expect(context.hub.shell().threads?.[0]?.snoozedUntil).toBe(snoozedUntil);
  });

  test("settle and archive succeed for a thread whose VM was removed", async () => {
    const { store, fleet, hub, sent, dispatch } = setup();
    store.deleteVm("vm1");
    fleet.emit("offline", "vm1");
    expect(hub.shell().threads).toEqual([]);

    await dispatch({ type: "thread.settle", threadId: "t1" });
    await dispatch({ type: "thread.archive", threadId: "unknown" });
    expect(sent.map((frame) => frame.exit?._tag)).toEqual(["Success", "Success"]);
  });
});

describe("thread commands while the VM is awake", () => {
  test("settle and snooze are answered and shown before the VM answers", async () => {
    const context = setup();
    const { dispatched } = await connect(context);

    await context.dispatch({ type: "thread.settle", threadId: "t1" });
    expect(context.sent.at(-1)?.exit?._tag).toBe("Success");
    expect(settledOverride(context.hub)).toBe("settled");
    expect(dispatched.map((entry) => entry.payload.type)).toEqual(["thread.settle"]);

    await context.dispatch({ type: "thread.unsettle", threadId: "t1", reason: "user" });
    const snoozedUntil = new Date(Date.now() + 60 * 60_000).toISOString();
    await context.dispatch({ type: "thread.snooze", threadId: "t1", snoozedUntil });
    expect(context.sent.map((frame) => frame.exit?._tag)).toEqual(["Success", "Success", "Success"]);
    expect(context.hub.shell().threads?.[0]).toMatchObject({ settledOverride: "active", snoozedUntil });
  });

  test("the VM gets commands in order, and its echoes do not flip the thread back", async () => {
    const context = setup();
    const { dispatched, report } = await connect(context);
    const seen: unknown[] = [];
    context.hub.on("shell", () => seen.push(settledOverride(context.hub)));

    await context.dispatch({ type: "thread.settle", threadId: "t1" });
    await context.dispatch({ type: "thread.unsettle", threadId: "t1", reason: "user" });
    // The unsettle waits for the VM to answer the settle.
    expect(dispatched.map((entry) => entry.payload.type)).toEqual(["thread.settle"]);

    dispatched[0]!.answer(11);
    await Bun.sleep(0);
    expect(dispatched.map((entry) => entry.payload.type)).toEqual(["thread.settle", "thread.unsettle"]);
    report(11, { settledOverride: "settled", settledAt: "2026-11-25T00:00:00.000Z" });
    dispatched[1]!.answer(12);
    await Bun.sleep(0);
    // Answered, but the VM's shell has not shown it yet.
    expect(context.store.heldCommands("vm1")).toHaveLength(1);
    report(12, { settledOverride: "active", unsettledAt: "2026-11-25T00:00:01.000Z" });

    expect(seen).toEqual(["settled", "active", "active", "active"]);
    expect(context.store.heldCommands("vm1")).toEqual([]);
  });

  test("a command the VM rejects leaves the thread as the VM has it", async () => {
    const context = setup();
    const { dispatched, report } = await connect(context);
    report(11, { settledOverride: "active", unsettledAt: "2026-11-25T00:00:00.000Z" });

    await context.dispatch({ type: "thread.settle", threadId: "t1" });
    expect(settledOverride(context.hub)).toBe("settled");
    dispatched[0]!.reject(new T3Rejected("orchestration.dispatchCommand", "vm1"));
    await Bun.sleep(0);

    expect(context.hub.shell().threads?.[0]).toMatchObject({ settledOverride: "active", unsettledAt: "2026-11-25T00:00:00.000Z" });
    expect(context.store.heldCommands("vm1")).toEqual([]);
  });
});

describe("applyHeldCommand", () => {
  test("leaves a thread as it is where T3 would refuse the command", () => {
    const thread = { id: "t1", archivedAt: null, snoozedUntil: null, updatedAt: "2026-11-21T00:00:00.000Z" };
    const at = "2026-11-25T00:00:00.000Z";
    const shell: Shell = { threads: [thread], archivedThreads: [{ ...thread, id: "t2", archivedAt: at }] };
    applyHeldCommand(shell, { type: "thread.snooze", threadId: "t1", snoozedUntil: "2026-11-24T00:00:00.000Z" }, at);
    applyHeldCommand(shell, { type: "thread.settle", threadId: "t2" }, at);
    expect(shell.threads).toEqual([thread]);
    expect(shell.archivedThreads?.[0]).toEqual({ ...thread, id: "t2", archivedAt: at });
  });
});

describe("shell from a VM", () => {
  test("the project-only snapshot T3 sends after its first one keeps the VM's threads", async () => {
    const { store, fleet, hub } = setup();
    const thread = store.snapshot<Shell>("vm1", "shell")!.threads![0]!;
    const project = { id: "p1", workspaceRoot: "/workspace/app", repositoryIdentity: null };
    const backend = {
      call: async () => ({ environment: { orchestrationProtocolVersion: 2 } }),
      request: (tag: string, _payload: unknown, handler: (frame: unknown) => void) => {
        if (tag === "orchestration.subscribeShell") {
          const full = { kind: "snapshot", snapshot: { projects: [project], threads: [thread], archivedThreads: [] } };
          const identity = { name: "acme/app" };
          const enriched = { kind: "snapshot", snapshot: { projects: [{ ...project, repositoryIdentity: identity }], threads: [], archivedThreads: [] }, resolvedRepositoryIdentityRoots: ["/workspace/app"] };
          handler({ _tag: "Chunk", values: [full, enriched] });
        }
        return () => {};
      },
    } as unknown as Backend;
    await fleet.onConnect("vm1", backend);

    expect(hub.shell().threads?.map((row) => row.id)).toEqual(["t1"]);
    expect(store.snapshot<Shell>("vm1", "shell")?.projects?.[0]?.repositoryIdentity).toEqual({ name: "acme/app" });
  });
});

describe("agent updates", () => {
  test("wakes a sleeping VM that reported the agent outdated, updates it, and puts it back to sleep", async () => {
    const advisory = (status: string, currentVersion: string) => ({
      status,
      currentVersion,
      latestVersion: "2.1.330",
      updateCommand: "npm i -g @anthropic-ai/claude-code@latest",
      canUpdate: true,
    });
    const claude = (status: string, version: string) =>
      ({ instanceId: "claudeAgent", driver: "claudeAgent", enabled: true, installed: true, version, versionAdvisory: advisory(status, version) }) as unknown as ProviderEntry;
    const config = { providers: [claude("behind_latest", "2.1.317")] } as ServerConfig;
    const { store } = setup();
    store.saveSnapshot("vm1", "config", config);
    // A fresh hub loads the cached config, as after a restart.
    const backends = new Map<string, Backend>();
    const slept: string[] = [];
    const calls: string[] = [];
    let leases = 0;
    const backend = {
      call: async (tag: string) => {
        calls.push(tag);
        return { providers: [claude("current", "2.1.330")] };
      },
      json: async () => ({ threads: [], archivedThreads: [], projects: [] }),
    } as unknown as Backend;
    const fleet = Object.assign(new EventEmitter(), {
      backend: (id: string) => backends.get(id),
      touch: () => {},
      leased: () => leases > 0,
      lease: () => (leases++, () => leases--),
      ensure: async (id: string) => (backends.set(id, backend), backend),
      sleep: async (id: string) => (slept.push(id), backends.delete(id)),
    }) as unknown as Fleet;
    const traffic = { record: () => {} } as unknown as Traffic;
    const hub = new Hub(store, new Settings(store.db), fleet, traffic, unmeasured);

    // Offered from the cached report, without waking the VM.
    expect(hub.agents().find((agent) => agent.instanceId === "claudeAgent")?.versionAdvisory).toMatchObject({ status: "behind_latest" });
    expect(calls).toEqual([]);

    const agents = await hub.updateAgent({ provider: "claudeAgent", instanceId: "claudeAgent" });
    expect(calls).toEqual(["server.updateProvider"]);
    expect(slept).toEqual(["vm1"]);
    const updated = agents.find((agent) => agent.instanceId === "claudeAgent");
    expect(updated?.versionAdvisory).toMatchObject({ status: "current" });
    expect(updated?.updateState).toMatchObject({ status: "succeeded" });
    expect(store.snapshot<ServerConfig>("vm1", "config")?.providers?.[0]?.version).toBe("2.1.330");
  });

  test("a waking VM re-checks agent releases and the dialog offers what it finds", async () => {
    const { fleet, hub } = setup();
    const calls: string[] = [];
    let pushConfig: (frame: unknown) => void = () => {};
    const backend = {
      call: async (tag: string) => {
        calls.push(tag);
        return { environment: { orchestrationProtocolVersion: 2 }, providers: [] };
      },
      request: (tag: string, _payload: unknown, handler: (frame: unknown) => void) => {
        if (tag === "subscribeServerConfig") pushConfig = handler;
        return () => {};
      },
    } as unknown as Backend;
    await fleet.onConnect("vm1", backend);
    expect(calls).toContain("server.refreshProviders");

    const advisory = { status: "behind_latest", currentVersion: "0.171.0", latestVersion: "0.172.0", updateCommand: "npm i -g @openai/codex@latest", canUpdate: true };
    const codex = { instanceId: "codex", driver: "codex", enabled: true, installed: true, version: "0.171.0", versionAdvisory: advisory };
    pushConfig({ _tag: "Chunk", values: [{ type: "providerStatuses", payload: { providers: [codex] } }] });
    expect(hub.agents().find((agent) => agent.instanceId === "codex")?.versionAdvisory).toMatchObject({ latestVersion: "0.172.0" });
  });
});
