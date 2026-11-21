import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { Metadata } from "next";
import Link from "next/link";
import { Footer, Nav } from "@/components/Chrome";
import { Command } from "@/components/CopyButton";
import { Faq } from "@/components/Faq";
import { Hero } from "@/components/Hero";
import { HowItWorks } from "@/components/HowItWorks";
import { Playground } from "@/components/Playground";
import { Providers } from "@/components/Providers";
import { Screens } from "@/components/Screens";
import { Terminal } from "@/components/Terminal";
import { faq, github, install } from "@/lib/data";
import { openGraph, site } from "@/lib/site";

export const metadata: Metadata = {
  alternates: { canonical: "/" },
  openGraph: { ...openGraph, url: "/", title: site.title, description: site.description },
};

const mit = "https://opensource.org/licenses/MIT";

// The app, its source code and the questions answered on this page, for search and answer engines.
const structuredData = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "SoftwareApplication",
      "@id": `${site.url}/#app`,
      name: site.name,
      description: site.description,
      url: site.url,
      applicationCategory: "DeveloperApplication",
      operatingSystem: "macOS, Linux",
      softwareVersion: site.version,
      license: mit,
      isAccessibleForFree: true,
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      downloadUrl: `${github}/releases/latest`,
      installUrl: `${site.url}/docs#install`,
      softwareHelp: { "@type": "WebPage", url: `${site.url}/docs` },
      sameAs: [github],
    },
    {
      "@type": "SoftwareSourceCode",
      "@id": `${site.url}/#source`,
      name: site.name,
      codeRepository: github,
      programmingLanguage: "TypeScript",
      license: mit,
      targetProduct: { "@id": `${site.url}/#app` },
    },
    {
      "@type": "FAQPage",
      "@id": `${site.url}/#faq`,
      mainEntity: faq.map(({ question, answer }) => ({
        "@type": "Question",
        name: question,
        acceptedAnswer: { "@type": "Answer", text: answer.replaceAll("`", "") },
      })),
    },
  ],
};

export default function Home() {
  return (
    <>
      <script
        type="application/ld+json"
        // Escapes < so the JSON can never close the script tag early.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData).replaceAll("<", "\\u003c") }}
      />
      <Nav />
      <main>
        <Hero />
        <HowItWorks />
        <Playground />
        <Screens />
        <Providers />
        <Terminal />
        <Faq />
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
