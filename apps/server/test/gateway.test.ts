import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import type { Fleet } from "../src/fleet.ts";
import { Hub } from "../src/gateway/hub.ts";
import { translate } from "../src/gateway/paths.ts";
import { githubName, normalizeRemote } from "../src/gateway/repos.ts";
import { Rpc, type RpcClient } from "../src/gateway/rpc.ts";
import type { Traffic } from "../src/traffic.ts";
import { Settings } from "../src/settings.ts";
import type { Wire } from "../src/gateway/types.ts";
import type { VmLoad } from "../src/placement.ts";
import { Store, type ProjectRow, type VmRow } from "../src/store.ts";

/** No resource readings: placement goes by thread counts and size labels alone. */
const unmeasured = { get: () => null, lastDisk: () => null };

const project: ProjectRow = {
  id: "p1",
  url: "https://github.com/acme/app.git",
  branch: null,
  title: "app",
  createdAt: 0,
  vms: [{ vmId: "vm1", checkoutPath: "/workspace/app" }],
};

/** The same project with a second VM, whose checkout sits at another path. */
const spread: ProjectRow = { ...project, vms: [...project.vms, { vmId: "vm2", checkoutPath: "/workspace/app-2" }] };

describe("path translation", () => {
  test("maps checkouts and other VM paths both ways, and leaves IDs alone", () => {
    const vm = { cwd: "/workspace/app/src", worktreePath: "/workspace/.t3/wt/1", threadId: "/workspace/app", nested: [{ path: "/workspace/app" }] };
    const client = translate(vm, "vm1", "out", [project]);
    expect(client).toEqual({
      cwd: "/projects/p1/app/src",
      worktreePath: "/vms/vm1/workspace/.t3/wt/1",
      threadId: "/workspace/app",
      nested: [{ path: "/projects/p1/app" }],
    });
    expect(translate(client, "vm1", "in", [project])).toEqual(vm);
  });

  test("does not rewrite a project's paths for a different VM", () => {
    expect(translate({ cwd: "/projects/p1/app" }, "vm2", "in", [project])).toEqual({ cwd: "/projects/p1/app" });
  });

  test("a project on two VMs maps its one client root to each VM's own checkout", () => {
    expect(translate({ cwd: "/projects/p1/app/src" }, "vm1", "in", [spread])).toEqual({ cwd: "/workspace/app/src" });
    expect(translate({ cwd: "/projects/p1/app/src" }, "vm2", "in", [spread])).toEqual({ cwd: "/workspace/app-2/src" });
    expect(translate({ cwd: "/workspace/app-2/src", worktreePath: "/workspace/.t3/wt/1" }, "vm2", "out", [spread])).toEqual({
      cwd: "/projects/p1/app/src",
      worktreePath: "/vms/vm2/workspace/.t3/wt/1",
    });
  });
});

describe("routing a project on two VMs", () => {
  function setup() {
    const store = new Store(openDatabase(":memory:"));
    for (const id of ["vm1", "vm2", "vm3"]) store.insertVm({ id, provider: "boxd", name: id, size: "medium", state: "ready", createdAt: 0 });
    store.insertProject({ id: "p1", url: "https://github.com/acme/app.git", branch: null, title: "app", createdAt: 0 });
    store.addProjectVm("p1", "vm1");
    store.setCheckout("p1", "vm1", "/workspace/app");
    store.addProjectVm("p1", "vm2");
    store.setCheckout("p1", "vm2", "/workspace/app");
    store.setThreadVm("t1", "vm1");
    store.setThreadVm("t2", "vm2");
    const fleet = Object.assign(new EventEmitter(), { backend: () => undefined }) as unknown as Fleet;
    const hub = new Hub(store, new Settings(store.db), fleet, { record: () => {} } as unknown as Traffic, unmeasured);
    return { store, hub };
  }

  test("a thread's requests stay on its VM, and the project root alone goes to the primary", () => {
    const { hub } = setup();
    expect(hub.route({ threadId: "t2", cwd: "/projects/p1/app" })).toBe("vm2");
    expect(hub.route({ threadId: "t1", projectId: "p1" })).toBe("vm1");
    expect(hub.route({ cwd: "/vms/vm2/workspace/.t3/wt/1" })).toBe("vm2");
    expect(hub.route({ cwd: "/projects/p1/app" })).toBe("vm1");
    expect(hub.into({ threadId: "t2", cwd: "/projects/p1/app/src" }, "vm2")).toEqual({ threadId: "t2", cwd: "/workspace/app/src" });
  });

  test("a request pairing the project with a VM that does not hold it is refused", () => {
    const { hub } = setup();
    expect(() => hub.route({ projectId: "p1", cwd: "/vms/vm3/workspace" })).toThrow("This project has no checkout on that VM.");
  });

  test("a running thread stays on its VM, whatever new threads do", async () => {
    const { hub, store } = setup();
    const prepared = await hub.prepare("orchestration.dispatchCommand", { type: "message.dispatch", commandId: "c9", threadId: "t2", message: "Go on" }, true);
    expect(prepared.vmId).toBe("vm2");
    expect(store.threadVm("t2")).toBe("vm2");
  });

  test("a thread placed on a busy VM shows why in its setup, and counts toward that VM until T3 lists it", async () => {
    const { store, hub } = setup();
    const seen: number[] = [];
    const placeThread = async (_projectId: string, options: { load: (vm: VmRow) => VmLoad; placed: (vmId: string) => void }) => {
      seen.push(options.load(store.vm("vm1")!).turns);
      options.placed("vm1");
      return { vmId: "vm1", notice: "This VM is running 4 threads on 2 vCPUs, so this one may be slow." };
    };
    Object.assign(hub.fleet, { placeThread });
    const first = await hub.prepare("orchestration.launchThread", { commandId: "l1", projectId: "p1" }, true);
    await hub.prepare("orchestration.launchThread", { commandId: "l2", projectId: "p1" }, true);
    expect(seen).toEqual([0, 1]);

    const threadId = first.payload.threadId as string;
    hub.reportSetup(threadId, "Preparing the workspace");
    const stage = (hub.setupSnapshot(threadId)?.stages as Wire[])[0];
    expect(stage).toMatchObject({ status: "warning", detail: "This VM is running 4 threads on 2 vCPUs, so this one may be slow." });
    const native = { stages: [{ id: "checkout", detail: null }, { id: "agent", detail: null }] };
    expect(hub.withBusyNotice(threadId, native).stages).toEqual([
      { id: "checkout", detail: null },
      { id: "agent", detail: "This VM is running 4 threads on 2 vCPUs, so this one may be slow." },
    ]);
    // T3's own detail, such as why the agent failed to start, is not hidden by the notice.
    const failed = { stages: [{ id: "agent", status: "failed", detail: "Agent exited" }] };
    expect(hub.withBusyNotice(threadId, failed).stages).toEqual([{ id: "agent", status: "failed", detail: "Agent exited" }]);
  });

  test("after VM Bridge restarts, a VM still reconnecting counts the turns its saved shell had", async () => {
    const { store } = setup();
    const working = (id: string) => ({ id, projectId: "p1", activeRunId: `run-${id}` });
    store.saveSnapshot("vm1", "shell", { threads: [working("t1"), working("t3"), { id: "t4", projectId: "p1" }] });
    store.saveSnapshot("vm2", "shell", { threads: [working("t2")] });
    store.updateVm("vm2", { state: "sleeping" });
    const fleet = Object.assign(new EventEmitter(), { backend: () => undefined }) as unknown as Fleet;
    const hub = new Hub(store, new Settings(store.db), fleet, { record: () => {} } as unknown as Traffic, unmeasured);
    const seen: Record<string, number> = {};
    const placeThread = async (_projectId: string, options: { load: (vm: VmRow) => VmLoad; placed: (vmId: string) => void }) => {
      for (const vmId of ["vm1", "vm2"]) seen[vmId] = options.load(store.vm(vmId)!).turns;
      options.placed("vm2");
      return { vmId: "vm2", notice: null };
    };
    Object.assign(fleet, { placeThread });
    await hub.prepare("orchestration.launchThread", { commandId: "l1", projectId: "p1" }, true);
    // A sleeping VM runs nothing, whatever it was doing when it went to sleep.
    expect(seen).toEqual({ vm1: 2, vm2: 0 });
  });

  test("the provider losing one VM takes only that VM from the project", () => {
    const { store } = setup();
    store.removeVmFromProjects("vm1");
    expect(store.project("p1")?.vms).toEqual([{ vmId: "vm2", checkoutPath: "/workspace/app" }]);
    store.deleteVm("vm2");
    expect(store.project("p1")?.vms).toEqual([]);
  });
});

describe("remotes", () => {
  test("accepts GitHub shorthands and plain HTTPS", () => {
    expect(githubName("git@github.com:acme/app.git")).toBe("acme/app");
    expect(normalizeRemote("acme/app")).toBe("https://github.com/acme/app.git");
    expect(normalizeRemote("https://gitlab.com/acme/app.git")).toBe("https://gitlab.com/acme/app.git");
  });

  test("rejects anything that could smuggle options or credentials into git", () => {
    for (const bad of ["http://example.com/a/b", "https://user:pass@example.com/a/b", "ext::sh -c id", "https://example.com/a b", "--upload-pack=x"]) {
      expect(() => normalizeRemote(bad)).toThrow();
    }
  });
});

describe("rpc", () => {
  test("answers with the request ID's own type, as T3 clients match replies by value", async () => {
    const traffic = { record: () => {} } as unknown as Traffic;
    const rpc = new Rpc({} as never, {} as never, {} as never, traffic, () => false);
    const sent: unknown[] = [];
    const client: RpcClient = { clientId: "c1", cancels: new Map(), send: (frame) => sent.push(frame), open: () => true };
    await rpc.handle(client, { _tag: "Request", id: 0, tag: "server.probe", payload: {} });
    await rpc.handle(client, { _tag: "Request", id: "1", tag: "server.probe", payload: {} });
    expect(sent.map((frame) => (frame as { requestId: unknown }).requestId)).toEqual([0, "1"]);
  });

  test("a config stream that cannot start leaves no listener, and one that fails later ends without failing the emitter", async () => {
    const traffic = { record: () => {} } as unknown as Traffic;
    const store = new Store(openDatabase(":memory:"));
    const fleet = Object.assign(new EventEmitter(), { backend: () => undefined, any: async () => "vm1" }) as unknown as Fleet;
    const hub = new Hub(store, new Settings(store.db), fleet, traffic, unmeasured);
    const rpc = new Rpc(hub, {} as never, {} as never, traffic, () => false);
    const sent: { _tag?: string; exit?: { _tag: string } }[] = [];
    const client: RpcClient = { clientId: "c1", cancels: new Map(), send: (frame) => sent.push(frame), open: () => true };

    // No VM has reported a config yet, and no provider is set up to start one.
    await rpc.handle(client, { _tag: "Request", id: 1, tag: "subscribeServerConfig", payload: {} });
    expect(sent.at(-1)?.exit?._tag).toBe("Failure");
    expect(hub.listenerCount("config")).toBe(0);
    expect(client.cancels.size).toBe(0);

    store.insertVm({ id: "vm1", provider: "boxd", name: "vm1", size: "medium", state: "sleeping", createdAt: 0 });
    store.saveSnapshot("vm1", "config", { environment: { orchestrationProtocolVersion: 2 }, providers: [] });
    const restarted = new Hub(store, new Settings(store.db), fleet, traffic, unmeasured);
    const live = new Rpc(restarted, {} as never, {} as never, traffic, () => false);
    await live.handle(client, { _tag: "Request", id: 2, tag: "subscribeServerConfig", payload: {} });
    expect(sent.at(-1)?._tag).toBe("Chunk");
    expect(restarted.listenerCount("config")).toBe(1);

    // Removing the only VM drops its config, so the next push has nothing to send.
    store.deleteVm("vm1");
    expect(() => fleet.emit("offline", "vm1")).not.toThrow();
    expect(sent.at(-1)?.exit?._tag).toBe("Failure");
    expect(restarted.listenerCount("config")).toBe(0);
    expect(client.cancels.size).toBe(0);
  });

  test("two retries of one launch racing through placement launch the same thread", async () => {
    const traffic = { record: () => {} } as unknown as Traffic;
    const store = new Store(openDatabase(":memory:"));
    store.insertVm({ id: "vm1", provider: "boxd", name: "vm1", size: "medium", state: "ready", createdAt: 0 });
    store.insertProject({ id: "p1", url: "https://github.com/acme/app.git", branch: null, title: "app", createdAt: 0 });
    const placeThread = async (_projectId: string, options: { placed: (vmId: string) => void }) => {
      await Bun.sleep(1);
      store.addProjectVm("p1", "vm1");
      store.setCheckout("p1", "vm1", "/workspace/app");
      options.placed("vm1");
      return { vmId: "vm1", notice: null };
    };
    const fleet = Object.assign(new EventEmitter(), { backend: () => undefined, placeThread }) as unknown as Fleet;
    const hub = new Hub(store, new Settings(store.db), fleet, traffic, unmeasured);
    const launch = { commandId: "c1", projectId: "p1", message: "Fix the login page" };
    const [a, b] = await Promise.all([hub.prepare("orchestration.launchThread", launch, true), hub.prepare("orchestration.launchThread", launch, true)]);
    expect(a.payload.threadId).toBeString();
    expect(b.payload.threadId).toBe(a.payload.threadId);
  });

  test("a retry that placement sent to another VM follows the VM and thread that won, and gives back its own reservation", async () => {
    const traffic = { record: () => {} } as unknown as Traffic;
    const store = new Store(openDatabase(":memory:"));
    for (const id of ["vm1", "vm2"]) store.insertVm({ id, provider: "boxd", name: id, size: "medium", state: "ready", createdAt: 0 });
    store.insertProject({ id: "p1", url: "https://github.com/acme/app.git", branch: null, title: "app", createdAt: 0 });
    store.addProjectVm("p1", "vm1");
    store.setCheckout("p1", "vm1", "/workspace/app");
    store.addProjectVm("p1", "vm2");
    store.setCheckout("p1", "vm2", "/workspace/app-2");
    // The first retry lands on vm1, the second, seeing it, on vm2 with a busy notice.
    let calls = 0;
    const turnsSeen: number[] = [];
    const placeThread = async (_projectId: string, options: { load: (vm: VmRow) => VmLoad; placed: (vmId: string) => void }) => {
      const vmId = calls++ === 0 ? "vm1" : "vm2";
      await Bun.sleep(calls === 1 ? 1 : 5);
      options.placed(vmId);
      return { vmId, notice: vmId === "vm2" ? "busy" : null };
    };
    const fleet = Object.assign(new EventEmitter(), { backend: () => undefined, placeThread }) as unknown as Fleet;
    const hub = new Hub(store, new Settings(store.db), fleet, traffic, unmeasured);
    const launch = { commandId: "c1", projectId: "p1", message: "Fix the login page", cwd: "/projects/p1/app" };
    const [a, b] = await Promise.all([hub.prepare("orchestration.launchThread", launch, true), hub.prepare("orchestration.launchThread", launch, true)]);
    expect([a.vmId, b.vmId]).toEqual(["vm1", "vm1"]);
    expect(b.payload.threadId).toBe(a.payload.threadId);
    expect(b.payload.cwd).toBe("/workspace/app");
    expect(store.threadVm(a.payload.threadId as string)).toBe("vm1");
    // vm2 no longer counts the losing thread toward its load.
    Object.assign(fleet, {
      placeThread: async (_projectId: string, options: { load: (vm: VmRow) => VmLoad }) => {
        turnsSeen.push(options.load(store.vm("vm1")!).turns, options.load(store.vm("vm2")!).turns);
        return { vmId: "vm1", notice: null };
      },
    });
    await hub.prepare("orchestration.launchThread", { commandId: "c2", projectId: "p1" }, true);
    expect(turnsSeen).toEqual([1, 0]);
  });
});
