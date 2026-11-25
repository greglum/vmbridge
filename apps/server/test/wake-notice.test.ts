import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";
import { openDatabase } from "../src/bun/sqlite.ts";
import type { Fleet } from "../src/fleet.ts";
import { Hub } from "../src/gateway/hub.ts";
import { Rpc, type RpcClient } from "../src/gateway/rpc.ts";
import type { Shell, Wire } from "../src/gateway/types.ts";
import { Settings } from "../src/settings.ts";
import { Store } from "../src/store.ts";
import type { Traffic } from "../src/traffic.ts";
import type { Backend } from "../src/vm/backend.ts";
import { testEncryption } from "./key.ts";

const unmeasured = { get: () => null, lastDisk: () => null };

/** vm1 (boxd) sleeps with threads t1 and t2, both with saved transcripts. The test drives the fleet's wake events. */
function setup() {
  const store = new Store(openDatabase(":memory:"), testEncryption);
  store.insertVm({ id: "vm1", provider: "boxd", name: "vm1", size: "medium", state: "sleeping", createdAt: 0 });
  const row = (id: string) => ({ id, title: id, updatedAt: "2026-11-21T00:00:00.000Z" });
  store.saveSnapshot("vm1", "shell", { threads: [row("t1"), row("t2")], archivedThreads: [], projects: [] } satisfies Shell);
  for (const id of ["t1", "t2"]) {
    store.setThreadVm(id, "vm1");
    store.saveProjection(id, "vm1", null, { thread: { id }, turnItems: [], visibleTurnItems: [] });
  }
  const fleet = Object.assign(new EventEmitter(), {
    backend: () => undefined as Backend | undefined,
    connected: () => [],
    touch: () => {},
  }) as unknown as Fleet;
  const traffic = { record: () => {} } as unknown as Traffic;
  const hub = new Hub(store, new Settings(store.db), fleet, traffic, unmeasured);
  const rpc = new Rpc(hub, {} as never, {} as never, traffic, () => false);
  /** A device viewing a thread: the notices its stream showed, newest last. */
  const view = async (threadId: string) => {
    const notices: (Wire | undefined)[] = [];
    const socket: RpcClient = {
      clientId: crypto.randomUUID(),
      cancels: new Map(),
      send: (frame) => {
        for (const value of ((frame as Wire).values ?? []) as Wire[]) {
          const projection = value.projection as { turnItems: Wire[] } | undefined;
          if (projection) notices.push(projection.turnItems.find((item) => item.type === "system_notice"));
        }
      },
      open: () => true,
    };
    await rpc.handle(socket, { _tag: "Request", id: 1, tag: "orchestration.subscribeThread", payload: { threadId } });
    return notices;
  };
  return { store, fleet, hub, view };
}

describe("the waking notice", () => {
  test("shows on every device viewing the VM's threads from the start of a wake, and goes once the VM connects", async () => {
    const { fleet, hub, view } = setup();
    const [first, second, other] = [await view("t1"), await view("t1"), await view("t2")];
    expect(first).toEqual([undefined]);

    fleet.emit("waking", "vm1", true);
    for (const device of [first, second, other]) expect(device.at(-1)).toMatchObject({ message: "Waking the boxd VM...", level: "info", status: "running" });
    // A device opening the thread mid-wake sees it too.
    expect((await view("t1")).at(-1)?.message).toBe("Waking the boxd VM...");

    fleet.emit("awake", "vm1");
    const items = hub.sleepingProjection("t1", "vm1")?.turnItems ?? [];
    expect(items.some((item) => item.type === "system_notice")).toBe(false);
  });

  test("estimates the wake from the median of the provider's latest wakes", () => {
    const { store, fleet, hub } = setup();
    const vm = { id: "old", provider: "boxd", size: "medium" } as const;
    // Older than the latest five, another provider's, a first start and an untimed one: none count.
    store.recordVmEvent(vm, "wake", 900_000, 1);
    store.recordVmEvent({ ...vm, provider: "daytona" }, "wake", 900_000, 10);
    store.recordVmEvent(vm, "start", 900_000, 10);
    store.recordVmEvent(vm, "wake", null, 10);
    [30_000, 20_000, 25_000, 40_000, 22_000].forEach((ms, index) => store.recordVmEvent(vm, "wake", ms, 2 + index));

    fleet.emit("waking", "vm1", true);
    expect(hub.sleepingProjection("t1", "vm1")?.turnItems?.at(-1)?.message).toBe("Waking the boxd VM, about 25 s");

    store.recordVmEvent(vm, "wake", 200_000, 20);
    store.recordVmEvent(vm, "wake", 200_000, 21);
    store.recordVmEvent(vm, "wake", 200_000, 22);
    fleet.emit("waking", "vm1", true);
    expect(hub.sleepingProjection("t1", "vm1")?.turnItems?.at(-1)?.message).toBe("Waking the boxd VM, about 3 min");
  });

  test("a reconnect to a VM that kept running says so, with no estimate", () => {
    const { store, fleet, hub } = setup();
    store.recordVmEvent({ id: "vm1", provider: "boxd", size: "medium" }, "wake", 20_000);
    fleet.emit("waking", "vm1", false);
    expect(hub.sleepingProjection("t1", "vm1")?.turnItems?.at(-1)?.message).toBe("Reconnecting to the boxd VM...");
  });

  test("a failed wake says so in place until the next wake starts", async () => {
    const { fleet, hub, view } = setup();
    const device = await view("t1");
    fleet.emit("waking", "vm1", true);
    const waking = device.at(-1);
    fleet.emit("wakeFailed", "vm1", "boxd refused the API key.");
    expect(device.at(-1)).toMatchObject({ id: waking?.id, message: "Could not wake the boxd VM: boxd refused the API key.", level: "error", status: "failed" });

    fleet.emit("waking", "vm1", true);
    expect(hub.sleepingProjection("t1", "vm1")?.turnItems?.at(-1)).toMatchObject({ message: "Waking the boxd VM...", status: "running" });
  });
});
