import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/bun/sqlite.ts";
import { readSkillFolder, skillDescription, Skills } from "../src/skills.ts";
import { applyScript, instructionHash, skillHash, type InstructionsState, type SkillFile } from "../src/vm/skills.ts";
import { testEncryption } from "./key.ts";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A VM's file system: VM Bridge's folder, a home folder, and Claude's and Codex's config folders, as the env file sets them. */
function vm() {
  const base = mkdtempSync(join(tmpdir(), "vmbridge-vm-"));
  temps.push(base);
  const root = join(base, "vmbridge");
  const home = join(base, "home");
  const claude = join(root, "claude");
  const codex = join(root, "codex");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "skills.mjs"), applyScript);
  const apply = (skills: { name: string; files?: SkillFile[] }[], instructions: Partial<Record<InstructionsState[number]["agent"], string>> = {}) => {
    const withHashes = skills.map((skill) => ({ ...skill, hash: skillHash(skill.files ?? []) }));
    const files = Object.entries(instructions).map(([agent, text]) => ({ agent, text, hash: instructionHash(text) }));
    writeFileSync(join(root, "skills-incoming.json"), JSON.stringify({ fingerprint: crypto.randomUUID(), skills: withHashes, instructions: files }));
    const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex, XDG_CONFIG_HOME: "" };
    const result = Bun.spawnSync(["bun", join(root, "skills.mjs"), root], { env });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  };
  return {
    root,
    apply,
    claudeSkills: join(claude, "skills"),
    codexSkills: join(home, ".agents", "skills"),
    instructions: { claude: join(claude, "CLAUDE.md"), codex: join(codex, "AGENTS.md"), opencode: join(home, ".config", "opencode", "AGENTS.md") },
  };
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

describe("instructions on a VM", () => {
  test("go where each agent reads them, and only the files VM Bridge wrote change", () => {
    const { apply, instructions: paths } = vm();
    apply([], { claude: "claude v1", codex: "codex v1" });
    expect(readFileSync(paths.claude, "utf8")).toBe("claude v1");
    expect(readFileSync(paths.codex, "utf8")).toBe("codex v1");
    expect(existsSync(paths.opencode)).toBe(false);

    // Edited on the VM, so no longer VM Bridge's: an update leaves it, and so does turning it off.
    writeFileSync(paths.codex, "edited on the VM");
    // Put there some other way.
    mkdirSync(join(paths.opencode, ".."), { recursive: true });
    writeFileSync(paths.opencode, "the VM's own");
    apply([], { claude: "claude v2", codex: "codex v2", opencode: "opencode v1" });
    expect(readFileSync(paths.claude, "utf8")).toBe("claude v2");
    expect(readFileSync(paths.codex, "utf8")).toBe("edited on the VM");
    expect(readFileSync(paths.opencode, "utf8")).toBe("the VM's own");

    apply([]);
    expect(existsSync(paths.claude)).toBe(false);
    expect(readFileSync(paths.codex, "utf8")).toBe("edited on the VM");
    expect(readFileSync(paths.opencode, "utf8")).toBe("the VM's own");

    // Once the VM's own file is gone, VM Bridge writes and manages it again.
    rmSync(paths.codex);
    apply([], { codex: "codex v3" });
    expect(readFileSync(paths.codex, "utf8")).toBe("codex v3");
  });
});

test("reads a skill's description in each YAML form", () => {
  expect(skillDescription("---\nname: a\ndescription: Plain words.\n---\n")).toBe("Plain words.");
  expect(skillDescription('---\ndescription: "Quoted: words."\n---\n')).toBe("Quoted: words.");
  expect(skillDescription("---\ndescription: >\n  Folded\n  words.\nname: a\n---\n")).toBe("Folded words.");
  expect(skillDescription("# No front matter")).toBeNull();
});

test("switching sync all says so even when no skill changes, so the dashboard redraws", () => {
  const root = mkdtempSync(join(tmpdir(), "vmbridge-roots-"));
  temps.push(root);
  mkdirSync(join(root, "alpha"));
  writeFileSync(join(root, "alpha", "SKILL.md"), "---\nname: alpha\n---\n");
  const skills = new Skills(openDatabase(":memory:"), testEncryption, () => [root]);
  let changes = 0;
  skills.on("changed", () => changes++);

  skills.setSyncAll(true);
  expect(changes).toBe(1);
  // Off installs and removes nothing, and on again finds alpha already installed.
  for (const sync of [false, true]) {
    changes = 0;
    skills.setSyncAll(sync);
    expect(skills.syncAll).toBe(sync);
    expect(changes).toBe(1);
  }
});

describe("local skill folders", () => {
  /** A temp folder holding a skill root (as in ~/.claude/skills), a skill in it, and a secret file outside it. */
  function machine() {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "vmbridge-local-")));
    temps.push(base);
    const root = join(base, "skills");
    const skill = join(root, "review");
    mkdirSync(join(skill, "docs"), { recursive: true });
    writeFileSync(join(skill, "SKILL.md"), "---\nname: review\ndescription: Reviews code.\n---\n");
    writeFileSync(join(skill, "docs", "guide.md"), "the guide");
    const secrets = join(base, "secrets");
    mkdirSync(secrets);
    writeFileSync(join(secrets, "key"), "SECRET");
    return { base, root, skill, secrets };
  }

  const paths = (files: SkillFile[]) => files.map((entry) => entry.path).sort();
  const texts = (files: SkillFile[]) => files.map((entry) => Buffer.from(entry.data, "base64").toString("utf8"));

  test("links out of the skill are skipped, links inside it are followed", () => {
    const { skill, secrets } = machine();
    symlinkSync(join(secrets, "key"), join(skill, "notes.txt"));
    symlinkSync("../../secrets", join(skill, "outside"));
    symlinkSync("docs/guide.md", join(skill, "guide.md"));
    symlinkSync("docs", join(skill, "more"));
    // A link back up the tree is walked once, not forever.
    symlinkSync("..", join(skill, "docs", "up"));
    Bun.spawnSync(["mkfifo", join(skill, "pipe")]);

    const files = readSkillFolder(skill);
    expect(paths(files)).toEqual(["SKILL.md", "docs/guide.md", "guide.md", "more/guide.md"]);
    expect(texts(files)).not.toContain("SECRET");
  });

  test("a skill folder that is itself a link is read", () => {
    const { base, skill } = machine();
    const link = join(base, "linked");
    symlinkSync(skill, link);
    expect(paths(readSkillFolder(link))).toEqual(["SKILL.md", "docs/guide.md"]);
  });

  test("never reads VM Bridge's data folder", () => {
    const { skill } = machine();
    const data = join(skill, "data");
    mkdirSync(data);
    writeFileSync(join(data, "encryption.key"), "SECRET");
    const files = readSkillFolder(skill, data);
    expect(paths(files)).toEqual(["SKILL.md", "docs/guide.md"]);
    expect(texts(files)).not.toContain("SECRET");
  });

  test("installs only skills found in this machine's skill folders", () => {
    const { base, root, skill } = machine();
    const elsewhere = join(base, "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "SKILL.md"), "---\nname: elsewhere\n---\n");
    // A skill kept in some repository and linked into the skill folder is fine.
    const repo = join(base, "repo", "deploy");
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "SKILL.md"), "---\nname: deploy\n---\n");
    symlinkSync(repo, join(root, "deploy"));
    const skills = new Skills(openDatabase(":memory:"), testEncryption, () => [root]);

    // A folder outside them, and one that does not exist, get the same answer.
    expect(() => skills.installLocal(elsewhere)).toThrow(`${elsewhere} is not a skill in this machine's skill folders.`);
    expect(() => skills.installLocal(join(base, "missing"))).toThrow(`${join(base, "missing")} is not a skill in this machine's skill folders.`);
    expect(skills.list()).toEqual([]);

    skills.installLocal(skill);
    skills.installLocal(join(root, "deploy"));
    expect(skills.list().map((entry) => entry.name)).toEqual(["deploy", "review"]);
  });
});
