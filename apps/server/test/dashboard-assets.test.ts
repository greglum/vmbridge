import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetUrl } from "../src/bun/dashboard.ts";
import { openDatabase } from "../src/bun/sqlite.ts";
import { databasePath, start } from "../src/index.ts";
import { Settings } from "../src/settings.ts";

let dir: string;
let bridge: Awaited<ReturnType<typeof start>>;
const path = process.env.PATH;
const dev = process.env.VMBRIDGE_DEV;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "vmbridge-dashboard-assets-"));
  // A stand-in cloudflared that marks when it started, so the tunnel listener is open, and waits to be stopped.
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "cloudflared"), `#!/bin/sh\ntouch "$(dirname "$0")/started"\nexec sleep 30\n`);
  chmodSync(join(bin, "cloudflared"), 0o755);
  process.env.PATH = `${bin}:${path}`;
  // Force production mode (development: false) so start() serves the dashboard through the asset proxy.
  process.env.VMBRIDGE_DEV = "0";
  const db = openDatabase(databasePath(dir));
  new Settings(db).set("cloudflareTunnel", { enabled: true, hostname: null, port: null });
  db.close();
  bridge = await start({ dir, host: "127.0.0.1", port: 0 });
  while (!existsSync(join(bin, "started"))) await Bun.sleep(20);
});

afterAll(async () => {
  process.env.PATH = path;
  if (dev === undefined) delete process.env.VMBRIDGE_DEV;
  else process.env.VMBRIDGE_DEV = dev;
  await bridge.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("the tunnel listener serves the dashboard's files before anyone opened the page through it", async () => {
  const main = `http://127.0.0.1:${bridge.port}`;
  const page = await (await fetch(`${main}/dashboard`)).text();
  const files = [...page.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((match) => match[1]!);
  const script = files.find((file) => file.endsWith(".js"));
  expect(script).toBeDefined();
  // Icons, like the agent and provider logos, are referenced from the script rather than the page.
  const code = await (await fetch(`${main}${script}`)).text();
  const icons = [...new Set([...code.matchAll(/"(\/[\w.-]+\.(?:svg|png))"/g)].map((match) => match[1]!))];
  expect(icons.length).toBeGreaterThan(0);

  const tunnel = `http://127.0.0.1:${(await bridge.network()).cloudflare.port}`;
  for (const file of [...files, ...icons]) {
    const response = await fetch(`${tunnel}${file}`);
    expect({ file, status: response.status }).toEqual({ file, status: 200 });
  }
});

/** Sends an HTTP/1.1 request verbatim so client URL normalization does not rewrite `//`, `/\`, or `/.//`. */
function rawRequest(port: number, method: "GET" | "HEAD", requestTarget: string): Promise<{ status: number; headers: Map<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port }, () => {
      socket.write(`${method} ${requestTarget} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    });
    let raw = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      raw += chunk;
    });
    socket.on("error", reject);
    socket.on("end", () => {
      const split = raw.indexOf("\r\n\r\n");
      const head = split === -1 ? raw : raw.slice(0, split);
      const body = split === -1 ? "" : raw.slice(split + 4);
      const [statusLine, ...headerLines] = head.split("\r\n");
      const status = Number(statusLine?.split(" ")[1] ?? 0);
      const headers = new Map<string, string>();
      for (const line of headerLines) {
        const idx = line.indexOf(":");
        if (idx !== -1) headers.set(line.slice(0, idx).toLowerCase(), line.slice(idx + 1).trim());
      }
      resolve({ status, headers, body });
    });
  });
}

test("dashboard asset proxy rejects protocol-relative paths without hitting another origin", async () => {
  expect(process.env.VMBRIDGE_DEV).toBe("0");
  // Prove assetUrl rejects protocol-relative paths directly before fetch() is ever called.
  const base = new URL("http://127.0.0.1:3000/");
  expect(assetUrl("http://127.0.0.1:3000/dashboard", base)?.href).toBe("http://127.0.0.1:3000/dashboard");
  expect(assetUrl("http://127.0.0.1:3000//dashboard", base)).toBeNull();
  expect(assetUrl("http://127.0.0.1:3000/.//dashboard", base)).toBeNull();
  expect(assetUrl("http://127.0.0.1:3000//127.0.0.1:9999/secret", base)).toBeNull();
  let hits = 0;
  const dummy = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      hits += 1;
      return new Response("internal-secret", { status: 200 });
    },
  });
  try {
    // Confirm the production asset proxy serves /dashboard with security headers.
    const normal = await fetch(`http://127.0.0.1:${bridge.port}/dashboard`);
    expect(normal.status).toBe(200);
    expect(normal.headers.get("x-frame-options")).toBe("DENY");
    expect(normal.headers.get("x-content-type-options")).toBe("nosniff");

    const cases: Array<{ method: "GET" | "HEAD"; target: string }> = [
      { method: "GET", target: `//127.0.0.1:${dummy.port}/secret` },
      { method: "GET", target: `//127.0.0.1:${dummy.port}/secret?q=1` },
      { method: "HEAD", target: `//127.0.0.1:${dummy.port}/secret` },
      { method: "GET", target: `/\\127.0.0.1:${dummy.port}/secret` },
      { method: "HEAD", target: `/\\127.0.0.1:${dummy.port}/secret` },
      { method: "GET", target: `/.//127.0.0.1:${dummy.port}/secret` },
      { method: "HEAD", target: `/.//127.0.0.1:${dummy.port}/secret` },
      // Matches an existing asset path, proving the explicit // guard rejects it rather than an ordinary asset miss.
      { method: "GET", target: "//dashboard" },
      { method: "HEAD", target: "//dashboard" },
      { method: "GET", target: "/.//dashboard" },
    ];
    for (const { method, target } of cases) {
      const res = await rawRequest(bridge.port, method, target);
      expect({ method, target, status: res.status }).toEqual({ method, target, status: 404 });
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.body).not.toContain("internal-secret");
      if (method === "HEAD") expect(res.body).toBe("");
    }

    const fetchRes = await fetch(`http://127.0.0.1:${bridge.port}//127.0.0.1:${dummy.port}/secret`);
    expect(fetchRes.status).toBe(404);
    expect(fetchRes.headers.get("x-frame-options")).toBe("DENY");
    expect(hits).toBe(0);
  } finally {
    await dummy.stop(true);
  }
});
