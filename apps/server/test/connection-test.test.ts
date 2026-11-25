import { afterAll, expect, test } from "bun:test";
import { Clients } from "../src/auth/clients.ts";
import { openDatabase } from "../src/bun/sqlite.ts";
import { testAddress } from "../src/connection-test.ts";
import { T3Gateway } from "../src/gateway/http.ts";
import type { Hub } from "../src/gateway/hub.ts";
import type { Rpc } from "../src/gateway/rpc.ts";
import { Traffic } from "../src/traffic.ts";

const base = "https://bridge.example";
const upgrade = () => null;
const hub = { traffic: new Traffic(), descriptor: () => ({ environmentId: "env", orchestrationProtocolVersion: 2 }) } as unknown as Hub;
const gateway = new T3Gateway(hub, {} as Rpc, new Clients(openDatabase(":memory:")));
afterAll(() => gateway.close());

const bridge = async (url: string, init: RequestInit) => (await gateway.fetch(new Request(url, init), upgrade, upgrade))!;
const problems = async (fetcher: typeof bridge, environmentId = "env") =>
  Object.fromEntries((await testAddress(base, environmentId, fetcher)).steps.map(({ step, problems }) => [step, problems]));

test("the bridge's gateway passes every step", async () => {
  expect(await problems(bridge)).toEqual({ preflight: [], environment: [], socket: [] });
});

// The bug T3 desktop hit before VM Bridge answered Origin-less requests with `*`.
test("a gateway that sends no Access-Control-Allow-Origin without an Origin fails for T3 Code desktop", async () => {
  const withoutWildcard = async (url: string, init: RequestInit) => {
    const response = await bridge(url, init);
    if (!new Headers(init.headers).has("origin")) response.headers.delete("access-control-allow-origin");
    return response;
  };
  const failed = await problems(withoutWildcard);
  const desktop = "No Access-Control-Allow-Origin when the request has no Origin: T3 Code desktop will fail.";
  expect(failed.preflight).toEqual([desktop]);
  expect(failed.environment).toEqual([desktop]);
  expect(failed.socket).toEqual([]);
});

test("a preflight that leaves out T3's trace headers fails", async () => {
  const narrow = async (url: string, init: RequestInit) => {
    const response = await bridge(url, init);
    if (init.method === "OPTIONS") response.headers.set("access-control-allow-headers", "authorization");
    return response;
  };
  expect((await problems(narrow)).preflight).toContain("Access-Control-Allow-Headers leaves out b3, traceparent for Origin https://app.t3.codes: T3 Code on the web will fail.");
});

test("a down tunnel is reported as Cloudflare's error", async () => {
  const down = async () => new Response("error code: 1033", { status: 530, headers: { "cf-ray": "1-LHR", server: "cloudflare" } });
  const failed = await problems(down);
  for (const step of ["preflight", "environment", "socket"]) expect(failed[step]).toEqual(["Cloudflare answered with error 1033: the tunnel is down."]);
});

test("an address that leads to another T3 server or nowhere says so", async () => {
  expect((await problems(bridge, "other")).environment).toEqual(["Another T3 server answered, so this address leads somewhere else."]);
  const refused = async () => {
    throw new TypeError("Unable to connect");
  };
  expect((await problems(refused)).socket).toEqual(["Could not reach it: Unable to connect"]);
});
