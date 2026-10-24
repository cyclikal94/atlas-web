// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  type Answer,
  assess,
  type CommitEvent,
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

/**
 * Revision 6 (R5-B; design assessment "the model histories must allow host commit with no witness, no recorder and no load"): a history's
 * events are SEPARATE inputs. `commit` is the host's journal entry; `document` adds, by default, a commit, a witness, an enrolment, a load
 * and a terminal counter, and each can be left out. A page's main frame has the page's number as its frame ordinal; a subframe 1000 + it.
 */
class History {
  witness: WitnessEvent[] = [];
  reports: OracleEvent[] = [];
  answers: Answer[] = [];
  counters: Counter[] = [];
  commits: CommitEvent[] = [];
  pages = new Map<number, PageState>();
  page(id: number): PageState {
    let p = this.pages.get(id);
    if (!p) {
      p = {
        page: id,
        mainFrame: id,
        loads: [],
        inspection: { state: "closed" },
      };
      this.pages.set(id, p);
    }
    return p;
  }
  /** The host's journal: a new document committed in a frame of a page. */
  commit(page: number, url: string, { main = true } = {}) {
    this.page(page);
    const entry: CommitEvent = {
      ordinal: this.commits.length + 1,
      page,
      frame: main ? page : 1000 + page,
      main,
      url,
      kind: "commit",
    };
    this.commits.push(entry);
    return entry;
  }
  /** A document in a page: committed, witnessed, enrolled, loaded and counted unless told otherwise. */
  document(
    page: number,
    doc: string,
    url: string,
    opts: {
      enrol?: boolean;
      load?: boolean;
      main?: boolean;
      commit?: boolean;
      witness?: boolean;
    } = {},
  ) {
    const main = opts.main ?? true;
    const frame = main ? page : 1000 + page;
    this.page(page);
    if (opts.commit ?? true) this.commit(page, url, { main });
    const witnessed = opts.witness ?? true;
    if (witnessed)
      this.witness.push({
        page,
        frame,
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
    if (main && witnessed) this.counters.push(counter);
    if (opts.enrol ?? true) {
      counter.enrolled = true;
      counter.sequence = 1;
      this.reports.push({
        page,
        frame,
        main,
        doc,
        type: "enrolled",
        sseq: 1,
        url,
      });
    }
    if (opts.load ?? true) {
      counter.loaded = true;
      if (main) this.page(page).loads.push(url);
      if (witnessed)
        this.witness.push({
          page,
          frame,
          main,
          doc,
          role: "main",
          type: "loaded",
          url,
        });
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
        frame: page,
        main: true,
        doc,
        type: "violation",
        sseq,
        violation: { doc, seq: 9, kind: "marker", detail: "x", record: null },
      });
  }
  open(page: number, doc: string, url: string, sseq = 1) {
    this.page(page).inspection = {
      state: "answered",
      doc,
      url,
      docUrl: url,
    };
    this.answers.push({
      page,
      doc,
      role: "main",
      url,
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
      commits: this.commits,
      journal: { available: true, detail: "" },
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
  // Adapted in revision 6 (R5-B): the escaped document is now found from the host's COMMIT of it, not from a load (old intent kept: a
  // loaded document with neither witness nor recorder is missing; the old message named the load arithmetic that was replaced).
  test("a loaded document with neither witness nor recorder is found from the host's commit of it", () => {
    const h = new History();
    h.document(1, "g1", URL_C);
    h.document(1, "escaped", URL_B, { witness: false, enrol: false });
    h.document(1, "g3", URL_C);
    h.open(1, "g3", URL_C);
    expect(assess(h.input()).missing).toEqual([
      `committed document generation 2 of page 1 (${URL_B}) has neither witness nor recorder`,
    ]);
  });
  // Adapted in revision 6: with the journal, the CURRENT unobserved document is its page's unmatched latest generation (one report); the
  // inspection's own message remains for an unavailable journal.
  test("an open page whose CURRENT document has neither witness nor recorder is missing", () => {
    const h = new History();
    h.commit(1, URL_B);
    h.page(1).loads.push(URL_B);
    h.page(1).inspection = { state: "answered", doc: null, url: URL_B };
    const result = assess(h.input());
    expect(result.missing).toEqual([
      `committed document generation 1 of page 1 (${URL_B}) has neither witness nor recorder`,
    ]);
    expect(result.documents.map((d) => [d.doc, d.state])).toEqual([
      ["generation 1", "open"],
    ]);
    const unavailable = assess(
      h.input({ journal: { available: false, detail: "absent" } }),
    );
    expect(unavailable.missing).toEqual([
      `page 1: its current document (${URL_B}) has neither witness nor recorder`,
    ]);
  });
  // Adapted in revision 6: the unresolved direction is now a witnessed document with no commit in its frame (was: a witnessed load the
  // host did not see); it still cannot cancel another page's escaped document.
  test("a witnessed document the host saw no commit of is unresolved (incomplete), and cannot cancel an escaped document of another page", () => {
    const h = new History();
    h.document(1, "a1", URL_C, { commit: false });
    h.document(2, "b1", URL_C, { load: false });
    h.document(2, "escaped", URL_B, { witness: false, enrol: false });
    const result = assess(h.input());
    expect(result.incomplete).toContain(
      `document a1 of page 1 (${URL_C}) matches no committed generation of its frame (unresolved correlation)`,
    );
    expect(result.incomplete).toContain(
      "page 1: the host saw 1 loaded documents but 0 commits (the commit journal is incomplete)",
    );
    expect(result.missing).toEqual([
      `committed document generation 2 of page 2 (${URL_B}) has neither witness nor recorder`,
    ]);
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
      frame: 1,
      main: true,
      doc: "blank",
      role: "blank",
      type: "document",
      url: "about:blank",
    });
    h.reports.push({
      page: 1,
      frame: 1,
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
      frame: 1001,
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
      frame: 1001,
      main: false,
      doc: "x",
      role: "main",
      type: "document",
      url: URL_C,
    });
    expect(assess(h.input()).documents[0]?.role).toBe("sub");
  });
});

describe("N1-N7 (revision 6, R5-B): every committed generation is expected, whether or not a script or a load followed", () => {
  const SLOW = "http://app.test/review-document?slow=1&oracle=off&witness=off";
  const LAST = "http://app.test/review-document?last=1";
  test("N1 the review's schedule: committed, neither script, never loaded, replaced by an enrolled successor: MISSING", () => {
    const h = new History();
    h.document(1, "pred", SLOW, { witness: false, enrol: false, load: false });
    h.document(1, "succ", LAST);
    h.open(1, "succ", LAST);
    const result = assess(h.input());
    expect(result.loaded).toBe(1);
    expect(result.missing).toEqual([
      `committed document generation 1 of page 1 (${SLOW}) has neither witness nor recorder`,
    ]);
    expect(result.incomplete).toEqual([]);
    expect(
      result.documents.map((d) => [d.doc, d.generation, d.outcome, d.state]),
    ).toEqual([
      ["succ", 2, "complete", "open"],
      ["generation 1", 1, "missing", "retired"],
    ]);
  });
  test("N1 controls: a healthy interrupted predecessor (witnessed, enrolled, never loaded) is complete; a fully loaded escaped one is missing", () => {
    const h = new History();
    h.document(1, "pred", SLOW, { load: false });
    h.document(1, "succ", LAST);
    h.open(1, "succ", LAST);
    const healthy = assess(h.input());
    expect([healthy.missing, healthy.incomplete]).toEqual([[], []]);
    const k = new History();
    k.document(1, "pred", SLOW, { witness: false, enrol: false });
    k.document(1, "succ", LAST);
    k.open(1, "succ", LAST);
    expect(assess(k.input()).missing).toHaveLength(1);
  });
  test("N1 sensitivity: counting only LOADED documents (the old fallback) would see nothing; the generation is what is counted", () => {
    const h = new History();
    h.document(1, "pred", SLOW, { witness: false, enrol: false, load: false });
    h.document(1, "succ", LAST);
    h.open(1, "succ", LAST);
    // With no commit journal entries the same evidence proves nothing: an empty journal has nothing to expect (never a pass by itself:
    // the witnessed successor then matches no commit, incomplete).
    const withoutCommits = assess(h.input({ commits: [] }));
    expect(withoutCommits.missing).toEqual([]);
    expect(withoutCommits.incomplete).toEqual([
      `document succ of page 1 (${LAST}) matches no committed generation of its frame (unresolved correlation)`,
      "page 1: the host saw 1 loaded documents but 0 commits (the commit journal is incomplete)",
    ]);
  });
  test("N2 closure and reload: an escaped committed document whose page closed, or that a same-URL reload replaced, stays expected", () => {
    const h = new History();
    h.document(1, "gone", SLOW, { witness: false, enrol: false, load: false });
    expect(assess(h.input()).missing).toHaveLength(1);
    const k = new History();
    k.document(1, "a", LAST);
    k.document(1, "reloaded-escaped", LAST, { witness: false, enrol: false });
    k.document(1, "b", LAST);
    k.open(1, "b", LAST);
    // Same URL three times: which reload escaped is not established by the evidence; that one did is.
    expect(assess(k.input()).missing).toEqual([
      `one of committed document generations 1, 2, 3 of page 1 (${LAST}) has neither witness nor recorder`,
    ]);
  });
  test("N3 identity: three same-URL generations with the middle escaped are exactly one missing; no commit (same-document, redirect hop, failed attempt) invents one", () => {
    const h = new History();
    h.document(1, "g1", LAST);
    h.document(1, "g2", LAST, { witness: false, enrol: false });
    h.document(1, "g3", LAST);
    h.open(1, "g3", LAST);
    const result = assess(h.input());
    expect(result.missing).toEqual([
      `one of committed document generations 1, 2, 3 of page 1 (${LAST}) has neither witness nor recorder`,
    ]);
    expect(result.incomplete).toEqual([]);
    expect(result.documents.map((d) => [d.doc, d.generation])).toEqual([
      ["g1", null],
      ["g3", null],
      ["one of generations 1, 2, 3", null],
    ]);
    // An initial blank document and an engine's error page are commits too, but not application documents.
    const k = new History();
    k.commit(1, "about:blank");
    k.commit(1, "chrome-error://chromewebdata/");
    k.document(1, "app", LAST);
    k.open(1, "app", LAST);
    expect(assess(k.input())).toMatchObject({ missing: [], incomplete: [] });
  });
  test("N4 pages and frames are separate: a surplus witnessed document of one page cannot pay for another page's escaped generation", () => {
    const h = new History();
    h.document(1, "leader", LAST);
    h.document(1, "extra", LAST, { commit: false });
    h.document(2, "helper-escaped", SLOW, {
      witness: false,
      enrol: false,
      load: false,
    });
    const result = assess(h.input());
    expect(result.missing).toEqual([
      `committed document generation 2 of page 2 (${SLOW}) has neither witness nor recorder`,
    ]);
    expect(result.incomplete).toContain(
      `document extra of page 1 (${LAST}) matches no committed generation of its frame (unresolved correlation)`,
    );
  });
  test("N4 one-to-one in a frame: an escaped generation and a LOST commit of another URL never cancel (page totals would)", () => {
    const h = new History();
    h.document(1, "escaped", SLOW, {
      witness: false,
      enrol: false,
      load: false,
    });
    h.document(1, "succ", LAST, { commit: false });
    h.open(1, "succ", LAST);
    const result = assess(h.input());
    expect(result.missing).toEqual([
      `committed document generation 1 of page 1 (${SLOW}) has neither witness nor recorder`,
    ]);
    expect(result.incomplete).toContain(
      `document succ of page 1 (${LAST}) matches no committed generation of its frame (unresolved correlation)`,
    );
  });
  test("N4 a predecessor's evidence delivered AFTER its successor's is still its own (matched by frame and creation URL, not arrival)", () => {
    const h = new History();
    h.document(1, "pred", SLOW, { load: false });
    h.document(1, "succ", LAST);
    // Deliver the successor's witness and enrolment first.
    h.witness.reverse();
    h.reports.reverse();
    h.open(1, "succ", LAST);
    const result = assess(h.input());
    expect([result.missing, result.incomplete]).toEqual([[], []]);
    expect(
      Object.fromEntries(result.documents.map((d) => [d.doc, d.generation])),
    ).toEqual({ succ: 2, pred: 1 });
  });
  test("N5 evidence that names no frame (a counter whose document's reports were all lost) makes an escaped generation UNRESOLVED, never clean", () => {
    const h = new History();
    h.document(1, "escaped", SLOW, {
      witness: false,
      enrol: false,
      load: false,
    });
    h.document(1, "succ", LAST);
    h.open(1, "succ", LAST);
    h.counters.push({
      doc: "orphan",
      enrolled: true,
      loaded: false,
      sequence: 1,
    });
    const result = assess(h.input());
    expect(result.missing).toEqual([]);
    expect(result.incomplete).toEqual([
      "document orphan of page 0 (no URL) enrolled but its enrolment report was not delivered",
      `committed document generation 1 of page 1 (${SLOW}) has neither witness nor recorder; unresolved: 1 documents' evidence names no frame`,
    ]);
  });
  test("N6 the sealed inspection must find the page's LATEST generation; a page that could not be inspected leaves its current generation unresolved", () => {
    const h = new History();
    h.document(1, "old", SLOW);
    h.document(1, "new", LAST, { witness: false, enrol: false });
    h.open(1, "old", SLOW);
    const result = assess(h.input());
    expect(result.incomplete).toContain(
      `page 1: the inspected document old is not its latest committed generation (2, ${LAST})`,
    );
    const k = new History();
    k.document(1, "new", LAST, { witness: false, enrol: false });
    k.page(1).inspection = { state: "failed", url: LAST, error: "boom" };
    const failed = assess(k.input());
    expect(failed.missing).toEqual([]);
    expect(failed.incomplete).toContain(
      `committed document generation 1 of page 1 (${LAST}) has neither witness nor recorder; unresolved: its page could not be inspected`,
    );
  });
  test("N7 an unavailable journal, and a frame that loaded more than it committed, are incomplete; an unobserved subframe generation too", () => {
    const h = new History();
    h.document(1, "a", LAST);
    h.open(1, "a", LAST);
    expect(
      assess(h.input({ journal: { available: false, detail: "absent" } }))
        .incomplete,
    ).toEqual([
      "the host's journal of committed documents is unavailable (absent): no document can be accounted for",
    ]);
    h.page(1).loads.push(LAST);
    expect(assess(h.input()).incomplete).toEqual([
      "page 1: the host saw 2 loaded documents but 1 commits (the commit journal is incomplete)",
    ]);
    const k = new History();
    k.document(1, "a", LAST);
    k.open(1, "a", LAST);
    k.commit(1, "http://app.test/inner", { main: false });
    expect(assess(k.input()).incomplete).toEqual([
      "committed document generation 2 of page 1 (http://app.test/inner): a subframe document with neither witness nor recorder is not observed",
    ]);
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
