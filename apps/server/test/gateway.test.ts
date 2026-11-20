import { describe, expect, test } from "bun:test";
import { translate } from "../src/gateway/paths.ts";
import { githubName, normalizeRemote } from "../src/gateway/repos.ts";
import type { ProjectRow } from "../src/store.ts";

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
