import { useEffect, useState } from "react";
import { vmSizes, type BridgeSettings, type NetworkInfo, type Overview, type VmSize } from "@vmbridge/contracts";
import { api } from "./api.ts";
import { Badge, Button, Card, CopyButton, ErrorText, Field, Input, useAction } from "./ui.tsx";

export function Settings({ overview, onLoggedOut }: { overview: Overview; onLoggedOut: () => void }) {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6">
      <VmSettings overview={overview} />
      <Network />
      <DashboardKey onLoggedOut={onLoggedOut} />
    </div>
  );
}

function VmSettings({ overview }: { overview: Overview }) {
  const [form, setForm] = useState<BridgeSettings>(overview.settings);
  const action = useAction();
  const [saved, setSaved] = useState(false);
  const sizes = overview.provider?.sizes;
  return (
    <Card title="VMs">
      <form
        className="grid gap-4 sm:grid-cols-3"
        onSubmit={(event) => {
          event.preventDefault();
          setSaved(false);
          void action.run(() => api("/settings", { method: "PUT", body: form })).then(setSaved);
        }}
      >
        <Field label="Size for new VMs">
          <select
            value={form.vmSize}
            onChange={(event) => setForm({ ...form, vmSize: event.target.value as VmSize })}
            className="h-9 rounded-md border border-line bg-sunken px-2 text-[13px] text-fg outline-none focus:border-accent"
          >
            {vmSizes.map((size) => (
              <option key={size} value={size}>
                {sizes ? `${size}: ${sizes[size]}` : size}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Sleep after idle (minutes)">
          <Input type="number" min={1} max={240} value={form.idleMinutes} onChange={(event) => setForm({ ...form, idleMinutes: Number(event.target.value) })} />
        </Field>
        <Field label="T3 version">
          <Input value={form.t3Version ?? ""} placeholder="Latest" onChange={(event) => setForm({ ...form, t3Version: event.target.value || null })} />
        </Field>
        <div className="flex items-center gap-3 sm:col-span-3">
          <Button tone="primary" type="submit" disabled={action.busy}>
            Save
          </Button>
          {saved && <span className="text-[12px] text-ok">Saved.</span>}
          <ErrorText error={action.error} />
        </div>
      </form>
    </Card>
  );
}

function Network() {
  const [network, setNetwork] = useState<NetworkInfo | null>(null);
  const action = useAction();
  useEffect(() => void action.run(async () => setNetwork(await api<NetworkInfo>("/network"))), []);
  const tailscale = network?.tailscale;
  return (
    <Card
      title="Addresses"
      actions={
        tailscale?.running && (
          <Button
            className="h-7"
            disabled={action.busy}
            onClick={() => void action.run(async () => setNetwork(await api<NetworkInfo>("/network/https", { body: { enabled: !tailscale.httpsUrl } })))}
          >
            {tailscale.httpsUrl ? "Turn off Tailscale HTTPS" : "Turn on Tailscale HTTPS"}
          </Button>
        )
      }
    >
      <ul className="flex flex-col divide-y divide-line">
        {network?.addresses.map((address) => (
          <li key={address.url} className="flex items-center gap-3 py-2">
            <Badge tone={address.kind.startsWith("tailscale") ? "violet" : "gray"}>{address.label}</Badge>
            <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted">{address.url}</code>
            <CopyButton value={address.url} />
          </li>
        ))}
      </ul>
      {network && !tailscale?.installed && <p className="mt-2 text-[12px] text-faint">Install Tailscale to reach VM Bridge from your other devices.</p>}
      {tailscale?.installed && !tailscale.running && <p className="mt-2 text-[12px] text-faint">Tailscale is installed but not connected.</p>}
      <ErrorText error={action.error} />
    </Card>
  );
}

function DashboardKey({ onLoggedOut }: { onLoggedOut: () => void }) {
  const [key, setKey] = useState("");
  const action = useAction();
  return (
    <Card
      title="Dashboard key"
      actions={
        <Button tone="ghost" className="h-7" onClick={() => void api("/logout", { body: {} }).finally(onLoggedOut)}>
          Log out
        </Button>
      }
    >
      <form
        className="flex flex-col gap-3 sm:flex-row sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          void action.run(() => api("/key", { body: { key } })).then((ok) => ok && onLoggedOut());
        }}
      >
        <div className="flex-1">
          <Field label="New key" hint="Changing it logs out every browser.">
            <Input type="password" autoComplete="new-password" minLength={8} value={key} onChange={(event) => setKey(event.target.value)} />
          </Field>
        </div>
        <Button type="submit" disabled={action.busy || key.length < 8}>
          Change key
        </Button>
      </form>
      <ErrorText error={action.error} />
    </Card>
  );
}
