import { afterEach, describe, expect, test } from "bun:test";
import {
  codexAccount,
  codexTokenAccounts,
  completeDeviceCode,
  parseCodexAuth,
  refreshCodexAuth,
  requestDeviceCode,
  SignInExpired,
  type CodexAuthFile,
} from "../src/agent-auth/codex.ts";
import { AgentAuth, codexAuthContext } from "../src/agent-auth/profiles.ts";
import { openDatabase } from "../src/bun/sqlite.ts";
import { Settings } from "../src/settings.ts";
import { testEncryption } from "./key.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => handler(String(input), init)) as typeof fetch;
}

const jwt = (payload: unknown) => `e30.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;

function codexFile(account = "acct-1", refresh = "refresh-1"): CodexAuthFile {
  return {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: jwt({ email: `${account}@example.com`, "https://api.openai.com/auth": { chatgpt_account_id: account } }),
      access_token: jwt({ exp: Math.floor((Date.now() + 24 * 60 * 60_000) / 1000) }),
      refresh_token: refresh,
      account_id: account,
    },
    last_refresh: new Date().toISOString(),
  };
}

describe("Codex device sign-in cancellation", () => {
  test("aborts immediately during the polling backoff sleep", async () => {
    const abort = new AbortController();
    let polls = 0;
    let timerFired = false;
    let finished = false;
    stubFetch(() => {
      polls++;
      setTimeout(() => {
        expect(finished).toBe(false);
        timerFired = true;
        abort.abort();
      }, 20);
      return new Response("{}", { status: 404 });
    });

    const started = Date.now();
    await expect(completeDeviceCode({ deviceAuthId: "dev", userCode: "ABCD-1234", intervalMs: 60_000 }, abort.signal)).rejects.toThrow();
    finished = true;
    expect(timerFired).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(polls).toBe(1);
  });

  test("propagates abort to in-flight device poll and never exchanges or saves a cancelled login", async () => {
    const db = openDatabase(":memory:");
    const auth = new AgentAuth(db, new Settings(db), testEncryption);
    const urls: string[] = [];
    let pollSignal: AbortSignal | null | undefined;
    let releasePoll!: () => void;
    const pollStarted = new Promise<void>((resolve) => {
      const file = codexFile();
      stubFetch(async (url, init) => {
        urls.push(url);
        if (url.endsWith("/deviceauth/usercode")) return Response.json({ device_auth_id: "dev", user_code: "ABCD-1234", interval: "5" });
        if (url.endsWith("/deviceauth/token")) {
          pollSignal = init?.signal;
          resolve();
          await new Promise<void>((done) => {
            releasePoll = done;
          });
          // Simulate a race where the approval response arrives just as cancel fires.
          return Response.json({ authorization_code: "auth-code", code_verifier: "verifier" });
        }
        return Response.json(file.tokens);
      });
    });

    const login = await auth.startCodexLogin("Work");
    await pollStarted;
    expect(pollSignal).toBeDefined();
    expect(pollSignal?.aborted).toBe(false);

    auth.cancelCodexLogin(login.id);
    expect(pollSignal?.aborted).toBe(true);
    releasePoll();

    for (let i = 0; i < 50 && auth.codexLogin(login.id)?.status === "pending"; i++) await Bun.sleep(5);
    expect(auth.codexLogin(login.id)).toMatchObject({ status: "failed", error: "Cancelled." });
    expect(auth.list()).toEqual([]);
    expect(urls.some((url) => url.endsWith("/oauth/token"))).toBe(false);
  });

  test("propagates abort to /oauth/token and does not save when cancelled before the token body arrives", async () => {
    const db = openDatabase(":memory:");
    const auth = new AgentAuth(db, new Settings(db), testEncryption);
    let tokenSignal: AbortSignal | null | undefined;
    let releaseTokenBody!: (value: unknown) => void;
    const file = codexFile();
    const tokenBodyStarted = new Promise<void>((resolve) => {
      stubFetch((url, init) => {
        if (url.endsWith("/deviceauth/usercode")) return Response.json({ device_auth_id: "dev", user_code: "ABCD-1234", interval: "5" });
        if (url.endsWith("/deviceauth/token")) return Response.json({ authorization_code: "auth-code", code_verifier: "verifier" });
        tokenSignal = init?.signal;
        return {
          ok: true,
          status: 200,
          json: () => {
            resolve();
            return new Promise((done) => {
              releaseTokenBody = done;
            });
          },
        } as Response;
      });
    });

    const login = await auth.startCodexLogin("Work");
    await tokenBodyStarted;
    expect(tokenSignal).toBeDefined();
    expect(tokenSignal?.aborted).toBe(false);

    auth.cancelCodexLogin(login.id);
    expect(tokenSignal?.aborted).toBe(true);
    releaseTokenBody(file.tokens);

    for (let i = 0; i < 50 && auth.codexLogin(login.id)?.status === "pending"; i++) await Bun.sleep(5);
    expect(auth.codexLogin(login.id)).toMatchObject({ status: "failed", error: "Cancelled." });
    expect(auth.list()).toEqual([]);
  });

  test("does not save credentials when cancelled after token exchange resolves but before saveCodex", async () => {
    const db = openDatabase(":memory:");
    const auth = new AgentAuth(db, new Settings(db), testEncryption);
    let releaseTokenBody!: (value: unknown) => void;
    const file = codexFile();
    const tokenBodyStarted = new Promise<void>((resolve) => {
      stubFetch((url) => {
        if (url.endsWith("/deviceauth/usercode")) return Response.json({ device_auth_id: "dev", user_code: "ABCD-1234", interval: "5" });
        if (url.endsWith("/deviceauth/token")) return Response.json({ authorization_code: "auth-code", code_verifier: "verifier" });
        return {
          ok: true,
          status: 200,
          json: () => {
            resolve();
            return new Promise((done) => {
              releaseTokenBody = done;
            });
          },
        } as Response;
      });
    });

    const login = await auth.startCodexLogin("Work");
    await tokenBodyStarted;

    // Microtask 1 resumes completeDeviceCode after response.json() and resolves it; microtask 2 cancels before .then runs saveCodex.
    releaseTokenBody(file.tokens);
    queueMicrotask(() => auth.cancelCodexLogin(login.id));

    for (let i = 0; i < 50 && auth.codexLogin(login.id)?.status === "pending"; i++) await Bun.sleep(5);
    expect(auth.codexLogin(login.id)).toMatchObject({ status: "failed", error: "Cancelled." });
    expect(auth.list()).toEqual([]);
  });
});

describe("Codex JSON null and malformed payload guards", () => {
  test("refreshCodexAuth throws SignInExpired on null and { error: null } error payloads", async () => {
    const file = codexFile();

    stubFetch(() => new Response("null", { status: 401, headers: { "content-type": "application/json" } }));
    await expect(refreshCodexAuth(file)).rejects.toBeInstanceOf(SignInExpired);

    stubFetch(() => Response.json({ error: null, code: "refresh_token_expired" }, { status: 400 }));
    await expect(refreshCodexAuth(file)).rejects.toBeInstanceOf(SignInExpired);
  });

  test("200 null or non-object refresh response throws and does not overwrite tokens or bump last_refresh", async () => {
    const file = codexFile();

    for (const raw of ["null", "[]"]) {
      stubFetch(() => new Response(raw, { status: 200, headers: { "content-type": "application/json" } }));
      let caught: unknown;
      try {
        await refreshCodexAuth(file);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(caught).not.toBeInstanceOf(SignInExpired);
      expect((caught as Error).message).toContain("unexpected refresh response");
    }

    const db = openDatabase(":memory:");
    const auth = new AgentAuth(db, new Settings(db), testEncryption);
    stubFetch((url) => {
      if (url.endsWith("/deviceauth/usercode")) return Response.json({ device_auth_id: "dev", user_code: "ABCD-1234", interval: "0" });
      if (url.endsWith("/deviceauth/token")) return Response.json({ authorization_code: "code", code_verifier: "v" });
      return Response.json(file.tokens);
    });
    const login = await auth.startCodexLogin("Work");
    for (let i = 0; i < 50 && auth.codexLogin(login.id)?.status === "pending"; i++) await Bun.sleep(5);
    expect(auth.codexLogin(login.id)?.status).toBe("done");

    const [profile] = auth.list();
    const readSaved = () => {
      const sealed = db.one<{ codexAuth: string }>("SELECT codex_auth AS codexAuth FROM agent_profiles WHERE id = ?", profile!.id)!.codexAuth;
      return JSON.parse(testEncryption.open(sealed, codexAuthContext(profile!.id))) as CodexAuthFile;
    };
    const before = readSaved();
    expect(auth.codexDue()).toBe(true);

    await Bun.sleep(5);
    stubFetch(() => new Response("null", { status: 200, headers: { "content-type": "application/json" } }));
    expect(await auth.refreshCodex(true)).toBeUndefined();

    expect(readSaved()).toEqual(before);
    expect(auth.list()[0]?.error).toBeNull();
    expect(auth.codexDue()).toBe(true);
  });

  test("handles JSON null payloads and ignores non-string/non-number poll intervals", async () => {
    const nullJwtFile: CodexAuthFile = {
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: { id_token: jwt(null), access_token: jwt(null), refresh_token: "r1", account_id: null },
      last_refresh: new Date().toISOString(),
    };
    expect(codexAccount(nullJwtFile)).toEqual({ email: null, accountId: null, expiresAt: null });
    expect(parseCodexAuth("null")).toBeNull();
    expect(parseCodexAuth(JSON.stringify({ tokens: [], last_refresh: "2026-01-01T00:00:00Z" }))).toBeNull();

    stubFetch(() => new Response("null", { status: 200, headers: { "content-type": "application/json" } }));
    await expect(requestDeviceCode()).rejects.toThrow("unexpected sign-in code");
    await expect(completeDeviceCode({ deviceAuthId: "dev", userCode: "ABCD-1234", intervalMs: 5 }, new AbortController().signal)).rejects.toThrow(
      "unexpected sign-in response",
    );
    expect(await codexTokenAccounts("access")).toEqual([]);

    for (const interval of [true, [2], {}, null]) {
      stubFetch(() => Response.json({ device_auth_id: "dev", user_code: "ABCD-1234", interval }));
      expect((await requestDeviceCode()).intervalMs).toBe(5000);
    }
    stubFetch(() => Response.json({ device_auth_id: "dev", user_code: "ABCD-1234", interval: "7" }));
    expect((await requestDeviceCode()).intervalMs).toBe(7000);
    stubFetch(() => Response.json({ device_auth_id: "dev", user_code: "ABCD-1234", interval: 9 }));
    expect((await requestDeviceCode()).intervalMs).toBe(9000);
  });
});
