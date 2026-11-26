import type { LiveMessage, Overview, TrafficEvent } from "@vmbridge/contracts";

export interface LiveEventSource {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  close(): void;
}

export interface LiveStreamTimers {
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  setInterval: (callback: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
}

export interface LiveStreamOptions {
  createEventSource: () => LiveEventSource;
  fetchAuth: () => Promise<{ authenticated?: boolean }>;
  fetchOverview: () => Promise<Overview>;
  fetchTraffic: () => Promise<TrafficEvent[]>;
  onOverview: (overview: Overview) => void;
  onTrafficSnapshot: (events: TrafficEvent[]) => void;
  onTrafficEvent: (event: TrafficEvent) => void;
  onOnline: (online: boolean) => void;
  onLoggedOut: () => void;
  pollIntervalMs?: number;
  initialRetryDelayMs?: number;
  maxRetryDelayMs?: number;
  timers?: LiveStreamTimers;
}

const eventSourceClosed = 2;

const defaultTimers: LiveStreamTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

function isOverviewPayload(value: unknown): value is Overview {
  if (!value || typeof value !== "object") return false;
  const bridge = (value as { bridge?: unknown }).bridge;
  return Boolean(bridge && typeof bridge === "object" && typeof (bridge as { version?: unknown }).version === "string");
}

function isTrafficEventPayload(value: unknown): value is TrafficEvent {
  return Boolean(value && typeof value === "object" && typeof (value as { kind?: unknown }).kind === "string");
}

function parseLiveMessage(raw: unknown): LiveMessage | null {
  if (typeof raw !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const candidate = parsed as { type?: unknown; overview?: unknown; event?: unknown };
  if (candidate.type === "overview" && isOverviewPayload(candidate.overview)) {
    return { type: "overview", overview: candidate.overview };
  }
  if (candidate.type === "traffic" && isTrafficEventPayload(candidate.event)) {
    return { type: "traffic", event: candidate.event };
  }
  return null;
}

function eventKey(event: TrafficEvent): string {
  const id = (event as { id?: unknown }).id;
  if (typeof id === "string" || typeof id === "number") return `id:${id}`;
  return JSON.stringify(event);
}

/** Keeps live events that arrived while `/traffic` was in flight without duplicating ones already in the snapshot. */
function mergeTrafficSnapshot(snapshot: TrafficEvent[], buffered: TrafficEvent[]): TrafficEvent[] {
  if (buffered.length === 0) return snapshot;
  const seen = new Set(snapshot.map(eventKey));
  const merged = [...snapshot];
  for (const event of buffered) {
    const key = eventKey(event);
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(event);
    }
  }
  return merged;
}

/**
 * Maintains the dashboard's live event stream, falling back to polling while disconnected and
 * reconnecting with backoff when a proxy error (such as 502/503 during a restart) closes EventSource.
 */
export function startLiveStream(options: LiveStreamOptions): () => void {
  const pollIntervalMs = options.pollIntervalMs ?? 5_000;
  const initialRetryDelayMs = options.initialRetryDelayMs ?? 2_000;
  const maxRetryDelayMs = options.maxRetryDelayMs ?? 15_000;
  const timers = options.timers ?? defaultTimers;

  let stopped = false;
  let polling: unknown = null;
  let retryTimer: unknown = null;
  let source: LiveEventSource | null = null;
  let retryDelayMs = initialRetryDelayMs;
  let authProbeInFlight = false;
  let overviewGeneration = 0;
  let overviewRequestSeq = 0;
  let appliedOverviewSeq = 0;
  let trafficRequestSeq = 0;
  let appliedTrafficSeq = 0;
  const pendingTrafficRequests = new Map<number, TrafficEvent[]>();
  let connectedOnce = false;

  const loadTraffic = () => {
    const id = ++trafficRequestSeq;
    pendingTrafficRequests.set(id, []);
    void options.fetchTraffic().then(
      (recent) => {
        const buffered = pendingTrafficRequests.get(id) ?? [];
        pendingTrafficRequests.delete(id);
        if (stopped || id <= appliedTrafficSeq) return;
        appliedTrafficSeq = id;
        options.onTrafficSnapshot(mergeTrafficSnapshot(recent, buffered));
      },
      () => {
        pendingTrafficRequests.delete(id);
      },
    );
  };

  const loadOverview = () => {
    const requestId = ++overviewRequestSeq;
    const generation = overviewGeneration;
    void options.fetchOverview().then(
      (next) => {
        if (stopped || requestId <= appliedOverviewSeq || overviewGeneration !== generation) return;
        appliedOverviewSeq = requestId;
        options.onOverview(next);
      },
      () => {},
    );
  };

  const stopPolling = () => {
    if (polling === null) return;
    timers.clearInterval(polling);
    polling = null;
  };

  const startPolling = () => {
    if (polling !== null || stopped) return;
    polling = timers.setInterval(() => {
      loadTraffic();
      loadOverview();
    }, pollIntervalMs);
  };

  const clearRetry = () => {
    if (retryTimer === null) return;
    timers.clearTimeout(retryTimer);
    retryTimer = null;
  };

  const stopAll = () => {
    stopped = true;
    stopPolling();
    clearRetry();
    pendingTrafficRequests.clear();
    source?.close();
    source = null;
  };

  const scheduleReconnect = () => {
    if (stopped || retryTimer !== null) return;
    const delay = retryDelayMs;
    retryDelayMs = Math.min(retryDelayMs * 2, maxRetryDelayMs);
    retryTimer = timers.setTimeout(() => {
      retryTimer = null;
      if (!stopped) connect();
    }, delay);
  };

  const probeAuth = () => {
    if (stopped || authProbeInFlight) return;
    authProbeInFlight = true;
    void options.fetchAuth().then(
      (auth) => {
        authProbeInFlight = false;
        if (stopped) return;
        // Only an explicit false means the session ended; empty/malformed proxy bodies stay transient.
        if (auth && auth.authenticated === false) {
          stopAll();
          options.onLoggedOut();
          return;
        }
        if (auth && auth.authenticated === true) {
          loadTraffic();
          loadOverview();
        }
      },
      () => {
        authProbeInFlight = false;
      },
    );
  };

  const connect = () => {
    if (stopped) return;
    clearRetry();
    source?.close();
    const next = options.createEventSource();
    source = next;

    next.onopen = () => {
      if (stopped || source !== next) return;
      retryDelayMs = initialRetryDelayMs;
      options.onOnline(true);
      if (connectedOnce) loadTraffic();
      connectedOnce = true;
    };

    next.onmessage = (event) => {
      if (stopped || source !== next) return;
      const live = parseLiveMessage(event.data);
      if (!live) return;
      retryDelayMs = initialRetryDelayMs;
      options.onOnline(true);
      stopPolling();
      if (live.type === "overview") {
        overviewGeneration++;
        options.onOverview(live.overview);
      } else {
        for (const buffered of pendingTrafficRequests.values()) buffered.push(live.event);
        options.onTrafficEvent(live.event);
      }
    };

    next.onerror = () => {
      if (stopped || source !== next) return;
      options.onOnline(false);
      startPolling();
      // Only intervene once EventSource gives up; browsers auto-retry while CONNECTING.
      if (next.readyState !== eventSourceClosed) return;
      next.close();
      source = null;
      scheduleReconnect();
      probeAuth();
    };
  };

  loadTraffic();
  loadOverview();
  startPolling();
  connect();

  return stopAll;
}
