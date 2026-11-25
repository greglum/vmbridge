import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = join(import.meta.dir, "../src/index.ts");
let dir: string;

afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Starts `vmbridge run` on `port` in `dir`, not in a terminal, and resolves once it says it is running. */
async function launch(port: number, env: Record<string, string> = {}) {
  const child = Bun.spawn(["bun", cli, "run", "--host", "127.0.0.1", "--port", String(port)], {
    // HOME too, so nothing reads this machine's skills or instructions files.
    env: { PATH: process.env.PATH ?? "", HOME: dir, VMBRIDGE_HOME: join(dir, "data"), ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let output = "";
  const decoder = new TextDecoder();
  for await (const chunk of child.stdout) {
    output += decoder.decode(chunk);
    if (output.includes("Press Ctrl+C") || output.includes("No dashboard password yet")) break;
  }
  return { child, output };
}

async function freePort() {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port!;
  await probe.stop();
  return port;
}

/** Runs `vmbridge run` on a free port with a new data folder until it says it is running, then stops it. */
async function run(env: Record<string, string> = {}, prepare = (_data: string) => {}) {
  dir = mkdtempSync(join(tmpdir(), "vmbridge-cli-"));
  prepare(join(dir, "data"));
  const port = await freePort();
  const { child, output } = await launch(port, env);
  const auth = (await (await fetch(`http://127.0.0.1:${port}/admin/api/auth`)).json()) as { hasPassword: boolean };
  child.kill("SIGTERM");
  await child.exited;
  return { output, hasPassword: auth.hasPassword };
}

/** Pairs a device as T3 does and opens its RPC socket. Resolves with the socket once it is open. */
async function connectDevice(base: string, password: string) {
  const json = { "content-type": "application/json", origin: base };
  const login = await fetch(`${base}/admin/api/login`, { method: "POST", headers: json, body: JSON.stringify({ key: password }) });
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const pairing = await fetch(`${base}/admin/api/pairing`, { method: "POST", headers: { ...json, cookie }, body: JSON.stringify({ name: "test" }) });
  const { urls } = (await pairing.json()) as { urls: { url: string }[] };
  const exchange = await fetch(`${base}/oauth/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      subject_token: new URL(urls[0]!.url).hash.replace("#token=", ""),
    }),
  });
  const { access_token: access } = (await exchange.json()) as { access_token: string };
  const ticket = await fetch(`${base}/api/auth/websocket-ticket`, { method: "POST", headers: { authorization: `Bearer ${access}` } });
  const { ticket: value } = (await ticket.json()) as { ticket: string };
  const socket = new WebSocket(`${base.replace("http", "ws")}/ws?orchestrationProtocol=2&wsTicket=${encodeURIComponent(value)}`);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  return socket;
}

test("starts without a password, and keeps the setup code out of output that is not a terminal", async () => {
  const { output, hasPassword } = await run();
  expect(hasPassword).toBe(false);
  expect(output).toContain("is running");
  expect(output).toContain("No dashboard password yet");
  expect(output).not.toContain("#code=");
}, 30_000);

test("still takes the password from VMBRIDGE_PASSWORD", async () => {
  const { output, hasPassword } = await run({ VMBRIDGE_PASSWORD: "from the environment" });
  expect(hasPassword).toBe(true);
  expect(output).toContain("Open the dashboard");
}, 30_000);

test("makes a log an older service left readable private", async () => {
  let log = "";
  await run({}, (data) => {
    mkdirSync(data, { mode: 0o755 });
    log = join(data, "vmbridge.log");
    writeFileSync(log, "", { mode: 0o644 });
  });
  expect(statSync(log).mode & 0o777).toBe(0o600);
  expect(statSync(join(dir, "data")).mode & 0o777).toBe(0o700);
}, 30_000);

test("a new start takes over a running VM Bridge, whose devices are told it is restarting", async () => {
  dir = mkdtempSync(join(tmpdir(), "vmbridge-cli-"));
  const port = await freePort();
  const env = { VMBRIDGE_PASSWORD: "takeover password" };
  const first = await launch(port, env);
  const socket = await connectDevice(`http://127.0.0.1:${port}`, env.VMBRIDGE_PASSWORD);
  const closed = new Promise<CloseEvent>((resolve) => (socket.onclose = resolve));

  const second = await launch(port, env);
  expect(second.output).toContain(`Stopping the VM Bridge already running (process ${first.child.pid})`);
  expect(second.output).toContain("is running");
  const event = await closed;
  expect(event.code).toBe(1012);
  expect(event.reason).toBe("VM Bridge is restarting");
  expect(await first.child.exited).toBe(0);
  expect(readFileSync(join(dir, "data", "vmbridge.pid"), "utf8")).toBe(String(second.child.pid));
  expect((await fetch(`http://127.0.0.1:${port}/admin/api/auth`)).ok).toBe(true);

  second.child.kill("SIGTERM");
  expect(await second.child.exited).toBe(0);
  expect(existsSync(join(dir, "data", "vmbridge.pid"))).toBe(false);
}, 30_000);
