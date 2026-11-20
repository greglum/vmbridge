"use client";

import Image from "next/image";
import { useRef, useState } from "react";
import { useReducedMotion } from "@/lib/hooks";

const shots = [
  { id: "canvas", label: "Canvas", src: "/shots/desktop-canvas.png", alt: "Dashboard canvas: a paired device, VM Bridge, one boxd VM online and one Boat VM asleep" },
  { id: "logs", label: "Logs", src: "/shots/desktop-logs.png", alt: "Dashboard logs: each request with where it went and how long it took" },
  { id: "setup", label: "Setup", src: "/shots/desktop-setup-provider.png", alt: "Dashboard setup: choosing a provider and entering its key" },
  { id: "devices", label: "Devices", src: "/shots/desktop-devices.png", alt: "Dashboard devices: pairing links and paired devices" },
];

/** Tilts toward the pointer. Pure CSS transform, set on pointer move only. */
function Tilt({ children, className = "", strength = 8 }: { children: React.ReactNode; className?: string; strength?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  return (
    <div className={`[perspective:1400px] ${className}`}>
      <div
        ref={ref}
        className="transition-transform duration-300 ease-out will-change-transform"
        style={{ transform: "none" }}
        onPointerMove={(event) => {
          if (reduced || event.pointerType !== "mouse" || !ref.current) return;
          const box = ref.current.getBoundingClientRect();
          const x = (event.clientX - box.left) / box.width - 0.5;
          const y = (event.clientY - box.top) / box.height - 0.5;
          ref.current.style.transform = `rotateX(${-y * strength}deg) rotateY(${x * strength}deg)`;
        }}
        onPointerLeave={() => {
          if (ref.current) ref.current.style.transform = "none";
        }}
      >
        {children}
      </div>
    </div>
  );
}

export function Screens() {
  const [active, setActive] = useState(shots[0].id);
  return (
    <section id="dashboard" className="relative scroll-mt-20 overflow-hidden py-24">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">See every device, VM and request</h2>

        <div className="mt-8 flex gap-1 overflow-x-auto rounded-lg border bg-card p-1 sm:inline-flex" role="tablist">
          {shots.map((shot) => (
            <button
              key={shot.id}
              type="button"
              role="tab"
              aria-selected={shot.id === active}
              onClick={() => setActive(shot.id)}
              className={`shrink-0 rounded-md px-3 py-1.5 text-sm transition ${shot.id === active ? "bg-muted" : "text-muted-foreground hover:text-foreground"}`}
            >
              {shot.label}
            </button>
          ))}
        </div>

        <div className="mt-8 grid grid-cols-1 items-start gap-8 lg:grid-cols-[1fr_auto]">
          <Tilt>
            <div className="relative aspect-[16/10] overflow-hidden rounded-xl border bg-black shadow-[0_40px_120px_-30px_rgba(139,92,246,0.45)]">
              {shots.map((shot) => (
                <Image
                  key={shot.id}
                  src={shot.src}
                  alt={shot.alt}
                  fill
                  sizes="(min-width: 1024px) 860px, 100vw"
                  className={`object-cover object-top transition-opacity duration-500 ${shot.id === active ? "opacity-100" : "opacity-0"}`}
                  priority={shot.id === "canvas"}
                />
              ))}
            </div>
          </Tilt>
          <div className="hidden gap-4 lg:flex lg:flex-col">
            {["/shots/phone-canvas.png", "/shots/phone-logs.png"].map((src, i) => (
              <Tilt key={src} strength={14}>
                <div className="relative h-[268px] w-[124px] overflow-hidden rounded-[22px] border-4 border-[#1c1c1f] bg-black">
                  <Image src={src} alt={i ? "Logs on a phone" : "Canvas on a phone"} fill sizes="124px" className="object-cover object-top" />
                </div>
              </Tilt>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
