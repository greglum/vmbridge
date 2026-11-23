import { afterEach, describe, expect, test } from "bun:test";
import { lsRemote, parseRefs, pktLines, RemoteBranches } from "../src/gateway/repos.ts";

const pkt = (line: string) => `${(Buffer.byteLength(line) + 4).toString(16).padStart(4, "0")}${line}`;
const oid = "a".repeat(40);
const bytes = (text: string) => new TextEncoder().encode(text);

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Seen {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

/** Answers like a git host speaking protocol version 2, or 0 with `v0`. Records every request. */
function gitHost(options: { v0?: boolean; status?: number } = {}) {
  const seen: Seen[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, method: init?.method ?? "GET", headers: new Headers(init?.headers), body: String(init?.body ?? "") });
    if (options.status) return new Response("", { status: options.status });
    if (url.endsWith("/info/refs?service=git-upload-pack")) {
      const service = `${pkt("# service=git-upload-pack\n")}0000`;
      if (options.v0) {
        return new Response(
          `${service}${pkt(`${oid} HEAD\0multi_ack symref=HEAD:refs/heads/trunk agent=git/2\n`)}${pkt(`${oid} refs/heads/trunk\n`)}` +
            `${pkt(`${oid} refs/heads/feature/é\n`)}${pkt(`${oid} refs/tags/v1\n`)}${pkt(`${oid} refs/pull/1/head\n`)}0000`,
        );
      }
      return new Response(`${service}${pkt("version 2\n")}${pkt("ls-refs=unborn\n")}0000`);
    }
    if (url.endsWith("/git-upload-pack")) {
      return new Response(`${pkt(`${oid} HEAD symref-target:refs/heads/main\n`)}${pkt(`${oid} refs/heads/main\n`)}${pkt(`${oid} refs/heads/dev\n`)}0000`);
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
  return seen;
}

describe("reading branches over git's HTTP protocol", () => {
  test("pkt-lines, with flush and delimiter packets as null", () => {
    expect(pktLines(bytes(`${pkt("one\n")}0000${pkt("two")}0001`))).toEqual(["one", null, "two", null]);
    expect(() => pktLines(bytes("zzzz"))).toThrow();
  });

  test("version 0 refs: the default branch from the symref capability, branches only", () => {
    const lines = [`${oid} HEAD\0multi_ack symref=HEAD:refs/heads/trunk`, `${oid} refs/heads/trunk`, `${oid} refs/tags/v1`, `${oid} refs/heads/a`];
    expect(parseRefs(lines)).toEqual({ names: ["a", "trunk"], defaultBranch: "trunk" });
  });

  test("version 2 asks for HEAD and branches only", async () => {
    const seen = gitHost();
    const branches = await lsRemote("https://codeberg.org/acme/app.git");
    expect(branches).toMatchObject({ names: ["dev", "main"], defaultBranch: "main" });
    expect(seen.map((request) => [request.method, request.url])).toEqual([
      ["GET", "https://codeberg.org/acme/app.git/info/refs?service=git-upload-pack"],
      ["POST", "https://codeberg.org/acme/app.git/git-upload-pack"],
    ]);
    expect(seen[0]!.headers.get("git-protocol")).toBe("version=2");
    expect(seen[1]!.body).toBe(`${pkt("command=ls-refs\n")}0001${pkt("symrefs\n")}${pkt("ref-prefix HEAD\n")}${pkt("ref-prefix refs/heads/\n")}0000`);
  });

  test("servers without version 2 send every ref, and multi-byte branch names survive", async () => {
    gitHost({ v0: true });
    expect(await lsRemote("https://git.example.com/app.git")).toMatchObject({ names: ["feature/é", "trunk"], defaultBranch: "trunk" });
  });

  test("the GitHub token goes to github.com only, as git's Basic auth", async () => {
    const seen = gitHost();
    await lsRemote("https://github.com/acme/private.git", "gh-token");
    await lsRemote("https://gitlab.com/acme/app.git", "gh-token");
    const auth = seen.map((request) => request.headers.get("authorization"));
    expect(auth).toEqual([`Basic ${btoa("x-access-token:gh-token")}`, `Basic ${btoa("x-access-token:gh-token")}`, null, null]);
  });

  test("only HTTPS, without credentials in the URL", async () => {
    const seen = gitHost();
    for (const url of ["http://example.com/app.git", "file:///etc", "ext::sh -c touch% /tmp/x", "https://user:pass@example.com/app.git"]) {
      await expect(lsRemote(url)).rejects.toThrow("Only HTTPS");
    }
    expect(seen).toEqual([]);
  });

  test("GitHub falls back to its REST API when git's protocol fails", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      seen.push(url);
      if (url.startsWith("https://github.com/")) return new Response("", { status: 401 });
      if (url.endsWith("/branches?per_page=100")) return Response.json([{ name: "main" }, { name: "dev" }]);
      return Response.json({ default_branch: "main" });
    }) as typeof fetch;
    const branches = await new RemoteBranches(() => undefined).branches("https://github.com/acme/app");
    expect(branches).toMatchObject({ names: ["dev", "main"], defaultBranch: "main" });
    expect(seen[0]).toBe("https://github.com/acme/app.git/info/refs?service=git-upload-pack");
    expect(seen.slice(1).every((url) => url.startsWith("https://api.github.com/repos/acme/app"))).toBe(true);
  });
});
