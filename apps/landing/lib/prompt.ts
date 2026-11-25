import { github, install } from "./data";
import { site } from "./site";

/**
 * The prompt the "Copy prompt for your agent" buttons copy: it has a coding agent install VM Bridge, set it up and open
 * the dashboard, asking the user first. Agents run commands without a terminal, so `vmbridge password` and the setup
 * link (both terminal only, see apps/cli/src/index.ts) can't work for them. The password comes from VMBRIDGE_PASSWORD
 * instead, which `vmbridge` and `vmbridge service install` save on a first install. Server only, like site.ts.
 */
export const agentPrompt = `Help me install VM Bridge on this computer and get it running. VM Bridge is a free, open source server that runs T3 Code agents on cloud VMs. Docs: ${site.url}/docs. Source: ${github}.

1. Check that this is macOS or Linux. VM Bridge does not run on Windows, so if it is Windows, tell me and stop.
2. Tell me in a few lines what you will do (download one file to ~/.local/bin, start it, open its dashboard in my browser) and ask if I want to go ahead. Stop if I say no.
3. Ask me these questions together, in one message:
   - What should the dashboard password be? It needs at least 8 characters. If I would rather not type it here, I can run \`vmbridge password\` in my own terminal once it is installed.
   - Should VM Bridge run in the background and start again at login (recommended), or only for now?
   If ~/.vmbridge already exists, VM Bridge was set up here before, so ask if it already has a password instead. If it does, leave it alone.
4. Install it:
   ${install}
   If ~/.local/bin is not on my PATH, use ~/.local/bin/vmbridge in the commands below, and ask before you change my shell profile.
   If I chose to set the password myself, wait for me to say it is done.
5. Start it. Pass the password only in the command's environment: never write it to a file or repeat it back to me.
   - In the background: VMBRIDGE_PASSWORD='<password>' vmbridge service install
   - Only for now: VMBRIDGE_PASSWORD='<password>' nohup vmbridge run > /tmp/vmbridge.log 2>&1 &
   Leave out VMBRIDGE_PASSWORD if the password is already set.
6. Wait up to 30 seconds for http://127.0.0.1:3774/dashboard to answer. If it doesn't, show me the end of the log and stop. The background service logs to ~/.vmbridge/vmbridge.log on macOS and to \`journalctl --user -u vmbridge\` on Linux. The other way logs to /tmp/vmbridge.log.
7. Open http://127.0.0.1:3774/dashboard in my browser, with \`open\` on macOS or \`xdg-open\` on Linux.

Then tell me:
- The dashboard address, and that I log in with my password.
- If the output says saved keys are encrypted with a new key, where that key is, and that I should back it up.
- What to do next in the dashboard: add a cloud provider and its API key, and sign in Codex, Claude Code or OpenCode. Then under Settings, Devices, create a pairing link and paste it into T3 Code as a remote environment.
- How to stop it (\`vmbridge stop\`) and update it (\`vmbridge update\`).`;
