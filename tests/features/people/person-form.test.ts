// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  applicablePerson,
  newPersonForm,
  reduceNewPerson,
} from "../../../src/features/people/model/person-form";

/** The "New person" form (§4.2) and PRODUCT-DECISIONS-20261011 item 2 for its optional first note. */
const typed = (...actions: Parameters<typeof reduceNewPerson>[1][]) =>
  actions.reduce(reduceNewPerson, newPersonForm());

describe("new person", () => {
  test("a hidden note keeps its text and is not sent; showing it again sends it", () => {
    const open = typed(
      { type: "name", value: " Ada " },
      { type: "note_open", value: true },
      { type: "note", value: "Allergic to nuts" },
    );
    expect(applicablePerson(open)).toEqual({
      ok: true,
      name: "Ada",
      sharing: "defaults",
      note: "Allergic to nuts",
    });
    const hidden = reduceNewPerson(open, { type: "note_open", value: false });
    expect(hidden.note).toBe("Allergic to nuts");
    expect(applicablePerson(hidden)).toMatchObject({ ok: true, note: null });
    const shown = reduceNewPerson(hidden, { type: "note_open", value: true });
    expect(applicablePerson(shown)).toMatchObject({ note: "Allergic to nuts" });
  });

  test("a blank shown note is not sent; a hidden over-long note does not stop the save", () => {
    expect(
      applicablePerson(
        typed(
          { type: "name", value: "Ada" },
          { type: "note_open", value: true },
          { type: "note", value: "   " },
        ),
      ),
    ).toMatchObject({ ok: true, note: null });
    expect(
      applicablePerson(
        typed(
          { type: "name", value: "Ada" },
          { type: "note_open", value: true },
          { type: "note", value: "x".repeat(4097) },
          { type: "note_open", value: false },
        ),
      ),
    ).toMatchObject({ ok: true, note: null });
  });

  test("name 1 to 300 characters; a shown note at most 4,096", () => {
    expect(applicablePerson(typed({ type: "name", value: " " }))).toEqual({
      ok: false,
      problems: { name: "name_missing" },
    });
    expect(
      applicablePerson(typed({ type: "name", value: "x".repeat(301) })),
    ).toEqual({ ok: false, problems: { name: "name_too_long" } });
    expect(
      applicablePerson(
        typed(
          { type: "name", value: "Ada" },
          { type: "note_open", value: true },
          { type: "note", value: "x".repeat(4097) },
        ),
      ),
    ).toEqual({ ok: false, problems: { note: "note_too_long" } });
  });

  test("every change raises the revision", () => {
    const a = typed({ type: "name", value: "A" });
    const b = reduceNewPerson(a, { type: "sharing", value: "only_you" });
    expect(b.revision).toBe(a.revision + 1);
  });
});
