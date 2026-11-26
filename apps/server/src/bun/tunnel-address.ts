/**
 * Waits before each check of a quick tunnel's address. The first wait gives Cloudflare time to publish the DNS
 * record, since a lookup that comes too early is remembered as "no such name" for a minute or more.
 */
const checkDelays = [3_000, 3_000, 5_000, 5_000, 10_000];
const checkLimitMs = 180_000;

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Whether the address resolves in public DNS and an HTTPS request to it reaches this VM Bridge. DNS is asked over
 * HTTPS, so a lookup before the record exists is never remembered by this machine's own resolver.
 */
export async function addressWorks(url: string, fetcher: Fetcher = fetch): Promise<boolean> {
  try {
    const name = new URL(url).hostname;
    const dns = await fetcher(`https://cloudflare-dns.com/dns-query?name=${name}&type=A`, {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(5_000),
    });
    const lookup = (await dns.json()) as { Status?: number; Answer?: { type: number }[] };
    // Status 0 is NOERROR, and type 1 an A record.
    if (lookup.Status !== 0 || !lookup.Answer?.some((record) => record.type === 1)) return false;
    // The login check is public and only VM Bridge answers it with this shape.
    const response = await fetcher(`${url}/admin/api/auth`, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return false;
    const auth = (await response.json()) as { hasPassword?: unknown };
    return typeof auth.hasPassword === "boolean";
  } catch {
    return false;
  }
}

/** Checks the address until it works, it is no longer wanted, or the time limit passes. */
export async function waitForAddress(
  url: string,
  wanted: () => boolean,
  { fetcher = fetch, delays = checkDelays, limitMs = checkLimitMs }: { fetcher?: Fetcher; delays?: number[]; limitMs?: number } = {},
): Promise<boolean> {
  const deadline = Date.now() + limitMs;
  for (let attempt = 0; ; attempt++) {
    await Bun.sleep(delays[Math.min(attempt, delays.length - 1)] ?? 0);
    if (!wanted()) return false;
    if (await addressWorks(url, fetcher)) return true;
    if (Date.now() >= deadline || !wanted()) return false;
  }
}
