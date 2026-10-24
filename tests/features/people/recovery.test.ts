// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  newFieldForm,
  reduceFieldForm,
} from "../../../src/features/people/model/field-form";
import {
  newPersonForm,
  reduceNewPerson,
} from "../../../src/features/people/model/person-form";
import {
  fieldContext,
  fieldRecoveryFields,
  newPersonContext,
  personRecoveryFields,
  renameContext,
  renameRecoveryFields,
  restoreFieldForm,
  restorePersonForm,
  restoreRename,
} from "../../../src/features/people/model/recovery";

/** The Q4 recovery contexts WEB-11a exposes for WEB-14a (no capture here; a restore fills the form and never submits). */
describe("recovery contexts", () => {
  test("context keys", () => {
    expect(fieldContext("p", { fieldId: "f" })).toBe("people-field:p:f");
    expect(fieldContext("p", { formId: "n" })).toBe("people-field:p:new:n");
    expect(renameContext("p")).toBe("people-rename:p");
    expect(newPersonContext("n")).toBe("people-new:n");
  });

  test("the field editor round-trips every slot, the hidden ones included", () => {
    const state = [
      { type: "name", value: "Weight" },
      { type: "slot", kind: "text", value: { text: "about 70" } },
      { type: "kind", value: "quantity" },
      { type: "slot", kind: "quantity", value: { amount: "70", unit: "kg" } },
      { type: "audience", value: "only_you" },
    ].reduce((s, a) => reduceFieldForm(s, a as never), newFieldForm());
    const restored = restoreFieldForm(fieldRecoveryFields(state));
    expect(restored?.name).toBe("Weight");
    expect(restored?.kind).toBe("quantity");
    expect(restored?.slots).toEqual(state.slots);
    expect(restored?.audience).toBe("only_you");
  });

  test("a captured value that is not one of these forms restores nothing", () => {
    expect(restoreFieldForm({ form: "not json" })).toBeNull();
    expect(
      restoreFieldForm({ form: JSON.stringify({ name: "x", kind: "colour" }) }),
    ).toBeNull();
    expect(restoreFieldForm({})).toBeNull();
    expect(
      restorePersonForm({
        name: "a",
        sharing: "everyone",
        note_open: "0",
        note: "",
      }),
    ).toBeNull();
    expect(restoreRename({})).toBeNull();
  });

  test("the new-person form keeps a hidden note; the rename keeps the name", () => {
    const state = [
      { type: "name", value: "Ada" },
      { type: "note_open", value: true },
      { type: "note", value: "nuts" },
      { type: "note_open", value: false },
    ].reduce((s, a) => reduceNewPerson(s, a as never), newPersonForm());
    expect(restorePersonForm(personRecoveryFields(state))).toMatchObject({
      name: "Ada",
      noteOpen: false,
      note: "nuts",
    });
    expect(restoreRename(renameRecoveryFields("Mo"))).toBe("Mo");
  });
});

/**
 * Review 8, observation 3 (`people-recovery-slot-shape`): a capture is restored only when EVERY slot (the hidden ones too) and every list
 * entry has its input's shape; otherwise nothing is restored, before any reader of the form could throw on it. Only the shape is checked:
 * unfinished input comes back exactly as typed.
 */
describe("review 8, observation 3: every slot is read back by its shape", () => {
  const captured = (patch: (form: Record<string, unknown>) => void) => {
    const state = reduceFieldForm(newFieldForm(), {
      type: "name",
      value: "Weight",
    });
    const form = JSON.parse(fieldRecoveryFields(state).form as string);
    patch(form);
    return { form: JSON.stringify(form) };
  };
  const slot =
    (kind: string, value: unknown) => (form: Record<string, unknown>) => {
      (form.slots as Record<string, unknown>)[kind] = value;
    };
  const malformed: Array<[string, (form: Record<string, unknown>) => void]> = [
    ["a numeric quantity amount", slot("quantity", { amount: 17, unit: "kg" })],
    ["a null quantity unit", slot("quantity", { amount: "12", unit: null })],
    ["a text that is not a text", slot("text", { text: 5 })],
    [
      "a date part that is a number",
      slot("date", { day: 1, month: "2", year: "2026" }),
    ],
    ["a date with a part missing", slot("date", { day: "1", month: "2" })],
    ["a URL that is not a text", slot("url", { url: ["https://a.example"] })],
    ["a boolean that is a text", slot("boolean", { value: "yes" })],
    ["choices that are not a list", slot("choices", { options: null })],
    [
      "a choice without a label",
      slot("choices", { options: [{ key: "k", selected: false }] }),
    ],
    [
      "a choice whose selection is a text",
      slot("choices", {
        options: [{ key: "k", label: "A", selected: "true" }],
      }),
    ],
    ["checklist items that are an object", slot("checklist", { items: {} })],
    [
      "a checklist item whose id is a number",
      slot("checklist", { items: [{ id: 1, label: "A", checked: false }] }),
    ],
    ["a checklist entry that is null", slot("checklist", { items: [null] })],
    [
      "a slot that is missing",
      (form) => {
        delete (form.slots as Record<string, unknown>).boolean;
      },
    ],
  ];
  for (const [name, patch] of malformed)
    test(`${name} (a hidden slot: the active one is text): nothing is restored`, () => {
      expect(restoreFieldForm(captured(patch))).toBeNull();
    });

  test("control: unfinished and hidden input comes back exactly as typed, never trimmed, coerced or validated as a value", () => {
    const slots = {
      text: { text: "  about seventy  " },
      quantity: { amount: "12.", unit: " kg" },
      date: { day: "31", month: "02", year: "20" },
      url: { url: "not a url yet" },
      boolean: { value: false },
      choices: { options: [{ key: "a", label: "Ája 😀", selected: false }] },
      checklist: { items: [{ id: "i-1", label: "", checked: true }] },
    };
    const restored = restoreFieldForm(
      captured((form) => {
        form.slots = slots;
        form.kind = "quantity";
      }),
    );
    expect(restored?.slots).toEqual(slots);
    expect(restored?.kind).toBe("quantity");
    expect(
      restoreFieldForm(captured(slot("boolean", { value: null })))?.slots
        .boolean,
    ).toEqual({ value: null });
    expect(
      restoreFieldForm(captured(slot("choices", { options: [] })))?.slots
        .choices,
    ).toEqual({ options: [] });
  });
});
