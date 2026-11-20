import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import Link from "next/link";
import { Footer, Nav } from "@/components/Chrome";
import { Command } from "@/components/CopyButton";
import { Hero } from "@/components/Hero";
import { HowItWorks } from "@/components/HowItWorks";
import { Playground } from "@/components/Playground";
import { Providers } from "@/components/Providers";
import { Screens } from "@/components/Screens";
import { Terminal } from "@/components/Terminal";
import { install } from "@/lib/data";


export default function Home() {
  return (
    <>
      <Nav />
      <main>
        <Hero />
        <HowItWorks />
        <Playground />
        <Screens />
        <Providers />
        <Terminal />
        <section className="relative overflow-hidden border-t">
          <div className="dots pointer-events-none absolute inset-0 [mask-image:radial-gradient(ellipse_at_center,black,transparent_70%)]" />
          <div className="relative mx-auto max-w-3xl px-4 py-24 text-center sm:px-6">
            <h2 className="text-3xl font-semibold tracking-tight text-balance sm:text-5xl">Install it in one line</h2>
            <div className="mx-auto mt-8 max-w-2xl">
              <Command text={install} />
            </div>
            <Link
              href="/docs"
              className="mt-6 inline-flex h-10 items-center gap-2 rounded-lg bg-white px-4 text-sm font-medium text-black transition hover:bg-white/85"
            >
              Read the docs
              <HugeiconsIcon icon={ArrowRight01Icon} size={16} />
            </Link>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
