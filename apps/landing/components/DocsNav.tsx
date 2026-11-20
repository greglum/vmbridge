"use client";

import { useEffect, useState } from "react";

export interface DocsSection {
  id: string;
  title: string;
}

/** Sidebar links that follow the section being read. */
export function DocsNav({ sections }: { sections: DocsSection[] }) {
  const [current, setCurrent] = useState(sections[0].id);

  useEffect(() => {
    // The current section is the last one whose heading has passed the top quarter of the screen.
    let frame = 0;
    const update = () => {
      frame = 0;
      let id = sections[0].id;
      for (const section of sections) {
        const top = document.getElementById(section.id)?.getBoundingClientRect().top;
        if (top !== undefined && top < innerHeight * 0.25) id = section.id;
      }
      setCurrent(id);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    addEventListener("scroll", onScroll, { passive: true });
    return () => {
      removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
    };
  }, [sections]);

  return (
    <nav className="flex flex-col gap-0.5 text-sm" aria-label="On this page">
      {sections.map(({ id, title }) => (
        <a
          key={id}
          href={`#${id}`}
          className={`rounded-md border-l-2 py-1.5 pl-3 transition ${id === current ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
        >
          {title}
        </a>
      ))}
    </nav>
  );
}
