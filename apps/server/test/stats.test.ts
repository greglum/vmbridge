import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";
import type { Fleet } from "../src/fleet.ts";
import type { Box } from "../src/providers/types.ts";
import { highMemory, parseStats, Stats } from "../src/vm/stats.ts";

const gib = 2 ** 30;

/** Output of the stats command, shaped like a real VM's (Instabox, 4 vCPU and 8 GB). */
function output(parts: Partial<Record<string, string>> = {}) {
  const all: Record<string, string> = {
    cpu0: "6.96 20.87\nusage_usec 2736826\ncpu  100 0 157 2089 363 0 15 0 0 0",
    meminfo: "MemTotal:        8155548 kB\nMemAvailable:    7774384 kB",
    "memory.max": "",
    "memory.current": "",
    "memory.stat": "inactive_file 201015296",
    psi: "some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0",
    "cpu.max": "",
    nproc: "4",
    df: "Filesystem     1024-blocks    Used Available Capacity Mounted on\n/dev/vdb          20466256 4194576  16255296      21% /data",
    cpu1: "7.97 24.88\nusage_usec 2752819\ncpu  100 0 159 2488 365 0 15 0 0 0",
  };
  return Object.entries({ ...all, ...parts })
    .map(([name, text]) => `@${name}\n${text ? `${text}\n` : ""}`)
    .join("");
}

describe("parseStats", () => {
  test("reads a VM: meminfo, PSI, CPU from the cgroup counter, and df", () => {
    const stats = parseStats(output(), 1);
    expect(stats.memory).toEqual({ used: (8155548 - 7774384) * 1024, total: 8155548 * 1024 });
    expect(stats.memoryPressure).toBe(0);
    // 15993 µs of CPU over 1.01 s on 4 cores.
    expect(stats.cpu?.cores).toBe(4);
    expect(stats.cpu?.usage).toBeCloseTo(15993 / 1.01e6 / 4, 6);
    expect(stats.disk).toEqual({ used: (20466256 - 16255296) * 1024, total: 20466256 * 1024 });
    expect(stats.highMemory).toBe(false);
  });

  test("leaves pressure out when the kernel has no PSI", () => {
    expect(parseStats(output({ psi: "" }), 1).memoryPressure).toBeNull();
  });

  test("uses a container's cgroup v2 limits instead of the host's meminfo", () => {
    const stats = parseStats(
      output({ "memory.max": "536870912", "memory.current": "500000000", "memory.stat": "inactive_file 20000000", "cpu.max": "50000 100000" }),
      1,
    );
    // Inactive page cache is reclaimable, so it is not used.
    expect(stats.memory).toEqual({ used: 480_000_000, total: 536870912 });
    expect(stats.cpu?.cores).toBe(0.5);
    expect(stats.highMemory).toBe(false);
  });

  test("ignores an unlimited cgroup and falls back to /proc/stat without a cgroup CPU counter", () => {
    const stats = parseStats(
      output({
        "memory.max": "max",
        "memory.current": "300000000",
        "cpu.max": "max 100000",
        cpu0: "1.00 2.00\ncpu  100 0 100 700 100 0 0 0 0 0",
        cpu1: "2.00 3.00\ncpu  200 0 200 900 200 0 0 0 0 0",
      }),
      1,
    );
    expect(stats.memory?.total).toBe(8155548 * 1024);
    // 200 busy ticks out of 500.
    expect(stats.cpu?.cores).toBe(4);
    expect(stats.cpu?.usage).toBeCloseTo(0.4, 6);
  });

  test("reads df with a long device name and survives missing parts", () => {
    const df = "Filesystem                       1024-blocks    Used Available Capacity Mounted on\n/dev/disk/by-id/packstore-rootfs    29985524 3670060  26299080      13% /";
    expect(parseStats(output({ df }), 1).disk?.total).toBe(29985524 * 1024);
    expect(parseStats("", 1)).toEqual({ at: 1, memory: null, memoryPressure: null, cpu: null, disk: null, highMemory: false });
  });
});

describe("highMemory", () => {
  test("flags 90% used or PSI some avg10 at 10", () => {
    expect(highMemory({ used: 9 * gib, total: 10 * gib }, 0)).toBe(true);
    expect(highMemory({ used: 8.9 * gib, total: 10 * gib }, 9.99)).toBe(false);
    expect(highMemory({ used: 1 * gib, total: 10 * gib }, 10)).toBe(true);
    expect(highMemory(null, null)).toBe(false);
  });

  test("applies to a parsed reading", () => {
    const full = output({ meminfo: "MemTotal:        8155548 kB\nMemAvailable:     400000 kB" });
    expect(parseStats(full, 1).highMemory).toBe(true);
    const stalled = output({ psi: "some avg10=23.50 avg60=4.00 avg300=1.00 total=99\nfull avg10=12.00 avg60=2.00 avg300=0.50 total=50" });
    expect(parseStats(stalled, 1)).toMatchObject({ memoryPressure: 23.5, highMemory: true });
  });
});

describe("Stats", () => {
  function fakeFleet() {
    const emitter = new EventEmitter();
    const boxes = new Map<string, Box>();
    const fleet = Object.assign(emitter, {
      box: (vmId: string) => boxes.get(vmId),
      connected: () => [...boxes.keys()],
    }) as unknown as Fleet;
    return { fleet, boxes };
  }

  test("ignores a stale reading from a previous connection without disturbing a pending replacement", async () => {
    const { fleet, boxes } = fakeFleet();
    const stats = new Stats(fleet);
    let resolveOld!: (value: { exitCode: number; stdout: string; stderr: string }) => void;
    let resolveNew!: (value: { exitCode: number; stdout: string; stderr: string }) => void;
    const oldBox = {
      run: () => new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => (resolveOld = resolve)),
    } as unknown as Box;
    const newBox = {
      run: () => new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => (resolveNew = resolve)),
    } as unknown as Box;

    boxes.set("vm1", oldBox);
    const oldReading = stats.sample("vm1");

    // VM goes offline and reconnects with a fresh box while the old stats command is still running.
    boxes.delete("vm1");
    fleet.emit("offline", "vm1");
    boxes.set("vm1", newBox);
    const freshReading = stats.sample("vm1");

    // Old reading settles while the replacement is still in flight; it must be discarded and must not clear the new flight.
    let changed = 0;
    fleet.on("changed", () => (changed += 1));
    resolveOld({
      exitCode: 0,
      stdout: output({ meminfo: "MemTotal:        8155548 kB\nMemAvailable:     100000 kB" }),
      stderr: "",
    });
    expect(await oldReading).toBeNull();
    expect(changed).toBe(0);
    expect(stats.sample("vm1")).toBe(freshReading);

    resolveNew({
      exitCode: 0,
      stdout: output({ meminfo: "MemTotal:        8155548 kB\nMemAvailable:    7000000 kB" }),
      stderr: "",
    });
    const resolvedFresh = await freshReading;
    expect(resolvedFresh?.memory?.used).toBe((8155548 - 7000000) * 1024);
    expect(changed).toBe(1);
    expect(stats.get("vm1")?.memory?.used).toBe((8155548 - 7000000) * 1024);
  });

  test("replaces an in-flight reading when the box changes without an offline event", async () => {
    const { fleet, boxes } = fakeFleet();
    const stats = new Stats(fleet);
    let resolveOld!: (value: { exitCode: number; stdout: string; stderr: string }) => void;
    const oldBox = {
      run: () => new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => (resolveOld = resolve)),
    } as unknown as Box;
    const newBox = {
      run: async () => ({
        exitCode: 0,
        stdout: output({ meminfo: "MemTotal:        8155548 kB\nMemAvailable:    6500000 kB" }),
        stderr: "",
      }),
    } as unknown as Box;

    boxes.set("vm1", oldBox);
    const oldReading = stats.sample("vm1");
    boxes.set("vm1", newBox);
    const freshReading = await stats.sample("vm1");
    expect(freshReading?.memory?.used).toBe((8155548 - 6500000) * 1024);

    resolveOld({
      exitCode: 0,
      stdout: output({ meminfo: "MemTotal:        8155548 kB\nMemAvailable:     100000 kB" }),
      stderr: "",
    });
    expect(await oldReading).toBeNull();
    expect(stats.get("vm1")?.memory?.used).toBe((8155548 - 6500000) * 1024);
  });

  test("clears in-flight tracking after both synchronous throws and async rejections so the next sample retries", async () => {
    const { fleet, boxes } = fakeFleet();
    const stats = new Stats(fleet);
    let attempt = 0;
    const flakyBox = {
      run: () => {
        attempt += 1;
        if (attempt === 1) throw new Error("sync failure");
        if (attempt === 2) return Promise.reject(new Error("async failure"));
        return Promise.resolve({
          exitCode: 0,
          stdout: output({ meminfo: "MemTotal:        8155548 kB\nMemAvailable:    7200000 kB" }),
          stderr: "",
        });
      },
    } as unknown as Box;

    boxes.set("vm1", flakyBox);
    expect(await stats.sample("vm1")).toBeNull();
    expect(await stats.sample("vm1")).toBeNull();
    const ok = await stats.sample("vm1");
    expect(ok?.memory?.used).toBe((8155548 - 7200000) * 1024);
    expect(attempt).toBe(3);
  });

  test("drops an in-flight reading after offline even if the VM reconnects before a new sample starts", async () => {
    const { fleet, boxes } = fakeFleet();
    const stats = new Stats(fleet);
    let resolveOld!: (value: { exitCode: number; stdout: string; stderr: string }) => void;
    const sameBox = {
      run: () => new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => (resolveOld = resolve)),
    } as unknown as Box;

    boxes.set("vm1", sameBox);
    const oldReading = stats.sample("vm1");
    fleet.emit("offline", "vm1");

    resolveOld({
      exitCode: 0,
      stdout: output({ meminfo: "MemTotal:        8155548 kB\nMemAvailable:     200000 kB" }),
      stderr: "",
    });
    expect(await oldReading).toBeNull();
    expect(stats.get("vm1")).toBeNull();
    expect(stats.lastDisk("vm1")).toBeNull();
  });

  test("preserves lastDisk across sleep/offline and evicts it once the VM is removed", async () => {
    const { fleet, boxes } = fakeFleet();
    let exists = true;
    const stats = new Stats(fleet, () => exists);
    const box = {
      run: async () => ({ exitCode: 0, stdout: output(), stderr: "" }),
    } as unknown as Box;

    boxes.set("vm1", box);
    await stats.sample("vm1");
    expect(stats.lastDisk("vm1")).toEqual({ used: (20466256 - 16255296) * 1024, total: 20466256 * 1024 });

    // Sleep/disconnect keeps lastDisk.
    boxes.delete("vm1");
    fleet.emit("offline", "vm1");
    expect(stats.get("vm1")).toBeNull();
    expect(stats.lastDisk("vm1")).toEqual({ used: (20466256 - 16255296) * 1024, total: 20466256 * 1024 });

    // Permanent removal evicts lastDisk.
    exists = false;
    fleet.emit("offline", "vm1");
    expect(stats.lastDisk("vm1")).toBeNull();
  });
});
