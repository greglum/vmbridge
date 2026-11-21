import { EventEmitter } from "node:events";
import { SandboxError, type Preview } from "@opencoredev/sandbox-sdk";
import type { ProviderId, VmSize, VmState } from "@vmbridge/contracts";
import { providers, type Box, type Driver } from "./providers/index.ts";
import type { Settings, Secrets } from "./settings.ts";
import type { ProjectRow, Store, VmRow } from "./store.ts";
import type { Traffic } from "./traffic.ts";
import { Backend, TokenRejected } from "./vm/backend.ts";
import type { AgentAuth } from "./agent-auth/profiles.ts";
import { githubName } from "./gateway/repos.ts";
import { hasLiveWork, type Shell } from "./gateway/types.ts";
import type { Skills } from "./skills.ts";
import { syncSkills } from "./vm/skills.ts";
import { checkoutRoot, credentialsFingerprint, prepareVm, quote, readCodexAuth, resolveT3Version, startT3, t3Port, writeCodexAuth, writeCredentials, type VmCredentials } from "./vm/runtime.ts";

type FleetEvents = {
  /** A VM's T3 server is connected and subscribed. */
  awake: [vmId: string];
  /** A VM went to sleep, disconnected, or was removed. */
  offline: [vmId: string];
  /** Anything the dashboard shows about the fleet changed. */
  changed: [];
};

export class NoProvider extends Error {
  constructor() {
    super("Choose a VM provider in the VM Bridge dashboard first.");
  }
}

const shortId = () => crypto.randomUUID().replaceAll("-", "").slice(0, 12);

/** Provider config: the non-secret options plus every secret field, read from the secrets table. */
export function providerValues(settings: Settings, secrets: Secrets, id: ProviderId) {
  const values = { ...settings.get("providerOptions")[id] };
  for (const field of providers[id].fields) {
    if (field.kind !== "secret") continue;
    const value = secrets.get(`provider.${id}.${field.key}`);
    if (value) values[field.key] = value;
  }
  return values;
}

const repoName = (url: string) =>
  new URL(url).pathname.split("/").filter(Boolean).pop()?.replace(/\.git$/, "") || "repository";

/**
 * Owns every VM: creating, waking, connecting to its T3 server, cloning its project, and sleeping.
 * One project per VM. Each VM operation runs under that VM's lock.
 */
export class Fleet extends EventEmitter<FleetEvents> {
  private readonly backends = new Map<string, Backend>();
  private readonly boxes = new Map<string, Box>();
  private readonly connecting = new Map<string, Promise<Backend>>();
  private readonly placing = new Map<string, Promise<string>>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly leases = new Map<string, number>();
  private readonly drivers = new Map<ProviderId, { signature: string; driver: Driver }>();
  /** The first VM started to read T3's configuration, shared by everyone asking at once. */
  private bootstrapping?: Promise<string>;
  /** Fingerprint of the sign-ins VM Bridge last gave out, once it has. */
  private latest?: string;
  /** VMs whose T3 server could not be restarted for these sign-ins, so the idle sweep stops trying. */
  private readonly unrestartable = new Map<string, string>();
  private closed = false;

  /** Runs once a VM's backend is connected, before anyone else can use it. */
  onConnect: (vmId: string, backend: Backend) => Promise<void> = async () => {};

  constructor(
    private readonly store: Store,
    private readonly settings: Settings,
    private readonly secrets: Secrets,
    private readonly traffic: Traffic,
    private readonly agents: AgentAuth,
    private readonly skills: Pick<Skills, "state" | "files">,
  ) {
    super();
  }

  driver(provider: ProviderId): Driver {
    const values = providerValues(this.settings, this.secrets, provider);
    const signature = JSON.stringify(values);
    const cached = this.drivers.get(provider);
    if (cached?.signature === signature) return cached.driver;
    const driver = providers[provider].open({ values });
    this.drivers.set(provider, { signature, driver });
    return driver;
  }

  backend(vmId: string): Backend | undefined {
    const backend = this.backends.get(vmId);
    return backend?.open ? backend : undefined;
  }

  /** The provider handle of a connected VM. Undefined while it sleeps, so callers cannot wake it. */
  box(vmId: string): Box | undefined {
    return this.backend(vmId) ? this.boxes.get(vmId) : undefined;
  }

  connected(): string[] {
    return [...this.backends.keys()].filter((id) => this.backend(id));
  }

  leased(vmId: string) {
    return (this.leases.get(vmId) ?? 0) > 0;
  }

  /** Holds a VM awake while a request runs. Call the result once to release. */
  lease(vmId: string): () => void {
    this.leases.set(vmId, (this.leases.get(vmId) ?? 0) + 1);
    this.touch(vmId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.leases.set(vmId, (this.leases.get(vmId) ?? 1) - 1);
    };
  }

  touch(vmId: string, now = Date.now()) {
    this.store.updateVm(vmId, { lastActivityAt: now });
  }

  private async exclusive<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(action);
    this.locks.set(key, task);
    try {
      return await task;
    } finally {
      if (this.locks.get(key) === task) this.locks.delete(key);
    }
  }

  private setState(vmId: string, state: VmState, error: string | null = null) {
    this.store.updateVm(vmId, { state, error });
    this.emit("changed");
  }

  private labels() {
    return { vmbridge: this.settings.get("bridgeId").slice(0, 12) };
  }

  /** Creates a VM, on the default provider and size unless told otherwise. It is not started or connected yet. */
  async create(choice: { provider?: ProviderId; size?: VmSize } = {}): Promise<VmRow> {
    const provider = choice.provider ?? this.settings.get("defaultProvider");
    if (!provider) throw new NoProvider();
    if (!this.settings.get("providers").includes(provider)) throw new Error(`Add ${providers[provider].label} in Setup first.`);
    const driver = this.driver(provider);
    const id = shortId();
    const size = choice.size ?? this.settings.get("vmSize");
    this.store.insertVm({ id, provider, name: `vm-${id.slice(0, 6)}`, size, state: "provisioning", createdAt: Date.now() });
    this.emit("changed");
    // Under the VM's lock, so deleting a VM that is still being created waits and then deletes it at the provider too.
    return this.exclusive(id, async () => {
      const started = performance.now();
      let box: Box;
      try {
        box = await driver.create({ key: id, size, labels: this.labels(), ports: [t3Port] });
      } catch (error) {
        this.traffic.record({ kind: "provider", operation: "create VM", vmId: id, status: "error" });
        this.setState(id, "error", message(error));
        throw error;
      }
      this.store.updateVm(id, { sandboxId: box.id });
      const vm = this.store.vm(id);
      if (!vm) {
        // The row went away some other way: do not leave a billable VM nobody knows about.
        await driver.destroy(box.id).catch(() => {});
        throw new Error(`VM ${id} was deleted while it was being created.`);
      }
      this.boxes.set(id, box);
      this.traffic.record({ kind: "provider", operation: "create VM", vmId: id, status: "ok", durationMs: Math.round(performance.now() - started) });
      return vm;
    });
  }

  /** Wakes and connects a VM. Concurrent callers share one attempt. */
  ensure(vmId: string): Promise<Backend> {
    const ready = this.backend(vmId);
    if (ready) return Promise.resolve(ready);
    let flight = this.connecting.get(vmId);
    if (!flight) {
      flight = this.exclusive(vmId, () => this.open(vmId)).finally(() => this.connecting.delete(vmId));
      this.connecting.set(vmId, flight);
    }
    return flight;
  }

  private async open(vmId: string): Promise<Backend> {
    if (this.closed) throw new Error("VM Bridge is stopping.");
    const ready = this.backend(vmId);
    if (ready) return ready;
    const vm = this.store.vm(vmId);
    if (!vm) throw new Error(`VM ${vmId} does not exist.`);
    if (vm.state === "gone") throw new Error("This VM was removed from the provider. Start a new thread to get a new VM.");
    if (!vm.sandboxId) throw new Error(`VM ${vmId} was never created at the provider.`);
    // Asleep (or never started) until now, so nothing runs there that restarting T3, or putting it back to sleep, could interrupt.
    const wasAsleep = (vm.lastSleptAt ?? 0) >= (vm.lastConnectedAt ?? 0);
    this.setState(vmId, "starting");
    const started = performance.now();
    let box: Box | undefined;
    try {
      const driver = this.driver(vm.provider);
      box = await driver.wake({
        key: vm.id,
        size: vm.size,
        labels: this.labels(),
        ports: [t3Port],
        sandboxId: vm.sandboxId,
        checkpoint: vm.checkpoint,
      });
      // Restoring a checkpoint makes a new sandbox. It holds the files now, so the checkpoint can go.
      if (box.id !== vm.sandboxId) {
        this.store.updateVm(vmId, { sandboxId: box.id, checkpoint: null });
        if (vm.checkpoint) {
          await driver.deleteCheckpoint(vm.checkpoint).catch(() => this.traffic.record({ kind: "provider", operation: "delete checkpoint", vmId, status: "error" }));
        }
      }
      this.boxes.set(vmId, box);
      const version = await resolveT3Version(this.settings.get("t3Version"));
      // A T3 server still running from before VM Bridge restarted may be in the middle of a turn: then the idle sweep restarts it later.
      const backend = await this.connect(vm, box, version, async (preview) => {
        if (wasAsleep || !vm.t3Token) return true;
        const shell = await new Backend(vmId, preview, vm.t3Token).json<Shell>("/api/orchestration/shell").catch(() => null);
        return Boolean(shell && !hasLiveWork(shell));
      });
      this.touch(vmId);
      this.traffic.record({ kind: "provider", operation: "wake VM", vmId, status: "ok", durationMs: Math.round(performance.now() - started) });
      return backend;
    } catch (error) {
      this.traffic.record({ kind: "provider", operation: "wake VM", vmId, status: "error" });
      if (error instanceof SandboxError && error.code === "not_found") this.markGone(vmId);
      else {
        // Woken but unusable: put it back to sleep so it does not run, and bill, outside the idle sweep.
        if (box && wasAsleep) await this.sleepBox(vmId, this.driver(vm.provider), box).catch(() => {});
        this.setState(vmId, "error", message(error));
      }
      throw error;
    }
  }

  /**
   * Installs what the VM needs, gives it the current sign-ins, and connects to its T3 server. A server
   * running from before with older sign-ins is restarted first when `idle` says nothing runs on it.
   */
  private async connect(vm: VmRow, box: Box, version: string, idle: (preview: Preview) => Promise<boolean>): Promise<Backend> {
    // Codex on this VM may have refreshed its own tokens while VM Bridge could not reach it.
    const codexAuth = await readCodexAuth(box);
    if (codexAuth) this.agents.adoptCodex(codexAuth);
    const credentials = await this.credentials();
    const fingerprint = credentialsFingerprint(credentials);
    await prepareVm(box, version, credentials);
    // Before T3 starts or VM Bridge sends it anything, so no agent on a woken VM runs with old skills.
    await this.syncSkills(vm.id, box);
    const preview = await box.preview(t3Port);
    const restart = vm.t3Credentials !== fingerprint && (await idle(preview));
    let server = await startT3(box, vm.t3Token, restart);
    if (server.descriptor.orchestrationProtocolVersion !== 2) {
      throw new Error(`T3 ${version} speaks orchestration protocol ${server.descriptor.orchestrationProtocolVersion}. VM Bridge supports 2.`);
    }
    if (restart && server.credentials !== fingerprint) this.unrestartable.set(vm.id, fingerprint);
    let backend = new Backend(vm.id, preview, server.token);
    try {
      try {
        await backend.connect();
      } catch (error) {
        if (!(error instanceof TokenRejected)) throw error;
        server = await startT3(box, null);
        backend = new Backend(vm.id, preview, server.token);
        await backend.connect();
      }
      this.store.updateVm(vm.id, { t3Token: server.token, t3Version: version, t3Credentials: server.credentials, lastConnectedAt: Date.now() });
      await this.onConnect(vm.id, backend);
    } catch (error) {
      await backend.close();
      throw error;
    }
    const connected = backend;
    connected.onClose = () => this.disconnected(vm.id, connected);
    this.backends.set(vm.id, connected);
    this.setState(vm.id, "ready");
    this.emit("awake", vm.id);
    return connected;
  }

  /** True when an awake VM's T3 server runs with older sign-ins than VM Bridge now gives out. */
  stale(vmId: string) {
    const vm = this.store.vm(vmId);
    return Boolean(vm && this.latest && vm.t3Credentials !== this.latest && this.unrestartable.get(vmId) !== this.latest);
  }

  /**
   * Restarts T3 on an awake VM whose sign-ins changed since it started, so its agents get the new ones.
   * `idle` runs with the backend still connected and says whether nothing runs there; the restart is also
   * dropped when a request holds the VM. Streams it ends see a VM starting rather than a dropped connection,
   * and requests arriving meanwhile wait for it and use the new connection.
   */
  restart(vmId: string, idle: (backend: Backend) => Promise<boolean>) {
    return this.exclusive(vmId, async () => {
      const vm = this.store.vm(vmId);
      const backend = this.backend(vmId);
      const box = this.boxes.get(vmId);
      if (!vm || !backend || !box || vm.t3Credentials === credentialsFingerprint(await this.credentials())) return;
      if (!(await idle(backend))) return;
      // Nothing may wait between this check and taking the backend away, or new work could start on a closing socket.
      if (this.leased(vmId)) return;
      const started = performance.now();
      this.backends.delete(vmId);
      this.setState(vmId, "starting");
      await backend.close();
      try {
        await this.connect(vm, box, vm.t3Version ?? (await resolveT3Version(this.settings.get("t3Version"))), async () => true);
        this.traffic.record({ kind: "system", operation: "restart T3 for new sign-ins", vmId, status: "ok", durationMs: Math.round(performance.now() - started) });
      } catch (error) {
        this.setState(vmId, "error", message(error));
        this.traffic.record({ kind: "system", operation: "restart T3 for new sign-ins", vmId, status: "error" });
        this.emit("offline", vmId);
        throw error;
      }
    });
  }

  /** Writes the current sign-ins to every awake VM now. Git uses them at once; agents once T3 restarts. */
  async shareCredentials() {
    const awake = this.connected().flatMap((vmId) => {
      const box = this.boxes.get(vmId);
      return box ? [{ vmId, box }] : [];
    });
    // A VM's Codex may have refreshed its tokens since VM Bridge last saw them. Keep the newest before overwriting.
    for (const { box } of awake) {
      const current = await readCodexAuth(box);
      if (current) this.agents.adoptCodex(current);
    }
    const credentials = await this.credentials();
    await Promise.all(
      awake.map(({ vmId, box }) =>
        this.exclusive(vmId, async () => {
          if (this.backend(vmId)) await writeCredentials(box, credentials);
        }).catch(() => this.traffic.record({ kind: "provider", operation: "write sign-ins", vmId, status: "error" })),
      ),
    );
  }

  /** Brings a VM's skills up to date. A VM that never had any skills, and still should not, is left alone. */
  private async syncSkills(vmId: string, box: Box) {
    const state = this.skills.state();
    if (!state.skills.length && !this.store.vm(vmId)?.skills) return;
    const started = performance.now();
    try {
      if (await syncSkills(box, state, (name) => this.skills.files(name))) {
        this.traffic.record({ kind: "provider", operation: "sync skills", vmId, status: "ok", durationMs: Math.round(performance.now() - started) });
      }
    } catch (error) {
      this.traffic.record({ kind: "provider", operation: "sync skills", vmId, status: "error" });
      throw error;
    }
    this.store.updateVm(vmId, { skills: state.fingerprint });
  }

  /**
   * Gives every awake VM the installed skills now, busy or not: they are only files, so nothing restarts and running
   * turns go on. Sleeping VMs get them when they wake, and VMs still waking get them before they connect.
   */
  async shareSkills() {
    await Promise.all(
      [...this.boxes.keys()].map((vmId) =>
        this.exclusive(vmId, async () => {
          const box = this.boxes.get(vmId);
          if (!box || !this.backend(vmId) || this.store.vm(vmId)?.skills === this.skills.state().fingerprint) return;
          await this.syncSkills(vmId, box);
        }).catch(() => {}),
      ),
    );
    this.emit("changed");
  }

  private async sleepBox(vmId: string, driver: Driver, box: Box) {
    this.boxes.delete(vmId);
    const { checkpoint } = await driver.sleep(box);
    this.store.updateVm(vmId, { checkpoint: checkpoint ?? null, lastSleptAt: Date.now() });
  }

  private disconnected(vmId: string, backend: Backend) {
    if (this.backends.get(vmId) !== backend) return;
    this.backends.delete(vmId);
    if (this.store.vm(vmId)?.state === "ready") this.setState(vmId, "error", "The T3 connection dropped. The next request reconnects.");
    this.traffic.record({ kind: "system", operation: "VM disconnected", vmId, status: "error" });
    this.emit("offline", vmId);
  }

  private markGone(vmId: string) {
    this.store.updateVm(vmId, { state: "gone", error: "The provider no longer has this VM." });
    for (const project of this.store.projects()) {
      if (project.vmId === vmId) this.store.updateProject(project.id, { vmId: null, checkoutPath: null });
    }
    this.emit("offline", vmId);
    this.emit("changed");
  }

  /**
   * Puts a VM to sleep. With `idle`, this is an idle sleep: `idle` runs with the backend still
   * connected and says whether the VM is still idle, and the sleep is also dropped when a request
   * holds the VM meanwhile. Once a sleep goes ahead, new requests wait for it and wake the VM again.
   */
  sleep(vmId: string, idle?: (backend: Backend) => Promise<boolean>) {
    return this.exclusive(vmId, async () => {
      const vm = this.store.vm(vmId);
      const backend = this.backends.get(vmId);
      // A checkpoint means the sandbox is already gone, such as after a failed wake put the VM back to sleep.
      if (!vm?.sandboxId || vm.checkpoint || vm.state === "sleeping" || vm.state === "gone") return;
      const started = performance.now();
      const driver = this.driver(vm.provider);
      const box = this.boxes.get(vmId) ?? (await driver.connect(vm.sandboxId));
      if (idle && backend?.open && !(await idle(backend))) return;
      // Nothing may wait between this check and taking the backend away, or new work could start on a closing socket.
      if (idle && this.leased(vmId)) return;
      this.backends.delete(vmId);
      // Before the socket closes, so streams it ends see a VM going to sleep rather than a dropped connection.
      this.setState(vmId, "sleeping");
      await backend?.close();
      this.emit("offline", vmId);
      try {
        await this.sleepBox(vmId, driver, box);
        this.emit("changed");
        this.traffic.record({ kind: "provider", operation: "sleep VM", vmId, status: "ok", durationMs: Math.round(performance.now() - started) });
      } catch (error) {
        this.setState(vmId, "error", message(error));
        this.traffic.record({ kind: "provider", operation: "sleep VM", vmId, status: "error" });
        throw error;
      }
    });
  }

  /** Extends provider-side auto-stop timers while agents work. */
  async keepAlive(vmId: string) {
    const vm = this.store.vm(vmId);
    const box = this.boxes.get(vmId);
    if (vm && box) await this.driver(vm.provider).keepAlive(box);
  }

  /** Deletes the VM at the provider. Its projects get a new VM next time. */
  destroy(vmId: string) {
    return this.exclusive(vmId, async () => {
      const vm = this.store.vm(vmId);
      if (!vm) return;
      this.backends.get(vmId)?.close();
      this.backends.delete(vmId);
      this.boxes.delete(vmId);
      if (vm.sandboxId && vm.state !== "gone") await this.driver(vm.provider).destroy(vm.sandboxId);
      // A VM asleep as a checkpoint has no sandbox left, only the checkpoint.
      if (vm.checkpoint) await this.driver(vm.provider).deleteCheckpoint(vm.checkpoint);
      this.store.deleteVm(vmId);
      this.traffic.record({ kind: "provider", operation: "delete VM", vmId, status: "ok" });
      this.emit("offline", vmId);
      this.emit("changed");
    });
  }

  /** Provider and size for a new VM holding this repository: its rule, else the defaults. */
  placement(url: string): { provider: ProviderId; size: VmSize } {
    const name = githubName(url)?.toLowerCase();
    const rule = name ? this.settings.get("repoRules").find((entry) => entry.repo.toLowerCase() === name) : undefined;
    // A rule naming a provider that was removed since falls back to the default.
    const provider = rule?.provider && this.settings.get("providers").includes(rule.provider) ? rule.provider : this.settings.get("defaultProvider");
    if (!provider) throw new NoProvider();
    return { provider, size: rule?.size ?? this.settings.get("vmSize") };
  }

  /** A VM to read T3's configuration from when none is cached: any existing VM, or a new one. Concurrent callers share one. */
  any(): Promise<string> {
    const added = this.settings.get("providers");
    const vms = this.store.vms().filter((vm) => added.includes(vm.provider) && vm.state !== "gone" && vm.sandboxId);
    const awake = vms.find((vm) => this.backend(vm.id));
    if (awake) return Promise.resolve(awake.id);
    this.bootstrapping ??= (async () => {
      const vmId = vms[0]?.id ?? (await this.create()).id;
      await this.ensure(vmId);
      return vmId;
    })().finally(() => (this.bootstrapping = undefined));
    return this.bootstrapping;
  }

  /**
   * The VM holding a project's checkout, creating, cloning and registering it as needed.
   * A VM without a project (such as the first one, started to read T3's configuration) is reused.
   */
  place(projectId: string, progress: (detail: string) => void = () => {}): Promise<string> {
    let flight = this.placing.get(projectId);
    if (!flight) {
      flight = this.exclusive(`project:${projectId}`, () => this.placeProject(projectId, progress)).finally(() =>
        this.placing.delete(projectId),
      );
      this.placing.set(projectId, flight);
    }
    return flight;
  }

  private async placeProject(projectId: string, progress: (detail: string) => void): Promise<string> {
    let project = this.store.project(projectId);
    if (!project) throw new Error("Unknown project.");
    if (project.vmId && project.checkoutPath) return project.vmId;
    if (!project.vmId) {
      const taken = new Set(this.store.projects().flatMap((p) => (p.vmId ? [p.vmId] : [])));
      const target = this.placement(project.url);
      const free = this.store
        .vms()
        .find((vm) => vm.provider === target.provider && vm.size === target.size && !taken.has(vm.id) && vm.state !== "gone" && vm.state !== "error" && vm.sandboxId);
      progress(free ? "Using an idle VM" : `Creating a VM on ${providers[target.provider].label}`);
      const vmId = free?.id ?? (await this.create(target)).id;
      this.store.updateProject(projectId, { vmId });
      this.emit("changed");
      project = { ...project, vmId };
    }
    const vmId = project.vmId!;
    progress("Starting the VM");
    const backend = await this.ensure(vmId);
    const release = this.lease(vmId);
    try {
      progress("Cloning the repository");
      const checkoutPath = await this.clone(vmId, project);
      progress("Registering the project with T3");
      await this.register(backend, project, checkoutPath);
      this.store.updateProject(projectId, { checkoutPath });
      this.emit("changed");
      return vmId;
    } finally {
      release();
    }
  }

  private async clone(vmId: string, project: ProjectRow): Promise<string> {
    const box = this.boxes.get(vmId);
    if (!box) throw new Error(`VM ${vmId} is not connected.`);
    const path = `${checkoutRoot}/${repoName(project.url)}`;
    const branch = project.branch ? `--branch ${quote(project.branch)} ` : "";
    const result = await box.run(
      `set -eu
. /workspace/.vmbridge/env
if [ -d ${quote(`${path}/.git`)} ]; then
  [ "$(git -C ${quote(path)} remote get-url origin)" = ${quote(project.url)} ] || { echo "${path} holds another repository" >&2; exit 3; }
else
  rm -rf ${quote(`${path}.cloning`)}
  GIT_TERMINAL_PROMPT=0 git clone ${branch}-- ${quote(project.url)} ${quote(`${path}.cloning`)}
  mv ${quote(`${path}.cloning`)} ${quote(path)}
fi`,
      { timeoutMs: 10 * 60_000 },
    );
    if (!result.ok) {
      const output = result.stderr.slice(-400);
      if (/not found|could not read|authentication|403|404/i.test(output)) {
        throw new Error("The VM could not read this repository. Check GitHub access in the VM Bridge dashboard.");
      }
      throw new Error(`Cloning failed: ${output}`);
    }
    return path;
  }

  private async register(backend: Backend, project: ProjectRow, checkoutPath: string) {
    const { projects } = await backend.json<{ projects: { id: string; workspaceRoot: string }[] }>("/api/projects");
    if (projects.some((p) => p.id === project.id)) return;
    const response = await backend.http("/api/projects/mutate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "project.create",
        commandId: crypto.randomUUID(),
        projectId: project.id,
        title: project.title,
        workspaceRoot: checkoutPath,
      }),
    });
    if (!response.ok) throw new Error(`T3 refused to register the project (${response.status}).`);
  }

  /** Reconnects VMs that were awake when VM Bridge stopped. */
  async resume() {
    for (const vm of this.store.vms()) {
      if (!["ready", "busy", "starting"].includes(vm.state)) continue;
      void this.ensure(vm.id).catch(() => {});
    }
  }

  private async credentials(): Promise<VmCredentials> {
    const token = this.secrets.get("github.token");
    const account = this.settings.get("github");
    const github = token && account ? { token, login: account.login, name: account.name ?? account.login, email: account.email } : undefined;
    const credentials = { ...(await this.agents.vmSecrets()), github };
    this.latest = credentialsFingerprint(credentials);
    return credentials;
  }

  /**
   * Refreshes the Codex sign-in when it is due and gives the new tokens to every awake VM, before
   * Codex there refreshes on its own and retires the refresh token the other VMs hold.
   */
  async syncCodexAuth() {
    if (!this.agents.codexDue()) return;
    const boxes = [...this.boxes.values()];
    for (const box of boxes) {
      const current = await readCodexAuth(box);
      if (current) this.agents.adoptCodex(current);
    }
    const authJson = await this.agents.refreshCodex(true);
    if (!authJson) return;
    await Promise.all(boxes.map((box) => writeCodexAuth(box, authJson).catch(() => {})));
  }

  close() {
    this.closed = true;
    for (const backend of this.backends.values()) backend.close();
    this.backends.clear();
  }
}

export const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
