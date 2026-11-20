import type { TrafficEvent } from "@vmbridge/contracts";

type Listener = (event: TrafficEvent) => void;

/**
 * Request metadata for the dashboard. Never record payloads, tokens, URLs with
 * credentials, or agent output: only operation names, endpoints, and timings.
 */
export class Traffic {
  private nextId = 1;
  private readonly listeners = new Set<Listener>();
  readonly recent: TrafficEvent[] = [];

  record(event: Omit<TrafficEvent, "id" | "at">): void {
    const entry: TrafficEvent = { ...event, id: this.nextId++, at: Date.now() };
    this.recent.push(entry);
    if (this.recent.length > 500) this.recent.shift();
    for (const listener of this.listeners) listener(entry);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
