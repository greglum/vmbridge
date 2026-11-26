// ChatGPT sign-in for Codex, the same device flow `codex login --device-auth` runs.
// The saved file is a Codex `auth.json`, so VMs use it as is.

const issuer = "https://auth.openai.com";
const clientId = "app_EMoamEEZ73f0CkXaXp7hrann";
export const verificationUrl = `${issuer}/codex/device`;
/** Codex gives up on a device code after 15 minutes. */
export const deviceCodeTtlMs = 15 * 60_000;

export interface CodexAuthFile {
  auth_mode: "chatgpt";
  OPENAI_API_KEY: null;
  tokens: { id_token: string; access_token: string; refresh_token: string; account_id: string | null };
  last_refresh: string;
}

/** A refresh token that can never work again. The person has to sign in again. */
export class SignInExpired extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function claims(jwt: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString());
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function codexAccount(file: CodexAuthFile) {
  const id = claims(file.tokens.id_token);
  const auth = isRecord(id["https://api.openai.com/auth"]) ? id["https://api.openai.com/auth"] : undefined;
  const exp = claims(file.tokens.access_token).exp;
  return {
    email: typeof id.email === "string" ? id.email : null,
    accountId: file.tokens.account_id ?? (typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : null),
    expiresAt: typeof exp === "number" ? exp * 1000 : null,
  };
}

/**
 * Parses a Codex auth.json, or returns null when it is not a ChatGPT sign-in. Only the sign-in's own fields are kept:
 * a VM writes this file, and anything else in it (an `OPENAI_API_KEY`, another `auth_mode`) would reach every VM.
 */
export function parseCodexAuth(text: string): CodexAuthFile | null {
  let file: unknown;
  try {
    file = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(file) || !isRecord(file.tokens)) return null;
  const { id_token, access_token, refresh_token, account_id } = file.tokens;
  const { last_refresh } = file;
  if (typeof id_token !== "string" || typeof access_token !== "string" || typeof refresh_token !== "string") return null;
  if (!id_token || !access_token || !refresh_token || typeof last_refresh !== "string" || !last_refresh) return null;
  return {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: { id_token, access_token, refresh_token, account_id: typeof account_id === "string" ? account_id : null },
    last_refresh,
  };
}

function authFile(tokens: { id_token: string; access_token: string; refresh_token: string }): CodexAuthFile {
  const file: CodexAuthFile = {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: { ...tokens, account_id: null },
    last_refresh: new Date().toISOString(),
  };
  file.tokens.account_id = codexAccount(file).accountId;
  return file;
}

function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function post(url: string, body: Record<string, string>, form = false, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(30_000);
  return fetch(url, {
    method: "POST",
    headers: { "content-type": form ? "application/x-www-form-urlencoded" : "application/json" },
    body: form ? new URLSearchParams(body) : JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
}

export interface DeviceCode {
  deviceAuthId: string;
  userCode: string;
  intervalMs: number;
}

export async function requestDeviceCode(): Promise<DeviceCode> {
  const response = await post(`${issuer}/api/accounts/deviceauth/usercode`, { client_id: clientId });
  if (!response.ok) throw new Error(`OpenAI answered ${response.status} when starting the sign-in.`);
  const body: unknown = await response.json();
  if (!isRecord(body)) throw new Error("OpenAI sent an unexpected sign-in code.");
  const userCode = typeof body.user_code === "string" ? body.user_code : typeof body.usercode === "string" ? body.usercode : "";
  if (typeof body.device_auth_id !== "string" || !body.device_auth_id || !userCode) throw new Error("OpenAI sent an unexpected sign-in code.");
  const seconds = typeof body.interval === "number" || typeof body.interval === "string" ? Number(body.interval) : Number.NaN;
  return { deviceAuthId: body.device_auth_id, userCode, intervalMs: (Number.isFinite(seconds) && seconds > 0 ? seconds : 5) * 1000 };
}

/** Waits until the person approves the code in their browser, then trades it for tokens. */
export async function completeDeviceCode(code: DeviceCode, signal: AbortSignal): Promise<CodexAuthFile> {
  const deadline = Date.now() + deviceCodeTtlMs;
  let approved: { authorization_code: string; code_verifier: string } | undefined;
  while (!approved) {
    signal.throwIfAborted();
    if (Date.now() > deadline) throw new Error("The code expired. Start again.");
    const response = await post(
      `${issuer}/api/accounts/deviceauth/token`,
      { device_auth_id: code.deviceAuthId, user_code: code.userCode },
      false,
      signal,
    );
    // 403 and 404 mean the person has not approved the code yet.
    if (response.status === 403 || response.status === 404) await sleepAbortable(code.intervalMs, signal);
    else if (!response.ok) throw new Error(`OpenAI answered ${response.status} while waiting for the sign-in.`);
    else {
      const body: unknown = await response.json();
      if (
        !isRecord(body) ||
        typeof body.authorization_code !== "string" ||
        !body.authorization_code ||
        typeof body.code_verifier !== "string" ||
        !body.code_verifier
      ) {
        throw new Error("OpenAI sent an unexpected sign-in response.");
      }
      approved = { authorization_code: body.authorization_code, code_verifier: body.code_verifier };
    }
  }
  signal.throwIfAborted();
  const response = await post(
    `${issuer}/oauth/token`,
    {
      grant_type: "authorization_code",
      code: approved.authorization_code,
      redirect_uri: `${issuer}/deviceauth/callback`,
      client_id: clientId,
      code_verifier: approved.code_verifier,
    },
    true,
    signal,
  );
  if (!response.ok) throw new Error(`OpenAI answered ${response.status} when finishing the sign-in.`);
  const tokens: unknown = await response.json();
  signal.throwIfAborted();
  if (
    !isRecord(tokens) ||
    typeof tokens.id_token !== "string" ||
    !tokens.id_token ||
    typeof tokens.access_token !== "string" ||
    !tokens.access_token ||
    typeof tokens.refresh_token !== "string" ||
    !tokens.refresh_token
  ) {
    throw new Error("OpenAI sent incomplete sign-in tokens.");
  }
  return authFile({ id_token: tokens.id_token, access_token: tokens.access_token, refresh_token: tokens.refresh_token });
}

/**
 * The ChatGPT accounts an access token can use, from the endpoint Codex checks accounts with
 * (`get_accounts_check` in codex-rs/backend-client). It only reads, so unlike a refresh it never rotates
 * tokens someone else holds. Throws when ChatGPT does not accept the token.
 */
export async function codexTokenAccounts(accessToken: string): Promise<string[]> {
  const response = await fetch("https://chatgpt.com/backend-api/wham/accounts/check", {
    headers: { authorization: `Bearer ${accessToken}`, "user-agent": "codex-cli" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`ChatGPT answered ${response.status} when checking the account.`);
  const body: unknown = await response.json();
  const accounts = isRecord(body) && Array.isArray(body.accounts) ? body.accounts : [];
  return accounts.flatMap((account) => (isRecord(account) && typeof account.id === "string" && !account.is_deactivated ? [account.id] : []));
}

/** Trades the refresh token for new tokens. OpenAI rotates refresh tokens, so the old one stops working. */
export async function refreshCodexAuth(file: CodexAuthFile): Promise<CodexAuthFile> {
  const response = await post(`${issuer}/oauth/token`, {
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: file.tokens.refresh_token,
  });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => ({}));
    const record = isRecord(body) ? body : {};
    const error = record.error;
    const code =
      typeof error === "string" && error
        ? error
        : isRecord(error) && typeof error.code === "string"
          ? error.code
          : typeof record.code === "string"
            ? record.code
            : undefined;
    const permanent =
      response.status === 401 ||
      ["refresh_token_expired", "refresh_token_reused", "refresh_token_invalidated"].includes(code ?? "") ||
      (response.status === 400 && code === "invalid_grant");
    if (permanent) throw new SignInExpired("This ChatGPT sign-in expired. Sign in again.");
    throw new Error(`OpenAI answered ${response.status} when refreshing the sign-in.`);
  }
  const fresh: unknown = await response.json();
  if (!isRecord(fresh)) throw new Error("OpenAI sent an unexpected refresh response.");
  return authFile({
    id_token: typeof fresh.id_token === "string" && fresh.id_token ? fresh.id_token : file.tokens.id_token,
    access_token: typeof fresh.access_token === "string" && fresh.access_token ? fresh.access_token : file.tokens.access_token,
    refresh_token: typeof fresh.refresh_token === "string" && fresh.refresh_token ? fresh.refresh_token : file.tokens.refresh_token,
  });
}
