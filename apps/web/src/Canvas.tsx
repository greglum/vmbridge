import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  getBezierPath,
  Handle,
  Panel,
  Position,
  ReactFlow,
  useReactFlow,
  useViewportStore,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon, Cancel01Icon, CenterFocusIcon, Delete02Icon, Folder01Icon, LaptopIcon, Message01Icon, Moon02Icon, PowerIcon, ZoomInIcon, ZoomOutIcon } from "@hugeicons/core-free-icons";
import type { ClientInfo, Overview, ProjectInfo, TrafficEvent, VmInfo, VmState } from "@vmbridge/contracts";
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
import { ButtonGroup } from "@/components/ui/button-group";
import { Item, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAction } from "@/hooks/use-action";
import { cn } from "@/lib/utils";
import { ago, api, useTick } from "./api.ts";
import { Logo, ProviderLogo } from "./brand.tsx";

/** A connection animates while it carried a request this recently. */
const flowWindowMs = 8_000;

export const vmStates: Record<VmState, { label: string; dot: string; text: string }> = {
  provisioning: { label: "Creating", dot: "bg-primary", text: "text-primary" },
  starting: { label: "Starting", dot: "bg-primary", text: "text-primary" },
  ready: { label: "Online", dot: "bg-success", text: "text-success" },
  busy: { label: "Working", dot: "bg-warning", text: "text-warning" },
  sleeping: { label: "Asleep", dot: "bg-faint", text: "text-muted-foreground" },
  error: { label: "Error", dot: "bg-destructive", text: "text-destructive" },
  gone: { label: "Gone", dot: "bg-faint", text: "text-muted-foreground" },
};

type Flow = {
  /** Data is moving right now. */
  flowing: boolean;
  /** Both ends are up; drawn solid instead of dashed. */
  live: boolean;
};

type DeviceNode = Node<{ client: ClientInfo }, "device">;
type BridgeNode = Node<{ overview: Overview }, "bridge">;
type VmNode = Node<{ vm: VmInfo; projects: ProjectInfo[]; selected: boolean }, "vm">;
type EmptyNode = Node<{ label: string }, "empty">;
type FlowEdge = Edge<Flow, "flow">;

const hidden = "!opacity-0";

/**
 * On narrow screens the graph is one column, drawn like a tree: devices above the bridge, VMs
 * below, and every connection runs down the left edge. Left to right it would not fit a phone.
 */
const Stacked = createContext(false);
const narrowQuery = typeof matchMedia === "function" ? matchMedia("(max-width: 639px)") : null;
const useNarrow = () =>
  useSyncExternalStore(
    (onChange) => {
      narrowQuery?.addEventListener("change", onChange);
      return () => narrowQuery?.removeEventListener("change", onChange);
    },
    () => narrowQuery?.matches ?? false,
  );
/** The stacked column's width: VM cards (300) indented by 48. */
const stackedWidth = 348;
/** Where the bridge's connections leave and arrive when stacked: near its left edge. */
const stackedHandle = { left: 20 };

function Status({ dot, text, label }: { dot: string; text: string; label: string }) {
  return (
    <span className={cn("flex items-center gap-2 text-[13px]", text)}>
      <span className={cn("size-2 rounded-full", dot)} />
      {label}
    </span>
  );
}

function DeviceCard({ data }: NodeProps<DeviceNode>) {
  const { client } = data;
  return (
    <div className="flex w-64 items-center gap-3 rounded-xl border bg-card p-3.5">
      <span className="grid size-9 place-items-center rounded-lg bg-muted text-muted-foreground">
        <HugeiconsIcon icon={LaptopIcon} className="size-5" strokeWidth={1.75} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{client.name}</div>
        {client.connected ? (
          <Status dot="bg-success" text="text-success" label="Connected" />
        ) : (
          <span className="text-[13px] text-muted-foreground">Seen {ago(client.lastSeenAt)}</span>
        )}
      </div>
      <Handle type="source" position={useContext(Stacked) ? Position.Left : Position.Right} isConnectable={false} className={hidden} />
    </div>
  );
}

function BridgeCard({ data }: NodeProps<BridgeNode>) {
  const { overview } = data;
  const provider = overview.provider?.active ? overview.provider : null;
  const stacked = useContext(Stacked);
  return (
    <div className="w-72 rounded-xl border border-primary/40 bg-card shadow-[0_0_0_4px_color-mix(in_oklab,var(--primary)_10%,transparent)]">
      <Handle type="target" position={stacked ? Position.Top : Position.Left} style={stacked ? stackedHandle : undefined} isConnectable={false} className={hidden} />
      <div className="flex items-center gap-3 p-3.5">
        <Logo className="size-9" />
        <div className="min-w-0 flex-1">
          <div className="font-semibold">VM Bridge</div>
          <div className="font-mono text-xs text-muted-foreground">v{overview.bridge.version}</div>
        </div>
      </div>
      <div className="flex items-center gap-2 border-t px-3.5 py-2.5 text-[13px] text-muted-foreground">
        {provider ? (
          <>
            <ProviderLogo id={provider.id} className="size-4 rounded" />
            {provider.label}
          </>
        ) : (
          "No provider yet"
        )}
      </div>
      <Handle type="source" position={stacked ? Position.Bottom : Position.Right} style={stacked ? stackedHandle : undefined} isConnectable={false} className={hidden} />
    </div>
  );
}

function VmCard({ data }: NodeProps<VmNode>) {
  const { vm, projects, selected } = data;
  const state = vmStates[vm.state];
  const settling = vm.state === "provisioning" || vm.state === "starting";
  const models = [...new Set(vm.sessions.map((session) => session.model).filter(Boolean))];
  const working = vm.sessions.filter((session) => session.working).length;
  return (
    <div
      className={cn(
        "w-[300px] cursor-pointer rounded-xl border bg-card transition-[border-color,opacity]",
        selected ? "border-primary ring-1 ring-primary" : settling ? "border-dashed border-primary/60" : "hover:border-input",
        vm.state === "sleeping" && !selected && "opacity-60",
      )}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} className={hidden} />
      <div className="flex flex-col gap-3 p-3.5">
        <div className="flex items-center gap-3">
          <ProviderLogo id={vm.provider} className="size-9 rounded-lg" />
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium">{vm.name}</div>
            <div className="truncate text-xs text-muted-foreground">{vm.sizeLabel}</div>
          </div>
        </div>
        <Status {...state} />
        <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <HugeiconsIcon icon={Message01Icon} className="size-4 text-faint" strokeWidth={1.75} />
          {vm.sessions.length} {vm.sessions.length === 1 ? "session" : "sessions"}
          {working > 0 && <span className="text-warning">· {working} working</span>}
        </div>
        {models.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {models.slice(0, 3).map((model) => (
              <Badge key={model} variant="secondary" className="font-mono font-normal">
                {model}
              </Badge>
            ))}
          </div>
        )}
        {vm.state === "error" && vm.error && <p className="line-clamp-2 text-xs text-destructive">{vm.error}</p>}
      </div>
      <div className="flex items-center gap-2 rounded-b-xl border-t bg-muted/40 px-3.5 py-2.5 text-[13px] text-muted-foreground">
        <HugeiconsIcon icon={Folder01Icon} className="size-4 shrink-0 text-faint" strokeWidth={1.75} />
        <span className="truncate">{projects.length ? projects.map((project) => project.title).join(", ") : "No repository yet"}</span>
      </div>
    </div>
  );
}

function EmptyCard({ data }: NodeProps<EmptyNode>) {
  return (
    <div className="flex w-64 items-center justify-center rounded-xl border border-dashed px-3 py-5 text-[13px] text-muted-foreground">
      {data.label}
      <Handle type="source" position={useContext(Stacked) ? Position.Left : Position.Right} isConnectable={false} className={hidden} />
      <Handle type="target" position={Position.Left} isConnectable={false} className={hidden} />
    </div>
  );
}

const reducedMotion = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** A connection. While requests pass, dots travel along it in the direction the requests go. */
function FlowEdgeView({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }: EdgeProps<FlowEdge>) {
  const [path] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const { flowing = false, live = false } = data ?? {};
  const dots = flowing && !reducedMotion ? 2 : 0;
  const seconds = 1.6;
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={{
          stroke: flowing ? "color-mix(in oklab, var(--primary) 55%, transparent)" : live ? "#3a3a3a" : "#262626",
          strokeWidth: flowing ? 1.75 : 1.25,
          strokeDasharray: live || flowing ? undefined : "5 5",
        }}
      />
      {Array.from({ length: dots }, (_, index) => (
        <circle key={index} r="3" fill="var(--primary)">
          <animateMotion dur={`${seconds}s`} begin={`${(index * seconds) / dots}s`} repeatCount="indefinite" path={path} />
        </circle>
      ))}
    </>
  );
}

const nodeTypes = { device: DeviceCard, bridge: BridgeCard, vm: VmCard, empty: EmptyCard };
const edgeTypes = { flow: FlowEdgeView };

function column(count: number, height: number, gap: number) {
  const total = count * height + (count - 1) * gap;
  return (index: number) => index * (height + gap) - total / 2;
}

const controlIcon = "size-[18px]";

/** Zoom controls, and a re-fit whenever cards come or go. */
function Controls({ fitKey }: { fitKey: string }) {
  const flow = useReactFlow();
  const stacked = useContext(Stacked);
  const width = useViewportStore((state) => state.width);
  // Stacked, the column is fitted to the width and shown from the top, below the New VM button.
  // Fitting its whole height would shrink the cards past reading.
  const fit = () =>
    void (stacked
      ? flow.setViewport({ x: 16, y: 72, zoom: Math.min(1, (width - 32) / stackedWidth) }, { duration: 300 })
      : flow.fitView({ padding: 0.25, maxZoom: 1, duration: 300 }));
  useEffect(() => {
    const timer = setTimeout(fit, 50);
    return () => clearTimeout(timer);
  }, [fitKey, width]);
  const controls = [
    { label: "Zoom in", icon: ZoomInIcon, run: () => void flow.zoomIn({ duration: 200 }) },
    { label: "Zoom out", icon: ZoomOutIcon, run: () => void flow.zoomOut({ duration: 200 }) },
    { label: "Fit to screen", icon: CenterFocusIcon, run: fit },
  ];
  return (
    <Panel position="bottom-left" className="!m-4">
      <ButtonGroup orientation="vertical">
        {controls.map((control) => (
          <Tooltip key={control.label}>
            <TooltipTrigger asChild>
              <Button variant="outline" size="icon-lg" className="size-9 bg-card" aria-label={control.label} onClick={control.run}>
                <HugeiconsIcon icon={control.icon} className={controlIcon} strokeWidth={1.75} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">{control.label}</TooltipContent>
          </Tooltip>
        ))}
      </ButtonGroup>
    </Panel>
  );
}

export function Canvas({ overview, traffic, onPair }: { overview: Overview; traffic: TrafficEvent[]; onPair: () => void }) {
  const now = useTick(1_000);
  const [selected, setSelected] = useState<string | null>(null);
  const create = useAction();
  const vm = overview.vms.find((entry) => entry.id === selected) ?? null;
  const narrow = useNarrow();

  const { nodes, edges } = useMemo(() => {
    const recent = traffic.filter((event) => now - event.at < flowWindowMs && event.kind !== "system");
    const flow = (match: (event: TrafficEvent) => boolean) => ({ flowing: recent.some(match) });
    const nodes: Node[] = [];
    const edges: FlowEdge[] = [];
    const clients = overview.clients;
    // Stacked: devices from the top, the bridge under them, then VMs, indented so connections fit on the left.
    const deviceCount = Math.max(clients.length, 1);
    const bridgeTop = deviceCount * 84 + 24;
    const devicePosition = (index: number) => (narrow ? { x: 48, y: index * 84 } : { x: 0, y: column(deviceCount, 68, 20)(index) });
    const vmPosition = (index: number) => (narrow ? { x: 48, y: bridgeTop + 148 + index * 236 } : { x: 780, y: column(Math.max(overview.vms.length, 1), 190, 28)(index) });
    if (clients.length === 0) nodes.push({ id: "empty-devices", type: "empty", position: devicePosition(0), data: { label: "Pair a device to start" } });
    clients.forEach((client, index) => {
      nodes.push({ id: `device-${client.id}`, type: "device", position: devicePosition(index), data: { client } });
      edges.push({
        id: `edge-${client.id}`,
        source: `device-${client.id}`,
        target: "bridge",
        type: "flow",
        data: { ...flow((event) => event.clientId === client.id), live: client.connected },
      });
    });
    nodes.push({ id: "bridge", type: "bridge", position: narrow ? { x: 0, y: bridgeTop } : { x: 380, y: -60 }, data: { overview } });
    if (overview.vms.length === 0) {
      const position = vmPosition(0);
      nodes.push({ id: "empty-vms", type: "empty", position: narrow ? position : { ...position, y: position.y + 60 }, data: { label: "VMs appear when work starts" } });
    }
    overview.vms.forEach((entry, index) => {
      const projects = overview.projects.filter((project) => entry.projects.includes(project.id));
      const live = entry.state === "ready" || entry.state === "busy";
      const traffic = flow((event) => event.vmId === entry.id);
      nodes.push({ id: entry.id, type: "vm", position: vmPosition(index), data: { vm: entry, projects, selected: entry.id === selected } });
      edges.push({
        id: `edge-vm-${entry.id}`,
        source: "bridge",
        target: entry.id,
        type: "flow",
        data: { ...traffic, flowing: traffic.flowing || entry.state === "busy", live },
      });
    });
    return { nodes, edges };
  }, [overview, traffic, now, selected, narrow]);

  return (
    <div className="relative h-full">
      <Stacked.Provider value={narrow}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          nodesDraggable={false}
          nodesConnectable={false}
          zoomOnDoubleClick={false}
          fitView
          fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
          minZoom={0.3}
          maxZoom={1.5}
          onNodeClick={(_, node) => {
            if (node.type === "vm") setSelected(node.id === selected ? null : node.id);
            if (node.id === "empty-devices") onPair();
          }}
          onPaneClick={() => setSelected(null)}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} />
          <Controls fitKey={`${nodes.length}-${narrow}`} />
          <Panel position="top-right" className="!m-4 flex flex-col items-end gap-2">
            <Button
              variant="outline"
              size="lg"
              className="bg-card"
              disabled={create.busy || !overview.setup.provider}
              title={overview.setup.provider ? undefined : "Choose a provider first"}
              onClick={() => void create.run(() => api("/vms", { body: {} }))}
            >
              <HugeiconsIcon icon={Add01Icon} data-icon="inline-start" strokeWidth={2} />
              New VM
            </Button>
            {create.error && <p className="max-w-64 text-right text-xs text-destructive">{create.error}</p>}
          </Panel>
        </ReactFlow>
      </Stacked.Provider>
      {vm && <VmDetails key={vm.id} vm={vm} overview={overview} now={now} onClose={() => setSelected(null)} />}
    </div>
  );
}

function VmDetails({ vm, overview, now, onClose }: { vm: VmInfo; overview: Overview; now: number; onClose: () => void }) {
  const action = useAction();
  const projects = overview.projects.filter((project) => vm.projects.includes(project.id));
  const awake = vm.state === "ready" || vm.state === "busy";
  const settling = vm.state === "provisioning" || vm.state === "starting";
  const providerLabel = overview.provider?.id === vm.provider ? overview.provider.label : vm.provider;
  const rows: [string, string][] = [
    ["Provider", providerLabel],
    ["Size", vm.sizeLabel],
    ["Sandbox", vm.sandboxId ?? "Not created"],
    ["T3", vm.t3Version ?? "Not installed"],
    ["Created", ago(vm.createdAt, now)],
    ["Last activity", ago(vm.lastActivityAt, now)],
  ];
  if (vm.sleepsAt) rows.push(["Sleeps", vm.sleepsAt <= now ? "Soon" : `In ${Math.ceil((vm.sleepsAt - now) / 60_000)} min`]);

  return (
    <aside className="absolute inset-x-2 bottom-2 z-10 flex max-h-[65%] flex-col rounded-xl border bg-card shadow-2xl shadow-black sm:inset-x-auto sm:top-3 sm:right-3 sm:bottom-3 sm:max-h-none sm:w-[400px]">
      <header className="flex items-center gap-3 p-4">
        <ProviderLogo id={vm.provider} className="size-9 rounded-lg" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold">{vm.name}</div>
          <Status {...vmStates[vm.state]} />
        </div>
        <Button variant="ghost" size="icon" aria-label="Close" onClick={onClose}>
          <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
        </Button>
      </header>
      <Separator />
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-4">
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-[13px]">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="truncate text-right font-mono text-xs leading-5">{value}</dd>
            </div>
          ))}
        </dl>
        {vm.error && <p className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-[13px] text-destructive">{vm.error}</p>}
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-medium text-muted-foreground">Repositories</h3>
          {projects.length === 0 && <p className="text-[13px] text-muted-foreground">None yet. Clone one from T3.</p>}
          <ItemGroup className="gap-1.5">
            {projects.map((project) => (
              <Item key={project.id} variant="outline" size="sm">
                <ItemMedia variant="icon">
                  <HugeiconsIcon icon={Folder01Icon} strokeWidth={1.75} />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{project.title}</ItemTitle>
                  {project.branch && <ItemDescription className="font-mono text-xs">{project.branch}</ItemDescription>}
                </ItemContent>
              </Item>
            ))}
          </ItemGroup>
        </section>
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-medium text-muted-foreground">Sessions</h3>
          {vm.sessions.length === 0 && <p className="text-[13px] text-muted-foreground">No sessions.</p>}
          <ItemGroup className="gap-1.5">
            {vm.sessions.map((session) => (
              <Item key={session.threadId} variant="outline" size="sm">
                <ItemContent>
                  <ItemTitle className="w-full justify-between">
                    <span className="truncate">{session.title}</span>
                    <Badge variant={session.working ? "default" : "secondary"}>{session.status}</Badge>
                  </ItemTitle>
                  <ItemDescription className="font-mono text-xs">{[session.provider, session.model].filter(Boolean).join(" · ") || "No model"}</ItemDescription>
                </ItemContent>
              </Item>
            ))}
          </ItemGroup>
        </section>
      </div>
      <Separator />
      <footer className="flex flex-col gap-2 p-4">
        <div className="flex gap-2">
          {awake ? (
            <Button variant="outline" size="lg" className="flex-1" disabled={action.busy} onClick={() => void action.run(() => api(`/vms/${vm.id}/sleep`, { body: {} }))}>
              <HugeiconsIcon icon={Moon02Icon} data-icon="inline-start" strokeWidth={1.75} />
              Sleep
            </Button>
          ) : (
            <Button variant="outline" size="lg" className="flex-1" disabled={action.busy || settling} onClick={() => void action.run(() => api(`/vms/${vm.id}/wake`, { body: {} }))}>
              <HugeiconsIcon icon={PowerIcon} data-icon="inline-start" strokeWidth={1.75} />
              Wake
            </Button>
          )}
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive" size="lg" className="flex-1" disabled={action.busy}>
                <HugeiconsIcon icon={Delete02Icon} data-icon="inline-start" strokeWidth={1.75} />
                Delete
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete {vm.name}?</AlertDialogTitle>
                <AlertDialogDescription>Its disk and any work that is not pushed are lost.</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction variant="destructive" onClick={() => void action.run(() => api(`/vms/${vm.id}`, { method: "DELETE" })).then((ok) => ok && onClose())}>
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
        {action.error && <p className="text-xs text-destructive">{action.error}</p>}
      </footer>
    </aside>
  );
}
