import { SandboxError, type ErrorCode } from "@opencoredev/sandbox-sdk";
import {
  createHttpClient,
  type ExecInput,
  type ExecResult,
  type Fetch,
  type FileInfo,
  type HttpClient,
  type HttpFailure,
  type Provider,
  type SandboxInfo,
} from "@opencoredev/sandbox-sdk/provider";
import { execLine } from "./boxd-web.ts";
import { sdkDriver } from "./sdk.ts";
import { required, type ProviderDefinition } from "./types.ts";

/**
 * Kubi (trykubi.com) over its HTTP API, as a sandbox-sdk provider, so the SDK builds the same `Box` on top. Kubi's own
 * SDK has no ports, which VM Bridge needs to reach T3, so this calls the API with fetch.
 *
 * A screen is a Debian desktop VM. Commands run with `bash -lc` as the desktop user, who has passwordless sudo. Labels are
 * native, so the SDK key and VM Bridge's labels live on the screen. Kubi cannot pause: stop and start (a full reboot)
 * stand in for the SDK's pause and resume, so nothing in memory survives a sleep and T3 starts again on every wake.
 */

export type ScreenKind = "persistent" | "disposable";

/** The permissions VM Bridge needs: list, run commands and move files, stop and start, and open T3's port. */
export const kubiPermissions = ["read", "exec", "power", "network"] as const;

interface Screen {
  id: string;
  state: string;
  labels: Record<string, string>;
  operation_id: string | null;
  created_at: string;
}

interface Operation {
  id: string;
  status: string;
  screen_id: string;
  error: { message?: string } | null;
}

interface Exec {
  id: string;
  status: string;
  exit_code: number | null;
  stdout: string;
  stderr: string;
}

interface Me {
  credential: { permissions: string[] };
  screens: { count: number; cap: number };
}

export type KubiProvider = Provider<{ client: HttpClient<"api"> }, "pause"> & {
  /** Throws a readable error when the key is refused or lacks a permission VM Bridge needs. */
  verify(): Promise<void>;
  /** A one-use ticket for a view-only stream of the screen, or null while it is not running. Never starts it. */
  viewerTicket(id: string): Promise<string | null>;
};

const apiUrl = "https://api.trykubi.com/v1";

/** Where a viewer ticket opens the screen's stream: a WebSocket carrying RFB 3.8, with the ticket as a subprotocol. */
export const viewerUrl = (id: string) => new URL(`wss://api.trykubi.com/v1/screens/${encodeURIComponent(id)}/viewer`);

export interface KubiOptions {
  apiKey: string;
  kind: ScreenKind;
  /** For tests. Default: the global `fetch`. */
  fetch?: Fetch;
}

const keyLabel = "sandbox-sdk-key";
const inputDir = "/tmp/.sandbox-sdk/input";
/** Kubi's cap on an exec's command. The SDK's background process start alone is about 15000 characters. */
const commandLimit = 10_000;
const notFoundMarker = "SDK_FILE_NOT_FOUND";
// Kubi answers a call within 30 s, and long polls hold it for up to 25.
const longPollS = 25;
const callTimeoutMs = 45_000;
/** A boot measured 13 s and a reboot about 20 s. */
const settleTimeoutMs = 3 * 60_000;

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
const fail = (message: string, code: ErrorCode, sandboxId?: string) => new SandboxError(message, { code, provider: "kubi", sandboxId });

/** What Kubi said about a failed call, kept as the error's cause. Only codes and validated details, never body text. */
export class KubiProblem extends Error {
  constructor(
    readonly status: number,
    readonly kubiCode: string | undefined,
    readonly needed: string | undefined,
    readonly screenCap: number | undefined,
  ) {
    super(`HTTP ${status}${kubiCode ? ` ${kubiCode}` : ""}`);
  }
}

function problem(failure: HttpFailure) {
  if (failure.kind !== "status") return undefined;
  const json = failure.body.json;
  const details = typeof json === "object" && json && "error" in json && typeof json.error === "object" && json.error && "details" in json.error ? json.error.details : undefined;
  const detail = (key: string) => (typeof details === "object" && details && key in details ? (details as Record<string, unknown>)[key] : undefined);
  const needed = detail("needed");
  const screenCap = detail("screen_cap");
  const code = failure.body.code;
  return new KubiProblem(
    failure.status,
    code && /^[A-Z_]{1,63}$/.test(code) ? code : undefined,
    typeof needed === "string" && /^[a-z]{1,10}$/.test(needed) ? needed : undefined,
    typeof screenCap === "number" ? screenCap : undefined,
  );
}

const missing = (permissions: string[]) =>
  `The Kubi API key is missing the ${permissions.join(" and ")} permission${permissions.length > 1 ? "s" : ""}. ` +
  "Create a key in the Kubi dashboard with read, exec, power and network ticked.";

/** Turns Kubi's answers that need a person into messages that say what to do. Anything else stays as the SDK words it. */
export function kubiError(error: unknown): unknown {
  if (!(error instanceof SandboxError) || !(error.cause instanceof KubiProblem)) return error;
  const { kubiCode, needed, screenCap } = error.cause;
  const message = (() => {
    switch (kubiCode) {
      case "UNAUTHENTICATED":
        return "Kubi refused the API key. Check it, or create a new one in the Kubi dashboard.";
      case "PERMISSION_DENIED":
        return needed ? missing([needed]) : undefined;
      case "QUOTA_EXCEEDED":
        return screenCap === undefined
          ? undefined
          : `Your Kubi account's machine limit (${screenCap}) is reached. Delete a screen, or ask Kubi to raise the limit.`;
      case "SUBSCRIPTION_REQUIRED":
        return "Kubi needs a paid persistent screen before it sells usage credit. Subscribe in the Kubi dashboard.";
      case "CREDIT_EXHAUSTED":
        return "Your Kubi usage credit, which pays for disposable VMs, is used up. Top it up in the Kubi dashboard.";
      case "SCREEN_NOT_RUNNING":
        return "The Kubi screen is not running.";
      default:
        return undefined;
    }
  })();
  if (!message) return error;
  return new SandboxError(message, { code: error.code, provider: "kubi", sandboxId: error.sandboxId, cause: error });
}

/** Kubi's power states as the SDK's: anything that can still be started counts as paused. */
function stateOf(state: string): SandboxInfo["state"] {
  if (state === "running") return "running";
  if (state === "failed" || state === "deleting" || state === "deleted") return "stopped";
  return "paused";
}

const gone = (state: string) => state === "deleting" || state === "deleted";

function info(screen: Screen): SandboxInfo {
  const { [keyLabel]: key, ...labels } = screen.labels;
  return { id: screen.id, key, labels, state: stateOf(screen.state), createdAt: Date.parse(screen.created_at) };
}

const entryType = (type: string): FileInfo["type"] => (type === "dir" ? "directory" : type === "symlink" ? "symlink" : "file");

export function kubi(options: KubiOptions): KubiProvider {
  const { apiKey, kind } = options;
  const client = createHttpClient({
    provider: "kubi",
    label: "Kubi",
    planes: { api: { baseUrl: apiUrl, auth: () => ({ authorization: `Bearer ${apiKey}` }) } },
    defaultPlane: "api",
    fetch: options.fetch,
    timeoutMs: callTimeoutMs,
    secrets: () => [apiKey],
    authHint: "Create a key in the Kubi dashboard with read, exec, power and network ticked.",
    mapError: (failure) => {
      if (failure.kind !== "status") return undefined;
      if (failure.body.code === "FILE_NOT_FOUND") return "file_not_found";
      // A stop or start still running. The SDK's resume loop waits and tries again.
      if (failure.body.code === "OPERATION_IN_PROGRESS") return "invalid_argument";
      return undefined;
    },
    cause: problem,
  });

  const call = async <T>(request: () => Promise<T>): Promise<T> => {
    try {
      return await request();
    } catch (error) {
      throw kubiError(error);
    }
  };

  const json = async <T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, sandboxId?: string, query?: Record<string, string | number | undefined>, body?: unknown) =>
    (await client.request({ method, path, sandboxId, query, body })).json() as T;

  const screen = (id: string) => json<Screen>("GET", `/screens/${encodeURIComponent(id)}`, id);

  /** Waits for a stop, start, create or delete to finish. */
  async function settle(operationId: string, sandboxId?: string) {
    const deadline = Date.now() + settleTimeoutMs;
    while (Date.now() < deadline) {
      const operation = await json<Operation>("GET", `/operations/${encodeURIComponent(operationId)}`, sandboxId, { wait_s: longPollS });
      if (operation.status === "succeeded") return operation;
      if (operation.status === "failed") throw fail(`Kubi could not finish the operation: ${operation.error?.message ?? "no reason given"}`, "provider", sandboxId);
    }
    throw fail("Kubi did not finish the operation within 3 minutes.", "timeout", sandboxId);
  }

  /** Waits out any operation on the screen, then returns it. */
  async function settled(id: string) {
    let current = await screen(id);
    if (current.operation_id) {
      await settle(current.operation_id, id).catch(() => undefined);
      current = await screen(id);
    }
    return current;
  }

  /** Every screen carrying `labels`. Kubi filters by one label, the rest are checked here. */
  async function screens(labels: Record<string, string>) {
    const [first] = Object.entries(labels);
    const found: Screen[] = [];
    let after: string | undefined;
    do {
      const page = await json<{ data: Screen[]; next: string | null }>("GET", "/screens", undefined, {
        label: first ? `${first[0]}:${first[1]}` : undefined,
        limit: 100,
        after,
      });
      found.push(...page.data);
      after = page.next ?? undefined;
    } while (after);
    return found.filter((entry) => !gone(entry.state) && Object.entries(labels).every(([key, value]) => entry.labels[key] === value));
  }

  /** Runs one command and waits for it, sending its output to `onChunk` as it arrives. */
  async function run(id: string, command: string, timeoutS: number, onChunk?: ExecInput["onChunk"]) {
    let stdoutFrom = 0;
    let stderrFrom = 0;
    const take = (exec: Exec) => {
      stdoutFrom += Buffer.byteLength(exec.stdout);
      stderrFrom += Buffer.byteLength(exec.stderr);
      if (exec.stdout) onChunk?.({ stream: "stdout", text: exec.stdout });
      if (exec.stderr) onChunk?.({ stream: "stderr", text: exec.stderr });
    };
    let exec = await json<Exec>("POST", `/screens/${encodeURIComponent(id)}/exec`, id, undefined, {
      command,
      timeout_s: timeoutS,
      wait_s: longPollS,
      max_bytes: 1_048_576,
    });
    take(exec);
    while (exec.status === "running") {
      exec = await json<Exec>("GET", `/screens/${encodeURIComponent(id)}/exec/${encodeURIComponent(exec.id)}`, id, {
        wait_s: longPollS,
        stdout_from: stdoutFrom,
        stderr_from: stderrFrom,
        max_bytes: 1_048_576,
      });
      take(exec);
    }
    if (exec.status === "lost") throw fail("The Kubi screen restarted while a command ran.", "provider", id);
    return exec;
  }

  /** Runs a short guest command and returns its stdout. Any failure is the operation's failure. */
  async function raw(id: string, command: string) {
    let stdout = "";
    const exec = await run(id, command, 60, (chunk) => {
      if (chunk.stream === "stdout") stdout += chunk.text;
    });
    if (exec.exit_code !== 0) throw fail("Guest operation failed", "provider", id);
    return stdout;
  }

  const writeFile = (id: string, path: string, data: Uint8Array, mode?: number) =>
    client.request({
      method: "PUT",
      path: `/screens/${encodeURIComponent(id)}/files`,
      sandboxId: id,
      query: { path, mode: mode === undefined ? undefined : mode.toString(8).padStart(4, "0") },
      body: data,
      headers: { "content-type": "application/octet-stream" },
    });

  async function exec(id: string, input: ExecInput): Promise<ExecResult> {
    if (input.signal?.aborted) return { exitCode: null, timedOut: true };
    const tag = `vmbridge-exec-${crypto.randomUUID()}`;
    // Stdin, and a command line over Kubi's cap, go up as files the command removes as it starts. Until then they can
    // hold sign-ins, so only the VM's user can read them, and they are removed below if the command never ran. Files,
    // not Kubi's stdin field, which takes 64 KiB at most.
    const uploads: string[] = [];
    const upload = async (text: (path: string) => string) => {
      const path = `${inputDir}/${crypto.randomUUID()}`;
      uploads.push(path);
      await writeFile(id, path, new TextEncoder().encode(text(path)), 0o600);
      return path;
    };
    let ran = false;
    let onAbort = () => {};
    try {
      const stdin = input.stdin;
      const stdinPath = stdin ? await upload(() => stdin) : undefined;
      let line = execLine(input, stdinPath, tag);
      if (line.length > commandLimit) {
        // `sh` keeps reading the script it opened after the script removes itself.
        const long = line;
        const script = await upload((path) => `rm -f -- ${quote(path)}\n${long}\n`);
        line = `exec sh ${quote(script)}`;
      }
      const started = Date.now();
      // Kubi's own limit only backs up `timeout` in the guest, which ends the command and its children first.
      const running = run(id, line, Math.ceil(input.timeoutMs / 1000) + 15, input.onChunk);
      running.catch(() => {});
      const aborted = new Promise<"aborted">((resolve) => {
        onAbort = () => resolve("aborted");
        input.signal?.addEventListener("abort", onAbort, { once: true });
      });
      const outcome = await Promise.race([running, aborted]);
      if (outcome === "aborted") {
        // As in boxd-web.ts: `[v]` keeps the pattern from matching the kill itself, and `timeout` leads the group.
        const pattern = quote(`[v]${tag.slice(1)}`);
        await raw(id, `for p in $(pgrep -f ${pattern}); do kill -9 -"$p" 2>/dev/null; kill -9 "$p" 2>/dev/null; done; true`);
        return { exitCode: null, timedOut: true };
      }
      ran = true;
      // 124 is `timeout`'s own exit code, 137 its kill after the grace period.
      const timedOut =
        outcome.status === "timed_out" || ((outcome.exit_code === 124 || outcome.exit_code === 137) && Date.now() - started >= input.timeoutMs);
      return { exitCode: timedOut ? null : outcome.exit_code, timedOut };
    } finally {
      input.signal?.removeEventListener("abort", onAbort);
      if (uploads.length > 0 && !ran) await raw(id, `rm -f -- ${uploads.map(quote).join(" ")}`).catch(() => {});
    }
  }

  async function stat(id: string, path: string): Promise<FileInfo> {
    const out = await raw(id, `if [ ! -e ${quote(path)} ] && [ ! -L ${quote(path)} ]; then echo ${notFoundMarker}; else stat -c '%F|%s|%Y' -- ${quote(path)}; fi`);
    if (out.trim() === notFoundMarker) throw fail("File does not exist", "file_not_found", id);
    const [type = "", size = "0", modified = "0"] = out.trim().split("|");
    return {
      path,
      type: type === "directory" ? "directory" : type === "symbolic link" ? "symlink" : "file",
      size: Number(size),
      modifiedAt: Number(modified) * 1000,
    };
  }

  async function list(id: string, path: string): Promise<FileInfo[]> {
    const entries: FileInfo[] = [];
    let after: string | undefined;
    do {
      const page = await json<{ data: { name: string; type: string; size_bytes: number; modified_at: string }[]; next: string | null }>(
        "GET",
        `/screens/${encodeURIComponent(id)}/dir`,
        id,
        { path, limit: 1000, after },
      );
      for (const entry of page.data) {
        entries.push({
          path: `${path.replace(/\/+$/, "")}/${entry.name}`,
          type: entryType(entry.type),
          size: entry.size_bytes,
          modifiedAt: Date.parse(entry.modified_at),
        });
      }
      after = page.next ?? undefined;
    } while (after);
    return entries;
  }

  /** Stops a screen and waits until it is stopped. One already stopped is fine. */
  async function stop(id: string) {
    const current = await settled(id);
    if (current.state === "stopped") return;
    await settle((await json<Operation>("POST", `/screens/${encodeURIComponent(id)}/stop`, id)).id, id);
  }

  /** Starts a screen and waits until it runs. One still stopping is started once the stop is done. */
  async function start(id: string) {
    const current = await settled(id);
    if (current.state === "running") return;
    await settle((await json<Operation>("POST", `/screens/${encodeURIComponent(id)}/start`, id)).id, id);
  }

  return {
    name: "kubi",
    keyMode: "best-effort",
    capabilities: new Set(["pause"] as const),

    verify: () =>
      call(async () => {
        const me = await json<Me>("GET", "/me");
        const absent = kubiPermissions.filter((permission) => !me.credential.permissions.includes(permission));
        if (absent.length) throw fail(missing(absent), "auth");
      }),

    create: (input) =>
      call(async () => {
        if (input.from !== undefined) throw fail("Kubi snapshots are not supported here", "unsupported");
        if (Object.keys(input.env ?? {}).length > 0) throw fail("Kubi sets no environment at create", "unsupported");
        const operation = await json<Operation>("POST", "/screens", undefined, undefined, {
          kind,
          labels: { ...input.labels, ...(input.key ? { [keyLabel]: input.key } : {}) },
        });
        const id = operation.screen_id;
        try {
          await settle(operation.id, id);
          // The SDK runs commands in /workspace, which the desktop user cannot create alone.
          await raw(id, `sudo -n install -d -o "$(id -u)" -g "$(id -g)" /workspace && mkdir -p /tmp/.sandbox-sdk`);
          return info(await screen(id));
        } catch (error) {
          await client.cleanup({ method: "DELETE", path: `/screens/${encodeURIComponent(id)}`, sandboxId: id }).catch(() => {});
          throw error;
        }
      }),

    find: (key) => call(async () => (await screens({ [keyLabel]: key })).map(info)[0]),

    connect: (id) =>
      call(async () => {
        const current = await screen(id);
        if (gone(current.state)) throw fail("The Kubi screen was deleted", "not_found", id);
        return info(current);
      }),

    list: (labels) => call(async () => (await screens(labels)).filter((entry) => keyLabel in entry.labels).map(info)),

    destroy: (id) =>
      call(async () => {
        const operation = await json<Operation>("DELETE", `/screens/${encodeURIComponent(id)}`, id);
        // Until the delete is done the screen still counts toward the account's limit.
        await settle(operation.id, id);
      }),

    exec: (id, input) => call(() => exec(id, input)),

    files: {
      writeCreatesParents: true,
      writeSupportsMode: true,
      read: (id, path) =>
        call(async () => (await client.request({ method: "GET", path: `/screens/${encodeURIComponent(id)}/files`, sandboxId: id, query: { path } })).body),
      write: (id, path, data, writeOptions) => call(async () => void (await writeFile(id, path, data, writeOptions?.mode))),
      stat: (id, path) => call(() => stat(id, path)),
      list: (id, path) => call(() => list(id, path)),
      mkdir: (id, path) => call(async () => void (await raw(id, `mkdir -p -- ${quote(path)}`))),
      remove: (id, path, { recursive }) =>
        call(async () => {
          const out = await raw(
            id,
            `if [ ! -e ${quote(path)} ] && [ ! -L ${quote(path)} ]; then echo ${notFoundMarker}; else rm -f${recursive ? "r" : ""} -- ${quote(path)}; fi`,
          );
          if (out.trim() === notFoundMarker) throw fail("File does not exist", "file_not_found", id);
        }),
    },

    // A token port: every request carries the token in a header. The URL and token stay the same across stop and start.
    previewUrl: (id, port) =>
      call(async () => {
        const opened = await json<{ url: string; token: string }>("PUT", `/screens/${encodeURIComponent(id)}/ports/${port}`, id, undefined, {
          access: "token",
        });
        return { url: opened.url, headers: { "Kubi-Port-Token": opened.token } };
      }),

    native: () => ({ client }),

    // A view link is good once, within 60 s, for a session of up to 60 minutes. Its ticket rides in the link's fragment.
    viewerTicket: (id) =>
      call(async () => {
        let link: string;
        try {
          link = (await json<{ url: string }>("POST", `/screens/${encodeURIComponent(id)}/viewer`, id, undefined, { mode: "view" })).url;
        } catch (error) {
          if (error instanceof SandboxError && error.cause instanceof KubiProblem && error.cause.kubiCode === "SCREEN_NOT_RUNNING") return null;
          throw error;
        }
        const ticket = new URLSearchParams(URL.parse(link)?.hash.slice(1)).get("t");
        if (!ticket || !/^vt_[\w-]{1,100}$/.test(ticket)) throw fail("Kubi's live view link has no ticket", "provider", id);
        return ticket;
      }),

    pause: (id) => call(() => stop(id)),
    resume: (id) => call(() => start(id)),
  };
}

export const kubiProvider: ProviderDefinition = {
  id: "kubi",
  label: "Kubi",
  website: "https://trykubi.com",
  fields: [
    {
      key: "apiKey",
      label: "API key",
      kind: "secret",
      required: true,
      placeholder: "kubi_...",
      help: "Create a key in the Kubi dashboard with read, exec, power and network ticked.",
    },
    {
      key: "kind",
      label: "VM kind",
      kind: "select",
      required: false,
      options: [
        { value: "persistent", label: "Persistent" },
        { value: "disposable", label: "Disposable" },
      ],
      help: "A disposable VM is deleted after 7 days asleep.",
    },
  ],
  features: {
    // Kubi cannot pause. Stop keeps the disk; memory and processes go, and T3 starts again on wake.
    sleep: "stop",
    keepsDisk: true,
    keepsMemory: false,
  },
  // Kubi sells one machine.
  sizes: { small: "4 vCPU, 8 GB", medium: "4 vCPU, 8 GB", large: "4 vCPU, 8 GB" },
  defaultSize: "medium",
  screen: true,

  open(config) {
    const provider = kubi({
      apiKey: required(config, "apiKey", "Kubi API key"),
      kind: config.values.kind === "disposable" ? "disposable" : "persistent",
    });
    return {
      ...sdkDriver({ id: "kubi", provider, sleep: "pause" }),
      verify: provider.verify,
      screen: async (sandboxId) => {
        const ticket = await provider.viewerTicket(sandboxId);
        return ticket ? { url: viewerUrl(sandboxId), protocols: ["kubi.v1", ticket] } : null;
      },
    };
  },
};
