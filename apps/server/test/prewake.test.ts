import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";
import { openDatabase } from "../src/bun/sqlite.ts";
import type { Fleet } from "../src/fleet.ts";
import type { FileTrees } from "../src/gateway/files.ts";
import { Hub } from "../src/gateway/hub.ts";
import { Rpc, type RpcClient } from "../src/gateway/rpc.ts";
import type { Shell } from "../src/gateway/types.ts";
import { Settings } from "../src/settings.ts";
import { Store } from "../src/store.ts";
import type { Traffic } from "../src/traffic.ts";
import type { Backend } from "../src/vm/backend.ts";
import { testEncryption } from "./key.ts";

const unmeasured = { get: () => null, lastDisk: () => null };

/**
 * vm1 sleeps and holds project p1 with thread t1 and archived thread t2. vm2 is awake and holds thread t3. Thread t4
 * is on no VM yet. `ensure` never resolves, as a real wake is still running when the call that started it is answered.
 * `files` stands in for the GitHub file lists a sleeping VM's @ search is answered from.
 */
function setup(files?: FileTrees, budget?: ConstructorParameters<typeof Hub>[5]) {
  const store = new Store(openDatabase(":memory:"), testEncryption);
  store.insertVm({ id: "vm1", provider: "boxd", name: "vm1", size: "medium", state: "sleeping", createdAt: 0 });
  store.insertVm({ id: "vm2", provider: "boxd", name: "vm2", size: "medium", state: "ready", createdAt: 0 });
  store.insertProject({ id: "p1", url: "https://github.com/acme/app.git", branch: null, title: "app", createdAt: 0 });
  store.addProjectVm("p1", "vm1");
  const row = (id: string) => ({ id, title: id, updatedAt: "2026-11-21T00:00:00.000Z" });
  store.saveSnapshot("vm1", "shell", { threads: [row("t1")], archivedThreads: [{ ...row("t2"), archivedAt: "2026-11-21T00:00:00.000Z" }], projects: [] } satisfies Shell);
  store.saveSnapshot("vm2", "shell", { threads: [row("t3")], archivedThreads: [], projects: [] } satisfies Shell);
  store.setThreadVm("t1", "vm1");
  store.setThreadVm("t2", "vm1");
  store.setThreadVm("t3", "vm2");

  const backends = new Map<string, Backend>([["vm2", { call: async () => null } as unknown as Backend]]);
  const woken: string[] = [];
  const fleet = Object.assign(new EventEmitter(), {
    backend: (id: string) => backends.get(id),
    connected: () => [...backends.keys()],
    touch: () => {},
    lease: () => () => {},
    ensure: (id: string) => {
      woken.push(id);
      return new Promise<Backend>(() => {});
    },
  }) as unknown as Fleet;
  const traffic = { record: () => {} } as unknown as Traffic;
  const hub = new Hub(store, new Settings(store.db), fleet, traffic, unmeasured, budget);
  const rpc = new Rpc(hub, {} as never, {} as never, traffic, () => false, files);
  const client = (clientId = "c1") => {
    const sent: { exit?: { _tag: string } }[] = [];
    const call = async (tag: string, payload: object) => {
      // A new object per frame, as the gateway makes.
      const socket: RpcClient = { clientId, cancels: new Map(), send: (frame) => sent.push(frame as (typeof sent)[number]), open: () => true };
      await rpc.handle(socket, { _tag: "Request", id: sent.length, tag, payload });
      return sent.at(-1)?.exit?._tag;
    };
    const visit = (threadId: string, opened?: true) =>
      call("orchestration.dispatchCommand", { type: "thread.visit", commandId: crypto.randomUUID(), threadId, visitedAt: new Date().toISOString(), ...(opened && { opened }) });
    return { call, visit };
  };
  return { woken, client, hub };
}

const upload = { type: "file", name: "notes.txt", mimeType: "text/plain", sizeBytes: 3 };

describe("waking a thread's VM before its message", () => {
  test("opening a thread on a sleeping VM answers at once and starts waking the VM", async () => {
    const { woken, client } = setup();
    expect(await client().visit("t1", true)).toBe("Success");
    expect(woken).toEqual(["vm1"]);
  });

  test("the visits T3 repeats while a thread stays open do not wake its VM", async () => {
    const { woken, client } = setup();
    expect(await client().visit("t1")).toBe("Success");
    expect(woken).toEqual([]);
  });

  test("opening an archived thread, a thread on no VM, or one on an awake VM wakes nothing", async () => {
    const { woken, client } = setup();
    const socket = client();
    for (const threadId of ["t2", "t3", "t4"]) expect(await socket.visit(threadId, true)).toBe("Success");
    expect(woken).toEqual([]);
  });

  test("typing in a thread on a sleeping VM starts waking it, and the agent list answers without waiting", async () => {
    const { woken, client } = setup();
    expect(await client().call("server.refreshProviders", { cwd: "/projects/p1/app", workspaceSnapshotsOnDemand: true })).toBe("Success");
    expect(woken).toEqual(["vm1"]);
  });

  test("refreshing agents with no workspace, as the model picker does, wakes nothing", async () => {
    const { woken, client } = setup();
    expect(await client().call("server.refreshProviders", { modelCatalogOnly: true })).toBe("Success");
    expect(woken).toEqual([]);
  });

  test("searching files with @ on a sleeping VM starts waking it, answered from its cached file list", async () => {
    const files = { search: async () => ({ entries: [], truncated: false }) } as unknown as FileTrees;
    const { woken, client } = setup(files);
    expect(await client().call("projects.searchEntries", { cwd: "/projects/p1/app", query: "src", limit: 20 })).toBe("Success");
    expect(woken).toEqual(["vm1"]);
  });

  test("searching files with @ on a sleeping VM with no cached file list starts waking it and answers that it is asleep", async () => {
    const { woken, client } = setup();
    expect(await client().call("projects.searchEntries", { cwd: "/projects/p1/app", query: "src", limit: 20 })).toBe("Failure");
    expect(woken).toEqual(["vm1"]);
  });

  test("with the month's budget spent, opening a thread wakes nothing early", async () => {
    const { woken, client } = setup(undefined, { allowsEarlyWake: () => false, notice: () => null, refusal: () => null });
    expect(await client().visit("t1", true)).toBe("Success");
    expect(woken).toEqual([]);
  });

  test("a wake past 80% of the budget tells the thread once a month", () => {
    const notices = ["VM Bridge: 85% of this month's $50.00 budget is used.", null];
    const { hub } = setup(undefined, { allowsEarlyWake: () => true, notice: () => notices.shift() ?? null, refusal: () => null });
    hub.store.saveProjection("t1", "vm1", null, { thread: { id: "t1" }, turnItems: [], visibleTurnItems: [] });
    const message = () => {
      hub.fleet.emit("waking", "vm1", true);
      const item = hub.sleepingProjection("t1", "vm1")?.turnItems?.at(-1);
      hub.fleet.emit("awake", "vm1");
      return item?.message;
    };
    expect(message()).toBe("Waking the boxd VM... VM Bridge: 85% of this month's $50.00 budget is used.");
    expect(message()).toBe("Waking the boxd VM...");
  });

  test("attaching a file wakes the VM of the thread that device last visited, and no other device's", async () => {
    const { woken, client } = setup();
    const other = client("c2");
    expect(await other.call("attachments.createUploadUrl", upload)).toBe("Success");
    expect(woken).toEqual([]);

    const device = client();
    await device.visit("t3", true);
    await device.visit("t1");
    expect(woken).toEqual([]);
    expect(await device.call("attachments.createUploadUrl", upload)).toBe("Success");
    expect(woken).toEqual(["vm1"]);
  });
});
