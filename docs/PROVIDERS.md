# Providers

VM Bridge runs every VM through `@opencoredev/sandbox-sdk` 1.2.0. One provider is active at a time.

| | Boat | boxd | Daytona | Instabox | Railway |
|---|---|---|---|---|---|
| Sizes (small / medium / large) | 2/4 GB, 4/8 GB, 8/16 GB | 1/4 GB, 2/8 GB, 4/16 GB | 1/1 GB, 2/4 GB, 4/8 GB | 2/4 GB, 4/8 GB, 8/16 GB | 1/2 GB, 2/4 GB, 4/8 GB |
| Idle sleep | stop (disk kept) | pause (memory kept) | stop (disk kept) | pause (memory kept) | checkpoint, then destroy |
| Wake | resume | resume | start | resume | new VM from checkpoint (new sandbox ID) |
| Snapshot | no (SDK) | yes | yes (files only) | yes, and delete | checkpoint (files only) |
| T3 port reachable through | preview host, `_port_auth` cookie | public default proxy | private preview, `X-Daytona-Preview-Token` header | public published port | public domain declared at create |
| Agent sign-ins | VM Bridge | VM Bridge | VM Bridge | VM Bridge | VM Bridge |
| GitHub | VM Bridge | VM Bridge | VM Bridge | VM Bridge | VM Bridge |
| Provider safety net if VM Bridge is down | auto-stop 12 h after start | auto-suspend after 60 min idle | auto-stop after 60 min without preview or toolbox traffic | auto-suspend after 30 min idle | none |
| Extra package | none | `@boxd-sh/sdk` | none | none | `railway` |

Public previews (boxd, Instabox, Railway) expose the T3 server port. The T3 server requires its own bearer session token on every route, and only VM Bridge holds it.

## Provider notes

- **Boat**: the SDK creates Boat VMs with `noEnv: true`, which drops the Boat environment. VM Bridge creates Boat VMs through Boat's API with the chosen environment and writes the SDK's name encoding so `connectSandbox` still attaches. Stop and resume use Boat's API, since the SDK has no pause for Boat. Agent and GitHub sign-ins a Boat environment passes in are cleared on the VM, like every provider's.
- **boxd**: reading a sleeping machine's labels wakes it, so the fleet listing uses the adapter's `listSleeping` and VM Bridge only connects when it means to wake.
- **Daytona**: VM Bridge uses container sandboxes from Daytona's built-in `daytona-small`, `daytona-medium` and `daytona-large` snapshots. Containers cannot pause (only Daytona VM sandboxes can, and the `daytona-vm-*` snapshots are not offered in this account's regions), so sleep is a stop: files stay, memory and processes go, and T3 cold-starts on wake. VM Bridge creates sandboxes through Daytona's API with the SDK's labels, because the SDK always sends `target: "us"` (refused for orgs without that region) and resizes non-default sizes with an extra stop, resize and start. Leaving the target out uses the org's default region, set in the Daytona dashboard. Start and delete answer 409 while a stop is still running, so wake and delete wait for it. Stopped sandboxes are archived after Daytona's default 7 days; starting an archived one restores its files from object storage first. Daytona secrets only swap API keys into outbound HTTPS headers, so agent sign-ins and GitHub come from VM Bridge.
- **Instabox**: the default template is `agent-browser`. Ports must be 1024 or higher (T3 uses 3773).
- **Railway**: no pause, and Railway's own idle timeout destroys the VM, so VM Bridge sets none. CPU and memory are fixed per client, so VM Bridge opens one client per size. Old checkpoints are not deleted (the SDK has no delete for them).

## Status

Implemented: drivers for all four. Not yet tested against live accounts. The live results land here after validation.

Unverified assumptions to check live:

- Boat accepts `PATCH /sandboxes/{id}` with `ttlSeconds` to push back auto-stop.
- boxd and Instabox safety-net idle timers do not suspend a VM while an agent turn is running.
- Railway checkpoints keep the installed T3 runtime under `/workspace/.vmbridge`.

### Daytona live results (2026-11-21, `eu` region, medium size)

`scripts/live.ts daytona`, two runs, no agent turn. Create, clone, sleep, a read while asleep, wake, and the checkout survived.

| Step | Time |
|---|---|
| Daytona create (API until `started`) | 1.0 to 1.5 s |
| First VM ready (create, install, start T3) | 16 to 19 s |
| Clone and register project | 1.0 s |
| Sleep (stop request) | 0.3 s (Daytona finishes the stop about 2 s later) |
| Wake (start, prepare, cold-start T3) | 10 to 11 s, of which Daytona start is about 1.8 s |

| Latency (ms) | p50 | p95 |
|---|---|---|
| Bridge-local `server.getConfig` | 0.8 to 1.0 | 1.4 to 3.8 |
| Bridge-local `GET /api/orchestration/shell` | 0.1 | 0.2 to 0.3 |
| VM `filesystem.browse` | 156 to 158 | 160 to 161 |
| VM `vcs.refreshStatus` | 372 to 504 | 520 to 622 |
| Raw Daytona preview GET | 156 | 159 |
| Raw Daytona toolbox command | 203 | 218 |

### Railway live results (2026-11-21, small size)

`scripts/live.ts railway`, one run, no agent turn. Create, clone, sleep, a read while asleep, wake, and the checkout survived. All three sandboxes the run made (the first VM, the VM restored from the checkpoint, and the verify call) ended `DESTROYED`. The checkpoint stays, since the SDK cannot delete it.

| Step | Time |
|---|---|
| First VM ready (create, install, start T3) | 57.2 s |
| Clone and register project | 2.8 s |
| Sleep (checkpoint, then destroy) | 8.8 s |
| Wake (new VM from the checkpoint, prepare, cold-start T3) | 45.1 s |

| Latency (ms) | p50 | p95 |
|---|---|---|
| Bridge-local `server.getConfig` | 1.0 | 2.3 |
| Bridge-local `GET /api/orchestration/shell` | 0.2 | 0.8 |
| VM `filesystem.browse` | 211 | 225 |
| VM `vcs.refreshStatus` | 852 | 1201 |
