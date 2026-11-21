import type { AgentSecrets } from "../agent-auth/profiles.ts";
import type { Box } from "../providers/index.ts";

/** Everything VM Bridge installs or keeps lives here, on the disk that survives sleep. */
export const root = "/workspace/.vmbridge";
export const t3Port = 3773;
export const t3DataDir = `${root}/t3`;
/** VM Bridge clones each project's repository here. */
export const checkoutRoot = "/workspace";

export const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

const codexAuthPath = `${root}/codex/auth.json`;

const gitConfigPath = `${root}/gitconfig`;
const gitCredentialsPath = `${root}/git-credentials`;
/** The fingerprint of the sign-ins the running T3 server read from the env file when it started. */
const startedCredentialsPath = `${t3DataDir}/credentials`;

/** Credentials VM Bridge passes into a VM. Agents and git use only these, never the provider's. */
export interface VmCredentials extends AgentSecrets {
  github?: { token: string; login: string; name: string; email: string };
  /** Environment variables set in the dashboard. Absent rather than empty, so having none leaves the fingerprint as it was. */
  env?: Record<string, string>;
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

/** The variables VM Bridge sets itself. Every name in here is reserved: the dashboard cannot set it. */
function managedVars(credentials: VmCredentials): Record<string, string | undefined> {
  return {
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
}

/**
 * Names the dashboard cannot set: those VM Bridge sets or clears, and those that would break shells, T3 or the
 * agents. Bash refuses to assign its readonly and array variables (UID, SHELLOPTS, GROUPS), which would stop every
 * script that reads the env file. Prefixes cover T3's and VM Bridge's own settings, bash's own variables (BASHOPTS,
 * BASHPID, BASH_FUNC_ and the rest) and the dynamic linker.
 */
const reservedNames = new Set([
  ...Object.keys(managedVars({})),
  ...providerVars,
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PWD",
  "OLDPWD",
  "IFS",
  "ENV",
  "BASH_ENV",
  "SHLVL",
  "UID",
  "EUID",
  "PPID",
  "SHELLOPTS",
  "GROUPS",
  "FUNCNAME",
  "DIRSTACK",
  "PIPESTATUS",
  "POSIXLY_CORRECT",
]);
const reservedPrefixes = ["T3CODE_", "VMBRIDGE_", "LD_", "BASH"];

/** Why a name cannot be an environment variable on the VMs, or null when it can. */
export function envNameProblem(name: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return "Use letters, digits and underscores, not starting with a digit.";
  if (name.length > 128) return "Use at most 128 characters.";
  if (reservedNames.has(name) || reservedPrefixes.some((prefix) => name.startsWith(prefix))) return `${name} is reserved. VM Bridge or the VM sets it.`;
  return null;
}

/** Why a value cannot be an environment variable's, or null when it can. */
export function envValueProblem(value: string) {
  if (value.includes("\0")) return "Values cannot contain a null character.";
  if (Buffer.byteLength(value) > 32_768) return "Use at most 32,768 bytes.";
  return null;
}

function envFile(credentials: VmCredentials) {
  const lines = [
    `unset ${providerVars.join(" ")}`,
    `export PATH="${root}/node/bin:${root}/npm/bin:${root}/gh/bin:$PATH"`,
    // Not exported: only start-t3.sh reads it, to record what the server starts with.
    `VMBRIDGE_CREDENTIALS=${credentialsFingerprint(credentials)}`,
  ];
  for (const [name, value] of Object.entries(managedVars(credentials))) if (value) lines.push(`export ${name}=${quote(value)}`);
  // Single quotes keep every value exact, newlines and `$` included. An empty one is still set. A name saved before it
  // was reserved is left out: one that bash refuses would stop setup on every VM.
  for (const [name, value] of Object.entries(credentials.env ?? {})) if (!envNameProblem(name)) lines.push(`export ${name}=${quote(value)}`);
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
# First, so the script's own variables below replace any of the same name from the dashboard.
. ${root}/env
root=${root}
version="$1"

fetch() { if command -v curl >/dev/null; then curl -fsSL "$1"; else wget -qO- "$1"; fi; }

# t3 needs Node 20.11 or later (import.meta.dirname). E2B's base image has 20.9.
node_ok() {
  command -v node >/dev/null || return 1
  node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 20 || (major === 20 && minor >= 11) ? 0 : 1)'
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
# The npm launcher downloads the T3 runtime on first use. Do it now rather than during a request.
t3 --version >/dev/null

git config --global --get-all include.path | grep -Fxq "$root/gitconfig" || git config --global --add include.path "$root/gitconfig"

# Shells opened on the VM, such as over SSH, get what T3 and its agents get. Shells under T3 already have it, as their
# turn started with it, so a change waiting for a busy VM does not reach a turn halfway.
line='[ -n "\${T3CODE_HOME:-}" ] || [ ! -r ${root}/env ] || . ${root}/env'
for rc in .profile .bashrc .bash_profile .bash_login; do
  file="$HOME/$rc"
  case "$rc" in .bash_profile|.bash_login) [ -f "$file" ] || continue ;; esac
  grep -Fqsx "$line" "$file" || printf '\\n%s\\n' "$line" >> "$file"
done
`;

// Sets only VMBRIDGE_ variables, which the dashboard cannot: assigning a name the env file exported would change it for T3
// and its agents, and a value set in the dashboard would change the script.
const startScript = `#!/bin/bash
set -euo pipefail
. ${root}/env
mkdir -p ${t3DataDir}
printf '%s' "$VMBRIDGE_CREDENTIALS" > ${startedCredentialsPath}
# T3 refuses to start when a runtime record from before a VM stop names a dead or reused PID.
VMBRIDGE_RUNTIME=${t3DataDir}/userdata/server-runtime.json
if [ -f "$VMBRIDGE_RUNTIME" ]; then
  VMBRIDGE_PID="$(node -e 'try{const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).pid;if(Number.isSafeInteger(p))process.stdout.write(String(p))}catch{}' "$VMBRIDGE_RUNTIME")"
  if [ -z "$VMBRIDGE_PID" ] || ! tr '\\0' ' ' < "/proc/$VMBRIDGE_PID/cmdline" 2>/dev/null | grep -q -- ${t3DataDir}; then rm -f "$VMBRIDGE_RUNTIME"; fi
fi
cd ${checkoutRoot}
exec t3 --base-dir ${t3DataDir} --host 0.0.0.0 --port ${t3Port} --no-browser
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

export async function check(box: Box, command: string, what: string, timeoutMs = 120_000) {
  const result = await box.run(command, { timeoutMs });
  // Only the tail: setup output is install noise, and the env file is never echoed.
  if (!result.ok) throw new Error(`${what} failed (exit ${result.exitCode}): ${result.output.slice(-600)}`);
  return result.stdout;
}

/**
 * Identifies the sign-ins and variables a T3 server starts with, to tell when a running one has older ones. Codex counts by
 * sign-in rather than by auth.json, which changes every time its tokens refresh and needs no restart.
 */
export function credentialsFingerprint(credentials: VmCredentials) {
  const { codexAuthJson: _refreshes, ...rest } = credentials;
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(rest)).digest("hex");
}

/**
 * Writes the sign-ins into the VM, removing those that are gone. Git and gh read them on their next command;
 * agents get them from T3's environment, so only once T3 restarts.
 */
export async function writeCredentials(box: Box, credentials: VmCredentials) {
  const { github, codexAuthJson } = credentials;
  const files: Record<string, string> = { [`${root}/env`]: envFile(credentials), [gitConfigPath]: gitConfig(github) };
  if (github) files[gitCredentialsPath] = `https://${encodeURIComponent(github.login)}:${encodeURIComponent(github.token)}@github.com\n`;
  if (codexAuthJson) files[codexAuthPath] = codexAuthJson;
  await box.files.write(files, { mode: 0o600 });
  // Older versions kept the GitHub token in `github` too.
  const removed = [`${root}/github`, ...(github ? [] : [gitCredentialsPath]), ...(codexAuthJson ? [] : [codexAuthPath])];
  await check(box, `rm -f ${removed.join(" ")}`, "Removing old sign-ins");
}

/** Writes credentials and scripts, then installs what is missing. Safe to repeat on every wake. */
export async function prepareVm(box: Box, t3Version: string, credentials: VmCredentials) {
  await box.run(`mkdir -p ${root} && chmod 700 ${root}`);
  await writeCredentials(box, credentials);
  await box.files.write({ [`${root}/setup.sh`]: setupScript, [`${root}/start-t3.sh`]: startScript }, { mode: 0o600 });
  await check(box, `bash ${root}/setup.sh ${quote(t3Version)}`, "VM setup", 10 * 60_000);
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
  /**
   * Fingerprint of the sign-ins the running server started with, as it recorded them, or null for a server
   * started before VM Bridge recorded them. Read back rather than assumed, since a restart can fail either side
   * of relaunching the server.
   */
  credentials: string | null;
}

/**
 * Starts the T3 server unless it already answers, and issues VM Bridge a session token when it has none.
 * With `restart`, a server already running is restarted, so it and the agents it runs read the env file
 * again. Only safe while nothing runs on the VM.
 */
export async function startT3(box: Box, token: string | null, restart = false): Promise<T3Server> {
  let answer = await box.run(probe, { timeoutMs: 15_000 });
  if (answer.ok && restart) {
    // A failed restart leaves the old server answering, or none, which the start below handles.
    await box.process("t3").restart().catch(() => {});
    answer = await box.run(probe, { timeoutMs: 15_000 });
  }
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
  const credentials = await box.files.read(startedCredentialsPath).catch(() => null);
  return { descriptor, token, credentials };
}
