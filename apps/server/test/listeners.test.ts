import { afterEach, describe, expect, jest, test } from "bun:test";
import type { Server } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { Listeners } from "../src/bun/listeners.ts";
import { servedHosts } from "../src/bun/network.ts";
import { dashboardKey, start } from "../src/index.ts";

// A local network address of this machine. Tailscale's 100.64.0.0/10 range is left out: it is not the local network.
const lanIp = Object.values(networkInterfaces())
  .flat()
  .find((entry) => entry && !entry.internal && entry.family === "IPv4" && !/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(entry.address))?.address;

const password = "listener test key";
const bridges: Awaited<ReturnType<typeof start>>[] = [];
const activeListeners: Listeners<undefined>[] = [];
const dirs: string[] = [];

async function startBridge(host?: string) {
  const dir = mkdtempSync(join(tmpdir(), "vmbridge-listeners-"));
  dirs.push(dir);
  const keys = dashboardKey(dir);
  await keys.set(password);
  keys.close();
  const bridge = await start({ dir, host, port: 0 });
  bridges.push(bridge);
  const base = `http://127.0.0.1:${bridge.port}`;
  const login = await fetch(`${base}/admin/api/login`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ key: password }) });
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const setLocalNetwork = (enabled: boolean) =>
    fetch(`${base}/admin/api/network/local`, { method: "POST", headers: { "content-type": "application/json", origin: base, cookie }, body: JSON.stringify({ enabled }) });
  return { bridge, setLocalNetwork };
}

const serves = (ip: string, port: number) =>
  fetch(`http://${ip}:${port}/dashboard`, { signal: AbortSignal.timeout(2_000) }).then(
    (response) => response.status === 200,
    () => false,
  );

afterEach(async () => {
  jest.useRealTimers();
  for (const listeners of activeListeners.splice(0)) await listeners.stop();
  for (const bridge of bridges.splice(0)) await bridge.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("serves loopback and the tailnet address, and the local network only when switched on", () => {
  const interfaces = ["192.168.1.20", "100.101.102.103", "10.0.0.1"];
  const tailnet = new Set(["100.101.102.103", "fd7a:115c:a1e0::1"]);
  expect(servedHosts(interfaces, tailnet, false)).toEqual(["127.0.0.1", "100.101.102.103"]);
  expect(servedHosts(interfaces, tailnet, true)).toEqual(["127.0.0.1", "192.168.1.20", "100.101.102.103", "10.0.0.1"]);
  // Tailscale not installed or not up yet.
  expect(servedHosts(interfaces, new Set(), false)).toEqual(["127.0.0.1"]);
});

describe.skipIf(!lanIp)("on this machine's local network address", () => {
  test("by default VM Bridge does not answer there, and the switch opens and closes it without a restart", async () => {
    const { bridge, setLocalNetwork } = await startBridge();
    expect(await serves("127.0.0.1", bridge.port)).toBe(true);
    expect(await serves(lanIp!, bridge.port)).toBe(false);
    let network = await bridge.network();
    expect(network.addresses.some((address) => address.kind === "lan")).toBe(false);
    expect(network.localNetwork).toEqual({ enabled: false, fixed: false });

    expect((await setLocalNetwork(true)).status).toBe(200);
    expect(await serves(lanIp!, bridge.port)).toBe(true);
    network = await bridge.network();
    expect(network.addresses.some((address) => address.url === `http://${lanIp}:${bridge.port}`)).toBe(true);
    expect(network.localNetwork.enabled).toBe(true);

    expect((await setLocalNetwork(false)).status).toBe(200);
    expect(await serves(lanIp!, bridge.port)).toBe(false);
    expect(await serves("127.0.0.1", bridge.port)).toBe(true);
  });

  test("--host 0.0.0.0 serves every network, and the switch cannot change it", async () => {
    const { bridge, setLocalNetwork } = await startBridge("0.0.0.0");
    expect(await serves(lanIp!, bridge.port)).toBe(true);
    expect((await bridge.network()).localNetwork).toEqual({ enabled: true, fixed: true });
    expect((await setLocalNetwork(false)).status).toBe(400);
    expect(await serves(lanIp!, bridge.port)).toBe(true);
  });

  test("--host 127.0.0.1 serves only this machine", async () => {
    const { bridge } = await startBridge("127.0.0.1");
    expect(await serves(lanIp!, bridge.port)).toBe(false);
    const network = await bridge.network();
    expect(network.addresses.map((address) => address.kind)).toEqual(["local"]);
    expect(network.localNetwork).toEqual({ enabled: false, fixed: true });
  });
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const responds = (port: number) =>
  fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1_000) }).then(
    (response) => response.status === 200,
    () => false,
  );

describe("Listeners lifecycle", () => {
  test("stop() fences an in-flight apply() whose wanted resolver settles after stop() and ignores later apply() calls", async () => {
    let openCalls = 0;
    let nextWanted = async () => ["127.0.0.1"];
    const listeners = new Listeners<undefined>(
      async (hostname, port) => {
        openCalls++;
        return Bun.serve({ hostname, port, fetch: () => new Response("ok") });
      },
      () => nextWanted(),
      0,
    );
    activeListeners.push(listeners);

    await listeners.start();
    expect(openCalls).toBe(1);
    expect(listeners.hosts()).toEqual(["127.0.0.1"]);
    expect(await responds(listeners.port)).toBe(true);

    const pendingWanted = deferred<string[]>();
    nextWanted = () => pendingWanted.promise;
    const inFlightApply = listeners.apply();

    await listeners.stop();
    expect(listeners.hosts()).toEqual([]);
    expect(await responds(listeners.port)).toBe(false);

    pendingWanted.resolve(["127.0.0.1"]);
    await inFlightApply;

    nextWanted = async () => ["127.0.0.1"];
    await listeners.apply();

    expect(openCalls).toBe(1);
    expect(listeners.hosts()).toEqual([]);
    expect(await responds(listeners.port)).toBe(false);
  });

  test("stop() closes a newly bound listener whose open() resolves while stop() is in flight", async () => {
    let hosts = ["127.0.0.1"];
    let openCalls = 0;
    const secondBound = deferred();
    const releaseSecondOpen = deferred();
    const listeners = new Listeners<undefined>(
      async (hostname, port) => {
        openCalls++;
        const server = Bun.serve({ hostname, port, fetch: () => new Response("ok") });
        if (openCalls === 2) {
          secondBound.resolve();
          await releaseSecondOpen.promise;
        }
        return server;
      },
      async () => hosts,
      0,
    );
    activeListeners.push(listeners);

    await listeners.start();
    const port = listeners.port;
    expect(await responds(port)).toBe(true);

    // Drop loopback first so the second open() binds the same loopback port.
    hosts = [];
    await listeners.apply();
    expect(await responds(port)).toBe(false);

    hosts = ["127.0.0.1"];
    const inFlightApply = listeners.apply();
    await secondBound.promise;

    let stopSettled = false;
    const stopPromise = listeners.stop().then(() => {
      stopSettled = true;
    });
    await Promise.resolve();
    expect(stopSettled).toBe(false);

    releaseSecondOpen.resolve();
    await Promise.all([stopPromise, inFlightApply]);

    expect(stopSettled).toBe(true);
    expect(openCalls).toBe(2);
    expect(listeners.hosts()).toEqual([]);
    expect(await responds(port)).toBe(false);
  });

  test("stop() immediately force-stops a draining loopback listener without waiting for the 1s drain timeout", async () => {
    let hosts = ["127.0.0.1"];
    const requestArrived = deferred();
    const releaseRequest = deferred<Response>();
    const listeners = new Listeners<undefined>(
      async (hostname, port) =>
        Bun.serve({
          hostname,
          port,
          fetch: () => {
            requestArrived.resolve();
            return releaseRequest.promise;
          },
        }),
      async () => hosts,
      0,
    );
    activeListeners.push(listeners);

    await listeners.start();
    const port = listeners.port;

    let requestSettled = false;
    const activeRequest = fetch(`http://127.0.0.1:${port}/slow`).then(
      () => {
        requestSettled = true;
        return "resolved";
      },
      () => {
        requestSettled = true;
        return "aborted";
      },
    );
    await requestArrived.promise;

    // Removing the host starts graceful drain (1s timeout before force-stop), so the active request stays open.
    hosts = [];
    await listeners.apply();
    expect(listeners.hosts()).toEqual([]);
    expect(await responds(port)).toBe(false);
    expect(requestSettled).toBe(false);

    const startedStop = performance.now();
    await listeners.stop();
    const outcome = await activeRequest;
    const elapsedMs = performance.now() - startedStop;

    expect(outcome).toBe("aborted");
    expect(elapsedMs).toBeLessThan(500);
    expect(await responds(port)).toBe(false);
  });

  test("stop() clears active drain timers so no late stop(true) fires after shutdown", async () => {
    jest.useFakeTimers();
    let hosts = ["127.0.0.1"];
    let gracefulStops = 0;
    let forceStops = 0;
    const drainDone = deferred();
    const fakeServer = {
      port: 43210,
      stop(closeActiveConnections?: boolean) {
        if (closeActiveConnections) {
          forceStops++;
          drainDone.resolve();
          return Promise.resolve();
        }
        gracefulStops++;
        return drainDone.promise;
      },
    } as unknown as Server<undefined>;

    const listeners = new Listeners<undefined>(
      async () => fakeServer,
      async () => hosts,
      0,
    );
    activeListeners.push(listeners);

    await listeners.start();
    hosts = [];
    await listeners.apply();
    expect(gracefulStops).toBe(1);
    expect(forceStops).toBe(0);

    await listeners.stop();
    expect(forceStops).toBe(1);

    jest.advanceTimersByTime(5_000);
    await Promise.resolve();
    expect(forceStops).toBe(1);
  });

  test("concurrent apply() calls serialize so a host removed while opening is not leaked", async () => {
    let hosts = ["127.0.0.1"];
    let openCalls = 0;
    const secondBound = deferred();
    const releaseSecondOpen = deferred();
    const listeners = new Listeners<undefined>(
      async (hostname, port) => {
        openCalls++;
        const server = Bun.serve({ hostname, port, fetch: () => new Response("ok") });
        if (openCalls === 2) {
          secondBound.resolve();
          await releaseSecondOpen.promise;
        }
        return server;
      },
      async () => hosts,
      0,
    );
    activeListeners.push(listeners);

    await listeners.start();
    const port = listeners.port;

    hosts = [];
    await listeners.apply();

    hosts = ["127.0.0.1"];
    const firstApply = listeners.apply();
    await secondBound.promise;

    hosts = [];
    const secondApply = listeners.apply();
    releaseSecondOpen.resolve();

    await Promise.all([firstApply, secondApply]);
    expect(openCalls).toBe(2);
    expect(listeners.hosts()).toEqual([]);
    expect(await responds(port)).toBe(false);
  });
});
