import type { SkillFile } from "@vmbridge/contracts";
import { skillHash } from "../vm/skills.ts";
import { root } from "../vm/runtime.ts";

/** Where a VM with a screen finds its watch link. Absent while the link is off. */
export const watchUrlPath = `${root}/watch-url`;

const skillMd = `---
name: vmbridge-screen
description: Shows the user this machine's screen live. Use when the user asks to see, open or watch the screen or desktop, such as "show me my screen", "I want to see the screen" or "open the screen".
---

# Show the screen

This machine's desktop can be watched live in a browser. VM Bridge keeps the link in \`${watchUrlPath}\`.

1. Run \`cat ${watchUrlPath}\`.
2. If the file is missing, tell the user the screen link is turned off in VM Bridge, and that they can turn it on in this VM's details in the VM Bridge dashboard. Stop there.
3. Open the link in the user's T3 Code browser panel with T3 Code's \`preview_open\` tool (from the \`t3-code\` server), passing the link as \`url\` and \`open: true\`. Do not use the \`browser\` or \`desktop\` tools for this: they drive this machine's own screen, which is what the user wants to watch.
4. Also give the user the link as a clickable Markdown link, for example \`[Open the screen](<link>)\`. If \`preview_open\` is not available, fails, or reports that the page did not load, say the link could not open in T3 Code and that they can open it themselves. The page shows the screen as it changes; it is view-only.

The link lets anyone who has it watch the screen. Share it only with the user, and do not write it into files, commits or messages to anyone else.
`;

/**
 * A skill every VM with a screen gets, besides the installed ones. It is not in the skills list: it belongs with the
 * watch link, which VM Bridge manages on its own.
 */
const files: SkillFile[] = [{ path: "SKILL.md", data: Buffer.from(skillMd).toString("base64") }];
export const screenSkill = { name: "vmbridge-screen", files, hash: skillHash(files) };
