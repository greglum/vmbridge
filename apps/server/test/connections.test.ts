import { afterEach, beforeEach, describe, expect, jest, spyOn, test } from "bun:test";
import type { TrafficEvent } from "@vmbridge/contracts";
import { Clients } from "../src/auth/clients.ts";
import { openDatabase } from "../src/bun/sqlite.ts";
import { T3Gateway, type ClientSocket } from "../src/gateway/http.ts";
import type { Hub } from "../src/gateway/hub.ts";
import type { Rpc } from "../src/gateway/rpc.ts";
import { refusedGroups, refusedWindowMs, Traffic } from "../src/traffic.ts";

let quiet: ReturnType<typeof spyOn>;
beforeEach(() => {
  jest.useFakeTimers();
  quiet = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  jest.useRealTimers();
  quiet.mockRestore();
});

function bridge() {
  const traffic = new Traffic();
  const clients = new Clients(openDatabase(":memory:"));
  const hub = { traffic, store: { vm: () => undefined }, fleet: { emit: () => {} }, attachments: { receive: async () => ({ status: 404 }) } } as unknown as Hub;
  const gateway = new T3Gateway(hub, {} as Rpc, clients);
  const pair = (name: string) => {
    const access = clients.exchange(clients.createLink(name).token)!;
    return { access, id: clients.authenticate(access)!.id };
  };
  const upgrade = () => undefined;
  const get = (path: string, headers: Record<string, string> = {}) => gateway.fetch(new Request(`http://bridge${path}`, { headers }), upgrade, upgrade);
  const logged = () => traffic.recent.map((event) => ({ operation: event.operation, reason: event.reason, clientId: event.clientId }));
  return { traffic, clients, gateway, pair, get, logged };
}

const socket = (clientId: string): ClientSocket => ({ data: { clientId, cancels: new Map() }, readyState: 1, send: () => {}, close: () => {} });

describe("device connections", () => {
  test("connecting and disconnecting are logged with the close code, and set when the device was last connected", () => {
    const { clients, gateway, pair, logged } = bridge();
    const desk = pair("Desk");
    const open = socket(desk.id);
    const start = Date.now();
    gateway.opened(open);
    expect(clients.list(gateway.connected())[0]).toMatchObject({ connected: true, lastConnectedAt: start });
    jest.setSystemTime(start + 5 * 60_000);
    gateway.closed(open, 1006, "");
    expect(clients.list(gateway.connected())[0]).toMatchObject({ connected: false, lastConnectedAt: start + 5 * 60_000 });
    gateway.opened(socket(desk.id));
    gateway.closed(socket(desk.id), 1008, "Session expired");
    expect(logged()).toEqual([
      { operation: "Device connected", reason: undefined, clientId: desk.id },
      { operation: "Device disconnected", reason: "code 1006, connection lost", clientId: desk.id },
      { operation: "Device connected", reason: undefined, clientId: desk.id },
      { operation: "Device disconnected", reason: "code 1008, Session expired", clientId: desk.id },
    ]);
    // Coming and going is not an error, so the console stays quiet.
    expect(quiet).not.toHaveBeenCalled();
    gateway.close();
  });

  test("a stopping bridge records its devices as connected until now", () => {
    const { clients, gateway, pair } = bridge();
    const desk = pair("Desk");
    const start = Date.now();
    gateway.opened(socket(desk.id));
    jest.setSystemTime(start + 30 * 60_000);
    gateway.close();
    expect(clients.list(new Set())[0]!.lastConnectedAt).toBe(start + 30 * 60_000);
  });
});

describe("refused requests", () => {
  test("auth failures are logged with their reason, and tied to their device when the bridge can tell", async () => {
    const { clients, gateway, pair, get, logged } = bridge();
    const desk = pair("Desk");
    const gone = pair("Old phone");
    clients.revoke(gone.id);
    const expired = clients.ticket(desk.id).ticket;
    jest.setSystemTime(Date.now() + 31_000);
    await get(`/ws?orchestrationProtocol=2&wsTicket=${expired}`);
    await get(`/ws?orchestrationProtocol=2&wsTicket=${expired}`);
    await get("/ws?orchestrationProtocol=1");
    await get("/api/orchestration/shell", { authorization: `Bearer ${gone.access}` });
    // T3 checks its session first; a bad token answers 200 there but is still a refusal.
    await get("/api/auth/session", { authorization: "Bearer stolen-or-mistyped" });
    await get("/api/projects");
    expect(logged()).toEqual([]);
    jest.advanceTimersByTime(refusedWindowMs);
    expect(logged()).toEqual([
      { operation: "Refused 1 request to /ws", reason: "expired ticket", clientId: desk.id },
      { operation: "Refused 1 request to /ws", reason: "unknown or used ticket", clientId: undefined },
      { operation: "Refused 1 request to /ws", reason: "T3 protocol 1, not 2", clientId: undefined },
      { operation: "Refused 1 request to /api/orchestration/shell", reason: 'token of removed device "Old phone"', clientId: gone.id },
      { operation: "Refused 1 request to /api/auth/session", reason: "unknown token", clientId: undefined },
      { operation: "Refused 1 request to /api/projects", reason: "no token", clientId: undefined },
    ]);
    gateway.close();
  });

  test("credentials in paths never reach the log, and repeated refusals share one entry", async () => {
    const { traffic, gateway, get } = bridge();
    const secret = "s3cr3t-upload-token";
    await gateway.fetch(new Request(`http://bridge/api/attachments/upload/${secret}`, { method: "POST" }), () => undefined, () => undefined);
    await get(`/api/assets/vm1.${secret}/photo.png`);
    for (let i = 0; i < 60; i++) await get("/api/projects", { authorization: `Bearer guess-${i}` });
    jest.advanceTimersByTime(refusedWindowMs);
    const events: TrafficEvent[] = traffic.recent;
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(events.map((event) => [event.operation, event.reason])).toEqual([
      ["Refused 1 request to /api/attachments/upload/:token", "unknown or expired upload link"],
      ["Refused 1 request to /api/assets/:file", "unknown or expired file link"],
      ["Refused 60 requests to /api/projects", "unknown token"],
    ]);
    gateway.close();
  });

  test("past the group limit, refusals share one entry", () => {
    const traffic = new Traffic();
    for (let i = 0; i < refusedGroups + 10; i++) traffic.refused({ path: "/api/projects", reason: `reason ${i}` });
    jest.advanceTimersByTime(refusedWindowMs);
    expect(traffic.recent).toHaveLength(refusedGroups + 1);
    expect(traffic.recent.at(-1)).toMatchObject({ operation: "Refused 10 requests to other paths", reason: "other reasons" });
  });
});
