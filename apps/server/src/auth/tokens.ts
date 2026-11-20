import { createHash, randomBytes } from "node:crypto";

export const newToken = (): string => randomBytes(32).toString("base64url");

/** Tokens are stored only as hashes, so a copied database cannot be replayed as a session. */
export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");
