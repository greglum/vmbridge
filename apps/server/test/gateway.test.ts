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
import { Store, type ProjectRow } from "../src/store.ts";

const project: ProjectRow = {
  id: "p1",
  url: "https://github.com/acme/app.git",
  branch: null,
  title: "app",
  vmId: "vm1",
  checkoutPath: "/workspace/app",
  createdAt: 0,
};

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
    const hub = new Hub(store, new Settings(store.db), fleet, traffic);
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
    const restarted = new Hub(store, new Settings(store.db), fleet, traffic);
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
    const place = async () => {
      await Bun.sleep(1);
      store.updateProject("p1", { vmId: "vm1", checkoutPath: "/workspace/app" });
      return "vm1";
    };
    const fleet = Object.assign(new EventEmitter(), { backend: () => undefined, place }) as unknown as Fleet;
    const hub = new Hub(store, new Settings(store.db), fleet, traffic);
    const launch = { commandId: "c1", projectId: "p1", message: "Fix the login page" };
    const [a, b] = await Promise.all([hub.prepare("orchestration.launchThread", launch, true), hub.prepare("orchestration.launchThread", launch, true)]);
    expect(a.payload.threadId).toBeString();
    expect(b.payload.threadId).toBe(a.payload.threadId);
  });
});
