"use client";

import { ArrowRight01Icon, GithubIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { github, install, providers } from "@/lib/data";
import { useMedia } from "@/lib/hooks";
import { Logo, ProviderLogo } from "./brand";
import { Command } from "./CopyButton";
import type { SceneVm } from "./BridgeScene";

const BridgeScene = dynamic(() => import("./BridgeScene").then((m) => m.BridgeScene), { ssr: false });

const initialVms: SceneVm[] = [
  { id: "a", providerId: "boxd", name: "api-server", state: "online" },
  { id: "b", providerId: "instabox", name: "web-app", state: "asleep" },
  { id: "c", providerId: "daytona", name: "docs", state: "online" },
];

let supportsWebgl: boolean | undefined;

const stateLabel = { online: "Online", asleep: "Asleep", waking: "Waking" } as const;
const stateDot = { online: "bg-success", asleep: "bg-faint", waking: "bg-warning" } as const;

export function Hero() {
  const [vms, setVms] = useState(initialVms);
  const narrow = useMedia("(max-width: 639px)");
  // Some browsers and locked-down machines have WebGL off. The page still works without the scene.
  const webgl = useSyncExternalStore(
    () => () => {},
    () => (supportsWebgl ??= Boolean(document.createElement("canvas").getContext("webgl2"))),
    () => true,
  );
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const toggle = (id: string) => {
    const vm = vms.find((v) => v.id === id);
    if (!vm || vm.state === "waking") return;
    const set = (state: SceneVm["state"]) => setVms((list) => list.map((v) => (v.id === id ? { ...v, state } : v)));
    if (vm.state === "online") return set("asleep");
    set("waking");
    timers.current.push(setTimeout(() => set("online"), 1600));
  };

  return (
    <section className="relative overflow-hidden">
      <div className="dots pointer-events-none absolute inset-0 [mask-image:radial-gradient(ellipse_at_center,black_30%,transparent_75%)]" />
      <div className="relative mx-auto max-w-6xl px-4 pt-16 text-center sm:px-6 sm:pt-24">
        <h1 className="mx-auto max-w-3xl text-4xl font-semibold tracking-tight text-balance sm:text-6xl">
          Every T3 Code project gets its own cloud computer
        </h1>
        <p className="mx-auto mt-5 max-w-xl text-base text-pretty text-muted-foreground sm:text-lg">
          Each project runs on its own cloud VM. It sleeps when you stop, so you don't pay for idle time, and wakes up when you send a message.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/docs"
            className="inline-flex h-10 items-center gap-2 rounded-lg bg-white px-4 text-sm font-medium text-black transition hover:bg-white/85"
          >
            Read the docs
            <HugeiconsIcon icon={ArrowRight01Icon} size={16} />
          </Link>
          <a
            href={github}
            className="inline-flex h-10 items-center gap-2 rounded-lg border bg-card px-4 text-sm font-medium transition hover:bg-muted"
          >
            <HugeiconsIcon icon={GithubIcon} size={16} />
            GitHub
          </a>
        </div>
        <div className="mx-auto mt-6 max-w-2xl">
          <Command text={install} />
        </div>
      </div>

      <div className="relative mx-auto mt-4 h-[300px] max-w-6xl sm:mt-6 sm:h-[500px]">
        {webgl ? (
          <BridgeScene vms={vms} onToggle={toggle} narrow={narrow} />
        ) : (
          <div className="grid h-full place-items-center">
            <Logo className="size-32 opacity-90" />
          </div>
        )}
        <div className="pointer-events-none absolute top-4 left-4 hidden font-mono text-[11px] tracking-wide text-faint uppercase sm:block">
          Your devices
        </div>
        <div className="pointer-events-none absolute top-4 left-1/2 hidden -translate-x-1/2 font-mono text-[11px] tracking-wide text-faint uppercase sm:block">
          VM Bridge
        </div>
        <div className="pointer-events-none absolute top-4 right-4 hidden font-mono text-[11px] tracking-wide text-faint uppercase sm:block">
          Cloud VMs
        </div>
      </div>

      <div className="relative mx-auto flex max-w-6xl flex-wrap items-center justify-center gap-2 px-4 pb-6">
        <span className="w-full text-center text-xs text-faint sm:w-auto">Click a VM to sleep or wake it</span>
        {vms.map((vm) => {
          const provider = providers.find((p) => p.id === vm.providerId)!;
          return (
            <button
              key={vm.id}
              type="button"
              onClick={() => toggle(vm.id)}
              className="inline-flex items-center gap-2 rounded-full border bg-card py-1 pr-3 pl-1 text-xs transition hover:bg-muted"
            >
              <ProviderLogo provider={provider} className="size-5 rounded-full" />
              <span className="font-mono">{vm.name}</span>
              <span className={`size-1.5 rounded-full ${stateDot[vm.state]}`} />
              <span className="text-muted-foreground">{stateLabel[vm.state]}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
