import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start } from "../src/index.ts";

let dir: string;
let bridge: Awaited<ReturnType<typeof start>>;
const get = (path: string) => fetch(`http://127.0.0.1:${bridge.port}${path}`, { redirect: "manual" });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "vmbridge-dashboard-"));
  bridge = await start({ dir, host: "127.0.0.1", port: 0 });
});

afterAll(async () => {
  await bridge.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("a trailing slash on a dashboard page redirects to the page, keeping the query", async () => {
  const redirects = {
    "/dashboard/": "/dashboard",
    "/dashboard/onboarding/": "/dashboard/onboarding",
    "/dashboard/?view=settings": "/dashboard?view=settings",
  };
  for (const [from, to] of Object.entries(redirects)) {
    const response = await get(from);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(to);
  }
  expect((await get("/dashboard")).status).toBe(200);
  expect((await get("/dashboard/onboarding")).status).toBe(200);
});

test("other paths are left alone", async () => {
  expect((await get("/admin/api/")).status).not.toBe(302);
  expect((await get("/nothing/")).status).toBe(404);
});
