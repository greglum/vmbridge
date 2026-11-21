import { faq } from "@/lib/data";

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
    <section id="faq" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-24 sm:px-6">
      <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">Questions</h2>
      <div className="mt-10">
        {faq.map(({ question, answer }) => (
          <div key={question} className="grid gap-2 border-t py-6 last:border-b md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] md:gap-12">
            <h3 className="font-medium">{question}</h3>
            <p className="leading-7 text-pretty text-muted-foreground [overflow-wrap:anywhere]">
              <Text text={answer} />
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
