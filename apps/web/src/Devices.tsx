import { useEffect, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { LaptopIcon, Link01Icon } from "@hugeicons/core-free-icons";
import type { ClientInfo, CreatedPairing, Overview, PairingLink, TrafficEvent } from "@vmbridge/contracts";
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
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item";
import { useAction } from "@/hooks/use-action";
import { failingReason, sinceText } from "@/lib/devices";
import { ago, api, useTick } from "./api.ts";
import { CopyButton } from "./CopyButton.tsx";
import { reconcileCreatedPairing } from "./lib/pairing.ts";
import { Section } from "./Page.tsx";

export function Devices({ overview, traffic }: { overview: Overview; traffic: TrafficEvent[] }) {
  const now = useTick(15_000);
  const [links, setLinks] = useState<PairingLink[]>([]);
  const [created, setCreated] = useState<CreatedPairing | null>(null);
  const refreshSeq = useRef(0);
  const manage = useAction();

  const refresh = () => {
    const seq = ++refreshSeq.current;
    return api<PairingLink[]>("/pairing").then((nextLinks) => {
      if (seq !== refreshSeq.current) return;
      setLinks(nextLinks);
      setCreated((current) => reconcileCreatedPairing(current, nextLinks, Date.now()));
    });
  };
  useEffect(() => void refresh().catch(() => {}), [overview.clients.length]);
  // Re-check active pairing links periodically and when returning to this tab (e.g. cancelled in another tab or failed prior refresh).
  useEffect(() => {
    if (!created) return;
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh().catch(() => {});
    };
    const msUntilExpiry = created.link.expiresAt - Date.now();
    const expiryTimer = setTimeout(() => {
      setCreated((current) => (current?.link.id === created.link.id ? null : current));
    }, Math.max(0, msUntilExpiry));
    const poll = setInterval(() => void refresh().catch(() => {}), 15_000);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(expiryTimer);
      clearInterval(poll);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [created]);

  const pending = links.filter((link) => !link.redeemedAt && link.expiresAt > now);
  const activeCreated = created && created.link.expiresAt > now ? created : null;

  return (
    <>
      <Pair
        created={activeCreated}
        onCreated={(next) => {
          setCreated(next);
          setLinks((current) => [next.link, ...current.filter((item) => item.id !== next.link.id)]);
          void refresh().catch(() => {});
        }}
      />

      <Section title="Paired devices" actions={overview.clients.length > 0 && <Badge variant="secondary">{overview.clients.length}</Badge>}>
        {overview.clients.length === 0 ? (
          <Empty className="border border-dashed">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <HugeiconsIcon icon={LaptopIcon} strokeWidth={1.75} />
              </EmptyMedia>
              <EmptyTitle>No devices yet</EmptyTitle>
              <EmptyDescription>Create a link above and open it in T3 Code.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ItemGroup className="gap-2">
            {overview.clients.map((client) => (
              <Device key={client.id} client={client} failing={failingReason(client.id, traffic, now)} now={now} busy={manage.busy} onRemove={() => void manage.run(() => api(`/clients/${client.id}`, { method: "DELETE" }))} />
            ))}
          </ItemGroup>
        )}
        {manage.error && <FieldError>{manage.error}</FieldError>}
      </Section>

      {pending.length > 0 && (
        <Section title="Unused links">
          <ItemGroup className="gap-2">
            {pending.map((link) => (
              <Item key={link.id} variant="outline" size="sm">
                <ItemMedia variant="icon">
                  <HugeiconsIcon icon={Link01Icon} strokeWidth={1.75} />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{link.name}</ItemTitle>
                  <ItemDescription>Expires in {Math.max(1, Math.round((link.expiresAt - now) / 60_000))} min</ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Button
                    variant="ghost"
                    disabled={manage.busy}
                    onClick={() =>
                      void manage.run(async () => {
                        await api(`/pairing/${link.id}`, { method: "DELETE" });
                        setLinks((current) => current.filter((item) => item.id !== link.id));
                        setCreated((current) => (current?.link.id === link.id ? null : current));
                        void refresh().catch(() => {});
                      })
                    }
                  >
                    Cancel
                  </Button>
                </ItemActions>
              </Item>
            ))}
          </ItemGroup>
        </Section>
      )}
    </>
  );
}

function Pair({ created, onCreated }: { created: CreatedPairing | null; onCreated: (created: CreatedPairing) => void }) {
  const [name, setName] = useState("");
  const create = useAction();
  return (
    <Section title="Pair a device">
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void create.run(async () => {
            const next = await api<CreatedPairing>("/pairing", { body: { name } });
            setName("");
            onCreated(next);
          });
        }}
      >
        <Field data-invalid={Boolean(create.error)}>
          <FieldLabel htmlFor="device-name">Device name</FieldLabel>
          <Input id="device-name" className="h-9" value={name} maxLength={60} onChange={(event) => setName(event.target.value)} placeholder="Work laptop" />
          {create.error && <FieldError>{create.error}</FieldError>}
        </Field>
        <div>
          <Button type="submit" size="lg" className="px-4" disabled={create.busy || !name.trim()}>
            Create link
          </Button>
        </div>
      </form>
      {created && (
        <div className="flex flex-col gap-3">
          <FieldDescription>
            Link for <span className="text-foreground">{created.link.name}</span>. Works once, for 15 minutes. In T3 Code, add a remote environment and paste the link from an address the
            device can reach.
          </FieldDescription>
          <ItemGroup className="gap-2">
            {created.urls.map((url) => (
              <Item key={url.url} variant="outline" size="sm">
                <ItemContent className="min-w-0">
                  <ItemTitle>{url.label}</ItemTitle>
                  <ItemDescription className="truncate font-mono text-xs">
                    {url.url}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <CopyButton value={url.url} label="Copy link" />
                </ItemActions>
              </Item>
            ))}
          </ItemGroup>
        </div>
      )}
    </Section>
  );
}

function Device({ client, failing, now, busy, onRemove }: { client: ClientInfo; failing: string | null; now: number; busy: boolean; onRemove: () => void }) {
  return (
    <Item variant="outline">
      <ItemMedia variant="icon">
        <HugeiconsIcon icon={LaptopIcon} strokeWidth={1.75} />
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle>
          {client.name}
          {client.connected && (
            <Badge variant="secondary" className="gap-1.5">
              <span className="size-1.5 rounded-full bg-success" />
              Connected
            </Badge>
          )}
        </ItemTitle>
        <ItemDescription>
          {client.connected
            ? `Paired ${ago(client.createdAt, now)}`
            : `${client.lastConnectedAt ? `Not connected since ${sinceText(client.lastConnectedAt, now)}` : "Never connected"}, paired ${ago(client.createdAt, now)}`}
        </ItemDescription>
        {failing && <ItemDescription className="text-destructive">Its requests are failing: {failing}</ItemDescription>}
      </ItemContent>
      <ItemActions>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="ghost" className="text-destructive" disabled={busy}>
              Remove
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove {client.name}?</AlertDialogTitle>
              <AlertDialogDescription>It will need a new link to connect again.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={onRemove}>
                Remove
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </ItemActions>
    </Item>
  );
}
