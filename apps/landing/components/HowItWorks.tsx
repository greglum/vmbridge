"use client";

import { ArrowLeft01Icon, ArrowRight01Icon, PauseIcon, PlayIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useRef, useState } from "react";
import { providers } from "@/lib/data";
import { useInView, useReducedMotion } from "@/lib/hooks";
import { Stage, steps } from "./Stage";

const stepMs = 2600;

export function HowItWorks() {
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [provider, setProvider] = useState(providers[0]);
  const section = useRef<HTMLElement>(null);
  const inView = useInView(section, "-20% 0px");
  const reduced = useReducedMotion();
  const running = playing && inView && !reduced;
  const step = steps[index];

  // Picking something by hand pauses the tour so it does not move on under the visitor.
  const go = (next: number) => {
    setIndex((next + steps.length) % steps.length);
    setPlaying(false);
  };

  return (
    <section id="how" ref={section} className="mx-auto max-w-6xl scroll-mt-20 px-4 py-24 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">From one command to a fleet of VMs</h2>
        </div>
        <div className="flex gap-1.5">
          <button type="button" onClick={() => go(index - 1)} aria-label="Previous step" className="grid size-9 place-items-center rounded-lg border bg-card transition hover:bg-muted">
            <HugeiconsIcon icon={ArrowLeft01Icon} size={16} />
          </button>
          <button
            type="button"
            onClick={() => setPlaying((value) => !value)}
            className="inline-flex h-9 w-24 items-center justify-center gap-2 rounded-lg border bg-card text-sm transition hover:bg-muted"
          >
            <HugeiconsIcon icon={playing ? PauseIcon : PlayIcon} size={14} />
            {playing ? "Pause" : "Play"}
          </button>
          <button type="button" onClick={() => go(index + 1)} aria-label="Next step" className="grid size-9 place-items-center rounded-lg border bg-card transition hover:bg-muted">
            <HugeiconsIcon icon={ArrowRight01Icon} size={16} />
          </button>
        </div>
      </div>

      <div
        className="mt-10 overflow-hidden rounded-2xl border bg-card"
        onKeyDown={(event) => {
          if (event.key === "ArrowRight") go(index + 1);
          if (event.key === "ArrowLeft") go(index - 1);
        }}
      >
        <div className="dots px-4 py-8 sm:px-8 sm:py-10">
          <Stage index={index} onStep={go} provider={provider} onPick={(p) => { setProvider(p); setPlaying(false); }} motion={inView && !reduced} />
        </div>

        <ol className="grid grid-cols-7 border-y bg-black/30">
          {steps.map((item, i) => {
            const active = i === index;
            return (
              <li key={item.title} className="min-w-0 border-l first:border-l-0">
                <button
                  type="button"
                  onClick={() => go(i)}
                  aria-current={active ? "step" : undefined}
                  className={`relative flex h-full w-full items-center justify-center gap-2 px-1 py-3 text-xs transition md:justify-start md:px-3 ${active ? "bg-card text-foreground" : i < index ? "text-muted-foreground hover:text-foreground" : "text-faint hover:text-foreground"}`}
                >
                  <span className={`grid size-5 shrink-0 place-items-center rounded-full font-mono text-[10px] ${active ? "bg-primary text-white" : i < index ? "bg-primary/20 text-primary" : "bg-muted"}`}>
                    {i + 1}
                  </span>
                  <span className="hidden truncate md:inline">{item.title}</span>
                  {active ? (
                    <span
                      key={`${index}-${playing}`}
                      className="absolute bottom-0 left-0 h-0.5 w-full origin-left bg-primary"
                      style={running ? { animation: `fill ${stepMs}ms linear forwards` } : { transform: playing ? "scaleX(0)" : "scaleX(1)" }}
                      onAnimationEnd={() => setIndex((n) => (n + 1) % steps.length)}
                    />
                  ) : null}
                </button>
              </li>
            );
          })}
        </ol>

        <div className="grid grid-cols-1 md:grid-cols-2">
          <div key={index} className="p-5 sm:p-6" style={{ animation: "rise 300ms both" }}>
            <div className="font-mono text-xs text-primary">
              {index + 1} / {steps.length}
            </div>
            <h3 className="mt-1.5 text-xl font-semibold">{step.title}</h3>
            <p className="mt-2 text-sm text-pretty text-muted-foreground">{step.body}</p>
          </div>
          <div className="min-h-36 min-w-0 border-t bg-black/60 p-5 font-mono text-[12px] leading-6 md:border-t-0 md:border-l sm:p-6">
            {step.log(provider).map((line, i) => (
              <div
                key={`${index}-${provider.id}-${i}`}
                className={`truncate whitespace-pre ${line.startsWith("$") ? "text-foreground" : "text-muted-foreground"}`}
                style={{ animation: `rise 300ms ${i * 120}ms both` }}
              >
                {line}
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
