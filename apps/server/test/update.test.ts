import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Overview } from "@vmbridge/contracts";
import { openDatabase } from "../src/bun/sqlite.ts";
import { dashboardKey, databasePath, start, type StartOptions } from "../src/index.ts";
import { releaseCheck, releaseCheckMs } from "../src/release.ts";
import { Settings } from "../src/settings.ts";

const password = "update test password";
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** A bridge whose last release check found 99.0.0, with a logged-in dashboard. */
async function bridgeWithRelease(options: Pick<StartOptions, "installUpdate">) {
  const dir = mkdtempSync(join(tmpdir(), "vmbridge-update-"));
  const keys = dashboardKey(dir);
  await keys.set(password);
  keys.close();
  const db = openDatabase(databasePath(dir));
  new Settings(db).set("latestRelease", { version: "99.0.0", checkedAt: Date.now() });
  db.close();
  const bridge = await start({ dir, host: "127.0.0.1", port: 0, ...options });
  cleanups.push(async () => {
    await bridge.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${bridge.port}`;
  const login = await fetch(`${base}/admin/api/login`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ key: password }) });
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const headers = { "content-type": "application/json", origin: base, cookie };
  return {
    update: async () => ((await (await fetch(`${base}/admin/api/overview`, { headers })).json()) as Overview).bridge.update,
    install: () => fetch(`${base}/admin/api/update`, { method: "POST", headers, body: "{}" }),
  };
}

test("the Update button installs once at a time, and shows why an install failed", async () => {
  let installs = 0;
  let fail = (_: Error) => {};
  const dashboard = await bridgeWithRelease({
    installUpdate: () => {
      installs++;
      return new Promise((_, reject) => (fail = reject));
    },
  });
  expect(await dashboard.update()).toEqual({ version: "99.0.0", how: "dashboard", installing: false, error: null });

  expect((await dashboard.install()).status).toBe(202);
  expect((await dashboard.install()).status).toBe(202);
  expect(installs).toBe(1);
  expect(await dashboard.update()).toMatchObject({ installing: true, error: null });

  fail(new Error("The download does not match its checksum. Nothing was changed."));
  await Bun.sleep(10);
  expect(await dashboard.update()).toMatchObject({ installing: false, error: "The download does not match its checksum. Nothing was changed." });
  expect((await dashboard.install()).status).toBe(202);
  expect(installs).toBe(2);
});

test("without an install, as in a terminal's VM Bridge, the dashboard shows the command and refuses to install", async () => {
  const dashboard = await bridgeWithRelease({});
  expect(await dashboard.update()).toMatchObject({ version: "99.0.0", how: "command" });
  expect((await dashboard.install()).status).toBe(400);
});

test("the release check asks GitHub at most every few hours and offers only a newer release", async () => {
  const settings = new Settings(openDatabase(":memory:"));
  let asked = 0;
  let latest = "v1.2.0";
  const check = releaseCheck(settings, "1.1.0", async () => {
    asked++;
    return Response.json({ tag_name: latest });
  });
  expect(check.available()).toBeNull();
  await check.job.run();
  expect(check.available()).toBe("1.2.0");
  latest = "v1.3.0";
  await check.job.run();
  expect(asked).toBe(1);

  settings.set("latestRelease", { version: "1.2.0", checkedAt: Date.now() - releaseCheckMs });
  await check.job.run();
  expect(asked).toBe(2);
  expect(check.available()).toBe("1.3.0");
  expect(releaseCheck(settings, "1.3.0").available()).toBeNull();
});
