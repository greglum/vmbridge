import type { Box } from "../providers/index.ts";
import { check, root } from "./runtime.ts";

/** One file of a skill, relative to its folder. */
export interface SkillFile {
  path: string;
  /** Base64, so scripts and images survive as they are. */
  data: string;
  executable?: boolean;
}

/** The skills every VM should have, by name and content hash. */
export interface SkillsState {
  fingerprint: string;
  skills: { name: string; hash: string }[];
}

/** What the VM last applied, kept in `skills.json` next to the skills VM Bridge put there. */
interface Manifest {
  fingerprint: string;
  skills: Record<string, string>;
}

const sha256 = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex");

export function skillHash(files: SkillFile[]) {
  const sorted = files.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return sha256(JSON.stringify(sorted.map((file) => [file.path, Boolean(file.executable), file.data])));
}

/** Identifies a set of skills, to tell when a VM has an older one. */
export function skillsFingerprint(skills: { name: string; hash: string }[]) {
  return sha256(JSON.stringify(skills.map((skill) => [skill.name, skill.hash]).sort()));
}

/**
 * Runs on the VM with the folder VM Bridge keeps its files in. Applies `skills-incoming.json`: writes each skill
 * that came with files into `skills/<name>` (replacing the old copy whole, so deleted files go too), deletes the
 * skills the last manifest listed that are no longer wanted, and links every wanted skill into the folders Claude
 * Code and Codex read personal skills from. It only ever removes links that point into `skills/`, so skills a user
 * or a repository put on the VM stay, and one already there under the same name wins over VM Bridge's.
 */
export const applyScript = `import { lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const root = process.argv[2];
const store = join(root, "skills");
const manifestPath = join(root, "skills.json");
const incomingPath = join(root, "skills-incoming.json");
const agentDirs = [join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "skills"), join(homedir(), ".agents", "skills")];
const exists = (path) => { try { lstatSync(path); return true; } catch { return false; } };

const incoming = JSON.parse(readFileSync(incomingPath, "utf8"));
const previous = exists(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : { skills: {} };
const wanted = new Set(incoming.skills.map((skill) => skill.name));
mkdirSync(store, { recursive: true });

for (const skill of incoming.skills) {
  if (!skill.files) continue;
  const staging = join(store, "." + skill.name + ".new");
  rmSync(staging, { recursive: true, force: true });
  for (const file of skill.files) {
    const target = resolve(staging, file.path);
    if (!target.startsWith(staging + "/")) throw new Error("Unsafe path in " + skill.name + ": " + file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(file.data, "base64"), { mode: file.executable ? 0o755 : 0o644 });
  }
  rmSync(join(store, skill.name), { recursive: true, force: true });
  renameSync(staging, join(store, skill.name));
}
for (const name of Object.keys(previous.skills)) if (!wanted.has(name)) rmSync(join(store, name), { recursive: true, force: true });

for (const dir of agentDirs) {
  mkdirSync(dir, { recursive: true });
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (!lstatSync(path).isSymbolicLink()) continue;
    const target = resolve(dir, readlinkSync(path));
    if (dirname(target) === store && !wanted.has(basename(target))) rmSync(path);
  }
  for (const name of wanted) if (!exists(join(dir, name))) symlinkSync(join(store, name), join(dir, name));
}

writeFileSync(manifestPath, JSON.stringify({ fingerprint: incoming.fingerprint, skills: Object.fromEntries(incoming.skills.map((skill) => [skill.name, skill.hash])) }));
rmSync(incomingPath);
`;

/**
 * Brings the VM's skills to `state`, sending only skills whose content the VM does not have. Agents see them on
 * their next session, so nothing restarts. Returns whether anything changed on the VM.
 */
export async function syncSkills(box: Box, state: SkillsState, files: (name: string) => SkillFile[]) {
  const manifest = await box.files.read(`${root}/skills.json`).then((text) => JSON.parse(text) as Manifest, () => null);
  if (manifest?.fingerprint === state.fingerprint) return false;
  const skills = state.skills.map((skill) => (manifest?.skills[skill.name] === skill.hash ? skill : { ...skill, files: files(skill.name) }));
  await box.files.write(
    { [`${root}/skills.mjs`]: applyScript, [`${root}/skills-incoming.json`]: JSON.stringify({ fingerprint: state.fingerprint, skills }) },
    { mode: 0o600 },
  );
  await check(box, `. ${root}/env && node ${root}/skills.mjs ${root}`, "Syncing skills");
  return true;
}
