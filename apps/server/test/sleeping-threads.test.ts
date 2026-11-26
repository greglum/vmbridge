import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";
import { Clients } from "../src/auth/clients.ts";
import { openDatabase } from "../src/bun/sqlite.ts";
import type { Fleet } from "../src/fleet.ts";
import { T3Gateway } from "../src/gateway/http.ts";
import { Hub } from "../src/gateway/hub.ts";
import { Rpc, type RpcClient } from "../src/gateway/rpc.ts";
import type { Wire } from "../src/gateway/types.ts";
import { Settings } from "../src/settings.ts";
import { Store } from "../src/store.ts";
import type { Traffic } from "../src/traffic.ts";
import { testEncryption } from "./key.ts";

const unmeasured = { get: () => null, lastDisk: () => null };

/** 1,200 rows of about 2 KB each, so the saved copy passes Durable Object SQL's 2 MB value limit. Rows 200 to 259 are one run's commands. */
function longThread() {
  const items = Array.from({ length: 1_200 }, (_, index) => {
    const work = index >= 200 && index < 260;
    return {
      id: `i${index}`,
      type: work ? "command_execution" : "assistant_message",
      status: "completed",
      runId: work ? "r1" : null,
      attemptId: null,
      ordinal: index + 1,
      text: `${index} `.padEnd(2_000, "x"),
    };
  });
  return {
    thread: { id: "t1", title: "Long thread" },
    updatedAt: "2026-11-25T00:00:00.000Z",
    turnItems: items,
    visibleTurnItems: items.map((item, position) => ({ position, visibility: "local", sourceThreadId: "t1", sourceItemId: item.id, item })),
  };
}

/** vm1 sleeps with a saved copy of long thread t1. Nothing may wake it. */
function setup() {
  const store = new Store(openDatabase(":memory:"), testEncryption);
  store.insertVm({ id: "vm1", provider: "boxd", name: "vm1", size: "medium", state: "sleeping", createdAt: 0 });
  store.setThreadVm("t1", "vm1");
  store.setThreadVm("t2", "vm1");
  store.saveProjection("t1", "vm1", "2026-11-25T00:00:00.000Z", null, longThread());
  const woken: string[] = [];
  const fleet = Object.assign(new EventEmitter(), {
    backend: () => undefined,
    connected: () => [],
    lease: () => () => {},
    ensure: (id: string) => {
      woken.push(id);
      return new Promise(() => {});
    },
  }) as unknown as Fleet;
  const traffic = { record: () => {}, refused: () => {} } as unknown as Traffic;
  const hub = new Hub(store, new Settings(store.db), fleet, traffic, unmeasured);
  const rpc = new Rpc(hub, {} as never, {} as never, traffic, () => false);
  const clients = new Clients(store.db);
  const gateway = new T3Gateway(hub, rpc, clients);
  const bearer = clients.exchange(clients.createLink("Laptop").token)!;
  const get = async (path: string) => {
    const response = (await gateway.fetch(new Request(`http://bridge${path}`, { headers: { authorization: `Bearer ${bearer}` } }), () => null, () => null))!;
    return { status: response.status, body: (await response.json()) as Wire };
  };
  const close = () => {
    gateway.close();
    hub.close();
  };
  return { store, hub, rpc, get, woken, close };
}

/** A cursor as T3 encodes one (`encodeThreadHistoryCursor`). */
const cursor = (itemId: string, position: number, inclusive?: true) =>
  Buffer.from(JSON.stringify({ v: 1, seq: 5, st: "t1", si: itemId, p: position, ...(inclusive && { inclusive }) })).toString("base64url");

const ids = (rows: unknown) => (rows as { sourceItemId: string }[]).map((row) => row.sourceItemId);

describe("a sleeping VM's threads", () => {
  test("are saved in parts under Durable Object SQL's value limit, a character split across two parts included", () => {
    const { store, close } = setup();
    expect(store.db.one<{ parts: number }>("SELECT COUNT(*) AS parts FROM projection_parts WHERE thread_id = 't1'")!.parts).toBeGreaterThan(1);
    const longest = store.db.one<{ size: number }>("SELECT MAX(LENGTH(CAST(data AS BLOB))) AS size FROM projection_parts")!.size;
    expect(longest).toBeLessThan(2_000_000);
    expect(store.projection("t1", "vm1")).toEqual(longThread());

    // The emoji's two halves fall either side of where the first part would end.
    const prefix = JSON.stringify({ thread: { id: "t2" }, text: "" }).length - 2;
    const split = { thread: { id: "t2" }, text: `${"a".repeat(600_000 - prefix - 1)}😀 after` };
    store.saveProjection("t2", "vm1", null, null, split);
    expect(store.projection("t2", "vm1")).toEqual(split);
    // A smaller copy leaves no parts of the bigger one behind.
    store.saveProjection("t2", "vm1", null, null, { thread: { id: "t2" } });
    expect(store.projection("t2", "vm1")).toEqual({ thread: { id: "t2" } });
    close();
  });

  test("open as a bounded snapshot holding the whole saved history, with T3's watermark, without waking the VM", async () => {
    const { get, woken, close } = setup();
    const { status, body } = await get("/api/orchestration/threads/t1/bounded?compactTurnItems=1&dedupeBodies=1&compactIds=1&deferWork=1");
    expect(status).toBe(200);
    expect(ids((body.projection as Wire).visibleTurnItems)).toHaveLength(1_200);
    expect(body).toMatchObject({ historyCursor: null, hasMoreHistory: false, latestLocalTurnOrdinal: 1_200 });
    expect(woken).toEqual([]);
    close();
  });

  test("scroll back from a cursor the VM gave while awake, page by page, to the first row", async () => {
    const { get, close } = setup();
    const seen: string[] = [];
    let next: string | null = cursor("i1100", 1_100);
    while (next) {
      const { status, body } = await get(`/api/orchestration/threads/t1/history?cursor=${next}&compactIds=1&deferWork=1`);
      expect(status).toBe(200);
      const items = body.items as { position: number }[];
      expect(items.map((row) => row.position)).toEqual(items.map((_, index) => index));
      seen.unshift(...ids(items));
      next = body.nextCursor as string | null;
      expect(body.hasMoreHistory).toBe(next !== null);
    }
    expect(seen).toEqual(Array.from({ length: 1_100 }, (_, index) => `i${index}`));

    // A jump to an older message reaches it in one page.
    const { body } = await get(`/api/orchestration/threads/t1/history?cursor=${cursor("i1100", 1_100)}&throughEntryId=i10`);
    expect(ids(body.items)[0]).toBe("i10");
    close();
  });

  test("open a folded work group, and refuse a cursor that is not T3's", async () => {
    const { get, close } = setup();
    const work = await get(`/api/orchestration/threads/t1/history?cursor=${cursor("i259", 260, true)}&throughEntryId=i200&view=work&compactIds=1`);
    expect(ids(work.body.items)).toEqual(Array.from({ length: 60 }, (_, index) => `i${200 + index}`));
    expect(work.body).toMatchObject({ nextCursor: null, hasMoreHistory: false });
    expect((await get("/api/orchestration/threads/t1/history?cursor=nonsense")).status).toBe(400);
    close();
  });

  test("copy as the whole transcript, without the waking notice the thread shows", async () => {
    const { get, hub, close } = setup();
    hub.fleet.emit("waking", "vm1", true);
    const transcript = await get("/api/orchestration/threads/t1/transcript");
    expect(transcript.body).toMatchObject({ threadId: "t1", title: "Long thread", updatedAt: "2026-11-25T00:00:00.000Z" });
    expect(ids(transcript.body.items)).toHaveLength(1_200);
    const shown = await get("/api/orchestration/threads/t1/bounded");
    expect(((shown.body.projection as Wire).visibleTurnItems as Wire[]).at(-1)).toMatchObject({ visibility: "synthetic" });
    close();
  });

  test("stream the saved history with the completion marker, and still say so for a thread with no saved copy", async () => {
    const { rpc, woken, close } = setup();
    const sent: Wire[] = [];
    const client: RpcClient = { clientId: "c1", cancels: new Map(), send: (frame) => sent.push(frame as Wire), open: () => true };
    await rpc.handle(client, { _tag: "Request", id: 1, tag: "orchestration.subscribeThread", payload: { threadId: "t1", requestCompletionMarker: true } });
    const values = sent.flatMap((frame) => (frame.values ?? []) as Wire[]);
    expect(values.map((value) => value.kind)).toEqual(["snapshot", "synchronized"]);
    expect(ids((values[0]!.projection as Wire).visibleTurnItems)).toHaveLength(1_200);

    await rpc.handle(client, { _tag: "Request", id: 2, tag: "orchestration.subscribeThread", payload: { threadId: "t2" } });
    expect(JSON.stringify(sent.find((frame) => frame.requestId === 2)?.exit)).toContain("no saved transcript");
    expect(woken).toEqual([]);
    close();
  });

  test("size older history pages by UTF-8 bytes rather than UTF-16 code units", async () => {
    const { store, get, close } = setup();
    // Each row is ~200K UTF-16 code units but ~600 KB in UTF-8, so 5 rows exceed 1 MiB in UTF-8
    // even though their combined string `.length` stays under 1,048,576.
    const items = Array.from({ length: 6 }, (_, index) => ({
      id: `m${index}`,
      type: "assistant_message",
      status: "completed",
      runId: null,
      attemptId: null,
      ordinal: index + 1,
      text: "あ".repeat(200_000),
    }));
    store.saveProjection("t2", "vm1", "2026-11-25T00:00:00.000Z", null, {
      thread: { id: "t2", title: "CJK thread" },
      updatedAt: "2026-11-25T00:00:00.000Z",
      turnItems: items,
      visibleTurnItems: items.map((item, position) => ({ position, visibility: "local", sourceThreadId: "t2", sourceItemId: item.id, item })),
    });
    const makeCursor = (itemId: string, position: number) =>
      Buffer.from(JSON.stringify({ v: 1, seq: 1, st: "t2", si: itemId, p: position })).toString("base64url");

    const seen: string[] = [];
    let pages = 0;
    let next: string | null = makeCursor("m5", 5);
    while (next) {
      const { status, body } = await get(`/api/orchestration/threads/t2/history?cursor=${next}`);
      expect(status).toBe(200);
      const pageItems = body.items as Wire[];
      expect(pageItems.length).toBe(1);
      expect(new TextEncoder().encode(JSON.stringify(pageItems)).byteLength).toBeLessThanOrEqual(1_048_576);
      seen.unshift(...ids(pageItems));
      next = body.nextCursor as string | null;
      pages++;
    }
    expect(pages).toBe(5);
    expect(seen).toEqual(["m0", "m1", "m2", "m3", "m4"]);
    close();
  });
});
