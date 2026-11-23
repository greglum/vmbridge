import { hashToken, newToken } from "../auth/tokens.ts";
import type { Encryption } from "../encryption.ts";
import type { Sql } from "../sql.ts";

/** The shape `newToken` makes: 32 random bytes in base64url. Anything else is not looked up at all. */
const tokenShape = /^[A-Za-z0-9_-]{43}$/;

const context = (vmId: string) => `watch:${vmId}`;

/**
 * Watch links, one per VM: `/watch/<token>` shows the VM's screen to anyone holding the token, so the token is the
 * only credential. It is stored sealed, because VM Bridge hands it to the VM again on every wake, and looked up by
 * its SHA-256 hash. A link stays until it is turned off or replaced, or its VM is deleted.
 */
export class WatchLinks {
  constructor(
    private readonly db: Sql,
    private readonly encryption: Encryption,
  ) {}

  /** Makes a new link for the VM, replacing any it had. Returns the token. */
  create(vmId: string): string {
    const token = newToken();
    this.db.run(
      `INSERT INTO watch_links (vm_id, token_hash, token, created_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (vm_id) DO UPDATE SET token_hash = ?2, token = ?3, created_at = ?4`,
      vmId, hashToken(token), this.encryption.seal(token, context(vmId)), Date.now(),
    );
    return token;
  }

  /** Turns the VM's link off. It stays off: VM Bridge only makes links for VMs that never had one. */
  off(vmId: string): void {
    this.db.run(
      `INSERT INTO watch_links (vm_id, token_hash, token, created_at) VALUES (?1, NULL, NULL, ?2)
       ON CONFLICT (vm_id) DO UPDATE SET token_hash = NULL, token = NULL, created_at = ?2`,
      vmId, Date.now(),
    );
  }

  /** Whether the VM ever had a link, on or off. */
  has(vmId: string): boolean {
    return this.db.one("SELECT 1 FROM watch_links WHERE vm_id = ?", vmId) !== undefined;
  }

  /** The VM's current token, or null while its link is off. */
  token(vmId: string): string | null {
    const row = this.db.one<{ token: string | null }>("SELECT token FROM watch_links WHERE vm_id = ?", vmId);
    return row?.token ? this.encryption.open(row.token, context(vmId)) : null;
  }

  /** The VM a token opens, or null for a wrong, replaced or turned off one. */
  vmFor(token: string): string | null {
    if (!tokenShape.test(token)) return null;
    return this.db.one<{ vmId: string }>("SELECT vm_id AS vmId FROM watch_links WHERE token_hash = ?", hashToken(token))?.vmId ?? null;
  }
}
