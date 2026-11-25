import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { openDatabase } from "../src/bun/sqlite.ts";
import type { Fleet } from "../src/fleet.ts";
import { Hub } from "../src/gateway/hub.ts";
import { Rpc, type RpcClient } from "../src/gateway/rpc.ts";
import type { Wire } from "../src/gateway/types.ts";
import { Settings } from "../src/settings.ts";
import { Store } from "../src/store.ts";
import { Traffic } from "../src/traffic.ts";
import type { Backend } from "../src/vm/backend.ts";
import { testEncryption } from "./key.ts";

const unmeasured = { get: () => null, lastDisk: () => null };
const dummy = "dummy-value-7f3a9c";

/** Console output during each test, to check that no secret reaches it. */
let printed: string[] = [];
let spies: ReturnType<typeof spyOn>[] = [];
beforeEach(() => {
  printed = [];
  spies = (["log", "warn", "error", "info", "debug"] as const).map((level) =>
    spyOn(console, level).mockImplementation((...args: unknown[]) => void printed.push(args.map(String).join(" "))),
  );
});
afterEach(() => spies.forEach((spy) => spy.mockRestore()));

/** p1 and thread t1 on vm1, p2 and thread t2 on vm2. vm3 sleeps with thread t3. */
function setup(backends: Record<string, Backend | undefined>) {
  const db = openDatabase(":memory:");
  const store = new Store(db, testEncryption);
  const traffic = new Traffic(db);
  for (const [index, vmId] of ["vm1", "vm2", "vm3"].entries()) {
    const n = index + 1;
    store.insertVm({ id: vmId, provider: "kubi", name: vmId, size: "medium", state: vmId === "vm3" ? "sleeping" : "ready", createdAt: 0 });
    store.insertProject({ id: `p${n}`, url: `https://github.com/acme/app${n}.git`, branch: null, title: `app${n}`, createdAt: 0 });
    store.addProjectVm(`p${n}`, vmId);
    store.setCheckout(`p${n}`, vmId, `/workspace/app${n}`);
    store.setThreadVm(`t${n}`, vmId);
  }
  const woken: string[] = [];
  const fleet = Object.assign(new EventEmitter(), {
    backend: (id: string) => backends[id],
    connected: () => Object.keys(backends).filter((id) => backends[id]),
    ensure: async (id: string) => {
      woken.push(id);
      return backends[id];
    },
    lease: () => () => {},
  }) as unknown as Fleet;
  const hub = new Hub(store, new Settings(store.db), fleet, traffic, unmeasured);
  return { db, hub, traffic, woken, rpc: new Rpc(hub, {} as never, {} as never, traffic, () => false) };
}

/** A VM's T3 server answering every request with `exit`. */
function fakeVm(exit: Wire = { _tag: "Success", value: null }) {
  const requests: { tag: string; payload: Wire }[] = [];
  const backend = {
    request: (tag: string, payload: Wire, handler: (frame: Wire) => void) => {
      requests.push({ tag, payload });
      queueMicrotask(() => handler({ _tag: "Exit", exit }));
      return () => {};
    },
  } as unknown as Backend;
  return { backend, requests };
}

function client() {
  const sent: Wire[] = [];
  const rpcClient: RpcClient = { clientId: "c1", cancels: new Map(), send: (frame) => sent.push(frame as Wire), open: () => true };
  return { sent, rpcClient };
}

const answer = (id: number, payload: Wire) => ({ _tag: "Request" as const, id, tag: "secrets.answerRequest", payload });
const exitOf = (sent: Wire[], id: number) => sent.find((frame) => frame.requestId === id && frame._tag === "Exit")?.exit as Wire;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("secret request answers", () => {
  test("go to the thread's own VM exactly as sent, values and decline alike, and wake nothing", async () => {
    const vm1 = fakeVm();
    const vm2 = fakeVm();
    const { hub, rpc, woken } = setup({ vm1: vm1.backend, vm2: vm2.backend });
    const { sent, rpcClient } = client();
    // Field names are the agent's: these look like a path and another VM's thread, and must change nothing.
    const values = { cwd: "/projects/p2/app2", threadId: "t2", token: dummy };
    await rpc.handle(rpcClient, answer(1, { threadId: "t1", turnItemId: "item-1", answer: { type: "save", values } }));
    await rpc.handle(rpcClient, answer(2, { threadId: "t1", turnItemId: "item-2", answer: { type: "decline" } }));
    await settle();
    expect(vm1.requests).toEqual([
      { tag: "secrets.answerRequest", payload: { threadId: "t1", turnItemId: "item-1", answer: { type: "save", values } } },
      { tag: "secrets.answerRequest", payload: { threadId: "t1", turnItemId: "item-2", answer: { type: "decline" } } },
    ]);
    expect(vm2.requests).toEqual([]);
    expect(exitOf(sent, 1)).toEqual({ _tag: "Success", value: null });
    expect(exitOf(sent, 2)).toEqual({ _tag: "Success", value: null });
    expect(woken).toEqual([]);
    hub.close();
  });

  test("for a thread no VM holds go nowhere, whatever the values name", async () => {
    const vm1 = fakeVm();
    const vm2 = fakeVm();
    const { hub, rpc } = setup({ vm1: vm1.backend, vm2: vm2.backend });
    const { sent, rpcClient } = client();
    const values = { cwd: "/vms/vm2/workspace", threadId: "t2", projectId: "p1", secret: dummy };
    await rpc.handle(rpcClient, answer(1, { threadId: "unknown", turnItemId: "item-1", answer: { type: "save", values } }));
    await rpc.handle(rpcClient, answer(2, { turnItemId: "item-1", answer: { type: "save", secret: dummy } }));
    await settle();
    expect(vm1.requests).toEqual([]);
    expect(vm2.requests).toEqual([]);
    expect(exitOf(sent, 1)).toEqual({ _tag: "Failure", cause: [{ _tag: "Fail", error: { _tag: "SecretRequestError", reason: "not_found" } }] });
    expect(exitOf(sent, 2)).toEqual({ _tag: "Failure", cause: [{ _tag: "Fail", error: { _tag: "SecretRequestError", reason: "not_found" } }] });
    hub.close();
  });

  test("for a sleeping VM's thread are refused as T3 refuses an ended run, without waking it or asking another VM", async () => {
    const vm1 = fakeVm();
    const { hub, rpc, woken } = setup({ vm1: vm1.backend });
    const { sent, rpcClient } = client();
    await rpc.handle(rpcClient, answer(1, { threadId: "t3", turnItemId: "item-1", answer: { type: "save", secret: dummy } }));
    expect(exitOf(sent, 1)).toEqual({ _tag: "Failure", cause: [{ _tag: "Fail", error: { _tag: "SecretRequestError", reason: "agent_stopped" } }] });
    expect(woken).toEqual([]);
    expect(vm1.requests).toEqual([]);
    hub.close();
  });

  test("leave no value in traffic, the database, the console or any reply, whether they work or fail", async () => {
    const vm1 = fakeVm();
    const failing = fakeVm({ _tag: "Failure", cause: [{ _tag: "Fail", error: { _tag: "SecretRequestError", reason: "store_failed" } }] });
    const { db, hub, traffic, rpc } = setup({ vm1: vm1.backend, vm2: failing.backend });
    const { sent, rpcClient } = client();
    const saved = { threadId: "t1", turnItemId: "item-1", answer: { type: "save", values: { token: dummy } } };
    await rpc.handle(rpcClient, answer(1, saved));
    await rpc.handle(rpcClient, answer(2, { threadId: "t2", turnItemId: "item-1", answer: { type: "save", secret: dummy } }));
    await rpc.handle(rpcClient, answer(3, { threadId: "t3", turnItemId: "item-1", answer: { type: "save", secret: dummy } }));
    await rpc.handle(rpcClient, answer(4, { threadId: "unknown", turnItemId: "item-1", answer: { type: "save", secret: dummy } }));
    await settle();
    expect(vm1.requests).toEqual([{ tag: "secrets.answerRequest", payload: saved }]);
    expect(traffic.recent.map((event) => [event.operation, event.vmId])).toEqual([
      ["secrets.answerRequest", "vm1"],
      ["secrets.answerRequest", "vm2"],
      ["secrets.answerRequest", undefined],
      ["secrets.answerRequest", undefined],
    ]);
    const tables = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'");
    const rows = tables.flatMap(({ name }) => db.all<Wire>(`SELECT * FROM "${name}"`));
    for (const place of [traffic.recent, rows, printed, sent]) expect(JSON.stringify(place)).not.toContain(dummy);
    hub.close();
  });
});
