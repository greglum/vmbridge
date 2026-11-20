import { useEffect, useState } from "react";
import { Waypoints } from "lucide-react";
import { api, onLoggedOut, useLive } from "./api.ts";
import { Canvas } from "./Canvas.tsx";
import { Devices } from "./Devices.tsx";
import { Settings } from "./Settings.tsx";
import { Setup } from "./Setup.tsx";
import { Button, ErrorText, Input, useAction } from "./ui.tsx";

const tabs = ["Canvas", "Setup", "Devices", "Settings"] as const;
type Tab = (typeof tabs)[number];

export function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  useEffect(() => {
    void api<{ authenticated: boolean }>("/auth").then((auth) => setAuthenticated(auth.authenticated));
    return onLoggedOut(() => setAuthenticated(false));
  }, []);
  if (authenticated === null) return null;
  return authenticated ? <Dashboard onLoggedOut={() => setAuthenticated(false)} /> : <Login onLoggedIn={() => setAuthenticated(true)} />;
}

function Login({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [key, setKey] = useState("");
  const action = useAction();
  return (
    <main className="grid min-h-full place-items-center px-4">
      <form
        className="flex w-full max-w-xs flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void action.run(() => api("/login", { body: { key } })).then((ok) => ok && onLoggedIn());
        }}
      >
        <div className="mb-3 flex items-center gap-2.5">
          <div className="grid size-8 place-items-center rounded-md bg-accent/15 text-accent-soft">
            <Waypoints size={16} />
          </div>
          <h1 className="text-[15px] font-semibold">VM Bridge</h1>
        </div>
        <Input type="password" autoFocus autoComplete="current-password" placeholder="Dashboard key" value={key} onChange={(event) => setKey(event.target.value)} />
        <Button tone="primary" type="submit" className="h-9" disabled={action.busy || !key}>
          Log in
        </Button>
        <ErrorText error={action.error} />
      </form>
    </main>
  );
}

function Dashboard({ onLoggedOut }: { onLoggedOut: () => void }) {
  const { overview, traffic, online } = useLive();
  const [tab, setTab] = useState<Tab>("Canvas");
  const setupDone = overview && overview.setup.provider && overview.setup.github && overview.setup.agents;
  useEffect(() => {
    if (overview && !overview.setup.provider) setTab((current) => (current === "Canvas" ? "Setup" : current));
  }, [overview === null]);

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-4 border-b border-line px-4">
        <div className="flex items-center gap-2">
          <Waypoints size={16} className="text-accent-soft" />
          <span className="hidden text-[13px] font-semibold sm:inline">VM Bridge</span>
        </div>
        <nav className="flex min-w-0 flex-1 gap-0.5 overflow-x-auto">
          {tabs.map((name) => (
            <button
              key={name}
              onClick={() => setTab(name)}
              className={`relative h-8 shrink-0 rounded-md px-2.5 text-[13px] transition-colors ${tab === name ? "bg-hover text-fg" : "text-muted hover:text-fg"}`}
            >
              {name}
              {name === "Setup" && overview && !setupDone && <span className="absolute right-1 top-1.5 size-1.5 rounded-full bg-warn" />}
            </button>
          ))}
        </nav>
        <span className={`flex shrink-0 items-center gap-1.5 text-[12px] ${online ? "text-faint" : "text-warn"}`}>
          <span className={`size-1.5 rounded-full ${online ? "bg-ok" : "bg-warn"}`} />
          <span className="hidden sm:inline">{online ? "Live" : "Reconnecting"}</span>
        </span>
      </header>
      {overview && (
        <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {tab === "Canvas" && <Canvas overview={overview} traffic={traffic} onPair={() => setTab("Devices")} />}
          {tab === "Setup" && <Setup overview={overview} />}
          {tab === "Devices" && <Devices overview={overview} />}
          {tab === "Settings" && <Settings overview={overview} onLoggedOut={onLoggedOut} />}
        </main>
      )}
    </div>
  );
}
