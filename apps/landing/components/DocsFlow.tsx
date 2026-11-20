"use client";

import { useState } from "react";
import { providers } from "@/lib/data";
import { useReducedMotion } from "@/lib/hooks";
import { Stage, steps } from "./Stage";

/** The lifecycle from the landing page, stepped by hand. */
export function DocsFlow() {
  const [index, setIndex] = useState(3);
  const [provider, setProvider] = useState(providers[0]);
  const reduced = useReducedMotion();
  const step = steps[index];
  return (
    <div className="not-prose my-6 overflow-hidden rounded-xl border bg-card">
      <div className="dots border-b px-3 py-6 sm:px-6">
        <Stage index={index} onStep={setIndex} provider={provider} onPick={setProvider} motion={!reduced} />
      </div>
      <div className="flex gap-1 overflow-x-auto border-b p-1.5">
        {steps.map((s, i) => (
          <button
            key={s.title}
            type="button"
            onClick={() => setIndex(i)}
            className={`shrink-0 rounded-md px-2.5 py-1 text-xs transition ${i === index ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}
          >
            {i + 1}. {s.title}
          </button>
        ))}
      </div>
      <p className="p-4 text-sm text-muted-foreground">{step.body}</p>
    </div>
  );
}
