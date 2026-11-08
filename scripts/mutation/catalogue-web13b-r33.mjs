// WEB-13b revision 33's mutants (review 40 F40-1 `calendar-import-file-control-accessibility` and F40-2
// `calendar-anchor-picker-loading-state`, both `new`; design assessment C1-C3, P1-P2, Q1-Q7), in the form and under the rules of
// `data-catalogue.mjs`, which spreads them into its `UNIT` list after `catalogue-web13b-r25.mjs`. Each removes ONE part of a correction;
// `expect` names the test written for it, so only an assertion of that test catches it.
//
// Considered and not selected (recorded for the reviewer):
// - the label id dropped from the button's `aria-describedby`: the drop zone's existing case (`reasonOf`, first token) and F40-1's label
//   assertion both see it; it restores no part of the defect (the label was always there).
// - F40-2's `Pages` while loading: unchanged by the correction ("Show previous" renders from the cursors, "Show next" only from a ready
//   page), so no mutant restores a defect there; Q5 asserts "Show previous" stays.
import { sub } from "./data-catalogue.mjs";

const DIALOG = "src/features/calendars/ImportDialog.tsx";
const PICKERS = "src/features/calendars/pickers.tsx";
const T_IMPORT = "tests/features/calendars/import-ui.test.tsx";
const T_ANCHOR = "tests/features/tasks/anchor-section.test.tsx";

const F40_1 = /F40-1: the file's refusal is the browse button's own error/;

export const UNIT_13B_R33 = [
  // ---- F40-1: the file control's refusal is its own error --------------------------------------------------------------------------
  {
    id: "MU-5250",
    title:
      "WEB-13b F40-1 (revision 33): the browse button is never invalid while the file is refused",
    file: DIALOG,
    tests: [T_IMPORT],
    expect: F40_1,
    patch: (t) =>
      sub(
        t,
        "aria-invalid={fileError === null ? undefined : true}",
        "aria-invalid={undefined}",
      ),
  },
  {
    id: "MU-5251",
    title:
      "WEB-13b F40-1 (revision 33): the browse button is described by its label alone while an error is shown (the original defect)",
    file: DIALOG,
    tests: [T_IMPORT],
    expect: F40_1,
    patch: (t) =>
      sub(
        t,
        ": `${fileInputId}-label ${fileErrorId}`",
        ": `${fileInputId}-label`",
      ),
  },
  {
    id: "MU-5252",
    title:
      "WEB-13b F40-1 (revision 33): the error element has no id, so the button's description names nothing",
    file: DIALOG,
    tests: [T_IMPORT],
    expect: F40_1,
    patch: (t) =>
      sub(
        t,
        '              id={fileErrorId}\n              data-field-error=""',
        '              data-field-error=""',
      ),
  },
  // ---- F40-2: a page that is not ready claims nothing --------------------------------------------------------------------------------
  {
    id: "MU-5253",
    title:
      "WEB-13b F40-2 (revision 33): the event picker's list ignores the read's state ('No events yet' while loading, the original defect)",
    file: PICKERS,
    tests: [T_ANCHOR],
    expect: /Q3 event picker: loading while held/,
    patch: (t) =>
      sub(
        t,
        '{page.status !== "ready" ? (\n        <PageState status={page.status} loading={EVENTS_LOADING} />',
        "{false ? (\n        <PageState status={page.status} loading={EVENTS_LOADING} />",
      ),
  },
  {
    id: "MU-5254",
    title:
      "WEB-13b F40-2 (revision 33): the field picker's list ignores the read's state ('No date fields on this device yet' while loading)",
    file: PICKERS,
    tests: [T_ANCHOR],
    expect: /Q4 field picker: loading while held/,
    patch: (t) =>
      sub(
        t,
        '{page.status !== "ready" ? (\n        <PageState status={page.status} loading={FIELDS_LOADING} />',
        "{false ? (\n        <PageState status={page.status} loading={FIELDS_LOADING} />",
      ),
  },
  {
    id: "MU-5255",
    title:
      "WEB-13b F40-2 (revision 33): an unreadable page is shown as loading for ever (`unavailable` treated as `loading`)",
    file: PICKERS,
    tests: [T_ANCHOR],
    expect: /Q3 event picker: loading while held/,
    patch: (t) =>
      sub(
        t,
        '  return status === "loading" ? (',
        '  return status !== ("never" as string) ? (',
      ),
  },
  {
    id: "MU-5256",
    title:
      "WEB-13b F40-2 (revision 33): the loading state is not busy (assistive technology is told nothing is pending)",
    file: PICKERS,
    tests: [T_ANCHOR],
    expect: /Q3 event picker: loading while held/,
    patch: (t) =>
      sub(
        t,
        '    <div data-picker-state="loading" aria-busy="true">',
        '    <div data-picker-state="loading">',
      ),
  },
];
