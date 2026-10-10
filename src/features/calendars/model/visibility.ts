import type {
  CacheRow,
  DraftWithCommand,
  GateState,
  Loadable,
  ResourceView,
} from "../../../data";

/**
 * What an open Manage may show of its source, and on what authority (WEB-13a; revision 2 replaces revision 1's `shownSource`). Pure:
 * the dialog passes in what it read. The row the dialog was OPENED with is context for its first moment only; from then on the
 * source's lifecycle decides, read in ONE transaction (`useResourceView`), so a create, its publication and its retirement are never
 * seen half-way.
 *
 *  - `cached`: the cache holds the source and the cache gate is open. The row is the merged cached row, and the dialog has now SEEN its
 *    source cached (`seenCached`, kept by the dialog, never unset): it is cache content from here on, whatever it was opened as. A
 *    pending source whose create is published is PROMOTED here, without closing, and its untouched fields follow the published values.
 *  - `pending`: the cache does not hold the source, the dialog has never seen it cached, and this device's create of it is still in the
 *    outbox (waiting, sent, receipted and not yet published, or refused). The row is that create as it stands NOW (an edit of the
 *    queued create shows), never the projection the dialog was opened with.
 *  - `resolving`: no current read yet (the first is loading), or the read of a source never seen cached failed or started again. The
 *    last row shown stands in, and NOTHING may be saved or sent until a read answers. A cached source is `resolving` only on its
 *    first read, under an open gate (the list showed it a moment earlier).
 *  - `gone`: a source seen cached whose cache is being brought up to date (the gate is closed: `refreshing`), or that the cache no
 *    longer holds, or whose read failed or started again (`removed` / `refreshing`); or a pending source whose create left the outbox
 *    without the cache holding it (discarded, superseded, or receipted and then not published to this account: `removed`). It never
 *    falls back to an earlier row.
 */
export type SourceAuthority =
  | { kind: "cached"; row: CacheRow; view: ResourceView }
  | { kind: "pending"; row: CacheRow; view: ResourceView }
  | { kind: "resolving"; row: CacheRow }
  | { kind: "gone"; reason: "refreshing" | "removed" };

export function sourceAuthority(input: {
  gate: GateState;
  view: Loadable<ResourceView>;
  /** The row shown last (at first, the row the dialog was opened with). */
  last: CacheRow;
  /** Whether the dialog has seen its source in the cache: it opened on a cached row, or a read since has shown it there. */
  seenCached: boolean;
  /** Whether a read of the view has answered since the dialog opened. */
  read: boolean;
  /** The row a create draft will become, or null when its body is not one. */
  project(create: DraftWithCommand): CacheRow | null;
}): SourceAuthority {
  const { gate, view, last, seenCached } = input;
  if (view.status === "ready") {
    const { base, merged, create } = view.value;
    if (base !== null && merged !== null)
      return gate === "open"
        ? { kind: "cached", row: merged, view: view.value }
        : { kind: "gone", reason: "refreshing" };
    if (seenCached) return { kind: "gone", reason: "removed" };
    const row = create === null ? null : input.project(create);
    return row === null
      ? { kind: "gone", reason: "removed" }
      : { kind: "pending", row, view: view.value };
  }
  if (!seenCached) return { kind: "resolving", row: last };
  if (gate !== "open") return { kind: "gone", reason: "refreshing" };
  if (view.status === "unavailable") return { kind: "gone", reason: "removed" };
  return input.read
    ? { kind: "gone", reason: "refreshing" }
    : { kind: "resolving", row: last };
}
