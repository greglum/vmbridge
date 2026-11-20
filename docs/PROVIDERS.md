# Providers

VM Bridge runs every VM through `@opencoredev/sandbox-sdk` 1.2.0. One provider is active at a time.

| | Boat | boxd | Instabox | Railway |
|---|---|---|---|---|
| Sizes (small / medium / large) | 2/4 GB, 4/8 GB, 8/16 GB | 1/4 GB, 2/8 GB, 4/16 GB | 2/4 GB, 4/8 GB, 8/16 GB | 1/2 GB, 2/4 GB, 4/8 GB |
| Idle sleep | stop (disk kept) | pause (memory kept) | pause (memory kept) | checkpoint, then destroy |
| Wake | resume | resume | resume | new VM from checkpoint (new sandbox ID) |
| Snapshot | no (SDK) | yes | yes, and delete | checkpoint (files only) |
| T3 port reachable through | preview host, `_port_auth` cookie | public default proxy | public published port | public domain declared at create |
| Agent sign-ins | Boat environment, or VM Bridge | VM Bridge | VM Bridge | VM Bridge |
| GitHub | Boat environment, or VM Bridge | VM Bridge | VM Bridge | VM Bridge |
| Provider safety net if VM Bridge is down | auto-stop 12 h after start | auto-suspend after 60 min idle | auto-suspend after 30 min idle | none |
| Extra package | none | `@boxd-sh/sdk` | none | `railway` |

Public previews (boxd, Instabox, Railway) expose the T3 server port. The T3 server requires its own bearer session token on every route, and only VM Bridge holds it.

## Provider notes

- **Boat**: the SDK creates Boat VMs with `noEnv: true`, which drops the Boat environment and its agent sign-ins. VM Bridge creates Boat VMs through Boat's API with the chosen environment and writes the SDK's name encoding so `connectSandbox` still attaches. Stop and resume use Boat's API, since the SDK has no pause for Boat.
- **boxd**: reading a sleeping machine's labels wakes it, so the fleet listing uses the adapter's `listSleeping` and VM Bridge only connects when it means to wake.
- **Instabox**: the default template is `agent-browser`. Ports must be 1024 or higher (T3 uses 3773).
- **Railway**: no pause, and Railway's own idle timeout destroys the VM, so VM Bridge sets none. CPU and memory are fixed per client, so VM Bridge opens one client per size. Old checkpoints are not deleted (the SDK has no delete for them).

## Status

Implemented: drivers for all four. Not yet tested against live accounts. The live results land here after validation.

Unverified assumptions to check live:

- Boat accepts `PATCH /sandboxes/{id}` with `ttlSeconds` to push back auto-stop.
- boxd and Instabox safety-net idle timers do not suspend a VM while an agent turn is running.
- Railway checkpoints keep the installed T3 runtime under `/workspace/.vmbridge`.
