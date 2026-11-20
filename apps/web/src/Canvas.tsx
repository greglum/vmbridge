import { useMemo, useState } from "react";
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  getBezierPath,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { FolderGit2, Laptop, MessagesSquare, Moon, Plus, Power, Server, Trash, Waypoints, X } from "lucide-react";
import type { ClientInfo, Overview, ProjectInfo, TrafficEvent, VmInfo, VmState } from "@vmbridge/contracts";
import { ago, api, useTick } from "./api.ts";
import { Badge, Button, ErrorText, useAction } from "./ui.tsx";

const windowMs = 60_000;

const stateLabels: Record<VmState, { label: string; tone: "green" | "amber" | "red" | "violet" | "gray" }> = {
  provisioning: { label: "Creating", tone: "violet" },
  starting: { label: "Starting", tone: "violet" },
  ready: { label: "Idle", tone: "green" },
  busy: { label: "Working", tone: "amber" },
  sleeping: { label: "Asleep", tone: "gray" },
  error: { label: "Error", tone: "red" },
  gone: { label: "Gone", tone: "gray" },
};

type DeviceNode = Node<{ client: ClientInfo; rate: number }, "device">;
type BridgeNode = Node<{ overview: Overview; rate: number }, "bridge">;
type VmNode = Node<{ vm: VmInfo; projects: ProjectInfo[]; selected: boolean }, "vm">;
type EmptyNode = Node<{ label: string }, "empty">;
type FlowEdge = Edge<{ rate: number }, "flow">;

const rate = (count: number) => (count === 0 ? "idle" : `${count}/min`);

function DeviceCard({ data }: NodeProps<DeviceNode>) {
  const { client } = data;
  return (
    <div className="flex w-56 items-center gap-3 rounded-lg border border-line bg-panel px-3 py-2.5">
      <div className="grid size-8 place-items-center rounded-md bg-raised text-muted">
        <Laptop size={16} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium">{client.name}</div>
        <div className="flex items-center gap-1.5 text-[11px] text-faint">
          <span className={`size-1.5 rounded-full ${client.connected ? "bg-ok" : "bg-line-strong"}`} />
          {client.connected ? "Connected" : `Seen ${ago(client.lastSeenAt)}`}
        </div>
      </div>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}

function BridgeCard({ data }: NodeProps<BridgeNode>) {
  const { overview } = data;
  const awake = overview.vms.filter((vm) => ["ready", "busy"].includes(vm.state)).length;
  return (
    <div className="w-64 rounded-lg border border-accent/50 bg-panel shadow-[0_0_0_4px_rgba(124,92,255,0.08)]">
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <div className="flex items-center gap-3 border-b border-line px-3 py-2.5">
        <div className="grid size-8 place-items-center rounded-md bg-accent/15 text-accent-soft">
          <Waypoints size={16} />
        </div>
        <div>
          <div className="text-[13px] font-semibold">VM Bridge</div>
          <div className="text-[11px] text-faint">v{overview.bridge.version}</div>
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-y-1 px-3 py-2.5 text-[12px]">
        <dt className="text-faint">Provider</dt>
        <dd className="text-right">{overview.provider?.active ? overview.provider.label : "None"}</dd>
        <dt className="text-faint">VMs awake</dt>
        <dd className="text-right font-mono">
          {awake}/{overview.vms.length}
        </dd>
        <dt className="text-faint">Requests</dt>
        <dd className="text-right font-mono">{rate(data.rate)}</dd>
      </dl>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}

function VmCard({ data }: NodeProps<VmNode>) {
  const { vm, projects, selected } = data;
  const state = stateLabels[vm.state];
  const settling = vm.state === "provisioning" || vm.state === "starting";
  const models = [...new Set(vm.sessions.map((session) => session.model).filter(Boolean))];
  const working = vm.sessions.filter((session) => session.status === "running").length;
  return (
    <div
      className={`w-72 cursor-pointer rounded-lg border bg-panel transition-colors ${
        selected ? "border-accent" : settling ? "border-dashed border-accent/60" : "border-line hover:border-line-strong"
      } ${vm.state === "sleeping" ? "opacity-70" : ""}`}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <div className="flex items-center gap-3 border-b border-line px-3 py-2.5">
        <div className="grid size-8 place-items-center rounded-md bg-raised text-muted">
          <Server size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-[13px]">{vm.name}</div>
          <div className="truncate text-[11px] text-faint">{vm.sizeLabel}</div>
        </div>
        <Badge tone={state.tone}>{state.label}</Badge>
      </div>
      <div className="flex flex-col gap-1.5 px-3 py-2.5 text-[12px]">
        <div className="flex items-center gap-2 text-muted">
          <FolderGit2 size={13} className="shrink-0 text-faint" />
          <span className="truncate">{projects.length ? projects.map((project) => project.title).join(", ") : "No repository yet"}</span>
        </div>
        <div className="flex items-center gap-2 text-muted">
          <MessagesSquare size={13} className="shrink-0 text-faint" />
          <span>
            {vm.sessions.length} {vm.sessions.length === 1 ? "session" : "sessions"}
            {working > 0 && <span className="text-warn"> · {working} working</span>}
          </span>
        </div>
        {models.length > 0 && (
          <div className="flex flex-wrap gap-1 pt-0.5">
            {models.slice(0, 3).map((model) => (
              <span key={model} className="rounded bg-raised px-1.5 py-0.5 font-mono text-[10.5px] text-muted">
                {model}
              </span>
            ))}
          </div>
        )}
        {vm.state === "error" && vm.error && <p className="line-clamp-2 text-[11px] text-danger">{vm.error}</p>}
      </div>
    </div>
  );
}

function EmptyCard({ data }: NodeProps<EmptyNode>) {
  return (
    <div className="flex w-56 items-center justify-center rounded-lg border border-dashed border-line px-3 py-4 text-[12px] text-faint">
      {data.label}
      <Handle type="source" position={Position.Right} isConnectable={false} className="opacity-0" />
      <Handle type="target" position={Position.Left} isConnectable={false} className="opacity-0" />
    </div>
  );
}

function FlowEdgeView({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }: EdgeProps<FlowEdge>) {
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const active = (data?.rate ?? 0) > 0;
  return (
    <>
      <BaseEdge id={id} path={path} style={{ stroke: active ? "var(--color-accent)" : "var(--color-line-strong)", strokeWidth: active ? 1.75 : 1.25 }} />
      <EdgeLabelRenderer>
        <div
          className={`absolute rounded border px-1.5 py-0.5 font-mono text-[10.5px] ${active ? "border-accent/40 bg-panel text-accent-soft" : "border-line bg-canvas text-faint"}`}
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
        >
          {rate(data?.rate ?? 0)}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

const nodeTypes = { device: DeviceCard, bridge: BridgeCard, vm: VmCard, empty: EmptyCard };
const edgeTypes = { flow: FlowEdgeView };

function column(count: number, height: number, gap: number) {
  const total = count * height + (count - 1) * gap;
  return (index: number) => index * (height + gap) - total / 2;
}

export function Canvas({ overview, traffic, onPair }: { overview: Overview; traffic: TrafficEvent[]; onPair: () => void }) {
  const now = useTick(5_000);
  const [selected, setSelected] = useState<string | null>(null);
  const recent = useMemo(() => traffic.filter((event) => now - event.at < windowMs && event.kind !== "system"), [traffic, now]);
  const vm = overview.vms.find((entry) => entry.id === selected) ?? null;

  const { nodes, edges } = useMemo(() => {
    const nodes: Node[] = [];
    const edges: FlowEdge[] = [];
    const clientRate = (id: string) => recent.filter((event) => event.clientId === id).length;
    const vmRate = (id: string) => recent.filter((event) => event.vmId === id).length;
    const clients = overview.clients;
    const deviceY = column(Math.max(clients.length, 1), 64, 20);
    if (clients.length === 0) nodes.push({ id: "empty-devices", type: "empty", position: { x: 0, y: deviceY(0) }, data: { label: "Pair a device to start" } });
    clients.forEach((client, index) => {
      nodes.push({ id: `device-${client.id}`, type: "device", position: { x: 0, y: deviceY(index) }, data: { client, rate: clientRate(client.id) } });
      edges.push({ id: `edge-${client.id}`, source: `device-${client.id}`, target: "bridge", type: "flow", data: { rate: clientRate(client.id) } });
    });
    nodes.push({ id: "bridge", type: "bridge", position: { x: 340, y: -70 }, data: { overview, rate: recent.length } });
    const vmY = column(Math.max(overview.vms.length, 1), 150, 24);
    if (overview.vms.length === 0) {
      nodes.push({ id: "empty-vms", type: "empty", position: { x: 720, y: vmY(0) + 40 }, data: { label: "VMs appear when work starts" } });
    }
    overview.vms.forEach((entry, index) => {
      const projects = overview.projects.filter((project) => entry.projects.includes(project.id));
      nodes.push({ id: entry.id, type: "vm", position: { x: 720, y: vmY(index) }, data: { vm: entry, projects, selected: entry.id === selected } });
      edges.push({ id: `edge-vm-${entry.id}`, source: "bridge", target: entry.id, type: "flow", data: { rate: vmRate(entry.id) } });
    });
    return { nodes, edges };
  }, [overview, recent, selected]);

  return (
    <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
      <div className="relative h-[60vh] min-h-80 border-b border-line lg:h-auto lg:flex-1 lg:border-b-0 lg:border-r">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          nodesDraggable={false}
          nodesConnectable={false}
          fitView
          fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
          minZoom={0.3}
          onNodeClick={(_, node) => {
            if (node.type === "vm") setSelected(node.id === selected ? null : node.id);
            if (node.id === "empty-devices") onPair();
          }}
          onPaneClick={() => setSelected(null)}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} />
          <Controls showInteractive={false} position="bottom-left" />
        </ReactFlow>
      </div>
      <aside className="flex min-h-0 w-full flex-col lg:w-[360px]">
        {vm ? <VmDetails vm={vm} overview={overview} now={now} onClose={() => setSelected(null)} /> : <Activity overview={overview} traffic={traffic} now={now} />}
      </aside>
    </div>
  );
}

function VmDetails({ vm, overview, now, onClose }: { vm: VmInfo; overview: Overview; now: number; onClose: () => void }) {
  const action = useAction();
  const projects = overview.projects.filter((project) => vm.projects.includes(project.id));
  const awake = vm.state === "ready" || vm.state === "busy";
  const state = stateLabels[vm.state];
  const rows: [string, string][] = [
    ["Provider", overview.provider?.id === vm.provider ? overview.provider.label : vm.provider],
    ["Size", vm.sizeLabel],
    ["Sandbox", vm.sandboxId ?? "Not created"],
    ["T3", vm.t3Version ?? "Not installed"],
    ["Created", ago(vm.createdAt, now)],
    ["Last activity", ago(vm.lastActivityAt, now)],
  ];
  if (vm.sleepsAt) rows.push(["Sleeps", vm.sleepsAt <= now ? "Soon" : `In ${Math.ceil((vm.sleepsAt - now) / 60_000)} min`]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-line px-4">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono text-[13px]">{vm.name}</span>
          <Badge tone={state.tone}>{state.label}</Badge>
        </div>
        <Button tone="ghost" className="h-7 px-1.5" onClick={onClose} aria-label="Close">
          <X size={15} />
        </Button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[12px]">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-faint">{label}</dt>
              <dd className="truncate text-right font-mono text-muted">{value}</dd>
            </div>
          ))}
        </dl>
        {vm.error && <p className="rounded-md border border-danger/30 bg-danger/8 p-2.5 text-[12px] text-danger">{vm.error}</p>}
        <section>
          <h3 className="mb-2 text-[12px] font-medium text-faint">Repositories</h3>
          {projects.length === 0 && <p className="text-[12px] text-faint">None yet. Clone one from T3.</p>}
          {projects.map((project) => (
            <div key={project.id} className="flex items-center gap-2 py-1 text-[13px]">
              <FolderGit2 size={14} className="text-faint" />
              <span className="truncate">{project.title}</span>
              {project.branch && <span className="font-mono text-[11px] text-faint">{project.branch}</span>}
            </div>
          ))}
        </section>
        <section>
          <h3 className="mb-2 text-[12px] font-medium text-faint">Sessions</h3>
          {vm.sessions.length === 0 && <p className="text-[12px] text-faint">No sessions.</p>}
          <ul className="flex flex-col divide-y divide-line">
            {vm.sessions.map((session) => (
              <li key={session.threadId} className="flex flex-col gap-0.5 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-[13px]">{session.title}</span>
                  <Badge tone={session.status === "running" ? "amber" : "gray"}>{session.status}</Badge>
                </div>
                <span className="font-mono text-[11px] text-faint">{[session.provider, session.model].filter(Boolean).join(" · ") || "No model"}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
      <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-line p-3">
        {awake ? (
          <Button disabled={action.busy} onClick={() => void action.run(() => api(`/vms/${vm.id}/sleep`, { body: {} }))}>
            <Moon size={14} /> Sleep
          </Button>
        ) : (
          <Button disabled={action.busy || vm.state === "provisioning" || vm.state === "starting"} onClick={() => void action.run(() => api(`/vms/${vm.id}/wake`, { body: {} }))}>
            <Power size={14} /> Wake
          </Button>
        )}
        <Button
          tone="danger"
          disabled={action.busy}
          onClick={() => {
            if (!confirm(`Delete ${vm.name}? Its disk and any work not pushed are lost.`)) return;
            void action.run(() => api(`/vms/${vm.id}`, { method: "DELETE" })).then((ok) => ok && onClose());
          }}
        >
          <Trash size={14} /> Delete
        </Button>
        <ErrorText error={action.error} />
      </footer>
    </div>
  );
}

function Activity({ overview, traffic, now }: { overview: Overview; traffic: TrafficEvent[]; now: number }) {
  const action = useAction();
  const names = new Map([...overview.clients.map((client) => [client.id, client.name] as const), ...overview.vms.map((vm) => [vm.id, vm.name] as const)]);
  const events = traffic.slice(-80).reverse();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-line px-4">
        <h2 className="text-[13px] font-semibold">Activity</h2>
        <Button
          className="h-7"
          disabled={action.busy || !overview.setup.provider}
          title={overview.setup.provider ? undefined : "Choose a provider first"}
          onClick={() => void action.run(() => api("/vms", { body: {} }))}
        >
          <Plus size={14} /> New VM
        </Button>
      </header>
      <ErrorText error={action.error} />
      <ol className="min-h-0 flex-1 overflow-y-auto px-2 py-1 font-mono text-[11.5px]">
        {events.length === 0 && <li className="px-2 py-3 font-sans text-[12px] text-faint">No requests yet.</li>}
        {events.map((event) => (
          <li key={event.id} className="grid grid-cols-[3.25rem_1fr_auto] items-baseline gap-2 rounded px-2 py-1 hover:bg-panel">
            <span className="text-faint">{ago(event.at, now).replace(" ago", "")}</span>
            <span className={`truncate ${event.status === "error" ? "text-danger" : event.kind === "system" ? "text-accent-soft" : "text-muted"}`}>
              {event.operation}
              {(event.vmId || event.clientId) && <span className="text-faint"> · {names.get(event.vmId ?? event.clientId ?? "") ?? "removed"}</span>}
            </span>
            <span className="text-faint">{event.durationMs !== undefined ? `${event.durationMs}ms` : ""}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
