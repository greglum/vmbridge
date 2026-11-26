import { expect, test } from "bun:test";
import { api, onLoggedOut } from "../api.ts";
import { authScreen, createAuthLoader, formatAuthError, initialAuthLoadState, type AuthLoadState, type AuthState } from "./auth-load.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("authScreen resolves loading, error, onboarding, login, and dashboard", () => {
  expect(authScreen(initialAuthLoadState)).toBe("loading");
  expect(authScreen({ auth: null, error: "Request failed (503).", loading: false })).toBe("error");
  expect(authScreen({ auth: null, error: "Request failed (503).", loading: true })).toBe("error");
  expect(authScreen({ auth: { authenticated: false, hasPassword: false, onboarded: false }, error: null, loading: false })).toBe("onboarding");
  expect(authScreen({ auth: { authenticated: true, hasPassword: true, onboarded: false }, error: null, loading: false })).toBe("onboarding");
  expect(authScreen({ auth: { authenticated: false, hasPassword: true, onboarded: true }, error: null, loading: false })).toBe("login");
  expect(authScreen({ auth: { authenticated: true, hasPassword: true, onboarded: true }, error: null, loading: false })).toBe("dashboard");
});

test("initial /auth failure surfaces an error screen and recovers on retry without rejecting", async () => {
  const states: Array<{ state: AuthLoadState; sync: boolean }> = [];
  const refreshErrors: string[] = [];
  let attempt = 0;

  const loader = createAuthLoader(
    async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("Request failed (503).");
      return { authenticated: false, hasPassword: true, onboarded: true };
    },
    (state, sync) => states.push({ state, sync }),
    (message) => refreshErrors.push(message),
  );

  await loader.refresh();
  expect(states).toEqual([
    { state: { auth: null, error: "Request failed (503).", loading: false }, sync: false },
  ]);
  expect(authScreen(states.at(-1)!.state)).toBe("error");
  expect(refreshErrors).toEqual([]);

  await loader.refresh();
  expect(states.slice(1)).toEqual([
    { state: { auth: null, error: "Request failed (503).", loading: true }, sync: false },
    { state: { auth: { authenticated: false, hasPassword: true, onboarded: true }, error: null, loading: false }, sync: true },
  ]);
  expect(authScreen(states.at(-1)!.state)).toBe("login");
});

test("subsequent /auth failure preserves loaded auth and reports via onRefreshError", async () => {
  const loaded: AuthState = { authenticated: true, hasPassword: true, onboarded: false };
  const states: AuthLoadState[] = [];
  const refreshErrors: string[] = [];
  let fail = false;

  const loader = createAuthLoader(
    async () => {
      if (fail) throw new TypeError("Failed to fetch");
      return loaded;
    },
    (state) => states.push(state),
    (message) => refreshErrors.push(message),
  );

  await loader.refresh();
  fail = true;
  await loader.refresh();

  expect(states.at(-1)).toEqual({ auth: loaded, error: null, loading: false });
  expect(authScreen(states.at(-1)!)).toBe("onboarding");
  expect(refreshErrors).toEqual(["Failed to fetch"]);
});

test("out-of-order and post-dispose /auth responses are ignored", async () => {
  const first = deferred<AuthState>();
  const second = deferred<AuthState>();
  const third = deferred<AuthState>();
  const queue = [first.promise, second.promise, third.promise];
  const states: AuthLoadState[] = [];
  const refreshErrors: string[] = [];

  const loader = createAuthLoader(
    () => queue.shift()!,
    (state) => states.push(state),
    (message) => refreshErrors.push(message),
  );

  const p1 = loader.refresh();
  const p2 = loader.refresh();

  const newer: AuthState = { authenticated: true, hasPassword: true, onboarded: true };
  second.resolve(newer);
  await p2;

  first.reject(new Error("stale failure"));
  await p1;

  expect(states.at(-1)).toEqual({ auth: newer, error: null, loading: false });
  expect(refreshErrors).toEqual([]);

  const p3 = loader.refresh();
  const countBeforeDispose = states.length;
  loader.dispose();
  third.resolve({ authenticated: false, hasPassword: true, onboarded: true });
  await p3;

  expect(states.length).toBe(countBeforeDispose);
  expect(states.at(-1)?.auth).toEqual(newer);
  expect(formatAuthError(new Error("  "))).toBe("Could not reach VM Bridge.");
  expect(formatAuthError("gateway timeout")).toBe("gateway timeout");
});

test("401 from /auth does not trigger loggedOut listeners (prevents infinite /auth refresh loop)", async () => {
  const originalFetch = globalThis.fetch;
  let loggedOutCalls = 0;
  const stop = onLoggedOut(() => {
    loggedOutCalls += 1;
  });

  try {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 })) as unknown as typeof fetch;

    await expect(api("/auth")).rejects.toThrow("Unauthorized");
    expect(loggedOutCalls).toBe(0);

    await expect(api("/overview")).rejects.toThrow("Unauthorized");
    expect(loggedOutCalls).toBe(1);
  } finally {
    stop();
    globalThis.fetch = originalFetch;
  }
});
