import * as copy from "./copy";
import { dayLabel } from "./format";
import { dateIn } from "./model/time";
import type { RowModel } from "./view";

/**
 * Why I cannot record on this occurrence now, or null when I can (the server's own preconditions, `commands.rs` `record_entry`): not open
 * yet, closed without completing, covered by an earlier day, a closed `close_incomplete` window, or no part in it.
 */
export function recordBlock(
  row: RowModel,
  nowMs: number,
  zone: string,
  writable: boolean,
): string | null {
  const { data } = row;
  const now = Math.floor(nowMs / 1000);
  if (!writable) return copy.NOT_WRITABLE;
  if (data.opens_at !== null && data.opens_at > now)
    return copy.NOT_OPEN_UNTIL(dayLabel(dateIn(data.opens_at, zone)));
  if (data.resolved) return copy.RESOLVED_REASON;
  if (data.covered_by !== null) return copy.COVERED_REASON;
  if (
    data.definition.carry === "close_incomplete" &&
    data.closes_at !== null &&
    now >= data.closes_at
  )
    return copy.DAY_CLOSED;
  const canRecord =
    row.streamPresent ||
    row.streamPending ||
    (data.definition.participation === "anyone" && row.canEdit);
  return canRecord ? null : copy.ONLY_PARTICIPANTS;
}

/**
 * Whether a revision of this task may be offered (R29, revision 15): `revise_task` writes the task AND its details, and the server checks
 * write access to both, so a known denial of EITHER (`can_edit: false` as last read) withholds it. A policy version is not edit authority.
 * A task created on this device and not sent yet is its creator's (its projected rows say so). Nothing here is a fresh online check: the
 * server still decides when the change is sent.
 */
export function editable(
  task: { can_edit: boolean },
  execution: { can_edit: boolean } | null,
): boolean {
  return task.can_edit && execution?.can_edit !== false;
}
