import type { Projection, Row, Wire } from "./types.ts";

/**
 * What a thread's shell row says about its content. A copy saved while the row read the same is still current, so a
 * VM going to sleep only fetches threads whose stamp moved. Visits and other changes that leave these alone do not
 * count.
 */
export function threadStamp(row: Row): string {
  return JSON.stringify([row.updatedAt, row.itemCount, row.visibleItemCount, row.latestRunId, row.status, row.title, row.archivedAt]);
}

/** The thread's latest item ordinal, as T3's `computeLatestLocalTurnOrdinal` reports it with a snapshot. */
export function latestOrdinal(projection: Projection): number | null {
  const ordinals = (projection.turnItems ?? []).map((item) => item.ordinal ?? 0);
  return ordinals.length ? Math.max(...ordinals) : null;
}

/** T3's history cursor (t3code apps/server/src/orchestration-v2/threadHistoryPaging.ts): base64url JSON. */
interface Cursor {
  v: 1;
  seq: number;
  /** The source thread and item of the row the page ends at. */
  st: string;
  si: string;
  /** That row's position, or for an inclusive (deferred work) cursor its item ordinal. */
  p: number;
  inclusive?: boolean;
}

function decodeCursor(cursor: string): Cursor | null {
  try {
    const binary = atob(cursor.replace(/-/g, "+").replace(/_/g, "/"));
    const value = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)))) as Partial<Cursor>;
    if (value.v !== 1 || typeof value.st !== "string" || typeof value.si !== "string" || typeof value.p !== "number") return null;
    return value as Cursor;
  } catch {
    return null;
  }
}

const encoder = new TextEncoder();

function encodeCursor(cursor: Cursor): string {
  const bytes = encoder.encode(JSON.stringify(cursor));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

type HistoryRow = Wire & { position?: number; sourceThreadId?: string; sourceItemId?: string; item?: Wire };

/** Where a cursor's page ends in `rows`, as T3's `findCursorEndIndex` finds it. */
function cursorEnd(rows: HistoryRow[], cursor: Cursor): number {
  const exact = rows.findIndex((row) => row.sourceThreadId === cursor.st && row.sourceItemId === cursor.si);
  if (exact !== -1) return exact + (cursor.inclusive ? 1 : 0);
  const byPosition = rows.findIndex((row) =>
    cursor.inclusive ? row.sourceThreadId === cursor.st && Number(row.item?.ordinal ?? row.position) > cursor.p : (row.position ?? 0) >= cursor.p,
  );
  return byPosition === -1 ? rows.length : byPosition;
}

/** T3's older-page limits: a page stops at either, but always holds at least one row. */
const pageRows = 500;
const pageBytes = 1_048_576;

const workTypes = new Set(["command_execution", "reasoning", "file_change", "file_search", "web_search", "dynamic_tool"]);

/**
 * A `GET /api/orchestration/threads/:threadId/history` page from a saved projection, for a sleeping VM. The cursor came
 * from the VM while it was awake (a bounded snapshot, an earlier page or a folded work group), so it is T3's own and
 * names a row of the saved history. Returns null for a cursor that is not one.
 */
export function historyPage(projection: Projection, query: URLSearchParams, snapshotSequence: number) {
  const cursor = decodeCursor(query.get("cursor") ?? "");
  if (!cursor) return null;
  const rows = (projection.visibleTurnItems ?? []) as HistoryRow[];
  const end = cursorEnd(rows, cursor);
  const through = query.get("throughEntryId");

  // The rows of one folded work group, from its first row (`throughEntryId`) through the cursor's.
  if (query.get("view") === "work") {
    const start = rows.findIndex((row) => row.sourceItemId === through);
    if (start < 0 || start >= end) return null;
    const anchor = rows[start]!;
    const items = rows
      .slice(start, end)
      .filter(
        (row) =>
          row.sourceThreadId === anchor.sourceThreadId &&
          row.item?.runId === anchor.item?.runId &&
          row.item?.attemptId === anchor.item?.attemptId &&
          row.item?.status === "completed" &&
          workTypes.has(String(row.item?.type)),
      );
    return { snapshotSequence, items: items.map((row, position) => ({ ...row, position })), nextCursor: null, hasMoreHistory: false };
  }

  // A page reaching back to `throughEntryId`, as when a reply quotes an older message, holds it whatever the limits.
  const target = through ? rows.findIndex((row) => (row.item?.messageId ?? row.item?.id) === through) : -1;
  let start = end;
  let bytes = 0;
  while (start > 0) {
    const size = encoder.encode(JSON.stringify(rows[start - 1])).byteLength;
    const full = start < end && (end - start >= pageRows || bytes + size > pageBytes);
    if (full && !(target !== -1 && target < start)) break;
    bytes += size;
    start--;
  }
  const oldest = rows[start];
  const hasMoreHistory = start > 0;
  return {
    snapshotSequence,
    items: rows.slice(start, end).map((row, position) => ({ ...row, position })),
    nextCursor:
      hasMoreHistory && oldest
        ? encodeCursor({ v: 1, seq: snapshotSequence, st: String(oldest.sourceThreadId), si: String(oldest.sourceItemId), p: oldest.position ?? start })
        : null,
    hasMoreHistory,
  };
}
