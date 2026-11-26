import type { Box } from "../providers/index.ts";
import type { ProjectRow } from "../store.ts";
import type { Backend } from "./backend.ts";
import { checkoutRoot, quote } from "./runtime.ts";

const repoName = (url: string) =>
  new URL(url).pathname.split("/").filter(Boolean).pop()?.replace(/\.git$/, "") || "repository";

/** Clones a project's repository into the VM's workspace if not already checked out there, returning the path. */
export async function cloneProject(box: Box, project: Pick<ProjectRow, "url" | "branch">): Promise<string> {
  const path = `${checkoutRoot}/${repoName(project.url)}`;
  const branch = project.branch ? `--branch ${quote(project.branch)} ` : "";
  const result = await box.run(
    `set -eu
. /workspace/.vmbridge/env
if [ -d ${quote(`${path}/.git`)} ]; then
  [ "$(git -C ${quote(path)} remote get-url origin)" = ${quote(project.url)} ] || { echo "${path} holds another repository" >&2; exit 3; }
else
  rm -rf ${quote(`${path}.cloning`)}
  GIT_TERMINAL_PROMPT=0 git clone ${branch}-- ${quote(project.url)} ${quote(`${path}.cloning`)}
  mv ${quote(`${path}.cloning`)} ${quote(path)}
fi`,
    { timeoutMs: 10 * 60_000 },
  );
  if (!result.ok) {
    const output = result.stderr.slice(-400);
    if (/not found|could not read|authentication|403|404/i.test(output)) {
      throw new Error("The VM could not read this repository. Check GitHub access in the VM Bridge dashboard.");
    }
    throw new Error(`Cloning failed: ${output}`);
  }
  return path;
}

/** Registers a cloned project with the VM's T3 server if T3 does not already know it. */
export async function registerProject(backend: Backend, project: Pick<ProjectRow, "id" | "title">, checkoutPath: string) {
  const { projects } = await backend.json<{ projects: { id: string; workspaceRoot: string }[] }>("/api/projects");
  if (projects.some((p) => p.id === project.id)) return;
  const response = await backend.http("/api/projects/mutate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "project.create",
      commandId: crypto.randomUUID(),
      projectId: project.id,
      title: project.title,
      workspaceRoot: checkoutPath,
    }),
  });
  if (!response.ok) throw new Error(`T3 refused to register the project (${response.status}).`);
}
