import { afterEach, describe, expect, jest, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { Overview } from "@vmbridge/contracts";
import { Admin, type AdminDeps } from "../src/admin.ts";
import { adminEvents, type AdminEventsDeps } from "../src/admin-events.ts";
import { Traffic } from "../src/traffic.ts";

const emptyOverview = () => ({ bridge: { id: "b1", version: "0.0.0", startedAt: 0, update: null } }) as unknown as Overview;
const decoder = new TextDecoder();
const local = { address: "127.0.0.1", secure: false };
const eventRequest = (signal: AbortSignal) => new Request("http://127.0.0.1/admin/api/events", { signal });

function makeDeps(allows: () => Promise<boolean> = async () => true) {
  const traffic = new Traffic();
  const fleet = new EventEmitter();
  const hub = new EventEmitter();
  let activeWatches = 0;
  let watchCalls = 0;
  const authEnded: (() => void)[] = [];
  const auth = {
    authenticated: () => true,
    watch: (_request: Request, ended: () => void) => {
      watchCalls++;
      activeWatches++;
      authEnded.push(ended);
      let stopped = false;
      return () => {
        if (stopped) return;
        stopped = true;
        activeWatches--;
      };
    },
  };
  const admin = new Admin({ network: { allows }, traffic, fleet, hub, auth } as unknown as AdminDeps);
  // Avoid spinning up the full overview store/provider graph for SSE lifecycle tests.
  (admin as unknown as { overview: () => Overview }).overview = emptyOverview;
  const open = (signal: AbortSignal, overrides?: Partial<AdminEventsDeps>) =>
    adminEvents(eventRequest(signal), { traffic, fleet, hub, auth, overview: emptyOverview, ...overrides });
  return {
    admin,
    traffic,
    fleet,
    hub,
    auth,
    authEnded,
    open,
    counts: () => ({
      activeWatches,
      watchCalls,
      fleetListeners: fleet.listenerCount("changed"),
      hubListeners: hub.listenerCount("shell"),
    }),
  };
}

function trackLifecycle(traffic: Traffic, ...signals: AbortSignal[]) {
  const realSubscribe = traffic.subscribe.bind(traffic);
  const unsubscribes: ReturnType<typeof jest.fn>[] = [];
  const subscribeSpy = spyOn(traffic, "subscribe").mockImplementation((listener) => {
    const realUnsub = realSubscribe(listener);
    const wrapped = jest.fn(() => realUnsub());
    unsubscribes.push(wrapped);
    return wrapped;
  });

  const realSetInterval = globalThis.setInterval;
  const realSetTimeout = globalThis.setTimeout;
  const intervals: ReturnType<typeof setInterval>[] = [];
  const timeouts: ReturnType<typeof setTimeout>[] = [];
  const setIntervalSpy = spyOn(globalThis, "setInterval").mockImplementation(
    ((...args: unknown[]) => {
      const handle = Reflect.apply(realSetInterval, globalThis, args) as ReturnType<typeof setInterval>;
      intervals.push(handle);
      return handle;
    }) as unknown as typeof setInterval,
  );
  const setTimeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(
    ((...args: unknown[]) => {
      const handle = Reflect.apply(realSetTimeout, globalThis, args) as ReturnType<typeof setTimeout>;
      timeouts.push(handle);
      return handle;
    }) as unknown as typeof setTimeout,
  );
  const clearIntervalSpy = spyOn(globalThis, "clearInterval");
  const clearTimeoutSpy = spyOn(globalThis, "clearTimeout");
  const removeSpies = signals.map((signal) => spyOn(signal, "removeEventListener"));

  return {
    unsubscribes,
    intervals,
    timeouts,
    clearIntervalSpy,
    clearTimeoutSpy,
    removeSpies,
    restore() {
      subscribeSpy.mockRestore();
      setIntervalSpy.mockRestore();
      setTimeoutSpy.mockRestore();
      clearIntervalSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
      for (const spy of removeSpies) spy.mockRestore();
    },
  };
}

function openWithThrowingController(open: () => Response) {
  const OriginalStream = globalThis.ReadableStream;
  let enqueues = 0;
  let closeAttempts = 0;
  globalThis.ReadableStream = class extends OriginalStream<Uint8Array> {
    constructor(
      source?: { start?: (controller: ReadableStreamDefaultController<Uint8Array>) => void; cancel?: () => void },
      strategy?: QueuingStrategy<Uint8Array>,
    ) {
      super(
        source?.start
          ? {
              cancel: source.cancel,
              start(controller) {
                const wrapped = {
                  ...controller,
                  enqueue(chunk: Uint8Array) {
                    enqueues++;
                    if (enqueues > 1) throw new TypeError("Controller is already closed");
                    return controller.enqueue(chunk);
                  },
                  close() {
                    closeAttempts++;
                    throw new TypeError("Controller is already closed");
                  },
                } as ReadableStreamDefaultController<Uint8Array>;
                source.start!(wrapped);
              },
            }
          : source,
        strategy,
      );
    }
  } as typeof ReadableStream;
  try {
    return { response: open(), enqueueCount: () => enqueues, closeAttempts: () => closeAttempts };
  } finally {
    globalThis.ReadableStream = OriginalStream;
  }
}

describe("admin SSE events", () => {
  afterEach(() => jest.useRealTimers());

  test("pre-aborted request to /admin/api/events closes immediately with zero leaked listeners or timers", async () => {
    const { admin, traffic, fleet, hub, counts } = makeDeps();
    const subscribeSpy = spyOn(traffic, "subscribe");
    const fleetOnSpy = spyOn(fleet, "on");
    const hubOnSpy = spyOn(hub, "on");
    const intervalSpy = spyOn(globalThis, "setInterval");
    try {
      const abort = new AbortController();
      abort.abort();
      const response = await admin.fetch(eventRequest(abort.signal), local);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      expect(await response.body!.getReader().read()).toEqual({ value: undefined, done: true });
      expect(subscribeSpy).not.toHaveBeenCalled();
      expect(fleetOnSpy).not.toHaveBeenCalled();
      expect(hubOnSpy).not.toHaveBeenCalled();
      expect(intervalSpy).not.toHaveBeenCalled();
      expect(counts()).toEqual({ activeWatches: 0, watchCalls: 0, fleetListeners: 0, hubListeners: 0 });
    } finally {
      subscribeSpy.mockRestore();
      fleetOnSpy.mockRestore();
      hubOnSpy.mockRestore();
      intervalSpy.mockRestore();
    }
  });

  test("request aborted while awaiting network.allows closes immediately with zero leaked listeners or timers", async () => {
    let resolveAllows!: (allowed: boolean) => void;
    const { admin, traffic, counts } = makeDeps(() => new Promise<boolean>((resolve) => (resolveAllows = resolve)));
    const subscribeSpy = spyOn(traffic, "subscribe");
    const intervalSpy = spyOn(globalThis, "setInterval");
    try {
      const abort = new AbortController();
      const pending = admin.fetch(eventRequest(abort.signal), local);
      abort.abort();
      resolveAllows(true);
      const response = await pending;
      expect(response.status).toBe(200);
      expect(await response.body!.getReader().read()).toEqual({ value: undefined, done: true });
      expect(subscribeSpy).not.toHaveBeenCalled();
      expect(intervalSpy).not.toHaveBeenCalled();
      expect(counts()).toEqual({ activeWatches: 0, watchCalls: 0, fleetListeners: 0, hubListeners: 0 });
    } finally {
      subscribeSpy.mockRestore();
      intervalSpy.mockRestore();
    }
  });

  test("cancelling one SSE stream unsubscribes traffic, clears heartbeat and pending debounce, and keeps a second stream live", async () => {
    jest.useFakeTimers();
    const { admin, traffic, fleet, counts } = makeDeps();
    const abort1 = new AbortController();
    const abort2 = new AbortController();
    const life = trackLifecycle(traffic, abort1.signal, abort2.signal);
    try {
      const res1 = await admin.fetch(eventRequest(abort1.signal), local);
      const res2 = await admin.fetch(eventRequest(abort2.signal), local);
      const reader1 = res1.body!.getReader();
      const reader2 = res2.body!.getReader();

      expect(decoder.decode((await reader1.read()).value)).toContain('"type":"overview"');
      expect(decoder.decode((await reader2.read()).value)).toContain('"type":"overview"');
      expect(counts()).toEqual({ activeWatches: 2, watchCalls: 2, fleetListeners: 2, hubListeners: 2 });
      expect(life.intervals).toHaveLength(2);

      // Schedule a pending debounce timer on both streams before cancelling stream 1.
      fleet.emit("changed");
      expect(life.timeouts).toHaveLength(2);

      await reader1.cancel();
      expect(life.unsubscribes[0]).toHaveBeenCalledTimes(1);
      expect(life.unsubscribes[1]).not.toHaveBeenCalled();
      expect(life.clearIntervalSpy).toHaveBeenCalledTimes(1);
      expect(life.clearIntervalSpy.mock.calls[0]![0]).toBe(life.intervals[0]);
      expect(life.clearTimeoutSpy).toHaveBeenCalledTimes(1);
      expect(life.clearTimeoutSpy.mock.calls[0]![0]).toBe(life.timeouts[0]);
      expect(life.removeSpies[0]).toHaveBeenCalledWith("abort", expect.any(Function));
      expect(counts()).toEqual({ activeWatches: 1, watchCalls: 2, fleetListeners: 1, hubListeners: 1 });

      expect(() => traffic.record({ kind: "rpc", operation: "after.cancel", status: "ok" })).not.toThrow();
      const next = await reader2.read();
      expect(next.done).toBe(false);
      expect(decoder.decode(next.value)).toContain('"operation":"after.cancel"');

      abort2.abort();
      expect(await reader2.read()).toEqual({ value: undefined, done: true });
      expect(life.unsubscribes[1]).toHaveBeenCalledTimes(1);
      expect(life.clearIntervalSpy).toHaveBeenCalledTimes(2);
      expect(life.clearIntervalSpy.mock.calls[1]![0]).toBe(life.intervals[1]);
      expect(life.clearTimeoutSpy).toHaveBeenCalledTimes(2);
      expect(life.clearTimeoutSpy.mock.calls[1]![0]).toBe(life.timeouts[1]);
      expect(life.removeSpies[1]).toHaveBeenCalledWith("abort", expect.any(Function));
      expect(counts()).toEqual({ activeWatches: 0, watchCalls: 2, fleetListeners: 0, hubListeners: 0 });
    } finally {
      life.restore();
    }
  });

  test("closed controller during traffic.record() unsubscribes, clears timers, and still delivers to other streams", async () => {
    jest.useFakeTimers();
    const { traffic, fleet, open, counts } = makeDeps();
    const abort1 = new AbortController();
    const abort2 = new AbortController();
    const life = trackLifecycle(traffic, abort1.signal, abort2.signal);
    try {
      const { response: res1, enqueueCount, closeAttempts } = openWithThrowingController(() => open(abort1.signal));
      const res2 = open(abort2.signal);
      const reader1 = res1.body!.getReader();
      const reader2 = res2.body!.getReader();
      expect(decoder.decode((await reader1.read()).value)).toContain('"type":"overview"');
      expect(decoder.decode((await reader2.read()).value)).toContain('"type":"overview"');

      fleet.emit("changed");
      expect(life.timeouts).toHaveLength(2);

      expect(() => traffic.record({ kind: "rpc", operation: "still.delivered", status: "ok" })).not.toThrow();
      const delivered = await reader2.read();
      expect(delivered.done).toBe(false);
      expect(decoder.decode(delivered.value)).toContain('"operation":"still.delivered"');

      expect(closeAttempts()).toBe(1);
      expect(life.unsubscribes[0]).toHaveBeenCalledTimes(1);
      expect(life.unsubscribes[1]).not.toHaveBeenCalled();
      expect(life.clearIntervalSpy).toHaveBeenCalledTimes(1);
      expect(life.clearIntervalSpy.mock.calls[0]![0]).toBe(life.intervals[0]);
      expect(life.clearTimeoutSpy).toHaveBeenCalledTimes(1);
      expect(life.clearTimeoutSpy.mock.calls[0]![0]).toBe(life.timeouts[0]);
      expect(life.removeSpies[0]).toHaveBeenCalledWith("abort", expect.any(Function));
      expect(counts()).toEqual({ activeWatches: 1, watchCalls: 2, fleetListeners: 1, hubListeners: 1 });

      // Heartbeat ticks only reach stream 2, not stream 1.
      const enqueuesAfterClose = enqueueCount();
      jest.advanceTimersByTime(25_000);
      expect(enqueueCount()).toBe(enqueuesAfterClose);
      expect(decoder.decode((await reader2.read()).value)).toContain('"type":"overview"');
      expect(decoder.decode((await reader2.read()).value)).toBe(": ping\n\n");

      abort2.abort();
      expect(await reader2.read()).toEqual({ value: undefined, done: true });
      expect(life.unsubscribes[1]).toHaveBeenCalledTimes(1);
      expect(life.clearIntervalSpy).toHaveBeenCalledTimes(2);
      expect(life.clearIntervalSpy.mock.calls[1]![0]).toBe(life.intervals[1]);
      expect(counts()).toEqual({ activeWatches: 0, watchCalls: 2, fleetListeners: 0, hubListeners: 0 });
    } finally {
      life.restore();
    }
  });

  test("closed controller triggered by heartbeat catches controller.close() outside Traffic.record() and completes teardown", async () => {
    jest.useFakeTimers();
    const { traffic, fleet, open, counts } = makeDeps();
    const abort = new AbortController();
    const life = trackLifecycle(traffic, abort.signal);
    try {
      const { response, closeAttempts } = openWithThrowingController(() => open(abort.signal));
      const reader = response.body!.getReader();
      expect(decoder.decode((await reader.read()).value)).toContain('"type":"overview"');

      // Schedule a pending debounce just before the 25s heartbeat fires so teardown must clear both timers.
      jest.advanceTimersByTime(24_900);
      fleet.emit("changed");
      expect(life.timeouts).toHaveLength(1);

      expect(() => jest.advanceTimersByTime(100)).not.toThrow();
      expect(closeAttempts()).toBe(1);
      expect(life.unsubscribes[0]).toHaveBeenCalledTimes(1);
      expect(life.clearIntervalSpy).toHaveBeenCalledTimes(1);
      expect(life.clearIntervalSpy.mock.calls[0]![0]).toBe(life.intervals[0]);
      expect(life.clearTimeoutSpy).toHaveBeenCalledTimes(1);
      expect(life.clearTimeoutSpy.mock.calls[0]![0]).toBe(life.timeouts[0]);
      expect(life.removeSpies[0]).toHaveBeenCalledWith("abort", expect.any(Function));
      expect(counts()).toEqual({ activeWatches: 0, watchCalls: 1, fleetListeners: 0, hubListeners: 0 });
    } finally {
      life.restore();
    }
  });

  test("throwing debounced overview() refresh does not escape uncaught and triggers full cleanup", async () => {
    jest.useFakeTimers();
    const { traffic, fleet, hub, open, counts } = makeDeps();
    const abort = new AbortController();
    const life = trackLifecycle(traffic, abort.signal);
    let overviewCalls = 0;
    try {
      const response = open(abort.signal, {
        overview: () => {
          overviewCalls++;
          if (overviewCalls > 1) throw new Error("overview refresh failed");
          return emptyOverview();
        },
      });
      const reader = response.body!.getReader();
      expect(decoder.decode((await reader.read()).value)).toContain('"type":"overview"');

      fleet.emit("changed");
      expect(life.timeouts).toHaveLength(1);
      expect(() => jest.advanceTimersByTime(200)).not.toThrow();

      expect(await reader.read()).toEqual({ value: undefined, done: true });
      expect(life.unsubscribes[0]).toHaveBeenCalledTimes(1);
      expect(life.clearIntervalSpy).toHaveBeenCalledTimes(1);
      expect(life.clearIntervalSpy.mock.calls[0]![0]).toBe(life.intervals[0]);
      expect(life.removeSpies[0]).toHaveBeenCalledWith("abort", expect.any(Function));
      expect(counts()).toEqual({ activeWatches: 0, watchCalls: 1, fleetListeners: 0, hubListeners: 0 });

      // Subsequent hub/fleet events must not schedule another refresh after teardown.
      hub.emit("shell");
      jest.advanceTimersByTime(200);
      expect(overviewCalls).toBe(2);
    } finally {
      life.restore();
    }
  });

  test("auth.watch ended callback closes stream and runs full teardown (async and synchronous)", async () => {
    jest.useFakeTimers();
    const { traffic, fleet, authEnded, open, counts } = makeDeps();
    const abort1 = new AbortController();
    const abort2 = new AbortController();
    const life = trackLifecycle(traffic, abort1.signal, abort2.signal);
    try {
      // Async session end after stream opens with a pending debounce timer.
      const res1 = open(abort1.signal);
      const reader1 = res1.body!.getReader();
      expect(decoder.decode((await reader1.read()).value)).toContain('"type":"overview"');
      fleet.emit("changed");
      expect(life.timeouts).toHaveLength(1);

      authEnded[0]!();
      expect(await reader1.read()).toEqual({ value: undefined, done: true });
      expect(life.unsubscribes[0]).toHaveBeenCalledTimes(1);
      expect(life.clearIntervalSpy).toHaveBeenCalledTimes(1);
      expect(life.clearIntervalSpy.mock.calls[0]![0]).toBe(life.intervals[0]);
      expect(life.clearTimeoutSpy).toHaveBeenCalledTimes(1);
      expect(life.clearTimeoutSpy.mock.calls[0]![0]).toBe(life.timeouts[0]);
      expect(life.removeSpies[0]).toHaveBeenCalledWith("abort", expect.any(Function));
      expect(counts()).toEqual({ activeWatches: 0, watchCalls: 1, fleetListeners: 0, hubListeners: 0 });

      // Synchronous ended() inside auth.watch still invokes the returned unwatch and cleans up.
      const syncUnwatch = jest.fn();
      const res2 = open(abort2.signal, {
        auth: {
          watch: (_request, ended) => {
            ended();
            return syncUnwatch;
          },
        },
      });
      expect(await res2.body!.getReader().read()).toEqual({ value: undefined, done: true });
      expect(syncUnwatch).toHaveBeenCalledTimes(1);
      expect(life.unsubscribes[1]).toHaveBeenCalledTimes(1);
      expect(life.clearIntervalSpy).toHaveBeenCalledTimes(2);
      expect(life.clearIntervalSpy.mock.calls[1]![0]).toBe(life.intervals[1]);
      expect(life.removeSpies[1]).toHaveBeenCalledWith("abort", expect.any(Function));
      expect(counts()).toEqual({ activeWatches: 0, watchCalls: 1, fleetListeners: 0, hubListeners: 0 });
    } finally {
      life.restore();
    }
  });
});
