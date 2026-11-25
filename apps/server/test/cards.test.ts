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

/**
 * p1 and thread t1 on vm1, p2 and thread t2 on vm2. vm3 sleeps with thread t3, and `waking` is what connects when a
 * VM is woken. vm4 was removed and still lists thread t4.
 */
function setup(backends: Record<string, Backend | undefined>, waking: Record<string, Backend> = {}) {
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
  store.insertVm({ id: "vm4", provider: "kubi", name: "vm4", size: "medium", state: "gone", createdAt: 0 });
  store.setThreadVm("t4", "vm4");
  const woken: string[] = [];
  const leases: string[] = [];
  const fleet = Object.assign(new EventEmitter(), {
    backend: (id: string) => backends[id],
    connected: () => Object.keys(backends).filter((id) => backends[id]),
    ensure: async (id: string) => {
      woken.push(id);
      backends[id] ??= waking[id];
      if (!backends[id]) throw new Error("could not wake");
      return backends[id];
    },
    lease: (id: string) => {
      leases.push(id);
      return () => leases.splice(leases.indexOf(id), 1);
    },
  }) as unknown as Fleet;
  const hub = new Hub(store, new Settings(store.db), fleet, traffic, unmeasured);
  return { db, hub, traffic, woken, leases, rpc: new Rpc(hub, {} as never, {} as never, traffic, () => false) };
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

function client(open = () => true) {
  const sent: Wire[] = [];
  const rpcClient: RpcClient = { clientId: "c1", cancels: new Map(), send: (frame) => sent.push(frame as Wire), open };
  return { sent, rpcClient };
}

const answer = (id: number, payload: Wire) => ({ _tag: "Request" as const, id, tag: "secrets.answerRequest", payload });
const feedback = (id: number, payload: Wire) => ({ _tag: "Request" as const, id, tag: "agentFeedback.answerRequest", payload });
const refused = (error: string, reason: string) => ({ _tag: "Failure", cause: [{ _tag: "Fail", error: { _tag: error, reason } }] });
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

  test("for a removed VM's thread go nowhere", async () => {
    const { hub, rpc, woken } = setup({});
    const { sent, rpcClient } = client();
    await rpc.handle(rpcClient, answer(1, { threadId: "t4", turnItemId: "item-1", answer: { type: "decline" } }));
    expect(exitOf(sent, 1)).toEqual(refused("SecretRequestError", "not_found"));
    expect(woken).toEqual([]);
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

describe("feedback card answers", () => {
  const card = (threadId: string, answer: "send" | "decline") => ({ threadId, turnItemId: "turn-item:feedback-request:r1", answer, includeConversation: true });

  test("go to the thread's own awake VM exactly as sent, and wake nothing", async () => {
    const vm1 = fakeVm();
    const vm2 = fakeVm();
    const { hub, rpc, woken, leases } = setup({ vm1: vm1.backend, vm2: vm2.backend });
    const { sent, rpcClient } = client();
    await rpc.handle(rpcClient, feedback(1, card("t1", "send")));
    await rpc.handle(rpcClient, feedback(2, card("t2", "decline")));
    await settle();
    expect(vm1.requests).toEqual([{ tag: "agentFeedback.answerRequest", payload: card("t1", "send") }]);
    expect(vm2.requests).toEqual([{ tag: "agentFeedback.answerRequest", payload: card("t2", "decline") }]);
    expect(exitOf(sent, 1)).toEqual({ _tag: "Success", value: null });
    expect(exitOf(sent, 2)).toEqual({ _tag: "Success", value: null });
    expect(woken).toEqual([]);
    expect(leases).toEqual([]);
    hub.close();
  });

  test("for a sleeping VM's thread wake that VM only, since the card outlives its run", async () => {
    const vm1 = fakeVm();
    const vm3 = fakeVm();
    const { hub, rpc, woken, leases } = setup({ vm1: vm1.backend }, { vm3: vm3.backend });
    const { sent, rpcClient } = client();
    await rpc.handle(rpcClient, feedback(1, card("t3", "decline")));
    await settle();
    expect(woken).toEqual(["vm3"]);
    expect(vm3.requests).toEqual([{ tag: "agentFeedback.answerRequest", payload: card("t3", "decline") }]);
    expect(vm1.requests).toEqual([]);
    expect(exitOf(sent, 1)).toEqual({ _tag: "Success", value: null });
    // Released once T3 answered, so the VM can sleep again.
    expect(leases).toEqual([]);
    hub.close();
  });

  test("for a thread no VM holds, or a removed VM's, are refused as T3 refuses a missing card, contacting no VM", async () => {
    const vm1 = fakeVm();
    const { hub, rpc, woken } = setup({ vm1: vm1.backend });
    const { sent, rpcClient } = client();
    await rpc.handle(rpcClient, feedback(1, card("unknown", "send")));
    await rpc.handle(rpcClient, feedback(2, { turnItemId: "turn-item:feedback-request:r1", answer: "send" }));
    await rpc.handle(rpcClient, feedback(3, card("t4", "send")));
    for (const id of [1, 2, 3]) expect(exitOf(sent, id)).toEqual(refused("AgentFeedbackRequestError", "not_found"));
    expect(vm1.requests).toEqual([]);
    expect(woken).toEqual([]);
    hub.close();
  });

  test("pass T3's refusal back, and record only the method, VM and status", async () => {
    const answered = fakeVm(refused("AgentFeedbackRequestError", "already_answered"));
    const { hub, rpc, traffic } = setup({ vm1: answered.backend });
    const { sent, rpcClient } = client();
    await rpc.handle(rpcClient, feedback(1, card("t1", "send")));
    await rpc.handle(rpcClient, feedback(2, card("unknown", "decline")));
    await settle();
    expect(exitOf(sent, 1)).toEqual(refused("AgentFeedbackRequestError", "already_answered"));
    expect(traffic.recent.map((event) => [event.operation, event.vmId, event.status])).toEqual([
      ["agentFeedback.answerRequest", "vm1", "error"],
      ["agentFeedback.answerRequest", undefined, "ok"],
    ]);
    for (const word of ["send", "decline", "includeConversation", "feedback-request"]) expect(JSON.stringify(traffic.recent)).not.toContain(word);
    hub.close();
  });

  test("send nothing for a device that left while its VM woke", async () => {
    const vm3 = fakeVm();
    const { hub, rpc, woken, leases } = setup({}, { vm3: vm3.backend });
    let open = true;
    const { sent, rpcClient } = client(() => open);
    const pending = rpc.handle(rpcClient, feedback(1, card("t3", "send")));
    open = false;
    await pending;
    await settle();
    expect(woken).toEqual(["vm3"]);
    expect(vm3.requests).toEqual([]);
    expect(sent).toEqual([]);
    expect(leases).toEqual([]);
    hub.close();
  });
});

describe("feedback card setting", () => {
  /** A VM's T3 server in agent feedback `mode`, without the setting when not `capable`, recording settings it is sent. */
  function settingsVm(mode = "off", capable = true) {
    const updates: unknown[] = [];
    const capabilities = capable ? { agentFeedback: true } : {};
    const config = { environment: { orchestrationProtocolVersion: 2, capabilities }, settings: { agentFeedback: { mode } }, providers: [] };
    const backend = {
      call: async (tag: string, payload: Wire) => {
        if (tag === "server.getConfig") return config;
        if (tag === "server.updateSettings") updates.push(payload.patch);
        return null;
      },
      request: () => () => {},
    } as unknown as Backend;
    return { backend, updates };
  }

  const feedbackMode = (mode: string) => ({ agentFeedback: { mode } });

  test("goes to every awake VM whose T3 has it, at once and without a restart", async () => {
    const vm1 = settingsVm();
    const older = settingsVm("off", false);
    const { hub } = setup({ vm1: vm1.backend, vm2: older.backend });
    await hub.fleet.onConnect("vm1", vm1.backend);
    await hub.fleet.onConnect("vm2", older.backend);
    for (const mode of ["on-request", "auto", "off"] as const) hub.setAgentFeedback(mode);
    await settle();
    expect(vm1.updates).toEqual([feedbackMode("on-request"), feedbackMode("auto"), feedbackMode("off")]);
    // Its T3 has no such setting, and would refuse it.
    expect(older.updates).toEqual([]);
    expect(hub.settings.get("agentFeedback")).toBe("off");
    hub.close();
  });

  test("reaches a sleeping or new VM as it connects, before it counts as awake, and only when it differs", async () => {
    const vm1 = settingsVm();
    const vm3 = settingsVm();
    const already = settingsVm("auto");
    const { hub } = setup({ vm1: vm1.backend });
    hub.setAgentFeedback("auto");
    await hub.fleet.onConnect("vm3", vm3.backend);
    expect(vm3.updates).toEqual([feedbackMode("auto")]);
    await hub.fleet.onConnect("vm2", already.backend);
    expect(already.updates).toEqual([]);
    hub.close();
  });

  test("a save that lands while a VM connects reaches it once it is awake", async () => {
    const vm3 = settingsVm();
    // Empty until the fleet publishes the VM, as while it connects.
    const backends: Record<string, Backend | undefined> = {};
    const { hub } = setup(backends);
    hub.setAgentFeedback("auto");
    const call = vm3.backend.call.bind(vm3.backend);
    // The save lands during the connecting VM's own update, before it counts as awake.
    (vm3.backend as { call: unknown }).call = async (tag: string, payload: Wire) => {
      const result = await call(tag, payload);
      if (tag === "server.updateSettings" && vm3.updates.length === 1) hub.setAgentFeedback("off");
      return result;
    };
    await hub.fleet.onConnect("vm3", vm3.backend);
    expect(vm3.updates).toEqual([feedbackMode("auto")]);
    backends.vm3 = vm3.backend;
    hub.fleet.emit("awake", "vm3");
    await settle();
    expect(vm3.updates).toEqual([feedbackMode("auto"), feedbackMode("off")]);
    // Already sent: waking again sends nothing.
    hub.fleet.emit("awake", "vm3");
    await settle();
    expect(vm3.updates).toHaveLength(2);
    hub.close();
  });

  test("a VM refusing it still connects", async () => {
    const vm1 = settingsVm();
    const backend = {
      ...vm1.backend,
      call: async (tag: string, payload: Wire) => {
        if (tag === "server.updateSettings") throw new Error("refused");
        return vm1.backend.call(tag, payload);
      },
    } as unknown as Backend;
    const { hub } = setup({ vm1: backend });
    hub.setAgentFeedback("auto");
    await settle();
    await hub.fleet.onConnect("vm1", backend);
    expect(hub.hasConfig()).toBe(true);
    hub.close();
  });
});
