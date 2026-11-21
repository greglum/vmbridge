import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import type { Fleet } from "../src/fleet.ts";
import { Hub } from "../src/gateway/hub.ts";
import { Rpc, type RpcClient } from "../src/gateway/rpc.ts";
import type { ProviderEntry, ServerConfig, Shell } from "../src/gateway/types.ts";
import { Settings } from "../src/settings.ts";
import { Store } from "../src/store.ts";
import type { Traffic } from "../src/traffic.ts";
import type { Backend } from "../src/vm/backend.ts";

function setup() {
  const store = new Store(openDatabase(":memory:"));
  store.insertVm({ id: "vm1", provider: "boxd", name: "vm1", size: "medium", state: "sleeping", createdAt: 0 });
  const thread = { id: "t1", title: "Fix login", settledOverride: null, settledAt: null, unsettledAt: null, archivedAt: null, pinnedAt: null, updatedAt: "2026-11-21T00:00:00.000Z" };
  store.saveSnapshot("vm1", "shell", { threads: [thread], archivedThreads: [], projects: [] } satisfies Shell);
  store.setThreadVm("t1", "vm1");

  const backends = new Map<string, Backend>();
  const fleet = Object.assign(new EventEmitter(), { backend: (id: string) => backends.get(id), touch: () => {} }) as unknown as Fleet;
  const traffic = { record: () => {} } as unknown as Traffic;
  const hub = new Hub(store, new Settings(store.db), fleet, traffic);
  const rpc = new Rpc(hub, {} as never, {} as never, traffic, () => false);
  const sent: { exit?: { _tag: string; value?: unknown } }[] = [];
  const client: RpcClient = { clientId: "c1", cancels: new Map(), send: (frame) => sent.push(frame as (typeof sent)[number]) };
  const dispatch = (payload: object) =>
    rpc.handle(client, { _tag: "Request", id: sent.length, tag: "orchestration.dispatchCommand", payload: { commandId: crypto.randomUUID(), ...payload } });
  return { store, fleet, hub, backends, sent, dispatch };
}

describe("thread commands while the VM is away", () => {
  test("settle succeeds without waking the VM, persists, and replays when the VM connects", async () => {
    const { store, fleet, hub, backends, sent, dispatch } = setup();

    await dispatch({ type: "thread.settle", threadId: "t1" });
    expect(sent.at(-1)?.exit?._tag).toBe("Success");
    expect(hub.shell().threads?.[0]?.settledOverride).toBe("settled");
    // Saved, so a restart still shows it settled.
    expect(store.snapshot<Shell>("vm1", "shell")?.threads?.[0]?.settledOverride).toBe("settled");

    const replayed: unknown[] = [];
    backends.set("vm1", { call: async (tag: string, payload: unknown) => replayed.push([tag, payload]) } as unknown as Backend);
    fleet.emit("awake", "vm1");
    await Bun.sleep(0);
    expect(replayed).toEqual([["orchestration.dispatchCommand", expect.objectContaining({ type: "thread.settle", threadId: "t1" })]]);
    expect(store.heldCommands("vm1")).toEqual([]);
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
    const hub = new Hub(store, new Settings(store.db), fleet, traffic);

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
});
