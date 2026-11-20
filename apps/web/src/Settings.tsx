import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ComputerIcon, GlobalIcon, Key01Icon } from "@hugeicons/core-free-icons";
import { vmSizes, type BridgeSettings, type NetworkInfo, type Overview, type VmSize } from "@vmbridge/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useAction } from "@/hooks/use-action";
import { api } from "./api.ts";
import { CopyButton } from "./CopyButton.tsx";
import { Page, Section, type Tab } from "./Page.tsx";

type SettingsTab = "vms" | "addresses" | "key";

const tabs: Tab<SettingsTab>[] = [
  { id: "vms", label: "VMs", icon: ComputerIcon },
  { id: "addresses", label: "Addresses", icon: GlobalIcon },
  { id: "key", label: "Dashboard key", icon: Key01Icon },
];

export function Settings({ overview, onLoggedOut }: { overview: Overview; onLoggedOut: () => void }) {
  const [tab, setTab] = useState<SettingsTab>("vms");
  return (
    <Page title="Settings" tabs={tabs} tab={tab} onTab={setTab}>
      {tab === "vms" && <VmSettings overview={overview} />}
      {tab === "addresses" && <Addresses />}
      {tab === "key" && <DashboardKey onLoggedOut={onLoggedOut} />}
    </Page>
  );
}

function VmSettings({ overview }: { overview: Overview }) {
  const [form, setForm] = useState<BridgeSettings>(overview.settings);
  const action = useAction();
  const sizes = overview.provider?.sizes;
  return (
    <Section title="VMs">
      <form
        className="flex flex-col gap-6"
        onSubmit={(event) => {
          event.preventDefault();
          void action.run(() => api("/settings", { method: "PUT", body: form })).then((ok) => ok && toast.success("Settings saved."));
        }}
      >
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="vm-size">Size for new VMs</FieldLabel>
            <Select value={form.vmSize} onValueChange={(value) => setForm({ ...form, vmSize: value as VmSize })}>
              <SelectTrigger id="vm-size" className="h-9 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {vmSizes.map((size) => (
                  <SelectItem key={size} value={size}>
                    <span className="capitalize">{size}</span>
                    {sizes && <span className="text-muted-foreground">{sizes[size]}</span>}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="idle-minutes">Sleep after idle (minutes)</FieldLabel>
            <Input
              id="idle-minutes"
              className="h-9"
              type="number"
              min={1}
              max={240}
              value={form.idleMinutes}
              onChange={(event) => setForm({ ...form, idleMinutes: Number(event.target.value) })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="t3-version">T3 version</FieldLabel>
            <Input id="t3-version" className="h-9" value={form.t3Version ?? ""} placeholder="Latest" onChange={(event) => setForm({ ...form, t3Version: event.target.value || null })} />
            <FieldDescription>New VMs install this version.</FieldDescription>
          </Field>
        </FieldGroup>
        {action.error && <FieldError>{action.error}</FieldError>}
        <div>
          <Button type="submit" size="lg" className="px-4" disabled={action.busy}>
            Save
          </Button>
        </div>
      </form>
    </Section>
  );
}

function Addresses() {
  const [network, setNetwork] = useState<NetworkInfo | null>(null);
  const action = useAction();
  useEffect(() => void action.run(async () => setNetwork(await api<NetworkInfo>("/network"))), []);
  const tailscale = network?.tailscale;
  return (
    <>
      <Section title="Addresses">
        <ItemGroup className="gap-2">
          {network?.addresses.map((address) => (
            <Item key={address.url} variant="outline" size="sm">
              <ItemContent className="min-w-0">
                <ItemTitle>{address.label}</ItemTitle>
                <ItemDescription className="truncate font-mono text-xs">{address.url}</ItemDescription>
              </ItemContent>
              <ItemActions>
                <CopyButton value={address.url} />
              </ItemActions>
            </Item>
          ))}
        </ItemGroup>
      </Section>
      {network && (
        <Section title="Tailscale" actions={<Badge variant="secondary">{tailscale?.running ? "Connected" : tailscale?.installed ? "Not connected" : "Not installed"}</Badge>}>
          {tailscale?.running ? (
            <Item variant="outline">
              <ItemContent>
                <ItemTitle>
                  <label htmlFor="tailscale-https">HTTPS address</label>
                </ItemTitle>
                <ItemDescription>{tailscale.httpsUrl ?? "Serve VM Bridge over HTTPS on your tailnet."}</ItemDescription>
              </ItemContent>
              <ItemActions>
                <Switch
                  id="tailscale-https"
                  checked={Boolean(tailscale.httpsUrl)}
                  disabled={action.busy}
                  onCheckedChange={(enabled) => void action.run(async () => setNetwork(await api<NetworkInfo>("/network/https", { body: { enabled } })))}
                />
              </ItemActions>
            </Item>
          ) : (
            <FieldDescription>
              {tailscale?.installed ? "Tailscale is installed but not connected." : "Install Tailscale to reach VM Bridge from your other devices."}
            </FieldDescription>
          )}
        </Section>
      )}
      {action.error && <FieldError>{action.error}</FieldError>}
    </>
  );
}

function DashboardKey({ onLoggedOut }: { onLoggedOut: () => void }) {
  const [key, setKey] = useState("");
  const action = useAction();
  return (
    <Section title="Dashboard key">
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void action.run(() => api("/key", { body: { key } })).then((ok) => ok && onLoggedOut());
        }}
      >
        <Field data-invalid={Boolean(action.error)}>
          <FieldLabel htmlFor="new-key">New key</FieldLabel>
          <Input id="new-key" className="h-9" type="password" autoComplete="new-password" minLength={8} value={key} onChange={(event) => setKey(event.target.value)} />
          <FieldDescription>At least 8 characters. Changing it logs out every browser.</FieldDescription>
          {action.error && <FieldError>{action.error}</FieldError>}
        </Field>
        <div className="flex gap-2">
          <Button type="submit" size="lg" className="px-4" disabled={action.busy || key.length < 8}>
            Change key
          </Button>
          <Button type="button" variant="outline" size="lg" className="px-4" onClick={() => void api("/logout", { body: {} }).finally(onLoggedOut)}>
            Log out
          </Button>
        </div>
      </form>
    </Section>
  );
}
