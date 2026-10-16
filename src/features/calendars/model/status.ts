import type { CacheRow, DraftRow, DraftStatus } from "../../../data";
import {
  CAUSE_UNCONFIGURED,
  CHECKING_CHANGES,
  COMPAT_PAUSED,
  HEALTH_WORDS,
  lastRefresh,
  lastSuccess,
  NEEDS_CONNECTION,
  NEEDS_DATABASE,
  NEEDS_DECISION,
  NOT_CREATED_REASON,
  NOT_REFRESHED_YET,
  OWNER_ONLY,
  PENDING_OFFLINE,
  PENDING_ONLINE,
  QUEUED,
  REFRESHING_REASON,
  REJECTED,
  SAVING,
  TURNED_OFF,
  TURNED_OFF_REASON,
  VIEW_ONLY_REASON,
  WAITING_CHANGES_FIRST,
  WAITING_CONNECTION_CHANGE,
  WAITING_LAST_CHANGE,
} from "../copy";
import { sourceValue } from "./commands";

/**
 * The ONE derivation of a calendar row's status lines and of what each of its actions may do (WEB-13a). Pure: the screen passes in
 * what it read, and every enablement and every disabled reason comes from here, so a table-driven test states the whole matrix.
 *
 * Health is shown as HISTORY ("Last success …", "Last refresh: …"), never as the result of a request the person just made.
 */
export type Compat =
  | "supported"
  | "unsupported"
  | "missing"
  | "unknown"
  | "unreachable";

export interface Enablement {
  enabled: boolean;
  /** Why it is unavailable (shown beside it); absent when enabled. */
  reason?: string;
}

const on: Enablement = { enabled: true };
const off = (reason: string): Enablement => ({ enabled: false, reason });

type CountedDraft = Pick<DraftRow, "status" | "last_error" | "local_id"> &
  Partial<Pick<DraftRow, "kind">> & { command?: unknown };

/** The unsettled drafts against a source, as `useOutstanding` counts them. */
export interface OutstandingCounts {
  total: number;
  byStatus: Partial<Record<DraftStatus, number>>;
  latest: CountedDraft | null;
  /**
   * The newest settings change that still applies (`useOutstanding(id, "configure_source")`), whatever drafts of other kinds were saved
   * after it (revision 2). Present only when it was asked for; a reader that did not ask falls back to `latest`.
   */
  latestOfKind?: CountedDraft | null;
}

/** The settings change whose values the row shows: the newest that applies when it was read for, else the newest draft of any kind. */
export function settingsDraft(
  counts: OutstandingCounts | null,
): CountedDraft | null {
  if (counts === null) return null;
  return counts.latestOfKind !== undefined
    ? counts.latestOfKind
    : counts.latest;
}

/**
 * The row as the person last asked for it: the merged row with the NEWEST unsettled settings change's values (timezone, enabled)
 * over it. A queued change has no overlay until it is claimed, and the wireframe shows the submitted values marked "Queued — will
 * apply once synced" (or "Saving — will confirm on next sync" once receipted). A change that needs a decision is not shown as made.
 */
export function displayedRow<R extends Pick<CacheRow, "value" | "archived">>(
  merged: R,
  latest: OutstandingCounts["latest"],
): R {
  if (
    latest === null ||
    latest.kind !== "configure_source" ||
    !["queued", "in_flight", "acknowledged"].includes(latest.status)
  )
    return merged;
  const wrapped = (latest.command as { command?: unknown } | undefined)
    ?.command as Record<string, unknown> | undefined;
  if (
    typeof wrapped?.timezone !== "string" ||
    typeof wrapped.enabled !== "boolean"
  )
    return merged;
  return {
    ...merged,
    archived: !wrapped.enabled,
    value: { ...(merged.value ?? {}), timezone: wrapped.timezone },
  };
}

export type OutstandingState =
  | "decision"
  | "rejected"
  | "queued"
  | "saving"
  | null;

export function outstandingState(
  counts: OutstandingCounts | null,
): OutstandingState {
  if (counts === null || counts.total === 0) return null;
  const n = (status: DraftStatus) => counts.byStatus[status] ?? 0;
  if (n("version_conflict") + n("operation_conflict") > 0) return "decision";
  if (n("rejected") + n("blocked") > 0) return "rejected";
  if (n("queued") + n("in_flight") > 0) return "queued";
  if (n("acknowledged") > 0) return "saving";
  return null;
}

export interface Environment {
  online: boolean;
  compat: Compat;
  /** Whether the account's database (and so the outbox) exists on this device. */
  hasOutbox: boolean;
  /** `calendar_links` of `GET /notification-capabilities`, or null when unknown. */
  calendarLinks: boolean | null;
}

/** What a direct (online-only) request needs, in order. */
function direct(env: Environment): Enablement | null {
  if (!env.online) return off(NEEDS_CONNECTION);
  if (env.compat === "unsupported" || env.compat === "missing")
    return off(COMPAT_PAUSED);
  if (env.compat !== "supported") return off(NEEDS_CONNECTION);
  return null;
}

/** The header's two entry points. */
export function headerActions(env: Environment): {
  add: Enablement;
  link: Enablement;
} {
  const link =
    direct(env) ?? (env.calendarLinks === false ? off(CAUSE_UNCONFIGURED) : on);
  return { add: env.hasOutbox ? on : off(NEEDS_DATABASE), link };
}

export interface SourceStatus {
  /** The status lines under the label, in order. */
  lines: string[];
  turnedOff: boolean;
  outstanding: OutstandingState;
  refresh: Enablement;
  manage: Enablement;
}

const two = (n: number) => String(n).padStart(2, "0");
/** "2026-09-22 07:00" in the page's own time zone (the wireframe's form). */
export function formatInstant(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

function healthLine(row: Pick<CacheRow, "value">): string {
  const value = sourceValue(row.value);
  const zone = value.timezone === null ? "" : ` · ${value.timezone}`;
  if (value.health === "healthy" && value.lastSuccess !== null)
    return `${lastSuccess(formatInstant(value.lastSuccess))}${zone}`;
  if (value.health === null || value.health === "pending")
    return `${NOT_REFRESHED_YET}${zone}`;
  return `${lastRefresh(HEALTH_WORDS[value.health] ?? value.health)}${zone}`;
}

function outstandingLine(
  state: OutstandingState,
  counts: OutstandingCounts | null,
): string | null {
  switch (state) {
    case "decision":
      return NEEDS_DECISION;
    case "rejected":
      return counts?.latest?.status === "rejected" &&
        counts.latest.last_error?.status === 403
        ? OWNER_ONLY
        : REJECTED;
    case "queued":
      return QUEUED;
    case "saving":
      return SAVING;
    default:
      return null;
  }
}

/** A cached source (its merged row). */
export function sourceStatus(input: {
  merged: Pick<CacheRow, "value" | "archived" | "can_edit">;
  outstanding: OutstandingCounts | null;
  env: Environment;
  /** A refresh of this source is running now. */
  refreshing: boolean;
}): SourceStatus {
  const { env } = input;
  const merged = displayedRow(input.merged, settingsDraft(input.outstanding));
  const state = outstandingState(input.outstanding);
  const lines = [healthLine(merged)];
  if (merged.archived) lines.push(TURNED_OFF);
  const extra = outstandingLine(state, input.outstanding);
  if (extra !== null) lines.push(extra);
  let refresh: Enablement;
  if (!merged.can_edit) refresh = off(VIEW_ONLY_REASON);
  else
    refresh =
      direct(env) ??
      (merged.archived
        ? off(TURNED_OFF_REASON)
        : input.refreshing
          ? off(REFRESHING_REASON)
          : on);
  return {
    lines,
    turnedOff: merged.archived,
    outstanding: state,
    refresh,
    manage: merged.can_edit ? on : off(VIEW_ONLY_REASON),
  };
}

/** A create this device saved that the cache does not hold yet. */
export function pendingStatus(input: {
  draft: Pick<DraftRow, "status" | "last_error" | "held_pending_cache">;
  env: Environment;
}): SourceStatus {
  const { draft, env } = input;
  let line: string;
  let state: OutstandingState;
  switch (draft.status) {
    case "version_conflict":
    case "operation_conflict":
      line = NEEDS_DECISION;
      state = "decision";
      break;
    case "rejected":
    case "blocked":
      line = draft.last_error?.status === 403 ? OWNER_ONLY : REJECTED;
      state = "rejected";
      break;
    case "acknowledged":
      line = SAVING;
      state = "saving";
      break;
    default:
      line = env.online ? PENDING_ONLINE : PENDING_OFFLINE;
      state = "queued";
  }
  return {
    lines: [line],
    turnedOff: false,
    outstanding: state,
    refresh: off(NOT_CREATED_REASON),
    // Settings can be queued against a pending source: they wait for its create.
    manage: env.hasOutbox ? on : off(NEEDS_DATABASE),
  };
}

/**
 * Manage: the queued settings Save, and the online connection changes (D-13a-8). The SAME result disables the controls and is checked
 * again by every handler that would act (a click, the Enter key's implicit submission, a Retry), so no route acts on less.
 */
export function manageActions(input: {
  env: Environment;
  /** Whether the source exists on the server (cached), not only as this device's pending create. */
  cached: boolean;
  /**
   * The unsettled drafts against the source, or null while its current read has not answered (nothing is saved or sent until it has:
   * the values shown and the observation a save states come from that read).
   */
  outstandingTotal: number | null;
  awaitingSync: boolean;
  /** Whether the person may change the source NOW (`can_edit` of the current row; a pending create is this person's). Default true. */
  canEdit?: boolean;
  /** Whether a connection change of this dialog is being sent (its answer decides the version the next Save is built on). */
  connectionBusy?: boolean;
}): { save: Enablement; replace: Enablement; remove: Enablement } {
  const { env } = input;
  const canEdit = input.canEdit ?? true;
  // Save restates the values the person last asked for, which include the newest waiting change (`displayedRow`): it waits until the
  // waiting changes have been read, so a second change never reverts a first one that is still queued.
  const save = !env.hasOutbox
    ? off(NEEDS_DATABASE)
    : !canEdit
      ? off(VIEW_ONLY_REASON)
      : input.connectionBusy === true
        ? off(WAITING_CONNECTION_CHANGE)
        : input.awaitingSync
          ? off(WAITING_LAST_CHANGE)
          : input.outstandingTotal === null
            ? off(CHECKING_CHANGES)
            : on;
  const base: Enablement = !input.cached
    ? off(NOT_CREATED_REASON)
    : !canEdit
      ? off(VIEW_ONLY_REASON)
      : (direct(env) ??
        (input.outstandingTotal === null
          ? off(CHECKING_CHANGES)
          : input.outstandingTotal > 0
            ? off(WAITING_CHANGES_FIRST)
            : on));
  const replace =
    base.enabled && env.calendarLinks === false
      ? off(CAUSE_UNCONFIGURED)
      : base;
  return { save, replace, remove: base };
}
