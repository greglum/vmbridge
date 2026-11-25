import { expect, test } from "bun:test";
import { checksumFor, isNewer, latestVersion } from "../src/release.ts";

test("compares release versions by number, with a prerelease before its release", () => {
  expect(isNewer("1.2.0", "1.1.9")).toBe(true);
  expect(isNewer("1.10.0", "1.9.0")).toBe(true);
  expect(isNewer("v2.0.0", "1.99.99")).toBe(true);
  expect(isNewer("1.2.0", "1.2.0-beta.1")).toBe(true);
  expect(isNewer("1.1.5", "1.1.5")).toBe(false);
  expect(isNewer("1.1.4", "1.1.5")).toBe(false);
  expect(isNewer("1.2.0-beta.1", "1.2.0")).toBe(false);
  expect(isNewer("latest", "1.0.0")).toBe(false);
  expect(isNewer("1.2", "1.0.0")).toBe(false);
});

test("finds a file's checksum in SHA256SUMS, in text or binary mode, and nothing for other files", () => {
  const hash = "a".repeat(64);
  const other = "B".repeat(64);
  const sums = `${other}  vmbridge-linux-x64\n${hash} *vmbridge-darwin-arm64\n`;
  expect(checksumFor(sums, "vmbridge-darwin-arm64")).toBe(hash);
  expect(checksumFor(sums, "vmbridge-linux-x64")).toBe("b".repeat(64));
  expect(checksumFor(sums, "vmbridge-linux-arm64")).toBeNull();
  // A name that only starts like the file, or a line that is not a checksum, does not count.
  expect(checksumFor(`${hash}  vmbridge-darwin-arm64.sig\nnot-a-hash  vmbridge-linux-arm64\n`, "vmbridge-darwin-arm64")).toBeNull();
  expect(checksumFor("not-a-hash  vmbridge-linux-arm64\n", "vmbridge-linux-arm64")).toBeNull();
});

test("reads the latest version from the release tag", async () => {
  const answer = (status: number, body: unknown) => async () => Response.json(body, { status });
  expect(await latestVersion(answer(200, { tag_name: "v1.2.3" }))).toBe("1.2.3");
  await expect(latestVersion(answer(403, { message: "rate limited" }))).rejects.toThrow("403");
  await expect(latestVersion(answer(200, { tag_name: "nightly" }))).rejects.toThrow("no version tag");
});
