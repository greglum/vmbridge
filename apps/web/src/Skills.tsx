import { useEffect, useState } from "react";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { ComputerIcon, MagicWand01Icon, Search01Icon } from "@hugeicons/core-free-icons";
import type { InstructionFile, LocalSkill, Overview, SkillInfo, SkillSearchResult } from "@vmbridge/contracts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item";
import { Switch } from "@/components/ui/switch";
import { useAction } from "@/hooks/use-action";
import { api } from "./api.ts";
import { Page, Section } from "./Page.tsx";
import { agentNames } from "./Setup.tsx";

const installs = new Intl.NumberFormat(undefined, { notation: "compact" });

export function Skills({ overview }: { overview: Overview }) {
  const [local, setLocal] = useState<LocalSkill[] | null>(null);
  const installed = new Set(overview.skills.map((skill) => skill.name));
  const action = useAction();

  // Again whenever the installed set changes, so each skill shows whether it is installed.
  useEffect(() => void api<LocalSkill[]>("/skills/local").then(setLocal, () => setLocal([])), [overview.skills.length]);

  const install = (name: string, body: Record<string, string>) =>
    void action.run(() => api("/skills", { body })).then((ok) => ok && toast.success(`${name} installed. Every VM gets it.`));

  return (
    <Page title="Skills">
      <Section title="Installed" actions={overview.skills.length > 0 && <Badge variant="secondary">{overview.skills.length}</Badge>}>
        {overview.skills.length === 0 ? (
          <Empty className="border border-dashed">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <HugeiconsIcon icon={MagicWand01Icon} strokeWidth={1.75} />
              </EmptyMedia>
              <EmptyTitle>No skills yet</EmptyTitle>
              <EmptyDescription>Skills you install here go to every VM, for Claude Code and Codex.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ItemGroup className="gap-2">
            {overview.skills.map((skill) => (
              <Installed key={skill.name} skill={skill} />
            ))}
          </ItemGroup>
        )}
      </Section>

      <Search installed={installed} busy={action.busy} onInstall={(result) => install(result.name, { source: "skills.sh", repo: result.source, skill: result.skillId })} />

      <Section title="On this machine">
        {local?.length === 0 && <p className="text-sm text-muted-foreground">No skills in ~/.claude/skills, ~/.agents/skills or ~/.codex/skills.</p>}
        {local && local.length > 0 && (
          <ItemGroup className="gap-2">
            {local.map((skill) => (
              <Item key={skill.path} variant="outline" size="sm">
                <ItemContent className="min-w-0">
                  <ItemTitle>{skill.name}</ItemTitle>
                  <ItemDescription className="truncate font-mono text-xs">{skill.path}</ItemDescription>
                </ItemContent>
                <ItemActions>
                  {skill.installed ? (
                    <Badge variant="secondary">Installed</Badge>
                  ) : (
                    <Button variant="outline" disabled={action.busy} onClick={() => install(skill.name, { source: "local", path: skill.path })}>
                      Install
                    </Button>
                  )}
                </ItemActions>
              </Item>
            ))}
          </ItemGroup>
        )}
      </Section>
      {action.error && <FieldError>{action.error}</FieldError>}
      <Instructions overview={overview} />
    </Page>
  );
}

function Instructions({ overview }: { overview: Overview }) {
  const action = useAction();
  const pending = overview.vms.filter((vm) => vm.skillsPending).length;
  const state = overview.instructions.some((file) => file.sync) && (
    <Badge variant="secondary">{pending ? `${pending} VM${pending === 1 ? "" : "s"} pending` : "On every VM"}</Badge>
  );
  const toggle = (file: InstructionFile, sync: boolean) => void action.run(() => api(`/instructions/${file.agent}`, { method: "PUT", body: { sync } }));
  return (
    <Section title="Instructions" actions={state}>
      {overview.instructions.length === 0 ? (
        <p className="text-sm text-muted-foreground">No CLAUDE.md or AGENTS.md in ~/.claude, ~/.codex or ~/.config/opencode.</p>
      ) : (
        <ItemGroup className="gap-2">
          {overview.instructions.map((file) => (
            <Item key={file.agent} variant="outline" size="sm">
              <ItemContent className="min-w-0">
                <ItemTitle>
                  <label htmlFor={`instructions-${file.agent}`}>{agentNames[file.agent]}</label>
                </ItemTitle>
                <ItemDescription className="truncate font-mono text-xs">{file.path}</ItemDescription>
              </ItemContent>
              <ItemActions>
                <Switch id={`instructions-${file.agent}`} checked={file.sync} disabled={action.busy} onCheckedChange={(sync) => toggle(file, sync)} />
              </ItemActions>
            </Item>
          ))}
        </ItemGroup>
      )}
      {action.error && <FieldError>{action.error}</FieldError>}
    </Section>
  );
}

function Installed({ skill }: { skill: SkillInfo }) {
  const action = useAction();
  const update = () =>
    void action.run(async () => {
      const { changed } = await api<{ changed: boolean }>(`/skills/${encodeURIComponent(skill.name)}/update`, { body: {} });
      toast.success(changed ? `${skill.name} updated.` : `${skill.name} is up to date.`);
    });
  return (
    <Item variant="outline">
      {/* Full width on phones, so the actions wrap below instead of squeezing the name. */}
      <ItemContent className="min-w-0 basis-full sm:basis-0">
        <ItemTitle>
          {skill.name}
          <Badge variant="secondary" className="gap-1.5">
            {skill.source === "local" && <HugeiconsIcon icon={ComputerIcon} className="size-3" strokeWidth={2} />}
            {skill.source === "local" ? "This machine" : "skills.sh"}
          </Badge>
        </ItemTitle>
        {skill.description && <ItemDescription className="line-clamp-2">{skill.description}</ItemDescription>}
        <ItemDescription className="truncate font-mono text-xs">{skill.ref}</ItemDescription>
        {action.error && <FieldError>{action.error}</FieldError>}
      </ItemContent>
      <ItemActions className="max-sm:-ml-2.5">
        {skill.source === "skills.sh" && (
          <Button variant="ghost" disabled={action.busy} onClick={update}>
            Update
          </Button>
        )}
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="ghost" className="text-destructive" disabled={action.busy}>
              Remove
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove {skill.name}?</AlertDialogTitle>
              <AlertDialogDescription>It comes off every VM. Skills put on a VM some other way stay.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={() => void action.run(() => api(`/skills/${encodeURIComponent(skill.name)}`, { method: "DELETE" }))}>
                Remove
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </ItemActions>
    </Item>
  );
}

function Search({ installed, busy, onInstall }: { installed: Set<string>; busy: boolean; onInstall: (result: SkillSearchResult) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SkillSearchResult[] | null>(null);
  const search = useAction();
  return (
    <Section title="skills.sh">
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void search.run(async () => setResults(await api<SkillSearchResult[]>(`/skills/search?${new URLSearchParams({ q: query })}`)));
        }}
      >
        <Input className="h-9" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search skills" aria-label="Search skills.sh" />
        <Button type="submit" variant="outline" size="lg" className="px-3" disabled={search.busy || !query.trim()}>
          <HugeiconsIcon icon={Search01Icon} strokeWidth={2} />
          Search
        </Button>
      </form>
      {search.error && <FieldError>{search.error}</FieldError>}
      {results?.length === 0 && <p className="text-sm text-muted-foreground">Nothing found.</p>}
      {results && results.length > 0 && (
        <ItemGroup className="gap-2">
          {results.map((result) => (
            <Item key={`${result.source}/${result.skillId}`} variant="outline" size="sm">
              <ItemContent className="min-w-0">
                <ItemTitle>{result.name}</ItemTitle>
                <ItemDescription className="truncate">
                  {result.source}, {installs.format(result.installs)} installs
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                {installed.has(result.skillId) ? (
                  <Badge variant="secondary">Installed</Badge>
                ) : (
                  <Button variant="outline" disabled={busy} onClick={() => onInstall(result)}>
                    Install
                  </Button>
                )}
              </ItemActions>
            </Item>
          ))}
        </ItemGroup>
      )}
    </Section>
  );
}
