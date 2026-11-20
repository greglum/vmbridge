import { useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";

type Tone = "default" | "primary" | "danger" | "ghost";

const tones: Record<Tone, string> = {
  default: "border-line bg-raised text-fg hover:border-line-strong hover:bg-hover",
  primary: "border-accent bg-accent text-white hover:bg-accent-strong",
  danger: "border-line bg-raised text-danger hover:border-danger/60",
  ghost: "border-transparent bg-transparent text-muted hover:bg-hover hover:text-fg",
};

export function Button({ tone = "default", className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: Tone }) {
  return (
    <button
      {...props}
      className={`inline-flex h-8 items-center justify-center gap-1.5 rounded-md border px-3 text-[13px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 ${tones[tone]} ${className}`}
    />
  );
}

export function Input({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`h-9 w-full rounded-md border border-line bg-sunken px-3 text-[13px] text-fg outline-none placeholder:text-faint focus:border-accent ${className}`}
    />
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[12px] font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="text-[12px] text-faint">{hint}</span>}
    </label>
  );
}

export function Card({ title, actions, children, className = "" }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-lg border border-line bg-panel ${className}`}>
      {(title || actions) && (
        <header className="flex min-h-11 items-center justify-between gap-3 border-b border-line px-4 py-2">
          <h2 className="text-[13px] font-semibold text-fg">{title}</h2>
          {actions}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

const badgeTones = {
  green: "bg-ok/12 text-ok",
  amber: "bg-warn/12 text-warn",
  red: "bg-danger/12 text-danger",
  violet: "bg-accent/15 text-accent-soft",
  gray: "bg-hover text-muted",
};

export function Badge({ tone = "gray", children }: { tone?: keyof typeof badgeTones; children: ReactNode }) {
  return <span className={`inline-flex h-5 items-center rounded px-1.5 text-[11px] font-medium ${badgeTones[tone]}`}>{children}</span>;
}

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      tone="ghost"
      className="h-7 px-2"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
      {copied ? "Copied" : label}
    </Button>
  );
}

export function ErrorText({ error }: { error: string | null }) {
  return error ? <p className="text-[12px] text-danger">{error}</p> : null;
}

/** Runs an async action with a busy flag and a readable error. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run, setError };
}
