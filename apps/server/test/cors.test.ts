import { expect, test } from "bun:test";
import { Clients } from "../src/auth/clients.ts";
import { openDatabase } from "../src/bun/sqlite.ts";
import { T3Gateway } from "../src/gateway/http.ts";
import type { Hub } from "../src/gateway/hub.ts";
import type { Rpc } from "../src/gateway/rpc.ts";
import { Traffic } from "../src/traffic.ts";

const upgrade = () => null;

async function answer(headers: Record<string, string>, method = "GET") {
  const hub = { traffic: new Traffic(), descriptor: () => ({ environmentId: "env" }) } as unknown as Hub;
  const gateway = new T3Gateway(hub, {} as Rpc, new Clients(openDatabase(":memory:")));
  try {
    return (await gateway.fetch(new Request("https://bridge.example/.well-known/t3/environment", { method, headers }), upgrade, upgrade))!;
  } finally {
    gateway.close();
  }
}

test("a request with an Origin is allowed from that origin", async () => {
  const response = await answer({ origin: "https://app.t3.codes" });
  expect(response.headers.get("access-control-allow-origin")).toBe("https://app.t3.codes");
  expect(response.headers.get("vary")).toBe("Origin");
});

// T3's desktop app strips Origin from its requests, and its renderer still rejects an answer without this header.
test("a request without an Origin, as T3's desktop app sends, is allowed from any origin", async () => {
  for (const method of ["GET", "OPTIONS"]) {
    const response = await answer({}, method);
    expect(response.ok).toBe(true);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("vary")).toBe("Origin");
  }
});
