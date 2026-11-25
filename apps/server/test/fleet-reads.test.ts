import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";
import { openDatabase } from "../src/bun/sqlite.ts";
import type { Fleet } from "../src/fleet.ts";
import { Hub } from "../src/gateway/hub.ts";
import { Rpc, type RpcClient } from "../src/gateway/rpc.ts";
import type { Wire } from "../src/gateway/types.ts";
import { Settings } from "../src/settings.ts";
import { Store } from "../src/store.ts";
import type { Traffic } from "../src/traffic.ts";
import type { Backend } from "../src/vm/backend.ts";
import { testEncryption } from "./key.ts";

const traffic = { record: () => {}, refused: () => {} } as unknown as Traffic;
const unmeasured = { get: () => null, lastDisk: () => null };

/**
 * Three VMs: p1 on vm1, p2 on vm2, p3 on vm3, one thread each. p4 is on no VM yet. The test gives the fleet
 * whichever VMs are awake.
 */
function setup(backends: Record<string, Backend | undefined>) {
  const store = new Store(openDatabase(":memory:"), testEncryption);
  for (const [index, vmId] of ["vm1", "vm2", "vm3"].entries()) {
    const n = index + 1;
    store.insertVm({ id: vmId, provider: "kubi", name: vmId, size: "medium", state: "ready", createdAt: 0 });
    store.insertProject({ id: `p${n}`, url: `https://github.com/acme/app${n}.git`, branch: null, title: `app${n}`, createdAt: 0 });
    store.addProjectVm(`p${n}`, vmId);
    store.setCheckout(`p${n}`, vmId, `/workspace/app${n}`);
    store.setThreadVm(`t${n}`, vmId);
  }
  store.insertProject({ id: "p4", url: "https://github.com/acme/app4.git", branch: null, title: "app4", createdAt: 0 });
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
  return { hub, fleet, woken, rpc: new Rpc(hub, {} as never, {} as never, traffic, () => false) };
}

function client() {
  const sent: Wire[] = [];
  const rpcClient: RpcClient = { clientId: "c1", cancels: new Map(), send: (frame) => sent.push(frame as Wire), open: () => true };
  return { sent, rpcClient };
}

/** A VM's T3 server: answers each tag with `answer(tag, payload)`, fails where it throws, and streams on `push`. */
function fakeVm(answer: (tag: string, payload: Wire) => unknown = (tag) => ({ from: tag })) {
  const requests: { tag: string; payload: Wire }[] = [];
  const streams = new Set<(values: unknown[]) => void>();
  const backend = {
    request: (tag: string, payload: Wire, handler: (frame: Wire) => void) => {
      requests.push({ tag, payload });
      if (tag.includes("subscribe")) {
        const push = (values: unknown[]) => handler({ _tag: "Chunk", values });
        streams.add(push);
        return () => streams.delete(push);
      }
      queueMicrotask(() => {
        try {
          handler({ _tag: "Exit", exit: { _tag: "Success", value: answer(tag, payload) } });
        } catch {
          handler({ _tag: "Exit", exit: { _tag: "Failure", cause: [] } });
        }
      });
      return () => {};
    },
    call(tag: string, payload: Wire) {
      requests.push({ tag, payload });
      return Promise.resolve().then(() => answer(tag, payload));
    },
  } as unknown as Backend;
  return { backend, requests, push: (values: unknown[]) => streams.forEach((push) => push(values)) };
}

const request = (id: number, tag: string, payload: Wire = {}) => ({ _tag: "Request" as const, id, tag, payload });
const exitOf = (sent: Wire[], id: number) => sent.find((frame) => frame.requestId === id && frame._tag === "Exit")?.exit as Wire;
const valueOf = (sent: Wire[], id: number) => exitOf(sent, id).value as Wire;

describe("reads VM Bridge answers for the whole fleet", () => {
  test("thread search ranks every awake VM's hits together, keeps each VM to its own threads, and wakes none", async () => {
    const match = (threadId: string, quality: number, source = "assistant") => ({ threadId, projectId: "p", source, snippet: threadId, messageCreatedAt: null, quality });
    // vm2 also claims vm1's thread, which must be dropped.
    const vm1 = fakeVm(() => ({ matches: [match("t1", 0.3)] }));
    const vm2 = fakeVm(() => ({ matches: [match("t2", 1), match("t1", 1), match("t2", 0.3, "user")] }));
    const { hub, rpc, woken } = setup({ vm1: vm1.backend, vm2: vm2.backend });
    const { sent, rpcClient } = client();
    await rpc.handle(rpcClient, request(1, "orchestration.searchThreads", { query: "deploy", limit: 2 }));
    expect(vm1.requests[0]).toEqual({ tag: "orchestration.searchThreads", payload: { query: "deploy", limit: 2 } });
    expect((valueOf(sent, 1).matches as Wire[]).map((hit) => [hit.threadId, hit.quality, hit.source])).toEqual([
      ["t2", 1, "assistant"],
      ["t2", 0.3, "user"],
    ]);
    expect(woken).toEqual([]);
    hub.close();
  });

  test("thread search with every VM asleep finds nothing, and with every awake VM failing reports T3's error", async () => {
    const asleep = setup({});
    const { sent, rpcClient } = client();
    await asleep.rpc.handle(rpcClient, request(1, "orchestration.searchThreads", { query: "deploy" }));
    expect(valueOf(sent, 1)).toEqual({ matches: [] });
    asleep.hub.close();

    const failing = setup({
      vm1: fakeVm(() => {
        throw new Error("no index");
      }).backend,
    });
    await failing.rpc.handle(rpcClient, request(2, "orchestration.searchThreads", { query: "deploy" }));
    expect(exitOf(sent, 2)).toMatchObject({ _tag: "Failure", cause: [{ _tag: "Fail", error: { _tag: "OrchestrationSearchThreadsError" } }] });
    failing.hub.close();
  });

  test("pull requests are listed per primary VM and merged, with sleeping and unplaced projects as errors", async () => {
    const list = (n: number, updatedAt: string) => ({
      viewers: { "github.com": "octo" },
      providers: [{ host: "github.com", kind: "github", searchesOnHost: true, projectCount: 1, projectIds: [`p${n}`], configured: true, detail: null }],
      entries: [{ projectId: `p${n}`, number: n, updatedAt }],
      errors: [],
      truncated: n === 2,
      nextCursors: { [`repo${n}`]: `c${n}` },
    });
    const vm1 = fakeVm(() => list(1, "2026-11-01T00:00:00Z"));
    const vm2 = fakeVm(() => list(2, "2026-11-02T00:00:00Z"));
    const { hub, rpc, woken } = setup({ vm1: vm1.backend, vm2: vm2.backend });
    const { sent, rpcClient } = client();
    await rpc.handle(rpcClient, request(1, "pullRequests.list", { state: "open", limit: 20 }));

    expect(vm1.requests.map((sent) => sent.payload)).toEqual([{ state: "open", limit: 20, projectIds: ["p1"] }]);
    expect(vm2.requests.map((sent) => sent.payload)).toEqual([{ state: "open", limit: 20, projectIds: ["p2"] }]);
    const value = valueOf(sent, 1);
    expect((value.entries as Wire[]).map((entry) => entry.number)).toEqual([2, 1]);
    expect(value.providers).toEqual([
      { host: "github.com", kind: "github", searchesOnHost: true, projectCount: 2, projectIds: ["p1", "p2"], configured: true, detail: null },
    ]);
    expect(value).toMatchObject({ viewers: { "github.com": "octo" }, truncated: true, nextCursors: { repo1: "c1", repo2: "c2" } });
    expect(value.errors).toEqual([
      { projectId: "p3", projectTitle: "app3", message: "Its VM is asleep. Sending a message in one of its threads wakes it." },
      { projectId: "p4", projectTitle: "app4", message: "This project is not on a VM yet." },
    ]);
    expect(woken).toEqual([]);

    // The branch picker asks about one project, which only its VM reads.
    await rpc.handle(rpcClient, request(2, "pullRequests.list", { state: "open", projectId: "p2", limit: 5 }));
    expect(vm1.requests).toHaveLength(1);
    expect(vm2.requests.at(-1)?.payload).toEqual({ state: "open", limit: 5, projectIds: ["p2"] });
    expect(valueOf(sent, 2).errors).toEqual([]);
    hub.close();
  });

  test("a VM failing its pull request read leaves its projects as errors and the rest listed", async () => {
    const vm1 = fakeVm(() => {
      throw new Error("gh missing");
    });
    const { hub, rpc } = setup({ vm1: vm1.backend });
    const { sent, rpcClient } = client();
    await rpc.handle(rpcClient, request(1, "pullRequests.list", { state: "open", projectIds: ["p1"] }));
    expect(valueOf(sent, 1)).toMatchObject({ entries: [], errors: [{ projectId: "p1", projectTitle: "app1", message: "Its pull requests could not be read." }] });
    hub.close();
  });

  test("pull request refreshes from any awake VM, or one that wakes later, move one fleet count", async () => {
    const vm1 = fakeVm();
    const vm2 = fakeVm();
    const backends: Record<string, Backend | undefined> = { vm1: vm1.backend };
    const { hub, rpc, fleet } = setup(backends);
    const { sent, rpcClient } = client();
    await rpc.handle(rpcClient, request(1, "pullRequests.subscribeRefreshes"));
    vm1.push([4]);
    backends.vm2 = vm2.backend;
    fleet.emit("awake", "vm2");
    vm2.push([1]);
    expect(sent.map((frame) => frame.values)).toEqual([[1], [2]]);

    await rpc.handle(rpcClient, { _tag: "Interrupt", requestId: 1 });
    vm1.push([5]);
    expect(sent).toHaveLength(2);
    hub.close();
  });

  test("other pull request reads go to the project's VM, and a sleeping one is not woken for them", async () => {
    const vm1 = fakeVm();
    const { hub, rpc, woken } = setup({ vm1: vm1.backend });
    const { sent, rpcClient } = client();
    const ref = { repository: "acme/app", number: 7 };
    await rpc.handle(rpcClient, request(1, "pullRequests.detail", { ...ref, projectId: "p1" }));
    await Bun.sleep(0);
    expect(valueOf(sent, 1)).toEqual({ from: "pullRequests.detail" });

    await rpc.handle(rpcClient, request(2, "pullRequests.detail", { ...ref, projectId: "p2" }));
    expect(JSON.stringify(exitOf(sent, 2))).toContain("This VM is asleep.");
    expect(woken).toEqual(["vm1"]);
    hub.close();
  });

  test("a diff preview of a project with no awake checkout is empty, and one on an awake VM is the VM's", async () => {
    const vm1 = fakeVm();
    const { hub, rpc, woken } = setup({ vm1: vm1.backend });
    const { sent, rpcClient } = client();
    await rpc.handle(rpcClient, request(1, "review.getDiffPreview", { cwd: "/projects/p2/app2", sourceKind: "branch-range" }));
    await rpc.handle(rpcClient, request(2, "review.getDiffPreview", { cwd: "/projects/p4/app4" }));
    expect(valueOf(sent, 1)).toMatchObject({ cwd: "/projects/p2/app2", sources: [] });
    expect(valueOf(sent, 2)).toMatchObject({ cwd: "/projects/p4/app4", sources: [] });
    expect(Date.parse(String(valueOf(sent, 1).generatedAt))).not.toBeNaN();

    await rpc.handle(rpcClient, request(3, "review.getDiffPreview", { cwd: "/projects/p1/app1" }));
    await Bun.sleep(0);
    expect(vm1.requests.at(-1)).toEqual({ tag: "review.getDiffPreview", payload: { cwd: "/workspace/app1" } });
    expect(valueOf(sent, 3)).toEqual({ from: "review.getDiffPreview" });
    expect(woken).toEqual(["vm1"]);
    hub.close();
  });

  test("a thread no VM has reported has no preview tabs, answered at once", async () => {
    const { hub, rpc } = setup({});
    const { sent, rpcClient } = client();
    const started = performance.now();
    await rpc.handle(rpcClient, request(1, "preview.list", { threadId: "draft" }));
    await rpc.handle(rpcClient, request(2, "preview.close", { threadId: "draft", tabId: "tab1" }));
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(valueOf(sent, 1)).toMatchObject({ sessions: [], revision: 0 });
    expect(exitOf(sent, 2)).toEqual({ _tag: "Success", value: null });
    hub.close();
  });

  test("void answers keep their value on the wire, and local servers are an empty list", async () => {
    const { hub, rpc } = setup({});
    const { sent, rpcClient } = client();
    await rpc.handle(rpcClient, request(1, "server.reportClientActivity", { activeThreadId: null }));
    await rpc.handle(rpcClient, request(2, "preview.reportProfiles", { profiles: [] }));
    for (const id of [1, 2]) expect(JSON.parse(JSON.stringify(exitOf(sent, id)))).toEqual({ _tag: "Success", value: null });

    await rpc.handle(rpcClient, request(3, "subscribeDiscoveredLocalServers", {}));
    expect(sent.at(-1)).toMatchObject({ _tag: "Chunk", requestId: 3, values: [{ servers: [] }] });
    expect(rpcClient.cancels.has("3")).toBe(true);
    hub.close();
  });
});
