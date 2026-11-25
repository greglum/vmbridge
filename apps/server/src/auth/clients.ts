import type { Sql } from "../sql.ts";
import type { ClientInfo, PairingLink } from "@vmbridge/contracts";
import { hashToken, newToken } from "./tokens.ts";

export const pairingLinkMs = 15 * 60_000;
export const clientSessionMs = 30 * 86_400_000;
const ticketMs = 30_000;

/** What a ticket opens: the RPC WebSocket, or a media stream such as a preview tab's. T3 asks for each separately. */
export type TicketUse = "rpc" | "media";
// How often a device in use writes its last-seen time and pushes its session forward, or its connected time.
const touchEveryMs = 60_000;

/** Why a credential was refused, and the device it belongs to when VM Bridge can tell. Never holds the credential. */
export interface Refusal {
  reason: string;
  clientId?: string;
}

interface ClientRow {
  id: string;
  name: string;
  created_at: number;
  expires_at: number;
  last_seen_at: number | null;
  last_connected_at: number | null;
}

/**
 * T3 devices pair with a one-use link, exchange it for a bearer token, and then
 * fetch short-lived single-use tickets to open the RPC WebSocket or a media stream.
 * Each paired device keeps the name of the link it used.
 */
export class Clients {
  private readonly tickets = new Map<string, { clientId: string; use: TicketUse; expiresAt: number }>();
  /** When each connected device last wrote its connected time. */
  private readonly connectedWrites = new Map<string, number>();

  constructor(private readonly db: Sql) {}

  createLink(name: string): { link: PairingLink; token: string } {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 60) throw new Error("Name the device in 1 to 60 characters.");
    const token = newToken();
    const now = Date.now();
    const link: PairingLink = { id: crypto.randomUUID(), name: trimmed, createdAt: now, expiresAt: now + pairingLinkMs, redeemedAt: null };
    this.db.run(
      "INSERT INTO pairing_links (id, name, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
      link.id, link.name, hashToken(token), link.createdAt, link.expiresAt,
    );
    return { link, token };
  }

  links(): PairingLink[] {
    return this.db.all<{ id: string; name: string; created_at: number; expires_at: number; redeemed_at: number | null }>(
      "SELECT id, name, created_at, expires_at, redeemed_at FROM pairing_links ORDER BY created_at DESC LIMIT 50",
    )
      .map((row) => ({ id: row.id, name: row.name, createdAt: row.created_at, expiresAt: row.expires_at, redeemedAt: row.redeemed_at }));
  }

  deleteLink(id: string): void {
    this.db.run("DELETE FROM pairing_links WHERE id = ?", id);
  }

  /** Redeems a pairing token once. Returns a new bearer token for the device, or null. */
  exchange(pairingToken: string): string | null {
    const now = Date.now();
    return this.db.transaction(() => {
      const link = this.db.one<{ id: string; name: string }>(
        "SELECT id, name FROM pairing_links WHERE token_hash = ? AND redeemed_at IS NULL AND expires_at > ?",
        hashToken(pairingToken), now,
      );
      if (!link) return null;
      this.db.run("UPDATE pairing_links SET redeemed_at = ? WHERE id = ?", now, link.id);
      const access = newToken();
      this.db.run(
        "INSERT INTO clients (id, name, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
        crypto.randomUUID(), link.name, hashToken(access), now, now + clientSessionMs,
      );
      return access;
    });
  }

  /** The client behind a bearer token, if the session is live. Each use keeps the session alive for another 30 days. */
  authenticate(bearer: string): { id: string; name: string; expiresAt: number } | null {
    const row = this.db.one<ClientRow>(
      "SELECT id, name, created_at, expires_at, last_seen_at, last_connected_at FROM clients WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?",
      hashToken(bearer), Date.now(),
    );
    return row ? { id: row.id, name: row.name, expiresAt: this.touch(row) } : null;
  }

  /** Why `authenticate` refused a bearer token. A removed or expired device is named, since it no longer shows in the list. */
  refusal(bearer: string): Refusal {
    const row = this.db.one<{ id: string; name: string; expires_at: number; revoked_at: number | null }>(
      "SELECT id, name, expires_at, revoked_at FROM clients WHERE token_hash = ?",
      hashToken(bearer),
    );
    if (!row) return { reason: "unknown token" };
    if (row.revoked_at !== null) return { reason: `token of removed device "${row.name}"`, clientId: row.id };
    return { reason: `session of "${row.name}" expired`, clientId: row.id };
  }

  valid(clientId: string): boolean {
    return (
      this.db.one("SELECT 1 FROM clients WHERE id = ? AND revoked_at IS NULL AND expires_at > ?", clientId, Date.now()) !== undefined
    );
  }

  /** Marks the device seen and slides its session forward, at most once a minute so requests don't each write. Returns the expiry. */
  private touch(row: ClientRow): number {
    const now = Date.now();
    if (row.last_seen_at !== null && now - row.last_seen_at < touchEveryMs) return row.expires_at;
    const expiresAt = now + clientSessionMs;
    this.db.run("UPDATE clients SET last_seen_at = ?, expires_at = ? WHERE id = ?", now, expiresAt, row.id);
    return expiresAt;
  }

  list(connected: ReadonlySet<string>): ClientInfo[] {
    return this.db.all<ClientRow>(
      "SELECT id, name, created_at, expires_at, last_seen_at, last_connected_at FROM clients WHERE revoked_at IS NULL AND expires_at > ? ORDER BY created_at",
      Date.now(),
    )
      .map((row) => ({
        id: row.id,
        name: row.name,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        lastSeenAt: row.last_seen_at,
        lastConnectedAt: row.last_connected_at,
        connected: connected.has(row.id),
      }));
  }

  revoke(clientId: string): void {
    this.db.run("UPDATE clients SET revoked_at = ? WHERE id = ?", Date.now(), clientId);
  }

  ticket(clientId: string, use: TicketUse = "rpc"): { ticket: string; expiresAt: number } {
    const now = Date.now();
    for (const [key, entry] of this.tickets) if (entry.expiresAt < now) this.tickets.delete(key);
    const ticket = newToken();
    const expiresAt = now + ticketMs;
    this.tickets.set(hashToken(ticket), { clientId, use, expiresAt });
    return { ticket, expiresAt };
  }

  /**
   * Single use: a ticket is consumed whether or not it is still valid, and opens only what it was issued for. A used
   * ticket is gone, so it cannot be tied to its device.
   */
  redeemTicket(ticket: string, use: TicketUse = "rpc"): { clientId: string } | { refused: Refusal } {
    if (!ticket) return { refused: { reason: "no ticket" } };
    const key = hashToken(ticket);
    const entry = this.tickets.get(key);
    this.tickets.delete(key);
    if (!entry) return { refused: { reason: "unknown or used ticket" } };
    const { clientId } = entry;
    if (entry.use !== use) return { refused: { reason: `${entry.use} ticket used for ${use}`, clientId } };
    if (entry.expiresAt <= Date.now()) return { refused: { reason: "expired ticket", clientId } };
    if (!this.valid(clientId)) return { refused: { reason: "device removed or its session expired", clientId } };
    return { clientId };
  }

  /** Records that the device's RPC WebSocket is open now. At most once a minute unless `now` is asked, as on open and close. */
  markConnected(clientId: string, now = false): void {
    const at = Date.now();
    if (!now && at - (this.connectedWrites.get(clientId) ?? 0) < touchEveryMs) return;
    this.connectedWrites.set(clientId, at);
    this.db.run("UPDATE clients SET last_connected_at = ? WHERE id = ?", at, clientId);
  }
}
