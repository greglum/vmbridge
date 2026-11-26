import { describe, expect, test } from "bun:test";
import { openDatabase } from "../src/bun/sqlite.ts";
import { Budget, monthStart } from "../src/budget.ts";
import { Settings } from "../src/settings.ts";
import { Store } from "../src/store.ts";
import { Usage } from "../src/usage.ts";
import { testEncryption } from "./key.ts";

const hour = 3_600_000;
// A medium Boat VM costs $0.036 an hour awake and nothing asleep.
const hourly = 0.036;
const october = new Date(2026, 9, 1).getTime();
const november = new Date(2026, 10, 1).getTime();

/** One Boat VM, awake for `awakeHours` from the start of October and asleep after, with a budget of $1. */
function setup(awakeHours: number, budget: { monthlyUsd: number | null; stopAtLimit: boolean } = { monthlyUsd: 1, stopAtLimit: false }) {
  const db = openDatabase(":memory:");
  const store = new Store(db, testEncryption);
  const settings = new Settings(db);
  settings.set("budget", budget);
  const awake = new Set<string>();
  const usage = new Usage(store, () => awake);
  store.insertVm({ id: "a", provider: "boat", name: "vm-a", size: "medium", state: "ready", createdAt: october });
  awake.add("a");
  usage.sync(october);
  awake.delete("a");
  store.updateVm("a", { state: "sleeping" });
  usage.sync(october + awakeHours * hour);
  /** Wakes the VM at `from` for `hours`. */
  const awakeFor = (from: number, hours: number) => {
    awake.add("a");
    store.updateVm("a", { state: "ready" });
    usage.sync(from);
    awake.delete("a");
    store.updateVm("a", { state: "sleeping" });
    usage.sync(from + hours * hour);
  };
  return { settings, awakeFor, budget: new Budget(settings, usage) };
}

/** Hours awake that cost `share` of $1. */
const hoursFor = (share: number) => share / hourly;

describe("monthly budget", () => {
  test("warns from 80% and is over from 100%", () => {
    const at = october + 30 * 24 * hour;
    expect(setup(hoursFor(0.79)).budget.status(at).level).toBe("ok");
    expect(setup(hoursFor(0.81)).budget.status(at).level).toBe("warning");
    expect(setup(hoursFor(0.99)).budget.status(at).level).toBe("warning");
    expect(setup(hoursFor(1.01)).budget.status(at).level).toBe("over");
    expect(setup(hoursFor(2), { monthlyUsd: null, stopAtLimit: true }).budget.status(at).level).toBe("ok");
  });

  test("refuses new VMs and wakes at 100% only when the setting is on", () => {
    const at = october + 30 * 24 * hour;
    expect(setup(hoursFor(1.1)).budget.refusal(at)).toBeNull();
    expect(setup(hoursFor(0.9), { monthlyUsd: 1, stopAtLimit: true }).budget.refusal(at)).toBeNull();
    const refusal = setup(hoursFor(1.1), { monthlyUsd: 1, stopAtLimit: true }).budget.refusal(at);
    expect(refusal).toContain("budget of $1.00");
    expect(refusal).toContain("Usage page of the VM Bridge dashboard");
  });

  test("early wakes stop at 100% even with the setting off", () => {
    const at = october + 30 * 24 * hour;
    expect(setup(hoursFor(0.9)).budget.allowsEarlyWake(at)).toBe(true);
    expect(setup(hoursFor(1.1)).budget.allowsEarlyWake(at)).toBe(false);
  });

  test("a new month starts from nothing, and T3 gets one notice a month", () => {
    const { budget, awakeFor } = setup(hoursFor(1.5), { monthlyUsd: 1, stopAtLimit: true });
    const lateOctober = october + 30 * 24 * hour;
    expect(monthStart(lateOctober)).toBe(october);
    expect(budget.status(lateOctober).level).toBe("over");
    expect(budget.notice(lateOctober)).toContain("budget is used up");
    expect(budget.notice(lateOctober + hour)).toBeNull();

    // Seconds into November: October's spend no longer counts, so nothing is refused.
    expect(budget.status(november + 1000)).toMatchObject({ monthStart: november, level: "ok", spent: { amount: 0 } });
    expect(budget.refusal(november + 1000)).toBeNull();
    expect(budget.allowsEarlyWake(november + 1000)).toBe(true);
    expect(budget.notice(november + 1000)).toBeNull();

    // Past 80% again in November: a new notice.
    awakeFor(november + hour, hoursFor(0.86));
    const later = november + 2 * 24 * hour;
    expect(budget.status(later).level).toBe("warning");
    expect(budget.notice(later)).toBe("VM Bridge: 86% of this month's $1.00 budget is used.");
    expect(budget.notice(later + hour)).toBeNull();
  });

  test("enforcement, early wake, and notice each compute fresh spend within the 60s status cache window, and invalidate clears cached status", () => {
    const at = october + 30 * 24 * hour;
    const soon = at + 10_000;

    // Each method gets its own fixture so none can warm the cache for the next.
    const forRefusal = setup(hoursFor(0.99), { monthlyUsd: 1, stopAtLimit: true });
    expect(forRefusal.budget.status(at).level).toBe("warning");
    forRefusal.awakeFor(at - 2 * hour, hoursFor(0.05));
    expect(forRefusal.budget.refusal(soon)).toContain("budget of $1.00");

    const forEarlyWake = setup(hoursFor(0.99), { monthlyUsd: 1, stopAtLimit: false });
    expect(forEarlyWake.budget.status(at).level).toBe("warning");
    forEarlyWake.awakeFor(at - 2 * hour, hoursFor(0.05));
    expect(forEarlyWake.budget.allowsEarlyWake(soon)).toBe(false);

    const forNotice = setup(hoursFor(0.99), { monthlyUsd: 1, stopAtLimit: false });
    expect(forNotice.budget.status(at).level).toBe("warning");
    forNotice.awakeFor(at - 2 * hour, hoursFor(0.05));
    expect(forNotice.budget.notice(soon)).toContain("budget is used up");

    const forInvalidate = setup(hoursFor(0.99), { monthlyUsd: 1, stopAtLimit: false });
    expect(forInvalidate.budget.status(at).level).toBe("warning");
    forInvalidate.awakeFor(at - 2 * hour, hoursFor(0.05));
    forInvalidate.budget.invalidate();
    expect(forInvalidate.budget.status(soon).level).toBe("over");
  });
});
