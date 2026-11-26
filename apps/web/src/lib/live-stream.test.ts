import { describe, expect, test } from "bun:test";
import type { Overview, TrafficEvent } from "@vmbridge/contracts";
import { startLiveStream, type LiveEventSource, type LiveStreamTimers } from "./live-stream.ts";

class FakeEventSource implements LiveEventSource {
  readyState = 0;
  closed = false;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;

  open() {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }

  emit(data: unknown) {
    this.readyState = 1;
    this.onmessage?.(new MessageEvent("message", { data: typeof data === "string" ? data : JSON.stringify(data) }));
  }

  fail(readyState: number) {
    this.readyState = readyState;
    this.onerror?.(new Event("error"));
  }

  close() {
    this.closed = true;
    this.readyState = 2;
  }
}

class FakeTimers {
  private nextId = 1;
  readonly timeouts = new Map<number, { callback: () => void; ms: number }>();
  readonly intervals = new Map<number, { callback: () => void; ms: number }>();
  readonly scheduledDelays: number[] = [];

  readonly api: LiveStreamTimers = {
    setTimeout: (callback, ms) => {
      const id = this.nextId++;
      this.timeouts.set(id, { callback, ms });
      this.scheduledDelays.push(ms);
      return id;
    },
    clearTimeout: (handle) => {
      this.timeouts.delete(handle as number);
    },
    setInterval: (callback, ms) => {
      const id = this.nextId++;
      this.intervals.set(id, { callback, ms });
      return id;
    },
    clearInterval: (handle) => {
      this.intervals.delete(handle as number);
    },
  };

  fireNextTimeout() {
    const first = this.timeouts.entries().next();
    if (first.done) throw new Error("no pending timeout");
    const [id, entry] = first.value;
    this.timeouts.delete(id);
    entry.callback();
  }

  fireIntervals() {
    for (const entry of [...this.intervals.values()]) entry.callback();
  }
}

const overview = (version: string) => ({ bridge: { version } }) as Overview;
const trafficEvent = (id: number) => ({ id, kind: "system", at: id, operation: `op-${id}` }) as unknown as TrafficEvent;
const eventIds = (events: TrafficEvent[]) => events.map((event) => (event as { id?: number }).id);
const flush = () => Promise.resolve().then(() => Promise.resolve());

describe("startLiveStream", () => {
  test("validates frames, preserves traffic history across live events and reconnects, backs off on CLOSED, and ignores stale sources", async () => {
    const timers = new FakeTimers();
    const sources: FakeEventSource[] = [];
    const onlineStates: boolean[] = [];
    const overviews: string[] = [];
    let currentTraffic: TrafficEvent[] = [];
    let loggedOut = 0;
    const overviewResolvers: Array<(value: Overview) => void> = [];
    const trafficResolvers: Array<(value: TrafficEvent[]) => void> = [];
    let authImpl: () => Promise<{ authenticated?: boolean }> = () => Promise.reject(new Error("502 Bad Gateway"));

    const stop = startLiveStream({
      createEventSource: () => {
        const source = new FakeEventSource();
        sources.push(source);
        return source;
      },
      fetchAuth: () => authImpl(),
      fetchOverview: () => new Promise<Overview>((resolve) => overviewResolvers.push(resolve)),
      fetchTraffic: () => new Promise<TrafficEvent[]>((resolve) => trafficResolvers.push(resolve)),
      onOverview: (next) => overviews.push(next.bridge.version),
      onTrafficSnapshot: (events) => {
        currentTraffic = events;
      },
      onTrafficEvent: (event) => {
        currentTraffic = [...currentTraffic, event];
      },
      onOnline: (online) => onlineStates.push(online),
      onLoggedOut: () => {
        loggedOut++;
      },
      timers: timers.api,
    });

    try {
      expect(sources).toHaveLength(1);
      expect(timers.intervals.size).toBe(1);
      expect(overviewResolvers).toHaveLength(1);
      expect(trafficResolvers).toHaveLength(1);

      // Malformed JSON, unknown types, and empty/null payloads do not stop polling or emit broken updates.
      sources[0]!.open();
      sources[0]!.emit("not-json");
      sources[0]!.emit({ type: "unknown" });
      sources[0]!.emit({ type: "overview", overview: null });
      sources[0]!.emit({ type: "overview", overview: {} });
      sources[0]!.emit({ type: "traffic", event: null });
      sources[0]!.emit({ type: "traffic", event: {} });
      expect(timers.intervals.size).toBe(1);
      expect(overviews).toEqual([]);
      expect(currentTraffic).toEqual([]);

      // Slow polls still apply if a newer poll has not resolved yet, while older polls arriving after a newer one are ignored.
      timers.fireIntervals();
      expect(overviewResolvers).toHaveLength(2);
      expect(trafficResolvers).toHaveLength(2);
      overviewResolvers[0]!(overview("poll-1-slow"));
      await flush();
      expect(overviews).toEqual(["poll-1-slow"]);
      timers.fireIntervals();
      expect(overviewResolvers).toHaveLength(3);
      overviewResolvers[2]!(overview("poll-3"));
      overviewResolvers[1]!(overview("poll-2-stale"));
      await flush();
      expect(overviews).toEqual(["poll-1-slow", "poll-3"]);

      // A live traffic event arriving before the latest /traffic snapshot resolves is merged with history, not dropped.
      sources[0]!.emit({ type: "overview", overview: overview("sse-1") });
      expect(timers.intervals.size).toBe(0);
      sources[0]!.emit({ type: "traffic", event: trafficEvent(3) });
      trafficResolvers[2]!([trafficEvent(1), trafficEvent(2)]);
      trafficResolvers[1]!([trafficEvent(99)]); // older overlapping snapshot ignored
      trafficResolvers[0]!([trafficEvent(98)]);
      await flush();
      expect(eventIds(currentTraffic)).toEqual([1, 2, 3]);

      // CONNECTING error marks offline and resumes polling without closing the EventSource.
      sources[0]!.fail(0);
      expect(onlineStates.at(-1)).toBe(false);
      expect(sources[0]!.closed).toBe(false);
      expect(timers.intervals.size).toBe(1);
      const overviewCountBeforeTick = overviewResolvers.length;
      timers.fireIntervals();
      expect(overviewResolvers.length).toBe(overviewCountBeforeTick + 1);

      // Repeated CLOSED errors back off 2s -> 4s -> 8s -> 15s -> 15s, even while /auth fails, returns {}, or hangs.
      sources[0]!.fail(2);
      expect(sources[0]!.closed).toBe(true);
      await flush();
      timers.fireNextTimeout(); // 2000ms -> sources[1]

      authImpl = async () => ({});
      sources[1]!.fail(2);
      await flush();
      timers.fireNextTimeout(); // 4000ms -> sources[2]

      let releaseHungAuth!: (value: { authenticated?: boolean }) => void;
      authImpl = () => new Promise((resolve) => (releaseHungAuth = resolve));
      sources[2]!.fail(2);
      timers.fireNextTimeout(); // 8000ms -> sources[3]
      sources[3]!.fail(2);
      timers.fireNextTimeout(); // 15000ms -> sources[4]
      sources[4]!.fail(2);
      timers.fireNextTimeout(); // 15000ms cap -> sources[5]
      expect(timers.scheduledDelays).toEqual([2_000, 4_000, 8_000, 15_000, 15_000]);
      releaseHungAuth({ authenticated: true });
      await flush();
      expect(loggedOut).toBe(0);

      // Reconnecting refreshes missed traffic even if a new live event arrives before the backfill resolves.
      const trafficBeforeOpen = trafficResolvers.length;
      sources[5]!.open();
      expect(trafficResolvers.length).toBe(trafficBeforeOpen + 1);
      sources[5]!.emit({ type: "traffic", event: trafficEvent(5) });
      trafficResolvers.at(-1)!([trafficEvent(1), trafficEvent(2), trafficEvent(3), trafficEvent(4), trafficEvent(5)]);
      await flush();
      expect(eventIds(currentTraffic)).toEqual([1, 2, 3, 4, 5]);

      // Stale callbacks (onopen, onmessage, onerror) from replaced sources are ignored.
      const onlineBeforeStale = onlineStates.length;
      sources[0]!.open();
      sources[0]!.emit({ type: "overview", overview: overview("from-closed-source") });
      sources[0]!.fail(2);
      expect(onlineStates.length).toBe(onlineBeforeStale);
      expect(overviews).not.toContain("from-closed-source");

      // Confirmed authenticated CLOSED stream refreshes overview and restarts at initial 2s backoff.
      authImpl = async () => ({ authenticated: true });
      const overviewCountBeforeClose = overviewResolvers.length;
      sources[5]!.fail(2);
      await flush();
      expect(overviewResolvers.length).toBeGreaterThan(overviewCountBeforeClose);
      expect(timers.scheduledDelays.at(-1)).toBe(2_000);
    } finally {
      stop();
    }
    expect(timers.intervals.size).toBe(0);
    expect(timers.timeouts.size).toBe(0);
  });

  test("stops polling and reconnecting on explicit authenticated:false, and stop() ignores late auth responses", async () => {
    const timers = new FakeTimers();
    const sources: FakeEventSource[] = [];
    let loggedOut = 0;
    let resolveAuth!: (value: { authenticated?: boolean }) => void;

    const stop = startLiveStream({
      createEventSource: () => {
        const source = new FakeEventSource();
        sources.push(source);
        return source;
      },
      fetchAuth: () => new Promise((resolve) => (resolveAuth = resolve)),
      fetchOverview: async () => overview("v1"),
      fetchTraffic: async () => [],
      onOverview: () => {},
      onTrafficSnapshot: () => {},
      onTrafficEvent: () => {},
      onOnline: () => {},
      onLoggedOut: () => {
        loggedOut++;
      },
      timers: timers.api,
    });

    sources[0]!.fail(2);
    expect(timers.timeouts.size).toBe(1);
    resolveAuth({ authenticated: false });
    await flush();
    expect(loggedOut).toBe(1);
    expect(timers.intervals.size).toBe(0);
    expect(timers.timeouts.size).toBe(0);
    stop();

    // Unmounting while an auth probe and retry timer are pending cleans up and ignores the late response.
    const timers2 = new FakeTimers();
    const sources2: FakeEventSource[] = [];
    let loggedOut2 = 0;
    let resolveLateAuth!: (value: { authenticated?: boolean }) => void;
    const stop2 = startLiveStream({
      createEventSource: () => {
        const source = new FakeEventSource();
        sources2.push(source);
        return source;
      },
      fetchAuth: () => new Promise((resolve) => (resolveLateAuth = resolve)),
      fetchOverview: async () => overview("v1"),
      fetchTraffic: async () => [],
      onOverview: () => {},
      onTrafficSnapshot: () => {},
      onTrafficEvent: () => {},
      onOnline: () => {},
      onLoggedOut: () => {
        loggedOut2++;
      },
      timers: timers2.api,
    });
    sources2[0]!.fail(2);
    expect(timers2.timeouts.size).toBe(1);
    stop2();
    expect(timers2.timeouts.size).toBe(0);
    expect(timers2.intervals.size).toBe(0);
    resolveLateAuth({ authenticated: false });
    await flush();
    expect(loggedOut2).toBe(0);
  });
});
