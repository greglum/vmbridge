import type { AgentSecrets } from "../agent-auth/profiles.ts";
import type { Box } from "../providers/index.ts";

/** Everything VM Bridge installs or keeps lives here, on the disk that survives sleep. */
const root = "/workspace/.vmbridge";
export const t3Port = 3773;
export const t3DataDir = `${root}/t3`;
/** VM Bridge clones each project's repository here. */
export const checkoutRoot = "/workspace";

export const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

const codexAuthPath = `${root}/codex/auth.json`;

const gitConfigPath = `${root}/gitconfig`;
const gitCredentialsPath = `${root}/git-credentials`;

/** Credentials VM Bridge passes into a VM. Agents and git use only these, never the provider's. */
export interface VmCredentials extends AgentSecrets {
  github?: { token: string; login: string; name: string; email: string };
}

/** Sign-in variables a provider may set on its machines. VM Bridge clears them and sets its own. */
const providerVars = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "OPENCODE_API_KEY",
];

function envFile(credentials: VmCredentials) {
  const vars: Record<string, string | undefined> = {
    T3CODE_HOME: `${root}/t3-home`,
    T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
    GH_TOKEN: credentials.github?.token,
    GITHUB_TOKEN: credentials.github?.token,
    // Agents run without a terminal: fail fast instead of waiting for a password.
    GIT_TERMINAL_PROMPT: "0",
    // gh, Codex and Claude keep sign-ins and sessions in these folders instead of the home folder,
    // where a provider may have put its own sign-ins.
    GH_CONFIG_DIR: `${root}/gh-config`,
    CODEX_HOME: `${root}/codex`,
    CLAUDE_CONFIG_DIR: `${root}/claude`,
    CLAUDE_CODE_OAUTH_TOKEN: credentials.claudeOAuthToken,
    ANTHROPIC_AUTH_TOKEN: credentials.anthropicAuthToken,
    ANTHROPIC_BASE_URL: credentials.anthropicBaseUrl,
    OPENCODE_API_KEY: credentials.opencodeApiKey,
  };
  const lines = [`unset ${providerVars.join(" ")}`, `export PATH="${root}/node/bin:${root}/npm/bin:${root}/gh/bin:$PATH"`];
  for (const [name, value] of Object.entries(vars)) if (value) lines.push(`export ${name}=${quote(value)}`);
  return `${lines.join("\n")}\n`;
}

/** A git config value, quoted so names with spaces, quotes or `#` survive. */
const gitValue = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

/**
 * Git setup every VM includes from its global config. The empty helper drops any credential helper
 * the provider set for github.com, so git only ever uses VM Bridge's token.
 */
function gitConfig(github: VmCredentials["github"]) {
  const lines = ['[credential "https://github.com"]', "\thelper ="];
  if (github) {
    lines.push(
      `\thelper = store --file ${gitCredentialsPath}`,
      "[user]",
      `\tname = ${gitValue(github.name)}`,
      `\temail = ${gitValue(github.email)}`,
      // SSH remotes go over HTTPS with the token: VMs have no SSH key for GitHub.
      '[url "https://github.com/"]',
      "\tinsteadOf = git@github.com:",
      "\tinsteadOf = ssh://git@github.com/",
    );
  }
  return `${lines.join("\n")}\n`;
}

/** Idempotent: installs Node when missing, the exact `t3` version, the agent CLIs, gh, and Git access. */
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

# The GitHub CLI, for agents opening pull requests. It signs in with GH_TOKEN.
if [ ! -x "$root/gh/bin/gh" ]; then
  case "$(uname -m)" in x86_64) gharch=amd64 ;; aarch64|arm64) gharch=arm64 ;; *) echo "unsupported CPU" >&2; exit 70 ;; esac
  tag="$(node -e 'fetch("https://api.github.com/repos/cli/cli/releases/latest",{headers:process.env.GH_TOKEN?{authorization:"Bearer "+process.env.GH_TOKEN}:{}}).then(r=>r.ok?r.json():Promise.reject(r.status)).then(j=>process.stdout.write(j.tag_name),e=>{console.error("GitHub CLI release lookup failed:",e);process.exit(1)})')"
  rm -rf "$root/gh" && mkdir -p "$root/gh"
  fetch "https://github.com/cli/cli/releases/download/$tag/gh_\${tag#v}_linux_$gharch.tar.gz" | tar -xz -C "$root/gh" --strip-components=1
fi
mkdir -p "$root/gh-config"

install() { npm install -g --prefix "$root/npm" --no-audit --no-fund --loglevel=error "$@"; }
installed="$(node -p "require('$root/npm/lib/node_modules/t3/package.json').version" 2>/dev/null || true)"
[ "$installed" = "$version" ] || install "t3@$version"
command -v codex >/dev/null || install @openai/codex
command -v claude >/dev/null || install @anthropic-ai/claude-code
[ -z "\${OPENCODE_API_KEY:-}" ] || command -v opencode >/dev/null || install opencode-ai
mkdir -p "$root/codex" "$root/claude"
[ -n "\${CODEX_AUTH:-}" ] || rm -f "$root/codex/auth.json"
# The npm launcher downloads the T3 runtime on first use. Do it now rather than during a request.
t3 --version >/dev/null

git config --global --get-all include.path | grep -Fxq "$root/gitconfig" || git config --global --add include.path "$root/gitconfig"
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
  files[gitConfigPath] = gitConfig(github);
  if (github) files[gitCredentialsPath] = `https://${encodeURIComponent(github.login)}:${encodeURIComponent(github.token)}@github.com\n`;
  if (codexAuthJson) files[codexAuthPath] = codexAuthJson;
  await box.files.write(files, { mode: 0o600 });
  // Older versions kept the token in this file too.
  await box.run(`rm -f ${root}/github${github ? "" : ` ${gitCredentialsPath}`}`);
  // Without a Codex profile, setup removes any auth.json left from an earlier one.
  await check(box, `${codexAuthJson ? "CODEX_AUTH=1 " : ""}bash ${root}/setup.sh ${quote(t3Version)}`, "VM setup", 10 * 60_000);
}

/** The VM's Codex auth.json, which Codex rewrites when it refreshes its own tokens. */
export async function readCodexAuth(box: Box): Promise<string | null> {
  try {
    return await box.files.read(codexAuthPath);
  } catch {
    return null;
  }
}

/** Replaces the VM's Codex sign-in. Codex reads the file again before it next refreshes. */
export async function writeCodexAuth(box: Box, authJson: string) {
  await box.files.write({ [codexAuthPath]: authJson }, { mode: 0o600 });
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
