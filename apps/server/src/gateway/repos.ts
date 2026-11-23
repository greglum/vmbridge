import type { ProjectRow } from "../store.ts";
import type { Wire } from "./types.ts";

/** `owner/name` for a github.com URL or shorthand (`owner/name`, `git@github.com:owner/name`). */
export function githubName(reference: string): string | undefined {
  const trimmed = reference.trim().replace(/^(?:git@github\.com:|ssh:\/\/git@github\.com\/)/i, "");
  if (/^[\w.-]+\/[\w.-]+$/.test(trimmed)) return trimmed.replace(/\.git$/, "");
  const url = URL.parse(trimmed);
  const name = url?.pathname.replace(/^\/|\/+$/g, "").replace(/\.git$/, "");
  if (url?.hostname === "github.com" && name && /^[\w.-]+\/[\w.-]+$/.test(name)) return name;
}

export const githubRepository = (name: string) => ({
  provider: "github",
  nameWithOwner: name,
  url: `https://github.com/${name}`,
  sshUrl: `git@github.com:${name}.git`,
});

export function repositoryIdentity(project: Pick<ProjectRow, "url">, workspaceRoot: string) {
  const url = new URL(project.url);
  const path = url.pathname.replace(/\/+$/, "").replace(/\.git$/, "");
  const [owner, name] = path.slice(1).split("/");
  const github = url.hostname === "github.com" && owner && name;
  return {
    canonicalKey: url.host + (github ? path.toLowerCase() : path),
    locator: { source: "git-remote", remoteName: "origin", remoteUrl: project.url },
    rootPath: workspaceRoot,
    webUrl: url.origin + path,
    displayName: path.slice(1),
    ...(github ? { provider: "github", owner, name } : {}),
  };
}

/** Accepts only plain HTTPS remotes, so nothing odd reaches `git clone` on a VM. */
export function normalizeRemote(reference: string): string {
  const github = githubName(reference);
  if (github) return `https://github.com/${github}.git`;
  const url = URL.parse(reference.trim());
  if (!url || url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !/^\/[\w./-]+$/.test(url.pathname)) {
    throw new Error("Use an HTTPS repository URL, such as https://github.com/owner/repo.");
  }
  return url.href;
}

interface Branches {
  names: string[];
  defaultBranch: string | null;
  at: number;
}

/** Remote branches for projects whose VM is asleep or not created yet. */
export class RemoteBranches {
  private readonly cache = new Map<string, Branches>();

  constructor(private readonly githubToken: () => string | undefined) {}

  async check(url: string) {
    await this.branches(url, true);
  }

  async branches(url: string, refresh = false): Promise<Branches> {
    const cached = this.cache.get(url);
    if (!refresh && cached && Date.now() - cached.at < 60_000) return cached;
    const github = githubName(url);
    let branches: Branches;
    if (github) {
      // Git's own protocol lists every branch in one request and has no API rate limit. The REST API is the fallback,
      // and explains a private or missing repository better.
      const token = this.githubToken();
      branches = await lsRemote(`https://github.com/${github}.git`, token).catch(() => this.github(github, token));
    } else branches = await lsRemote(url);
    this.cache.set(url, branches);
    return branches;
  }

  private async github(name: string, token: string | undefined): Promise<Branches> {
    const headers = { accept: "application/vnd.github+json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
    const get = async <T>(path: string) => {
      const response = await fetch(`https://api.github.com/repos/${name}${path}`, { headers, signal: AbortSignal.timeout(10_000) });
      if (response.status === 404) {
        throw new Error(token ? `GitHub has no repository ${name} that this account can read.` : `Repository ${name} is private or missing. Connect GitHub in the VM Bridge dashboard.`);
      }
      if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${name}.`);
      return (await response.json()) as T;
    };
    const [repo, branches] = await Promise.all([
      get<{ default_branch: string }>(""),
      get<{ name: string }[]>("/branches?per_page=100"),
    ]);
    return { names: branches.map((branch) => branch.name).sort(), defaultBranch: repo.default_branch, at: Date.now() };
  }

  /** T3's `vcs.listRefs` result for a project with no reachable checkout. */
  async refs(project: ProjectRow, input: Wire) {
    const branches = await this.branches(project.url, input.refresh === true);
    const current = project.branch ?? branches.defaultBranch;
    const refs: Wire[] = [];
    if (current && input.refKind !== "remote") {
      refs.push({ name: current, current: true, isDefault: current === branches.defaultBranch, worktreePath: null });
    }
    if (input.refKind !== "local") {
      for (const name of branches.names) {
        if (name === current && !input.includeMatchingRemoteRefs && input.refKind !== "remote") continue;
        refs.push({
          name: `origin/${name}`,
          isRemote: true,
          remoteName: "origin",
          upstreamRef: `refs/remotes/origin/${name}`,
          current: false,
          isDefault: name === branches.defaultBranch,
          worktreePath: null,
        });
      }
    }
    const query = typeof input.query === "string" ? input.query.toLowerCase().trim() : "";
    const filtered = refs.filter((ref) => String(ref.name).toLowerCase().includes(query));
    const cursor = Number.isSafeInteger(input.cursor) ? Math.max(0, input.cursor as number) : 0;
    const limit = Number.isSafeInteger(input.limit) ? Math.min(200, Math.max(1, input.limit as number)) : 50;
    return {
      refs: filtered.slice(cursor, cursor + limit),
      isRepo: true,
      isAtRepositoryRoot: true,
      hasPrimaryRemote: true,
      totalCount: filtered.length,
      nextCursor: cursor + limit < filtered.length ? cursor + limit : null,
    };
  }

  /** A VCS status for a checkout VM Bridge cannot read right now. It never claims the tree is clean or dirty in detail. */
  async status(project: ProjectRow, cwd: string) {
    const branches = await this.branches(project.url).catch(() => null);
    const refName = project.branch ?? branches?.defaultBranch ?? null;
    return {
      isRepo: true,
      hasPrimaryRemote: true,
      isDefaultRef: refName !== null && refName === branches?.defaultBranch,
      refName,
      hasWorkingTreeChanges: false,
      workingTree: { rootPath: cwd, files: [], insertions: 0, deletions: 0 },
      ...(githubName(project.url) ? { sourceControlProvider: { kind: "github", name: "GitHub", baseUrl: "https://github.com" } } : {}),
    };
  }
}

const decoder = new TextDecoder();

/** Git pkt-lines without their trailing newline. Flush, delimiter and response-end packets are null. */
export function pktLines(bytes: Uint8Array): (string | null)[] {
  const lines: (string | null)[] = [];
  for (let at = 0; at + 4 <= bytes.length; ) {
    const length = Number.parseInt(decoder.decode(bytes.subarray(at, at + 4)), 16);
    if (!Number.isInteger(length) || (length > 2 && length < 4)) throw new Error("The repository sent an unreadable answer.");
    if (length <= 2) {
      lines.push(null);
      at += 4;
      continue;
    }
    lines.push(decoder.decode(bytes.subarray(at + 4, at + length)).replace(/\n$/, ""));
    at += length;
  }
  return lines;
}

const pkt = (line: string) => `${(new TextEncoder().encode(line).length + 4).toString(16).padStart(4, "0")}${line}`;

/** Branches and the default branch from ref lines of either protocol: `<oid> <ref>`, then capabilities or attributes. */
export function parseRefs(lines: (string | null)[]): Omit<Branches, "at"> {
  const names = new Set<string>();
  let defaultBranch: string | null = null;
  for (const line of lines) {
    if (!line) continue;
    // Version 0 puts capabilities after a NUL on the first line; version 2 puts attributes after spaces.
    const [refPart = "", capabilities = ""] = line.split("\0");
    const [, ref, ...attributes] = refPart.split(" ");
    const symref = [...attributes, ...capabilities.split(" ")].find((entry) => entry.startsWith("symref-target:") || entry.startsWith("symref=HEAD:"));
    if (ref === "HEAD" && symref?.includes("refs/heads/")) defaultBranch = symref.slice(symref.indexOf("refs/heads/") + "refs/heads/".length);
    if (ref?.startsWith("refs/heads/")) names.add(ref.slice("refs/heads/".length));
  }
  return { names: [...names].sort(), defaultBranch };
}

/**
 * What `git ls-remote --symref <url> HEAD refs/heads/*` prints, read over git's smart HTTP protocol with fetch, so it
 * runs wherever VM Bridge does. HTTPS only and never prompts. Asks for protocol version 2, which lists only branches,
 * and reads version 0's full list from servers without it. `token` goes to github.com only.
 */
export async function lsRemote(url: string, token?: string): Promise<Branches> {
  const parsed = URL.parse(url);
  if (parsed?.protocol !== "https:" || parsed.username || parsed.password) throw new Error("Only HTTPS repositories can be read.");
  const base = parsed.href.replace(/\/+$/, "");
  const headers: Record<string, string> = { "git-protocol": "version=2", "user-agent": "git/vmbridge" };
  if (token && parsed.hostname === "github.com") headers.authorization = `Basic ${btoa(`x-access-token:${token}`)}`;
  const request = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: { ...headers, ...init.headers },
      // A redirect must not carry the token to another host.
      redirect: headers.authorization ? "error" : "follow",
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (!response?.ok) throw new Error("Could not read the repository's branches.");
    return pktLines(new Uint8Array(await response.arrayBuffer()));
  };

  let advertised = await request("/info/refs?service=git-upload-pack");
  // Smart HTTP may start with a service line and a flush before what the protocol itself sends.
  if (advertised[0]?.startsWith("# service=")) advertised = advertised.slice(2);
  if (advertised[0] !== "version 2") return { ...parseRefs(advertised), at: Date.now() };
  const body = `${pkt("command=ls-refs\n")}0001${pkt("symrefs\n")}${pkt("ref-prefix HEAD\n")}${pkt("ref-prefix refs/heads/\n")}0000`;
  const refs = await request("/git-upload-pack", { method: "POST", body, headers: { "content-type": "application/x-git-upload-pack-request" } });
  return { ...parseRefs(refs), at: Date.now() };
}
