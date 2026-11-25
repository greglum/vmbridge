import type { AddressTest, ConnectionStep } from "@vmbridge/contracts";
import { message } from "./fleet.ts";

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

const desktopOrigin = "t3code://app";
const webOrigin = "https://app.t3.codes";
const timeoutMs = 10_000;
// T3's HTTP client (Effect's) adds trace headers to every request, so each one is preflighted.
const requestedHeaders = ["b3", "traceparent"];

/**
 * Who sends a request, with the Origin they send and the origin their browser checks the answer against. T3's desktop
 * app strips `Origin` while its renderer, at `t3code://app`, still checks the answer; older desktop builds sent it.
 */
const callers = [
  { origin: null, checkedAs: desktopOrigin, when: "when the request has no Origin", who: "T3 Code desktop" },
  { origin: desktopOrigin, checkedAs: desktopOrigin, when: `for Origin ${desktopOrigin}`, who: "older T3 Code desktop" },
  { origin: webOrigin, checkedAs: webOrigin, when: `for Origin ${webOrigin}`, who: "T3 Code on the web" },
];
type Caller = (typeof callers)[number];

const cloudflareErrors: Record<string, string> = {
  "1016": "the hostname has no working DNS record",
  "1033": "the tunnel is down",
  "1101": "the Worker threw an error",
  "1102": "the Worker ran out of time or memory",
};

/** The address could not be reached, or something other than the bridge answered. Not tied to one caller. */
class Unreachable extends Error {}

async function send(fetcher: Fetch, url: string, init: RequestInit) {
  let response: Response;
  try {
    response = await fetcher(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") throw new Unreachable(`No answer within ${timeoutMs / 1000} seconds.`);
    throw new Unreachable(`Could not reach it: ${message(error)}`);
  }
  const body = await response.text().catch(() => "");
  // Answers through a tunnel carry cf-ray too, so only Cloudflare's own error pages count.
  const code = response.headers.has("cf-ray") ? /error code:?\s*(1\d{3})/i.exec(body)?.[1] : undefined;
  if (code) {
    const meaning = cloudflareErrors[code];
    throw new Unreachable(`Cloudflare answered with error ${code}${meaning ? `: ${meaning}` : ""}.`);
  }
  return { response, body };
}

function statusProblem(response: Response) {
  if (response.status >= 200 && response.status < 300) return null;
  const location = response.headers.get("location");
  return location ? `Redirected to ${location}` : `Answered ${response.status}`;
}

/** What a browser at `origin` would refuse in this answer, for a request that sends no cookies. */
function allowOriginProblem(response: Response, origin: string) {
  const allowed = response.headers.get("access-control-allow-origin");
  if (allowed === null) return "No Access-Control-Allow-Origin";
  if (allowed !== "*" && allowed !== origin) return `Access-Control-Allow-Origin is ${allowed}, not ${origin}`;
  return null;
}

function allowHeadersProblem(response: Response) {
  const allowed = (response.headers.get("access-control-allow-headers") ?? "").split(",").map((header) => header.trim().toLowerCase());
  if (allowed.includes("*")) return null;
  const missing = requestedHeaders.filter((header) => !allowed.includes(header));
  return missing.length > 0 ? `Access-Control-Allow-Headers leaves out ${missing.join(", ")}` : null;
}

const headersFor = (caller: Caller, extra: Record<string, string> = {}) => ({ ...extra, ...(caller.origin ? { origin: caller.origin } : {}) });

async function preflight(fetcher: Fetch, base: string, caller: Caller) {
  const { response } = await send(fetcher, `${base}/.well-known/t3/environment`, {
    method: "OPTIONS",
    headers: headersFor(caller, { "access-control-request-method": "GET", "access-control-request-headers": requestedHeaders.join(",") }),
  });
  return statusProblem(response) ?? allowOriginProblem(response, caller.checkedAs) ?? allowHeadersProblem(response);
}

async function environment(fetcher: Fetch, base: string, caller: Caller, environmentId: string) {
  const { response, body } = await send(fetcher, `${base}/.well-known/t3/environment`, { headers: headersFor(caller, { accept: "application/json" }) });
  const problem = statusProblem(response) ?? allowOriginProblem(response, caller.checkedAs);
  if (problem) return problem;
  let descriptor: unknown;
  try {
    descriptor = JSON.parse(body);
  } catch {}
  const id = descriptor && typeof descriptor === "object" ? (descriptor as { environmentId?: unknown }).environmentId : undefined;
  if (typeof id !== "string") throw new Unreachable("The answer is not a T3 environment, so something other than VM Bridge answered.");
  if (id !== environmentId) throw new Unreachable("Another T3 server answered, so this address leads somewhere else.");
  return null;
}

/** Without a ticket VM Bridge refuses the socket with T3's auth error, which shows the path reaches it. */
async function socket(fetcher: Fetch, base: string) {
  const { response, body } = await send(fetcher, `${base}/ws?orchestrationProtocol=2`, {});
  let code: unknown;
  try {
    code = (JSON.parse(body) as { code?: unknown }).code;
  } catch {}
  if (response.status === 401 && code === "auth_invalid") return [];
  return [`A connection without a ticket should be refused with 401, but it answered ${response.status}.`];
}

/** Runs one step for every caller. A problem that is the same for every caller is listed once. */
async function forEachCaller(run: (caller: Caller) => Promise<string | null>) {
  const problems = new Set<string>();
  for (const caller of callers) {
    try {
      const problem = await run(caller);
      if (problem) problems.add(`${problem} ${caller.when}: ${caller.who} will fail.`);
    } catch (error) {
      problems.add(error instanceof Unreachable ? error.message : message(error));
    }
  }
  return [...problems];
}

/**
 * Connects to `base` from this server the way a T3 client does, so a tunnel or Tailscale address is reached through
 * the tunnel or tailnet. `environmentId` is this bridge's, to tell when an address leads to another server.
 */
export async function testAddress(base: string, environmentId: string, fetcher: Fetch = fetch): Promise<AddressTest> {
  const run = async (step: ConnectionStep, check: () => Promise<string[]>) => ({ step, problems: await check() });
  const steps = await Promise.all([
    run("preflight", () => forEachCaller((caller) => preflight(fetcher, base, caller))),
    run("environment", () => forEachCaller((caller) => environment(fetcher, base, caller, environmentId))),
    run("socket", () => socket(fetcher, base).catch((error) => [message(error)])),
  ]);
  return { url: base, steps };
}
