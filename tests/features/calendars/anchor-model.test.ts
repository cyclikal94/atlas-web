// @vitest-environment node
import { describe, expect, test } from "vitest";
import { ObservationFold } from "../../../src/data/model/observation";
import {
  type AnchorDraft,
  anchorDraftOf,
  anchorOfCommand,
  annualForced,
  type CalendarAnchor,
  describeAnchor,
  EMPTY_ANCHOR,
  secondsAllowed,
  setAnchorRequest,
  validateAnchor,
} from "../../../src/features/calendars/model/anchor";

/**
 * WEB-13b §4.3: the anchor panel's validation mirrors the released server (`anchors.rs` `Anchor::validate`, `set_task_anchor`) and sends
 * only the APPLICABLE fields: title-contains never for a person date (kept while editing, omitted on save), seconds only for a timed event
 * series, a minute-precision time sent as `HH:MM:SS`, weekdays sorted and unique, "repeats annually" forced for a year-less date field.
 */
const SOURCE = "00000000-0000-4000-8000-0000000000a1";
const FIELD = "00000000-0000-4000-8000-0000000000f1";
const TASK = "00000000-0000-4000-8000-0000000000b1";
const event = (timed: boolean): AnchorDraft => ({
  ...EMPTY_ANCHOR,
  event: { sourceId: SOURCE, uid: "bin@example", timed },
});
const person = (hasYear: boolean, over: Partial<AnchorDraft> = {}) => ({
  ...EMPTY_ANCHOR,
  reference: "person_date" as const,
  field: { fieldId: FIELD, hasYear },
  ...over,
});
const anchorOf = (draft: AnchorDraft) => {
  const out = validateAnchor(draft);
  if (!("anchor" in out)) throw new Error(JSON.stringify(out.errors));
  return out.anchor;
};

describe("the reference", () => {
  test("an event series names its source and uid", () => {
    expect(anchorOf({ ...event(false), days: "-1", time: "18:00" })).toEqual({
      reference: {
        kind: "event_series",
        source_id: SOURCE,
        uid: "bin@example",
      },
      offset: { kind: "calendar_days", days: -1, time: "18:00:00" },
      weekdays: [],
    });
  });

  test("nothing chosen is the reference's error", () => {
    expect(validateAnchor(EMPTY_ANCHOR)).toEqual({
      errors: { reference: "Choose an event or a date field first" },
    });
    expect(
      validateAnchor({ ...EMPTY_ANCHOR, reference: "person_date" }),
    ).toMatchObject({ errors: { reference: expect.any(String) } });
  });

  test("a date field with a year may repeat or not; one without a year always repeats annually", () => {
    expect(anchorOf(person(true, { annual: false })).reference).toEqual({
      kind: "person_date",
      field_id: FIELD,
      annual: false,
    });
    expect(annualForced(person(false))).toBe(true);
    expect(anchorOf(person(false, { annual: false })).reference).toEqual({
      kind: "person_date",
      field_id: FIELD,
      annual: true,
    });
  });
});

describe("the offset", () => {
  test.each([
    ["0", "", { kind: "calendar_days", days: 0 }],
    ["366", "", { kind: "calendar_days", days: 366 }],
    ["-366", "07:05", { kind: "calendar_days", days: -366, time: "07:05:00" }],
    ["−2", "", { kind: "calendar_days", days: -2 }],
    ["+3", " 23:59 ", { kind: "calendar_days", days: 3, time: "23:59:00" }],
  ])("days %s at %j", (days, time, offset) => {
    expect(anchorOf({ ...event(false), days, time }).offset).toEqual(offset);
  });

  test.each([
    ["367", "", "days", "Enter a number of days from −366 to 366"],
    ["1.5", "", "days", "Enter a whole number of days (or seconds)"],
    ["", "", "days", "Enter a whole number of days (or seconds)"],
    ["1", "24:00", "time", "Enter a valid 24-hour time, e.g. 18:00"],
    ["1", "6pm", "time", "Enter a valid 24-hour time, e.g. 18:00"],
    ["1", "18:00:00", "time", "Enter a valid 24-hour time, e.g. 18:00"],
  ])("days %j at %j is the %s field's error", (days, time, field, message) => {
    expect(validateAnchor({ ...event(false), days, time })).toEqual({
      errors: { [field]: message },
    });
  });

  test("a bad day count and a bad time are each shown under their own field", () => {
    expect(
      validateAnchor({ ...event(false), days: "x", time: "99:99" }),
    ).toEqual({
      errors: {
        days: "Enter a whole number of days (or seconds)",
        time: "Enter a valid 24-hour time, e.g. 18:00",
      },
    });
  });

  test("seconds only for a TIMED event series, within ±31,622,400", () => {
    const timed = { ...event(true), offset: "elapsed_seconds" as const };
    expect(secondsAllowed(timed)).toBe(true);
    expect(anchorOf({ ...timed, seconds: "-3600" }).offset).toEqual({
      kind: "elapsed_seconds",
      seconds: -3600,
    });
    expect(anchorOf({ ...timed, seconds: "31622400" }).offset).toMatchObject({
      seconds: 31_622_400,
    });
    expect(validateAnchor({ ...timed, seconds: "31622401" })).toMatchObject({
      errors: { seconds: expect.stringContaining("31,622,400") },
    });
    const untimed = { ...event(false), offset: "elapsed_seconds" as const };
    expect(secondsAllowed(untimed)).toBe(false);
    expect(validateAnchor(untimed)).toEqual({
      errors: { seconds: "Needs a timed event" },
    });
    const date = person(true, { offset: "elapsed_seconds" });
    expect(secondsAllowed(date)).toBe(false);
    expect(validateAnchor(date)).toMatchObject({
      errors: { seconds: "Needs a timed event" },
    });
  });
});

describe("eligibility", () => {
  test("weekdays are sent sorted and unique (1 is Monday, 7 Sunday)", () => {
    expect(
      anchorOf({ ...event(false), weekdays: [7, 1, 3, 1] }).weekdays,
    ).toEqual([1, 3, 7]);
  });

  test("title contains: sent for an event series, omitted when blank, at most 100 BYTES", () => {
    expect(
      anchorOf({ ...event(false), titleContains: "Bin" }).title_contains,
    ).toBe("Bin");
    expect(
      "title_contains" in anchorOf({ ...event(false), titleContains: "  " }),
    ).toBe(false);
    expect(
      anchorOf({ ...event(false), titleContains: "é".repeat(50) })
        .title_contains,
    ).toHaveLength(50);
    expect(
      validateAnchor({ ...event(false), titleContains: "é".repeat(51) }),
    ).toEqual({ errors: { titleContains: "Keep this to 100 bytes or fewer" } });
  });

  test("a person date never sends title contains, whatever was typed (kept in the draft, omitted on save)", () => {
    const draft = person(true, { titleContains: "Birthday" });
    expect(draft.titleContains).toBe("Birthday");
    expect("title_contains" in anchorOf(draft)).toBe(false);
    // Even one that would be too long is not an error when it does not apply.
    expect(
      "anchor" in
        validateAnchor(person(true, { titleContains: "x".repeat(200) })),
    ).toBe(true);
  });
});

describe("round trip, summary and the request", () => {
  test("an anchor read back fills the panel as it was set", () => {
    const anchor = anchorOf({
      ...event(true),
      offset: "calendar_days",
      days: "-1",
      time: "18:00",
      weekdays: [1, 2],
      titleContains: "Bin",
    });
    const draft = anchorDraftOf(anchor, { timed: true });
    expect(draft).toMatchObject({
      reference: "event_series",
      event: { sourceId: SOURCE, uid: "bin@example", timed: true },
      days: "-1",
      time: "18:00",
      weekdays: [1, 2],
      titleContains: "Bin",
    });
    expect(validateAnchor(draft)).toEqual({ anchor });
    expect(anchorDraftOf(null)).toEqual(EMPTY_ANCHOR);
  });

  test("R5: an anchor's own time is kept exactly (seconds included) until the time field is edited or cleared", () => {
    const exact = (time: string): CalendarAnchor => ({
      reference: {
        kind: "event_series",
        source_id: SOURCE,
        uid: "bin@example",
      },
      offset: { kind: "calendar_days", days: -1, time },
      weekdays: [],
    });
    const draft = anchorDraftOf(exact("18:00:37"), { timed: true });
    expect(draft).toMatchObject({ time: "18:00", keptTime: "18:00:37" });
    // Untouched: sent exactly, whatever else changed (days, weekdays, a reference switched away and back).
    expect(validateAnchor({ ...draft, days: "-2", weekdays: [3] })).toEqual({
      anchor: {
        ...exact("18:00:37"),
        offset: { kind: "calendar_days", days: -2, time: "18:00:37" },
        weekdays: [3],
      },
    });
    expect(
      validateAnchor({ ...draft, reference: "person_date" }),
    ).toMatchObject({ errors: { reference: expect.any(String) } });
    expect(validateAnchor({ ...draft })).toEqual({ anchor: exact("18:00:37") });
    // Edited (the panel ends the kept time with the edit): sent as typed.
    expect(validateAnchor({ ...draft, time: "19:15", keptTime: null })).toEqual(
      { anchor: exact("19:15:00") },
    );
    // Even an edit back to the same minute is what was typed.
    expect(validateAnchor({ ...draft, time: "18:00", keptTime: null })).toEqual(
      { anchor: exact("18:00:00") },
    );
    // Cleared: no time.
    expect(validateAnchor({ ...draft, time: "", keptTime: null })).toEqual({
      anchor: {
        ...exact("18:00:37"),
        offset: { kind: "calendar_days", days: -1 },
      },
    });
    // A kept time that the field no longer shows (or that is not HH:MM:SS) is never sent.
    expect(validateAnchor({ ...draft, time: "07:30" })).toEqual({
      anchor: exact("07:30:00"),
    });
    expect(validateAnchor({ ...draft, keptTime: "18:00" })).toEqual({
      anchor: exact("18:00:00"),
    });
    // The seconds offset hides the time and keeps it: back on calendar days it is still exact.
    const back = { ...draft, offset: "elapsed_seconds" as const };
    expect(validateAnchor({ ...back, offset: "calendar_days" })).toEqual({
      anchor: exact("18:00:37"),
    });
    expect(anchorDraftOf(null).keptTime).toBeNull();
    expect(EMPTY_ANCHOR.keptTime).toBeNull();
  });

  test("the summary names what is known and invents nothing", () => {
    const anchor = anchorOf({ ...event(false), days: "-1", time: "18:00" });
    expect(
      describeAnchor(anchor, { source: "Family calendar", event: "Bin day" }),
    ).toBe("Family calendar · Bin day · 1 day before at 18:00");
    expect(describeAnchor(anchor)).toBe(
      "a calendar event · 1 day before at 18:00",
    );
    expect(
      describeAnchor(anchorOf(person(false)), { field: "Priya — Birthday" }),
    ).toBe("Priya — Birthday · every year · on the day");
  });

  test("set_anchor is version-checked on the TASK, needs edit access, and `null` removes", () => {
    const anchor = anchorOf(event(false));
    // What a read of the task saw (here: an incarnation holding no copy of it and no drafts), carried to the writing transaction (R11).
    const observed = {
      resourceId: TASK,
      token: new ObservationFold(
        "incarnation-1",
        TASK,
        undefined,
        undefined,
      ).token(),
    };
    const request = setAnchorRequest({ id: TASK }, anchor, observed, "k1");
    expect(request).toMatchObject({
      endpoint: "/calendar-commands",
      localId: "k1",
      observed,
      targets: [
        {
          resourceId: TASK,
          role: "primary",
          basis: "resource",
          versionChecked: true,
          requiresEdit: true,
        },
      ],
    });
    expect(request.build({ [TASK]: 4 })).toEqual({
      command: {
        command: { kind: "set_anchor", id: TASK, expected_version: 4, anchor },
      },
    });
    const removing = setAnchorRequest({ id: TASK }, null, observed);
    expect(removing.observed).toEqual(observed);
    expect(removing.localId).toBeUndefined();
    const removal = removing.build({ [TASK]: 5 });
    expect(removal.command).toEqual({
      command: {
        kind: "set_anchor",
        id: TASK,
        expected_version: 5,
        anchor: null,
      },
    });
    expect(anchorOfCommand(removal.command)).toBeNull();
    expect(anchorOfCommand(request.build({ [TASK]: 4 }).command)).toEqual(
      anchor,
    );
    expect(
      anchorOfCommand({ command: { kind: "configure_source" } }),
    ).toBeUndefined();
  });
});
