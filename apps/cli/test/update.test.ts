import { expect, test } from "bun:test";
import { verifyChecksum } from "../src/update.ts";

const bytes = new TextEncoder().encode("a VM Bridge build");
const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

test("accepts a download whose SHA-256 is the one SHA256SUMS lists for its file", () => {
  expect(() => verifyChecksum(bytes, `${"0".repeat(64)}  vmbridge-linux-x64\n${hash}  vmbridge-darwin-arm64\n`, "vmbridge-darwin-arm64")).not.toThrow();
});

test("refuses a changed download, and one the release lists no checksum for", () => {
  const changed = new TextEncoder().encode("a VM Bridge build, changed");
  expect(() => verifyChecksum(changed, `${hash}  vmbridge-darwin-arm64\n`, "vmbridge-darwin-arm64")).toThrow("does not match its checksum");
  // The right hash under another file's name does not vouch for this one.
  expect(() => verifyChecksum(bytes, `${hash}  vmbridge-linux-x64\n`, "vmbridge-darwin-arm64")).toThrow("no checksum for vmbridge-darwin-arm64");
});
