// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  listFormContext,
  listFormRecoveryValues,
  listPickerContext,
  newListFormContext,
  pickerRecoveryValues,
  restoreListForm,
  restorePicker,
} from "../../../src/features/tasks/model/lists";

/** WEB-10b L19 (Q4 readiness; WEB-14a wires the capture): contexts and values round-trip, raw; anything else restores nothing. */
const ID = "56000000-0000-4000-8000-000000000001";

describe("L19: the Lists' recoverable forms", () => {
  test("contexts", () => {
    expect(newListFormContext("f1")).toBe("list-form:new:f1");
    expect(listFormContext(ID)).toBe(`list-form:${ID}`);
    expect(listPickerContext(ID)).toBe(`list-picker:${ID}`);
  });
  test("a name round-trips raw (blank, too long, astral)", () => {
    for (const name of ["", "  x ", "😀".repeat(301), "\u0085"])
      expect(restoreListForm(listFormRecoveryValues(name))).toEqual({ name });
  });
  test("a picker round-trips its query and selection, never ids it cannot be", () => {
    expect(
      restorePicker(pickerRecoveryValues({ query: "Éclair", selected: [ID] })),
    ).toEqual({ query: "Éclair", selected: [ID] });
  });
  test.each([
    [{}],
    [{ list: "not json" }],
    [{ list: JSON.stringify({ name: 1 }) }],
    [{ list: JSON.stringify({ name: "x", extra: true }) }],
    [{ list: JSON.stringify(["x"]) }],
  ])("a list form value that does not parse restores nothing: %j", (values) => {
    expect(restoreListForm(values)).toBeNull();
  });
  test.each([
    [{ picker: JSON.stringify({ query: "x", selected: ["nope"] }) }],
    [{ picker: JSON.stringify({ query: "x", selected: [ID, ID] }) }],
    [{ picker: JSON.stringify({ query: 1, selected: [] }) }],
    [{ picker: JSON.stringify({ query: "x" }) }],
    [{ picker: "{" }],
  ])("a picker value that does not parse restores nothing: %j", (values) => {
    expect(restorePicker(values)).toBeNull();
  });
});
