import { faq } from "@/lib/data";
import { FaqItem } from "./FaqItem";

/** Plain text with `backticks` shown as code. */
function Text({ text }: { text: string }) {
  return text.split("`").map((part, i) =>
    i % 2 ? (
      <code key={i} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em] text-foreground">
        {part}
      </code>
    ) : (
      part
    ),
  );
}

export function Faq() {
  return (
    <section id="faq" className="mx-auto grid max-w-6xl scroll-mt-20 gap-10 px-4 py-24 sm:px-6 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] md:gap-12">
      <h2 className="self-start text-3xl font-semibold tracking-tight sm:text-4xl md:sticky md:top-24">Questions</h2>
      <div>
        {faq.map(({ question, answer }, i) => (
          <FaqItem key={question} number={i + 1} question={question} defaultOpen={i === 0}>
            <Text text={answer} />
          </FaqItem>
        ))}
      </div>
    </section>
  );
}
