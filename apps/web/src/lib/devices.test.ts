import { expect, test } from "bun:test";
import type { ClientInfo, TrafficEvent } from "@vmbridge/contracts";
import { failingDevices, failingMs, failingReason } from "./devices.ts";

const now = 1_800_000_000_000;
const event = (over: Partial<TrafficEvent>): TrafficEvent => ({ id: 1, at: now, kind: "http", operation: "GET /api/projects", clientId: "desk", status: "ok", ...over });
const device = (over: Partial<ClientInfo>): ClientInfo => ({ id: "desk", name: "Desk", createdAt: 0, expiresAt: now + failingMs, lastSeenAt: null, lastConnectedAt: null, connected: false, ...over });

test("a device's requests are failing while its latest one failed recently", () => {
  const failed = event({ at: now - 60_000, operation: "Refused 3 requests to /ws", status: "error", reason: "expired ticket" });
  expect(failingReason("desk", [failed], now)).toBe("expired ticket");
  // Another device's and RPC traffic do not count.
  expect(failingReason("desk", [failed, event({ clientId: "phone" }), event({ kind: "rpc" })], now)).toBe("expired ticket");
  expect(failingReason("desk", [failed, event({})], now)).toBeNull();
  expect(failingReason("desk", [failed], now + failingMs)).toBeNull();
  expect(failingReason("desk", [event({ status: "error" })], now)).toBe("GET /api/projects");
});

test("only devices whose requests are failing are listed for the banner, not ones that are just away", () => {
  const failed = event({ at: now - 60_000, status: "error", reason: "expired ticket" });
  const away = device({ id: "phone", name: "Phone", lastConnectedAt: now - 60 * 60_000 });
  expect(failingDevices([device({}), away], [failed], now)).toEqual([{ id: "desk", name: "Desk", reason: "expired ticket" }]);
});
