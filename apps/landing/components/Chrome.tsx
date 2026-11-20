import { GithubIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import Link from "next/link";
import { github } from "@/lib/data";
import { Logo } from "./brand";

export function Nav() {
  return (
    <header className="sticky top-0 z-40 border-b bg-black/70 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2.5 font-semibold">
          <Logo className="size-7" />
          VM Bridge
        </Link>
        <nav className="ml-auto flex items-center gap-1 text-sm text-muted-foreground sm:gap-2">
          <Link href="/#how" className="hidden rounded-md px-2.5 py-1.5 transition hover:text-foreground sm:block">
            How it works
          </Link>
          <Link href="/#providers" className="hidden rounded-md px-2.5 py-1.5 transition hover:text-foreground sm:block">
            Providers
          </Link>
          <Link href="/docs" className="rounded-md px-2.5 py-1.5 transition hover:text-foreground">
            Docs
          </Link>
          <a href={github} aria-label="GitHub" className="grid size-8 place-items-center rounded-md transition hover:text-foreground">
            <HugeiconsIcon icon={GithubIcon} size={18} />
          </a>
        </nav>
      </div>
    </header>
  );
}

export function Footer() {
  return (
    <footer className="border-t">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-4 px-4 py-8 text-sm text-muted-foreground sm:px-6">
        <Logo className="size-6" />
        <span>VM Bridge</span>
        <div className="ml-auto flex gap-5">
          <Link href="/docs" className="transition hover:text-foreground">
            Docs
          </Link>
          <a href={github} className="transition hover:text-foreground">
            GitHub
          </a>
        </div>
      </div>
    </footer>
  );
}
