import type { Database } from "bun:sqlite";
import type { ProviderId, VmSize, VmState } from "@vmbridge/contracts";

export interface VmRow {
  id: string;
  provider: ProviderId;
  sandboxId: string | null;
  name: string;
  size: VmSize;
  state: VmState;
  error: string | null;
  t3Token: string | null;
  t3Version: string | null;
  checkpoint: string | null;
  createdAt: number;
  lastActivityAt: number | null;
  lastConnectedAt: number | null;
  lastSleptAt: number | null;
}

export interface ProjectRow {
  id: string;
  url: string;
  branch: string | null;
  title: string;
  vmId: string | null;
  /** Absolute checkout path on the VM, once cloned. */
  checkoutPath: string | null;
  createdAt: number;
}

const vmColumns = `id, provider, sandbox_id AS sandboxId, name, size, state, error, t3_token AS t3Token,
  t3_version AS t3Version, checkpoint, created_at AS createdAt, last_activity_at AS lastActivityAt,
  last_connected_at AS lastConnectedAt, last_slept_at AS lastSleptAt`;

const projectColumns = `id, url, branch, title, vm_id AS vmId, checkout_path AS checkoutPath, created_at AS createdAt`;

const vmFields = {
  sandboxId: "sandbox_id",
  state: "state",
  error: "error",
  t3Token: "t3_token",
  t3Version: "t3_version",
  checkpoint: "checkpoint",
  lastActivityAt: "last_activity_at",
  lastConnectedAt: "last_connected_at",
  lastSleptAt: "last_slept_at",
} as const satisfies Partial<Record<keyof VmRow, string>>;

type VmUpdate = Partial<Pick<VmRow, keyof typeof vmFields>>;

const projectFields = { vmId: "vm_id", checkoutPath: "checkout_path", branch: "branch", title: "title" } as const;

type ProjectUpdate = Partial<Pick<ProjectRow, keyof typeof projectFields>>;

/** JSON caches of what each VM's T3 server last reported, kept so sleeping VMs still render. */
type SnapshotKind = "shell" | "config" | "scheduled_tasks";

function assignments<T extends object>(fields: Record<string, string>, update: T) {
  const entries = Object.entries(update).filter(([key]) => key in fields);
  return {
    sql: entries.map(([key]) => `${fields[key]} = ?`).join(", "),
    values: entries.map(([, value]) => value as string | number | null),
  };
}

/** Typed access to fleet, project, and routing tables. */
export class Store {
  constructor(readonly db: Database) {}

  vms(): VmRow[] {
    return this.db.query<VmRow, []>(`SELECT ${vmColumns} FROM vms ORDER BY created_at`).all();
  }

  vm(id: string): VmRow | null {
    return this.db.query<VmRow, [string]>(`SELECT ${vmColumns} FROM vms WHERE id = ?`).get(id);
  }

  insertVm(vm: Pick<VmRow, "id" | "provider" | "name" | "size" | "state" | "createdAt">) {
    this.db
      .query("INSERT INTO vms (id, provider, name, size, state, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(vm.id, vm.provider, vm.name, vm.size, vm.state, vm.createdAt);
  }

  updateVm(id: string, update: VmUpdate) {
    const { sql, values } = assignments(vmFields, update);
    if (sql) this.db.query(`UPDATE vms SET ${sql} WHERE id = ?`).run(...values, id);
  }

  /** Forgets a VM. Its projects stay and get a fresh VM next time they are used. */
  deleteVm(id: string) {
    this.db.transaction(() => {
      this.db.query("UPDATE projects SET checkout_path = NULL WHERE vm_id = ?").run(id);
      this.db.query("DELETE FROM vms WHERE id = ?").run(id);
    })();
  }

  projects(): ProjectRow[] {
    return this.db.query<ProjectRow, []>(`SELECT ${projectColumns} FROM projects ORDER BY created_at`).all();
  }

  project(id: string): ProjectRow | null {
    return this.db.query<ProjectRow, [string]>(`SELECT ${projectColumns} FROM projects WHERE id = ?`).get(id);
  }

  insertProject(project: Omit<ProjectRow, "vmId" | "checkoutPath">) {
    this.db
      .query("INSERT INTO projects (id, url, branch, title, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(project.id, project.url, project.branch, project.title, project.createdAt);
  }

  updateProject(id: string, update: ProjectUpdate) {
    const { sql, values } = assignments(projectFields, update);
    if (sql) this.db.query(`UPDATE projects SET ${sql} WHERE id = ?`).run(...values, id);
  }

  deleteProject(id: string) {
    this.db.query("DELETE FROM projects WHERE id = ?").run(id);
  }

  snapshot<T>(vmId: string, kind: SnapshotKind): T | null {
    const row = this.db
      .query<{ value: string | null }, [string]>(`SELECT ${kind} AS value FROM vm_snapshots WHERE vm_id = ?`)
      .get(vmId);
    return row?.value ? (JSON.parse(row.value) as T) : null;
  }

  snapshots<T>(kind: SnapshotKind): Map<string, T> {
    const rows = this.db
      .query<{ vmId: string; value: string }, []>(
        `SELECT vm_id AS vmId, ${kind} AS value FROM vm_snapshots WHERE ${kind} IS NOT NULL`,
      )
      .all();
    return new Map(rows.map((row) => [row.vmId, JSON.parse(row.value) as T]));
  }

  saveSnapshot(vmId: string, kind: SnapshotKind, value: unknown) {
    this.db
      .query(
        `INSERT INTO vm_snapshots (vm_id, ${kind}) VALUES (?, ?) ON CONFLICT (vm_id) DO UPDATE SET ${kind} = excluded.${kind}`,
      )
      .run(vmId, JSON.stringify(value));
  }

  threadVm(threadId: string): string | null {
    return (
      this.db.query<{ vmId: string }, [string]>("SELECT vm_id AS vmId FROM threads WHERE id = ?").get(threadId)?.vmId ??
      null
    );
  }

  setThreadVm(threadId: string, vmId: string) {
    this.db
      .query("INSERT INTO threads (id, vm_id) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET vm_id = excluded.vm_id")
      .run(threadId, vmId);
  }

  command(id: string) {
    return this.db
      .query<{ vmId: string; fingerprint: string; threadId: string | null }, [string]>(
        "SELECT vm_id AS vmId, fingerprint, thread_id AS threadId FROM commands WHERE id = ?",
      )
      .get(id);
  }

  saveCommand(id: string, vmId: string, fingerprint: string, threadId: string | null) {
    this.db
      .query("INSERT OR IGNORE INTO commands (id, vm_id, fingerprint, thread_id) VALUES (?, ?, ?, ?)")
      .run(id, vmId, fingerprint, threadId);
  }

  projection<T>(threadId: string): T | null {
    const row = this.db
      .query<{ data: string }, [string]>("SELECT data FROM projections WHERE thread_id = ?")
      .get(threadId);
    return row ? (JSON.parse(row.data) as T) : null;
  }

  hasProjection(threadId: string) {
    return this.db.query("SELECT 1 FROM projections WHERE thread_id = ?").get(threadId) !== null;
  }

  /** Keeps the newest projection: a late, older response never replaces a newer one. */
  saveProjection(threadId: string, vmId: string, updatedAt: string | null, data: unknown) {
    this.db
      .query(
        `INSERT INTO projections (thread_id, vm_id, updated_at, data) VALUES (?, ?, ?, ?)
         ON CONFLICT (thread_id) DO UPDATE SET vm_id = excluded.vm_id, updated_at = excluded.updated_at, data = excluded.data
         WHERE projections.updated_at IS NULL OR excluded.updated_at IS NULL OR excluded.updated_at >= projections.updated_at`,
      )
      .run(threadId, vmId, updatedAt, JSON.stringify(data));
  }

  clones<T>(): T[] {
    return this.db
      .query<{ snapshot: string }, []>("SELECT snapshot FROM clones")
      .all()
      .map((row) => JSON.parse(row.snapshot) as T);
  }

  saveClone(projectId: string, snapshot: unknown) {
    this.db
      .query(
        "INSERT INTO clones (project_id, snapshot) VALUES (?, ?) ON CONFLICT (project_id) DO UPDATE SET snapshot = excluded.snapshot",
      )
      .run(projectId, JSON.stringify(snapshot));
  }
}
