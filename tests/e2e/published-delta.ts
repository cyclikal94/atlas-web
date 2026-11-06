import type { SyncStub } from "./data-sync-helpers";

/**
 * One delta page PUBLISHED on the fixture sync server (WEB-10c revision 9, R35; harness, labelled), as a server holds a change: answered
 * from the client's cursor, not handed out once.
 *
 * `stubNetwork`'s script gives each scripted answer to exactly one poll, whatever cursor it asks from. W1 commits a page only from the
 * cursor its poll left (CAS), so when two polls leave one cursor together and the other one's empty answer is committed first, a page handed
 * out once is lost (WebKit E-T20, revision 8 run 4: `cursor-7` → `cursor-8` committed, `cursor-7` → `cursor-r4-2` discarded, the leader
 * went on from `cursor-8` and never saw the correction). Published, the page is the answer to every poll asking from any cursor but its
 * own (each such cursor is a position before it), however many compete; the first poll from its own cursor (the writer has committed it)
 * ends the publication with the stub's ordinary empty page. Every answer is recorded, in order, in `served`.
 *
 * Only the answers to polls the stub has NOT been scripted to answer otherwise change: the publication waits its turn in the script, and
 * once it ends, later scripted answers follow as before.
 */
export function publishDelta(
  net: Pick<SyncStub, "script" | "requests">,
  revision: number,
  changes: unknown[],
): {
  readonly own: string;
  readonly served: ReadonlyArray<{ cursor: string | null; page: boolean }>;
  ended(): boolean;
} {
  const own = `cursor-r4-${revision}`;
  const body = JSON.stringify({
    phase: "delta",
    batches: [{ revision, changes }],
    next_cursor: own,
    has_more: false,
  });
  const served: Array<{ cursor: string | null; page: boolean }> = [];
  let ended = false;
  const answer = (url: URL) => {
    const cursor = url.searchParams.get("cursor");
    if (cursor === own) {
      ended = true;
      served.push({ cursor, page: false });
      // The stub's own empty page (as when its script is empty).
      return {
        status: 200,
        body: JSON.stringify({
          phase: "delta",
          batches: [],
          next_cursor: `cursor-${net.requests.length}`,
          has_more: false,
        }),
      };
    }
    served.push({ cursor, page: true });
    // Still published: the next poll is answered by it again.
    net.script.unshift(answer);
    return { status: 200, body };
  };
  net.script.push(answer);
  return { own, served, ended: () => ended };
}

/** Whether `rows` (one cache snapshot) hold progress `id` exactly at `version`, with `count` entries and `tail`'s ids in order. */
export function progressCommitted(
  rows: Array<Record<string, unknown>>,
  id: unknown,
  version: number,
  tail: Array<{ id: string }>,
  count: number,
): boolean {
  const row = rows.find((r) => r.id === id);
  const value = row?.value as
    | { entry_count?: unknown; recent_entries?: Array<{ id?: unknown }> }
    | null
    | undefined;
  return (
    row !== undefined &&
    row.version === version &&
    value?.entry_count === count &&
    JSON.stringify((value?.recent_entries ?? []).map((e) => e.id)) ===
      JSON.stringify(tail.map((e) => e.id))
  );
}
