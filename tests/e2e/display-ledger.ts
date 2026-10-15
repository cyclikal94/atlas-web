/**
 * WEB-08c revision 5 (R5-B of the review of 14 October 2026; design assessment P2/P3, invariants 4-6): the DOCUMENT LEDGER of the display
 * oracle. TEST-ONLY and pure (no browser), so its rules are unit-tested on explicit histories (`tests/oracle/display-ledger.test.ts`).
 *
 * Every application document is accounted for by its OWN identity (the witness's random id), never by a page's totals or a URL:
 *
 * - a main document that was witnessed must have ENROLLED (the recorder's own report, or its own answer when the run is sealed); another
 *   document's enrolment, a blank document's or a subframe's never counts for it;
 * - its evidence must be COMPLETE: a document still open when the run is sealed answers for itself; a document that was replaced or closed
 *   is complete only when every one of its substantive reports (numbered 1..n by the document) reached the test, n being the document's
 *   own terminal counter (its evidence cookie). A gap, an unknown counter, a counter behind the delivered reports, or an open page that
 *   could not be asked is INCOMPLETE, never clean;
 * - documents that escaped the witness too (a test-only seam) are found from the host's own record of the documents each page LOADED:
 *   more loads than witnessed loaded documents is a missing document; fewer is an unresolved correlation (incomplete). Both directions are
 *   reported, so one cannot cancel the other unless two independent faults coincide in the same page (a document without init scripts AND a
 *   dropped lifecycle event of a witnessed one): a stated residual of the absent-witness check only, not of enrolment.
 */

export type Role = "main" | "sub" | "blank";

export interface LedgerViolation {
  doc: string;
  /** The controller's ordinal of the page that delivered it (0: unknown). */
  page: number;
  seq: number;
  sseq: number;
  kind: string;
  detail: string;
  record: unknown;
}

export interface WitnessEvent {
  page: number;
  /** From the page's main frame. */
  main: boolean;
  doc: string;
  role: Role;
  type: "document" | "loaded";
  url: string;
}

export interface OracleEvent {
  page: number;
  main: boolean;
  doc: string;
  type: "enrolled" | "violation" | "incomplete" | "boundary";
  sseq?: number;
  url?: string;
  detail?: string;
  violation?: Omit<LedgerViolation, "page" | "sseq">;
}

export interface Answer {
  page: number;
  doc: string;
  role: Role | null;
  sseq: number;
  violations: Array<Omit<LedgerViolation, "page">>;
  limits: string[];
}

export interface Counter {
  doc: string;
  enrolled: boolean;
  loaded: boolean;
  sequence: number;
}

export interface PageState {
  page: number;
  /** The page's SUBFRAMES when it was inspected: whether a current witness observes each one's document (null: could not be asked). */
  frames?: Array<{ url: string; observed: boolean | null }>;
  /** Host-observed `domcontentloaded` of the main frame, in order (URLs at the event). */
  loads: string[];
  /** The sealed collection's view of the page. */
  inspection:
    | { state: "closed" }
    | { state: "answered"; doc: string | null; url: string }
    | { state: "blank" }
    | { state: "failed"; url: string; error: string };
}

export interface LedgerInput {
  pages: PageState[];
  witness: WitnessEvent[];
  reports: OracleEvent[];
  answers: Answer[];
  counters: Counter[];
  /** The collection could not reach an interval in which nothing happened. */
  unstable?: string;
}

export interface DocumentOutcome {
  doc: string;
  page: number;
  role: Role | "unknown";
  url: string;
  state: "open" | "retired";
  enrolled: boolean;
  loaded: boolean;
  /** Substantive reports the document says it made (null: unknown). */
  expected: number | null;
  delivered: number[];
  outcome: "complete" | "missing" | "incomplete" | "not-required";
  reason: string;
}

export interface LedgerResult {
  documents: DocumentOutcome[];
  missing: string[];
  incomplete: string[];
  violations: LedgerViolation[];
  loaded: number;
  enrolled: number;
}

const isBlankUrl = (url: string) => url === "" || url.startsWith("about:");

export function parseCounter(name: string, value: string, prefix: string) {
  if (!name.startsWith(prefix)) return null;
  const match = /^m\.e([01])\.d([01])\.s(\d+)$/.exec(value);
  if (!match) return null;
  return {
    doc: name.slice(prefix.length),
    enrolled: match[1] === "1",
    loaded: match[2] === "1",
    sequence: Number(match[3]),
  } satisfies Counter;
}

export function assess(input: LedgerInput): LedgerResult {
  const missing: string[] = [];
  const incomplete: string[] = [];
  if (input.unstable) incomplete.push(input.unstable);
  type Doc = {
    doc: string;
    page: number;
    role: Role | "unknown";
    url: string;
    witnessed: boolean;
    witnessLoaded: boolean;
    enrolled: boolean;
    delivered: Set<number>;
  };
  const docs = new Map<string, Doc>();
  const docOf = (doc: string, page: number): Doc => {
    let d = docs.get(doc);
    if (!d) {
      d = {
        doc,
        page,
        role: "unknown",
        url: "",
        witnessed: false,
        witnessLoaded: false,
        enrolled: false,
        delivered: new Set(),
      };
      docs.set(doc, d);
    }
    if (d.page === 0) d.page = page;
    return d;
  };
  for (const e of input.witness) {
    const d = docOf(e.doc, e.page);
    // A frame that is not the page's main frame is never a main document, whatever it says.
    d.role = e.main ? e.role : e.role === "blank" ? "blank" : "sub";
    d.witnessed = true;
    if (e.type === "document") d.url = e.url;
    if (e.type === "loaded") {
      d.witnessLoaded = true;
      if (!isBlankUrl(e.url)) d.url = e.url;
    }
  }
  const violations = new Map<string, LedgerViolation>();
  for (const r of input.reports) {
    const d = docOf(r.doc, r.page);
    // A recorder without a witness (a test-only seam) still names its frame; its first report says whether it is a blank document.
    if (d.role === "unknown")
      d.role = !r.main
        ? "sub"
        : r.type === "enrolled" && isBlankUrl(r.url ?? "")
          ? "blank"
          : "main";
    else if (!r.main && d.role !== "blank") d.role = "sub";
    if (r.sseq !== undefined) d.delivered.add(r.sseq);
    if (r.type === "enrolled") {
      d.enrolled = true;
      if (!d.url && r.url) d.url = r.url;
    }
    if (r.type === "violation" && r.violation && r.sseq !== undefined)
      violations.set(`${r.doc}:${r.sseq}`, {
        ...r.violation,
        page: r.page,
        sseq: r.sseq,
      });
    if (r.type === "incomplete")
      incomplete.push(
        `document ${r.doc} (page ${r.page}): ${r.detail ?? "recorder limit"}`,
      );
  }
  const answered = new Map<string, Answer>();
  for (const a of input.answers) {
    answered.set(a.doc, a);
    const d = docOf(a.doc, a.page);
    if (d.role === "unknown") d.role = a.role ?? "main";
    d.enrolled = true;
    for (const v of a.violations)
      violations.set(`${a.doc}:${v.sseq}`, { ...v, page: a.page });
    for (const limit of a.limits)
      incomplete.push(`document ${a.doc} (page ${a.page}): ${limit}`);
  }
  const counters = new Map(input.counters.map((c) => [c.doc, c]));
  for (const c of input.counters) {
    const d = docOf(c.doc, 0);
    // Only the witness of a MAIN document keeps a counter.
    if (d.role === "unknown") d.role = "main";
    d.witnessed = true;
  }

  const documents: DocumentOutcome[] = [];
  let lostLoadReports = false;
  for (const d of docs.values()) {
    const counter = counters.get(d.doc);
    const answer = answered.get(d.doc);
    const loaded = d.witnessLoaded || counter?.loaded === true;
    if (counter?.loaded && !d.witnessLoaded) lostLoadReports = true;
    const base = {
      doc: d.doc,
      page: d.page,
      role: d.role,
      url: d.url,
      state: answer ? ("open" as const) : ("retired" as const),
      enrolled: d.enrolled,
      loaded,
      expected: answer ? answer.sseq : (counter?.sequence ?? null),
      delivered: [...d.delivered].sort((a, b) => a - b),
    };
    const name = `document ${d.doc} of page ${d.page} (${d.url || "no URL"})`;
    if (d.role !== "main") {
      documents.push({
        ...base,
        outcome: "not-required",
        reason: `${d.role} document`,
      });
      continue;
    }
    if (!d.enrolled) {
      if (counter?.enrolled) {
        const reason = `${name} enrolled but its enrolment report was not delivered`;
        incomplete.push(reason);
        documents.push({ ...base, outcome: "incomplete", reason });
      } else {
        const reason = `${name} did not enrol`;
        missing.push(reason);
        documents.push({ ...base, outcome: "missing", reason });
      }
      continue;
    }
    if (answer) {
      documents.push({
        ...base,
        outcome: "complete",
        reason: "answered for itself in the sealed interval",
      });
      continue;
    }
    if (!counter) {
      const reason = `${name} was retired with no terminal evidence`;
      incomplete.push(reason);
      documents.push({ ...base, outcome: "incomplete", reason });
      continue;
    }
    const lost: number[] = [];
    for (let n = 1; n <= counter.sequence; n += 1)
      if (!d.delivered.has(n)) lost.push(n);
    const beyond = base.delivered.filter((n) => n > counter.sequence);
    if (beyond.length > 0) {
      const reason = `${name}: its terminal counter (${counter.sequence}) is behind the delivered reports (${beyond.join(",")})`;
      incomplete.push(reason);
      documents.push({ ...base, outcome: "incomplete", reason });
    } else if (lost.length > 0) {
      const reason = `${name}: ${lost.length} of ${counter.sequence} reports were not delivered (${lost.join(",")})`;
      incomplete.push(reason);
      documents.push({ ...base, outcome: "incomplete", reason });
    } else
      documents.push({
        ...base,
        outcome: "complete",
        reason: `all ${counter.sequence} reports delivered`,
      });
  }

  // Open pages: what their CURRENT document is, asked in the sealed interval.
  for (const p of input.pages) {
    const i = p.inspection;
    if (i.state === "failed")
      incomplete.push(
        `page ${p.page} (${i.url}) could not be inspected: ${i.error}`,
      );
    if (i.state === "answered" && i.doc === null && !isBlankUrl(i.url))
      missing.push(
        `page ${p.page}: its current document (${i.url}) has neither witness nor recorder`,
      );
    // A subframe document no init script reached (a reused Window) is unobserved: its violations could not be seen.
    for (const frame of p.frames ?? [])
      if (frame.observed !== true && !isBlankUrl(frame.url))
        incomplete.push(
          `page ${p.page}: a subframe document (${frame.url}) ${frame.observed === null ? "could not be inspected" : "is not observed"}`,
        );
  }
  // Documents that escaped the witness too: the host's own loads, per page, against the witnessed documents of that page that loaded.
  for (const p of input.pages) {
    const hostLoads = p.loads.filter((url) => !isBlankUrl(url)).length;
    const witnessed = [...docs.values()].filter(
      (d) =>
        d.page === p.page &&
        d.role === "main" &&
        (d.witnessLoaded || counters.get(d.doc)?.loaded === true),
    ).length;
    if (hostLoads > witnessed) {
      const reason = `page ${p.page}: ${hostLoads - witnessed} of ${hostLoads} loaded documents have no witness (${p.loads.at(-1) ?? ""})`;
      // A witness whose reports were all lost cannot be placed on a page: then the shortfall is unresolved, not proven missing.
      if (lostLoadReports || documents.some((d) => d.page === 0))
        incomplete.push(
          `${reason}; unresolved: some witness reports were lost`,
        );
      else missing.push(reason);
    } else if (hostLoads < witnessed)
      incomplete.push(
        `page ${p.page}: ${witnessed} witnessed documents loaded but the host saw ${hostLoads} loads (unresolved correlation)`,
      );
  }
  return {
    documents,
    missing: [...new Set(missing)],
    incomplete: [...new Set(incomplete)],
    violations: [...violations.values()],
    loaded: input.pages.reduce(
      (n, p) => n + p.loads.filter((url) => !isBlankUrl(url)).length,
      0,
    ),
    enrolled: documents.filter((d) => d.role === "main" && d.enrolled).length,
  };
}
