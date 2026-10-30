// WEB-13b revision 14's mutants (review 15 R12 `new`, family calendar-import-logical-line-validation; design assessment C2 and its
// mutation list), in the form and under the rules of `data-catalogue.mjs`, which spreads them into its `UNIT` list after
// `catalogue-web13b-r13.mjs`. Each restores ONE part of the defect the revision corrected (components recognised on physical lines, so a
// folded or otherwise rewritten `BEGIN:VEVENT` was not counted and the 256 bound was bypassed) or breaks one rule of the pinned parser
// the correction ports; `expect` names the tests written for it, so only an assertion of those tests catches it. The oracle of the
// `parser corpus` and `refused by the server` cases is `ical` 0.11.0 itself (tests/fixtures/ics-parser/ical-0.11.0.json).
//
// Considered and not selected (recorded for the reviewer): the 10-value limit of a parameter list (`values`) is unreachable by any
// file the corpus or a real calendar holds and changes only which malformed file is refused; the `equals <= 0` and `close === -1`
// refusals return null, which skips a line the server refuses the file for anyway (a different local answer for an invalid file only);
// the `else if (saved === undefined) return out` end has no other exit (removing it loops forever: a timeout, never a catch).
import { sub } from "./data-catalogue.mjs";

const IMPORT_MODEL = "src/features/calendars/model/import.ts";
const T_IMPORT_MODEL = "tests/features/calendars/import-model.test.ts";
const T_IMPORT_UI = "tests/features/calendars/import-ui.test.tsx";

const UNFOLD = '/\\r?\\n[ \\t]/g, ""';

export const UNIT_13B_R14 = [
  {
    id: "MU-2733",
    title:
      "WEB-13b R12 (revision 14): the original defect — components are recognised on PHYSICAL lines (a folded header is not a calendar, a folded or rewritten BEGIN:VEVENT is not counted, 257 pass)",
    file: IMPORT_MODEL,
    tests: [T_IMPORT_MODEL, T_IMPORT_UI],
    expect:
      /parser corpus (header-folded|events-folded|variants)|R12: a folded calendar header|R12: 256 components however|R12: 257 folded components/,
    patch: (t) =>
      sub(
        t,
        / {2}let calendar = false;\n[\s\S]*?\n {2}if \(!calendar\)/,
        '  let calendar = false;\n  let events = 0;\n  for (const line of ics.split("\\n").map((l) => (l.endsWith("\\r") ? l.slice(0, -1) : l))) {\n    const upper = line.toUpperCase();\n    if (upper === "BEGIN:VCALENDAR") calendar = true;\n    else if (upper === "BEGIN:VEVENT") events += 1;\n  }\n  if (!calendar)',
      ),
  },
  {
    id: "MU-2734",
    title:
      "WEB-13b R12 (revision 14): a TAB does not continue a line (only a space folds)",
    file: IMPORT_MODEL,
    tests: [T_IMPORT_MODEL, T_IMPORT_UI],
    expect:
      /parser corpus (header-folded-tab|header-folded-many|variants-25[67]|variant-2-257|overrides-folded)|R12: the drop zone's Browse checks header-folded-tab|R12: a folded calendar header/,
    patch: (t) =>
      sub(
        t,
        "      if (first === 0x20 || first === 0x09) parts.push(trimEnd(line.slice(1)));\n",
        "      if (first === 0x20) parts.push(trimEnd(line.slice(1)));\n",
      ),
  },
  {
    id: "MU-2735",
    title:
      "WEB-13b R12 (revision 14): a continuation keeps its folding space (`BEGIN:` + ` VEVENT` reads `BEGIN: VEVENT`)",
    file: IMPORT_MODEL,
    tests: [T_IMPORT_MODEL, T_IMPORT_UI],
    expect:
      /parser corpus (header-folded|events-folded|variants-25[67]|variant-[1-4]-257|overrides-folded)|R12: a folded calendar header|R12: 256 components however|R12: 257 folded components/,
    patch: (t) =>
      sub(
        t,
        "parts.push(trimEnd(line.slice(1)));\n",
        "parts.push(trimEnd(line));\n",
      ),
  },
  {
    id: "MU-2736",
    title:
      "WEB-13b R12 (revision 14): an empty line ends a folded line (the parser skips it and still joins the continuation after it)",
    file: IMPORT_MODEL,
    tests: [T_IMPORT_MODEL],
    expect: /parser corpus (variants-25[67]|variant-4-257)/,
    patch: (t) =>
      sub(
        t,
        '      if (line === "") continue;\n',
        '      if (line === "") break;\n',
      ),
  },
  {
    id: "MU-2737",
    title:
      "WEB-13b R12 (revision 14): trailing white space is kept (`BEGIN:VEVENT ` and a header with a trailing tab are not recognised)",
    file: IMPORT_MODEL,
    tests: [T_IMPORT_MODEL],
    expect:
      /parser corpus (header-trailing-space|variants-25[67]|variant-[5-8]-257)/,
    patch: (t) =>
      sub(
        t,
        "  while (end > 0 && isSpace(text.charCodeAt(end - 1))) end -= 1;\n",
        "",
      ),
  },
  {
    id: "MU-2738",
    title:
      "WEB-13b R12 (revision 14): JavaScript's white space instead of Rust's (U+0085 is kept, U+FEFF removed)",
    file: IMPORT_MODEL,
    tests: [T_IMPORT_MODEL],
    expect:
      /parser corpus (variants-25[67]|variant-7-257)|refused by the server trailing-feff/,
    patch: (t) =>
      sub(
        sub(
          t,
          "  while (end > 0 && isSpace(text.charCodeAt(end - 1))) end -= 1;\n  return text.slice(0, end);\n",
          "  return text.trimEnd();\n",
        ),
        "  while (start < text.length && isSpace(text.charCodeAt(start))) start += 1;\n  return trimEnd(text.slice(start));\n",
        "  return text.trim();\n",
      ),
  },
  {
    id: "MU-2739",
    title:
      "WEB-13b R12 (revision 14): the design assessment's rejected alternative — a bare regular-expression unfold and a search for the marker (text inside a property counts; parameters, `::`, blank lines and gaps are missed)",
    file: IMPORT_MODEL,
    tests: [T_IMPORT_MODEL],
    expect:
      /parser corpus (markers-in-text|variants-25[67]|variant-(4|9|10|11)-257|gap-after-end|crcrlf-after-end|stray-end-then-gap)/,
    patch: (t) =>
      sub(
        t,
        '  if (!calendar) return { ok: false, reason: "not_calendar" };\n',
        `  events = (ics.replace(${UNFOLD}).match(/BEGIN:VEVENT/gi) ?? []).length;\n  if (!calendar) return { ok: false, reason: "not_calendar" };\n`,
      ),
  },
  {
    id: "MU-2740",
    title:
      "WEB-13b R12 (revision 14): only ONE leading `:` is removed from a value (`BEGIN::VEVENT` is not counted; the parser removes them all)",
    file: IMPORT_MODEL,
    tests: [T_IMPORT_MODEL],
    expect: /parser corpus (variants-25[67]|variant-11-257)/,
    patch: (t) =>
      sub(
        t,
        '  rest = trimStartOf(rest, ":");\n',
        '  if (rest.startsWith(":")) rest = rest.slice(1);\n',
      ),
  },
  {
    id: "MU-2741",
    title:
      "WEB-13b R12 (revision 14): a name runs to the first `:` (parameters are part of it: `BEGIN;X-A=1:VEVENT` is not counted)",
    file: IMPORT_MODEL,
    tests: [T_IMPORT_MODEL],
    expect: /parser corpus (variants-25[67]|variant-(9|10)-257)/,
    patch: (t) =>
      sub(
        t,
        "  if (param < value && param !== 0) end = param;\n",
        "  if (false) end = param;\n",
      ),
  },
  {
    id: "MU-2742",
    title:
      'WEB-13b R12 (revision 14): a quoted parameter value is not honoured (`X-A="a:b"` ends at its `:`, so the value is wrong)',
    file: IMPORT_MODEL,
    tests: [T_IMPORT_MODEL],
    expect: /parser corpus (variants-25[67]|variant-10-257)/,
    patch: (t) =>
      sub(
        t,
        "        if (rest.startsWith('\"')) {\n",
        "        if (false) {\n",
      ),
  },
  {
    id: "MU-2743",
    title:
      "WEB-13b R12 (revision 14): a gap straight after the calendar's END does not end the reading (what the server ignores is counted: a valid file is refused)",
    file: IMPORT_MODEL,
    tests: [T_IMPORT_MODEL],
    expect: /parser corpus (gap-after-end|crcrlf-after-end|stray-end-then-gap)/,
    patch: (t) => sub(t, "      if (closed) break;\n", ""),
  },
  {
    id: "MU-2744",
    title:
      "WEB-13b R12 (revision 14): any END followed by a gap ends the reading (an event's END too: the rest of a file the server refuses goes uncounted)",
    file: IMPORT_MODEL,
    tests: [T_IMPORT_MODEL],
    expect: /refused by the server gap-after-event/,
    patch: (t) =>
      sub(t, "        closed = depth === 0;\n", "        closed = true;\n"),
  },
  {
    id: "MU-2745",
    title:
      "WEB-13b R12 (revision 14): END does not close the open component (the calendar is never seen to end)",
    file: IMPORT_MODEL,
    tests: [T_IMPORT_MODEL],
    expect: /parser corpus (gap-after-end|crcrlf-after-end|stray-end-then-gap)/,
    patch: (t) => sub(t, "        depth -= 1;\n", ""),
  },
  {
    id: "MU-2746",
    title:
      "WEB-13b R12 (revision 14): the checked text is NORMALISED (unfolded) before it is kept, stored and sent",
    file: IMPORT_MODEL,
    tests: [T_IMPORT_MODEL, T_IMPORT_UI],
    expect:
      /parser corpus (header-folded|events-folded-256|variants-256|overrides-folded)|R12: a folded calendar header|R12: 256 components however|R12: the drop zone's (Browse checks header-folded-tab|a page drop checks overrides-folded)/,
    patch: (t) =>
      sub(
        t,
        "  return { ok: true, ics, bytes, lines: count, events };\n",
        `  return { ok: true, ics: ics.replace(${UNFOLD}), bytes, lines: count, events };\n`,
      ),
  },
  {
    id: "MU-2747",
    title:
      "WEB-13b R12 (revision 14): a component's NAME is matched case-sensitively (`begin:VEVENT`, which the parser counts, is not)",
    file: IMPORT_MODEL,
    tests: [T_IMPORT_MODEL],
    expect:
      /parser corpus (variants-25[67]|variant-12-257)|lower-case component lines are counted/,
    patch: (t) =>
      sub(
        t,
        "    const name = property.name.toUpperCase();\n",
        "    const name = property.name;\n",
      ),
  },
];
