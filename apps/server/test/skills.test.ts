import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skillDescription } from "../src/skills.ts";
import { applyScript, skillHash, type SkillFile } from "../src/vm/skills.ts";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A VM's file system: VM Bridge's folder, a home folder, and Claude's config folder. */
function vm() {
  const base = mkdtempSync(join(tmpdir(), "vmbridge-vm-"));
  temps.push(base);
  const root = join(base, "vmbridge");
  const home = join(base, "home");
  const claude = join(root, "claude");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "skills.mjs"), applyScript);
  const apply = (skills: { name: string; files?: SkillFile[] }[]) => {
    const withHashes = skills.map((skill) => ({ ...skill, hash: skillHash(skill.files ?? []) }));
    writeFileSync(join(root, "skills-incoming.json"), JSON.stringify({ fingerprint: crypto.randomUUID(), skills: withHashes }));
    const result = Bun.spawnSync(["bun", join(root, "skills.mjs"), root], { env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: claude } });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  };
  return { root, apply, claudeSkills: join(claude, "skills"), codexSkills: join(home, ".agents", "skills") };
}

const file = (path: string, text: string): SkillFile => ({ path, data: Buffer.from(text).toString("base64") });

describe("the skills script on a VM", () => {
  test("links skills for both agents, and removes only what VM Bridge put there", () => {
    const { root, apply, claudeSkills, codexSkills } = vm();
    // Put there by the user or a repository.
    mkdirSync(join(codexSkills, "mine"), { recursive: true });
    mkdirSync(join(codexSkills, "shared"), { recursive: true });
    writeFileSync(join(codexSkills, "shared", "SKILL.md"), "the user's own");
    mkdirSync(claudeSkills, { recursive: true });
    symlinkSync("/opt/elsewhere/other", join(claudeSkills, "other"));

    apply([
      { name: "review", files: [file("SKILL.md", "v1"), file("scripts/run.sh", "echo")] },
      { name: "shared", files: [file("SKILL.md", "VM Bridge's")] },
    ]);
    for (const dir of [claudeSkills, codexSkills]) expect(readFileSync(join(dir, "review", "scripts", "run.sh"), "utf8")).toBe("echo");
    expect(readFileSync(join(claudeSkills, "shared", "SKILL.md"), "utf8")).toBe("VM Bridge's");
    // A skill already there under the same name wins.
    expect(readFileSync(join(codexSkills, "shared", "SKILL.md"), "utf8")).toBe("the user's own");

    // An update replaces the whole folder, so a file it dropped goes too. A skill sent without files is kept as it is.
    apply([{ name: "review", files: [file("SKILL.md", "v2")] }, { name: "shared" }]);
    expect(readFileSync(join(codexSkills, "review", "SKILL.md"), "utf8")).toBe("v2");
    expect(existsSync(join(root, "skills", "review", "scripts"))).toBe(false);
    expect(readFileSync(join(claudeSkills, "shared", "SKILL.md"), "utf8")).toBe("VM Bridge's");

    apply([]);
    expect(existsSync(join(root, "skills", "review"))).toBe(false);
    expect(existsSync(join(claudeSkills, "review"))).toBe(false);
    expect(existsSync(join(claudeSkills, "shared"))).toBe(false);
    expect(lstatSync(join(codexSkills, "review"), { throwIfNoEntry: false })).toBeUndefined();
    expect(existsSync(join(codexSkills, "mine"))).toBe(true);
    expect(readFileSync(join(codexSkills, "shared", "SKILL.md"), "utf8")).toBe("the user's own");
    expect(readlinkSync(join(claudeSkills, "other"))).toBe("/opt/elsewhere/other");
  });

  test("refuses a file outside the skill's folder", () => {
    const { root, apply } = vm();
    expect(() => apply([{ name: "evil", files: [file("../../escape", "x")] }])).toThrow("Unsafe path");
    expect(existsSync(join(root, "escape"))).toBe(false);
  });
});

test("reads a skill's description in each YAML form", () => {
  expect(skillDescription("---\nname: a\ndescription: Plain words.\n---\n")).toBe("Plain words.");
  expect(skillDescription('---\ndescription: "Quoted: words."\n---\n')).toBe("Quoted: words.");
  expect(skillDescription("---\ndescription: >\n  Folded\n  words.\nname: a\n---\n")).toBe("Folded words.");
  expect(skillDescription("# No front matter")).toBeNull();
});
