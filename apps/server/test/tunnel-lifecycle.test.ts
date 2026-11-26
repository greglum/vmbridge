import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/bun/sqlite.ts";
import { CloudflareTunnel } from "../src/bun/tunnel.ts";
import { Secrets, Settings } from "../src/settings.ts";
import { Traffic } from "../src/traffic.ts";
import { testEncryption } from "./key.ts";

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "vmbridge-tunnel-lifecycle-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakeCloudflared(dir: string, script: string) {
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "cloudflared"), `#!/bin/sh\n${script}\n`);
  chmodSync(join(bin, "cloudflared"), 0o755);
  return bin;
}

async function waitFor(check: () => boolean, timeoutMs: number, label: string) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function readRawEvents(bin: string): string[] {
  const file = join(bin, "events");
  if (!existsSync(file)) return [];
  const text = readFileSync(file, "utf8").trim();
  return text ? text.split("\n") : [];
}

function readEvents(bin: string): string[] {
  return readRawEvents(bin).map((line) => line.split(":").slice(0, 2).join(":"));
}

const gatedScript = `pidfile=""; prev=""
for arg in "$@"; do [ "$prev" = "--pidfile" ] && pidfile="$arg" && break; prev="$arg"; done
d=$(dirname "$0"); n=$(($(cat "$d/runs" 2>/dev/null || echo 0) + 1)); echo "$n" > "$d/runs"
sp=""
on_term() {
  trap '' TERM
  [ -n "\${sp:-$!}" ] && kill "\${sp:-$!}" 2>/dev/null || true
  if [ "$n" = 1 ]; then
    : > "$d/got_term"
    while [ ! -f "$d/release" ]; do sleep 0.02; done
  fi
  echo "exit:$n:$$" >> "$d/events"
  exit 0
}
trap on_term TERM
echo $$ > "$pidfile"; echo "start:$n:$$" >> "$d/events"
echo "INF |  https://run-$n-tunnel.trycloudflare.com  |" >&2
echo "INF Registered tunnel connection connIndex=0" >&2
sleep 30 >/dev/null 2>&1 & sp=$!; wait "$sp"`;

describe("tunnel lifecycle ordering and serialization", () => {
  function setup(script: string, checkAddress: (url: string, wanted: () => boolean) => Promise<boolean> = async () => true) {
    const dir = tempDir();
    const db = openDatabase(":memory:");
    const settings = new Settings(db);
    const secrets = new Secrets(db, testEncryption);
    const tunnel = new CloudflareTunnel({
      settings,
      secrets,
      traffic: new Traffic(),
      dir,
      home: dir,
      PATH: fakeCloudflared(dir, script),
      fallbacks: [],
      checkAddress,
      listen: async (port) => Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("ok") }),
    });
    return { dir, settings, tunnel };
  }

  test("starts checking a quick tunnel when the banner URL arrives after the connection line", async () => {
    let dir = "";
    const checked: string[] = [];
    const ctx = setup(
      `d=$(dirname "$0")
echo "INF Registered tunnel connection connIndex=0" >&2
sleep 0.05
echo "INF |  https://late-banner-tunnel.trycloudflare.com  |" >&2
while [ ! -f "$d/checked" ]; do sleep 0.02; done
echo "INF Registered tunnel connection connIndex=1" >&2
: > "$d/after-second-conn"
exec sleep 30`,
      async (url) => {
        checked.push(url);
        writeFileSync(join(dir, "bin", "checked"), "");
        return true;
      },
    );
    dir = ctx.dir;
    const { settings, tunnel } = ctx;
    try {
      settings.set("cloudflareTunnel", { enabled: true, hostname: null, port: null });
      await tunnel.apply();
      await tunnel.ready(5_000);
      expect(tunnel.info()).toMatchObject({ mode: "quick", state: "running", url: "https://late-banner-tunnel.trycloudflare.com", error: null });
      await waitFor(() => existsSync(join(dir, "bin", "after-second-conn")), 5_000, "second connection line");
      await Bun.sleep(50);
      expect(checked).toEqual(["https://late-banner-tunnel.trycloudflare.com"]);
    } finally {
      writeFileSync(join(dir, "bin", "checked"), "");
      await tunnel.stop();
    }
  });

  test("overlapping apply waits for a slow-exiting child and preserves the replacement pidfile", async () => {
    const { dir, settings, tunnel } = setup(gatedScript);
    const bin = join(dir, "bin");
    const pidFile = join(dir, "cloudflared", "cloudflared.pid");
    try {
      settings.set("cloudflareTunnel", { enabled: true, hostname: null, port: null });
      await tunnel.apply();
      await tunnel.ready(5_000);
      expect(tunnel.info()).toMatchObject({ mode: "quick", state: "running", url: "https://run-1-tunnel.trycloudflare.com" });

      const first = tunnel.apply();
      await waitFor(() => existsSync(join(bin, "got_term")), 5_000, "child 1 SIGTERM");

      let secondSettled = false;
      const second = tunnel.apply().finally(() => {
        secondSettled = true;
      });
      await Bun.sleep(50);
      expect(secondSettled).toBe(false);
      expect(readEvents(bin)).toEqual(["start:1"]);

      writeFileSync(join(bin, "release"), "");
      await Promise.all([first, second]);
      await tunnel.ready(5_000);

      const rawEvents = readRawEvents(bin);
      expect(rawEvents.map((line) => line.split(":").slice(0, 2).join(":"))).toEqual(["start:1", "exit:1", "start:2"]);
      const secondPid = rawEvents[2]!.split(":")[2]!;
      expect(existsSync(pidFile)).toBe(true);
      expect((await Bun.file(pidFile).text()).trim()).toBe(secondPid);
      expect(tunnel.info()).toMatchObject({ mode: "quick", state: "running", url: "https://run-2-tunnel.trycloudflare.com" });

      await tunnel.stop();
      expect(existsSync(pidFile)).toBe(false);
    } finally {
      writeFileSync(join(bin, "release"), "");
      await tunnel.stop();
    }
  });

  test("stop superseded by apply leaves the replacement tunnel running", async () => {
    const { dir, settings, tunnel } = setup(gatedScript);
    const bin = join(dir, "bin");
    const pidFile = join(dir, "cloudflared", "cloudflared.pid");
    try {
      settings.set("cloudflareTunnel", { enabled: true, hostname: null, port: null });
      await tunnel.apply();
      await tunnel.ready(5_000);
      expect(tunnel.info()).toMatchObject({ mode: "quick", state: "running", url: "https://run-1-tunnel.trycloudflare.com" });

      const stopping = tunnel.stop();
      await waitFor(() => existsSync(join(bin, "got_term")), 5_000, "child 1 SIGTERM");

      let restartingSettled = false;
      const restarting = tunnel.apply().finally(() => {
        restartingSettled = true;
      });
      await Bun.sleep(50);
      expect(restartingSettled).toBe(false);
      expect(readEvents(bin)).toEqual(["start:1"]);

      writeFileSync(join(bin, "release"), "");
      await Promise.all([stopping, restarting]);
      await tunnel.ready(5_000);

      const rawEvents = readRawEvents(bin);
      expect(rawEvents.map((line) => line.split(":").slice(0, 2).join(":"))).toEqual(["start:1", "exit:1", "start:2"]);
      const secondPid = rawEvents[2]!.split(":")[2]!;
      const info = tunnel.info();
      expect(info).toMatchObject({ mode: "quick", state: "running", url: "https://run-2-tunnel.trycloudflare.com", error: null });
      expect(existsSync(pidFile)).toBe(true);
      expect((await Bun.file(pidFile).text()).trim()).toBe(secondPid);
      expect(await (await fetch(`http://127.0.0.1:${info.port}/`)).text()).toBe("ok");

      await tunnel.stop();
      expect(tunnel.info()).toMatchObject({ state: "off", url: null });
      expect(existsSync(pidFile)).toBe(false);
    } finally {
      writeFileSync(join(bin, "release"), "");
      await tunnel.stop();
    }
  });
});
