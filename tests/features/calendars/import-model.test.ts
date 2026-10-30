// @vitest-environment node
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
