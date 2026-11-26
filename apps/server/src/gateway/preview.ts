import type { Viewer, ViewerSocket } from "../watch/watch.ts";

/** Where T3 clients open a preview tab's stream, on VM Bridge and on each VM's T3 server alike. */
export const previewStreamPath = "/api/preview-stream/ws";

/** The query parameters T3 clients send for a preview stream, and the only ones passed on to the VM. */
const passed = ["threadId", "tabId", "maxWidth", "maxHeight", "quality", "interactive"];

/** T3's close code for a tab that is gone, on which clients stop instead of reconnecting. */
const goneCode = 4404;
/** A client sends a few small inputs before its VM's stream opens; more than this is not a viewer. */
const earlyLimit = 64 * 1024;

export function previewQuery(url: URL) {
  const query = new URLSearchParams();
  for (const key of passed) {
    const value = url.searchParams.get(key);
    if (value !== null) query.set(key, value);
  }
  return query;
}

const payload = (data: unknown) =>
  typeof data === "string" || data instanceof Uint8Array ? data : data instanceof ArrayBuffer ? new Uint8Array(data) : null;

/** A server may close with 1000 or a code from the application range. Others, such as 1006, end as 1011, which T3 clients retry. */
const sendable = (code: number) => code === 1000 || (code >= 3000 && code <= 4999);

/**
 * Relays one T3 client's preview stream to the T3 server on the tab's VM, as T3 sends it: JPEG frames and JSON
 * messages, both ways, with the VM's close codes kept so the client still tells a closed tab from a dropped link.
 * `open` opens the VM's side, or gives null when the VM is not awake, which means its tabs are gone.
 */
export function previewRelay(open: () => Promise<WebSocket | null>, ended: () => void) {
  let client: ViewerSocket | undefined;
  let vm: WebSocket | undefined;
  /** What the client sent before the VM's stream opened. */
  const early: (string | Uint8Array)[] = [];
  let earlyBytes = 0;
  let done = false;
  let closeCode = 1000;
  let closeReason = "";
  const end = (code: number, reason: string) => {
    if (done) return;
    done = true;
    closeCode = code;
    closeReason = reason;
    early.length = 0;
    const activeVm = vm;
    const activeClient = client;
    vm = undefined;
    client = undefined;
    ended();
    activeVm?.close();
    activeClient?.close(code, reason);
  };

  const viewer: Viewer = {
    opened: (socket) => {
      if (done) return socket.close(closeCode, closeReason);
      client = socket;
      let opening: Promise<WebSocket | null>;
      try {
        opening = open();
      } catch {
        return end(1011, "Unavailable");
      }
      opening.then(
        (opened) => {
          if (!opened) return end(goneCode, "tab closed");
          if (done) return opened.close();
          vm = opened;
          // Listeners, not onmessage and onclose, which Workers' WebSocket lacks.
          opened.addEventListener("message", (event: MessageEvent<unknown>) => {
            if (done) return;
            const data = payload(event.data);
            if (data !== null) client?.send(data);
          });
          opened.addEventListener("close", (event: CloseEvent) => end(sendable(event.code) ? event.code : 1011, event.reason));
          opened.addEventListener("error", () => end(1011, "Ended"));
          try {
            for (const data of early.splice(0)) {
              if (done) break;
              opened.send(data);
            }
          } catch {
            end(1011, "Ended");
          }
        },
        // The reason could name the VM's address.
        () => end(1011, "Unavailable"),
      );
    },
    received: (data) => {
      if (done) return;
      const chunk = payload(data);
      if (chunk === null) return;
      if (vm) return vm.send(chunk);
      earlyBytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
      if (earlyBytes > earlyLimit) return end(1008, "Too much before the stream opened");
      early.push(chunk);
    },
    closed: () => {
      client = undefined;
      end(1000, "");
    },
  };
  return { viewer, end };
}
