import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { Clients } from "../src/auth/clients.ts";
import { openSocket } from "../src/bun/socket.ts";
import { openDatabase } from "../src/bun/sqlite.ts";
import type { Fleet } from "../src/fleet.ts";
import { T3Gateway, type SocketData } from "../src/gateway/http.ts";
import { bridgeScopes, Hub } from "../src/gateway/hub.ts";
import { Rpc, type RpcClient } from "../src/gateway/rpc.ts";
import type { Wire } from "../src/gateway/types.ts";
import { Settings } from "../src/settings.ts";
import { Store } from "../src/store.ts";
import type { Traffic } from "../src/traffic.ts";
import { Backend } from "../src/vm/backend.ts";
import type { Viewer } from "../src/watch/watch.ts";
import { testEncryption } from "./key.ts";

const traffic = { record: () => {}, refused: () => {} } as unknown as Traffic;
const unmeasured = { get: () => null, lastDisk: () => null };

/** Two VMs, each with a project and one thread, and whichever backends the test gives the fleet. */
function setup(backends: Record<string, Backend | undefined>) {
  const store = new Store(openDatabase(":memory:"), testEncryption);
  for (const id of ["vm1", "vm2"]) store.insertVm({ id, provider: "kubi", name: id, size: "medium", state: "ready", createdAt: 0 });
  store.setThreadVm("t1", "vm1");
  store.setThreadVm("t2", "vm2");
  const fleet = Object.assign(new EventEmitter(), {
    backend: (id: string) => backends[id],
    connected: () => Object.keys(backends).filter((id) => backends[id]),
    ensure: async (id: string) => backends[id],
    lease: () => () => {},
  }) as unknown as Fleet;
  const hub = new Hub(store, new Settings(store.db), fleet, traffic, unmeasured);
  return { store, fleet, hub, rpc: new Rpc(hub, {} as never, {} as never, traffic, () => false) };
}

function client() {
  const sent: Wire[] = [];
  const rpcClient: RpcClient = { clientId: "c1", cancels: new Map(), send: (frame) => sent.push(frame as Wire), open: () => true };
  return { sent, rpcClient };
}

/** A VM's T3 server as the RPC socket sees it: records requests, and lets the test push stream chunks. */
function fakeVm() {
  const requests: { tag: string; payload: unknown }[] = [];
  const streams = new Map<string, (values: unknown[]) => void>();
  let interrupted = 0;
  const backend = {
    request: (tag: string, payload: unknown, handler: (frame: Wire) => void) => {
      requests.push({ tag, payload });
      if (tag === "subscribePreviewEvents") streams.set(tag, (values) => handler({ _tag: "Chunk", values }));
      else queueMicrotask(() => handler({ _tag: "Exit", exit: { _tag: "Success", value: { from: tag } } }));
      return () => interrupted++;
    },
  } as unknown as Backend;
  return { backend, requests, push: (values: unknown[]) => streams.get("subscribePreviewEvents")?.(values), interrupted: () => interrupted };
}

const event = (threadId: string, type = "opened") => ({ type, threadId, tabId: "tab1", serverEpoch: "e1", revision: 1, createdAt: "now" });

describe("preview RPC", () => {
  test("events come from every awake VM, each only for its own threads, and from a VM that wakes later", async () => {
    const vm1 = fakeVm();
    const vm2 = fakeVm();
    const backends: Record<string, Backend | undefined> = { vm1: vm1.backend };
    const { hub, rpc, fleet } = setup(backends);
    const { sent, rpcClient } = client();
    await rpc.handle(rpcClient, { _tag: "Request", id: 1, tag: "subscribePreviewEvents", payload: {} });

    vm1.push([event("t1"), event("t2")]);
    backends.vm2 = vm2.backend;
    fleet.emit("awake", "vm2");
    vm2.push([event("t2", "navigated"), event("t1", "closed")]);
    const delivered = sent.flatMap((frame) => (frame.values as Wire[]).map((value) => [value.threadId, value.type]));
    // vm1 cannot tell the client about vm2's thread, nor vm2 about vm1's.
    expect(delivered).toEqual([
      ["t1", "opened"],
      ["t2", "navigated"],
    ]);

    await rpc.handle(rpcClient, { _tag: "Interrupt", requestId: 1 });
    expect(vm1.interrupted() + vm2.interrupted()).toBe(2);
    hub.close();
  });

  test("a thread's tabs are listed and closed on its own VM, and a VM that is not awake has none", async () => {
    const vm1 = fakeVm();
    const { hub, rpc } = setup({ vm1: vm1.backend });
    const { sent, rpcClient } = client();
    await rpc.handle(rpcClient, { _tag: "Request", id: 1, tag: "preview.list", payload: { threadId: "t1" } });
    await rpc.handle(rpcClient, { _tag: "Request", id: 2, tag: "preview.close", payload: { threadId: "t1", tabId: "tab1" } });
    await Bun.sleep(0);
    expect(vm1.requests.map((request) => request.tag)).toEqual(["preview.list", "preview.close"]);

    await rpc.handle(rpcClient, { _tag: "Request", id: 3, tag: "preview.list", payload: { threadId: "t2" } });
    expect(sent.at(-1)).toMatchObject({ requestId: 3, exit: { _tag: "Success", value: { sessions: [], revision: 0 } } });
    hub.close();
  });

  test("other preview methods stay refused", async () => {
    const vm1 = fakeVm();
    const { hub, rpc } = setup({ vm1: vm1.backend });
    const { sent, rpcClient } = client();
    const refused = ["preview.open", "preview.resize", "preview.adjust", "preview.reportStatus", "preview.clearProfile", "preview.stopLocalServer", "preview.listX"];
    for (const [index, tag] of refused.entries()) {
      await rpc.handle(rpcClient, { _tag: "Request", id: index, tag, payload: { threadId: "t1", tabId: "tab1", pid: 1, port: 3000 } });
    }
    expect(vm1.requests).toEqual([]);
    expect(sent.map((frame) => (frame.exit as { cause: { defect: string }[] }).cause[0]!.defect)).toEqual(
      refused.map((tag) => `VM Bridge does not support '${tag}'.`),
    );
    hub.close();
  });

  test("clients are told to show agents' tabs when the VMs have a server browser, and their profiles stay with them", async () => {
    const vm1 = fakeVm();
    const { store, fleet, hub } = setup({ vm1: vm1.backend });
    expect(bridgeScopes).toContain("preview:operate");
    expect(hub.descriptor().capabilities).toMatchObject({ serverBrowser: false });
    hub.close();

    store.saveSnapshot("vm1", "config", { environment: { capabilities: { serverBrowser: true } }, providers: [] });
    const withBrowser = new Hub(store, new Settings(store.db), fleet, traffic, unmeasured);
    expect(withBrowser.descriptor().capabilities).toMatchObject({ serverBrowser: true });

    const { sent, rpcClient } = client();
    const rpc = new Rpc(withBrowser, {} as never, {} as never, traffic, () => false);
    await rpc.handle(rpcClient, { _tag: "Request", id: 1, tag: "preview.reportProfiles", payload: { profiles: [], defaultProfileId: "default" } });
    expect(vm1.requests).toEqual([]);
    expect(sent).toMatchObject([{ requestId: 1, exit: { _tag: "Success" } }]);
    withBrowser.close();
  });
});

/** A VM's T3 server: hands out media tickets to VM Bridge's token and serves preview streams that echo. */
function fakeT3Server() {
  const opened: URL[] = [];
  const server = Bun.serve<{ url: URL }>({
    port: 0,
    fetch(request, bun) {
      const url = new URL(request.url);
      if (url.pathname === "/api/auth/websocket-ticket/media" && request.method === "POST") {
        if (request.headers.get("authorization") !== "Bearer vm-token") return new Response(null, { status: 401 });
        return Response.json({ ticket: "vm-media-ticket" });
      }
      if (url.pathname === "/api/preview-stream/ws" && url.searchParams.get("wsTicket") === "vm-media-ticket") {
        return bun.upgrade(request, { data: { url } }) ? undefined : new Response(null, { status: 400 });
      }
      return new Response(null, { status: 404 });
    },
    websocket: {
      open(socket: ServerWebSocket<{ url: URL }>) {
        opened.push(socket.data.url);
        if (socket.data.url.searchParams.get("tabId") === "gone") return socket.close(4404, "tab closed");
        socket.send(new Uint8Array([0xff, 0xd8, 1, 2]));
        socket.send(JSON.stringify({ type: "control", canOperate: true }));
      },
      message(socket, message) {
        socket.send(typeof message === "string" ? `echo ${message}` : message);
      },
    },
  });
  return { server, opened };
}

/** VM Bridge's T3 surface on a real listener, as index.ts serves it, with one paired device. */
function bridge(backends: Record<string, Backend | undefined>) {
  const { hub, rpc, store } = setup(backends);
  const clients = new Clients(store.db);
  const gateway = new T3Gateway(hub, rpc, clients);
  const server = Bun.serve<SocketData | { viewer: Viewer }>({
    port: 0,
    fetch(request, bun) {
      const relay = (upgrade: Request, viewer: Viewer) => (bun.upgrade(upgrade, { data: { viewer } }) ? undefined : null);
      return gateway.fetch(request, (upgrade, data) => (bun.upgrade(upgrade, { data }) ? undefined : null), relay);
    },
    websocket: {
      open: (socket) => ("viewer" in socket.data ? socket.data.viewer.opened(socket) : undefined),
      message: (socket, raw) => ("viewer" in socket.data ? socket.data.viewer.received(raw) : undefined),
      close: (socket) => ("viewer" in socket.data ? socket.data.viewer.closed() : undefined),
    },
  });
  const bearer = clients.exchange(clients.createLink("Laptop").token)!;
  const ticket = async (use: string) => {
    const response = await fetch(`${server.url.origin}/api/auth/websocket-ticket/${use}`, { method: "POST", headers: { authorization: `Bearer ${bearer}` } });
    return ((await response.json()) as { ticket: string }).ticket;
  };
  const deviceId = clients.authenticate(bearer)!.id;
  return { server, gateway, hub, ticket, deviceId, stop: () => (gateway.close(), hub.close(), server.stop(true)) };
}

/** Opens a preview stream as T3 clients do, and records what arrives and how it ends. */
function watchTab(origin: string, query: string) {
  const socket = new WebSocket(`${origin.replace(/^http/, "ws")}/api/preview-stream/ws?${query}`);
  socket.binaryType = "arraybuffer";
  const received: (string | number[])[] = [];
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    socket.addEventListener("close", (event) => resolve({ code: event.code, reason: event.reason })),
  );
  socket.addEventListener("message", (event) => received.push(typeof event.data === "string" ? event.data : [...new Uint8Array(event.data)]));
  const opened = new Promise<void>((resolve) => socket.addEventListener("open", () => resolve()));
  return { socket, received, closed, opened };
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(5);
  expect(check()).toBe(true);
};

describe("preview stream relay", () => {
  test("reaches the thread's VM with its own ticket and only T3's parameters, and passes frames both ways", async () => {
    const vm = fakeT3Server();
    using _vm = vm.server;
    const { server, ticket, stop } = bridge({ vm1: new Backend("vm1", { url: vm.server.url.origin }, "vm-token", openSocket) });
    try {
      const tab = watchTab(server.url.origin, `threadId=t1&tabId=tab1&maxWidth=800&maxHeight=600&interactive=false&extra=1&wsTicket=${await ticket("media")}`);
      await tab.opened;
      tab.socket.send(JSON.stringify({ type: "ack" }));
      tab.socket.send(new Uint8Array([7, 8]));
      await until(() => tab.received.length === 4);
      expect(tab.received).toEqual([[0xff, 0xd8, 1, 2], JSON.stringify({ type: "control", canOperate: true }), 'echo {"type":"ack"}', [7, 8]]);
      expect(Object.fromEntries(vm.opened[0]!.searchParams)).toEqual({
        threadId: "t1",
        tabId: "tab1",
        maxWidth: "800",
        maxHeight: "600",
        interactive: "false",
        wsTicket: "vm-media-ticket",
      });
      tab.socket.close();
    } finally {
      stop();
    }
  });

  test("keeps T3's close codes, and a tab on a VM that is not awake is gone", async () => {
    const vm = fakeT3Server();
    using _vm = vm.server;
    const { server, ticket, stop } = bridge({ vm1: new Backend("vm1", { url: vm.server.url.origin }, "vm-token", openSocket) });
    try {
      const gone = watchTab(server.url.origin, `threadId=t1&tabId=gone&wsTicket=${await ticket("media")}`);
      expect(await gone.closed).toEqual({ code: 4404, reason: "tab closed" });
      // t2 is vm2's, which is asleep: nothing reaches vm1.
      const asleep = watchTab(server.url.origin, `threadId=t2&tabId=tab1&wsTicket=${await ticket("media")}`);
      expect((await asleep.closed).code).toBe(4404);
      expect(vm.opened.map((url) => url.searchParams.get("threadId"))).toEqual(["t1"]);
    } finally {
      stop();
    }
  });

  test("needs a media ticket, which opens nothing else, and ends when the device is removed", async () => {
    const vm = fakeT3Server();
    using _vm = vm.server;
    const { server, ticket, gateway, deviceId, stop } = bridge({ vm1: new Backend("vm1", { url: vm.server.url.origin }, "vm-token", openSocket) });
    try {
      const rpcTicket = watchTab(server.url.origin, `threadId=t1&tabId=tab1&wsTicket=${await ticket("rpc")}`);
      // A refused upgrade, which T3 clients read as needing a new ticket.
      expect((await rpcTicket.closed).code).toBe(1006);
      const media = await ticket("media");
      const rpcSocket = await fetch(`${server.url.origin}/ws?orchestrationProtocol=2&wsTicket=${media}`);
      expect(rpcSocket.status).toBe(401);
      expect(vm.opened).toEqual([]);

      const tab = watchTab(server.url.origin, `threadId=t1&tabId=tab1&wsTicket=${await ticket("media")}`);
      await until(() => tab.received.length === 2);
      gateway.disconnect(deviceId);
      expect(await tab.closed).toEqual({ code: 1008, reason: "Device removed" });
    } finally {
      stop();
    }
  });
});
