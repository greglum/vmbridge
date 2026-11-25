import type { Clients } from "../auth/clients.ts";
import { clientSessionMs } from "../auth/clients.ts";
import { message } from "../fleet.ts";
import type { Frame } from "../vm/backend.ts";
import type { WatchUpgrade } from "../watch/watch.ts";
import { assetPrefix, bridgeAssetUrl, heldOwner, relayedAsset, uploadPrefix } from "./attachments.ts";
import { bridgeAuth, bridgeScopes, type Hub } from "./hub.ts";
import { previewQuery, previewRelay, previewStreamPath } from "./preview.ts";
import type { Rpc, RpcClient } from "./rpc.ts";
import type { Projection, Wire } from "./types.ts";

export interface SocketData {
  clientId: string;
  cancels: Map<string, () => void>;
}

/** A connected T3 client: Bun's ServerWebSocket, or a Worker's WebSocket with its data beside it. */
export interface ClientSocket {
  readonly data: SocketData;
  readonly readyState: number;
  send(message: string): unknown;
  close(code?: number, reason?: string): void;
}

/**
 * Accepts a `/ws` upgrade with `data` for the new socket, which then reports to `opened`, `received` and `closed`.
 * Returns the response to send, undefined when the runtime answers the upgrade itself (Bun), or null when the request
 * is not a WebSocket upgrade.
 */
export type Upgrade = (request: Request, data: SocketData) => Response | undefined | null;

const open = 1;

const json = (value: unknown, status = 200) => Response.json(value, { status });
const notFound = () => new Response("Not Found", { status: 404 });
const unauthenticated = () => json({ code: "auth_invalid", reason: "invalid_credential", traceId: crypto.randomUUID() }, 401);

const tokenExchange = {
  grant: "urn:ietf:params:oauth:grant-type:token-exchange",
  subject: "urn:t3:params:oauth:token-type:environment-bootstrap",
  requested: "urn:ietf:params:oauth:token-type:access_token",
};

/** Paths a T3 client uses. Everything else belongs to the dashboard. */
export const isT3Path = (path: string) => path === "/ws" || path === "/oauth/token" || path.startsWith("/api/") || path.startsWith("/.well-known/t3/");

/**
 * The T3 server surface VM Bridge exposes: pairing, bearer sessions, the RPC WebSocket, and the
 * few HTTP reads T3 makes outside RPC. T3 routes use bearer tokens only, never cookies, so any
 * origin may call them; the hosted and desktop T3 apps come from origins VM Bridge cannot list.
 */
export class T3Gateway {
  private readonly sockets = new Set<ClientSocket>();
  /** Open preview streams, which end with their device's access like its RPC sockets. */
  private readonly streams = new Set<{ clientId: string; end: (code: number, reason: string) => void }>();
  private readonly expiry: ReturnType<typeof setInterval>;

  constructor(
    private readonly hub: Hub,
    private readonly rpc: Rpc,
    private readonly clients: Clients,
  ) {
    this.expiry = setInterval(() => {
      for (const socket of this.sockets) if (!clients.valid(socket.data.clientId)) socket.close(1008, "Session expired");
      for (const stream of this.streams) if (!clients.valid(stream.clientId)) stream.end(1008, "Session expired");
    }, 30_000);
  }

  connected(): Set<string> {
    return new Set([...this.sockets].map((socket) => socket.data.clientId));
  }

  /** Ends a revoked device's open connections. */
  disconnect(clientId: string) {
    for (const socket of this.sockets) if (socket.data.clientId === clientId) socket.close(1008, "Device removed");
    for (const stream of this.streams) if (stream.clientId === clientId) stream.end(1008, "Device removed");
  }

  /** `upgrade` accepts the RPC WebSocket, and `relay` a preview tab's stream. */
  async fetch(request: Request, upgrade: Upgrade, relay: WatchUpgrade): Promise<Response | undefined> {
    const origin = request.headers.get("origin");
    const started = performance.now();
    const path = new URL(request.url).pathname;
    const seen: { clientId?: string } = {};
    const response = await this.route(request, upgrade, relay, seen).catch((error) =>
      json({ error: "bridge_unavailable", message: message(error) }, 503),
    );
    if (!response) return undefined;
    // T3's desktop app strips `Origin` from its requests but its renderer still checks the answer, so a request with no
    // `Origin` gets the wildcard, as T3's own server sends. Nothing here is sent with cookies, so `*` is enough.
    response.headers.set("access-control-allow-origin", origin ?? "*");
    response.headers.set("vary", "Origin");
    // Assets keep the caching T3 gives them: their URLs are signed anew for each new copy.
    if (!response.headers.has("cache-control")) response.headers.set("cache-control", "no-store");
    if (!seen.clientId) {
      // Anyone can send these, so failures are only counted. Pairing logs itself; discovery and preflights are not worth a line.
      if (!response.ok) this.hub.traffic.refused();
    } else if (path !== "/api/auth/session") {
      this.hub.traffic.record({
        kind: "http",
        // An upload URL's token is what lets anyone send the file.
        operation: `${request.method} ${path.replace(/\/threads\/[^/]+/, "/threads/:id").replace(/^\/api\/attachments\/upload\/.+/, `${uploadPrefix}:token`)}`,
        clientId: seen.clientId,
        status: response.ok ? "ok" : "error",
        durationMs: Math.round(performance.now() - started),
      });
    }
    return response;
  }

  private async route(request: Request, upgrade: Upgrade, relay: WatchUpgrade, seen: { clientId?: string }): Promise<Response | undefined> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "authorization, content-type, x-t3-orchestration-protocol, b3, traceparent, dpop",
        },
      });
    }
    if (path === "/.well-known/t3/environment" && request.method === "GET") return json(this.hub.descriptor());
    if (path === "/oauth/token" && request.method === "POST") return this.exchange(request);
    if (path === "/ws") {
      if (url.searchParams.get("orchestrationProtocol") !== "2") {
        return json({ code: "orchestration_protocol_incompatible", orchestrationProtocolVersion: 2 }, 426);
      }
      const clientId = this.clients.redeemTicket(url.searchParams.get("wsTicket") ?? "");
      if (!clientId) return unauthenticated();
      const upgraded = upgrade(request, { clientId, cancels: new Map() });
      return upgraded === null ? json({ error: "websocket_required" }, 400) : upgraded;
    }
    if (path === previewStreamPath) return this.previewStream(request, url, relay);
    // Signed URLs, as on T3: the token in the path is the credential, and clients send no bearer with them.
    if (path.startsWith(uploadPrefix) && request.method === "POST") return this.upload(request, path.slice(uploadPrefix.length), seen);
    const asset = bridgeAssetUrl.exec(path);
    if (asset && (request.method === "GET" || request.method === "HEAD")) return this.asset(request, asset[1]!, asset[2]!, asset[3]!);

    const bearer = request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
    const client = bearer ? this.clients.authenticate(bearer) : null;
    if (path === "/api/auth/session") {
      return json({
        authenticated: Boolean(client),
        auth: bridgeAuth,
        ...(client
          ? {
              scopes: bridgeScopes,
              permissions: bridgeScopes,
              sessionMethod: "bearer-access-token",
              expiresAt: new Date(client.expiresAt).toISOString(),
            }
          : {}),
      });
    }
    if (!client) return unauthenticated();
    seen.clientId = client.id;

    const ticketFor = /^\/api\/auth\/websocket-ticket(?:\/(rpc|media))?$/.exec(path);
    if (ticketFor && request.method === "POST") {
      const { ticket, expiresAt } = this.clients.ticket(client.id, ticketFor[1] === "media" ? "media" : "rpc");
      return json({ ticket, expiresAt: new Date(expiresAt).toISOString() });
    }
    if (path === "/api/orchestration/shell" && request.method === "GET") return json(this.hub.shell());
    if (path === "/api/projects" && request.method === "GET") {
      const projects = (this.hub.shell().projects ?? []).map((project) => ({ ...project, deletedAt: null }));
      return json({ projects, updatedAt: new Date().toISOString() });
    }
    const thread = /^\/api\/orchestration\/threads\/([^/]+)(?:\/(bounded|history|transcript))?$/.exec(path);
    if (thread && request.method === "GET") return this.thread(decodeURIComponent(thread[1]!), thread[2], url);
    return json({ error: "unsupported_bridge_route" }, 404);
  }

  /**
   * A preview tab's stream, relayed to the T3 server on the VM that owns the tab's thread and no other: a tab exists
   * only on its thread's VM. A VM that is not awake has no tabs, which the client hears as a closed tab.
   */
  private previewStream(request: Request, url: URL, relay: WatchUpgrade) {
    const clientId = this.clients.redeemTicket(url.searchParams.get("wsTicket") ?? "", "media");
    if (!clientId) return unauthenticated();
    const query = previewQuery(url);
    const stream = {
      clientId,
      ...previewRelay(
        async () => {
          const vmId = this.hub.store.threadVm(query.get("threadId") ?? "");
          const backend = vmId ? this.hub.fleet.backend(vmId) : undefined;
          return backend ? backend.media(previewStreamPath, query) : null;
        },
        () => this.streams.delete(stream),
      ),
    };
    this.streams.add(stream);
    const upgraded = relay(request, stream.viewer);
    if (upgraded !== null) return upgraded;
    this.streams.delete(stream);
    return json({ error: "websocket_required" }, 400);
  }

  private async upload(request: Request, token: string, seen: { clientId?: string }) {
    const { status, clientId } = await this.hub.attachments.receive(token, request);
    if (clientId) seen.clientId = clientId;
    if (status === 204) return new Response(null, { status });
    return status === 400 ? new Response("The upload is not the size it was announced as.", { status }) : notFound();
  }

  /**
   * An asset, from the VM that signed its URL. A VM that is not awake is not woken for it, and the client shows the
   * asset as missing. An upload VM Bridge still holds is served from here, as a download unless it is an image.
   */
  private async asset(request: Request, owner: string, token: string, name: string) {
    if (owner === heldOwner) {
      const file = this.hub.attachments.file(token);
      if (!file) return notFound();
      const image = /^image\/(?:png|jpeg|gif|webp)$/i.test(file.upload.mimeType);
      return new Response(request.method === "HEAD" ? null : file.body, {
        headers: {
          "content-type": image ? file.upload.mimeType : "application/octet-stream",
          ...(image ? {} : { "content-disposition": "attachment" }),
          "content-security-policy": "default-src 'none'; sandbox",
          "x-content-type-options": "nosniff",
        },
      });
    }
    const backend = this.hub.store.vm(owner) ? this.hub.fleet.backend(owner) : undefined;
    if (!backend) return notFound();
    const headers = new Headers();
    for (const header of ["range", "if-range"]) {
      const value = request.headers.get(header);
      if (value !== null) headers.set(header, value);
    }
    const upstream = await backend.http(`${assetPrefix}${token}/${name}`, { method: request.method, headers, signal: AbortSignal.timeout(10 * 60_000) });
    return relayedAsset(upstream);
  }

  private async exchange(request: Request) {
    const body = new URLSearchParams(await request.text());
    if (
      body.get("grant_type") !== tokenExchange.grant ||
      body.get("subject_token_type") !== tokenExchange.subject ||
      body.get("requested_token_type") !== tokenExchange.requested
    ) {
      return json({ error: "unsupported_grant_type" }, 400);
    }
    const access = this.clients.exchange(body.get("subject_token") ?? "");
    if (!access) return json({ error: "invalid_grant" }, 400);
    this.hub.traffic.record({ kind: "system", operation: "Device paired" });
    // The dashboard's device list follows fleet changes.
    this.hub.fleet.emit("changed");
    return json({
      access_token: access,
      issued_token_type: tokenExchange.requested,
      token_type: "Bearer",
      expires_in: clientSessionMs / 1000,
      scope: bridgeScopes.join(" "),
    });
  }

  /** Thread reads: from the VM when it is awake, from the cached transcript while it sleeps. */
  private async thread(threadId: string, view: string | undefined, url: URL) {
    const vmId = await this.hub.routeSoon({ threadId });
    const backend = this.hub.fleet.backend(vmId);
    if (!backend) {
      const cached = this.hub.sleepingProjection(threadId, vmId);
      if (!cached) return json({ error: "vm_sleeping_no_snapshot" }, 503);
      const projection = this.hub.out(cached, vmId) as Projection;
      const snapshotSequence = this.hub.shellSequence(vmId);
      if (view === "transcript") {
        return json({ threadId, title: projection.thread?.title, updatedAt: projection.updatedAt, items: projection.visibleTurnItems ?? [] });
      }
      if (view === "history") return json({ snapshotSequence, items: [], nextCursor: null, hasMoreHistory: false });
      const ordinals = ((projection.runs ?? []) as Wire[]).map((run) => Number(run.ordinal) || 0);
      return json({ projection, snapshotSequence, historyCursor: null, hasMoreHistory: false, latestLocalTurnOrdinal: Math.max(0, ...ordinals) });
    }
    // VM Bridge caches plain projections, so ask the VM for the uncompacted form.
    const query = new URLSearchParams(url.search);
    for (const key of ["compactIds", "compactTurnItems", "dedupeBodies"]) query.delete(key);
    const upstream = await backend.http(`${url.pathname}?${query}`);
    const value = (await upstream.json()) as Wire;
    if (upstream.ok && !view && !value.hasMoreHistory && value.projection) this.hub.cacheProjection(threadId, vmId, value.projection);
    return json(this.hub.out(value, vmId), upstream.status);
  }

  opened(socket: ClientSocket) {
    this.sockets.add(socket);
    this.hub.traffic.record({ kind: "system", operation: "Device connected", clientId: socket.data.clientId });
    this.hub.fleet.emit("changed");
  }

  received(socket: ClientSocket, raw: string) {
    if (!this.clients.valid(socket.data.clientId)) return socket.close(1008, "Session expired");
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      return socket.close(1008, "Invalid JSON");
    }
    const client: RpcClient = {
      clientId: socket.data.clientId,
      cancels: socket.data.cancels,
      send: (frame) => {
        if (socket.readyState === open) socket.send(JSON.stringify(frame));
      },
      open: () => socket.readyState === open && this.clients.valid(socket.data.clientId),
    };
    for (const frame of Array.isArray(decoded) ? decoded : [decoded]) {
      this.rpc.handle(client, frame as Frame).catch(() => socket.close(1008, "Invalid RPC message"));
    }
  }

  closed(socket: ClientSocket) {
    this.sockets.delete(socket);
    for (const cancel of socket.data.cancels.values()) cancel();
    socket.data.cancels.clear();
    this.hub.fleet.emit("changed");
  }

  close() {
    clearInterval(this.expiry);
    for (const socket of this.sockets) socket.close(1001, "VM Bridge stopped");
    for (const stream of this.streams) stream.end(1001, "VM Bridge stopped");
  }
}
