// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  type Answer,
  assess,
  type Counter,
  type LedgerInput,
  type OracleEvent,
  type PageState,
  parseCounter,
  type WitnessEvent,
} from "../e2e/display-ledger";
import { EVIDENCE_COOKIE } from "../e2e/display-recorder";

/**
 * WEB-08c revision 5 (R5-B of the review of 14 October 2026; design assessment P2/P3, Q1, schedules S9-S17): the document ledger on
 * explicit histories. Each document is a witness identity; enrolment and evidence never transfer between documents, pages, URLs or frames.
 * Native correlation (that real engines deliver these events) is qualified in `fixture.lifecycle-oracle.spec.ts`.
 */
const URL_A = "http://app.test/review-doc?slow=1";
const URL_B = "http://app.test/review-doc?oracle=off";
const URL_C = "http://app.test/review-doc?last=1";

class History {
  witness: WitnessEvent[] = [];
  reports: OracleEvent[] = [];
  answers: Answer[] = [];
  counters: Counter[] = [];
  pages = new Map<number, PageState>();
  page(id: number) {
    let p = this.pages.get(id);
    if (!p) {
      p = { page: id, loads: [], inspection: { state: "closed" } };
      this.pages.set(id, p);
    }
    return p;
  }
  /** A document committed in a page: witnessed, with its terminal counter. */
  document(
    page: number,
    doc: string,
    url: string,
    opts: { enrol?: boolean; load?: boolean; main?: boolean } = {},
  ) {
    const main = opts.main ?? true;
    this.page(page);
    this.witness.push({
      page,
      main,
      doc,
      role: main ? "main" : "sub",
      type: "document",
      url,
    });
    const counter: Counter = {
      doc,
      enrolled: false,
      loaded: false,
      sequence: 0,
    };
    if (main) this.counters.push(counter);
    if (opts.enrol ?? true) {
      counter.enrolled = true;
      counter.sequence = 1;
      this.reports.push({ page, main, doc, type: "enrolled", sseq: 1, url });
    }
    if (opts.load ?? true) {
      counter.loaded = true;
      this.page(page).loads.push(url);
      this.witness.push({ page, main, doc, role: "main", type: "loaded", url });
    }
    return counter;
  }
  violation(
    page: number,
    doc: string,
    counter: Counter | null,
    deliver = true,
  ) {
    const sseq = (counter?.sequence ?? 1) + 1;
    if (counter) counter.sequence = sseq;
    if (deliver)
      this.reports.push({
        page,
        main: true,
        doc,
        type: "violation",
        sseq,
        violation: { doc, seq: 9, kind: "marker", detail: "x", record: null },
      });
  }
  open(page: number, doc: string, url: string, sseq = 1) {
    this.page(page).inspection = { state: "answered", doc, url };
    this.answers.push({
      page,
      doc,
      role: "main",
      sseq,
      violations: [],
      limits: [],
    });
  }
  input(extra: Partial<LedgerInput> = {}): LedgerInput {
    return {
      pages: [...this.pages.values()],
      witness: this.witness,
      reports: this.reports,
      answers: this.answers,
      counters: this.counters,
      ...extra,
    };
  }
}

describe("S10: an interrupted enrolled document cannot pay another document's deficit (the review's schedule)", () => {
  test("D1 committed with a held stylesheet (enrolled, never loaded) → D2 loaded with the recorder off → D3 normal: D2 is missing", () => {
    const h = new History();
    h.document(1, "d1", URL_A, { load: false });
    h.document(1, "d2", URL_B, { enrol: false });
    h.document(1, "d3", URL_C);
    h.open(1, "d3", URL_C);
    const result = assess(h.input());
    expect(result.loaded).toBe(2);
    expect(result.missing).toEqual([
      `document d2 of page 1 (${URL_B}) did not enrol`,
    ]);
    expect(result.incomplete).toEqual([]);
    expect(result.documents.map((d) => [d.doc, d.outcome, d.state])).toEqual([
      ["d1", "complete", "retired"],
      ["d2", "missing", "retired"],
      ["d3", "complete", "open"],
    ]);
  });
  test("control without D1: D2 is missing as well", () => {
    const h = new History();
    h.document(1, "d2", URL_B, { enrol: false });
    h.document(1, "d3", URL_C);
    h.open(1, "d3", URL_C);
    expect(assess(h.input()).missing).toHaveLength(1);
  });
  test("healthy D1 → D3 with complete evidence invents no missing document", () => {
    const h = new History();
    h.document(1, "d1", URL_A, { load: false });
    h.document(1, "d3", URL_C);
    h.open(1, "d3", URL_C);
    const result = assess(h.input());
    expect(result.missing).toEqual([]);
    expect(result.incomplete).toEqual([]);
  });
});

describe("S11/S12: identical URLs, replacement, and documents that escaped the witness too", () => {
  test("three generations of the SAME URL, the middle one unenrolled: exactly that generation is missing", () => {
    const h = new History();
    h.document(1, "g1", URL_C);
    h.document(1, "g2", URL_C, { enrol: false });
    h.document(1, "g3", URL_C);
    h.open(1, "g3", URL_C);
    expect(assess(h.input()).missing).toEqual([
      `document g2 of page 1 (${URL_C}) did not enrol`,
    ]);
  });
  test("a loaded document with neither witness nor recorder is found from the host's loads", () => {
    const h = new History();
    h.document(1, "g1", URL_C);
    h.page(1).loads.push(URL_B);
    h.document(1, "g3", URL_C);
    h.open(1, "g3", URL_C);
    expect(assess(h.input()).missing).toEqual([
      `page 1: 1 of 3 loaded documents have no witness (${URL_C})`,
    ]);
  });
  test("an open page whose CURRENT document has neither witness nor recorder is missing", () => {
    const h = new History();
    h.page(1).loads.push(URL_B);
    h.page(1).inspection = { state: "answered", doc: null, url: URL_B };
    expect(assess(h.input()).missing).toContain(
      `page 1: its current document (${URL_B}) has neither witness nor recorder`,
    );
  });
  test("a witnessed load the host never saw is unresolved (incomplete), and cannot cancel an unwitnessed load of another page", () => {
    const h = new History();
    h.document(1, "a1", URL_C);
    h.page(1).loads.pop();
    h.document(2, "b1", URL_C, { load: false });
    h.page(2).loads.push(URL_B);
    const result = assess(h.input());
    expect(result.incomplete).toContain(
      "page 1: 1 witnessed documents loaded but the host saw 0 loads (unresolved correlation)",
    );
    expect(result.missing).toContain(
      `page 2: 1 of 1 loaded documents have no witness (${URL_B})`,
    );
  });
});

describe("S13/S14: closure, lost tails and transport", () => {
  test("an unenrolled loaded page that closed is missing", () => {
    const h = new History();
    h.document(1, "c1", URL_B, { enrol: false });
    expect(assess(h.input()).missing).toHaveLength(1);
  });
  test("a page that recorded a violation and closed before the report was delivered is INCOMPLETE (its counter says so)", () => {
    const h = new History();
    const counter = h.document(1, "c1", URL_C);
    h.violation(1, "c1", counter, false);
    const result = assess(h.input());
    expect(result.incomplete).toEqual([
      `document c1 of page 1 (${URL_C}): 1 of 2 reports were not delivered (2)`,
    ]);
    expect(result.violations).toEqual([]);
  });
  test("its delivered counterpart stands as a violation; a clean closed page is complete (controls)", () => {
    const h = new History();
    const counter = h.document(1, "c1", URL_C);
    h.violation(1, "c1", counter, true);
    h.document(2, "c2", URL_C);
    const result = assess(h.input());
    expect(result.incomplete).toEqual([]);
    expect(result.violations.map((v) => [v.doc, v.sseq])).toEqual([["c1", 2]]);
    expect(result.documents.map((d) => d.outcome)).toEqual([
      "complete",
      "complete",
    ]);
  });
  test("a retired document with no terminal counter is incomplete; one whose counter is behind its delivered reports too", () => {
    const h = new History();
    h.document(1, "c1", URL_C);
    h.counters = [];
    expect(assess(h.input()).incomplete).toEqual([
      `document c1 of page 1 (${URL_C}) was retired with no terminal evidence`,
    ]);
    const k = new History();
    const counter = k.document(1, "c2", URL_C);
    k.violation(1, "c2", counter, true);
    counter.sequence = 1;
    expect(assess(k.input()).incomplete[0]).toContain(
      "is behind the delivered reports (2)",
    );
  });
  test("an enrolment whose report was lost is incomplete, not missing and not enrolled", () => {
    const h = new History();
    const counter = h.document(1, "c1", URL_C);
    h.reports = [];
    expect(counter.enrolled).toBe(true);
    const result = assess(h.input());
    expect(result.missing).toEqual([]);
    expect(result.incomplete).toEqual([
      `document c1 of page 1 (${URL_C}) enrolled but its enrolment report was not delivered`,
    ]);
  });
  test("a duplicate enrolment of one document gives no credit to another; a late report keeps its own document", () => {
    const h = new History();
    h.document(1, "a", URL_C);
    h.reports.push({ ...(h.reports[0] as OracleEvent) });
    h.document(1, "b", URL_C, { enrol: false });
    // A's late violation, delivered after B committed in the same page, is A's.
    const a = h.counters[0] as Counter;
    h.violation(1, "a", a, true);
    h.document(1, "c", URL_C);
    h.open(1, "c", URL_C);
    const result = assess(h.input());
    expect(result.missing).toEqual([
      `document b of page 1 (${URL_C}) did not enrol`,
    ]);
    expect(result.violations.map((v) => v.doc)).toEqual(["a"]);
  });
});

describe("S15/S16/S17: sealing, inspection, frames and blank documents", () => {
  test("a collection that never found a quiet interval is incomplete", () => {
    const h = new History();
    h.document(1, "a", URL_C);
    h.open(1, "a", URL_C);
    expect(assess(h.input({ unstable: "never quiet" })).incomplete).toEqual([
      "never quiet",
    ]);
  });
  test("an open page that could not be inspected is incomplete", () => {
    const h = new History();
    h.document(1, "a", URL_C);
    h.page(1).inspection = { state: "failed", url: URL_C, error: "boom" };
    expect(assess(h.input()).incomplete).toContain(
      `page 1 (${URL_C}) could not be inspected: boom`,
    );
  });
  test("a blank document and a subframe enrol without covering the page's unenrolled main document; the subframe's violation stands", () => {
    const h = new History();
    h.witness.push({
      page: 1,
      main: true,
      doc: "blank",
      role: "blank",
      type: "document",
      url: "about:blank",
    });
    h.reports.push({
      page: 1,
      main: true,
      doc: "blank",
      type: "enrolled",
      sseq: 1,
      url: "about:blank",
    });
    h.document(1, "main", URL_B, { enrol: false });
    h.document(1, "frame", URL_C, { main: false, load: false });
    h.reports.push({
      page: 1,
      main: false,
      doc: "frame",
      type: "violation",
      sseq: 2,
      violation: {
        doc: "frame",
        seq: 3,
        kind: "marker",
        detail: "x",
        record: null,
      },
    });
    const result = assess(h.input());
    expect(result.missing).toEqual([
      `document main of page 1 (${URL_B}) did not enrol`,
    ]);
    expect(result.violations.map((v) => v.doc)).toEqual(["frame"]);
    expect(
      result.documents
        .filter((d) => d.outcome === "not-required")
        .map((d) => d.role),
    ).toEqual(["blank", "sub"]);
  });
  test("an open page's subframe whose document no current witness observes is incomplete (a reused Window); an observed one is not", () => {
    const h = new History();
    h.document(1, "a", URL_C);
    h.open(1, "a", URL_C);
    h.page(1).frames = [
      { url: URL_B, observed: false },
      { url: URL_A, observed: true },
      { url: "about:blank", observed: false },
      { url: URL_C, observed: null },
    ];
    expect(assess(h.input()).incomplete).toEqual([
      `page 1: a subframe document (${URL_B}) is not observed`,
      `page 1: a subframe document (${URL_C}) could not be inspected`,
    ]);
  });
  test("a frame cannot claim to be a main document", () => {
    const h = new History();
    h.witness.push({
      page: 1,
      main: false,
      doc: "x",
      role: "main",
      type: "document",
      url: URL_C,
    });
    expect(assess(h.input()).documents[0]?.role).toBe("sub");
  });
});

test("the terminal counter's cookie format", () => {
  expect(
    parseCounter(
      `${EVIDENCE_COOKIE.cookiePrefix}abc`,
      "m.e1.d0.s12",
      EVIDENCE_COOKIE.cookiePrefix,
    ),
  ).toEqual({ doc: "abc", enrolled: true, loaded: false, sequence: 12 });
  expect(parseCounter("session", "x", EVIDENCE_COOKIE.cookiePrefix)).toBe(null);
  expect(
    parseCounter(
      `${EVIDENCE_COOKIE.cookiePrefix}abc`,
      "garbage",
      EVIDENCE_COOKIE.cookiePrefix,
    ),
  ).toBe(null);
});
