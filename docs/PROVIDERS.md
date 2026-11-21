# Providers

VM Bridge runs every VM through `@opencoredev/sandbox-sdk` 1.2.0. You can add several providers and use them at once.

| | Boat | boxd | Daytona | Instabox | Railway |
|---|---|---|---|---|---|
| Sizes (small / medium / large) | 2/4 GB, 4/8 GB, 8/16 GB | 1/4 GB, 2/8 GB, 4/16 GB | 1/1 GB, 2/4 GB, 4/8 GB | 2/4 GB, 4/8 GB, 8/16 GB | 1/2 GB, 2/4 GB, 4/8 GB |
| Idle sleep | stop (disk kept) | pause (memory kept) | stop (disk kept) | pause (memory kept) | checkpoint, then destroy |
| Wake | resume | resume | start | resume | new VM from checkpoint (new sandbox ID) |
| Snapshot | no (SDK) | yes | yes (files only) | yes, and delete | checkpoint (files only) |
| T3 port reachable through | preview host, `_port_auth` cookie | public default proxy | private preview, `X-Daytona-Preview-Token` header | public published port | public domain declared at create |
| Agent sign-ins | VM Bridge | VM Bridge | VM Bridge | VM Bridge | VM Bridge |
| GitHub | VM Bridge | VM Bridge | VM Bridge | VM Bridge | VM Bridge |
| Provider safety net if VM Bridge is down | auto-stop 12 h after start, pushed back while agents work | auto-suspend after 60 min idle | auto-stop after 60 min without preview or toolbox traffic | auto-suspend after 30 min idle | none |
| Extra package | none | `@boxd-sh/sdk` | none | none | `railway` |

Public previews (boxd, Instabox, Railway) expose the T3 server port. The T3 server requires its own bearer session token on every route, and only VM Bridge holds it.

## Provider notes

- **Boat**: the SDK creates Boat VMs with `noEnv: true`, which drops the Boat environment. VM Bridge creates Boat VMs through Boat's API with the chosen environment and writes the SDK's name encoding so `connectSandbox` still attaches. Stop and resume use Boat's API, since the SDK has no pause for Boat. Agent and GitHub sign-ins a Boat environment passes in are cleared on the VM, like every provider's.
- **boxd**: reading a sleeping machine's labels wakes it, so the fleet listing uses the adapter's `listSleeping` and VM Bridge only connects when it means to wake.
- **Daytona**: VM Bridge uses container sandboxes from Daytona's built-in `daytona-small`, `daytona-medium` and `daytona-large` snapshots. Containers cannot pause (only Daytona VM sandboxes can, and the `daytona-vm-*` snapshots are not offered in this account's regions), so sleep is a stop: files stay, memory and processes go, and T3 cold-starts on wake. VM Bridge creates sandboxes through Daytona's API with the SDK's labels, because the SDK always sends `target: "us"` (refused for orgs without that region) and resizes non-default sizes with an extra stop, resize and start. Leaving the target out uses the org's default region, set in the Daytona dashboard. Start and delete answer 409 while a stop is still running, so wake and delete wait for it. Stopped sandboxes are archived after Daytona's default 7 days; starting an archived one restores its files from object storage first. Daytona secrets only swap API keys into outbound HTTPS headers, so agent sign-ins and GitHub come from VM Bridge.
- **Instabox**: the default template is `agent-browser`. Ports must be 1024 or higher (T3 uses 3773).
- **Railway**: no pause, and Railway's own idle timeout destroys the VM, so VM Bridge sets none. CPU and memory are fixed per client, so VM Bridge opens one client per size. Railway keeps checkpoints until they are deleted and the SDK has no delete, so VM Bridge deletes them with Railway's own SDK (`Sandbox.checkpoints` to find one by key, then `Sandbox.deleteCheckpoint`): after a wake from the checkpoint, and when a VM asleep as a checkpoint is deleted.

## Status

All five drivers are built and have passed a live run. On 2026-11-21, Boat, boxd, Instabox and Railway each ran `scripts/live.ts <provider> --agent` at medium size: create, clone, one short Codex turn, sleep, reads while asleep, a new message that wakes the VM, a second turn, the checkout still there, delete. Daytona was not set up for that round, so its results below are from its own earlier runs without an agent turn.

Verified live:

- Boat accepts `PATCH /sandboxes/{id}` with `ttlSeconds`, and it pushes back auto-stop. After `keepAlive`, Boat's `archiveAfter` (when the VM stops by itself) moved to 12 hours from the call. Boat's API reference says the same: the deadline becomes now plus `ttlSeconds`.
- Railway checkpoints keep the installed T3 runtime under `/workspace/.vmbridge`. After a wake from a checkpoint, the T3 package file still had its modification time from before the sleep, so setup found T3 installed and did not reinstall it.
- Railway checkpoints can be deleted. Over a sleep, wake, sleep, delete cycle, the environment's checkpoints went from 2 to 3, back to 2, to 3, and back to 2.

Still unverified:

- boxd and Instabox safety-net idle timers do not suspend a VM while an agent turn is running. This needs a turn of 30 to 60 minutes.

### Boat live results (2026-11-21, medium size, `base` environment)

`scripts/live.ts boat --agent`, one run. Everything listed under Status passed. `keepAlive` (the `ttlSeconds` PATCH) took 0.4 to 0.6 s.

| Step | Time |
|---|---|
| First VM ready (create, install, start T3) | 23.1 s |
| Clone and register project | 1.8 s |
| First agent turn | 8.6 s |
| Sleep (stop request) | 0.8 s |
| Wake on a new message (resume, prepare, until T3 took the message) | about 20.7 s |
| Second agent turn | 3.7 s |

| Latency (ms) | p50 | p95 |
|---|---|---|
| Bridge-local `server.getConfig` | 1.0 | 2.3 |
| Bridge-local `GET /api/orchestration/shell` | 0.2 | 0.2 |
| VM `filesystem.browse` | 189 | 192 |
| VM `vcs.refreshStatus` | 601 | 924 |
| VM `orchestration.getThreadProjection` | 196 | 198 |
| Asleep: `getThreadProjection` from VM Bridge's copy | 0.5 | 1.5 |

### boxd live results (2026-11-21, medium size)

`scripts/live.ts boxd --agent`, one run. Everything listed under Status passed.

| Step | Time |
|---|---|
| First VM ready (create, install, start T3) | 29.1 s |
| Clone and register project | 1.2 s |
| First agent turn | 8.7 s |
| Sleep (pause) | 0.3 s |
| Wake on a new message (resume, prepare, until T3 took the message) | about 8.5 s |
| Second agent turn | 2.8 s |

| Latency (ms) | p50 | p95 |
|---|---|---|
| Bridge-local `server.getConfig` | 1.1 | 4.2 |
| Bridge-local `GET /api/orchestration/shell` | 0.2 | 0.3 |
| VM `filesystem.browse` | 162 | 207 |
| VM `vcs.refreshStatus` | 827 | 1221 |
| VM `orchestration.getThreadProjection` | 176 | 184 |
| Asleep: `getThreadProjection` from VM Bridge's copy | 0.5 | 3.3 |

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

### Instabox live results (2026-11-21, medium size)

`scripts/live.ts instabox --agent`, one run. Everything listed under Status passed.

| Step | Time |
|---|---|
| First VM ready (create, install, start T3) | 21.1 s |
| Clone and register project | 1.3 s |
| First agent turn | 9.0 s |
| Sleep (pause) | 0.7 s |
| Wake on a new message (resume, prepare, until T3 took the message) | about 39.8 s |
| Second agent turn | 8.6 s |

| Latency (ms) | p50 | p95 |
|---|---|---|
| Bridge-local `server.getConfig` | 1.3 | 3.7 |
| Bridge-local `GET /api/orchestration/shell` | 0.2 | 0.2 |
| VM `filesystem.browse` | 229 | 232 |
| VM `vcs.refreshStatus` | 660 | 880 |
| VM `orchestration.getThreadProjection` | 238 | 244 |
| Asleep: `getThreadProjection` from VM Bridge's copy | 0.4 | 0.7 |

### Railway live results (2026-11-21, medium size)

`scripts/live.ts railway --agent`, one run, then two sleep, wake, sleep and delete cycles through the dashboard API. Everything listed under Status passed, and every checkpoint those runs made was deleted. In a third cycle the first wake of a new VM failed about 74 s after create. Its error was not captured and it did not happen again in the next two cycles. The failed wake put the VM back to sleep as a checkpoint, and the next wake restored it.

| Step | Time |
|---|---|
| First VM ready (create, install, start T3) | 56 to 80 s (65.2 s in the agent run) |
| Clone and register project | 2.5 s |
| First agent turn | 11.9 s |
| Sleep (checkpoint, then destroy) | 7 to 8.8 s |
| Wake (new VM from the checkpoint, prepare, cold-start T3) | 47 to 65 s (47.4 s in the agent run) |
| Second agent turn | 6.0 s |

| Latency (ms) | p50 | p95 |
|---|---|---|
| Bridge-local `server.getConfig` | 1.3 | 4.4 |
| Bridge-local `GET /api/orchestration/shell` | 0.2 | 0.2 |
| VM `filesystem.browse` | 225 | 230 |
| VM `vcs.refreshStatus` | 1124 | 1688 |
| VM `orchestration.getThreadProjection` | 245 | 265 |
| Asleep: `getThreadProjection` from VM Bridge's copy | 0.5 | 2.1 |

An earlier Railway run (2026-11-21, small size, no agent turn) took 57.2 s to the first VM, 8.8 s to sleep and 45.1 s to wake.

## Not supported

Agent37 is a hosted agents API, not a VM, so it cannot run T3's server. VM Bridge does not support it.
