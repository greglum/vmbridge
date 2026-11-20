import { useEffect, useState, type ReactNode } from "react";
import { Check } from "lucide-react";
import type { AgentCredentials, Overview, ProviderId, ProviderInfo, SelectOption } from "@vmbridge/contracts";
import { api } from "./api.ts";
import { Badge, Button, Card, ErrorText, Field, Input, useAction } from "./ui.tsx";

const sleepModes = { pause: "Pauses: memory and disk kept", stop: "Stops: disk kept", checkpoint: "Checkpoints: disk kept, new sandbox on wake" };

export function Setup({ overview }: { overview: Overview }) {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6">
      <Providers active={overview.provider?.active ? overview.provider.id : null} />
      <GitHub login={overview.github} providerGitHub={Boolean(overview.provider?.features.providerGitHub)} />
      <Agents credentials={overview.agents} providerCredentials={Boolean(overview.provider?.features.providerAgentCredentials)} />
    </div>
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
    <Card title="VM provider">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {list.map((entry) => (
          <button
            key={entry.id}
            onClick={() => setChosen(entry.id)}
            className={`flex flex-col items-start gap-1 rounded-md border px-3 py-2.5 text-left transition-colors ${
              entry.id === chosen ? "border-accent bg-accent/8" : "border-line bg-raised hover:border-line-strong"
            }`}
          >
            <span className="flex w-full items-center justify-between text-[13px] font-medium">
              {entry.label}
              {entry.active && <Check size={14} className="text-ok" />}
            </span>
            <span className="text-[11px] text-faint">{entry.active ? "In use" : entry.configured ? "Ready" : "Not set up"}</span>
          </button>
        ))}
      </div>
      <ErrorText error={load.error} />
      {provider && <ProviderForm key={provider.id} provider={provider} onSaved={replace} />}
    </Card>
  );
}

function ProviderForm({ provider, onSaved }: { provider: ProviderInfo; onSaved: (provider: ProviderInfo) => void }) {
  const [values, setValues] = useState<Record<string, string>>(provider.values);
  const [options, setOptions] = useState<Record<string, SelectOption[]>>({});
  const save = useAction();
  const [saved, setSaved] = useState<string | null>(null);

  const changes = () => {
    const out: Record<string, string> = {};
    for (const field of provider.fields) if (values[field.key] !== undefined) out[field.key] = values[field.key]!;
    return out;
  };

  const loadOptions = (field: string) =>
    save.run(async () => {
      const next = await api<ProviderInfo>(`/providers/${provider.id}`, { method: "PUT", body: { values: changes() } });
      onSaved(next);
      const loaded = await api<SelectOption[]>(`/providers/${provider.id}/options?field=${field}`);
      setOptions((current) => ({ ...current, [field]: loaded }));
    });

  const submit = (activate: boolean) =>
    save.run(async () => {
      setSaved(null);
      let next = await api<ProviderInfo>(`/providers/${provider.id}`, { method: "PUT", body: { values: changes() } });
      if (activate) next = await api<ProviderInfo>(`/providers/${provider.id}/activate`, { body: {} });
      else await api(`/providers/${provider.id}/verify`, { body: {} });
      onSaved(next);
      setValues(next.values);
      setSaved(activate ? `${provider.label} is now in use.` : "Saved and checked.");
    });

  return (
    <form
      className="mt-5 flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit(!provider.active);
      }}
    >
      <div className="flex flex-wrap gap-1.5">
        <Badge tone="violet">{sleepModes[provider.features.sleep]}</Badge>
        {provider.features.providerGitHub && <Badge>GitHub from {provider.label}</Badge>}
        {provider.features.providerAgentCredentials && <Badge>Agent sign-in from {provider.label}</Badge>}
      </div>
      {provider.fields.map((field) => {
        const isSet = provider.secretsSet.includes(field.key);
        if (field.kind === "select") {
          const choices = options[field.key] ?? [];
          const current = values[field.key] ?? "";
          return (
            <Field key={field.key} label={field.label} hint={field.help}>
              <div className="flex gap-2">
                <select
                  value={current}
                  onChange={(event) => setValues({ ...values, [field.key]: event.target.value })}
                  className="h-9 w-full rounded-md border border-line bg-sunken px-2 text-[13px] text-fg outline-none focus:border-accent"
                >
                  <option value="">{field.required ? "Choose one" : "Default"}</option>
                  {current && !choices.some((choice) => choice.value === current) && <option value={current}>{current}</option>}
                  {choices.map((choice) => (
                    <option key={choice.value} value={choice.value}>
                      {choice.detail ? `${choice.label} (${choice.detail})` : choice.label}
                    </option>
                  ))}
                </select>
                <Button type="button" disabled={save.busy} onClick={() => void loadOptions(field.key)}>
                  Load
                </Button>
              </div>
            </Field>
          );
        }
        return (
          <Field key={field.key} label={field.label} hint={field.help}>
            <Input
              type={field.kind === "secret" ? "password" : "text"}
              autoComplete="off"
              placeholder={field.kind === "secret" && isSet ? "Saved. Type to replace it." : field.placeholder}
              value={values[field.key] ?? ""}
              onChange={(event) => setValues({ ...values, [field.key]: event.target.value })}
            />
          </Field>
        );
      })}
      <div className="flex flex-wrap items-center gap-2">
        <Button tone="primary" type="submit" disabled={save.busy}>
          {provider.active ? "Save" : `Use ${provider.label}`}
        </Button>
        {!provider.active && (
          <Button type="button" disabled={save.busy} onClick={() => void submit(false)}>
            Save and check
          </Button>
        )}
        <a href={provider.website} target="_blank" rel="noreferrer" className="ml-auto text-[12px] text-faint hover:text-muted">
          {new URL(provider.website).host}
        </a>
      </div>
      <ErrorText error={save.error} />
      {saved && <p className="text-[12px] text-ok">{saved}</p>}
    </form>
  );
}

function GitHub({ login, providerGitHub }: { login: string | null; providerGitHub: boolean }) {
  const [token, setToken] = useState("");
  const action = useAction();
  return (
    <Card title="GitHub" actions={login ? <Badge tone="green">{login}</Badge> : undefined}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void action.run(() => api("/github", { method: "PUT", body: { token } })).then((ok) => ok && setToken(""));
        }}
      >
        <Field
          label={login ? "Replace token" : "Personal access token"}
          hint={providerGitHub ? "Optional with this provider: it can use its own GitHub connection." : "Needs read and write access to repository contents."}
        >
          <Input type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} placeholder="github_pat_..." />
        </Field>
        <div className="flex gap-2">
          <Button tone="primary" type="submit" disabled={action.busy || !token.trim()}>
            Connect
          </Button>
          {login && (
            <Button tone="danger" type="button" disabled={action.busy} onClick={() => void action.run(() => api("/github", { method: "DELETE" }))}>
              Disconnect
            </Button>
          )}
        </div>
        <ErrorText error={action.error} />
      </form>
    </Card>
  );
}

const agentFields: { key: keyof AgentCredentials; label: string; hint: ReactNode; multiline?: boolean }[] = [
  { key: "claudeOAuthToken", label: "Claude subscription token", hint: <>Run <code className="font-mono">claude setup-token</code> and paste the token.</> },
  { key: "anthropicApiKey", label: "Anthropic API key", hint: "Used by Claude when no subscription token is set." },
  { key: "codexAuthJson", label: "Codex sign-in", hint: <>Paste <code className="font-mono">~/.codex/auth.json</code> after <code className="font-mono">codex login</code>.</>, multiline: true },
  { key: "openaiApiKey", label: "OpenAI API key", hint: "Used by Codex when no sign-in is set." },
];

function Agents({ credentials, providerCredentials }: { credentials: AgentCredentials; providerCredentials: boolean }) {
  const [values, setValues] = useState<Partial<Record<keyof AgentCredentials, string>>>({});
  const action = useAction();
  const filled = Object.values(values).some((value) => value?.trim());
  return (
    <Card title="Agent sign-in">
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void action.run(() => api("/agents", { method: "PUT", body: values })).then((ok) => ok && setValues({}));
        }}
      >
        {providerCredentials && <p className="text-[12px] text-faint">This provider can also supply agent sign-ins from its own account.</p>}
        {agentFields.map((field) => {
          const isSet = credentials[field.key];
          const props = {
            value: values[field.key] ?? "",
            placeholder: isSet ? "Saved. Type to replace it." : undefined,
            onChange: (event: { target: { value: string } }) => setValues({ ...values, [field.key]: event.target.value }),
          };
          return (
            <Field
              key={field.key}
              label={field.label}
              hint={
                <span className="flex items-center justify-between gap-2">
                  {field.hint}
                  {isSet && (
                    <button
                      type="button"
                      className="shrink-0 text-danger hover:underline"
                      onClick={() => void action.run(() => api("/agents", { method: "PUT", body: { [field.key]: null } }))}
                    >
                      Remove
                    </button>
                  )}
                </span>
              }
            >
              {field.multiline ? (
                <textarea
                  {...props}
                  rows={3}
                  spellCheck={false}
                  className="w-full rounded-md border border-line bg-sunken px-3 py-2 font-mono text-[12px] text-fg outline-none placeholder:text-faint focus:border-accent"
                />
              ) : (
                <Input {...props} type="password" autoComplete="off" />
              )}
            </Field>
          );
        })}
        <div>
          <Button tone="primary" type="submit" disabled={action.busy || !filled}>
            Save
          </Button>
        </div>
        <p className="text-[12px] text-faint">VMs pick up changes the next time they start.</p>
        <ErrorText error={action.error} />
      </form>
    </Card>
  );
}
