import { str, threadsOf, type Row, type Shell, type Wire } from "./types.ts";

/**
 * Commands that only change how T3 files a thread. VM Bridge answers these itself and shows the result at once,
 * then sends them to the thread's VM in the background: now when it is awake, at its next connect when it is not.
 * A sleeping VM is not woken for them.
 */
export const heldCommandTypes = new Set([
  "thread.settle",
  "thread.auto-settle",
  "thread.unsettle",
  "thread.snooze",
  "thread.unsnooze",
  "thread.pin",
  "thread.unpin",
  "thread.archive",
  "thread.unarchive",
]);

/**
 * Mirrors T3's own reducer for these commands on a cached shell (`dispatchThreadMutation` in T3's
 * `apps/server/src/orchestration-v2/Orchestrator.ts`). Re-applying a command gives the same result, since `at` is
 * when VM Bridge accepted it, so it can be laid over every VM update until the VM's shell shows it.
 */
export function applyHeldCommand(shell: Shell, command: Wire, at: string) {
  const id = str(command.threadId);
  const thread = threadsOf(shell).find((row) => row.id === id);
  if (!thread) return;
  const next = changed(thread, command, at);
  if (next === thread) return;
  shell.threads = (shell.threads ?? []).filter((row) => row.id !== id);
  shell.archivedThreads = (shell.archivedThreads ?? []).filter((row) => row.id !== id);
  const field = next.archivedAt ? "archivedThreads" : "threads";
  shell[field] = [...shell[field]!, next];
}

/** Commands T3 refuses for an archived thread. */
const refusedWhenArchived = new Set(["thread.settle", "thread.auto-settle", "thread.unsettle", "thread.snooze", "thread.unsnooze", "thread.pin", "thread.unpin"]);

/** T3 ends a pull request watch when a thread is settled or archived, and keeps what it watched as `endedWatch`. */
function withoutWatches(thread: Row) {
  if (!Array.isArray(thread.pullRequests)) return {};
  const pullRequests = (thread.pullRequests as Wire[]).map(({ watch, endedWatch, ...rest }) => {
    const ended = watch ?? endedWatch;
    return ended === undefined ? rest : { ...rest, endedWatch: ended };
  });
  return { pullRequests };
}

function changed(thread: Row, command: Wire, at: string): Row {
  // T3 rejects these, so the VM's state stays as it is.
  if (thread.archivedAt && refusedWhenArchived.has(String(command.type))) return thread;
  // T3 skips an automatic settle once the user chose a state or the thread moved on.
  if (
    command.type === "thread.auto-settle" &&
    (thread.settledOverride != null || Date.parse(String(thread.updatedAt)) > Date.parse(String(command.snapshotAt)))
  ) {
    return thread;
  }
  const limitRecovery = thread.limitRecovery as Wire | null | undefined;
  switch (command.type) {
    case "thread.settle":
    case "thread.auto-settle": {
      const already = thread.settledOverride === "settled" && thread.settledAt != null && thread.pinnedAt == null;
      const snoozed = thread.snoozedUntil != null || thread.snoozedAt != null;
      return {
        ...thread,
        settledOverride: "settled",
        settledAt: already ? thread.settledAt : (str(command.settledAt) ?? at),
        // Settled threads refuse recovery, so T3 disarms a pending resume.
        ...(limitRecovery && { limitRecovery: { ...limitRecovery, autoResume: false, snooze: false } }),
        ...withoutWatches(thread),
        unsettledAt: null,
        pinnedAt: null,
        pinOrderKey: null,
        activeOrderKey: null,
        snoozedUntil: null,
        snoozedAt: null,
        updatedAt: already && !snoozed ? thread.updatedAt : at,
      };
    }
    case "thread.unsettle": {
      const already = thread.settledOverride === "active";
      const restore = command.restoreUnsettledAt;
      return {
        ...thread,
        settledOverride: "active",
        settledAt: null,
        unsettledAt: already ? (thread.unsettledAt ?? null) : restore === undefined ? at : restore,
        updatedAt: already ? thread.updatedAt : at,
      };
    }
    case "thread.snooze": {
      const until = Date.parse(String(command.snoozedUntil));
      // T3 refuses a wake time that is not in the future.
      if (!(until > Date.parse(at))) return thread;
      return {
        ...thread,
        snoozedUntil: new Date(until).toISOString(),
        limitRecovery: limitRecovery ? { ...limitRecovery, snooze: false } : null,
        snoozedAt: at,
        updatedAt: at,
      };
    }
    case "thread.unsnooze": {
      const already = thread.snoozedUntil == null;
      return { ...thread, snoozedUntil: null, snoozedAt: null, updatedAt: already ? thread.updatedAt : at };
    }
    case "thread.pin": {
      const already = thread.pinnedAt != null;
      const settled = thread.settledOverride === "settled";
      const promotes = settled || thread.snoozedUntil != null;
      const orderKey = str(command.orderKey);
      return {
        ...thread,
        pinnedAt: already ? thread.pinnedAt : at,
        ...(!already && orderKey !== undefined && { pinOrderKey: orderKey }),
        settledOverride: settled ? "active" : thread.settledOverride,
        settledAt: settled ? null : thread.settledAt,
        ...(settled && { unsettledAt: at }),
        snoozedUntil: null,
        snoozedAt: null,
        updatedAt: already && !promotes ? thread.updatedAt : at,
      };
    }
    case "thread.unpin":
      return { ...thread, pinnedAt: null, pinOrderKey: null, updatedAt: thread.pinnedAt == null ? thread.updatedAt : at };
    case "thread.archive":
      return thread.archivedAt ? thread : { ...thread, archivedAt: at, titleRegeneration: null, ...withoutWatches(thread), updatedAt: at };
    case "thread.unarchive":
      return thread.archivedAt ? { ...thread, archivedAt: null, updatedAt: at } : thread;
    default:
      return thread;
  }
}
