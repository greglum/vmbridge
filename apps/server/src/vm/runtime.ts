import type { Box } from "../providers/index.ts";

/** Everything VM Bridge installs or keeps lives here, on the disk that survives sleep. */
const root = "/workspace/.vmbridge";
export const t3Port = 3773;
export const t3DataDir = `${root}/t3`;
/** VM Bridge clones each project's repository here. */
export const checkoutRoot = "/workspace";

export const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** Credentials VM Bridge passes into a VM. Unset values leave whatever the provider supplies. */
export interface VmCredentials {
  github?: { token: string; login: string; email: string };
  anthropicApiKey?: string;
  claudeOAuthToken?: string;
  openaiApiKey?: string;
  codexAuthJson?: string;
}

function envFile(credentials: VmCredentials) {
  const vars: Record<string, string | undefined> = {
    T3CODE_HOME: `${root}/t3-home`,
    T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
    GH_TOKEN: credentials.github?.token,
    GITHUB_TOKEN: credentials.github?.token,
    ANTHROPIC_API_KEY: credentials.anthropicApiKey,
    CLAUDE_CODE_OAUTH_TOKEN: credentials.claudeOAuthToken,
    OPENAI_API_KEY: credentials.openaiApiKey,
    // Codex reads auth.json from CODEX_HOME. Point there only when VM Bridge supplies one.
    CODEX_HOME: credentials.codexAuthJson ? `${root}/codex` : undefined,
  };
  const lines = [`export PATH="${root}/node/bin:${root}/npm/bin:$PATH"`];
  for (const [name, value] of Object.entries(vars)) if (value) lines.push(`export ${name}=${quote(value)}`);
  return `${lines.join("\n")}\n`;
}

/** Idempotent: installs Node when missing, the exact `t3` version, the agent CLIs, and Git access. */
const setupScript = `#!/bin/bash
set -euo pipefail
umask 077
root=${root}
. "$root/env"
version="$1"

fetch() { if command -v curl >/dev/null; then curl -fsSL "$1"; else wget -qO- "$1"; fi; }

node_ok() {
  command -v node >/dev/null || return 1
  [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ]
}
if ! node_ok; then
  case "$(uname -m)" in x86_64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) echo "unsupported CPU" >&2; exit 70 ;; esac
  base=https://nodejs.org/dist/latest-v22.x
  file="$(fetch "$base/SHASUMS256.txt" | awk -v a="linux-$arch.tar.gz" '$2 ~ a { print $2 }')"
  rm -rf "$root/node" && mkdir -p "$root/node"
  fetch "$base/$file" | tar -xz -C "$root/node" --strip-components=1
fi

if ! command -v git >/dev/null; then
  if command -v sudo >/dev/null; then sudo -n apt-get update -qq && sudo -n apt-get install -y -qq git
  else apt-get update -qq && apt-get install -y -qq git; fi
fi

install() { npm install -g --prefix "$root/npm" --no-audit --no-fund --loglevel=error "$@"; }
installed="$(node -p "require('$root/npm/lib/node_modules/t3/package.json').version" 2>/dev/null || true)"
[ "$installed" = "$version" ] || install "t3@$version"
command -v codex >/dev/null || install @openai/codex
command -v claude >/dev/null || install @anthropic-ai/claude-code
# The npm launcher downloads the T3 runtime on first use. Do it now rather than during a request.
t3 --version >/dev/null

if [ -f "$root/github" ]; then
  . "$root/github"
  printf 'https://%s:%s@github.com\\n' "$GITHUB_LOGIN" "$GH_TOKEN" > "$root/git-credentials"
  printf '[credential "https://github.com"]\\n\\thelper =\\n\\thelper = store --file %s\\n[user]\\n\\tname = %s\\n\\temail = %s\\n' \\
    "$root/git-credentials" "$GITHUB_LOGIN" "$GITHUB_EMAIL" > "$root/gitconfig"
  git config --global --get-all include.path | grep -Fxq "$root/gitconfig" || git config --global --add include.path "$root/gitconfig"
else
  rm -f "$root/git-credentials" "$root/gitconfig"
fi
`;

const startScript = `#!/bin/bash
set -euo pipefail
root=${root}
data=${t3DataDir}
. "$root/env"
mkdir -p "$data"
# T3 refuses to start when a runtime record from before a VM stop names a dead or reused PID.
runtime="$data/userdata/server-runtime.json"
if [ -f "$runtime" ]; then
  pid="$(node -e 'try{const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).pid;if(Number.isSafeInteger(p))process.stdout.write(String(p))}catch{}' "$runtime")"
  if [ -z "$pid" ] || ! tr '\\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -q -- "$data"; then rm -f "$runtime"; fi
fi
cd /workspace
exec t3 --base-dir "$data" --host 0.0.0.0 --port ${t3Port} --no-browser
`;

const probe = `. ${root}/env && node -e 'fetch("http://127.0.0.1:${t3Port}/.well-known/t3/environment").then(r=>r.ok?r.text():Promise.reject()).then(t=>process.stdout.write(t),()=>process.exit(1))'`;

let latest: { version: string; at: number } | undefined;

/** Resolves the npm `t3` version to install: the pinned one, or the latest release. */
export async function resolveT3Version(pinned: string | null) {
  if (pinned) return pinned;
  if (latest && Date.now() - latest.at < 10 * 60_000) return latest.version;
  const response = await fetch("https://registry.npmjs.org/t3/latest", { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`npm registry answered ${response.status} for t3.`);
  const { version } = (await response.json()) as { version: string };
  latest = { version, at: Date.now() };
  return version;
}

async function check(box: Box, command: string, what: string, timeoutMs = 120_000) {
  const result = await box.run(command, { timeoutMs });
  // Only the tail: setup output is install noise, and the env file is never echoed.
  if (!result.ok) throw new Error(`${what} failed (exit ${result.exitCode}): ${result.output.slice(-600)}`);
  return result.stdout;
}

/** Writes credentials and scripts, then installs what is missing. Safe to repeat on every wake. */
export async function prepareVm(box: Box, t3Version: string, credentials: VmCredentials) {
  await box.run(`mkdir -p ${root} && chmod 700 ${root}`);
  const files: Record<string, string> = {
    [`${root}/env`]: envFile(credentials),
    [`${root}/setup.sh`]: setupScript,
    [`${root}/start-t3.sh`]: startScript,
  };
  const { github, codexAuthJson } = credentials;
  if (github) {
    files[`${root}/github`] = [
      `GITHUB_LOGIN=${quote(github.login)}`,
      `GITHUB_EMAIL=${quote(github.email)}`,
      `GH_TOKEN=${quote(github.token)}`,
      "",
    ].join("\n");
  }
  if (codexAuthJson) files[`${root}/codex/auth.json`] = codexAuthJson;
  await box.files.write(files, { mode: 0o600 });
  if (!github) await box.run(`rm -f ${root}/github`);
  await check(box, `bash ${root}/setup.sh ${quote(t3Version)}`, "VM setup", 10 * 60_000);
}

export interface T3Server {
  /** The server's `/.well-known/t3/environment` descriptor. */
  descriptor: { orchestrationProtocolVersion?: number; serverVersion?: string };
  token: string;
}

/** Starts the T3 server unless it already answers, and issues VM Bridge a session token when it has none. */
export async function startT3(box: Box, token: string | null): Promise<T3Server> {
  let answer = await box.run(probe, { timeoutMs: 15_000 });
  if (!answer.ok) {
    const options = {
      name: "t3",
      ready: { http: { port: t3Port, path: "/.well-known/t3/environment" } },
      readyTimeoutMs: 120_000,
    };
    try {
      await box.start(`bash ${root}/start-t3.sh`, options);
    } catch (error) {
      // A record left by a server that stopped answering: replace it.
      if (!(error instanceof Error && error.message.includes("already running"))) throw error;
      await box.process("t3").restart();
    }
    answer = await box.run(probe, { timeoutMs: 15_000 });
    if (!answer.ok) throw new Error("The T3 server started but does not answer. See its log in the VM.");
  }
  const descriptor = JSON.parse(answer.stdout) as T3Server["descriptor"];
  token ??= (
    await check(
      box,
      `. ${root}/env && t3 auth session issue --base-dir ${t3DataDir} --ttl 30d --label 'VM Bridge' --token-only`,
      "Issuing a T3 session",
    )
  ).trim();
  return { descriptor, token };
}
