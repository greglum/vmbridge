import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Box } from "../src/providers/index.ts";
import { envNameProblem, prepareVm, type VmCredentials } from "../src/vm/runtime.ts";

async function envFile(credentials: VmCredentials) {
  const written: Record<string, string> = {};
  const box = {
    run: async () => ({ ok: true, exitCode: 0, stdout: "", output: "" }),
    files: { write: async (files: Record<string, string>) => Object.assign(written, files) },
  } as unknown as Box;
  await prepareVm(box, "1.0.0", credentials);
  return written["/workspace/.vmbridge/env"]!;
}

describe("environment variables", () => {
  test.each(["bash", "sh"])("values come out of the env file exactly as set, read by %s", async (shell) => {
    const values = {
      SPACES: "  two  spaces  ",
      QUOTES: `it's "quoted" and 'again'`,
      DOLLAR: "$HOME ${PATH} $(whoami) `id` \\n stays",
      NEWLINES: "first\nsecond\n\nfourth\n",
      EMPTY: "",
    };
    const dir = mkdtempSync(join(tmpdir(), "vmbridge-env-"));
    try {
      const file = join(dir, "env");
      writeFileSync(file, await envFile({ env: values }));
      for (const [name, value] of Object.entries(values)) {
        const read = Bun.spawnSync([shell, "-c", `. ${file} && printf '%s' "$${name}"`]);
        expect(read.stdout.toString()).toBe(value);
      }
      // Set even when empty, unlike a variable VM Bridge leaves out.
      expect(Bun.spawnSync([shell, "-c", `. ${file} && printf '%s' "\${EMPTY-unset}"`]).stdout.toString()).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("names VM Bridge sets, or that would break shells and agents, are refused", () => {
    for (const name of ["PATH", "HOME", "SHELL", "IFS", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "GH_TOKEN", "GITHUB_TOKEN", "GIT_TERMINAL_PROMPT", "ANTHROPIC_API_KEY", "T3CODE_HOME", "T3CODE_ANYTHING", "VMBRIDGE_CREDENTIALS", "LD_PRELOAD"]) {
      expect(envNameProblem(name)).toContain("reserved");
    }
    for (const name of ["", "1ABC", "MY-VAR", "MY VAR", "A=B", "ÄPI"]) expect(envNameProblem(name)).toStartWith("Use letters");
    for (const name of ["API_URL", "_private", "npm_config_registry", "Path"]) expect(envNameProblem(name)).toBeNull();
  });
});
