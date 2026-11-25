import type { AgentKind, ProjectIcon as ProjectIconInfo, ProjectIconColor, ProviderId } from "@vmbridge/contracts";
import { cn } from "@/lib/utils";
import claude from "./assets/agents/claude.svg";
import codex from "./assets/agents/codex.svg";
import opencode from "./assets/agents/opencode.svg";
import boat from "./assets/providers/boat.svg";
import boxd from "./assets/providers/boxd.svg";
import daytona from "./assets/providers/daytona.png";
import e2b from "./assets/providers/e2b.png";
import freestyle from "./assets/providers/freestyle.png";
import instabox from "./assets/providers/instabox.svg";
import kubi from "./assets/providers/kubi.svg";
import railway from "./assets/providers/railway.svg";
import superserve from "./assets/providers/superserve.svg";

/** The VM Bridge mark: a bridge between your device and a VM. Same drawing as assets/logo.svg. */
export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn("size-7 shrink-0", className)} aria-label="VM Bridge">
      <rect width="32" height="32" rx="9" fill="#fff" />
      <g fill="none" stroke="#000" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M6 19Q16 3 26 19" />
        <path d="M4.5 19h23" />
        <path d="M11 13v6M16 11v8M21 13v6" />
        <path d="M9 19v5M23 19v5" />
      </g>
    </svg>
  );
}

/** Each provider's own mark, on the tile color its brand uses. */
const providerLogos: Record<string, { src: string; tile: string; inset: string }> = {
  boat: { src: boat, tile: "bg-white", inset: "p-[18%]" },
  boxd: { src: boxd, tile: "bg-black", inset: "p-[24%]" },
  instabox: { src: instabox, tile: "bg-black", inset: "" },
  kubi: { src: kubi, tile: "bg-black", inset: "p-[18%]" },
  railway: { src: railway, tile: "bg-[#13111c]", inset: "p-[20%]" },
  daytona: { src: daytona, tile: "bg-black", inset: "" },
  e2b: { src: e2b, tile: "bg-black", inset: "" },
  freestyle: { src: freestyle, tile: "bg-white", inset: "p-[18%]" },
  superserve: { src: superserve, tile: "bg-[#141414]", inset: "" },
};

export function ProviderLogo({ id, className }: { id: ProviderId | string; className?: string }) {
  const logo = providerLogos[id];
  return (
    <span className={cn("grid size-6 shrink-0 place-items-center overflow-hidden rounded-md ring-1 ring-white/10", logo?.tile ?? "bg-muted", className)}>
      {logo ? <img src={logo.src} alt="" className={cn("size-full object-contain", logo.inset)} draggable={false} /> : null}
    </span>
  );
}

/** Each agent's own mark: OpenAI for Codex, Anthropic's Claude mark, and OpenCode. */
const agentLogos: Record<AgentKind, { src: string; tile: string; inset: string }> = {
  codex: { src: codex, tile: "bg-black", inset: "p-[18%]" },
  claude: { src: claude, tile: "bg-[#262624]", inset: "p-[20%]" },
  opencode: { src: opencode, tile: "bg-black", inset: "" },
};

/** An agent's logo on its tile. `bare` drops the tile, for small logos beside text. */
export function AgentLogo({ agent, className, bare = false }: { agent: AgentKind; className?: string; bare?: boolean }) {
  const logo = agentLogos[agent];
  if (bare) return <img src={logo.src} alt="" className={cn("size-6 shrink-0 object-contain", className)} draggable={false} />;
  return (
    <span className={cn("grid size-6 shrink-0 place-items-center overflow-hidden rounded-md ring-1 ring-white/10", logo.tile, className)}>
      <img src={logo.src} alt="" className={cn("size-full object-contain", logo.inset)} draggable={false} />
    </span>
  );
}

// Whole class names, so Tailwind sees each one. The shades T3 uses on a dark background.
const projectColors: Record<ProjectIconColor, string> = {
  gray: "text-gray-400",
  red: "text-red-400",
  orange: "text-orange-400",
  amber: "text-amber-400",
  yellow: "text-yellow-400",
  lime: "text-lime-400",
  green: "text-green-400",
  emerald: "text-emerald-400",
  teal: "text-teal-400",
  cyan: "text-cyan-400",
  sky: "text-sky-400",
  blue: "text-blue-400",
  indigo: "text-indigo-400",
  violet: "text-violet-400",
  purple: "text-purple-400",
  fuchsia: "text-fuchsia-400",
  pink: "text-pink-400",
  rose: "text-rose-400",
};

/** A project's icon as T3 shows it: its repository's logo, an emoji, or letters on a tile of their color. */
export function ProjectIcon({ icon, className }: { icon: ProjectIconInfo; className?: string }) {
  const box = cn("inline-flex size-4 shrink-0 items-center justify-center", className);
  if (icon.kind === "image") return <img src={icon.url} alt="" className={cn(box, "rounded-[25%] object-contain")} />;
  if (icon.kind === "emoji") {
    return (
      <span aria-hidden="true" className={cn(box, "[container-type:size]")}>
        <span className="text-[80cqh] leading-none">{icon.emoji}</span>
      </span>
    );
  }
  return (
    <span aria-hidden="true" className={box}>
      <svg viewBox="0 0 16 16" className={cn("size-full rounded-[25%] font-mono select-none", projectColors[icon.color])} style={{ backgroundColor: "color-mix(in srgb, currentColor 14%, transparent)" }}>
        <text x="8" y="10.8" textAnchor="middle" fill="currentColor" fontSize="8.25" fontWeight="700" textLength={Array.from(icon.text).length === 1 ? 6 : 12} lengthAdjust="spacingAndGlyphs">
          {icon.text}
        </text>
      </svg>
    </span>
  );
}
