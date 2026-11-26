import type { LiveMessage, Overview, TrafficEvent } from "@vmbridge/contracts";

export interface AdminEventsDeps {
  traffic: { subscribe(listener: (event: TrafficEvent) => void): () => void };
  fleet: { on(event: "changed", listener: () => void): unknown; off(event: "changed", listener: () => void): unknown };
  hub: { on(event: "shell", listener: () => void): unknown; off(event: "shell", listener: () => void): unknown };
  auth: { watch(request: Request, ended: () => void): () => void };
  overview: () => Overview;
}

const sseHeaders = {
  "content-type": "text/event-stream",
  "cache-control": "no-store",
  connection: "keep-alive",
};

const encoder = new TextEncoder();
const ping = encoder.encode(": ping\n\n");

/** Server-sent events: every traffic event, and a fresh overview whenever the fleet changes. */
export function adminEvents(request: Request, { traffic, fleet, hub, auth, overview }: AdminEventsDeps): Response {
  if (request.signal.aborted) {
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => controller.close(),
    });
    return new Response(stream, { headers: sseHeaders });
  }

  const initial = overview();
  let cleanup = () => {};
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      const close = () => {
        if (closed) return;
        closed = true;
        cleanup();
        try {
          controller.close();
        } catch {
          // The stream controller was already closed or errored by the runtime.
        }
      };
      const enqueue = (chunk: Uint8Array) => {
        if (closed) return;
        try {
          controller.enqueue(chunk);
        } catch {
          close();
        }
      };
      const send = (live: LiveMessage) => enqueue(encoder.encode(`data: ${JSON.stringify(live)}\n\n`));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const changed = () => {
        if (closed) return;
        timer ??= setTimeout(() => {
          timer = undefined;
          if (closed) return;
          try {
            send({ type: "overview", overview: overview() });
          } catch {
            close();
          }
        }, 200);
      };
      const unsubscribe = traffic.subscribe((event) => send({ type: "traffic", event }));
      const heartbeat = setInterval(() => enqueue(ping), 25_000);
      fleet.on("changed", changed);
      hub.on("shell", changed);
      let unwatch = () => {};
      cleanup = () => {
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
        clearInterval(heartbeat);
        unsubscribe();
        const stopWatch = unwatch;
        unwatch = () => {};
        stopWatch();
        fleet.off("changed", changed);
        hub.off("shell", changed);
        request.signal.removeEventListener("abort", close);
      };
      request.signal.addEventListener("abort", close);
      // The cookie was checked when the stream opened. Stop sending once that session ends.
      unwatch = auth.watch(request, close);
      if (closed) {
        unwatch();
        return;
      }
      send({ type: "overview", overview: initial });
    },
    cancel: () => {
      if (closed) return;
      closed = true;
      cleanup();
    },
  });
  return new Response(stream, { headers: sseHeaders });
}
