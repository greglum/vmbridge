import type { Sql } from "../sql.ts";
import { timingSafeEqual } from "node:crypto";
import type { Settings } from "../settings.ts";
import { hashPassword, verifyPassword } from "./password.ts";
import { hashToken, newToken } from "./tokens.ts";

const sessionMs = 30 * 86_400_000;
const cookieName = "vmbridge_session";
const maxFailures = 5;
const failureWindowMs = 60_000;
// How often a watched session is checked, which catches one that simply expired.
const watchEveryMs = 30_000;

/**
 * The dashboard has one secret key, chosen in onboarding or from the terminal. Logging in with it
 * issues a cookie session. Failed attempts are throttled per address because the dashboard
 * listens on the LAN and tailnet.
 */
export class DashboardAuth {
  private readonly failures = new Map<string, number[]>();
  private readonly watchers = new Set<() => void>();
  /** Kept only in memory: a restart makes a new one. */
  private setupCode: string | null = null;

  constructor(
    private readonly db: Sql,
    private readonly settings: Settings,
  ) {}

  hasKey(): boolean {
    return this.settings.get("dashboardKeyHash") !== null;
  }

  async setKey(key: string): Promise<void> {
    checkKey(key);
    this.settings.set("dashboardKeyHash", await hashPassword(key));
    // A new key ends every existing dashboard session.
    this.db.run("DELETE FROM admin_sessions");
    this.checkWatched();
  }

  /** Sets a new key only when `current` is the key in use. Returns false when it is not. Throws when the address is throttled. */
  async changeKey(current: string, next: string, address: string): Promise<boolean> {
    if (!(await this.verify(current, address))) return false;
    await this.setKey(next);
    return true;
  }

  /**
   * A one-time code for choosing the first password in the dashboard. Anyone on the LAN or tailnet can open a fresh
   * bridge, so only the terminal that started it gets the code. Null once a password exists.
   */
  createSetupCode(): string | null {
    this.setupCode = this.hasKey() ? null : newToken();
    return this.setupCode;
  }

  /**
   * Sets the first password when `code` is the setup code, and returns a Set-Cookie value for a new session. Returns
   * null when the code is wrong, used, or a password already exists. Throws when the address is throttled or the
   * password is too short; a short password leaves the code usable.
   */
  async claim(code: string, key: string, address: string, secure: boolean): Promise<string | null> {
    const failed = this.throttle(address);
    const expected = this.setupCode;
    if (!expected || this.hasKey() || !timingSafeEqual(Buffer.from(hashToken(code)), Buffer.from(hashToken(expected)))) {
      failed();
      return null;
    }
    checkKey(key);
    // Spent before hashing the password, so a second request racing this one cannot use it too.
    this.setupCode = null;
    this.failures.delete(address);
    await this.setKey(key);
    return this.session(secure);
  }

  /** Returns a Set-Cookie value, or null when the key is wrong. Throws when the address is throttled. */
  async login(key: string, address: string, secure: boolean): Promise<string | null> {
    if (!(await this.verify(key, address))) return null;
    return this.session(secure);
  }

  private session(secure: boolean): string {
    const now = Date.now();
    const token = newToken();
    this.db.run("INSERT INTO admin_sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)", hashToken(token), now, now + sessionMs);
    this.db.run("DELETE FROM admin_sessions WHERE expires_at < ?", now);
    return cookie(token, sessionMs / 1000, secure);
  }

  authenticated(request: Request): boolean {
    const token = readCookie(request, cookieName);
    if (!token) return false;
    const row = this.db.one<{ expires_at: number }>("SELECT expires_at FROM admin_sessions WHERE token_hash = ?", hashToken(token));
    return row !== undefined && row.expires_at > Date.now();
  }

  logout(request: Request): string {
    const token = readCookie(request, cookieName);
    if (token) this.db.run("DELETE FROM admin_sessions WHERE token_hash = ?", hashToken(token));
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

  /** Throws when the address failed too often lately. Returns a function that records one more failure. */
  private throttle(address: string) {
    const now = Date.now();
    const recent = (this.failures.get(address) ?? []).filter((at) => now - at < failureWindowMs);
    if (recent.length >= maxFailures) throw new TooManyAttempts();
    return () => void this.failures.set(address, [...recent, now]);
  }

  /** Checks a key against the one in use, throttling failed attempts per address. */
  private async verify(key: string, address: string): Promise<boolean> {
    const failed = this.throttle(address);
    const hash = this.settings.get("dashboardKeyHash");
    const { ok, outdated } = hash ? await verifyPassword(key, hash) : { ok: false, outdated: false };
    if (!ok) {
      failed();
      return false;
    }
    this.failures.delete(address);
    // Swaps a hash from an older version for the current kind, keeping every session. Checked again after hashing,
    // with no await before the write, so a password changed meanwhile is never put back.
    if (outdated) {
      const replacement = await hashPassword(key);
      if (this.settings.get("dashboardKeyHash") === hash) this.settings.set("dashboardKeyHash", replacement);
    }
    return true;
  }
}

export class InvalidPassword extends Error {}

function checkKey(key: string) {
  if (key.length < 8) throw new InvalidPassword("The password needs at least 8 characters.");
}

export class TooManyAttempts extends Error {
  constructor() {
    super("Too many attempts. Wait a minute and try again.");
  }
}

function cookie(value: string, maxAge: number, secure: boolean): string {
  return `${cookieName}=${value}; Path=/; Max-Age=${maxAge};${secure ? " Secure;" : ""} HttpOnly; SameSite=Strict`;
}

function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=") || null;
  }
  return null;
}
