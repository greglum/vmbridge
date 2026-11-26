import type { CreatedPairing, PairingLink } from "@vmbridge/contracts";

/** Matches `Clients.listPairings` (`LIMIT 50`) so truncation is not mistaken for cancellation. */
export const pairingListLimit = 50;

/** Keeps a newly created pairing panel only while its link is still active in the latest server list and unexpired. */
export function reconcileCreatedPairing(
  created: CreatedPairing | null,
  links: readonly PairingLink[],
  now: number,
): CreatedPairing | null {
  if (!created || created.link.expiresAt <= now) return null;
  const current = links.find((link) => link.id === created.link.id);
  if (current) {
    return current.redeemedAt || current.expiresAt <= now ? null : created;
  }
  // If the list hit its server page cap and the link is older than the returned window, absence does not prove deletion.
  if (links.length >= pairingListLimit) {
    const oldestReturned = Math.min(...links.map((link) => link.createdAt));
    if (created.link.createdAt <= oldestReturned) return created;
  }
  return null;
}
