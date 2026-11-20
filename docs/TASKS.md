# Tasks

Each task lands as its own commit.

- [x] 1. Monorepo scaffold: Bun workspaces, server, CLI, web, contracts.
- [x] 2. Server foundation: `~/.vmbridge/main.db`, settings and secrets, dashboard key login, network addresses (LAN, Tailscale, Tailscale HTTPS).
- [x] 3. Provider layer on `@opencoredev/sandbox-sdk`: Boat, boxd, Instabox, Railway. One active provider.
- [x] 4. VM runtime: install npm `t3` and agent CLIs, start the T3 server, expose it, connect.
- [x] 5. T3 gateway: named pairing links, client sessions, RPC routing, shell merge, sleeping transcripts, idle sleep, wake on send, clone flow.
- [ ] 6. Web dashboard: login, onboarding (provider, keys, environment, GitHub, agent credentials), pairing links, live canvas, VM details.
- [ ] 7. CLI: `vmbridge` run, stop, background service (launchd, systemd), single compiled binary.
- [ ] 8. Live validation per provider, feature parity report, T3 protocol findings.
