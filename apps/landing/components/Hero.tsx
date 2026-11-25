import { CloudUploadIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { copy } from "@/lib/copy";
import { deployToCloudflare } from "@/lib/data";
import { agentPrompt } from "@/lib/prompt";
import { cloudflareButton, innerPad, primaryButton } from "@/lib/styles";
import { CopyPrompt } from "./CopyButton";
import { Topology } from "./Topology";

/**
 * The landing header as one centred column (title, body, and the two ways to set
 * up: a prompt for your agent or a Cloudflare deploy) above a full-width stage
 * holding the flat wiring diagram (devices to VM Bridge to cloud VMs). The diagram is plain server-rendered markup that
 * fills every pixel left over so the hint row lands on the fold, so nothing
 * moves while the page loads and it reads identically with JavaScript off.
 * The VM cards themselves are the sleep/wake controls.
 */
export function Hero() {
  return (
    <div className="flex min-h-[calc(100svh-3.5rem-2rem)] flex-col">
      <div className={`${innerPad} pt-12 text-center xl:pt-10`}>
        {/* Sized to hold the ~43-character title on one line from xl up; the max
            width below xl balances it into two or three lines. */}
        <h1
          className="mx-auto max-w-[28rem] text-[clamp(2.4rem,3.4vw,3.6rem)] leading-[1.04] font-medium tracking-[-0.035em] text-balance xl:max-w-none"
          style={{ animation: "rise 500ms both" }}
        >
          {copy.hero.title}
        </h1>
        <p
          className="mx-auto mt-4 max-w-[44rem] text-pretty text-[16px] text-muted-foreground sm:text-[18px]"
          style={{ animation: "rise 500ms 60ms both" }}
        >
          {copy.hero.body}
        </p>
        <div className="mt-7 flex flex-wrap items-center justify-center gap-2" style={{ animation: "rise 500ms 120ms both" }}>
          <CopyPrompt prompt={agentPrompt} className={primaryButton} />
          <a href={deployToCloudflare} target="_blank" rel="noopener noreferrer" className={cloudflareButton}>
            <HugeiconsIcon icon={CloudUploadIcon} size={15} />
            {copy.hero.cloudflare}
          </a>
        </div>
      </div>
      {/* The stage runs rail to rail: the diagram fills its width up to a 72rem
          cap and every pixel of height left over so the hint lands on the fold. */}
      <div className="mt-5 flex min-h-0 flex-1 flex-col">
        <div className="relative min-h-[280px] md:flex md:flex-1">
          <Topology hero log={false} />
        </div>
        <div className="flex justify-center px-6 py-4">
          <span className="text-[13px] whitespace-nowrap text-faint">{copy.hero.hint}</span>
        </div>
      </div>
    </div>
  );
}
