import type { ReactNode } from "react";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface Tab<T extends string> {
  id: T;
  label: string;
  icon: IconSvgElement;
  /** Shows a small dot, for something that still needs doing. */
  attention?: boolean;
}

/** A settings-style page: a title, an optional list of sub-pages on the left, and the content. */
export function Page<T extends string>({
  title,
  actions,
  tabs,
  tab,
  onTab,
  children,
}: {
  title: string;
  /** Shown beside the title, for state that applies to every tab. */
  actions?: ReactNode;
  tabs?: Tab<T>[];
  tab?: T;
  onTab?: (tab: T) => void;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b px-5 py-6 sm:px-10 sm:py-8">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {actions}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-6 px-5 py-6 sm:px-10 sm:py-8 md:flex-row md:gap-12">
          {tabs && (
            <nav className="-mx-1 flex shrink-0 gap-1 overflow-x-auto md:mx-0 md:w-48 md:flex-col">
              {tabs.map((entry) => (
                <Button
                  key={entry.id}
                  variant="ghost"
                  size="lg"
                  onClick={() => onTab?.(entry.id)}
                  className={cn(
                    "relative h-10 shrink-0 justify-start gap-2 px-3 text-sm text-muted-foreground md:gap-3",
                    entry.id === tab && "bg-accent text-foreground hover:bg-accent",
                  )}
                >
                  <HugeiconsIcon icon={entry.icon} className={cn("size-5 max-md:hidden", entry.id === tab && "text-primary")} strokeWidth={1.75} />
                  {entry.label}
                  {entry.attention && <span className="size-1.5 rounded-full bg-warning" />}
                </Button>
              ))}
            </nav>
          )}
          <div className="flex min-w-0 max-w-2xl flex-1 flex-col gap-10">{children}</div>
        </div>
      </div>
    </div>
  );
}

export function Section({ title, icon, actions, children }: { title: string; icon?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-5">
      <div className="flex min-h-9 items-center justify-between gap-3">
        <h2 className="flex items-center gap-2.5 text-lg font-semibold tracking-tight">
          {icon}
          {title}
        </h2>
        {actions}
      </div>
      {children}
    </section>
  );
}
