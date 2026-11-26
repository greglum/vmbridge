import { describe, expect, test } from "bun:test";
import type { CreatedPairing, PairingLink } from "@vmbridge/contracts";
import { pairingListLimit, reconcileCreatedPairing } from "./pairing.ts";

const created: CreatedPairing = {
  link: { id: "p1", name: "Laptop", createdAt: 1_000, expiresAt: 10_000, redeemedAt: null },
  urls: [{ kind: "local", label: "Local", url: "https://example.test/#pair=1" }],
};

describe("reconcileCreatedPairing", () => {
  test("keeps the panel while the link is unredeemed and unexpired in the server list", () => {
    const links: PairingLink[] = [created.link];
    expect(reconcileCreatedPairing(created, links, 5_000)).toBe(created);
  });

  test("clears the panel once the link is redeemed, cancelled, or expired", () => {
    expect(reconcileCreatedPairing(created, [{ ...created.link, redeemedAt: 4_000 }], 5_000)).toBeNull();
    expect(reconcileCreatedPairing(created, [], 5_000)).toBeNull();
    expect(reconcileCreatedPairing(created, [created.link], 10_000)).toBeNull();
    expect(reconcileCreatedPairing(null, [created.link], 5_000)).toBeNull();
  });

  test("does not mistake a 50-item server page cutoff for cancellation", () => {
    const newerPage: PairingLink[] = Array.from({ length: pairingListLimit }, (_, index) => ({
      id: `newer-${index}`,
      name: `Device ${index}`,
      createdAt: 2_000 + index,
      expiresAt: 20_000,
      redeemedAt: null,
    }));
    expect(reconcileCreatedPairing(created, newerPage, 5_000)).toBe(created);

    // If the link falls within the returned window (newer than the oldest returned entry), absence still means cancelled.
    const windowCoveringCreated: PairingLink[] = [
      ...newerPage.slice(0, pairingListLimit - 1),
      { id: "older", name: "Older", createdAt: 500, expiresAt: 20_000, redeemedAt: null },
    ];
    expect(reconcileCreatedPairing(created, windowCoveringCreated, 5_000)).toBeNull();
  });
});
