import { expect, test } from "bun:test";
import { Backend } from "../src/vm/backend.ts";

test("the preview URL's own query parameters win over the client's", async () => {
  const seen: URL[] = [];
  // Stands in for the VM's T3 server behind its preview URL.
  using vm = Bun.serve({
    port: 0,
    fetch: (request) => {
      seen.push(new URL(request.url));
      return Response.json({});
    },
  });
  const backend = new Backend("vm1", { url: `${vm.url.origin}/?preview_token=PROVIDER` }, "t3-token", async () => {
    throw new Error("no sockets in this test");
  });

  await backend.http("/api/orchestration/threads/t1?preview_token=CLIENT&preview_token=AGAIN&view=full");
  expect(seen[0]!.searchParams.getAll("preview_token")).toEqual(["PROVIDER"]);
  expect(seen[0]!.searchParams.get("view")).toBe("full");
});

test("media sockets preserve provider credentials and minted wsTicket over client query parameters", async () => {
  const opened: URL[] = [];
  using vm = Bun.serve({
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/api/auth/websocket-ticket/media") {
        return Response.json({ ticket: "MINTED" });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const backend = new Backend(
    "vm1",
    { url: `${vm.url.origin}/?preview_token=PROVIDER&wsTicket=PROVIDER_TICKET` },
    "t3-token",
    async (url) => {
      opened.push(new URL(url));
      return {} as WebSocket;
    },
  );

  const query = new URLSearchParams({ preview_token: "CLIENT", tabId: "t1", wsTicket: "CLIENT_TICKET" });
  await backend.media("/api/preview-stream/ws", query);

  expect(opened).toHaveLength(1);
  expect(opened[0]!.protocol).toBe("ws:");
  expect(opened[0]!.pathname).toBe("/api/preview-stream/ws");
  expect(opened[0]!.searchParams.getAll("preview_token")).toEqual(["PROVIDER"]);
  expect(opened[0]!.searchParams.get("tabId")).toBe("t1");
  expect(opened[0]!.searchParams.getAll("wsTicket")).toEqual(["MINTED"]);
  expect(query.get("preview_token")).toBe("CLIENT");
});

test("off-origin paths are rejected before any HTTP request or media socket is opened", async () => {
  let vmHits = 0;
  let attackerHits = 0;
  let socketOpens = 0;
  using vm = Bun.serve({
    port: 0,
    fetch: () => {
      vmHits++;
      return Response.json({ ticket: "MINTED" });
    },
  });
  using attacker = Bun.serve({
    port: 0,
    fetch: () => {
      attackerHits++;
      return Response.json({});
    },
  });
  const backend = new Backend(
    "vm1",
    { url: `${vm.url.origin}/?preview_token=PROVIDER`, headers: { "x-preview": "secret" } },
    "t3-token",
    async () => {
      socketOpens++;
      return {} as WebSocket;
    },
  );

  const badPaths = [
    "//127.0.0.1:1/steal",
    "/\\127.0.0.1:1/steal",
    "https://evil.example/steal",
    `//${attacker.url.host}/steal`,
    `/\\${attacker.url.host}/steal`,
    `${attacker.url.origin}/steal`,
    `/\t/${attacker.url.host}/steal`,
    "/api/ok\t/x",
  ];

  for (const badPath of badPaths) {
    await expect(backend.http(badPath)).rejects.toThrow("path must stay on the VM origin");
    await expect(backend.media(badPath, new URLSearchParams({ tabId: "t1" }))).rejects.toThrow("path must stay on the VM origin");
  }

  expect(vmHits).toBe(0);
  expect(attackerHits).toBe(0);
  expect(socketOpens).toBe(0);
});

test("malformed preview URLs fail without leaking credentials", async () => {
  let socketOpens = 0;
  const backend = new Backend("vm1", { url: "not a url?secret=TOP_SECRET" }, "t3-token", async () => {
    socketOpens++;
    return {} as WebSocket;
  });

  for (const op of [
    () => backend.http("/api/health"),
    () => backend.media("/api/preview-stream/ws", new URLSearchParams({ tabId: "t1" })),
  ]) {
    let caught: unknown;
    try {
      await op();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const err = caught as Error & { input?: unknown; cause?: unknown };
    expect(err.message).toBe("Invalid preview URL for VM vm1.");
    expect(err.message).not.toContain("TOP_SECRET");
    expect(err.message).not.toContain("not a url");
    expect(err.input).toBeUndefined();
    expect(err.cause).toBeUndefined();
  }

  expect(socketOpens).toBe(0);
});
