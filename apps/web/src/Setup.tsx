import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { GithubIcon, LinkSquare02Icon, Plug01Icon, Robot01Icon } from "@hugeicons/core-free-icons";
import type { AgentCredentials, Overview, ProviderId, ProviderInfo, SelectOption } from "@vmbridge/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldTitle } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useAction } from "@/hooks/use-action";
import { api } from "./api.ts";
import { ProviderLogo } from "./brand.tsx";
import { Page, Section, type Tab } from "./Page.tsx";

type SetupTab = "provider" | "github" | "agents";

const sleepModes = { pause: "Pauses: memory and disk kept", stop: "Stops: disk kept", checkpoint: "Checkpoints: disk kept, new sandbox on wake" };

/** Where, in each provider's own dashboard, its account sign-ins are set up. */
const accountHints: Partial<Record<ProviderId, { agents: string; github?: string }>> = {
  boat: {
    agents: "Turn on agent sign-ins in the Boat environment you chose under Provider.",
    github: "Turn on GitHub in the Boat environment you chose under Provider.",
  },
  boxd: {
    agents: "Connect Claude Code and Codex under Integrations in boxd.",
    github: "Connect Git under Integrations in boxd.",
  },
  instabox: {
    agents: "Sign-ins saved in your Instabox Vault reach every new machine.",
  },
};

export function Setup({ overview }: { overview: Overview }) {
  const [tab, setTab] = useState<SetupTab>(overview.setup.provider ? "agents" : "provider");
  const provider = overview.provider?.active ? overview.provider : null;
  const tabs: Tab<SetupTab>[] = [
    { id: "provider", label: "Provider", icon: Plug01Icon, attention: !overview.setup.provider },
    { id: "github", label: "GitHub", icon: GithubIcon, attention: !overview.setup.github },
    { id: "agents", label: "Agent sign-in", icon: Robot01Icon, attention: !overview.setup.agents },
  ];
  return (
    <Page title="Setup" tabs={tabs} tab={tab} onTab={setTab}>
      {tab === "provider" && <Providers active={provider?.id ?? null} />}
      {tab === "github" && <GitHub login={overview.github} provider={provider?.features.providerGitHub ? provider : null} />}
      {tab === "agents" && <Agents credentials={overview.agents} provider={provider?.features.providerAgentCredentials ? provider : null} />}
    </Page>
  );
}

function Providers({ active }: { active: ProviderId | null }) {
  const [list, setList] = useState<ProviderInfo[]>([]);
  const [chosen, setChosen] = useState<ProviderId | null>(active);
  const load = useAction();
  useEffect(() => {
    void load.run(async () => {
      const providers = await api<ProviderInfo[]>("/providers");
      setList(providers);
      setChosen((current) => current ?? providers.find((provider) => provider.active)?.id ?? providers[0]?.id ?? null);
    });
  }, [active]);
  const provider = list.find((entry) => entry.id === chosen);
  const replace = (next: ProviderInfo) => setList((current) => current.map((entry) => (entry.id === next.id ? next : { ...entry, active: next.active ? false : entry.active })));

  return (
    <>
      <Section title="Provider">
        <RadioGroup value={chosen ?? ""} onValueChange={(value) => setChosen(value as ProviderId)} className="grid gap-2 sm:grid-cols-2">
          {list.map((entry) => (
            <FieldLabel key={entry.id} htmlFor={`provider-${entry.id}`}>
              <Field orientation="horizontal" className="items-center">
                <ProviderLogo id={entry.id} className="size-9 rounded-lg" />
                <FieldContent>
                  <FieldTitle>{entry.label}</FieldTitle>
                  <FieldDescription>{entry.active ? "In use" : entry.configured ? "Ready" : "Not set up"}</FieldDescription>
                </FieldContent>
                <RadioGroupItem value={entry.id} id={`provider-${entry.id}`} />
              </Field>
            </FieldLabel>
          ))}
        </RadioGroup>
        {load.error && <FieldError>{load.error}</FieldError>}
      </Section>
      {provider && <ProviderForm key={provider.id} provider={provider} onSaved={replace} />}
    </>
  );
}

const defaultOption = "__default";

function ProviderForm({ provider, onSaved }: { provider: ProviderInfo; onSaved: (provider: ProviderInfo) => void }) {
  const [values, setValues] = useState<Record<string, string>>(provider.values);
  const [options, setOptions] = useState<Record<string, SelectOption[]>>({});
  const save = useAction();

  const changes = () => Object.fromEntries(provider.fields.flatMap((field) => (values[field.key] === undefined ? [] : [[field.key, values[field.key]!]])));

  const loadOptions = (field: string) =>
    save.run(async () => {
      onSaved(await api<ProviderInfo>(`/providers/${provider.id}`, { method: "PUT", body: { values: changes() } }));
      const loaded = await api<SelectOption[]>(`/providers/${provider.id}/options?field=${field}`);
      setOptions((current) => ({ ...current, [field]: loaded }));
    });

  const submit = (activate: boolean) =>
    save.run(async () => {
      let next = await api<ProviderInfo>(`/providers/${provider.id}`, { method: "PUT", body: { values: changes() } });
      if (activate) next = await api<ProviderInfo>(`/providers/${provider.id}/activate`, { body: {} });
      else await api(`/providers/${provider.id}/verify`, { body: {} });
      onSaved(next);
      setValues(next.values);
      toast.success(activate ? `${provider.label} is now in use.` : `${provider.label} settings saved and checked.`);
    });

  return (
    <Section title={`${provider.label} settings`}>
      <form
        className="flex flex-col gap-6"
        onSubmit={(event) => {
          event.preventDefault();
          void submit(!provider.active);
        }}
      >
        <div className="flex flex-wrap gap-1.5">
          <Badge variant="secondary">{sleepModes[provider.features.sleep]}</Badge>
          {provider.features.providerAgentCredentials && <Badge variant="secondary">Agent sign-in from {provider.label}</Badge>}
          {provider.features.providerGitHub && <Badge variant="secondary">GitHub from {provider.label}</Badge>}
        </div>
        <FieldGroup>
          {provider.fields.map((field) => {
            const id = `field-${provider.id}-${field.key}`;
            if (field.kind === "select") {
              const choices = options[field.key] ?? [];
              const current = values[field.key] || defaultOption;
              return (
                <Field key={field.key}>
                  <FieldLabel htmlFor={id}>{field.label}</FieldLabel>
                  <ButtonGroup className="w-full">
                    <Select value={current} onValueChange={(value) => setValues({ ...values, [field.key]: value === defaultOption ? "" : value })}>
                      <SelectTrigger id={id} className="h-9 flex-1">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={defaultOption}>{field.required ? "Choose one" : "Default"}</SelectItem>
                        {current !== defaultOption && !choices.some((choice) => choice.value === current) && <SelectItem value={current}>{current}</SelectItem>}
                        {choices.map((choice) => (
                          <SelectItem key={choice.value} value={choice.value}>
                            {choice.label}
                            {choice.detail && <span className="text-muted-foreground">({choice.detail})</span>}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button type="button" variant="outline" size="lg" className="h-9" disabled={save.busy} onClick={() => void loadOptions(field.key)}>
                      Load
                    </Button>
                  </ButtonGroup>
                  {field.help && <FieldDescription>{field.help}</FieldDescription>}
                </Field>
              );
            }
            const isSet = provider.secretsSet.includes(field.key);
            return (
              <Field key={field.key}>
                <FieldLabel htmlFor={id}>{field.label}</FieldLabel>
                <Input
                  id={id}
                  className="h-9"
                  type={field.kind === "secret" ? "password" : "text"}
                  autoComplete="off"
                  placeholder={field.kind === "secret" && isSet ? "Saved. Type to replace it." : field.placeholder}
                  value={values[field.key] ?? ""}
                  onChange={(event) => setValues({ ...values, [field.key]: event.target.value })}
                />
                {field.help && <FieldDescription>{field.help}</FieldDescription>}
              </Field>
            );
          })}
        </FieldGroup>
        {save.error && <FieldError>{save.error}</FieldError>}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" size="lg" className="h-9 px-4" disabled={save.busy}>
            {provider.active ? "Save" : `Use ${provider.label}`}
          </Button>
          {!provider.active && (
            <Button type="button" variant="outline" size="lg" className="h-9 px-4" disabled={save.busy} onClick={() => void submit(false)}>
              Save and check
            </Button>
          )}
          <Button asChild variant="link" className="ml-auto text-muted-foreground">
            <a href={provider.website} target="_blank" rel="noreferrer">
              {new URL(provider.website).host}
            </a>
          </Button>
        </div>
      </form>
    </Section>
  );
}

/** Points to the provider's own dashboard, for sign-ins it manages itself. */
function FromProvider({ provider, title, hint }: { provider: ProviderInfo; title: string; hint?: string }) {
  return (
    <Item variant="outline">
      <ItemMedia>
        <ProviderLogo id={provider.id} className="size-9 rounded-lg" />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{title}</ItemTitle>
        {hint && <ItemDescription>{hint}</ItemDescription>}
      </ItemContent>
      <ItemActions>
        <Button asChild variant="outline" size="lg" className="h-9">
          <a href={provider.dashboardUrl} target="_blank" rel="noreferrer">
            Open {provider.label}
            <HugeiconsIcon icon={LinkSquare02Icon} data-icon="inline-end" strokeWidth={1.75} />
          </a>
        </Button>
      </ItemActions>
    </Item>
  );
}

function GitHub({ login, provider }: { login: string | null; provider: ProviderInfo | null }) {
  const [token, setToken] = useState("");
  const action = useAction();
  const disconnect = (
    <Button variant="destructive" size="lg" className="h-9" disabled={action.busy} onClick={() => void action.run(() => api("/github", { method: "DELETE" }))}>
      Disconnect
    </Button>
  );
  return (
    <Section title="GitHub" actions={login ? <Badge variant="secondary">Connected as {login}</Badge> : undefined}>
      {provider && <FromProvider provider={provider} title={`GitHub comes from your ${provider.label} account`} hint={accountHints[provider.id]?.github} />}
      {provider && login && (
        <Item variant="muted">
          <ItemContent>
            <ItemTitle>A token is also saved in VM Bridge</ItemTitle>
            <ItemDescription>VM Bridge uses it to list branches. VMs use your {provider.label} connection.</ItemDescription>
          </ItemContent>
          <ItemActions>{disconnect}</ItemActions>
        </Item>
      )}
      {!provider && (
        <form
          className="flex flex-col gap-6"
          onSubmit={(event) => {
            event.preventDefault();
            void action.run(() => api("/github", { method: "PUT", body: { token } })).then((ok) => {
              if (!ok) return;
              setToken("");
              toast.success("GitHub connected.");
            });
          }}
        >
          <Field data-invalid={Boolean(action.error)}>
            <FieldLabel htmlFor="github-token">{login ? "Replace token" : "Personal access token"}</FieldLabel>
            <Input id="github-token" className="h-9" type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} placeholder="github_pat_..." />
            <FieldDescription>Needs read and write access to repository contents.</FieldDescription>
            {action.error && <FieldError>{action.error}</FieldError>}
          </Field>
          <div className="flex gap-2">
            <Button type="submit" size="lg" className="h-9 px-4" disabled={action.busy || !token.trim()}>
              Connect
            </Button>
            {login && disconnect}
          </div>
        </form>
      )}
    </Section>
  );
}

const agentFields: { key: keyof AgentCredentials; label: string; hint: ReactNode; multiline?: boolean }[] = [
  {
    key: "claudeOAuthToken",
    label: "Claude subscription token",
    hint: (
      <>
        Run <code>claude setup-token</code> and paste the token.
      </>
    ),
  },
  { key: "anthropicApiKey", label: "Anthropic API key", hint: "Used by Claude when no subscription token is set." },
  {
    key: "codexAuthJson",
    label: "Codex sign-in",
    hint: (
      <>
        Paste <code>~/.codex/auth.json</code> after <code>codex login</code>.
      </>
    ),
    multiline: true,
  },
  { key: "openaiApiKey", label: "OpenAI API key", hint: "Used by Codex when no sign-in is set." },
];

function Agents({ credentials, provider }: { credentials: AgentCredentials; provider: ProviderInfo | null }) {
  const [values, setValues] = useState<Partial<Record<keyof AgentCredentials, string>>>({});
  const action = useAction();
  const filled = Object.values(values).some((value) => value?.trim());
  const saved = agentFields.filter((field) => credentials[field.key]);
  const remove = (key: keyof AgentCredentials) => void action.run(() => api("/agents", { method: "PUT", body: { [key]: null } }));

  if (provider) {
    return (
      <Section title="Agent sign-in">
        <FromProvider provider={provider} title={`Agent sign-in comes from your ${provider.label} account`} hint={accountHints[provider.id]?.agents} />
        {saved.length > 0 && (
          <Item variant="muted">
            <ItemContent>
              <ItemTitle>Also saved in VM Bridge</ItemTitle>
              <ItemDescription>{saved.map((field) => field.label).join(", ")}. VMs get these as well. Remove them to use only {provider.label}.</ItemDescription>
            </ItemContent>
            <ItemActions>
              <Button
                variant="destructive"
                size="lg"
                className="h-9"
                disabled={action.busy}
                onClick={() => void action.run(() => api("/agents", { method: "PUT", body: Object.fromEntries(saved.map((field) => [field.key, null])) }))}
              >
                Remove
              </Button>
            </ItemActions>
          </Item>
        )}
        {action.error && <FieldError>{action.error}</FieldError>}
      </Section>
    );
  }

  return (
    <Section title="Agent sign-in">
      <form
        className="flex flex-col gap-6"
        onSubmit={(event) => {
          event.preventDefault();
          void action.run(() => api("/agents", { method: "PUT", body: values })).then((ok) => {
            if (!ok) return;
            setValues({});
            toast.success("Saved. VMs pick up changes the next time they start.");
          });
        }}
      >
        <FieldGroup>
          {agentFields.map((field) => {
            const isSet = credentials[field.key];
            const id = `agent-${field.key}`;
            const props = {
              id,
              value: values[field.key] ?? "",
              placeholder: isSet ? "Saved. Type to replace it." : undefined,
              onChange: (event: { target: { value: string } }) => setValues({ ...values, [field.key]: event.target.value }),
            };
            return (
              <Field key={field.key}>
                <div className="flex items-center justify-between gap-2">
                  <FieldLabel htmlFor={id}>{field.label}</FieldLabel>
                  {isSet && (
                    <Button type="button" variant="ghost" size="xs" className="text-destructive" onClick={() => remove(field.key)}>
                      Remove
                    </Button>
                  )}
                </div>
                {field.multiline ? <Textarea {...props} rows={3} spellCheck={false} className="font-mono text-xs" /> : <Input {...props} className="h-9" type="password" autoComplete="off" />}
                <FieldDescription className="[&_code]:font-mono [&_code]:text-foreground">{field.hint}</FieldDescription>
              </Field>
            );
          })}
        </FieldGroup>
        {action.error && <FieldError>{action.error}</FieldError>}
        <div>
          <Button type="submit" size="lg" className="h-9 px-4" disabled={action.busy || !filled}>
            Save
          </Button>
        </div>
      </form>
    </Section>
  );
}
