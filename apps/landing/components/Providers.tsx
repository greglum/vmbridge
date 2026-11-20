import { providers } from "@/lib/data";
import { ProviderLogo } from "./brand";

export function Providers() {
  return (
    <section id="providers" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-24 sm:px-6">
      <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">Bring the cloud you already pay for</h2>
      <div className="mt-10 grid grid-cols-2 gap-2 sm:grid-cols-5">
        {providers.map((p) => (
          <div key={p.id} className="flex items-center gap-3 rounded-xl border bg-card p-3">
            <ProviderLogo provider={p} className="size-9" />
            <span className="truncate text-sm font-medium">{p.name}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
