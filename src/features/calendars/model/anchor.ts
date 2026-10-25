import type {
  CacheRow,
  EnqueueRequest,
  JsonObject,
  LocalId,
  Observation,
} from "../../../data";
import type { components } from "../../../lib/api-types";
import {
  A_DATE,
  AN_EVENT,
  ANNUALLY,
  atTime,
  CHOOSE_REFERENCE,
  DAYS_RANGE,
  daysWords,
  NEEDS_TIMED_EVENT,
  SECONDS_RANGE,
  secondsWords,
  TITLE_TOO_LONG,
  VALID_TIME,
  WHOLE_NUMBER,
} from "../copy-anchor";
import { CALENDAR_COMMANDS } from "./commands";

/**
 * Task anchors (WEB-13b §4.3): the anchor-configuration panel's editing state, its validation against the released server's rules
 * (`v0.29.0-rc.1`, `crates/core/src/calendars/anchors.rs` `Anchor::validate` and `set_task_anchor`), and the queued `set_anchor`.
 *
 *  - Weekdays: at most seven, each 1 (Monday) to 7 (Sunday); sorted and unique here.
 *  - Title contains: 1 to 100 BYTES; an empty one is omitted. Event series only (the panel hides it for a person date and keeps what was
 *    typed; it is never sent for one: PRODUCT-DECISIONS-20261011, hidden values omitted on save without a loss warning).
 *  - Calendar-day offset: whole days −366 to 366; the optional time is typed `HH:MM` and sent `HH:MM:SS`.
 *  - Elapsed seconds: whole seconds ±31,622,400, and only for a TIMED event series (an all-day event or a person date fails at
 *    reconcile, so the whole command answers `422`).
 *  - Person date: a field whose value has no year must repeat annually (`annual: false` needs a year).
 *  - The task must not repeat on its own schedule (`422`); the panel says so and does not offer Save.
 */
export type CalendarAnchor = components["schemas"]["CalendarAnchor"];

/** What the pickers know of the reference chosen: whether an event is timed, whether a date field has a year. */
export interface PickedEvent {
  sourceId: string;
  uid: string;
  timed: boolean;
}
export interface PickedField {
  fieldId: string;
  hasYear: boolean;
}

/** The panel's editing state: EVERY field is kept, applicable or not, so a field that is hidden and shown again has its value back. */
export interface AnchorDraft {
  reference: "event_series" | "person_date";
  event: PickedEvent | null;
  field: PickedField | null;
  annual: boolean;
  offset: "calendar_days" | "elapsed_seconds";
  days: string;
  /** `HH:MM`, or empty for none. */
  time: string;
  seconds: string;
  weekdays: number[];
  titleContains: string;
}

export type AnchorErrors = Partial<
  Record<"reference" | "days" | "time" | "seconds" | "titleContains", string>
>;

export const EMPTY_ANCHOR: AnchorDraft = {
  reference: "event_series",
  event: null,
  field: null,
  annual: true,
  offset: "calendar_days",
  days: "0",
  time: "",
  seconds: "0",
  weekdays: [],
  titleContains: "",
};

const WHOLE = /^[+-]?\d+$/;
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;
const LIMITS = { days: 366, seconds: 31_622_400, titleBytes: 100 } as const;

/** Whether the seconds offset can be chosen: only for a timed event series. */
export const secondsAllowed = (draft: AnchorDraft): boolean =>
  draft.reference === "event_series" && draft.event?.timed === true;

/** Whether "repeats annually" can be changed: a date field without a year always repeats. */
export const annualForced = (draft: AnchorDraft): boolean =>
  draft.reference === "person_date" && draft.field?.hasYear === false;

const whole = (text: string): number | null => {
  const trimmed = text.trim().replace(/^−/, "-");
  return WHOLE.test(trimmed) ? Number(trimmed) : null;
};

/**
 * The anchor to save, from the APPLICABLE fields only, or the field messages (the wireframe's, inline under each field; the typed text is
 * kept by the caller). Only a timed event series may use seconds: any other reference with seconds chosen is the seconds field's error.
 */
export function validateAnchor(
  draft: AnchorDraft,
): { anchor: CalendarAnchor } | { errors: AnchorErrors } {
  const errors: AnchorErrors = {};
  const eventSeries = draft.reference === "event_series";
  if (eventSeries ? draft.event === null : draft.field === null)
    errors.reference = CHOOSE_REFERENCE;
  let offset: CalendarAnchor["offset"] | null = null;
  if (draft.offset === "elapsed_seconds") {
    const seconds = whole(draft.seconds);
    if (!secondsAllowed(draft)) errors.seconds = NEEDS_TIMED_EVENT;
    else if (seconds === null) errors.seconds = WHOLE_NUMBER;
    else if (Math.abs(seconds) > LIMITS.seconds) errors.seconds = SECONDS_RANGE;
    else offset = { kind: "elapsed_seconds", seconds };
  } else {
    const days = whole(draft.days);
    const time = draft.time.trim();
    if (days === null) errors.days = WHOLE_NUMBER;
    else if (Math.abs(days) > LIMITS.days) errors.days = DAYS_RANGE;
    if (time !== "" && !CLOCK.test(time)) errors.time = VALID_TIME;
    if (days !== null && errors.days === undefined && errors.time === undefined)
      offset =
        time === ""
          ? { kind: "calendar_days", days }
          : { kind: "calendar_days", days, time: `${time}:00` };
  }
  const title = draft.titleContains;
  const sendTitle = eventSeries && title.trim() !== "";
  if (sendTitle && new TextEncoder().encode(title).length > LIMITS.titleBytes)
    errors.titleContains = TITLE_TOO_LONG;
  if (Object.keys(errors).length > 0 || offset === null) return { errors };
  const reference: CalendarAnchor["reference"] = eventSeries
    ? {
        kind: "event_series",
        source_id: (draft.event as PickedEvent).sourceId,
        uid: (draft.event as PickedEvent).uid,
      }
    : {
        kind: "person_date",
        field_id: (draft.field as PickedField).fieldId,
        annual: annualForced(draft) ? true : draft.annual,
      };
  const weekdays = [...new Set(draft.weekdays)]
    .filter((day) => Number.isInteger(day) && day >= 1 && day <= 7)
    .sort((a, b) => a - b);
  return {
    anchor: {
      reference,
      offset,
      weekdays,
      ...(sendTitle ? { title_contains: title } : {}),
    },
  };
}

/** The panel's state for an anchor already set (the binding read), with what the pickers know of its reference. */
export function anchorDraftOf(
  anchor: CalendarAnchor | null,
  facts: { timed?: boolean; hasYear?: boolean } = {},
): AnchorDraft {
  if (anchor === null) return EMPTY_ANCHOR;
  const { reference, offset } = anchor;
  return {
    reference: reference.kind,
    event:
      reference.kind === "event_series"
        ? {
            sourceId: reference.source_id,
            uid: reference.uid,
            // An event this device does not hold is taken as timed when its anchor uses seconds (the server accepted it).
            timed: facts.timed ?? offset.kind === "elapsed_seconds",
          }
        : null,
    field:
      reference.kind === "person_date"
        ? { fieldId: reference.field_id, hasYear: facts.hasYear ?? true }
        : null,
    annual: reference.kind === "person_date" ? reference.annual : true,
    offset: offset.kind,
    days: offset.kind === "calendar_days" ? String(offset.days) : "0",
    time:
      offset.kind === "calendar_days" && typeof offset.time === "string"
        ? offset.time.slice(0, 5)
        : "",
    seconds: offset.kind === "elapsed_seconds" ? String(offset.seconds) : "0",
    weekdays: [...(anchor.weekdays ?? [])],
    titleContains: anchor.title_contains ?? "",
  };
}

/** The names a summary uses, when this device holds them. */
export interface AnchorNames {
  source?: string | null;
  event?: string | null;
  field?: string | null;
}

/** "Family calendar · Bin day · 1 day before at 18:00", from what is known; nothing is invented for what is not. */
export function describeAnchor(
  anchor: CalendarAnchor,
  names: AnchorNames = {},
): string {
  const parts: string[] = [];
  if (anchor.reference.kind === "event_series") {
    if (names.source) parts.push(names.source);
    parts.push(names.event || AN_EVENT);
  } else {
    parts.push(names.field || A_DATE);
    if (anchor.reference.annual) parts.push(ANNUALLY);
  }
  const offset = anchor.offset;
  parts.push(
    offset.kind === "elapsed_seconds"
      ? secondsWords(offset.seconds)
      : typeof offset.time === "string"
        ? `${daysWords(offset.days)} ${atTime(offset.time.slice(0, 5))}`
        : daysWords(offset.days),
  );
  return parts.join(" · ");
}

/**
 * The queued `set_anchor` (§4.3; R13): its version check is on the TASK root resource (`expected_version`, `409 conflict` on a mismatch),
 * it needs edit access to the task, and `anchor: null` removes the anchor (automation stops, occurrences stay). Nothing is shown
 * optimistically (the binding is not in the cache). `observed`: the read the panel was opened from, checked again in the writing
 * transaction.
 */
export function setAnchorRequest(
  task: Pick<CacheRow, "id">,
  anchor: CalendarAnchor | null,
  localId?: LocalId,
  observed?: Observation,
): EnqueueRequest {
  const { id } = task;
  return {
    endpoint: CALENDAR_COMMANDS,
    targets: [
      {
        resourceId: id,
        role: "primary",
        basis: "resource",
        versionChecked: true,
        requiresEdit: true,
      },
    ],
    build: (bases) => ({
      command: {
        command: {
          kind: "set_anchor",
          id,
          expected_version: bases[id] as number,
          anchor: anchor as unknown as JsonObject | null,
        },
      },
    }),
    ...(localId === undefined ? {} : { localId }),
    ...(observed === undefined ? {} : { observed }),
  };
}

/** The anchor a queued `set_anchor` body carries (`undefined` when the body is not one), for the "Review" of a conflicted change. */
export function anchorOfCommand(
  command: unknown,
): CalendarAnchor | null | undefined {
  const wrapped = (command as { command?: unknown } | null)?.command as
    | Record<string, unknown>
    | undefined;
  if (wrapped?.kind !== "set_anchor") return undefined;
  const anchor = wrapped.anchor;
  if (anchor === null || anchor === undefined) return null;
  return typeof anchor === "object" ? (anchor as CalendarAnchor) : undefined;
}
