import "@fontsource-variable/mona-sans";
import "@fontsource/fragment-mono";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles.css";

createRoot(document.getElementById("root")!).render(<App />);
