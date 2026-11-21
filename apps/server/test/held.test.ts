import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import type { Fleet } from "../src/fleet.ts";
import { Hub } from "../src/gateway/hub.ts";
import { Rpc, type RpcClient } from "../src/gateway/rpc.ts";
import type { Shell } from "../src/gateway/types.ts";
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
