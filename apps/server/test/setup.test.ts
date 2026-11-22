import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Box } from "../src/providers/index.ts";
import { prepareVm } from "../src/vm/runtime.ts";

// A curl that logs every URL and answers only GitHub CLI release downloads, with a fake gh of the asked version,
// and only when GH_DOWNLOADS is set. Everything else fails, as GitHub's API does for anonymous calls from boxd.
const fakeCurl = `#!/bin/bash
for url; do :; done
echo "$url" >> "$CURL_LOG"
case "$url" in
  https://github.com/cli/cli/releases/download/*)
    [ -n "\${GH_DOWNLOADS:-}" ] || exit 22
    version="\${url##*/gh_}"; version="\${version%%_linux*}"
    dir="$(mktemp -d)"; mkdir -p "$dir/gh/bin"
    printf '#!/bin/sh\\necho "gh version %s (test)"\\n' "$version" > "$dir/gh/bin/gh"; chmod +x "$dir/gh/bin/gh"
    tar -cz -C "$dir" gh ;;
  *) exit 22 ;;
esac
`;

let dir: string;
beforeEach(async () => {
  // The VM's /workspace, moved into a temporary folder, with the setup script as prepareVm writes it.
  dir = mkdtempSync(join(tmpdir(), "vmbridge-setup-"));
  const written: Record<string, string> = {};
  const box = {
    run: async () => ({ ok: true, exitCode: 0, stdout: "", output: "" }),
    files: { write: async (files: Record<string, string>) => Object.assign(written, files) },
  } as unknown as Box;
  await prepareVm(box, "1.0.0", {});
  mkdirSync(join(dir, ".vmbridge"));
  for (const [path, text] of Object.entries(written)) writeFileSync(path.replaceAll("/workspace", dir), text.replaceAll("/workspace", dir));
  mkdirSync(join(dir, "bin"));
  // npm and t3 do nothing: only the GitHub CLI step is under test.
  for (const [name, text] of Object.entries({ curl: fakeCurl, npm: "#!/bin/sh\n", t3: "#!/bin/sh\n" })) {
    writeFileSync(join(dir, "bin", name), text);
    chmodSync(join(dir, "bin", name), 0o755);
  }
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function setup(env: Record<string, string> = {}) {
  const run = Bun.spawnSync(["bash", join(dir, ".vmbridge/setup.sh"), "1.0.0"], {
    env: { PATH: `${join(dir, "bin")}:${process.env.PATH}`, HOME: dir, CURL_LOG: join(dir, "curl.log"), ...env },
  });
  const urls = existsSync(join(dir, "curl.log")) ? readFileSync(join(dir, "curl.log"), "utf8").trim().split("\n") : [];
  return { exitCode: run.exitCode, stderr: run.stderr.toString(), urls };
}

describe("VM setup", () => {
  test("finishes without the GitHub CLI when GitHub refuses its download", () => {
    const { exitCode, stderr, urls } = setup();
    expect(exitCode).toBe(0);
    expect(stderr).toContain("Could not install the GitHub CLI");
    expect(existsSync(join(dir, ".vmbridge/gh"))).toBe(false);
    expect(existsSync(join(dir, ".vmbridge/gh.new"))).toBe(false);
    expect(urls.filter((url) => url.includes("api.github.com"))).toEqual([]);
  });

  test("installs the pinned GitHub CLI from its release download, without GitHub's API, once", () => {
    const first = setup({ GH_DOWNLOADS: "1" });
    expect(first.exitCode).toBe(0);
    expect(first.urls).toHaveLength(1);
    expect(first.urls[0]).toMatch(/^https:\/\/github\.com\/cli\/cli\/releases\/download\/v[\d.]+\/gh_[\d.]+_linux_(amd64|arm64)\.tar\.gz$/);
    const gh = Bun.spawnSync([join(dir, ".vmbridge/gh/bin/gh"), "--version"]);
    expect(gh.stdout.toString()).toStartWith("gh version ");

    const again = setup({ GH_DOWNLOADS: "1" });
    expect(again.exitCode).toBe(0);
    expect(again.urls).toHaveLength(1);
  });
});
