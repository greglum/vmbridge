import { describe, expect, test } from "bun:test";
import { pendingAgent, presentAgent } from "../src/gateway/agents.ts";

describe("presentAgent", () => {
  test("reports a waiting message instead of missing sign-in for a pending agent", () => {
    const report = presentAgent(pendingAgent("codex"), undefined, "VM Bridge");
    expect(report.enabled).toBe(true);
    expect(report.installed).toBe(false);
    expect(report.auth).toEqual({ status: "unknown" });
    expect(report.message).toBe("Waiting for a VM to report this agent.");
  });

  test("keeps the sign-in prompt for an installed unauthenticated agent and for real VM reports with unknown auth", () => {
    const installed = presentAgent(
      {
        instanceId: "codex",
        driver: "codex",
        enabled: true,
        installed: true,
        status: "warning",
        auth: { status: "unauthenticated" },
        models: [],
        version: "1.0.0",
      },
      undefined,
      "VM Bridge",
    );
    expect(installed.message).toBe("Add this agent's sign-in in the VM Bridge dashboard.");

    const vmReportedMinimal = presentAgent(
      {
        instanceId: "codex",
        driver: "codex",
        enabled: true,
        models: [{ slug: "gpt-5" }],
      },
      undefined,
      "VM Bridge",
    );
    expect(vmReportedMinimal.message).toBe("Add this agent's sign-in in the VM Bridge dashboard.");

    const vmReportedUninstalledUnknown = presentAgent(
      {
        instanceId: "codex",
        driver: "codex",
        enabled: true,
        installed: false,
        auth: { status: "unknown" },
      },
      undefined,
      "VM Bridge",
    );
    expect(vmReportedUninstalledUnknown.message).toBe("Add this agent's sign-in in the VM Bridge dashboard.");
  });

  test("respects disabled preference even for a pending agent", () => {
    const report = presentAgent(pendingAgent("claudeAgent"), { enabled: false }, "VM Bridge");
    expect(report.enabled).toBe(false);
    expect(report.message).toBe("Switched off for new sessions in VM Bridge.");
  });
});
