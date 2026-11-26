import { describe, expect, test } from "bun:test";
import { openDatabase } from "../src/bun/sqlite.ts";
import { DashboardAuth } from "../src/auth/dashboard.ts";
import type { Passwords } from "../src/auth/password.ts";
import { Secrets } from "../src/settings.ts";
import { testEncryption } from "./key.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("dashboard password rotation races", () => {
  test("an in-flight login cannot issue a session after the password rotates", async () => {
    const db = openDatabase(":memory:");
    const secrets = new Secrets(db, testEncryption);
    const gate = deferred<{ ok: boolean; outdated: boolean }>();
    let holdVerify = false;
    const passwords: Passwords = {
      hash: async (password) => `h:${password}`,
      verify: async (password, hash) => {
        if (holdVerify) return gate.promise;
        return { ok: hash === `h:${password}`, outdated: false };
      },
    };
    const auth = new DashboardAuth(db, secrets, passwords);
    await auth.setKey("first password");

    holdVerify = true;
    const pendingLogin = auth.login("first password", "10.0.0.1", false);
    holdVerify = false;

    // Rotate while the first login is still verifying against the old hash.
    await auth.setKey("second password");
    gate.resolve({ ok: true, outdated: false });

    expect(await pendingLogin).toBeNull();
    expect(db.one<{ n: number }>("SELECT COUNT(*) AS n FROM admin_sessions")?.n).toBe(0);
    expect(await auth.login("second password", "10.0.0.2", false)).not.toBeNull();
  });

  test("an in-flight login upgrading an outdated hash fails if the password rotates during rehash", async () => {
    const db = openDatabase(":memory:");
    const secrets = new Secrets(db, testEncryption);
    const rehashGate = deferred<string>();
    let holdRehash = false;
    const passwords: Passwords = {
      hash: async (password) => {
        if (holdRehash) return rehashGate.promise;
        return `h:${password}`;
      },
      verify: async (password, hash) => ({ ok: hash === `h:${password}`, outdated: hash === "h:first password" }),
    };
    const auth = new DashboardAuth(db, secrets, passwords);
    await auth.setKey("first password");

    holdRehash = true;
    const pendingLogin = auth.login("first password", "10.0.0.1", false);
    await Bun.sleep(0);
    holdRehash = false;

    await auth.setKey("second password");
    rehashGate.resolve("h:upgraded-first");

    expect(await pendingLogin).toBeNull();
    expect(await auth.login("second password", "10.0.0.2", false)).not.toBeNull();
    expect(await auth.login("first password", "10.0.0.3", false)).toBeNull();
  });

  test("an in-flight changeKey cannot overwrite a password rotated while hashing its replacement", async () => {
    const db = openDatabase(":memory:");
    const secrets = new Secrets(db, testEncryption);
    const hashGate = deferred<string>();
    let holdNextHash = false;
    const passwords: Passwords = {
      hash: async (password) => {
        if (holdNextHash && password === "stale next") return hashGate.promise;
        return `h:${password}`;
      },
      verify: async (password, hash) => ({ ok: hash === `h:${password}`, outdated: false }),
    };
    const auth = new DashboardAuth(db, secrets, passwords);
    await auth.setKey("first password");

    holdNextHash = true;
    const pendingChange = auth.changeKey("first password", "stale next", "10.0.0.1");
    await Bun.sleep(0);
    holdNextHash = false;

    await auth.setKey("rotated password");
    const validCookie = (await auth.login("rotated password", "10.0.0.2", false))!.split(";")[0]!;
    hashGate.resolve("h:stale next");

    expect(await pendingChange).toBe(false);
    expect(auth.authenticated(new Request("http://x/", { headers: { cookie: validCookie } }))).toBe(true);
    expect(await auth.login("rotated password", "10.0.0.3", false)).not.toBeNull();
    expect(await auth.login("stale next", "10.0.0.4", false)).toBeNull();
  });

  test("concurrent logins with the unchanged password both succeed during a one-time hash upgrade", async () => {
    const db = openDatabase(":memory:");
    const secrets = new Secrets(db, testEncryption);
    const rehashGate = deferred<string>();
    let hashCalls = 0;
    const passwords: Passwords = {
      hash: async (password) => {
        if (hashCalls++ === 1) return rehashGate.promise;
        return `new:${password}:${hashCalls}`;
      },
      verify: async (password, hash) => ({
        ok: hash === `old:${password}` || hash.startsWith(`new:${password}:`),
        outdated: hash === `old:${password}`,
      }),
    };
    const auth = new DashboardAuth(db, secrets, passwords);
    secrets.set("dashboard.passwordHash", "old:same password");
    hashCalls = 1;

    const first = auth.login("same password", "10.0.0.1", false);
    await Bun.sleep(0);
    const second = auth.login("same password", "10.0.0.2", false);
    const secondCookie = await second;
    expect(secondCookie).not.toBeNull();

    rehashGate.resolve("new:same password:late");
    const firstCookie = await first;
    expect(firstCookie).not.toBeNull();
  });

  test("a password set from the CLI while claim is hashing is not overwritten and claim issues no session", async () => {
    const db = openDatabase(":memory:");
    const secrets = new Secrets(db, testEncryption);
    const hashGate = deferred<string>();
    let holdClaim = false;
    const passwords: Passwords = {
      hash: async (password) => {
        if (holdClaim && password === "browser password") return hashGate.promise;
        return `h:${password}`;
      },
      verify: async (password, hash) => ({ ok: hash === `h:${password}`, outdated: false }),
    };
    const auth = new DashboardAuth(db, secrets, passwords);
    const code = auth.createSetupCode()!;

    holdClaim = true;
    const pendingClaim = auth.claim(code, "browser password", "10.0.0.1", false);
    await Bun.sleep(0);
    holdClaim = false;

    await new DashboardAuth(db, new Secrets(db, testEncryption), passwords).setKey("terminal password");
    hashGate.resolve("h:browser password");

    expect(await pendingClaim).toBeNull();
    expect(db.one<{ n: number }>("SELECT COUNT(*) AS n FROM admin_sessions")?.n).toBe(0);
    expect(await auth.login("terminal password", "10.0.0.2", false)).not.toBeNull();
    expect(await auth.login("browser password", "10.0.0.3", false)).toBeNull();
  });
});
