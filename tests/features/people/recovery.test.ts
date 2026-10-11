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
