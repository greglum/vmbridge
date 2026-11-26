import { afterEach, describe, expect, test } from "bun:test";
import type { SandboxInfo } from "@opencoredev/sandbox-sdk/provider";
import type { AgentAuth } from "../src/agent-auth/profiles.ts";
import { bunMachine } from "../src/bun/machine.ts";
import { openSocket } from "../src/bun/socket.ts";
import { openDatabase } from "../src/bun/sqlite.ts";
import { Fleet } from "../src/fleet.ts";
import { Hub } from "../src/gateway/hub.ts";
import type { Shell, Wire } from "../src/gateway/types.ts";
import type { Box, Driver } from "../src/providers/index.ts";
import { Secrets, Settings } from "../src/settings.ts";
import { Skills } from "../src/skills.ts";
import { Store } from "../src/store.ts";
import type { Traffic } from "../src/traffic.ts";
import { testEncryption } from "./key.ts";
import { programFiles } from "./vm-program.ts";

const unmeasured = { get: () => null, lastDisk: () => null };
const ok = (stdout = "") => ({ ok: true, exitCode: 0, stdout, stderr: "", output: stdout });
const failed = { ok: false, exitCode: 1, stdout: "", stderr: "", output: "" };

const servers: ReturnType<typeof Bun.serve>[] = [];
const fleets: Fleet[] = [];
afterEach(() => {
  for (const fleet of fleets.splice(0)) fleet.close();
  for (const server of servers.splice(0)) server.stop(true);
});

function fakeT3() {
  const shell: Shell = { threads: [{ id: "t1", status: "idle" }], archivedThreads: [], projects: [] };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      const path = new URL(request.url).pathname;
      if (path === "/api/auth/websocket-ticket/rpc") return Response.json({ ticket: "ticket" });
      if (path === "/api/orchestration/shell") return Response.json(shell);
      if (path === "/ws" && server.upgrade(request, { data: undefined })) return undefined;
      return new Response(null, { status: 404 });
    },
    websocket: {
      message(socket, raw) {
        const frame = JSON.parse(String(raw)) as Wire;
        if (frame._tag !== "Request") return;
        if (String(frame.tag).toLowerCase().includes("subscribe")) return;
        socket.send(JSON.stringify({ _tag: "Exit", requestId: frame.id, exit: { _tag: "Success", value: null } }));
      },
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}` };
}

function setup() {
  const t3 = fakeT3();
  const db = openDatabase(":memory:");
  const settings = new Settings(db);
  settings.set("providers", ["boxd"]);
  settings.set("defaultProvider", "boxd");
  settings.set("t3Version", "1.0.0");
  const store = new Store(db, testEncryption);
  const secrets = new Secrets(db, testEncryption);
  const recorded: Parameters<Traffic["record"]>[0][] = [];
  const traffic = { record: (event: Parameters<Traffic["record"]>[0]) => void recorded.push(event) } as unknown as Traffic;
  const agents = { vmSecrets: async () => ({}), adoptCodex: () => {}, codexDue: () => false } as unknown as AgentAuth;
  const skills = new Skills(db, testEncryption, bunMachine(undefined, () => []));

  const files: Record<string, string> = {};
  let running = false;
  const startedPath = "/workspace/.vmbridge/t3/credentials";
  const box = {
    id: "sb1",
    run: async (command: string, options: { stdin?: string } = {}) => {
      if (command === "bash -s") {
        Object.assign(files, programFiles(options.stdin!));
        if (!options.stdin!.includes("setup.sh")) return ok();
        const report = [
          running && `t3 ${btoa(JSON.stringify({ orchestrationProtocolVersion: 2 }))}`,
          files[startedPath] !== undefined && `started ${files[startedPath]}`,
        ];
        return ok(report.filter(Boolean).join("\n"));
      }
      if (command.includes("auth session issue")) return ok("token");
      if (command.includes("well-known")) return running ? ok(JSON.stringify({ orchestrationProtocolVersion: 2 })) : failed;
      return ok();
    },
    files: {
      read: async (path: string) => {
        if (files[path] === undefined) throw new Error("No such file.");
        return files[path];
      },
      write: async (written: Record<string, string>) => void Object.assign(files, written),
    },
    start: async () => {
      running = true;
      const env = files["/workspace/.vmbridge/env"] ?? "";
      files[startedPath] = /^VMBRIDGE_CREDENTIALS=(.*)$/m.exec(env)?.[1] ?? "";
    },
    preview: async () => ({ url: t3.url, headers: {} }),
  } as unknown as Box;

  const events: string[] = [];
  const driver = {
    create: async () => (events.push("create"), box),
    wake: async () => (events.push("wake"), box),
    sleep: async (): Promise<{ checkpoint?: string }> => (events.push("sleep"), {}),
    destroy: async (sandboxId: string) => void events.push(`destroy ${sandboxId}`),
    connect: async (sandboxId: string) => (events.push(`connect ${sandboxId}`), box),
    keepAlive: async () => {},
    deleteCheckpoint: async (checkpoint: string) => void events.push(`delete checkpoint ${checkpoint}`),
    list: async (): Promise<SandboxInfo[]> => [],
  };

  const fleet = new Fleet(store, settings, secrets, traffic, agents, skills, openSocket);
  fleet.driver = () => driver as unknown as Driver;
  fleets.push(fleet);
  const hub = new Hub(store, settings, fleet, traffic, unmeasured);
  fleet.onConnect = async () => {};
  return { store, fleet, hub, driver, events, recorded };
}

describe("Fleet.destroy failure handling", () => {
  const later = () => Date.now() + 24 * 60 * 60_000;

  test("marks an awake VM as error, emits offline, logs the failure, and allows idle sweep and retry destroy", async () => {
    const { store, fleet, hub, driver, events, recorded } = setup();
    const offline: string[] = [];
    let changed = 0;
    fleet.on("offline", (vmId) => offline.push(vmId));
    fleet.on("changed", () => changed++);

    const vm = await fleet.create();
    await fleet.ensure(vm.id);
    expect(store.vm(vm.id)?.state).toBe("ready");
    expect(fleet.backend(vm.id)).toBeDefined();

    const changedBefore = changed;
    const destroyOk = driver.destroy;
    driver.destroy = async () => {
      throw new Error("provider 503");
    };

    await expect(fleet.destroy(vm.id)).rejects.toThrow("provider 503");
    expect(fleet.backend(vm.id)).toBeUndefined();
    expect(fleet.box(vm.id)).toBeUndefined();
    expect(store.vm(vm.id)).toMatchObject({ state: "error", error: "provider 503", sandboxId: "sb1" });
    expect(offline).toEqual([vm.id]);
    expect(changed).toBeGreaterThan(changedBefore);
    expect(recorded).toContainEqual({
      kind: "provider",
      operation: "delete VM",
      vmId: vm.id,
      provider: "boxd",
      status: "error",
      reason: "provider 503",
    });

    // Idle sweep can now put the failed, still-billable VM to sleep instead of leaving it running forever.
    await hub.sweep(later());
    expect(events).toEqual(["create", "wake", "connect sb1", "sleep"]);
    expect(store.vm(vm.id)?.state).toBe("sleeping");

    // Retrying destroy after the provider recovers completes deletion cleanly.
    driver.destroy = destroyOk;
    await fleet.destroy(vm.id);
    expect(store.vm(vm.id)).toBeNull();
    expect(events).toEqual(["create", "wake", "connect sb1", "sleep", "destroy sb1"]);
    expect(offline).toEqual([vm.id, vm.id, vm.id]);
    expect(recorded).toContainEqual({ kind: "provider", operation: "delete VM", vmId: vm.id, status: "ok" });
  });

  test("retires the checkpoint for bases.sweep and finishes deleting the VM when deleteCheckpoint fails", async () => {
    const { store, fleet, driver, events, recorded } = setup();
    const offline: string[] = [];
    fleet.on("offline", (vmId) => offline.push(vmId));

    const vm = await fleet.create();
    await fleet.ensure(vm.id);
    driver.sleep = async () => (events.push("sleep"), { checkpoint: "cp1" });
    await fleet.sleep(vm.id);
    offline.length = 0;

    const deleteCheckpointOk = driver.deleteCheckpoint;
    driver.deleteCheckpoint = async () => {
      throw new Error("checkpoint storage 500");
    };

    await fleet.destroy(vm.id);
    expect(events).toEqual(["create", "wake", "sleep", "destroy sb1"]);
    expect(store.vm(vm.id)).toBeNull();
    expect(store.retiredSnapshots("boxd")).toEqual(["cp1"]);
    expect(offline).toEqual([vm.id]);
    expect(recorded).toContainEqual({
      kind: "provider",
      operation: "delete snapshot",
      vmId: vm.id,
      provider: "boxd",
      status: "error",
      reason: "checkpoint storage 500",
    });
    expect(recorded).toContainEqual({ kind: "provider", operation: "delete VM", vmId: vm.id, status: "ok" });

    // Once checkpoint storage recovers, bases.sweep deletes the retired snapshot.
    driver.deleteCheckpoint = deleteCheckpointOk;
    await fleet.bases.sweep("boxd");
    expect(events).toEqual(["create", "wake", "sleep", "destroy sb1", "delete checkpoint cp1"]);
    expect(store.retiredSnapshots("boxd")).toEqual([]);
  });

  test("preserves sleeping state when driver.destroy fails and skips provider destroy for gone VMs", async () => {
    const { store, fleet, hub, driver, events, recorded } = setup();
    const offline: string[] = [];
    fleet.on("offline", (vmId) => offline.push(vmId));

    const vm = await fleet.create();
    await fleet.ensure(vm.id);
    await fleet.sleep(vm.id);
    offline.length = 0;

    const destroyOk = driver.destroy;
    driver.destroy = async () => {
      throw new Error("provider 503");
    };

    await expect(fleet.destroy(vm.id)).rejects.toThrow("provider 503");
    expect(store.vm(vm.id)).toMatchObject({ state: "sleeping", error: "provider 503", sandboxId: "sb1" });
    expect(offline).toEqual([]);
    expect(recorded).toContainEqual({
      kind: "provider",
      operation: "delete VM",
      vmId: vm.id,
      provider: "boxd",
      status: "error",
      reason: "provider 503",
    });

    // Idle sweep leaves the still-sleeping VM asleep instead of treating it as awake.
    await hub.sweep(later());
    expect(events).toEqual(["create", "wake", "sleep"]);
    expect(store.vm(vm.id)?.state).toBe("sleeping");

    driver.destroy = destroyOk;
    await fleet.destroy(vm.id);
    expect(store.vm(vm.id)).toBeNull();
    expect(events).toEqual(["create", "wake", "sleep", "destroy sb1"]);

    // A gone VM skips driver.destroy and retires any leftover checkpoint if its delete fails.
    const gone = await fleet.create();
    store.updateVm(gone.id, { state: "gone", error: "The provider no longer has this VM.", checkpoint: "cp-gone" });
    events.length = 0;
    driver.destroy = async () => {
      throw new Error("should not destroy gone sandbox");
    };
    driver.deleteCheckpoint = async () => {
      throw new Error("checkpoint storage 500");
    };

    await fleet.destroy(gone.id);
    expect(events).toEqual([]);
    expect(store.vm(gone.id)).toBeNull();
    expect(store.retiredSnapshots("boxd")).toEqual(["cp-gone"]);
  });
});
