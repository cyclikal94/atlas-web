import {
  type AnchorDraft,
  type AnchorNames,
  type CalendarAnchor,
  validateAnchor,
} from "./model/anchor";

/**
 * WEB-13b maintenance merge of accepted main, correction M-13b-1 (Kieran, 7 November 2026): the recovery texts of WEB-13b's anchor
 * input around an app-update reload (Q4; docs/pwa.md "WEB-13b's editors"). PURE. Every text is explicitly versioned, holds the panel's raw
 * input (every field, hidden ones included, and the names its summary shows: no secret is part of an anchor) and is read back STRICTLY: a
 * text of another version or shape is null, so it is offered as it is and never restored in part.
 *
 *  - G-1, the new-task form's ANCHOR (`TaskFormPage.tsx`: the anchor the panel saved into the form, and the panel kept by its in-dialog sync
 *    control) travels in the task form's own text (`tasks/form/form-input.ts`, version 2). A saved anchor is read back only if the draft it
 *    was saved with still validates to exactly that anchor (`validateAnchor`): never an anchor no check has passed.
 *  - G-2, the anchor PANEL being edited (`AnchorDialog.tsx`), on the new-task form (`task-form:new:anchor`) or on a task's detail
 *    (`task-anchor:<task>`, with the base the change is checked against: `tasks/detail/AnchorSection.tsx`).
 */
export const FORM_ANCHOR_CONTEXT = "task-form:new:anchor";
export const anchorPanelContext = (taskId: string) => `task-anchor:${taskId}`;

/** A typed field's bound (a text longer than any panel field holds is no panel's). */
const TEXT_BOUND = 2000;

type Raw = Record<string, unknown>;
const isRaw = (value: unknown): value is Raw =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string =>
  typeof value === "string" && value.length <= TEXT_BOUND;
const optionalName = (value: unknown): boolean =>
  value === undefined || value === null || text(value);

/** The panel's whole state as a copy holds it, or null when it is not exactly one. */
export function readAnchorDraft(raw: unknown): AnchorDraft | null {
  if (!isRaw(raw)) return null;
  const { reference, event, field, annual, offset, days, time, keptTime } = raw;
  const { seconds, weekdays, titleContains } = raw;
  if (reference !== "event_series" && reference !== "person_date") return null;
  if (offset !== "calendar_days" && offset !== "elapsed_seconds") return null;
  if (typeof annual !== "boolean") return null;
  if (!text(days) || !text(time) || !text(seconds) || !text(titleContains))
    return null;
  if (keptTime !== null && !text(keptTime)) return null;
  if (
    !Array.isArray(weekdays) ||
    weekdays.length > 7 ||
    !weekdays.every((day) => Number.isInteger(day) && day >= 1 && day <= 7)
  )
    return null;
  let picked: AnchorDraft["event"] = null;
  if (event !== null) {
    if (
      !isRaw(event) ||
      !text(event.sourceId) ||
      !text(event.uid) ||
      typeof event.timed !== "boolean"
    )
      return null;
    picked = { sourceId: event.sourceId, uid: event.uid, timed: event.timed };
  }
  let chosen: AnchorDraft["field"] = null;
  if (field !== null) {
    if (
      !isRaw(field) ||
      !text(field.fieldId) ||
      typeof field.hasYear !== "boolean"
    )
      return null;
    chosen = { fieldId: field.fieldId, hasYear: field.hasYear };
  }
  return {
    reference,
    event: picked,
    field: chosen,
    annual,
    offset,
    days,
    time,
    keptTime: keptTime as string | null,
    seconds,
    weekdays: [...(weekdays as number[])],
    titleContains,
  };
}

/** The names a copy's summary shows, or null when they are not names. */
export function readAnchorNames(raw: unknown): AnchorNames | null {
  if (!isRaw(raw)) return null;
  const { source, event, field } = raw;
  if (!optionalName(source) || !optionalName(event) || !optionalName(field))
    return null;
  const names: AnchorNames = {};
  if (source !== undefined) names.source = source as string | null;
  if (event !== undefined) names.event = event as string | null;
  if (field !== undefined) names.field = field as string | null;
  return names;
}

/**
 * G-2: the anchor a copy says its panel began from (the task's binding as it was read), or null when it is not one. Its shape only: it is
 * described and offered for removal, never sent from a copy (Save sends the restored DRAFT, validated when it is pressed).
 */
export function readCalendarAnchor(raw: unknown): CalendarAnchor | null {
  if (!isRaw(raw) || !isRaw(raw.reference) || !isRaw(raw.offset)) return null;
  const { reference, offset, weekdays, title_contains } = raw;
  const referenced =
    reference.kind === "event_series"
      ? text(reference.source_id) && text(reference.uid)
      : reference.kind === "person_date"
        ? text(reference.field_id) && typeof reference.annual === "boolean"
        : false;
  const offsetOk =
    offset.kind === "calendar_days"
      ? Number.isInteger(offset.days) &&
        (offset.time === undefined || offset.time === null || text(offset.time))
      : offset.kind === "elapsed_seconds"
        ? Number.isInteger(offset.seconds)
        : false;
  if (!referenced || !offsetOk) return null;
  if (
    weekdays !== undefined &&
    (!Array.isArray(weekdays) ||
      !weekdays.every((day) => Number.isInteger(day) && day >= 1 && day <= 7))
  )
    return null;
  if (
    title_contains !== undefined &&
    title_contains !== null &&
    !text(title_contains)
  )
    return null;
  return raw as unknown as CalendarAnchor;
}

/** Canonical JSON (member order fixed), to compare an anchor with the one its draft validates to. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, inner: unknown) =>
    isRaw(inner)
      ? Object.fromEntries(
          Object.keys(inner)
            .sort()
            .map((k) => [k, inner[k]]),
        )
      : inner,
  );

/**
 * G-1: an anchor the panel saved into the new-task form, as a copy holds it (`{ draft, anchor, names }`), or null. The draft must still
 * validate, to exactly the anchor stored with it.
 */
export function readFormAnchor(
  raw: unknown,
): { draft: AnchorDraft; anchor: CalendarAnchor; names: AnchorNames } | null {
  if (!isRaw(raw)) return null;
  const draft = readAnchorDraft(raw.draft);
  const names = readAnchorNames(raw.names);
  if (draft === null || names === null) return null;
  const validated = validateAnchor(draft);
  if (!("anchor" in validated)) return null;
  if (canonical(validated.anchor) !== canonical(raw.anchor)) return null;
  return { draft, anchor: validated.anchor, names };
}

/** G-1: the panel kept by its in-dialog sync control (`{ draft, names }`), or null. */
export function readKeptPanel(
  raw: unknown,
): { draft: AnchorDraft; names: AnchorNames } | null {
  if (!isRaw(raw)) return null;
  const draft = readAnchorDraft(raw.draft);
  const names = readAnchorNames(raw.names);
  return draft === null || names === null ? null : { draft, names };
}

/** G-2: the anchor panel's input as one recoverable text (version 1); `base`, the host's own (what the change is checked against). */
export const ANCHOR_PANEL_VERSION = 1;

export interface AnchorPanelInput<B> {
  draft: AnchorDraft;
  names: AnchorNames;
  base: B;
}

export function encodeAnchorPanel<B>(
  input: AnchorPanelInput<B>,
  encodeBase: (base: B) => unknown,
): string {
  return JSON.stringify({
    v: ANCHOR_PANEL_VERSION,
    draft: input.draft,
    names: input.names,
    base: encodeBase(input.base),
  });
}

/** Null for a text of another version, or whose draft, names or base (`decodeBase`: undefined when it is not one) cannot be read. */
export function decodeAnchorPanel<B>(
  text: string,
  decodeBase: (raw: unknown) => B | undefined,
): AnchorPanelInput<B> | null {
  try {
    const raw = JSON.parse(text) as unknown;
    if (!isRaw(raw) || raw.v !== ANCHOR_PANEL_VERSION) return null;
    const draft = readAnchorDraft(raw.draft);
    const names = readAnchorNames(raw.names);
    if (draft === null || names === null) return null;
    const base = decodeBase(raw.base);
    return base === undefined ? null : { draft, names, base };
  } catch {
    return null;
  }
}
