import { useEffect, useState } from "react";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { File01Icon, FlowConnectionIcon, LaptopIcon, Logout01Icon, Plug01Icon, Settings01Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Toaster } from "@/components/ui/sonner";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useAction } from "@/hooks/use-action";
import { cn } from "@/lib/utils";
import { api, onLoggedOut, useLive } from "./api.ts";
import { Logo, ProviderLogo } from "./brand.tsx";
import { Canvas } from "./Canvas.tsx";
import { Devices } from "./Devices.tsx";
import { Logs } from "./Logs.tsx";
import { Settings } from "./Settings.tsx";
import { Setup } from "./Setup.tsx";

const views = [
  { id: "canvas", label: "Canvas", icon: FlowConnectionIcon },
  { id: "logs", label: "Logs", icon: File01Icon },
  { id: "setup", label: "Setup", icon: Plug01Icon },
  { id: "devices", label: "Devices", icon: LaptopIcon },
  { id: "settings", label: "Settings", icon: Settings01Icon },
] as const satisfies readonly { id: string; label: string; icon: IconSvgElement }[];

type View = (typeof views)[number]["id"];

/** The view lives in the URL hash so a reload keeps your place. */
function useView() {
  const read = (): View | null => views.find((view) => `#${view.id}` === location.hash)?.id ?? null;
  const [view, setView] = useState<View | null>(read);
  useEffect(() => {
    const onHash = () => setView(read());
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);
  const go = (next: View) => {
    history.replaceState(null, "", `#${next}`);
    setView(next);
  };
  return [view, go] as const;
}

export function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  useEffect(() => {
    void api<{ authenticated: boolean }>("/auth").then((auth) => setAuthenticated(auth.authenticated));
    return onLoggedOut(() => setAuthenticated(false));
  }, []);
  return (
    <TooltipProvider delayDuration={300}>
      {authenticated === true && <Dashboard onLoggedOut={() => setAuthenticated(false)} />}
      {authenticated === false && <Login onLoggedIn={() => setAuthenticated(true)} />}
      <Toaster position="bottom-right" />
    </TooltipProvider>
  );
}

function Login({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [key, setKey] = useState("");
  const action = useAction();
  return (
    <main className="grid min-h-full place-items-center px-4">
      <form
        className="flex w-full max-w-sm flex-col gap-8"
        onSubmit={(event) => {
          event.preventDefault();
          void action.run(() => api("/login", { body: { key } })).then((ok) => ok && onLoggedIn());
        }}
      >
        <div className="flex flex-col items-center gap-4">
          <Logo className="size-12" />
          <h1 className="text-xl font-semibold tracking-tight">VM Bridge</h1>
        </div>
        <FieldGroup>
          <Field data-invalid={Boolean(action.error)}>
            <FieldLabel htmlFor="key">Dashboard key</FieldLabel>
            <Input id="key" type="password" className="h-10" autoFocus autoComplete="current-password" value={key} onChange={(event) => setKey(event.target.value)} />
            {action.error && <FieldError>{action.error}</FieldError>}
          </Field>
          <Button type="submit" size="lg" className="h-10" disabled={action.busy || !key}>
            Log in
          </Button>
        </FieldGroup>
      </form>
    </main>
  );
}

function Dashboard({ onLoggedOut }: { onLoggedOut: () => void }) {
  const { overview, traffic, online } = useLive();
  const [chosen, go] = useView();
  const view: View = chosen ?? (overview && !overview.setup.provider ? "setup" : "canvas");
  const setupDone = overview && overview.setup.provider && overview.setup.github && overview.setup.agents;
  const provider = overview?.provider?.active ? overview.provider : null;
  const current = views.find((entry) => entry.id === view)!;

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 px-3 sm:px-4">
        <Logo className="size-7" />
        <span className="text-lg text-faint">/</span>
        <nav className="flex min-w-0 items-center gap-2 text-sm">
          {provider ? (
            <span className="flex min-w-0 items-center gap-2 font-medium">
              <ProviderLogo id={provider.id} className="size-5 rounded" />
              <span className="truncate">{provider.label}</span>
            </span>
          ) : (
            <span className="text-muted-foreground">No provider</span>
          )}
          <span className="text-faint">/</span>
          <span className="truncate text-muted-foreground">{current.label}</span>
        </nav>
        <div className={cn("ml-auto flex items-center gap-2 text-xs", online ? "text-muted-foreground" : "text-warning")}>
          <span className={cn("size-2 rounded-full", online ? "bg-success" : "bg-warning")} />
          {online ? "Live" : "Reconnecting"}
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        <nav className="order-last flex shrink-0 items-center justify-around gap-1 px-2 py-1.5 sm:order-none sm:w-14 sm:flex-col sm:justify-start sm:px-0 sm:py-2">
          {views.map((entry) => (
            <Tooltip key={entry.id}>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-lg"
                  aria-label={entry.label}
                  aria-current={view === entry.id ? "page" : undefined}
                  onClick={() => go(entry.id)}
                  className={cn("relative size-10 rounded-lg text-muted-foreground", view === entry.id && "bg-accent text-foreground hover:bg-accent")}
                >
                  <HugeiconsIcon icon={entry.icon} className="size-5" strokeWidth={1.75} />
                  {entry.id === "setup" && overview && !setupDone && <span className="absolute top-2 right-2 size-1.5 rounded-full bg-warning" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">{entry.label}</TooltipContent>
            </Tooltip>
          ))}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-lg"
                aria-label="Log out"
                className="size-10 rounded-lg text-muted-foreground max-sm:hidden sm:mt-auto"
                onClick={() => void api("/logout", { body: {} }).finally(onLoggedOut)}
              >
                <HugeiconsIcon icon={Logout01Icon} className="size-5" strokeWidth={1.75} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">Log out</TooltipContent>
          </Tooltip>
        </nav>

        <main className="relative mx-2 min-h-0 flex-1 overflow-hidden rounded-xl border bg-background sm:mr-3 sm:mb-3 sm:ml-0">
          {overview && view === "canvas" && <Canvas overview={overview} traffic={traffic} onPair={() => go("devices")} />}
          {overview && view === "logs" && <Logs overview={overview} traffic={traffic} />}
          {overview && view === "setup" && <Setup overview={overview} />}
          {overview && view === "devices" && <Devices overview={overview} />}
          {overview && view === "settings" && <Settings overview={overview} onLoggedOut={onLoggedOut} />}
        </main>
      </div>
    </div>
  );
}
