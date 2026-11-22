import type { Database } from "bun:sqlite";
import type { Settings } from "../settings.ts";
import { hashToken, newToken } from "./tokens.ts";

const sessionMs = 30 * 86_400_000;
const cookieName = "vmbridge_session";
const maxFailures = 5;
const failureWindowMs = 60_000;
// How often a watched session is checked, which catches one that simply expired.
const watchEveryMs = 30_000;

/**
 * The dashboard has one secret key, chosen when VM Bridge first starts. Logging in with it
 * issues a cookie session. Failed attempts are throttled per address because the dashboard
 * listens on the LAN and tailnet.
 */
export class DashboardAuth {
  private readonly failures = new Map<string, number[]>();
  private readonly watchers = new Set<() => void>();

  constructor(
    private readonly db: Database,
    private readonly settings: Settings,
  ) {}

  hasKey(): boolean {
    return this.settings.get("dashboardKeyHash") !== null;
  }

  async setKey(key: string): Promise<void> {
    if (key.length < 8) throw new Error("The password needs at least 8 characters.");
    this.settings.set("dashboardKeyHash", await Bun.password.hash(key));
    // A new key ends every existing dashboard session.
    this.db.query("DELETE FROM admin_sessions").run();
    this.checkWatched();
  }

  /** Sets a new key only when `current` is the key in use. Returns false when it is not. Throws when the address is throttled. */
  async changeKey(current: string, next: string, address: string): Promise<boolean> {
    if (!(await this.verify(current, address))) return false;
    await this.setKey(next);
    return true;
  }

  /** Returns a Set-Cookie value, or null when the key is wrong. Throws when the address is throttled. */
  async login(key: string, address: string, secure: boolean): Promise<string | null> {
    if (!(await this.verify(key, address))) return null;
    const now = Date.now();
    const token = newToken();
    this.db
      .query("INSERT INTO admin_sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)")
      .run(hashToken(token), now, now + sessionMs);
    this.db.query("DELETE FROM admin_sessions WHERE expires_at < ?").run(now);
    return cookie(token, sessionMs / 1000, secure);
  }

  authenticated(request: Request): boolean {
    const token = readCookie(request, cookieName);
    if (!token) return false;
    const row = this.db
      .query<{ expires_at: number }, [string]>("SELECT expires_at FROM admin_sessions WHERE token_hash = ?")
      .get(hashToken(token));
    return row !== null && row.expires_at > Date.now();
  }

  logout(request: Request): string {
    const token = readCookie(request, cookieName);
    if (token) this.db.query("DELETE FROM admin_sessions WHERE token_hash = ?").run(hashToken(token));
    this.checkWatched();
    return cookie("", 0, false);
  }

  /**
   * Calls `ended` once the request's session is gone: logged out, ended by a new key, or expired.
   * Long-lived responses such as the event stream use it, since they only check the cookie when they open.
   * Returns a function that stops watching.
   */
  watch(request: Request, ended: () => void): () => void {
    const check = () => {
      if (this.authenticated(request)) return;
      stop();
      ended();
    };
    const timer = setInterval(check, watchEveryMs);
    const stop = () => {
      clearInterval(timer);
      this.watchers.delete(check);
    };
    this.watchers.add(check);
    return stop;
  }

  private checkWatched() {
    for (const check of this.watchers) check();
  }

  /** Checks a key against the one in use, throttling failed attempts per address. */
  private async verify(key: string, address: string): Promise<boolean> {
    const now = Date.now();
    const recent = (this.failures.get(address) ?? []).filter((at) => now - at < failureWindowMs);
    if (recent.length >= maxFailures) throw new TooManyAttempts();
    const hash = this.settings.get("dashboardKeyHash");
    if (!hash || !(await Bun.password.verify(key, hash))) {
      this.failures.set(address, [...recent, now]);
      return false;
    }
    this.failures.delete(address);
    return true;
  }
}

export class TooManyAttempts extends Error {
  constructor() {
    super("Too many attempts. Wait a minute and try again.");
  }
}

function cookie(value: string, maxAge: number, secure: boolean): string {
  return new Bun.Cookie(cookieName, value, { path: "/", httpOnly: true, sameSite: "strict", maxAge, secure }).serialize();
}

function readCookie(request: Request, name: string): string | null {
  return new Bun.CookieMap(request.headers.get("cookie") ?? "").get(name);
}
