import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { SandboxError } from "@opencoredev/sandbox-sdk";
import type { Address, ProviderId, VmState } from "@vmbridge/contracts";
import { openSocket } from "../src/bun/socket.ts";
import { openDatabase } from "../src/bun/sqlite.ts";
import type { Fleet } from "../src/fleet.ts";
import { hasScreen, type Box, type Driver, type ScreenStream } from "../src/providers/index.ts";
import { Skills } from "../src/skills.ts";
import { Store } from "../src/store.ts";
import { Traffic } from "../src/traffic.ts";
import { WatchLinks } from "../src/watch/links.ts";
import { ViewOnlyFilter } from "../src/watch/rfb.ts";
import { screenSkill, watchUrlPath } from "../src/watch/skill.ts";
import { asleepCode, Watch, type Viewer, type ViewerSocket } from "../src/watch/watch.ts";
import { testEncryption } from "./key.ts";

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
/** The 404 VM Bridge gives any path it does not serve. */
const unknownPath = () => new Response("Not found", { status: 404 });

/** Just what `Watch` uses of a fleet: its events, and the boxes of the VMs that are connected. */
class FakeFleet extends EventEmitter<{ awake: [vmId: string]; offline: [vmId: string]; changed: [] }> {
  readonly boxes = new Map<string, Box>();
  screenCalls = 0;
  screen: (sandboxId: string) => Promise<ScreenStream | null> = async () => null;
  box = (vmId: string) => this.boxes.get(vmId);
  connected = () => [...this.boxes.keys()];
  driver = () => ({ screen: (sandboxId: string) => (this.screenCalls++, this.screen(sandboxId)) }) as unknown as Driver;
}

/** A VM's files, as `Watch` writes and removes them. */
function fakeBox(fail = false) {
  const files = new Map<string, { data: string; mode: number | undefined }>();
  const box = {
    files: {
      write: async (entries: Record<string, string>, options?: { mode?: number }) => {
        if (fail) throw new Error(`could not write ${Object.values(entries).join()}`);
        for (const [path, data] of Object.entries(entries)) files.set(path, { data, mode: options?.mode });
      },
      remove: async (path: string) => {
        if (!files.delete(path)) throw new SandboxError("missing", { code: "file_not_found" });
      },
    },
  } as unknown as Box;
  return { files, box };
}

function setup(options: { addresses?: Address[] } = {}) {
  const db = openDatabase(":memory:");
  const store = new Store(db, testEncryption);
  const links = new WatchLinks(db, testEncryption);
  const fleet = new FakeFleet();
  const traffic = new Traffic();
  let addresses = options.addresses ?? [{ kind: "local", label: "This Mac", url: "http://127.0.0.1:3790" }];
  const watch = new Watch({
    links,
    store,
    fleet: fleet as unknown as Fleet,
    traffic,
    openSocket,
    addresses: async () => addresses,
    page: async () => new Response("<!doctype html><title>Live screen</title>"),
  });
  const addVm = (id: string, provider: ProviderId = "kubi", state: VmState = "ready") => {
    store.insertVm({ id, provider, name: id, size: "medium", state, createdAt: 0 });
    store.updateVm(id, { sandboxId: `scr_${id}` });
    fleet.emit("changed");
  };
  const setAddresses = (next: Address[]) => (addresses = next);
  return { db, store, links, fleet, traffic, watch, addVm, setAddresses };
}

const tokenOf = (url: string | null) => url!.split("/watch/")[1]!;
const get = (watch: Watch, path: string, method = "GET") =>
  watch.fetch(new Request(`http://127.0.0.1:3790${path}`, { method }), () => null) as Promise<Response>;

describe("watch links", () => {
  test("a link is 32 random bytes, found by its SHA-256 hash and stored sealed, never in plain", () => {
    const { db, links, store } = setup();
    store.insertVm({ id: "vm1", provider: "kubi", name: "vm1", size: "medium", state: "ready", createdAt: 0 });
    const token = links.create("vm1");
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(links.vmFor(token)).toBe("vm1");
    expect(links.token("vm1")).toBe(token);
    const row = db.one<{ token_hash: string; token: string }>("SELECT token_hash, token FROM watch_links WHERE vm_id = 'vm1'")!;
    expect(row.token_hash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(row.token).not.toContain(token);
    expect(links.create("vm1")).not.toBe(token);
  });

  test("a new link replaces the old one, and a link turned off stays off", () => {
    const { links, addVm, fleet } = setup();
    addVm("vm1");
    const first = links.token("vm1")!;
    const second = links.create("vm1");
    expect(links.vmFor(first)).toBeNull();
    expect(links.vmFor(second)).toBe("vm1");
    links.off("vm1");
    expect(links.vmFor(second)).toBeNull();
    expect(links.token("vm1")).toBeNull();
    // VM Bridge only makes links for VMs that never had one.
    fleet.emit("changed");
    expect(links.token("vm1")).toBeNull();
  });

  test("every VM with a screen gets one, and only those", () => {
    const { links, watch, addVm, store } = setup();
    addVm("kubi1");
    addVm("boxd1", "boxd");
    expect(links.token("kubi1")).not.toBeNull();
    expect(links.has("boxd1")).toBe(false);
    expect(watch.info(store.vm("boxd1")!)).toBeNull();
    expect(hasScreen("kubi")).toBe(true);
    expect(hasScreen("boxd")).toBe(false);
  });
});

describe("the watch page", () => {
  test("a working token gets the page, with headers that keep the token from leaking", async () => {
    const { watch, addVm } = setup();
    addVm("vm1");
    await watch.refresh();
    const url = watch.url("vm1")!;
    expect(url).toStartWith("http://127.0.0.1:3790/watch/");
    const response = await get(watch, `/watch/${tokenOf(url)}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-robots-tag")).toContain("noindex");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("content-security-policy")).toContain("connect-src 'self'");
    const body = await response.text();
    for (const secret of [tokenOf(url), "vm1", "scr_vm1", "kubi"]) expect(body).not.toContain(secret);
  });

  test("a wrong, replaced or turned off token gets the same 404 as any unknown path", async () => {
    const { watch, addVm } = setup();
    addVm("vm1");
    await watch.refresh();
    const replaced = tokenOf(watch.url("vm1"));
    watch.renew("vm1");
    const turnedOff = tokenOf(watch.url("vm1"));
    watch.off("vm1");
    const expected = unknownPath();
    const expectedBody = await expected.text();
    for (const path of [`/watch/${replaced}`, `/watch/${turnedOff}`, `/watch/${"a".repeat(43)}`, "/watch/short", "/watch", `/watch/${turnedOff}/stream`, `/watch/${replaced}/other`]) {
      const response = await get(watch, path);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe(expectedBody);
      expect([...response.headers]).toEqual([...expected.headers]);
    }
  });

  test("only GET and HEAD open the page, and its stream needs a WebSocket upgrade", async () => {
    const { watch, addVm } = setup();
    addVm("vm1");
    await watch.refresh();
    const token = tokenOf(watch.url("vm1"));
    expect((await get(watch, `/watch/${token}`, "POST")).status).toBe(404);
    const head = await get(watch, `/watch/${token}`, "HEAD");
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect((await get(watch, `/watch/${token}/stream`)).status).toBe(404);
  });

  test("the dashboard's link has the address most devices can reach", async () => {
    const { watch, addVm } = setup({
      addresses: [
        { kind: "local", label: "This Mac", url: "http://127.0.0.1:3790" },
        { kind: "cloudflare", label: "Cloudflare Tunnel", url: "https://bridge.example.com/" },
      ],
    });
    addVm("vm1");
    await watch.refresh();
    expect(watch.url("vm1")).toStartWith("https://bridge.example.com/watch/");
  });
});

/** Opens a stream as a watch page would, and records what VM Bridge sends it and how it ends. */
async function openStream(watch: Watch, token: string) {
  let viewer: Viewer | undefined;
  await watch.fetch(new Request(`http://127.0.0.1:3790/watch/${token}/stream`), (_request, opened) => {
    viewer = opened;
    return undefined;
  });
  const page = { sent: [] as Uint8Array[], closed: null as { code?: number; reason?: string } | null };
  const socket: ViewerSocket = {
    send: (data) => void page.sent.push(data),
    close: (code, reason) => void (page.closed = { code, reason }),
  };
  viewer!.opened(socket);
  return { viewer: viewer!, page };
}

/** A screen's stream, as Kubi's is: it checks the ticket subprotocol and records what reaches it. */
function fakeScreen() {
  const received: Uint8Array[] = [];
  const protocols: string[] = [];
  const sockets: Bun.ServerWebSocket<unknown>[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      protocols.push(request.headers.get("sec-websocket-protocol") ?? "");
      return server.upgrade(request, { data: undefined, headers: { "sec-websocket-protocol": "kubi.v1" } }) ? undefined : new Response(null, { status: 400 });
    },
    websocket: {
      open: (socket) => void sockets.push(socket),
      message: (_socket, data) => void received.push(new Uint8Array(data as Buffer)),
    },
  });
  servers.push(server);
  const stream: ScreenStream = { url: new URL(`ws://127.0.0.1:${server.port}/viewer`), protocols: ["kubi.v1", "vt_ticket"] };
  return { stream, received, protocols, sockets };
}

/** The client's side of an RFB 3.8 handshake with no VNC security. */
const handshake = new Uint8Array([...new TextEncoder().encode("RFB 003.008\n"), 1, 1]);
const frameRequest = new Uint8Array([3, 1, 0, 0, 0, 0, 4, 0, 3, 0]);
const keyEvent = new Uint8Array([4, 1, 0, 0, 0, 0, 0, 0x61]);

describe("the screen's stream", () => {
  test("an asleep VM is not woken: the page hears it is asleep, and the screen is never asked", async () => {
    const { watch, addVm, fleet } = setup();
    addVm("vm1", "kubi", "sleeping");
    await watch.refresh();
    const { page } = await openStream(watch, tokenOf(watch.url("vm1")));
    await settle();
    expect(page.closed?.code).toBe(asleepCode);
    expect(fleet.screenCalls).toBe(0);
  });

  test("a screen that is not running counts as asleep", async () => {
    const { watch, addVm, fleet } = setup();
    addVm("vm1");
    await watch.refresh();
    const { page } = await openStream(watch, tokenOf(watch.url("vm1")));
    await settle();
    expect(fleet.screenCalls).toBe(1);
    expect(page.closed?.code).toBe(asleepCode);
  });

  test("frames reach the page, and only requests for frames reach the screen", async () => {
    const { watch, addVm, fleet } = setup();
    const screen = fakeScreen();
    fleet.screen = async () => screen.stream;
    addVm("vm1");
    await watch.refresh();
    const { viewer, page } = await openStream(watch, tokenOf(watch.url("vm1")));
    viewer.received(handshake);
    await settle();
    expect(screen.protocols).toEqual(["kubi.v1, vt_ticket"]);
    screen.sockets[0]!.send(new Uint8Array([0, 0, 1, 2]));
    viewer.received(frameRequest);
    await settle();
    expect(page.sent.map((data) => [...data])).toEqual([[0, 0, 1, 2]]);
    expect(screen.received.flatMap((data) => [...data])).toEqual([...handshake, ...frameRequest]);

    viewer.received(keyEvent);
    await settle();
    expect(page.closed).toEqual({ code: 1008, reason: "View only" });
    expect(screen.received.flatMap((data) => [...data])).toEqual([...handshake, ...frameRequest]);
  });

  test("a new link ends the streams open on the old one", async () => {
    const { watch, addVm, fleet } = setup();
    const screen = fakeScreen();
    fleet.screen = async () => screen.stream;
    addVm("vm1");
    await watch.refresh();
    const { page } = await openStream(watch, tokenOf(watch.url("vm1")));
    await settle();
    expect(page.closed).toBeNull();
    watch.renew("vm1");
    expect(page.closed?.code).not.toBe(asleepCode);
    expect(page.closed).not.toBeNull();
  });
});

describe("the view-only filter", () => {
  test("passes the handshake and requests for frames, even split across chunks", () => {
    const filter = new ViewOnlyFilter();
    const all = new Uint8Array([...handshake, ...frameRequest, 2, 0, 0, 2, 0, 0, 0, 7, 0, 0, 0, 16]);
    const passed: number[] = [];
    for (let at = 0; at < all.length; at += 5) passed.push(...filter.push(all.subarray(at, at + 5))!);
    expect(passed).toEqual([...all]);
  });

  test("drops the clipboard noVNC offers on connect, and passes what follows it", () => {
    const filter = new ViewOnlyFilter();
    filter.push(handshake);
    // ClientCutText with the extended clipboard's capabilities, as noVNC 1.7 sends it.
    const clipboard = new Uint8Array([6, 0, 0, 0, 255, 255, 255, 248, 31, 0, 0, 1, 0, 0, 0, 0]);
    expect([...filter.push(new Uint8Array([...clipboard, ...frameRequest]))!]).toEqual([...frameRequest]);
    const text = new Uint8Array([6, 0, 0, 0, 0, 0, 0, 3, 104, 105, 33]);
    expect([...filter.push(text)!]).toEqual([]);
    expect(new ViewOnlyFilter().push(new Uint8Array([...handshake, 6, 0, 0, 0, 0x7f, 0xff, 0xff, 0xff]))).toBeNull();
  });

  test("ends the stream on input, or on a handshake that asks for VNC security", () => {
    const input = new ViewOnlyFilter();
    expect(input.push(handshake)).not.toBeNull();
    expect(input.push(keyEvent)).toBeNull();
    const pointer = new ViewOnlyFilter();
    pointer.push(handshake);
    expect(pointer.push(new Uint8Array([5, 1, 0, 10, 0, 10]))).toBeNull();
    const security = new Uint8Array(handshake);
    security[12] = 2;
    expect(new ViewOnlyFilter().push(security)).toBeNull();
  });
});

describe("the VM's copy of its link", () => {
  test("is written as a private file when the VM connects, and kept up to date", async () => {
    const { watch, addVm, fleet, setAddresses } = setup();
    const { files, box } = fakeBox();
    addVm("vm1");
    fleet.boxes.set("vm1", box);
    await watch.refresh();
    expect(files.get(watchUrlPath)).toEqual({ data: `${watch.url("vm1")}\n`, mode: 0o600 });

    watch.renew("vm1");
    await settle();
    expect(files.get(watchUrlPath)?.data).toBe(`${watch.url("vm1")}\n`);

    setAddresses([{ kind: "tailscale-https", label: "Tailscale", url: "https://mac.tail.ts.net" }]);
    await watch.refresh();
    expect(files.get(watchUrlPath)?.data).toStartWith("https://mac.tail.ts.net/watch/");

    watch.off("vm1");
    await settle();
    expect(files.has(watchUrlPath)).toBe(false);
  });

  test("is written again on every wake, since the VM may come back from an older disk", async () => {
    const { watch, addVm, fleet } = setup();
    const { files, box } = fakeBox();
    addVm("vm1");
    await watch.refresh();
    fleet.boxes.set("vm1", box);
    fleet.emit("awake", "vm1");
    await settle();
    expect(files.get(watchUrlPath)?.data).toBe(`${watch.url("vm1")}\n`);
    files.clear();
    fleet.emit("offline", "vm1");
    fleet.emit("awake", "vm1");
    await settle();
    expect(files.get(watchUrlPath)?.data).toBe(`${watch.url("vm1")}\n`);
  });

  test("is not given to VMs without a screen", async () => {
    const { watch, addVm, fleet } = setup();
    const { files, box } = fakeBox();
    addVm("vm1", "boxd");
    fleet.boxes.set("vm1", box);
    await watch.refresh();
    expect(files.size).toBe(0);
  });

  test("a failed write is recorded without the link", async () => {
    const { watch, addVm, fleet, traffic } = setup();
    addVm("vm1");
    fleet.boxes.set("vm1", fakeBox(true).box);
    await watch.refresh();
    const token = tokenOf(watch.url("vm1"));
    expect(traffic.recent.some((event) => event.operation === "give the VM its watch link" && event.status === "error")).toBe(true);
    expect(JSON.stringify(traffic.recent)).not.toContain(token);
  });
});

describe("the screen skill", () => {
  test("VMs with a screen get it, others do not, and the skills list never shows it", () => {
    const skills = new Skills(openDatabase(":memory:"), testEncryption);
    expect(skills.state(true).skills).toEqual([{ name: screenSkill.name, hash: screenSkill.hash }]);
    expect(skills.state(false).skills).toEqual([]);
    expect(skills.state(true).fingerprint).not.toBe(skills.state(false).fingerprint);
    expect(skills.list()).toEqual([]);
    const skillMd = Buffer.from(skills.files(screenSkill.name)[0]!.data, "base64").toString();
    expect(skillMd).toContain(watchUrlPath);
    expect(skillMd).toContain("show me my screen");
    expect(skillMd).toContain("turned off in VM Bridge");
  });
});
