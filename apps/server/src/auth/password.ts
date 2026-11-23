import { timingSafeEqual } from "node:crypto";

// Cloudflare Workers refuse PBKDF2 above 100,000 iterations. The count is stored with each hash, so it can rise later.
const iterations = 100_000;
const scheme = "pbkdf2-sha256";

async function derive(password: string, salt: Uint8Array<ArrayBuffer>, rounds: number) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  return Buffer.from(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: rounds }, key, 256));
}

/** A salted PBKDF2-SHA256 hash, as `$pbkdf2-sha256$i=<iterations>$<salt>$<hash>` with base64 salt and hash. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt, iterations);
  return `$${scheme}$i=${iterations}$${Buffer.from(salt).toString("base64")}$${hash.toString("base64")}`;
}

/**
 * Checks a password against a hash from `hashPassword`, or an argon2 one from `Bun.password`, which VM Bridge used
 * before and only Bun can check. `outdated` means the password was right and should be hashed again.
 */
export async function verifyPassword(password: string, stored: string): Promise<{ ok: boolean; outdated: boolean }> {
  const [, name, rounds, salt, hash] = stored.split("$");
  if (name !== scheme) {
    const ok = typeof Bun !== "undefined" && (await Bun.password.verify(password, stored).catch(() => false));
    return { ok, outdated: ok };
  }
  const count = Number(rounds?.replace(/^i=/, ""));
  if (!Number.isSafeInteger(count) || count < 1 || !salt || !hash) return { ok: false, outdated: false };
  const expected = Buffer.from(hash, "base64");
  const actual = await derive(password, Buffer.from(salt, "base64"), count);
  const ok = actual.length === expected.length && timingSafeEqual(actual, expected);
  return { ok, outdated: ok && count < iterations };
}
