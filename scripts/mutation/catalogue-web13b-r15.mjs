// WEB-13b revision 15's mutants (review 16 R13 `regression`, family calendar-import-parameter-scan-complexity; design assessment C2 and
// Q2), in the form and under the rules of `data-catalogue.mjs`, which spreads them into its `UNIT` list after `catalogue-web13b-r14.mjs`.
// Each restores ONE part of the defect the revision corrected (every parameter value searched the whole rest of the line, so the check
// was quadratic on the page's main thread) or breaks one rule of the pinned parser the linear scanner keeps; `expect` names the tests
// written for it, so only an assertion of those tests catches it.
//
// The work mutants are judged by the model file alone: its meter stops a call past the declared bound at once, so they fail on the
// bound's assertion in milliseconds. The rendered 1 MiB test would instead run the quadratic scan for seconds (a timeout, never a catch).
//
// Considered and not selected (recorded for the reviewer): searching `=` from the start of the line moves the position backwards and
// never ends (a timeout, never a catch); skipping only ONE `;` or `,` of a run reads an empty key or value the parser also accepts, so no
// file's answer changes (equivalent).
import { sub } from "./data-catalogue.mjs";

const IMPORT_MODEL = "src/features/calendars/model/import.ts";
const T_IMPORT_MODEL = "tests/features/calendars/import-model.test.ts";

/** From the first scanner helper to the end of `contentLine`: the whole of what revision 15 rewrote. */
const SCANNER =
  /const SEMICOLON = 0x3b;\n[\s\S]*?\n {2}return \{ name, value: at === line\.length \? null : line\.slice\(at\) \};\n\}\n/;

// Revision 14's scanner, verbatim (a64365072ab7111063669e11fe5dc24c556ee396), after the `find` helper both revisions share.
const REVISION_14_SCANNER = `function trimStartOf(text: string, char: string): string {
  let start = 0;
  while (text[start] === char) start += 1;
  return text.slice(start);
}

function contentLine(
  line: string,
): { name: string; value: string | null } | null {
  const param = find(line, ";");
  const value = find(line, ":");
  let end: number;
  if (param < value && param !== 0) end = param;
  else if (value !== Number.POSITIVE_INFINITY && value !== 0) end = value;
  else return null;
  const name = line.slice(0, end);
  let rest = line.slice(end);
  if (
    find(rest, ";") !== Number.POSITIVE_INFINITY &&
    find(rest, ":") > find(rest, ";")
  )
    while (rest.startsWith(";")) {
      rest = trimStartOf(rest, ";");
      const equals = rest.indexOf("=");
      if (equals <= 0) return null;
      rest = rest.slice(equals + 1);
      for (let values = 10; values > 0; ) {
        values -= 1;
        if (rest.startsWith('"')) {
          const close = rest.indexOf('"', 1);
          if (close === -1) return null;
          rest = rest.slice(close + 1);
        } else {
          const nextParam = find(rest, ";");
          const nextValue = find(rest, ":");
          const nextListed = find(rest, ",");
          if (nextListed < nextValue && nextListed < nextParam)
            rest = rest.slice(nextListed);
          else if (nextParam < nextValue && nextParam < nextListed)
            rest = rest.slice(nextParam);
          else if (nextValue !== Number.POSITIVE_INFINITY)
            rest = rest.slice(nextValue);
          else return null;
        }
        if (!rest.startsWith(",")) break;
        rest = trimStartOf(rest, ",");
      }
    }
  rest = trimStartOf(rest, ":");
  return { name, value: rest === "" ? null : rest };
}
`;

/** The R13 work tests a quadratic parameter scan of SUMMARY and of component lines fails. */
const WORK_ALL =
  /review 16 R13.*(an ordinary property's parameters|a component line's parameters|an END line's parameters|listed values|folded component parameters|Review 16's (full|begin-full) file)/;
/** Those of component (BEGIN/END) lines alone. */
const WORK_COMPONENTS =
  /review 16 R13.*(a component line's parameters|an END line's parameters|listed values|folded component parameters|Review 16's begin-full file)/;

export const UNIT_13B_R15 = [
  {
    id: "MU-2748",
    title:
      "WEB-13b R13 (revision 15): the original defect — revision 14's scanner, verbatim: every parameter value searches the whole rest of the line for `;`, `:` and `,` (quadratic work on the main thread)",
    file: IMPORT_MODEL,
    tests: [T_IMPORT_MODEL],
    expect: WORK_ALL,
    patch: (t) => sub(t, SCANNER, REVISION_14_SCANNER),
  },
  {
    id: "MU-2749",
    title:
      "WEB-13b R13 (revision 15): the position is kept, but a raw value's end is found by three separate searches to the end of the line (the same answers; an absent delimiter is searched for again at every value)",
    file: IMPORT_MODEL,
    tests: [T_IMPORT_MODEL],
    expect:
      /review 16 R13.*(an ordinary property's parameters|a component line's parameters|an END line's parameters|listed values|folded component parameters|a component line with no value|Review 16's (full|begin-full) file)/,
    patch: (t) =>
      sub(
        t,
        "  for (let next = at; next < line.length; next += 1) {\n    const code = line.charCodeAt(next);\n    if (code === SEMICOLON || code === COLON || code === COMMA) return next;\n  }\n  return -1;\n",
        '  const ends = [";", ":", ","].map((c) => line.indexOf(c, at)).filter((n) => n !== -1);\n  return ends.length === 0 ? -1 : Math.min(...ends);\n',
      ),
  },
  {
    id: "MU-2750",
    title:
      "WEB-13b R13 (revision 15): ordinary properties are skipped, but component lines keep revision 14's scanner (BEGIN and END parameters are still quadratic)",
    file: IMPORT_MODEL,
    tests: [T_IMPORT_MODEL],
    expect: WORK_COMPONENTS,
    patch: (t) =>
      sub(
        t,
        SCANNER,
        REVISION_14_SCANNER.replace(
          "  const name = line.slice(0, end);\n",
          "  const name = line.slice(0, end);\n  if (!/^(BEGIN|END)$/i.test(name)) return { name, value: null };\n",
        ),
      ),
  },
  {
    id: "MU-2751",
    title:
      'WEB-13b R13 (revision 15): a `,` does not end a raw parameter value (a list then a quoted value `a,"b:c"` ends at the quoted `:`)',
    file: IMPORT_MODEL,
    tests: [T_IMPORT_MODEL],
    expect: /parser corpus (parameters-25[67]|parameter-1-257)/,
    patch: (t) =>
      sub(
        t,
        "    if (code === SEMICOLON || code === COLON || code === COMMA) return next;\n",
        "    if (code === SEMICOLON || code === COLON) return next;\n",
      ),
  },
  {
    id: "MU-2752",
    title:
      "WEB-13b R13 (revision 15): the parser's ten-value limit of a parameter list is not kept (an END with eleven listed values fails to parse, so the calendar is never seen to end)",
    file: IMPORT_MODEL,
    tests: [T_IMPORT_MODEL],
    expect: /parser corpus end-eleven-values-then-gap/,
    patch: (t) =>
      sub(
        t,
        "    for (let values = 10; values > 0; ) {\n      values -= 1;\n",
        "    for (;;) {\n",
      ),
  },
  {
    id: "MU-2753",
    title:
      "WEB-13b R13 (revision 15): a quoted value's closing quote is searched from its opening quote (the value ends at once; its `:` is read as the property's)",
    file: IMPORT_MODEL,
    tests: [T_IMPORT_MODEL],
    expect:
      /parser corpus (variants-25[67]|variant-10-257|parameters-25[67]|parameter-(1|7)-257)/,
    patch: (t) =>
      sub(
        t,
        "        const close = line.indexOf('\"', at + 1);\n",
        "        const close = line.indexOf('\"', at);\n",
      ),
  },
  {
    id: "MU-2754",
    title:
      "WEB-13b R13 (revision 15): the value is read from where the name ended, not after the parameters (`BEGIN;X-A=1:VEVENT` is not counted)",
    file: IMPORT_MODEL,
    tests: [T_IMPORT_MODEL],
    expect:
      /parser corpus (variants-25[67]|variant-(9|10)-257|parameters-25[67]|parameter-([1-9]|10)-257|parameters-begin-many)/,
    patch: (t) =>
      sub(
        t,
        "  at = skip(line, at, COLON);\n",
        "  at = skip(line, end, COLON);\n",
      ),
  },
];
