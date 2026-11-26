import { useEffect, useRef, useState } from "react";
import type { Overview, TrafficEvent } from "@vmbridge/contracts";
import { startLiveStream } from "./lib/live-stream.ts";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Listeners told when the session ends, so the app can show the login screen. */
const loggedOut = new Set<() => void>();
export const onLoggedOut = (listener: () => void) => {
  loggedOut.add(listener);
  return () => void loggedOut.delete(listener);
};

export async function api<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(`/admin/api${path}`, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const value = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    // A wrong password, setup link, or /auth probe itself should not trigger a logout refresh loop.
    if (response.status === 401 && path !== "/login" && path !== "/setup" && path !== "/auth") for (const listener of loggedOut) listener();
    throw new ApiError(value.error ?? `Request failed (${response.status}).`, response.status);
  }
  return value;
}

const trafficLimit = 300;

/** The latest `trafficLimit` requests and as many other events, so a burst of requests cannot hide startup or a failure. */
function trimTraffic(events: TrafficEvent[]) {
  let requests = 0;
  let others = 0;
  const kept: TrafficEvent[] = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    const count = event.kind === "rpc" || event.kind === "http" ? ++requests : ++others;
    if (count <= trafficLimit) kept.push(event);
  }
  return kept.reverse();
}

/** The live overview and recent traffic, from the server's event stream. */
export function useLive() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [traffic, setTraffic] = useState<TrafficEvent[]>([]);
  const [online, setOnline] = useState(true);

  // A new version of VM Bridge has a new dashboard, so the page reloads once one is running, as after an update.
  const version = overview?.bridge.version;
  const firstVersion = useRef(version);
  useEffect(() => {
    firstVersion.current ??= version;
    if (version && version !== firstVersion.current) location.reload();
  }, [version]);

  useEffect(() => {
    // Cloudflare's quick tunnels hold event streams back, so until the stream delivers, read the same data every few seconds.
    return startLiveStream({
      createEventSource: () => new EventSource("/admin/api/events"),
      fetchAuth: () => api<{ authenticated: boolean }>("/auth"),
      fetchOverview: () => api<Overview>("/overview"),
      fetchTraffic: () => api<TrafficEvent[]>("/traffic"),
      onOverview: setOverview,
      onTrafficSnapshot: (recent) => setTraffic(trimTraffic(recent)),
      onTrafficEvent: (event) => setTraffic((current) => (current.some((existing) => existing.id === event.id) ? current : trimTraffic([...current, event]))),
      onOnline: setOnline,
      onLoggedOut: () => {
        for (const listener of loggedOut) listener();
      },
    });
  }, []);

  return { overview, traffic, online };
}

/** Re-renders every `ms`, for relative times and decaying request rates. */
export function useTick(ms: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

const clockFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

/** Local wall-clock time with milliseconds, for log rows. */
export function clock(at: number) {
  return `${clockFormat.format(at)}.${String(at % 1000).padStart(3, "0")}`;
}

/** A request duration, readable at a glance. */
export function duration(ms: number) {
  if (ms < 1) return "<1 ms";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

/** Time since `at` as a running clock, such as "42s" or "3m 05s". */
export function elapsed(at: number, now = Date.now()) {
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

export function ago(at: number | null, now = Date.now()) {
  if (!at) return "never";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86_400)} d ago`;
}
