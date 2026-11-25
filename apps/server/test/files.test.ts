import { EventEmitter } from "node:events";
import { afterEach, describe, expect, test } from "bun:test";
import { openDatabase } from "../src/bun/sqlite.ts";
import type { Fleet } from "../src/fleet.ts";
import { FileTrees, indexTree, searchEntries } from "../src/gateway/files.ts";
import { Hub } from "../src/gateway/hub.ts";
import { Rpc, type RpcClient } from "../src/gateway/rpc.ts";
import type { Wire } from "../src/gateway/types.ts";
import { Settings } from "../src/settings.ts";
import { Store } from "../src/store.ts";
import type { Traffic } from "../src/traffic.ts";
import { testEncryption } from "./key.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const files = [
  "README.md",
  "package.json",
  "src/button.tsx",
  "src/components/Button.tsx",
  "src/components/Card.tsx",
  "docs/guide.md",
  "public/logo.png",
  "lib/buttonless/index.ts",
];

/** GitHub's trees API with `trees` by ref, recording each ref asked for. */
function github(trees: Record<string, string[]>, truncated = false) {
  const asked: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const match = /\/repos\/acme\/app\/git\/trees\/([^?]+)\?recursive=1$/.exec(String(input));
    const ref = match ? decodeURIComponent(match[1]!) : "";
    asked.push(ref);
    const paths = trees[ref];
    if (!paths) return new Response("{}", { status: 404 });
    const tree = paths.map((path) => ({ path, type: "blob" }));
    return Response.json({ tree: [...tree, { path: "vendor/lib", type: "commit" }], truncated });
  }) as typeof fetch;
  return asked;
}

const branches = { branches: async () => ({ names: ["main", "feature/login"], defaultBranch: "main", at: 0 }) };

function setup() {
  const traffic = { record: () => {} } as unknown as Traffic;
  const store = new Store(openDatabase(":memory:"), testEncryption);
  store.insertVm({ id: "vm1", provider: "boxd", name: "vm1", size: "medium", state: "sleeping", createdAt: 0 });
  store.insertProject({ id: "p1", url: "https://github.com/acme/app.git", branch: null, title: "app", createdAt: 0 });
  store.addProjectVm("p1", "vm1");
  store.setCheckout("p1", "vm1", "/workspace/app");
  store.saveSnapshot("vm1", "shell", {
    threads: [
      { id: "t1", projectId: "p1", branch: "feature/login", worktreePath: "/workspace/.t3/worktrees/app/login" },
      { id: "t2", projectId: "p1", branch: "t3code/only-on-the-vm", worktreePath: "/workspace/.t3/worktrees/app/local" },
    ],
  });
  const requests: string[] = [];
  let awake = false;
  const backend = {
    request: (tag: string, _payload: unknown, handler: (frame: Wire) => void) => {
      requests.push(tag);
      queueMicrotask(() => handler({ _tag: "Exit", exit: { _tag: "Success", value: { entries: [{ path: "uncommitted.ts", kind: "file" }], truncated: false } } }));
      return () => {};
    },
  };
  const fleet = Object.assign(new EventEmitter(), { backend: () => (awake ? backend : undefined), ensure: async () => backend, lease: () => () => {} }) as unknown as Fleet;
  const hub = new Hub(store, new Settings(store.db), fleet, traffic, { get: () => null, lastDisk: () => null });
  const trees = new FileTrees(store.db, () => "token", branches);
  const rpc = new Rpc(hub, {} as never, {} as never, traffic, () => true, trees);
  const sent: Wire[] = [];
  const client: RpcClient = { clientId: "c1", cancels: new Map(), send: (frame) => sent.push(frame as Wire), open: () => true };
  let id = 0;
  const search = async (payload: Wire) => {
    await rpc.handle(client, { _tag: "Request", id: ++id, tag: "projects.searchEntries", payload: { limit: 80, ...payload } });
    return sent.at(-1)!.exit as Wire & { value?: { entries: Wire[]; truncated: boolean }; cause?: { defect: string }[] };
  };
  return { store, trees, search, requests, wake: () => (awake = true) };
}

describe("file search while a VM sleeps", () => {
  test("ranks files and folders by their own name before their path, in T3's result shape", async () => {
    github({ main: files });
    const { search } = setup();
    const found = await search({ cwd: "/projects/p1/app", query: "button" });
    expect(found.value).toEqual({
      entries: [
        // Equal scores keep the shallow-first order.
        { path: "lib/buttonless", kind: "directory" },
        { path: "src/button.tsx", kind: "file" },
        { path: "src/components/Button.tsx", kind: "file" },
        // Only its folder's name matches.
        { path: "lib/buttonless/index.ts", kind: "file" },
      ],
      truncated: false,
    });
    // A bare "@" lists the top level first, and says when there is more than the limit.
    expect((await search({ cwd: "/projects/p1/app", query: "", limit: 3 })).value).toEqual({
      entries: [
        { path: "docs", kind: "directory" },
        { path: "lib", kind: "directory" },
        { path: "package.json", kind: "file" },
      ],
      truncated: true,
    });
    expect((await search({ cwd: "/projects/p1/app", query: "@./comp", kind: "directory" })).value?.entries).toEqual([{ path: "src/components", kind: "directory" }]);
    expect((await search({ cwd: "/projects/p1/app", query: "", imageOnly: true })).value?.entries).toEqual([{ path: "public/logo.png", kind: "file" }]);
    // Words must all match, and a subfolder's paths are relative to it.
    expect((await search({ cwd: "/projects/p1/app/src", query: "comp card" })).value?.entries).toEqual([{ path: "components/Card.tsx", kind: "file" }]);
  });

  test("a word found whole in a path ranks before letters scattered through a file's name", () => {
    const entries = indexTree([`${"deep/".repeat(30)}gateway/hub.ts`, "test/agent-auth.test.ts"]);
    expect(searchEntries(entries, { query: "gate", kind: "file", limit: 10 }).entries.map((entry) => entry.path)).toEqual([
      `${"deep/".repeat(30)}gateway/hub.ts`,
      "test/agent-auth.test.ts",
    ]);
  });

  test("a thread's worktree searches its branch when GitHub has it, and the default branch when it is only on the VM", async () => {
    const asked = github({ main: files, "feature/login": ["src/login.tsx"] });
    const { search } = setup();
    expect((await search({ cwd: "/vms/vm1/workspace/.t3/worktrees/app/login", query: "log" })).value?.entries).toEqual([{ path: "src/login.tsx", kind: "file" }]);
    expect((await search({ cwd: "/vms/vm1/workspace/.t3/worktrees/app/local", query: "card" })).value?.entries).toEqual([{ path: "src/components/Card.tsx", kind: "file" }]);
    expect(asked).toEqual(["feature/login", "main"]);
  });

  test("the tree is fetched once, kept across restarts, and searched as GitHub cut it short", async () => {
    const asked = github({ main: files }, true);
    const { store, search } = setup();
    await search({ cwd: "/projects/p1/app", query: "readme" });
    const found = await search({ cwd: "/projects/p1/app", query: "readme" });
    expect(found.value).toEqual({ entries: [{ path: "README.md", kind: "file" }], truncated: true });
    expect(asked).toEqual(["main"]);

    const restarted = new FileTrees(store.db, () => "token", branches);
    const project = store.project("p1")!;
    expect(await restarted.search(project, null, "", { query: "card", limit: 10 })).toEqual({
      entries: [{ path: "src/components/Card.tsx", kind: "file" }],
      truncated: true,
    });
    expect(asked).toEqual(["main"]);
  });

  test("an old tree answers at once and is fetched again for the next search", async () => {
    github({ main: files });
    const { store, search } = setup();
    await search({ cwd: "/projects/p1/app", query: "card" });
    store.db.run("UPDATE file_trees SET fetched_at = 0");
    const asked = github({ main: [...files, "src/new.ts"] });
    const restarted = new FileTrees(store.db, () => "token", branches);
    const project = store.project("p1")!;
    expect((await restarted.search(project, null, "", { query: "new", limit: 10 }))?.entries).toEqual([]);
    await Bun.sleep(0);
    expect((await restarted.search(project, null, "", { query: "new", limit: 10 }))?.entries).toEqual([{ path: "src/new.ts", kind: "file" }]);
    expect(asked).toEqual(["main"]);
  });

  test("with no tree to search it fails as before, and an awake VM is still asked, as it has unpushed files", async () => {
    github({});
    const { search, requests, wake } = setup();
    const failed = await search({ cwd: "/projects/p1/app", query: "card" });
    expect(failed.cause?.[0]?.defect).toBe("This VM is asleep. Sending a message wakes it.");
    expect(requests).toEqual([]);

    wake();
    expect((await search({ cwd: "/projects/p1/app", query: "unc" })).value?.entries).toEqual([{ path: "uncommitted.ts", kind: "file" }]);
    expect(requests).toEqual(["projects.searchEntries"]);
  });

  test("going to sleep fetches the kept trees again", async () => {
    const asked = github({ main: files, "feature/login": ["src/login.tsx"] });
    const { store, trees } = setup();
    // Nothing kept yet: the default branch.
    await trees.refresh(store.projects());
    expect(asked).toEqual(["main"]);
    await trees.search(store.project("p1")!, "feature/login", "", { query: "x", limit: 1 });
    await trees.refresh(store.projects());
    expect(asked.toSorted()).toEqual(["feature/login", "feature/login", "main", "main"]);
  });
});
