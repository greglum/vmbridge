import "@fontsource-variable/mona-sans";
import "@fontsource/fragment-mono";
import { NuqsAdapter } from "nuqs/adapters/react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { movedLink } from "./lib/moved-links.ts";
import "./styles.css";

// Before the first render, so each page reads its new view and tab from the start.
const moved = movedLink(location.search);
if (moved) history.replaceState(history.state, "", `${location.pathname}${moved}${location.hash}`);

createRoot(document.getElementById("root")!).render(
  <NuqsAdapter>
    <App />
  </NuqsAdapter>,
);
