// @vitest-environment node
import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  checkImportText,
  checkWindow,
  defaultWindow,
  envelopeBytes,
  IMPORT_LIMITS,
  lineCount,
  readImportFile,
} from "../../../src/features/calendars/model/import";
import {
  type CorpusCase,
  corpusCases,
  corpusSource,
  corpusText,
} from "../../support/ics-corpus";
import { metered, WorkExceeded } from "../../support/work-meter";

/**
 * WEB-13b §4.1: the local checks of an `.ics` import mirror the released server's bounds (`v0.29.0-rc.1`, `ics.rs` `parse`): bytes, Rust
 * line semantics before unfolding, VEVENTs with overrides, the inclusive 0–730-day window with years 1900–9999, and the 2 MiB envelope.
 * Each bound is tested at the limit (accepted) and one past it (refused).
 */
const calendar = (events: number, extra = ""): string => {
  const out = ["BEGIN:VCALENDAR", "VERSION:2.0"];
  for (let n = 0; n < events; n += 1)
    out.push("BEGIN:VEVENT", `UID:${n}`, "END:VEVENT");
  out.push("END:VCALENDAR");
  return `${out.join("\r\n")}\r\n${extra}`;
};

describe("lines: Rust str::lines semantics", () => {
  test.each([
    ["", 0],
    ["a", 1],
    ["a\n", 1],
    ["a\nb", 2],
    ["\n", 1],
    ["\n\n", 2],
    ["a\r\nb\r\n", 2],
    // A folded line is still two physical lines (counted before unfolding).
    ["SUMMARY:long\r\n  continued\r\n", 2],
  ])("%j has %i lines", (text, count) => {
    expect(lineCount(text)).toBe(count);
  });

  test("20,000 lines are accepted and 20,001 are refused", () => {
    const at = calendar(0, "X:y\n".repeat(IMPORT_LIMITS.lines - 3));
    expect(lineCount(at)).toBe(IMPORT_LIMITS.lines);
    expect(checkImportText(at)).toMatchObject({ ok: true, lines: 20_000 });
    expect(checkImportText(`${at}X:y`)).toEqual({
      ok: false,
      reason: "too_many_lines",
    });
  });
});

describe("bytes: UTF-8 bytes of the text, not characters", () => {
  test("1 MiB exactly is accepted; one byte more is refused", () => {
    const head = calendar(0);
    const pad = "x".repeat(IMPORT_LIMITS.bytes - head.length);
    expect(checkImportText(head + pad)).toMatchObject({
      ok: true,
      bytes: IMPORT_LIMITS.bytes,
    });
    expect(checkImportText(`${head + pad}x`)).toEqual({
      ok: false,
      reason: "too_large",
    });
  });

  test("multibyte text is measured in bytes: fewer characters than the limit can be over it", () => {
    const head = calendar(0);
    // "é" is two bytes: half the limit in characters is the whole limit in bytes, plus the header.
    const text =
      head + "é".repeat(Math.ceil((IMPORT_LIMITS.bytes - head.length) / 2) + 1);
    expect(text.length).toBeLessThan(IMPORT_LIMITS.bytes);
    expect(checkImportText(text)).toEqual({ ok: false, reason: "too_large" });
  });
});

describe("events: VEVENT components, overrides included", () => {
  test("256 are accepted, 257 refused; an override (RECURRENCE-ID) is a component of its own", () => {
    expect(checkImportText(calendar(256))).toMatchObject({
      ok: true,
      events: 256,
    });
    expect(checkImportText(calendar(257))).toEqual({
      ok: false,
      reason: "too_many_events",
    });
    const override =
      "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a\r\nRRULE:FREQ=DAILY\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:a\r\nRECURRENCE-ID:20260101T000000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
    expect(checkImportText(override)).toMatchObject({ ok: true, events: 2 });
  });

  test("lower-case component lines are counted; a text without a calendar is refused", () => {
    expect(
      checkImportText(
        "begin:vcalendar\nbegin:vevent\nend:vevent\nend:vcalendar",
      ),
    ).toMatchObject({ ok: true, events: 1 });
    expect(checkImportText("hello\n")).toEqual({
      ok: false,
      reason: "not_calendar",
    });
  });
});

/*
 * Review 15 R12 (revision 14): components are recognised on the content lines the server's parser reads, not on physical lines. The
 * oracle is the pinned parser itself: `tests/fixtures/ics-parser/ical-0.11.0.json`, written by `scripts/generate-ics-parser-corpus.mjs`
 * from `ical` 0.11.0 (the released backend's dependency) over each recipe. A text whose hash differs from the one the parser read fails
 * here, so the recipe and the parser's answer cannot drift apart.
 */
const accepted = corpusCases.filter((entry) => entry.parser.status === "ok");
const refused = corpusCases.filter((entry) => entry.parser.status !== "ok");

/**
 * What this device answers for a file the SERVER refuses (`invalid_ics`): a pre-check, not the parser. The header is recognised wherever
 * it is and in any case, as before; counting goes on where the parser would stop with an error (the cautious answer).
 */
const REFUSED_BY_SERVER: Record<string, ReturnType<typeof checkImportText>> = {
  "gap-inside-calendar": { ok: false, reason: "too_many_events" },
  "gap-after-event": { ok: false, reason: "too_many_events" },
  "header-continued": { ok: false, reason: "not_calendar" },
  "header-leading-space": { ok: false, reason: "not_calendar" },
  "value-lower-case-257": { ok: false, reason: "too_many_events" },
  "not-calendar": { ok: false, reason: "not_calendar" },
  empty: { ok: false, reason: "not_calendar" },
};
const COUNTED_THOUGH_REFUSED: Record<string, number> = {
  "gap-before-header": 1,
  "header-lower-case": 1,
  "second-calendar": 2,
  "event-continued": 0,
  "fold-two-spaces": 0,
  "trailing-feff": 0,
  "unclosed-quote": 0,
};

describe("review 15 R12: components on the parser's content lines", () => {
  test("the corpus is the pinned parser's, and holds the cases the correction needs", () => {
    expect(corpusSource).toMatchObject({
      commit: "4396c99300d00798fc10e61d459f4d9fce699ee8",
      parser_files_sha256: {
        "src/line.rs":
          "8fa08985500b4e478a58d78063ac2e0f2a6472ebf84aa3fb7bd085d411e9dede",
      },
    });
    const names = corpusCases.map((entry) => entry.name);
    for (const name of [
      "header-folded-space",
      "header-folded-tab",
      "events-folded-256",
      "events-folded-257",
      "variants-256",
      "variants-257",
      "markers-in-text",
      "gap-after-end",
    ])
      expect(names).toContain(name);
    // Every case the server refuses has a stated local answer: none is left unchecked.
    expect(refused.map((entry) => entry.name).sort()).toEqual(
      [
        ...Object.keys(REFUSED_BY_SERVER),
        ...Object.keys(COUNTED_THOUGH_REFUSED),
      ].sort(),
    );
  });

  test.each(accepted.map((entry) => [entry.name, entry] as const))(
    "parser corpus %s: the parser's own count, the text unchanged",
    (_, entry: CorpusCase) => {
      const text = corpusText(entry);
      const events = (entry.parser as { events: number }).events;
      const check = checkImportText(text);
      if (events > IMPORT_LIMITS.events)
        expect(check).toEqual({ ok: false, reason: "too_many_events" });
      else {
        expect(check).toEqual({
          ok: true,
          ics: text,
          bytes: new TextEncoder().encode(text).length,
          lines: lineCount(text),
          events,
        });
        // The same string, not a normalised copy: what was checked is what is stored and sent.
        expect(check.ok && check.ics).toBe(text);
      }
    },
  );

  test.each(refused.map((entry) => [entry.name, entry] as const))(
    "refused by the server %s: this device's pre-check",
    (name, entry) => {
      const check = checkImportText(corpusText(entry));
      const counted = COUNTED_THOUGH_REFUSED[name];
      if (counted === undefined) expect(check).toEqual(REFUSED_BY_SERVER[name]);
      else expect(check).toMatchObject({ ok: true, events: counted });
    },
  );

  test("a folded file read from a Blob (with a byte-order mark) is checked and kept exactly as decoded", async () => {
    const text = corpusText("variants-256");
    const out = await readImportFile(
      new Blob([
        new Uint8Array([0xef, 0xbb, 0xbf]),
        new TextEncoder().encode(text),
      ]),
    );
    expect(out).toEqual({
      ok: true,
      ics: text,
      bytes: new TextEncoder().encode(text).length,
      lines: lineCount(text),
      events: 256,
    });
    expect(
      await readImportFile(
        new Blob([new TextEncoder().encode(corpusText("events-folded-257"))]),
      ),
    ).toEqual({ ok: false, reason: "too_many_events" });
  });

  test("the line bound still counts PHYSICAL lines: folding does not lower it", () => {
    // 20,001 physical lines that unfold into a few content lines are still over the bound.
    const head = "BEGIN:VCALENDAR\r\nX-LONG:a\r\n";
    const tail = "BEGIN:VEVENT\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
    const folds = IMPORT_LIMITS.lines - lineCount(head + tail);
    const at = `${head}${" b\r\n".repeat(folds)}${tail}`;
    expect(lineCount(at)).toBe(IMPORT_LIMITS.lines);
    expect(checkImportText(at)).toMatchObject({
      ok: true,
      lines: IMPORT_LIMITS.lines,
      events: 1,
    });
    expect(
      checkImportText(`${head}${" b\r\n".repeat(folds + 1)}${tail}`),
    ).toEqual({ ok: false, reason: "too_many_lines" });
  });
});

/**
 * Review 16 R13: the check runs synchronously on the page, so its work must grow with the file, not with the square of a line's
 * parameters. The work is counted by `metered` (tests/support/work-meter.ts: code units read or written through the built-in methods)
 * and held to a bound worked out from the algorithm, not from a measurement. For a text of N code units in P `\n`-separated segments:
 *
 *  - encoding N + 1; `lineCount` N + 3 (its searches end where the next begins);
 *  - `physicalLines` and `contentLines` 7N + 6P + 2: the split; per segment the `\r` test and slice, and `trim`/`trimEnd` reading each
 *    code unit at most twice and copying it at most twice; the join;
 *  - per content line of m code units, 13m + 10: the two name searches and the name; the parameters, where each search starts at the
 *    position and stops at the parser's nearest delimiter, so a code unit is inspected at most five times (by the search that reaches it,
 *    the checks of the delimiter it is, and the skip of its run); the value; and both upper-casings, which read and write.
 *
 * The sum is at most 22N + 16P + 16. The revision-14 scanner, which searched the whole rest of the line for `;`, `:` and `,` at every
 * parameter value, needs about 64 million at 4,000 parameters (Review 16's work probe), against this bound's few hundred thousand.
 */
const workBound = (text: string): number =>
  22 * text.length + 16 * text.split("\n").length + 16;

/** The calendar of Review 16's probes (`parameter-browser.mjs` `make`), byte for byte. */
const reviewCalendar = (n: number, kind: "summary" | "begin" | "plain") =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN${kind === "begin" ? ";X=A".repeat(n) : ""}:VEVENT\r\nUID:x\r\nDTSTART;VALUE=DATE:20261101\r\nSUMMARY${kind === "summary" ? ";X=A".repeat(n) : ""}:${kind === "plain" ? "x".repeat(4 * n) : "Review"}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;

/** One event whose lines are the given ones (each a content line, CRLF ends). */
const eventWith = ({
  begin = "BEGIN:VEVENT",
  summary = "SUMMARY:Review",
  end = "END:VEVENT",
}: {
  begin?: string;
  summary?: string;
  end?: string;
}) =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${begin}\r\nUID:x\r\n${summary}\r\n${end}\r\nEND:VCALENDAR\r\n`;

/** A content line folded as a writer of the format does: a CRLF and a space after every 74 code units. */
const folded = (line: string): string =>
  (line.match(/[\s\S]{1,74}/g) ?? []).join("\r\n ");

/** Each shape at n parameters (or n code units of value) and the check's answer for it. */
const SHAPES: ReadonlyArray<
  readonly [string, (n: number) => string, { ok: true; events: number }]
> = [
  [
    "an ordinary property's parameters",
    (n) => reviewCalendar(n, "summary"),
    { ok: true, events: 1 },
  ],
  [
    "a component line's parameters",
    (n) => reviewCalendar(n, "begin"),
    { ok: true, events: 1 },
  ],
  [
    "an END line's parameters",
    (n) => eventWith({ end: `END${";X=A".repeat(n)}:VEVENT` }),
    { ok: true, events: 1 },
  ],
  [
    "quoted values holding delimiters",
    (n) => eventWith({ summary: `SUMMARY${';X="a:b"'.repeat(n)}:Review` }),
    { ok: true, events: 1 },
  ],
  [
    "listed values",
    (n) => eventWith({ begin: `BEGIN${";X=a,b,c".repeat(n)}:VEVENT` }),
    { ok: true, events: 1 },
  ],
  [
    "a list past the ten-value limit",
    (n) => eventWith({ summary: `SUMMARY;X=${"a,".repeat(n)}:Review` }),
    { ok: true, events: 1 },
  ],
  [
    "a run of semicolons",
    (n) => eventWith({ summary: `SUMMARY${";".repeat(n)}X=1:Review` }),
    { ok: true, events: 1 },
  ],
  [
    "one long parameter value",
    (n) => eventWith({ summary: `SUMMARY;X=${"a".repeat(4 * n)}:Review` }),
    { ok: true, events: 1 },
  ],
  [
    "folded component parameters",
    (n) => eventWith({ begin: folded(`BEGIN${";X=A".repeat(n)}:VEVENT`) }),
    { ok: true, events: 1 },
  ],
  [
    // The parser fails on the line (no value after the last parameter), so it is not a component; the server refuses the file.
    "a component line with no value",
    (n) => eventWith({ begin: `BEGIN${";X=A".repeat(n)}` }),
    { ok: true, events: 0 },
  ],
  [
    "no parameters (control)",
    (n) => reviewCalendar(n, "plain"),
    { ok: true, events: 1 },
  ],
];

/** Checks `text` under the meter; past its bound the meter stops it at once and the assertion reports the work it had reached. */
function measuredCheck(text: string) {
  const bound = workBound(text);
  let work: number;
  let check: ReturnType<typeof checkImportText> | undefined;
  try {
    ({ work, result: check } = metered(bound, () => checkImportText(text)));
  } catch (error) {
    if (!(error instanceof WorkExceeded)) throw error;
    work = error.work;
  }
  expect(work, `work for ${text.length} code units`).toBeLessThanOrEqual(bound);
  return { work, check };
}

describe("review 16 R13: the check's work grows with the file, not with a line's parameters squared", () => {
  test("the meter counts searches to where they stop, and leaves every answer unchanged", () => {
    const text = `;X=A${";X=A".repeat(9)}:v`;
    const { work, result } = metered(1_000, () => [
      text.indexOf(":"),
      text.indexOf(","),
      text.indexOf(";", 4),
      text.slice(0, 4),
      text.charCodeAt(0),
    ]);
    expect(result).toEqual([40, -1, 4, ";X=A", 0x3b]);
    // 41 + 42 (to the end: no comma) + 1 + 5 + 1.
    expect(work).toBe(90);
    expect(() => metered(10, () => text.indexOf(","))).toThrow(WorkExceeded);
    // The wrappers are gone afterwards.
    expect(String.prototype.indexOf.toString()).toContain("[native code]");
  });

  test.each(SHAPES)(
    "%s: within the bound at n, 2n and 4n, and growing linearly",
    (_, shape, answer) => {
      const runs = [1_000, 2_000, 4_000].map((n) => {
        const text = shape(n);
        const { work, check } = measuredCheck(text);
        expect(check).toMatchObject(answer);
        // What was checked is what would be stored and sent.
        expect(check?.ok && check.ics).toBe(text);
        return work;
      });
      const [one, two, four] = runs as [number, number, number];
      // Linear work with a fixed part grows at most in proportion; the revision-14 scanner grew about fourfold per doubling.
      expect(two).toBeLessThanOrEqual(2 * one);
      expect(four).toBeLessThanOrEqual(4 * one);
    },
  );

  test.each([
    [
      "full",
      "summary",
      "10db691359374c914735fc53594cfed98e3cd4b6ad903e4ad96ec63aad6f25ee",
    ],
    [
      "begin-full",
      "begin",
      "dddedd5d21f925822d97b74c5a26ef7038fe36256cabd497a58635be2b604b08",
    ],
    [
      "plain-full",
      "plain",
      "7db16f593768f4fcd4310bb62c1da6f76c6dbffd15bdf26f828a286091895376",
    ],
  ] as const)(
    "Review 16's %s file (262,000 parameters, just under 1 MiB) is checked within the bound, one event, the text unchanged",
    (_, kind, sha256) => {
      const text = reviewCalendar(262_000, kind);
      expect(createHash("sha256").update(text).digest("hex")).toBe(sha256);
      expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(
        IMPORT_LIMITS.bytes,
      );
      const { check } = measuredCheck(text);
      expect(check).toEqual({
        ok: true,
        ics: text,
        bytes: new TextEncoder().encode(text).length,
        lines: lineCount(text),
        events: 1,
      });
    },
  );

  test("the corpus holds the parameter rules the scanner keeps, each answered by the parser", () => {
    const names = corpusCases.map((entry) => entry.name);
    for (const name of [
      "parameters-256",
      "parameters-257",
      ...Array.from({ length: 10 }, (_, at) => `parameter-${at + 1}-257`),
      "parameters-summary-many",
      "parameters-begin-many",
      "end-eleven-values-then-gap",
      "end-parameters-then-gap",
    ])
      expect(names).toContain(name);
  });
});

describe("the coverage window", () => {
  test.each([
    ["2026-01-01", "2026-01-01", { ok: true }],
    ["2026-01-01", "2028-01-01", { ok: true }], // 730 days (2026 and 2027 have 365 each)
    [
      "2026-01-01",
      "2028-01-02",
      { ok: false, field: "through", reason: "span" },
    ],
    [
      "2026-01-02",
      "2026-01-01",
      { ok: false, field: "through", reason: "span" },
    ],
    ["1900-01-01", "1900-12-31", { ok: true }],
    ["1899-12-31", "1900-01-01", { ok: false, field: "from", reason: "range" }],
    ["9999-01-01", "9999-12-31", { ok: true }],
    ["0050-01-01", "0050-02-01", { ok: false, field: "from", reason: "range" }],
    [
      "2026-02-30",
      "2026-03-01",
      { ok: false, field: "from", reason: "format" },
    ],
    ["2026-1-01", "2026-03-01", { ok: false, field: "from", reason: "format" }],
    ["2026-01-01", "", { ok: false, field: "through", reason: "format" }],
  ])("%s to %s", (from, through, expected) => {
    expect(checkWindow(from, through)).toEqual(expected);
  });

  test("the default window is today through 364 days later (a span the server accepts)", () => {
    expect(defaultWindow("2026-10-25")).toEqual({
      from: "2026-10-25",
      through: "2027-10-24",
    });
    const { from, through } = defaultWindow("2028-02-29");
    expect(checkWindow(from, through)).toEqual({ ok: true });
  });
});

describe("the envelope", () => {
  test("is the UTF-8 bytes of the JSON body; escaping can take a 1 MiB file over 2 MiB", () => {
    const quotes = '"'.repeat(IMPORT_LIMITS.bytes - 20);
    expect(
      envelopeBytes({ ics: quotes, from: "2026-01-01", through: "2026-12-31" }),
    ).toBeGreaterThan(IMPORT_LIMITS.envelopeBytes);
    expect(
      envelopeBytes({ ics: "é", from: "2026-01-01", through: "2026-12-31" }),
    ).toBe(
      new TextEncoder().encode(
        JSON.stringify({ from: "2026-01-01", ics: "é", through: "2026-12-31" }),
      ).length,
    );
  });
});

describe("reading a file", () => {
  test("valid UTF-8 is decoded and checked; a byte-order mark is dropped", async () => {
    const text = calendar(1);
    const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
    const out = await readImportFile(
      new Blob([bom, new TextEncoder().encode(text)]),
    );
    expect(out).toMatchObject({ ok: true, ics: text, events: 1 });
  });

  test("invalid UTF-8 is refused (a fatal decode), nothing is guessed", async () => {
    const out = await readImportFile(
      new Blob([
        new TextEncoder().encode("BEGIN:VCALENDAR\n"),
        new Uint8Array([0xff, 0xfe]),
      ]),
    );
    expect(out).toEqual({ ok: false, reason: "not_utf8" });
  });

  test("a file larger than the limit is refused without being read", async () => {
    let read = false;
    const big = {
      size: IMPORT_LIMITS.bytes + 4,
      arrayBuffer: async () => {
        read = true;
        return new ArrayBuffer(0);
      },
    } as unknown as Blob;
    expect(await readImportFile(big)).toEqual({
      ok: false,
      reason: "too_large",
    });
    expect(read).toBe(false);
  });

  test("a file that cannot be read is said to be unreadable", async () => {
    const broken = {
      size: 10,
      arrayBuffer: async () => {
        throw new DOMException("gone", "NotReadableError");
      },
    } as unknown as Blob;
    expect(await readImportFile(broken)).toEqual({
      ok: false,
      reason: "unreadable",
    });
  });
});
