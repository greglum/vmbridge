import { useEffect, useState } from "react";
import { Laptop } from "lucide-react";
import type { CreatedPairing, Overview, PairingLink } from "@vmbridge/contracts";
import { ago, api, useTick } from "./api.ts";
import { Badge, Button, Card, CopyButton, ErrorText, Field, Input, useAction } from "./ui.tsx";

export function Devices({ overview }: { overview: Overview }) {
  const now = useTick(15_000);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<CreatedPairing | null>(null);
  const [links, setLinks] = useState<PairingLink[]>([]);
  const create = useAction();
  const manage = useAction();

  const refresh = () => api<PairingLink[]>("/pairing").then(setLinks);
  useEffect(() => void refresh().catch(() => {}), [overview.clients.length]);

  const pending = links.filter((link) => !link.redeemedAt && link.expiresAt > now);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6">
      <Card title="Pair a device">
        <form
          className="flex flex-col gap-3 sm:flex-row sm:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            void create.run(async () => {
              setCreated(await api<CreatedPairing>("/pairing", { body: { name } }));
              setName("");
              await refresh();
            });
          }}
        >
          <div className="flex-1">
            <Field label="Device name">
              <Input value={name} maxLength={60} onChange={(event) => setName(event.target.value)} placeholder="Work laptop" />
            </Field>
          </div>
          <Button tone="primary" type="submit" disabled={create.busy || !name.trim()}>
            Create link
          </Button>
        </form>
        <ErrorText error={create.error} />
        {created && (
          <div className="mt-4 flex flex-col gap-2 rounded-md border border-accent/40 bg-accent/5 p-3">
            <p className="text-[12px] text-muted">
              Link for <span className="text-fg">{created.link.name}</span>. Works once, for 15 minutes. Use the address the device can reach.
            </p>
            {created.urls.map((url) => (
              <div key={url.url} className="flex flex-col gap-1 rounded-md border border-line bg-panel p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <Badge tone={url.kind.startsWith("tailscale") ? "violet" : "gray"}>{url.label}</Badge>
                  <div className="flex">
                    <CopyButton value={url.url} label="Copy link" />
                    <CopyButton value={url.appLink} label="App link" />
                  </div>
                </div>
                <code className="break-all font-mono text-[11.5px] text-muted">{url.url}</code>
              </div>
            ))}
            <p className="text-[12px] text-faint">In T3 Code, add a remote environment and paste the link.</p>
          </div>
        )}
      </Card>

      <Card title="Paired devices">
        {overview.clients.length === 0 && <p className="text-[13px] text-faint">No devices yet.</p>}
        <ul className="flex flex-col divide-y divide-line">
          {overview.clients.map((client) => (
            <li key={client.id} className="flex items-center gap-3 py-2.5">
              <Laptop size={16} className="text-faint" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px]">{client.name}</div>
                <div className="text-[11px] text-faint">
                  Paired {ago(client.createdAt, now)} · seen {ago(client.lastSeenAt, now)}
                </div>
              </div>
              {client.connected && <Badge tone="green">Connected</Badge>}
              <Button
                tone="danger"
                className="h-7"
                disabled={manage.busy}
                onClick={() => {
                  if (confirm(`Remove ${client.name}? It will need a new link to connect again.`)) {
                    void manage.run(() => api(`/clients/${client.id}`, { method: "DELETE" }));
                  }
                }}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
        <ErrorText error={manage.error} />
      </Card>

      {pending.length > 0 && (
        <Card title="Unused links">
          <ul className="flex flex-col divide-y divide-line">
            {pending.map((link) => (
              <li key={link.id} className="flex items-center gap-3 py-2">
                <span className="flex-1 truncate text-[13px]">{link.name}</span>
                <span className="text-[11px] text-faint">Expires in {Math.max(1, Math.round((link.expiresAt - now) / 60_000))} min</span>
                <Button tone="ghost" className="h-7" onClick={() => void manage.run(() => api(`/pairing/${link.id}`, { method: "DELETE" }).then(refresh))}>
                  Cancel
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
