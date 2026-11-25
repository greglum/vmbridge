"use client";

import { AiChat02Icon, Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Fragment, useState } from "react";
import { copy } from "@/lib/copy";
import { secondaryButton } from "@/lib/styles";
import { UrlText } from "./TerminalWindow";

/** A small icon button that copies text; the copy and tick icons cross-fade on swap. */
export function CopyButton({ text, className = "" }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={copied ? "Copied" : "Copy"}
      className={`grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-[color,background-color,transform] duration-150 hover:bg-white/5 hover:text-foreground active:scale-[0.97] ${className}`}
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      <span className="relative col-start-1 row-start-1 grid place-items-center">
        <HugeiconsIcon
          icon={Copy01Icon}
          size={16}
          className={`transition-[opacity,transform] duration-150 ${copied ? "scale-90 opacity-0" : "scale-100 opacity-100"}`}
        />
        <HugeiconsIcon
          icon={Tick02Icon}
          size={16}
          className={`absolute text-primary transition-[opacity,transform] duration-150 ${copied ? "scale-100 opacity-100" : "scale-90 opacity-0"}`}
        />
      </span>
    </button>
  );
}

/**
 * A shell command with a copy button, full width. The text wraps at spaces, and URLs
 * inside it only after a `/` (UrlText), so it never scrolls sideways and never clips.
 * A trailing "…/install.sh | sh" pipe stays one nowrap unit (a nbsp alone is not
 * enough: `overflow-wrap:anywhere` still breaks beside it), so "| sh" can never
 * orphan on its own line. One line keeps the old look: a 40px row with the text
 * vertically centred. `className` styles the command text.
 */
export function Command({ text, className = "" }: { text: string; className?: string }) {
  const tokens = text.split(" ");
  let head = text;
  let unit = "";
  if (tokens.length >= 3 && tokens[tokens.length - 2] === "|") {
    const url = tokens[tokens.length - 3];
    const slash = url.lastIndexOf("/");
    if (slash >= 0 && slash < url.length - 1) {
      unit = `${url.slice(slash + 1)} ${tokens[tokens.length - 2]} ${tokens[tokens.length - 1]}`;
      head = text.slice(0, -unit.length);
    }
  }
  return (
    // py-1 plus the code's my-1.5 lands a single line at exactly 40px with the text
    // centred; wrapped lines grow the box and leave the button aligned to the top.
    <div className="flex min-h-10 w-full max-w-full items-start gap-3 rounded-md bg-card py-1 pr-1 pl-4 font-mono text-[13px]">
      <code data-command className={`my-1.5 min-w-0 flex-1 leading-5 whitespace-normal [overflow-wrap:anywhere] ${className}`}>
        <span className="text-faint select-none">$ </span>
        {head.split(" ").map((token, i) => (
          <Fragment key={i}>
            {i > 0 ? " " : null}
            {/^https?:\/\//.test(token) ? <UrlText url={token} /> : token}
          </Fragment>
        ))}
        {unit ? (
          <>
            <wbr />
            <span className="whitespace-nowrap">{unit}</span>
          </>
        ) : null}
      </code>
      <CopyButton text={text} className="shrink-0" />
    </div>
  );
}

/** A button that copies the setup prompt for a coding agent (lib/prompt.ts, passed in from a server component). */
export function CopyPrompt({ prompt }: { prompt: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={secondaryButton}
      onClick={async () => {
        await navigator.clipboard.writeText(prompt);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
    >
      <HugeiconsIcon icon={copied ? Tick02Icon : AiChat02Icon} size={15} className={copied ? "text-primary" : ""} />
      {/* Both labels share one cell, so the button keeps its width when the label swaps. */}
      <span className="grid text-left" aria-live="polite">
        <span className={`col-start-1 row-start-1 ${copied ? "invisible" : ""}`}>{copy.agentPrompt.copy}</span>
        <span className={`col-start-1 row-start-1 ${copied ? "" : "invisible"}`}>{copy.agentPrompt.copied}</span>
      </span>
    </button>
  );
}
