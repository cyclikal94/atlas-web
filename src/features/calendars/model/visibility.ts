import type {
  CacheRow,
  GateState,
  Loadable,
  MergedResource,
} from "../../../data";

/**
 * Whether an open Manage may still show its source, and as which row (WEB-13a). Pure: the dialog passes in what it read.
 *
 * A CACHED source is cache content, so it is shown only while the list could show it: the cache gate is open and the source's own
 * read holds it. When the cache is being brought up to date (invalid, unverified, a recovery under way: the gate is closed) the dialog
 * is `gone` for `refreshing`; when the read fails or no longer holds the source (it was removed, or access to it was), it is `gone`
 * for `removed`. Neither falls back to the row the dialog was opened with. Only while the source's FIRST read is still loading is the
 * row it was opened with used: the list showed it a moment ago under the same open gate. A read that starts again later (the account's
 * database was opened again) is `refreshing`: what was shown before cannot stand in for it.
 *
 * A PENDING source (this device's create, not cached yet) is not cache content (drafts are never behind the gate): it is shown from its
 * create, as the "Waiting to be created" group shows it.
 */
export type ShownSource =
  | { kind: "row"; row: CacheRow }
  | { kind: "gone"; reason: "refreshing" | "removed" };

export function shownSource(input: {
  dialog: { row: CacheRow; cached: boolean };
  gate: GateState;
  resource: Loadable<MergedResource>;
  /** Whether this dialog has had an answer of its source's read (ready or unavailable) since it opened. */
  read: boolean;
}): ShownSource {
  const { dialog, resource } = input;
  if (!dialog.cached) return { kind: "row", row: dialog.row };
  if (input.gate !== "open") return { kind: "gone", reason: "refreshing" };
  if (resource.status === "loading")
    return input.read
      ? { kind: "gone", reason: "refreshing" }
      : { kind: "row", row: dialog.row };
  if (
    resource.status !== "ready" ||
    resource.value.base === null ||
    resource.value.merged === null
  )
    return { kind: "gone", reason: "removed" };
  return { kind: "row", row: resource.value.merged };
}
