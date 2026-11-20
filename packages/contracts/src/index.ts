// Types shared by the VM Bridge server and its web dashboard. The admin API returns these shapes.

export const providerIds = ["boat", "boxd", "instabox", "railway"] as const;
export type ProviderId = (typeof providerIds)[number];

export const vmSizes = ["small", "medium", "large"] as const;
export type VmSize = (typeof vmSizes)[number];

export interface ProviderField {
  key: string;
  label: string;
  kind: "secret" | "text" | "select";
  required: boolean;
  help?: string;
  placeholder?: string;
}

/** How a provider keeps a VM between bursts of work. */
export type SleepMode = "pause" | "stop" | "checkpoint";

export interface ProviderFeatures {
  sleep: SleepMode;
  /** VM disk and agent sessions survive sleep. */
  keepsDisk: boolean;
  /** Memory and running processes survive sleep. */
  keepsMemory: boolean;
  /** Agent sign-ins come from the provider account instead of VM Bridge settings. */
  providerAgentCredentials: boolean;
  /** Repositories come from the provider's own GitHub connection. */
  providerGitHub: boolean;
}

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  website: string;
  fields: ProviderField[];
  features: ProviderFeatures;
  sizes: Record<VmSize, string>;
  /** Non-secret field values. Secret fields report only whether they are set. */
  values: Record<string, string>;
  secretsSet: string[];
  configured: boolean;
  active: boolean;
}

export interface SelectOption {
  value: string;
  label: string;
}

export type AddressKind = "local" | "lan" | "tailscale" | "tailscale-dns" | "tailscale-https";

export interface Address {
  kind: AddressKind;
  label: string;
  url: string;
}

export interface NetworkInfo {
  port: number;
  host: string;
  addresses: Address[];
  tailscale: {
    installed: boolean;
    running: boolean;
    dnsName: string | null;
    httpsUrl: string | null;
  };
}

export interface PairingLink {
  id: string;
  name: string;
  createdAt: number;
  expiresAt: number;
  redeemedAt: number | null;
}

/** A device paired with VM Bridge through a pairing link. */
export interface ClientInfo {
  id: string;
  name: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number | null;
  connected: boolean;
}

export type VmState = "provisioning" | "starting" | "ready" | "busy" | "sleeping" | "error" | "gone";

export interface VmSession {
  threadId: string;
  title: string;
  projectId: string | null;
  model: string | null;
  provider: string | null;
  status: string;
  updatedAt: string | null;
}

export interface VmInfo {
  id: string;
  name: string;
  provider: ProviderId;
  sandboxId: string | null;
  size: VmSize;
  sizeLabel: string;
  state: VmState;
  error: string | null;
  createdAt: number;
  lastActivityAt: number | null;
  lastConnectedAt: number | null;
  lastSleptAt: number | null;
  /** When the idle timer will put the VM to sleep, if it is awake and idle. */
  sleepsAt: number | null;
  projects: string[];
  sessions: VmSession[];
  t3Version: string | null;
}

export interface ProjectInfo {
  id: string;
  title: string;
  url: string;
  branch: string | null;
  vmId: string | null;
  createdAt: number;
}

export interface Setup {
  provider: boolean;
  github: boolean;
  agents: boolean;
}

export interface AgentCredentials {
  anthropicApiKey: boolean;
  claudeOAuthToken: boolean;
  openaiApiKey: boolean;
  codexAuthJson: boolean;
}

export interface BridgeSettings {
  vmSize: VmSize;
  idleMinutes: number;
  t3Version: string | null;
}

export interface Overview {
  bridge: { id: string; version: string; startedAt: number };
  setup: Setup;
  provider: ProviderInfo | null;
  settings: BridgeSettings;
  clients: ClientInfo[];
  vms: VmInfo[];
  projects: ProjectInfo[];
}

export interface GitHubInfo {
  login: string | null;
}

export interface TrafficEvent {
  id: number;
  at: number;
  kind: "rpc" | "http" | "provider" | "system";
  operation: string;
  clientId?: string;
  vmId?: string;
  status?: "ok" | "error";
  durationMs?: number;
}

export type LiveMessage =
  | { type: "traffic"; event: TrafficEvent }
  | { type: "overview"; overview: Overview };

export interface ApiError {
  error: string;
}
