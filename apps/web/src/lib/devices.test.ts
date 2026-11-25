import { expect, test } from "bun:test";
import type { ClientInfo, TrafficEvent } from "@vmbridge/contracts";
import { failingMs, failingReason, missingDevices, missingMs, usualMs } from "./devices.ts";

const now = 1_800_000_000_000;
const event = (over: Partial<TrafficEvent>): TrafficEvent => ({ id: 1, at: now, kind: "http", operation: "GET /api/projects", clientId: "desk", status: "ok", ...over });
const device = (over: Partial<ClientInfo>): ClientInfo => ({ id: "desk", name: "Desk", createdAt: 0, expiresAt: now + usualMs, lastSeenAt: null, lastConnectedAt: null, connected: false, ...over });

test("a device's requests are failing while its latest one failed recently", () => {
  const failed = event({ at: now - 60_000, operation: "Refused 3 requests to /ws", status: "error", reason: "expired ticket" });
  expect(failingReason("desk", [failed], now)).toBe("expired ticket");
  // Another device's and RPC traffic do not count.
  expect(failingReason("desk", [failed, event({ clientId: "phone" }), event({ kind: "rpc" })], now)).toBe("expired ticket");
  expect(failingReason("desk", [failed, event({})], now)).toBeNull();
  expect(failingReason("desk", [failed], now + failingMs)).toBeNull();
  expect(failingReason("desk", [event({ status: "error" })], now)).toBe("GET /api/projects");
});

test("a usually connected device gets a banner once away for a few minutes while VM Bridge is up", () => {
  const started = now - 60 * 60_000;
  const away = (ms: number) => device({ lastConnectedAt: now - ms });
  expect(missingDevices([away(missingMs - 1)], started, now)).toEqual([]);
  expect(missingDevices([away(missingMs)], started, now)).toHaveLength(1);
  // Connected now, never connected, or away for over a day: no banner.
  expect(missingDevices([device({ connected: true, lastConnectedAt: now - missingMs })], started, now)).toEqual([]);
  expect(missingDevices([device({})], started, now)).toEqual([]);
  expect(missingDevices([away(usualMs + 1)], started, now)).toEqual([]);
  // Time VM Bridge was down does not count: the device gets a few minutes from the start.
  expect(missingDevices([away(2 * 60 * 60_000)], now - missingMs + 1, now)).toEqual([]);
  expect(missingDevices([away(2 * 60 * 60_000)], now - missingMs, now)).toHaveLength(1);
});
