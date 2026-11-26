import { describe, expect, test } from "bun:test";
import { wakeBoatSandbox } from "../src/providers/boat.ts";

describe("wakeBoatSandbox", () => {
  test("fails fast at the stop deadline without overshooting or waiting for startup", async () => {
    let time = 0;
    let polls = 0;
    let resumed = 0;
    let waited = 0;
    let connected = 0;
    await expect(
      wakeBoatSandbox("sbx-1", {
        get: async () => {
          polls += 1;
          return { state: "stopping" };
        },
        resume: async () => {
          resumed += 1;
        },
        waitRunning: async () => {
          waited += 1;
        },
        connect: async () => {
          connected += 1;
          return "box";
        },
        sleep: async (ms) => {
          time += ms;
        },
        now: () => time,
        stopTimeoutMs: 1_500,
      }),
    ).rejects.toThrow("Boat VM sbx-1 is still stopping; try again.");
    expect(time).toBe(1_500);
    expect(polls).toBe(3);
    expect(resumed).toBe(0);
    expect(waited).toBe(0);
    expect(connected).toBe(0);
  });

  test("resumes once stopping completes and connects after running", async () => {
    const states = ["securing", "stopped"];
    let index = 0;
    const calls: string[] = [];
    const box = await wakeBoatSandbox("sbx-3", {
      get: async () => ({ state: states[index++] ?? "stopped" }),
      resume: async () => {
        calls.push("resume");
      },
      waitRunning: async () => {
        calls.push("waitRunning");
      },
      connect: async () => {
        calls.push("connect");
        return "box";
      },
      sleep: async () => {},
    });
    expect(box).toBe("box");
    expect(calls).toEqual(["resume", "waitRunning", "connect"]);
  });

  test("skips resume when the VM is already running or starting up", async () => {
    for (const state of ["running", "ready", "resuming", "starting", "queued", "provisioning"]) {
      let resumed = 0;
      const box = await wakeBoatSandbox(`sbx-${state}`, {
        get: async () => ({ state }),
        resume: async () => {
          resumed += 1;
        },
        waitRunning: async () => {},
        connect: async () => "box",
        sleep: async () => {},
      });
      expect(box).toBe("box");
      expect(resumed).toBe(0);
    }
  });
});
