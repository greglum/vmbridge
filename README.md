# VM Bridge

Run T3 Code agents on cloud VMs. You pair an unchanged T3 Code client with VM Bridge
once. After that, VM Bridge creates, wakes and sleeps VMs on your sandbox provider,
and sends each project and thread to the right one.

- One provider at a time: Boat, boxd, Instabox or Railway (through
  [`@opencoredev/sandbox-sdk`](https://www.npmjs.com/package/@opencoredev/sandbox-sdk)).
- One project per VM. A VM sleeps after it has been idle for a set time, and wakes when you send a message.
- Everything is set up from a web dashboard behind one secret key. That covers
  provider keys, GitHub, agent sign-ins and device pairing.
- Listens on `0.0.0.0`, so the dashboard and T3 clients work over your LAN and tailnet.

## Install

macOS and Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/vkpdeveloper/vmbridge/main/install.sh | sh
vmbridge               # asks for a dashboard key on first run
```

This puts one file, holding the server, the dashboard and the CLI, in `~/.local/bin`
(set `VMBRIDGE_INSTALL_DIR` to change it). Run it again to update.

From source, with Bun 1.4.4 or newer:

```sh
bun install
bun run build          # dist/vmbridge, one executable
./dist/vmbridge
```

Releases: push a `v*` tag and `.github/workflows/release.yml` builds and publishes the binaries.

## Run

```
vmbridge [run] [--host 0.0.0.0] [--port 3774]   Start in this terminal
vmbridge stop                                   Stop, including the background service
vmbridge service install [--host] [--port]      Run in the background at login (launchd or systemd)
vmbridge service uninstall                      Remove the background service
vmbridge key                                    Set a new dashboard key
```

Data lives in `~/.vmbridge` (`main.db`, owner-only). Set `VMBRIDGE_HOME` to move it. On a
machine with no terminal, set `VMBRIDGE_DASHBOARD_KEY` for the first start.

Once it is running, open `/dashboard` on any listed address. Choose a provider, connect GitHub and add agent
sign-ins. Then create a pairing link under Devices and paste it into T3 Code as a
remote environment.

## Develop

```sh
bun run dev        # server and dashboard, restarted on change
bun run check      # typecheck and tests
```

- `apps/server`: the T3 gateway, the fleet of VMs, providers and the admin API.
- `apps/web`: the dashboard.
- `apps/cli`: the `vmbridge` command.
- `apps/landing`: the website and docs (Next.js). Run it with `bun --filter @vmbridge/landing dev` on port 3100.
- `packages/contracts`: types shared by the server and the dashboard.

Provider support and what has been tested live: [docs/PROVIDERS.md](docs/PROVIDERS.md).
