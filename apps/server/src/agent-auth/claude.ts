// Claude sign-in that mints the same one-year, inference-only token `claude setup-token` does.
// Claude's code page shows the code to copy, so this works wherever the dashboard is open.
import { createHash, randomBytes } from "node:crypto";

const clientId = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const authorizeUrl = "https://claude.ai/oauth/authorize";
const tokenUrl = "https://platform.claude.com/v1/oauth/token";
/** Claude Code's manual redirect: the page shows `code#state` instead of calling back to a local port. */
const redirectUri = "https://platform.claude.com/oauth/code/callback";
const oneYearSeconds = 365 * 24 * 60 * 60;

export interface ClaudeSignIn {
  state: string;
  verifier: string;
  url: string;
}

export function startClaudeSignIn(): ClaudeSignIn {
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(32).toString("base64url");
  const params = new URLSearchParams({
    code: "true",
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: "user:inference",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state,
  });
  return { state, verifier, url: `${authorizeUrl}?${params}` };
}

/** Reads the code from what the person pasted: the code page's `code#state`, or the whole callback URL. */
export function parsePastedCode(text: string): { code: string; state: string | null } {
  const pasted = text.trim();
  if (pasted.includes("code=")) {
    // Address bars may drop the scheme when copying.
    const url = new URL(/^https?:\/\//.test(pasted) ? pasted : `http://${pasted}`);
    return { code: url.searchParams.get("code") ?? "", state: url.searchParams.get("state") };
  }
  const [code = "", state] = pasted.split("#");
  return { code, state: state || null };
}

export class ClaudeCodeRejected extends Error {}

/** Swaps an approved code for a one-year token, as `claude setup-token` does. Each code works once. */
export async function exchangeSetupToken(signIn: ClaudeSignIn, code: string) {
  let response: Response;
  try {
    response = await fetch(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: signIn.verifier,
        state: signIn.state,
        expires_in: oneYearSeconds,
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new ClaudeCodeRejected("Could not reach Claude.");
  }
  if (response.status === 400 || response.status === 401) throw new ClaudeCodeRejected("Claude did not accept that code. Start again.");
  if (!response.ok) throw new ClaudeCodeRejected(`Claude answered ${response.status}.`);
  const body = (await response.json()) as { access_token?: string; account?: { email_address?: string } };
  if (!body.access_token) throw new ClaudeCodeRejected("Claude sent no token.");
  return { token: body.access_token, email: body.account?.email_address ?? null };
}
