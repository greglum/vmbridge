import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const config: NextConfig = {
  // The repository root holds the workspace lockfile.
  turbopack: { root: fileURLToPath(new URL("../..", import.meta.url)) },
  // next dev otherwise writes an AGENTS.md into the app.
  agentRules: false,
};

export default config;
