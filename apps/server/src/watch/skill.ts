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

This machine's desktop can be watched live in any browser. VM Bridge keeps the link in \`${watchUrlPath}\`.

1. Run \`cat ${watchUrlPath}\`.
2. If the file is there, give the user the link as a clickable Markdown link, for example \`[Open the screen](<link>)\`, and tell them to open it. The page shows the screen as it changes; it is view-only. Do not open it with a browser on this machine: the user would not see it.
3. If the file is missing, tell the user the screen link is turned off in VM Bridge, and that they can turn it on in this VM's details in the VM Bridge dashboard.

The link lets anyone who has it watch the screen. Share it only with the user, and do not write it into files, commits or messages to anyone else.
`;

/**
 * A skill every VM with a screen gets, besides the installed ones. It is not in the skills list: it belongs with the
 * watch link, which VM Bridge manages on its own.
 */
const files: SkillFile[] = [{ path: "SKILL.md", data: Buffer.from(skillMd).toString("base64") }];
export const screenSkill = { name: "vmbridge-screen", files, hash: skillHash(files) };
