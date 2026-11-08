import { describe, expect, test } from "vitest";
import {
  decodeAnchorPanel,
  encodeAnchorPanel,
  readAnchorDraft,
  readCalendarAnchor,
  readFormAnchor,
} from "../../../src/features/calendars/anchor-recovery";
import {
  decodeImportInput,
  encodeImportInput,
} from "../../../src/features/calendars/import-recovery";
import {
  type AnchorDraft,
  EMPTY_ANCHOR,
  validateAnchor,
} from "../../../src/features/calendars/model/anchor";
import {
  decodeFormInput,
  encodeFormInput,
} from "../../../src/features/tasks/form/form-input";
import { emptyForm } from "../../../src/features/tasks/model/form";
import { encodeTaskFormInput } from "../../../src/features/tasks/model/recovery";

/**
 * WEB-13b maintenance merge of accepted main, correction M-13b-1 (Kieran, 7 November 2026): the recovery texts of WEB-13b's input
 * (`anchor-recovery.ts`, `import-recovery.ts`, `tasks/form/form-input.ts`) are explicitly versioned and read back strictly: a text of
 * another version or shape is null (offered as it is, never restored in part); a saved anchor is read back only if its draft still
 * validates to exactly it; a version-1 task form (a build without anchors) is read with none. PURE.
 */
const DRAFT: AnchorDraft = {
  ...EMPTY_ANCHOR,
  event: { sourceId: "src-1", uid: "bin@example", timed: false },
  days: "-1",
  time: "18:00",
};
const validated = validateAnchor(DRAFT);
if (!("anchor" in validated))
  throw new Error("the fixture draft must validate");
const ANCHOR = validated.anchor;
const NAMES = { source: "Family calendar", event: "Bin day" };
const form = emptyForm("Europe/London", "2026-11-07");
const typed = { ...form, title: "Put the bins out" };

describe("G-1: the task form's text, version 2", () => {
  test("keeps the anchor and the kept panel, and reads them back", () => {
    const input = {
      initial: form,
      state: typed,
      anchor: { draft: DRAFT, anchor: ANCHOR, names: NAMES },
      panel: { draft: { ...DRAFT, days: "-2" }, names: NAMES },
    };
    const text = encodeFormInput(input);
    expect(JSON.parse(text).v).toBe(2);
    expect(decodeFormInput(text)).toEqual(input);
  });

  test("a form with no anchor keeps none", () => {
    expect(
      decodeFormInput(encodeFormInput({ initial: form, state: typed })),
    ).toEqual({
      initial: form,
      state: typed,
      anchor: null,
      panel: null,
    });
  });

  test("a version-1 text (a build without anchors) is read with no anchor", () => {
    const decoded = decodeFormInput(
      encodeTaskFormInput({ initial: form, state: typed }),
    );
    expect(decoded?.state.title).toBe("Put the bins out");
    expect(decoded?.anchor ?? null).toBeNull();
  });

  test("an anchor its draft does not validate to, another version, or a malformed panel is unreadable (null)", () => {
    const good = JSON.parse(
      encodeFormInput({
        initial: form,
        state: typed,
        anchor: { draft: DRAFT, anchor: ANCHOR, names: NAMES },
      }),
    );
    const tampered = {
      ...good,
      anchor: {
        ...good.anchor,
        anchor: { ...ANCHOR, offset: { kind: "calendar_days", days: 30 } },
      },
    };
    expect(decodeFormInput(JSON.stringify(tampered))).toBeNull();
    expect(decodeFormInput(JSON.stringify({ ...good, v: 3 }))).toBeNull();
    expect(
      decodeFormInput(JSON.stringify({ ...good, panel: { draft: {} } })),
    ).toBeNull();
    expect(decodeFormInput("not json")).toBeNull();
  });
});

describe("the anchor panel's text and readers", () => {
  test("a draft is read back exactly, or not at all", () => {
    expect(readAnchorDraft(JSON.parse(JSON.stringify(DRAFT)))).toEqual(DRAFT);
    expect(readAnchorDraft({ ...DRAFT, weekdays: [0] })).toBeNull();
    expect(readAnchorDraft({ ...DRAFT, offset: "minutes" })).toBeNull();
    expect(readAnchorDraft({ ...DRAFT, days: 1 })).toBeNull();
    expect(
      readAnchorDraft({ ...DRAFT, event: { sourceId: "s", uid: "u" } }),
    ).toBeNull();
  });

  test("a stored anchor is read only when its draft validates to exactly it", () => {
    expect(
      readFormAnchor({ draft: DRAFT, anchor: ANCHOR, names: NAMES }),
    ).toEqual({ draft: DRAFT, anchor: ANCHOR, names: NAMES });
    expect(
      readFormAnchor({
        draft: DRAFT,
        anchor: { ...ANCHOR, weekdays: [1] },
        names: NAMES,
      }),
    ).toBeNull();
  });

  test("version 1 with the host's base; another version, or a base the host cannot read, is null", () => {
    const text = encodeAnchorPanel(
      { draft: DRAFT, names: NAMES, base: { observed: "t-1" } },
      (base) => base,
    );
    const decode = (raw: unknown) =>
      typeof raw === "object" &&
      raw !== null &&
      typeof (raw as { observed?: unknown }).observed === "string"
        ? (raw as { observed: string })
        : undefined;
    expect(decodeAnchorPanel(text, decode)).toEqual({
      draft: DRAFT,
      names: NAMES,
      base: { observed: "t-1" },
    });
    expect(
      decodeAnchorPanel(JSON.stringify({ ...JSON.parse(text), v: 2 }), decode),
    ).toBeNull();
    expect(
      decodeAnchorPanel(
        JSON.stringify({ ...JSON.parse(text), base: { observed: 1 } }),
        decode,
      ),
    ).toBeNull();
  });

  test("the anchor a panel began from: a binding's shape, or null", () => {
    expect(readCalendarAnchor(ANCHOR)).toEqual(ANCHOR);
    expect(
      readCalendarAnchor({ ...ANCHOR, reference: { kind: "elsewhere" } }),
    ).toBeNull();
    expect(
      readCalendarAnchor({ ...ANCHOR, offset: { kind: "calendar_days" } }),
    ).toBeNull();
  });
});

describe("G-3: the import dialog's text", () => {
  test("the source and the window as typed, version 1 (never a file)", () => {
    const text = encodeImportInput({
      chosen: null,
      from: "2026-01-01",
      through: "",
    });
    expect(JSON.parse(text)).toEqual({
      v: 1,
      chosen: null,
      from: "2026-01-01",
      through: "",
    });
    expect(decodeImportInput(text)).toEqual({
      chosen: null,
      from: "2026-01-01",
      through: "",
    });
  });

  test("another version, another shape or an overlong field is null", () => {
    const good = { v: 1, chosen: "src-1", from: "2026-01-01", through: "x" };
    expect(decodeImportInput(JSON.stringify(good))?.chosen).toBe("src-1");
    expect(decodeImportInput(JSON.stringify({ ...good, v: 2 }))).toBeNull();
    expect(decodeImportInput(JSON.stringify({ ...good, from: 7 }))).toBeNull();
    expect(
      decodeImportInput(JSON.stringify({ ...good, through: "9".repeat(65) })),
    ).toBeNull();
    expect(
      decodeImportInput(JSON.stringify({ ...good, chosen: 3 })),
    ).toBeNull();
  });
});
