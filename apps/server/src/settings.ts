import type { Database } from "bun:sqlite";
import type { AgentKind, GitHubAccount, ProviderId, RepoRule, VmSize } from "@vmbridge/contracts";

export interface ProviderPreference {
  enabled?: boolean;
  displayName?: string;
}

interface SettingValues {
  /** Stable T3 environment identity. Never changes once created. */
  bridgeId: string;
  dashboardKeyHash: string | null;
  /** Providers added in Setup, in order. VMs on a removed provider keep running but get no new VMs beside them. */
  providers: ProviderId[];
  /** One of `providers`. New VMs go here unless a repository rule picks another. */
  defaultProvider: ProviderId | null;
  repoRules: RepoRule[];
  /** Non-secret provider fields, such as a Boat environment name. Secrets live in the secrets table. */
  providerOptions: Partial<Record<ProviderId, Record<string, string>>>;
  vmSize: VmSize;
  idleMinutes: number;
  /** Exact npm `t3` version for new VMs; null resolves the latest release when a VM is created. */
  t3Version: string | null;
  /** The GitHub account VM Bridge's token belongs to. The token itself is the `github.token` secret. */
  github: GitHubAccount | null;
  /** T3 shell snapshot sequence. Only grows, across restarts, so clients never see it go back. */
  shellSequence: number;
  /** T3 agent provider switches and display names set from T3's settings screen. */
  agentPreferences: Record<string, ProviderPreference>;
  /** The sign-in profile each agent uses on every VM. Profiles live under `<data dir>/auths`. */
  agentProfiles: Partial<Record<AgentKind, string>>;
}

const defaults: { [K in keyof SettingValues]: () => SettingValues[K] } = {
  bridgeId: () => crypto.randomUUID(),
  dashboardKeyHash: () => null,
  providers: () => [],
  defaultProvider: () => null,
  repoRules: () => [],
  providerOptions: () => ({}),
  vmSize: () => "medium",
  idleMinutes: () => 5,
  t3Version: () => null,
  github: () => null,
  shellSequence: () => 0,
  agentPreferences: () => ({}),
  agentProfiles: () => ({}),
};

export class Settings {
  constructor(private readonly db: Database) {
    // Persist the identity on first start so pairings survive restarts.
    if (!this.db.query("SELECT 1 FROM settings WHERE key = 'bridgeId'").get()) this.set("bridgeId", defaults.bridgeId());
  }

  get<K extends keyof SettingValues>(key: K): SettingValues[K] {
    const row = this.db.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?").get(key);
    return row ? (JSON.parse(row.value) as SettingValues[K]) : defaults[key]();
  }

  set<K extends keyof SettingValues>(key: K, value: SettingValues[K]): void {
    this.db
      .query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .run(key, JSON.stringify(value));
  }
}

/** Secret values never leave the server through the admin API; only their presence does. */
export class Secrets {
  constructor(private readonly db: Database) {}

  get(name: string): string | undefined {
    return this.db.query<{ value: string }, [string]>("SELECT value FROM secrets WHERE name = ?").get(name)?.value;
  }

  has(name: string): boolean {
    return this.get(name) !== undefined;
  }

  set(name: string, value: string | null): void {
    if (value === null || value === "") this.db.query("DELETE FROM secrets WHERE name = ?").run(name);
    else {
      this.db
        .query("INSERT INTO secrets (name, value) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value")
        .run(name, value);
    }
  }
}
