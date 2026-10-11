// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  applicable,
  type FieldFormState,
  fromField,
  isCurrent,
  newFieldForm,
  reduceFieldForm,
  ticketOf,
} from "../../../src/features/people/model/field-form";

/**
 * The field editor's state (WF-PEOPLE-03) and PRODUCT-DECISIONS-20261011 item 2: each type keeps its own value slot for the editing
 * session, a save sends only the active type's value with no warning, and a success never consumes a later edit (the ticket).
 */
const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
let keys = 0;
const key = () => {
  keys += 1;
  return `k${keys}`;
};

const typed = (
  state: FieldFormState,
  ...actions: Parameters<typeof reduceFieldForm>[1][]
) => actions.reduce(reduceFieldForm, state);

describe("conditional values (type switch)", () => {
  test("switching the type away and back restores what was typed in each slot", () => {
    let state = typed(
      newFieldForm(),
      { type: "name", value: "Weight" },
      { type: "slot", kind: "text", value: { text: "about 70" } },
      { type: "kind", value: "quantity" },
      { type: "slot", kind: "quantity", value: { amount: "70", unit: "kg" } },
      { type: "kind", value: "text" },
    );
    expect(state.slots.text.text).toBe("about 70");
    expect(state.slots.quantity).toEqual({ amount: "70", unit: "kg" });
    state = reduceFieldForm(state, { type: "kind", value: "quantity" });
    expect(state.slots.text.text).toBe("about 70");
  });

  test("a save sends only the ACTIVE type's value, whatever the hidden slots hold", () => {
    const state = typed(
      newFieldForm(),
      { type: "name", value: "Weight" },
      { type: "slot", kind: "text", value: { text: "about 70" } },
      { type: "kind", value: "quantity" },
      { type: "slot", kind: "quantity", value: { amount: "70", unit: "kg" } },
    );
    expect(applicable(state)).toEqual({
      ok: true,
      label: "Weight",
      value: { kind: "quantity", amount: "70", unit: "kg" },
    });
  });

  test("a hidden slot that is invalid does not stop the save (no warning about it)", () => {
    const state = typed(
      newFieldForm(),
      { type: "name", value: "Site" },
      { type: "kind", value: "date" },
      {
        type: "slot",
        kind: "date",
        value: { day: "31", month: "2", year: "" },
      },
      { type: "kind", value: "url" },
      { type: "slot", kind: "url", value: { url: "https://example.org" } },
    );
    const result = applicable(state);
    expect(result.ok).toBe(true);
  });
});

describe("applicable: every problem of the active type, at its input", () => {
  test("name and value problems together", () => {
    const state = typed(
      newFieldForm(),
      { type: "kind", value: "quantity" },
      { type: "slot", kind: "quantity", value: { amount: "-1", unit: "kg" } },
    );
    expect(applicable(state)).toEqual({
      ok: false,
      problems: { name: "label_missing", amount: "amount_invalid" },
    });
  });

  test.each([
    [
      "date without a day",
      "date",
      { day: "", month: "3", year: "" },
      "date",
      "day_missing",
    ],
    [
      "an impossible date",
      "date",
      { day: "29", month: "2", year: "2023" },
      "date",
      "date_invalid",
    ],
    ["an empty link", "url", { url: "  " }, "url", "url_missing"],
    [
      "an unanswered yes or no",
      "boolean",
      { value: null },
      "boolean",
      "boolean_missing",
    ],
    ["no options", "choices", { options: [] }, "options", "options_missing"],
    ["no items", "checklist", { items: [] }, "items", "items_missing"],
  ] as const)("%s", (_name, kind, slot, at, problem) => {
    const state = typed(
      newFieldForm(),
      { type: "name", value: "X" },
      { type: "kind", value: kind },
      { type: "slot", kind, value: slot as never },
    );
    expect(applicable(state)).toEqual({
      ok: false,
      problems: { [at]: problem },
    });
  });

  test("a date without a year is sent with no year key at all", () => {
    const state = typed(
      newFieldForm(),
      { type: "name", value: "Birthday" },
      { type: "kind", value: "date" },
      {
        type: "slot",
        kind: "date",
        value: { day: "29", month: "2", year: "" },
      },
    );
    expect(applicable(state)).toEqual({
      ok: true,
      label: "Birthday",
      value: { kind: "date", month: 2, day: 29 },
    });
  });

  test("choices and checklists send labels and ids; checked ids are the items' own", () => {
    const state = typed(
      newFieldForm(),
      { type: "name", value: "Diet" },
      { type: "kind", value: "checklist" },
      {
        type: "slot",
        kind: "checklist",
        value: { items: [{ id: ID, label: " Nuts ", checked: true }] },
      },
    );
    expect(applicable(state)).toEqual({
      ok: true,
      label: "Diet",
      value: {
        kind: "checklist",
        items: [{ id: ID, label: "Nuts" }],
        checked: [ID],
      },
    });
  });
});

describe("fromField", () => {
  test("an existing value fills its own slot, keeps checklist ids and starts at revision 0", () => {
    const state = fromField(
      {
        label: "Diet",
        value: {
          kind: "checklist",
          items: [{ id: ID, label: "Nuts" }],
          checked: [ID],
        },
      },
      key,
    );
    expect(state.kind).toBe("checklist");
    expect(state.slots.checklist.items).toEqual([
      { id: ID, label: "Nuts", checked: true },
    ]);
    expect(state.slots.text.text).toBe("");
    expect(state.revision).toBe(0);
    // Saving it unchanged sends the same value, with the same item id.
    expect(applicable(state)).toEqual({
      ok: true,
      label: "Diet",
      value: {
        kind: "checklist",
        items: [{ id: ID, label: "Nuts" }],
        checked: [ID],
      },
    });
  });

  test("choices keep their selection", () => {
    const state = fromField(
      {
        label: "Size",
        value: { kind: "choices", options: ["S", "M"], selected: ["M"] },
      },
      key,
    );
    expect(
      state.slots.choices.options.map((o) => [o.label, o.selected]),
    ).toEqual([
      ["S", false],
      ["M", true],
    ]);
  });
});

describe("the save's ticket", () => {
  test("a success may end the session only for the revision it saved; any later change keeps it open", () => {
    const state = typed(newFieldForm(), { type: "name", value: "A" });
    const ticket = ticketOf(state);
    expect(isCurrent(state, ticket)).toBe(true);
    const later = reduceFieldForm(state, { type: "name", value: "AB" });
    expect(isCurrent(later, ticket)).toBe(false);
    // A hidden-slot edit is an edit too.
    const hidden = reduceFieldForm(state, {
      type: "slot",
      kind: "url",
      value: { url: "x" },
    });
    expect(isCurrent(hidden, ticket)).toBe(false);
  });
});
