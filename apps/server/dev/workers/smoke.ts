/**
 * Checks a running VM Bridge Worker the way the dashboard and a T3 client use it: logs in, pairs a device, opens the
 * T3 WebSocket and asks for the server config, opens a preview stream and uploads a file. Prints no secret. Used by
 * run.ts and against a real deploy:
 *
 *   VMBRIDGE_PASSWORD=... bun apps/server/dev/workers/smoke.ts https://vmbridge.example.workers.dev
 */

export interface Paired {
  accessToken: string;
}

const tokenExchange = {
  grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
  subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
  requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
};

function check(ok: boolean, what: string) {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) throw new Error(`Failed: ${what}`);
}

export async function login(base: string, password: string) {
  const post = (key: string) =>
    fetch(`${base}/admin/api/login`, { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify({ key }) });
  check((await post("not the password")).status === 401, "a wrong password is refused");
  const response = await post(password);
  check(response.ok, "the password logs in");
  check(Boolean(response.headers.get("content-security-policy")), "the API sends security headers");
  return response.headers.get("set-cookie")!.split(";")[0]!;
}

export async function pair(base: string, cookie: string): Promise<Paired> {
  const admin = (path: string, body?: unknown) =>
    fetch(`${base}/admin/api${path}`, {
      method: body ? "POST" : "GET",
      headers: { cookie, origin: base, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  const network = (await (await admin("/network")).json()) as { platform: string; addresses: { url: string }[] };
  check(network.platform === "workers" && network.addresses.length === 1 && network.addresses[0]!.url === base, "the only address is the Worker's own");
  const pairing = (await (await admin("/pairing", { name: "smoke test" })).json()) as { urls: { url: string }[] };
  const link = pairing.urls[0]?.url ?? "";
  check(link.startsWith(`${base}/pair#token=`), "the pairing link uses the Worker's address");
  const exchanged = await fetch(`${base}/oauth/token`, {
    method: "POST",
    body: new URLSearchParams({ ...tokenExchange, subject_token: link.split("#token=")[1]! }),
  });
  const { access_token: accessToken } = (await exchanged.json()) as { access_token?: string };
  check(exchanged.ok && Boolean(accessToken), "the pairing token becomes a device session");
  return { accessToken: accessToken! };
}

/** Opens the T3 socket and returns the first reply to each frame sent. */
export async function rpc(base: string, device: Paired, frames: unknown[]) {
  const ticketResponse = await fetch(`${base}/api/auth/websocket-ticket`, { method: "POST", headers: { authorization: `Bearer ${device.accessToken}` } });
  const { ticket } = (await ticketResponse.json()) as { ticket: string };
  check(ticketResponse.ok && Boolean(ticket), "the device gets a WebSocket ticket");
  const url = new URL(`/ws?orchestrationProtocol=2&wsTicket=${encodeURIComponent(ticket)}`, base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url);
  const replies: Record<string, unknown>[] = [];
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("No answer on the T3 socket within 20 s")), 20_000);
    socket.onopen = () => {
      for (const frame of frames) socket.send(JSON.stringify(frame));
    };
    socket.onmessage = (event) => {
      replies.push(JSON.parse(String(event.data)) as Record<string, unknown>);
      if (replies.length >= frames.length) {
        clearTimeout(timer);
        resolve();
      }
    };
    socket.onerror = () => reject(new Error("The T3 socket failed"));
  });
  socket.close();
  return replies;
}

/** Opens a preview tab's stream for a thread no VM has, which VM Bridge accepts and closes as T3 closes a gone tab. */
export async function previewStream(base: string, device: Paired) {
  const ticketResponse = await fetch(`${base}/api/auth/websocket-ticket/media`, { method: "POST", headers: { authorization: `Bearer ${device.accessToken}` } });
  const { ticket } = (await ticketResponse.json()) as { ticket: string };
  check(ticketResponse.ok && Boolean(ticket), "the device gets a media ticket");
  const url = new URL(`/api/preview-stream/ws?threadId=none&tabId=none&wsTicket=${encodeURIComponent(ticket)}`, base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url);
  const code = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The preview stream did not close within 20 s")), 20_000);
    socket.onclose = (event) => {
      clearTimeout(timer);
      resolve(event.code);
    };
  });
  check(code === 4404, "a preview stream for a tab no VM has closes as a gone tab");
}

/** Uploads a file larger than one stored chunk and reads it back, as a client checks an upload it holds. */
export async function upload(base: string, device: Paired) {
  const file = Uint8Array.from({ length: 2.5 * 1024 * 1024 }, (_, index) => index % 251);
  const exitValue = (reply: Record<string, unknown> | undefined) => (reply?.exit as { value?: Record<string, string> } | undefined)?.value;
  const [minted] = await rpc(base, device, [
    { _tag: "Request", id: "1", tag: "attachments.createUploadUrl", payload: { type: "file", name: "big.bin", mimeType: "application/octet-stream", sizeBytes: file.byteLength } },
  ]);
  const slot = exitValue(minted);
  check(Boolean(slot?.relativeUrl?.startsWith("/api/attachments/upload/")), "an upload URL points at the Worker");
  const sent = await fetch(new URL(slot!.relativeUrl!, base), { method: "POST", body: file, headers: { "content-type": "application/octet-stream" } });
  check(sent.status === 204, "the Worker takes the upload");
  const [asset] = await rpc(base, device, [
    { _tag: "Request", id: "1", tag: "assets.createUrl", payload: { resource: { _tag: "attachment", attachmentId: slot!.attachmentId } } },
  ]);
  const read = await fetch(new URL(exitValue(asset)!.relativeUrl!, base));
  const back = new Uint8Array(await read.arrayBuffer());
  check(read.ok && back.byteLength === file.byteLength && back.every((byte, index) => byte === file[index]), "the upload reads back whole");
}

export async function smoke(base: string, password: string) {
  const cookie = await login(base, password);
  const device = await pair(base, cookie);
  const replies = await rpc(base, device, [{ _tag: "Ping" }, { _tag: "Request", id: "1", tag: "server.probe", payload: {} }]);
  check(replies.some((reply) => reply._tag === "Pong"), "the T3 socket answers a ping");
  check(replies.some((reply) => reply._tag === "Exit" && reply.requestId === "1"), "the T3 socket answers an RPC request");
  await previewStream(base, device);
  await upload(base, device);
  return { cookie, device };
}

if (import.meta.main) {
  const base = process.argv[2];
  const password = process.env.VMBRIDGE_PASSWORD;
  if (!base || !password) throw new Error("Usage: VMBRIDGE_PASSWORD=... bun smoke.ts <url>");
  await smoke(base.replace(/\/$/, ""), password);
}
