import { afterEach, beforeEach, describe, expect, jest, spyOn, test } from "bun:test";
import { Clients } from "../src/auth/clients.ts";
import { openDatabase } from "../src/bun/sqlite.ts";
import { T3Gateway } from "../src/gateway/http.ts";
import type { Hub } from "../src/gateway/hub.ts";
import { previewStreamPath } from "../src/gateway/preview.ts";
import type { Rpc } from "../src/gateway/rpc.ts";
import { refusedWindowMs, Traffic } from "../src/traffic.ts";

let quiet: ReturnType<typeof spyOn>;
beforeEach(() => {
  jest.useFakeTimers();
  quiet = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  jest.useRealTimers();
  quiet.mockRestore();
});

function setup() {
  const traffic = new Traffic();
  const clients = new Clients(openDatabase(":memory:"));
  const hub = {
    traffic,
    store: { threadVm: () => undefined },
    fleet: { backend: () => undefined, emit: () => {} },
  } as unknown as Hub;
  const gateway = new T3Gateway(hub, {} as Rpc, clients);
  const access = clients.exchange(clients.createLink("Laptop").token)!;
  const clientId = clients.authenticate(access)!.id;
  return { traffic, clients, gateway, clientId };
}

/** A Workers-style 101 Switching Protocols response carrying its client WebSocket. */
function workersUpgradeResponse() {
  const webSocket = { accept() {}, close() {} };
  const response = new Response(null, { status: 101 });
  Object.defineProperty(response, "webSocket", { value: webSocket, enumerable: true });
  return { response, webSocket };
}

describe("Workers 101 WebSocket upgrades", () => {
  test("returns a /ws 101 upgrade response untouched and records no refusal", async () => {
    const { traffic, clients, gateway, clientId } = setup();
    const refused = spyOn(traffic, "refused");
    try {
      const { ticket } = clients.ticket(clientId, "rpc");
      const { response: upgraded, webSocket } = workersUpgradeResponse();
      const request = new Request(`https://bridge.example/ws?orchestrationProtocol=2&wsTicket=${ticket}`, {
        headers: { origin: "https://app.t3.codes", upgrade: "websocket" },
      });
      const result = await gateway.fetch(request, () => upgraded, () => null);
      expect(result).toBe(upgraded);
      expect(result?.status).toBe(101);
      expect((result as Response & { webSocket?: unknown }).webSocket).toBe(webSocket);
      expect(result?.headers.get("access-control-allow-origin")).toBeNull();
      expect(result?.headers.get("vary")).toBeNull();
      expect(result?.headers.get("cache-control")).toBeNull();
      expect(refused).not.toHaveBeenCalled();
      jest.advanceTimersByTime(refusedWindowMs);
      expect(traffic.recent).toEqual([]);
    } finally {
      gateway.close();
    }
  });

  test("returns a preview stream 101 upgrade response untouched and records no refusal", async () => {
    const { traffic, clients, gateway, clientId } = setup();
    const refused = spyOn(traffic, "refused");
    try {
      const { ticket } = clients.ticket(clientId, "media");
      const { response: upgraded, webSocket } = workersUpgradeResponse();
      const request = new Request(`https://bridge.example${previewStreamPath}?wsTicket=${ticket}&threadId=t1&tabId=tab1`, {
        headers: { origin: "https://app.t3.codes", upgrade: "websocket" },
      });
      const result = await gateway.fetch(request, () => null, () => upgraded);
      expect(result).toBe(upgraded);
      expect(result?.status).toBe(101);
      expect((result as Response & { webSocket?: unknown }).webSocket).toBe(webSocket);
      expect(result?.headers.get("access-control-allow-origin")).toBeNull();
      expect(result?.headers.get("vary")).toBeNull();
      expect(result?.headers.get("cache-control")).toBeNull();
      expect(refused).not.toHaveBeenCalled();
      jest.advanceTimersByTime(refusedWindowMs);
      expect(traffic.recent).toEqual([]);
    } finally {
      gateway.close();
    }
  });

  test("still records refusals for rejected /ws and preview stream requests", async () => {
    const { traffic, clients, gateway, clientId } = setup();
    try {
      const rpcTicket = clients.ticket(clientId, "rpc").ticket;
      const mediaTicket = clients.ticket(clientId, "media").ticket;

      const badWs = await gateway.fetch(new Request("https://bridge.example/ws?orchestrationProtocol=2&wsTicket=bad"), () => null, () => null);
      const nonUpgradeWs = await gateway.fetch(new Request(`https://bridge.example/ws?orchestrationProtocol=2&wsTicket=${rpcTicket}`), () => null, () => null);
      const badPreview = await gateway.fetch(new Request(`https://bridge.example${previewStreamPath}?wsTicket=bad`), () => null, () => null);
      const nonUpgradePreview = await gateway.fetch(new Request(`https://bridge.example${previewStreamPath}?wsTicket=${mediaTicket}`), () => null, () => null);

      expect(badWs?.status).toBe(401);
      expect(nonUpgradeWs?.status).toBe(400);
      expect(badPreview?.status).toBe(401);
      expect(nonUpgradePreview?.status).toBe(400);

      jest.advanceTimersByTime(refusedWindowMs);
      expect(traffic.recent.map((event) => ({ operation: event.operation, reason: event.reason, clientId: event.clientId }))).toEqual([
        { operation: "Refused 1 request to /ws", reason: "unknown or used ticket", clientId: undefined },
        { operation: "Refused 1 request to /ws", reason: "not a WebSocket upgrade", clientId },
        { operation: `Refused 1 request to ${previewStreamPath}`, reason: "unknown or used ticket", clientId: undefined },
        { operation: `Refused 1 request to ${previewStreamPath}`, reason: "not a WebSocket upgrade", clientId },
      ]);
    } finally {
      gateway.close();
    }
  });
});
