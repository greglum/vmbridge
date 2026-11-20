"use client";

import {
  Copy01Icon,
  FilterHorizontalIcon,
  FolderAddIcon,
  GitBranchIcon,
  LayoutBottomIcon,
  Mic01Icon,
  Moon02Icon,
  Note01Icon,
  PencilEdit02Icon,
  Search01Icon,
  Settings01Icon,
  SidebarLeftIcon,
  SidebarRightIcon,
  ArrowRight01Icon,
  ChartColumnIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, useState } from "react";
import { agents, providers, type Agent } from "@/lib/data";
import { useInView, useReducedMotion } from "@/lib/hooks";
import { ProviderLogo } from "./brand";

type VmState = "online" | "asleep" | "waking";
type Code = { lang: string; body: string };
type Reply = { text: string; code?: Code };
type Message =
  | { id: number; role: "user"; text: string }
  | { id: number; role: "agent"; text: string; code?: Code; done: boolean }
  | { id: number; role: "notice"; tone: "warn" | "ok" | "quiet"; text: string };
type LogRow = { id: number; time: string; operation: string; target: string; took: string; kind: "client" | "vm" | "system" };

/** Seconds of idle before the demo VM dozes off. In VM Bridge it is minutes, 5 by default. */
const idleSeconds = 10;
/** Each second asleep on this page counts as this many minutes of a real night. */
const minutesPerSecond = 10;
/** A rough hourly price for a medium VM, only for the savings counter. */
const dollarsPerHour = 0.1;

/** Production T3 Code dark theme, recreated so the window looks like the real app. */
const t3 = {
  sans: '-apple-system, BlinkMacSystemFont, "Inter Variable", "Segoe UI", system-ui, sans-serif',
  mono: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace',
};

const replies: Record<string, Reply> = {
  "Center a div": {
    text: "Centered it, both ways. One rule and about 30 years of the web:",
    code: { lang: "css", body: ".parent {\n  display: grid;\n  place-items: center;\n}" },
  },
  "Rewrite it in Rust": {
    text: "Rewrote it in Rust. It is 3 ms faster and takes 4 minutes to compile.",
  },
  "Fix the bug I made at 3am": {
    text: "Found it: you wrote `final_final_v2` but used `final_final`. Go to bed, your VM already did.",
  },
  "Make it webscale": {
    text: "Added a load balancer, two caches and a queue for your 3 users. I would undo this.",
  },
};

const keywordReplies: [RegExp, string][] = [
  [/\b(hi|hello|hey|yo)\b/i, "Hi. I am awake, which is more than this VM can say for most of the day."],
  [/test/i, "Ran `bun test`: 41 passed, 1 skipped because nobody trusts it."],
  [/bug|fix|error|broken|crash/i, "Fixed. It was a missing `await`. It is always a missing `await`."],
  [/deploy|ship|prod/i, "Shipped on a Friday. Brave. The VM will sleep through the fallout."],
  [/coffee|tired|sleep|nap/i, "I run on a VM, not coffee. It only costs you while awake."],
  [/rust|\bgo\b|zig/i, "I could rewrite it, but the current version works, and that is rare enough to protect."],
];

const fallbacks = [
  "Done. I read 14 files, changed 2 and decided the other 12 were fine.",
  "Shipped it. Tests pass, the linter is happy and I left one `TODO` for future you.",
  "Done. If anyone asks, it was like this when I got here.",
  "Done, with a comment explaining why. You will not read it.",
];

const grumbles = ["Five more minutes.", "I was dreaming about idle CPUs.", "Who messages a VM at this hour?", "Fine. I am up. Mostly."];
const pokeLines = ["Zzz.", "Zzz... not now.", "Send a message if you need me.", "Asleep means free. Let me be."];

const badgeTone = {
  green: "bg-emerald-500/15 text-emerald-400",
  blue: "bg-sky-500/15 text-sky-400",
  orange: "bg-orange-500/15 text-orange-400",
};

const otherThreads = [
  { badge: "HW", tone: "green", project: "Hello-World", title: "Center the div, again", branch: "fix/center-div", time: "6m", agent: "claude" },
  { badge: "VB", tone: "blue", project: "vm-bridge", title: "Teach the VM to snore", branch: "feat/snoring", time: "14m", agent: "codex" },
  { badge: "MA", tone: "orange", project: "mobile-app", title: "Undo the webscale", branch: "revert/webscale", time: "31m", agent: "claude" },
] as const;

const clock = () => new Date().toLocaleTimeString("en-GB", { hour12: false });
const vmNameOf = (providerId: string) => `vm-${providerId.slice(0, 2)}9bca`;
const agentById = (id: string) => agents.find((a) => a.id === id) ?? agents[0];

function replyTo(message: string, serial: number): Reply {
  const keyword = keywordReplies.find(([pattern]) => pattern.test(message))?.[1];
  return replies[message] ?? { text: keyword ?? fallbacks[serial % fallbacks.length] };
}

/** Plain text with `inline code` chips, like T3 Code's markdown. */
function Rich({ text }: { text: string }) {
  return text.split(/(`[^`]+`)/).map((part, i) =>
    part.length > 2 && part.startsWith("`") && part.endsWith("`") ? (
      <code key={i} className="rounded-md bg-white/[0.08] px-1.5 py-0.5 text-[0.85em]" style={{ fontFamily: t3.mono }}>
        {part.slice(1, -1)}
      </code>
    ) : (
      part
    ),
  );
}

/** A CSS block with the colours T3 Code uses: teal selectors, orange properties, amber values. */
function CodeBlock({ code }: { code: Code }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-3 rounded-xl border border-white/[0.08] bg-[#141414] p-3" style={{ animation: "rise 200ms both" }}>
      <div className="flex items-center justify-between">
        <span className="rounded bg-violet-500/20 px-1 text-[9px] font-bold text-violet-300 uppercase">{code.lang}</span>
        <button
          type="button"
          aria-label="Copy code"
          onClick={() => {
            void navigator.clipboard?.writeText(code.body).then(() => setCopied(true));
          }}
          className="grid size-7 place-items-center rounded-md text-neutral-400 transition hover:bg-white/[0.06] hover:text-neutral-100"
        >
          <HugeiconsIcon icon={copied ? Tick02Icon : Copy01Icon} size={14} />
        </button>
      </div>
      <pre className="mt-1 overflow-x-auto text-[13px] leading-6" style={{ fontFamily: t3.mono }}>
        {code.body.split("\n").map((line, i) => {
          const declaration = /^(\s*)([\w-]+)(:\s*)([^;]+)(;)$/.exec(line);
          if (declaration) {
            const [, indent, property, colon, value, semi] = declaration;
            return (
              <div key={i}>
                {indent}
                <span className="text-orange-300">{property}</span>
                <span className="text-neutral-500">{colon}</span>
                <span className="text-amber-200">{value}</span>
                <span className="text-neutral-500">{semi}</span>
              </div>
            );
          }
          const selector = /^([^{}]+)(\{)$/.exec(line);
          if (selector) {
            return (
              <div key={i}>
                <span className="text-teal-300">{selector[1]}</span>
                <span className="text-neutral-500">{selector[2]}</span>
              </div>
            );
          }
          return (
            <div key={i} className="text-neutral-500">
              {line}
            </div>
          );
        })}
      </pre>
    </div>
  );
}

function AgentMark({ agent, className = "size-4" }: { agent: Agent; className?: string }) {
  // eslint-disable-next-line @next/next/no-img-element -- tiny static mark
  return <img src={agent.logo} alt="" className={`shrink-0 ${className}`} draggable={false} />;
}

function ThreadCard(props: { badge: string; tone: keyof typeof badgeTone; project: string; title: string; branch: string; time: string; agent: Agent; current?: boolean }) {
  return (
    <div className={`rounded-xl px-3 py-2.5 transition ${props.current ? "bg-[#1f1f1f]" : "hover:bg-white/[0.03]"}`}>
      <div className="flex items-center gap-2 text-[13px] text-neutral-400">
        <span className={`rounded px-1 text-[9px] leading-4 font-bold ${badgeTone[props.tone]}`}>{props.badge}</span>
        <span className="min-w-0 flex-1 truncate">{props.project}</span>
        <span className="tabular-nums">{props.time}</span>
      </div>
      <div className="mt-1 truncate text-[15px] text-neutral-100">{props.title}</div>
      <div className="mt-0.5 flex items-center gap-2 text-xs text-neutral-500">
        <span className="min-w-0 flex-1 truncate">{props.branch}</span>
        <AgentMark agent={props.agent} className="size-3.5" />
      </div>
    </div>
  );
}

const iconButton = "grid size-8 place-items-center rounded-lg text-neutral-400 transition hover:bg-white/[0.05] hover:text-neutral-100";

export function Playground() {
  const [provider, setProvider] = useState(providers[0]);
  const [agent, setAgent] = useState<Agent>(agents[1]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [vm, setVm] = useState<VmState>("online");
  const [idle, setIdle] = useState(idleSeconds);
  const [messages, setMessages] = useState<Message[]>([
    { id: 0, role: "user", text: "Set up the project and tell me what it does" },
    {
      id: 1,
      role: "agent",
      done: true,
      text: "It is a small web app. I installed everything and `bun dev` runs fine.",
    },
  ]);
  const [log, setLog] = useState<LogRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  /** Seconds asleep this time, ticked only while the section is on screen. */
  const [asleepFor, setAsleepFor] = useState(0);
  const [savedMinutes, setSavedMinutes] = useState(0);
  const [pokes, setPokes] = useState(0);
  const [bubble, setBubble] = useState<string | null>(null);
  const serial = useRef(2);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const bubbleTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const thread = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLElement>(null);
  const inView = useInView(root);
  const reduced = useReducedMotion();
  const vmName = vmNameOf(provider.id);

  useEffect(
    () => () => {
      timers.current.forEach(clearTimeout);
      clearTimeout(bubbleTimer.current);
    },
    [],
  );

  // The idle countdown only runs while the VM is awake, nothing is streaming and the section is visible.
  useEffect(() => {
    if (vm !== "online" || busy || !inView) return;
    const timer = setInterval(() => setIdle((left) => left - 1), 1000);
    return () => clearInterval(timer);
  }, [vm, busy, inView]);

  useEffect(() => {
    if (idle > 0 || vm !== "online") return;
    sleep("Idle");
  });

  // Snoring and savings tick once a second, only while asleep and on screen.
  useEffect(() => {
    if (vm !== "asleep" || !inView) return;
    const timer = setInterval(() => {
      setAsleepFor((seconds) => seconds + 1);
      setSavedMinutes((minutes) => minutes + minutesPerSecond);
    }, 1000);
    return () => clearInterval(timer);
  }, [vm, inView]);

  useEffect(() => {
    thread.current?.scrollTo({ top: thread.current.scrollHeight, behavior: reduced ? "auto" : "smooth" });
  }, [messages, reduced]);

  const later = (ms: number, run: () => void) => timers.current.push(setTimeout(run, ms));
  const nextId = () => serial.current++;
  const addLog = (row: Omit<LogRow, "id" | "time">) => setLog((rows) => [{ ...row, id: nextId(), time: clock() }, ...rows].slice(0, 8));
  const addMessage = (message: Message) => setMessages((list) => [...list, message].slice(-12));

  function say(text: string) {
    clearTimeout(bubbleTimer.current);
    setBubble(text);
    bubbleTimer.current = setTimeout(() => setBubble(null), 2200);
  }

  function sleep(reason: "Idle" | "Manual") {
    setVm("asleep");
    setAsleepFor(0);
    setPokes(0);
    addMessage({ id: nextId(), role: "notice", tone: "quiet", text: "VM asleep. This thread stays readable." });
    addLog({ kind: "system", operation: reason === "Idle" ? "Idle, sleeping VM" : "Sleeping VM", target: vmName, took: "0.7 s" });
    later(300, () => addLog({ kind: "client", operation: "thread read from saved copy", target: "bridge", took: "0.1 ms" }));
  }

  function poke() {
    if (vm !== "asleep") return;
    setPokes((count) => count + 1);
    say(pokeLines[Math.min(pokes, pokeLines.length - 1)]);
    addLog({ kind: "client", operation: "poke", target: vmName, took: "ignored" });
  }

  function stream(reply: Reply) {
    const id = nextId();
    addMessage({ id, role: "agent", text: "", code: reply.code, done: false });
    const words = reply.text.split(" ");
    const started = performance.now();
    words.forEach((_, i) =>
      later(i * 22, () => {
        const partial = words.slice(0, i + 1).join(" ");
        const done = i === words.length - 1;
        setMessages((list) => list.map((m) => (m.id === id && m.role === "agent" ? { ...m, text: partial, done } : m)));
        if (done) {
          setBusy(false);
          setIdle(idleSeconds);
          addLog({ kind: "vm", operation: "orchestration.dispatch", target: vmName, took: `${Math.round(performance.now() - started)} ms` });
        }
      }),
    );
  }

  function send(text: string) {
    const message = text.trim();
    if (!message || busy) return;
    const id = nextId();
    const reply = replyTo(message, id);
    setDraft("");
    setBusy(true);
    setBubble(null);
    setPickerOpen(false);
    addMessage({ id, role: "user", text: message });
    addLog({ kind: "client", operation: "thread.send", target: "bridge", took: "1 ms" });
    if (vm !== "asleep") return later(250, () => stream(reply));

    // Quick on purpose: the demo is about the feeling, not the stopwatch.
    const ms = 1200 + Math.round(Math.random() * 600);
    const notice = nextId();
    setVm("waking");
    addMessage({ id: notice, role: "notice", tone: "warn", text: `Waking the ${provider.name} VM` });
    addLog({ kind: "system", operation: `Waking ${provider.name} VM`, target: vmName, took: "..." });
    later(ms, () => {
      const took = `${(ms / 1000).toFixed(1)} s`;
      setVm("online");
      setMessages((list) =>
        list.map((m) => (m.id === notice && m.role === "notice" ? { ...m, tone: "ok", text: `${provider.name} VM woke in ${took}` } : m)),
      );
      say(grumbles[notice % grumbles.length]);
      addLog({ kind: "system", operation: "Woke VM", target: vmName, took });
      later(250, () => stream(reply));
    });
  }

  function pickProvider(next: (typeof providers)[number]) {
    if (next.id === provider.id) return;
    setProvider(next);
    setVm("online");
    setIdle(idleSeconds);
    setBubble(null);
    addLog({ kind: "system", operation: `Project moved to ${next.name}`, target: vmNameOf(next.id), took: "ready" });
  }

  function pickAgent(next: Agent) {
    setPickerOpen(false);
    if (next.id === agent.id) return;
    setAgent(next);
    addMessage({ id: nextId(), role: "notice", tone: "quiet", text: `Switched to ${next.name}` });
  }

  const status = { online: busy ? "Working" : "Online", asleep: "Asleep", waking: "Waking" }[vm];
  const dot = { online: "bg-success", asleep: "bg-neutral-500", waking: "bg-warning" }[vm];
  const noticeDot = { warn: "bg-warning", ok: "bg-success", quiet: "bg-neutral-600" };

  return (
    <section id="try" ref={root} className="mx-auto max-w-6xl scroll-mt-20 px-4 py-24 sm:px-6">
      <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">Put a VM to sleep, then wake it up</h2>

      {/* T3 Code, drawn the way the production app looks. */}
      <div
        className="mt-10 grid h-[600px] grid-cols-1 overflow-hidden rounded-2xl border border-white/[0.08] bg-black text-neutral-100 lg:grid-cols-[260px_minmax(0,1fr)]"
        style={{ fontFamily: t3.sans }}
      >
        <aside className="hidden min-h-0 flex-col border-r border-white/[0.08] bg-[#0a0a0a] lg:flex">
          <div className="flex h-14 shrink-0 items-center gap-3 px-3">
            <span className={iconButton}>
              <HugeiconsIcon icon={SidebarLeftIcon} size={18} />
            </span>
            <span className="text-[15px]">
              <span className="font-bold">T3</span> Code
            </span>
          </div>
          <div className="flex items-center gap-1 px-3 pb-2">
            <span className="flex flex-1 items-center gap-2 px-1.5 text-sm text-neutral-400">
              <HugeiconsIcon icon={Search01Icon} size={16} />
              Search
            </span>
            {[FilterHorizontalIcon, FolderAddIcon, PencilEdit02Icon].map((icon, i) => (
              <span key={i} className={iconButton}>
                <HugeiconsIcon icon={icon} size={16} />
              </span>
            ))}
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-hidden px-2">
            <ThreadCard badge="HW" tone="green" project="Hello-World" title="Make it better" branch="feat/make-it-better" time="now" agent={agent} current />
            {otherThreads.map((t) => (
              <ThreadCard key={t.title} {...t} agent={agentById(t.agent)} />
            ))}
          </div>
          <div className="flex items-center justify-between px-5 py-2 text-sm text-neutral-300">
            <span>Settled</span>
            <span className="flex items-center gap-1 text-neutral-400">
              1
              <HugeiconsIcon icon={ArrowRight01Icon} size={14} />
            </span>
          </div>
          <div className="flex gap-1 px-3 pb-3">
            {[Settings01Icon, GitBranchIcon, ChartColumnIcon].map((icon, i) => (
              <span key={i} className={iconButton}>
                <HugeiconsIcon icon={icon} size={17} />
              </span>
            ))}
          </div>
        </aside>

        <div className="flex min-h-0 min-w-0 flex-col">
          <div className="flex h-14 shrink-0 items-center gap-2 px-4">
            <span className={`rounded px-1 text-[9px] leading-4 font-bold ${badgeTone.green}`}>HW</span>
            <span className="hidden text-[15px] text-neutral-400 sm:inline">Hello-World</span>
            <span className="hidden text-neutral-600 sm:inline">/</span>
            <h3 className="min-w-0 truncate text-[15px]">Make it better</h3>
            <span className="ml-auto flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-white/[0.08] px-2 text-xs text-neutral-300">
              <ProviderLogo provider={provider} className="size-4 rounded" />
              {provider.name}
              <span className={`size-1.5 rounded-full ${dot}`} />
              <span className="text-neutral-400">{status}</span>
            </span>
            <span className="hidden items-center gap-0.5 sm:flex">
              {[Note01Icon, LayoutBottomIcon, SidebarRightIcon].map((icon, i) => (
                <span key={i} className={iconButton}>
                  <HugeiconsIcon icon={icon} size={17} />
                </span>
              ))}
            </span>
          </div>

          <div ref={thread} className="min-h-0 flex-1 overflow-y-auto px-4">
            <div className="mx-auto flex max-w-[46rem] flex-col pt-2 pb-4">
              {messages.map((m) => {
                if (m.role === "notice") {
                  return (
                    <div key={m.id} className="flex items-center gap-2 px-1 pb-5 text-[13px] text-neutral-400">
                      <span className={`size-1.5 shrink-0 rounded-full ${noticeDot[m.tone]}`} />
                      {m.text}
                    </div>
                  );
                }
                if (m.role === "user") {
                  return (
                    <div key={m.id} className="flex justify-end pb-5">
                      <div className="max-w-[80%] rounded-[20px] bg-[#1f1f1f] px-4 py-2.5 text-[15px] leading-relaxed break-words">{m.text}</div>
                    </div>
                  );
                }
                return (
                  <div key={m.id} className="px-1 pb-5 text-[15px] leading-7 text-pretty break-words">
                    {m.text ? <Rich text={m.text} /> : <span className="text-neutral-500">Thinking...</span>}
                    {m.code && m.done ? <CodeBlock code={m.code} /> : null}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="shrink-0 px-3 pb-3 sm:px-4 sm:pb-4">
            <div className="mx-auto max-w-[46rem]">
              <div className="mb-2 flex gap-1.5 overflow-x-auto [scrollbar-width:none]">
                {Object.keys(replies).map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    disabled={busy}
                    onClick={() => send(suggestion)}
                    className="shrink-0 rounded-full border border-white/[0.08] px-3 py-1 text-[13px] text-neutral-400 transition hover:bg-white/[0.05] hover:text-neutral-100 disabled:opacity-40"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>

              <form
                className="relative rounded-[20px] border border-white/[0.06] bg-[#1a1a1a]"
                onSubmit={(event) => {
                  event.preventDefault();
                  send(draft);
                }}
              >
                <input
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder={vm === "asleep" ? "Send anything to wake the VM" : "Ask anything. @ files, $ skills, / commands"}
                  aria-label="Message Make it better"
                  className="block w-full bg-transparent px-4 pt-4 pb-6 text-base text-neutral-100 outline-none placeholder:text-neutral-500 sm:text-[15px]"
                />
                <div className="flex items-center justify-end gap-1 px-2 pb-2">
                  <div className="relative">
                    <button
                      type="button"
                      aria-haspopup="listbox"
                      aria-expanded={pickerOpen}
                      disabled={busy}
                      onClick={() => setPickerOpen((open) => !open)}
                      className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-[15px] text-neutral-100/85 transition hover:bg-white/[0.05] hover:text-neutral-100 disabled:opacity-60"
                    >
                      <AgentMark agent={agent} />
                      {agent.name}
                    </button>
                    {pickerOpen ? (
                      <div
                        role="listbox"
                        aria-label="Agent"
                        className="absolute right-0 bottom-full z-10 mb-1.5 w-40 rounded-xl border border-white/[0.08] bg-[#1a1a1a] p-1 shadow-[0_14px_32px_-18px_rgb(0_0_0/75%)]"
                        style={{ animation: "rise 150ms both" }}
                      >
                        {agents.map((a) => (
                          <button
                            key={a.id}
                            type="button"
                            role="option"
                            aria-selected={a.id === agent.id}
                            onClick={() => pickAgent(a)}
                            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-white/[0.06]"
                          >
                            <AgentMark agent={a} />
                            <span className="flex-1">{a.name}</span>
                            {a.id === agent.id ? <HugeiconsIcon icon={Tick02Icon} size={14} /> : null}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  <span className={`${iconButton} rounded-full`}>
                    <HugeiconsIcon icon={Mic01Icon} size={17} />
                  </span>
                  <button
                    type="submit"
                    disabled={busy || !draft.trim()}
                    aria-label="Send"
                    className="grid size-9 place-items-center rounded-full bg-[oklch(0.571_0.21_264)] text-white transition-all duration-150 enabled:hover:scale-105 disabled:bg-white/[0.12] disabled:text-neutral-300"
                  >
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
                      <path d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="min-w-0 rounded-2xl border bg-card p-4">
          <div className="flex flex-wrap gap-2">
            {providers.map((p) => (
              <button
                key={p.id}
                type="button"
                disabled={busy}
                onClick={() => pickProvider(p)}
                className={`inline-flex items-center gap-2 rounded-lg border py-1 pr-3 pl-1 text-sm transition disabled:opacity-40 ${p.id === provider.id ? "border-primary/60 bg-primary/10" : "hover:bg-muted"}`}
              >
                <ProviderLogo provider={p} className="size-6 rounded-md" />
                {p.name}
              </button>
            ))}
          </div>

          {/* The VM itself. Click it while it sleeps. */}
          <div className="dots relative mt-4 flex h-48 flex-col items-center justify-center rounded-xl border bg-black">
            <div className="relative">
              {bubble ? (
                <div
                  key={bubble}
                  className="absolute bottom-full left-1/2 mb-3 w-max max-w-52 -translate-x-1/2 rounded-lg border bg-card px-2.5 py-1 text-center text-xs text-pretty"
                  style={{ animation: "rise 200ms both" }}
                >
                  {bubble}
                </div>
              ) : null}
              <button
                key={pokes}
                type="button"
                onClick={poke}
                disabled={vm !== "asleep"}
                aria-label={vm === "asleep" ? "Poke the sleeping VM" : vmName}
                className={`block rounded-2xl transition duration-500 disabled:cursor-default ${
                  vm === "online" ? "shadow-[0_0_40px_-8px_var(--success)]" : vm === "waking" ? "shadow-[0_0_40px_-8px_var(--warning)]" : "cursor-pointer"
                }`}
                style={pokes > 0 && !reduced ? { animation: "poke 400ms ease-in-out" } : undefined}
              >
                <ProviderLogo provider={provider} className={`size-16 rounded-2xl transition duration-500 ${vm === "asleep" ? "opacity-40 grayscale" : ""}`} />
              </button>
              {vm === "asleep"
                ? [0, 1, 2].map((i) => {
                    // Three z's take turns rising. They move once a second, only while asleep and on screen.
                    const phase = (asleepFor + i) % 3;
                    return (
                      <span
                        key={i}
                        aria-hidden
                        className="pointer-events-none absolute -top-2 -right-3 font-mono font-semibold text-muted-foreground"
                        style={{
                          fontSize: 12 + phase * 3,
                          opacity: 1 - phase * 0.35,
                          transform: `translate(${phase * 9}px, ${-phase * 13}px)`,
                          transition: phase === 0 || reduced ? "none" : "transform 1s linear, opacity 1s linear, font-size 1s linear",
                        }}
                      >
                        z
                      </span>
                    );
                  })
                : null}
            </div>
            <div className="mt-3 font-mono text-sm">{vmName}</div>
            <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className={`size-1.5 rounded-full ${dot}`} />
              {status}
              <span className="text-faint">· {provider.sizes[1]}</span>
            </div>
            <button
              type="button"
              disabled={vm !== "online" || busy}
              onClick={() => sleep("Manual")}
              className="absolute top-2.5 right-2.5 inline-flex h-8 items-center gap-1.5 rounded-lg border bg-card px-2.5 text-xs transition hover:bg-muted disabled:opacity-40"
            >
              <HugeiconsIcon icon={Moon02Icon} size={14} />
              Sleep now
            </button>
          </div>

          <div className="mt-4">
            <div className="flex justify-between gap-3 text-xs text-muted-foreground">
              <span>
                {vm === "online"
                  ? busy
                    ? `${agent.name} is working`
                    : `Falls asleep in ${idle}s`
                  : vm === "waking"
                    ? "Waking up"
                    : "Asleep. Send a message to wake it"}
              </span>
              <span className="font-mono tabular-nums">
                {vm === "asleep" ? `$${((savedMinutes / 60) * dollarsPerHour).toFixed(2)} saved` : ""}
              </span>
            </div>
            <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
              <div
                className={`h-full origin-left rounded-full transition-transform duration-1000 ease-linear ${vm === "online" ? "bg-success" : "bg-faint"}`}
                style={{ transform: `scaleX(${vm === "online" ? idle / idleSeconds : 0})` }}
              />
            </div>
          </div>
        </div>

        <div className="min-h-64 min-w-0 overflow-hidden rounded-2xl border bg-black">
          <div className="border-b px-4 py-2.5 text-xs text-muted-foreground">Logs</div>
          <div className="p-2 font-mono text-[12px]">
            {log.length === 0 ? <div className="px-2 py-6 text-center text-faint">Send a message to see traffic</div> : null}
            {log.map((row) => (
              <div key={row.id} className="grid grid-cols-[3px_4.5rem_minmax(0,1fr)_auto] items-center gap-2 rounded px-2 py-1.5" style={{ animation: "rise 250ms both" }}>
                <span className={`h-4 rounded-full ${row.kind === "client" ? "bg-primary" : row.kind === "vm" ? "bg-success" : "bg-warning"}`} />
                <span className="text-faint">{row.time}</span>
                <span className="truncate">
                  {row.operation} <span className="text-faint">{row.target}</span>
                </span>
                <span className="text-muted-foreground">{row.took}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
