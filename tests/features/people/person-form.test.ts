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

  describe("a shown note is a text value the server accepts: 4,096 characters and 8,192 bytes once encoded (review 21, R21.1)", () => {
    /** The note's value as sent, `{"kind":"text","text":…}` in UTF-8, counted here rather than by the validator under test. */
    const encoded = (note: string) =>
      new TextEncoder().encode(JSON.stringify({ kind: "text", text: note }))
        .length;
    const shown = (note: string, sharing: "defaults" | "only_you") =>
      typed(
        { type: "name", value: "Ada" },
        { type: "sharing", value: sharing },
        { type: "note_open", value: true },
        { type: "note", value: note },
      );
    // [what, note, its characters, its encoded bytes, the problem or null]
    const cases: Array<[string, string, number, number, string | null]> = [
      ["4,096 ASCII", "x".repeat(4096), 4096, 4121, null],
      ["4,097 ASCII", "x".repeat(4097), 4097, 4122, "note_too_long"],
      [
        "review 21's 3,000 字",
        "字".repeat(3000),
        3000,
        9025,
        "value_too_large",
      ],
      [
        "4,096 escaped newlines",
        `a${"\n".repeat(4095)}`,
        4096,
        8216,
        "value_too_large",
      ],
      ["multibyte at 8,192", `${"字".repeat(2722)}a`, 2723, 8192, null],
      [
        "multibyte at 8,193",
        `${"字".repeat(2722)}aa`,
        2724,
        8193,
        "value_too_large",
      ],
      ["escaped at 8,192", `a${"\n".repeat(4083)}`, 4084, 8192, null],
      [
        "escaped at 8,193",
        `aa${"\n".repeat(4083)}`,
        4085,
        8193,
        "value_too_large",
      ],
      ["astral at 8,192", `${"😀".repeat(2041)}aaa`, 2044, 8192, null],
      [
        "astral at 8,193",
        `${"😀".repeat(2041)}aaaa`,
        2045,
        8193,
        "value_too_large",
      ],
      ["quotes at 8,192", `a${'"'.repeat(4083)}`, 4084, 8192, null],
      [
        "quotes at 8,193",
        `aa${'"'.repeat(4083)}`,
        4085,
        8193,
        "value_too_large",
      ],
      [
        "backslashes at 8,193",
        `aa${"\\".repeat(4083)}`,
        4085,
        8193,
        "value_too_large",
      ],
      [
        "control characters at 8,192",
        `a${"\u0001".repeat(1361)}`,
        1362,
        8192,
        null,
      ],
      [
        "control characters at 8,193",
        `aa${"\u0001".repeat(1361)}`,
        1363,
        8193,
        "value_too_large",
      ],
    ];
    for (const [what, note, characters, bytes, problem] of cases)
      for (const sharing of ["defaults", "only_you"] as const)
        test(`${what} (${sharing})`, () => {
          expect([...note].length).toBe(characters);
          expect(encoded(note)).toBe(bytes);
          const result = applicablePerson(shown(note, sharing));
          if (problem === null)
            expect(result).toEqual({ ok: true, name: "Ada", sharing, note });
          else
            expect(result).toEqual({ ok: false, problems: { note: problem } });
        });

    test("the note is kept as typed: not trimmed, cut or changed", () => {
      const note = `  ${"字".repeat(2720)}  `;
      expect(encoded(note)).toBe(8189);
      expect(applicablePerson(shown(note, "defaults"))).toMatchObject({
        ok: true,
        note,
      });
      const over = shown(`${"字".repeat(2722)}aa`, "defaults");
      expect(applicablePerson(over).ok).toBe(false);
      expect(over.note).toBe(`${"字".repeat(2722)}aa`);
    });

    test("a hidden or blank note over the limit is not sent and does not stop the save; shown again it is checked", () => {
      const blank = "\n".repeat(4096);
      expect(encoded(blank)).toBe(8217);
      expect(applicablePerson(shown(blank, "defaults"))).toEqual({
        ok: true,
        name: "Ada",
        sharing: "defaults",
        note: null,
      });
      const over = "字".repeat(3000);
      const hidden = reduceNewPerson(shown(over, "only_you"), {
        type: "note_open",
        value: false,
      });
      expect(applicablePerson(hidden)).toEqual({
        ok: true,
        name: "Ada",
        sharing: "only_you",
        note: null,
      });
      expect(hidden.note).toBe(over);
      expect(
        applicablePerson(
          reduceNewPerson(hidden, { type: "note_open", value: true }),
        ),
      ).toEqual({ ok: false, problems: { note: "value_too_large" } });
    });

    test("both problems are reported together", () => {
      expect(
        applicablePerson(
          typed(
            { type: "note_open", value: true },
            { type: "note", value: "字".repeat(3000) },
          ),
        ),
      ).toEqual({
        ok: false,
        problems: { name: "name_missing", note: "value_too_large" },
      });
    });
  });

  test("every change raises the revision", () => {
    const a = typed({ type: "name", value: "A" });
    const b = reduceNewPerson(a, { type: "sharing", value: "only_you" });
    expect(b.revision).toBe(a.revision + 1);
  });
});
