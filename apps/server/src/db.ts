import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Append only. Each entry runs once, in order, tracked by PRAGMA user_version.
const migrations = [
  `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE secrets (name TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE admin_sessions (
    token_hash TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE pairing_links (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    redeemed_at INTEGER
  );

  CREATE TABLE clients (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_seen_at INTEGER,
    revoked_at INTEGER
  );

  CREATE TABLE vms (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    sandbox_id TEXT,
    name TEXT NOT NULL,
    size TEXT NOT NULL,
    state TEXT NOT NULL,
    error TEXT,
    endpoint TEXT,
    t3_token TEXT,
    t3_version TEXT,
    checkpoint TEXT,
    created_at INTEGER NOT NULL,
    last_activity_at INTEGER,
    last_connected_at INTEGER,
    last_slept_at INTEGER
  );

  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    branch TEXT,
    title TEXT NOT NULL,
    vm_id TEXT REFERENCES vms(id) ON DELETE SET NULL,
    checkout_path TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    vm_id TEXT NOT NULL REFERENCES vms(id) ON DELETE CASCADE
  );

  CREATE TABLE commands (
    id TEXT PRIMARY KEY,
    vm_id TEXT NOT NULL REFERENCES vms(id) ON DELETE CASCADE,
    fingerprint TEXT NOT NULL,
    thread_id TEXT
  );

  CREATE TABLE vm_snapshots (
    vm_id TEXT PRIMARY KEY REFERENCES vms(id) ON DELETE CASCADE,
    shell TEXT,
    config TEXT,
    scheduled_tasks TEXT
  );

  CREATE TABLE projections (
    thread_id TEXT PRIMARY KEY,
    vm_id TEXT NOT NULL REFERENCES vms(id) ON DELETE CASCADE,
    updated_at TEXT,
    data TEXT NOT NULL
  );

  CREATE TABLE clones (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    snapshot TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE held_commands (
    id TEXT PRIMARY KEY,
    vm_id TEXT NOT NULL REFERENCES vms(id) ON DELETE CASCADE,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
  // One active provider became a list of added providers with a default.
  `
  INSERT INTO settings (key, value) SELECT 'providers', json_array(json(value)) FROM settings WHERE key = 'activeProvider' AND value != 'null';
  INSERT INTO settings (key, value) SELECT 'defaultProvider', value FROM settings WHERE key = 'activeProvider';
  DELETE FROM settings WHERE key = 'activeProvider';
  `,
  `ALTER TABLE vms ADD COLUMN t3_credentials TEXT;`,
];

export function openDatabase(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path, { create: true, strict: true });
  // The database holds provider keys and tokens: owner-only. WAL side files share the 0700 directory.
  if (path !== ":memory:") chmodSync(path, 0o600);
  db.run("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  const { user_version: version } = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!;
  for (let next = version; next < migrations.length; next++) {
    db.transaction(() => {
      db.run(migrations[next]!);
      db.run(`PRAGMA user_version = ${next + 1}`);
    })();
  }
  return db;
}
