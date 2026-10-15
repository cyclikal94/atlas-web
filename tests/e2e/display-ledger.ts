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
 * - (revision 6, R5-B of the review of 15 October 2026) the EXPECTED documents are the host's own journal of committed documents, not
 *   any in-page evidence and not the documents that loaded: every new-document commit of every frame is a GENERATION the moment it is
 *   committed, whether or not a witness, a recorder or `DOMContentLoaded` ever follows (an interrupted document need never load). Each
 *   generation is matched one-to-one, in its own frame, to a document the frame's evidence names with the URL it was created at (the
 *   witness's report, the recorder's, or the document's own answer). A generation no document matches escaped both scripts: MISSING (or
 *   INCOMPLETE while some document's evidence cannot be placed in a frame, or its page could not be inspected); a document no generation
 *   matches is an unresolved correlation (INCOMPLETE). Same-document navigations, redirects and aborted attempts commit no document, so they
 *   add no generation; a replaced or closed document's generation stays in the journal. A surplus document can only stand in for a missing
 *   generation if the host ALSO lost a commit in the same frame for the same URL (two independent faults): a stated residual.
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
  /** The host's ordinal of the frame that sent it (captured when it was sent). */
  frame: number;
  /** From the page's main frame. */
  main: boolean;
  doc: string;
  role: Role;
  type: "document" | "loaded";
  url: string;
}

export interface OracleEvent {
  page: number;
  frame: number;
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
  /** The URL the answering document was created at. */
  url?: string;
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

/**
 * The host's journal of committed documents (revision 6, R5-B): one entry per NEW-DOCUMENT commit of a frame, in the order the host was
 * told of them, or the document a frame already showed when the host first saw that frame.
 */
export interface CommitEvent {
  ordinal: number;
  page: number;
  frame: number;
  main: boolean;
  url: string;
  kind: "commit" | "registration";
}

export interface PageState {
  page: number;
  /** The host's ordinal of the page's main frame. */
  mainFrame: number;
  /** The page's SUBFRAMES when it was inspected: whether a current witness observes each one's document (null: could not be asked). */
  frames?: Array<{ url: string; observed: boolean | null }>;
  /** Host-observed `domcontentloaded` of the main frame, in order (URLs at the event). */
  loads: string[];
  /** The sealed collection's view of the page. */
  inspection:
    | { state: "closed" }
    | {
        state: "answered";
        doc: string | null;
        url: string;
        /** The URL the current document was created at (its witness's or recorder's), when one answered. */
        docUrl?: string | null;
      }
    | { state: "blank" }
    | { state: "failed"; url: string; error: string };
}

export interface LedgerInput {
  pages: PageState[];
  witness: WitnessEvent[];
  reports: OracleEvent[];
  answers: Answer[];
  counters: Counter[];
  /** The host's committed documents. */
  commits: CommitEvent[];
  /** Whether the host could keep that journal (an unavailable journal accounts for nothing: incomplete). */
  journal: { available: boolean; detail: string };
  /** The collection could not reach an interval in which nothing happened. */
  unstable?: string;
}

export interface DocumentOutcome {
  /** The witness's identity (a generation no document matched: `generation <n>`). */
  doc: string;
  page: number;
  /** The host's frame ordinal (null: the document's evidence names no frame). */
  frame: number | null;
  /** The committed generation it is matched to (null: none). */
  generation: number | null;
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
/** A document the application could have served (an engine's error or blank page is not one). */
const isAppUrl = (url: string) => /^https?:/i.test(url);

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
    /** The frame its evidence came from (null: none names one, a terminal counter alone). */
    frame: number | null;
    role: Role | "unknown";
    url: string;
    /** The URL it was created at, as its own evidence states it (what its commit names). */
    created: string;
    /** Order of its first evidence. */
    seen: number;
    witnessed: boolean;
    witnessLoaded: boolean;
    enrolled: boolean;
    delivered: Set<number>;
  };
  const docs = new Map<string, Doc>();
  const docOf = (doc: string, page: number, frame: number | null): Doc => {
    let d = docs.get(doc);
    if (!d) {
      d = {
        doc,
        page,
        frame,
        role: "unknown",
        url: "",
        created: "",
        seen: docs.size,
        witnessed: false,
        witnessLoaded: false,
        enrolled: false,
        delivered: new Set(),
      };
      docs.set(doc, d);
    }
    if (d.page === 0) d.page = page;
    if (d.frame === null) d.frame = frame;
    return d;
  };
  const mainFrameOf = new Map(input.pages.map((p) => [p.page, p.mainFrame]));
  for (const e of input.witness) {
    const d = docOf(e.doc, e.page, e.frame);
    // A frame that is not the page's main frame is never a main document, whatever it says.
    d.role = e.main ? e.role : e.role === "blank" ? "blank" : "sub";
    d.witnessed = true;
    if (e.type === "document") {
      d.url = e.url;
      d.created = e.url;
    }
    if (e.type === "loaded") {
      d.witnessLoaded = true;
      if (!isBlankUrl(e.url)) d.url = e.url;
    }
  }
  const violations = new Map<string, LedgerViolation>();
  for (const r of input.reports) {
    const d = docOf(r.doc, r.page, r.frame);
    // A recorder without a witness (a test-only seam) still names its frame; its first report says whether it is a blank document.
    if (d.role === "unknown")
      d.role = !r.main
        ? "sub"
        : r.type === "enrolled" && !isAppUrl(r.url ?? "")
          ? "blank"
          : "main";
    else if (!r.main && d.role !== "blank") d.role = "sub";
    if (r.sseq !== undefined) d.delivered.add(r.sseq);
    if (r.type === "enrolled") {
      d.enrolled = true;
      if (!d.url && r.url) d.url = r.url;
      if (!d.created && r.url) d.created = r.url;
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
    const d = docOf(a.doc, a.page, mainFrameOf.get(a.page) ?? null);
    if (d.role === "unknown") d.role = a.role ?? "main";
    d.enrolled = true;
    if (!d.created && a.url) d.created = a.url;
    if (!d.url && a.url) d.url = a.url;
    for (const v of a.violations)
      violations.set(`${a.doc}:${v.sseq}`, { ...v, page: a.page });
    for (const limit of a.limits)
      incomplete.push(`document ${a.doc} (page ${a.page}): ${limit}`);
  }
  // A page's current document as the sealed inspection found it: its witness identity is evidence of that document in the main frame,
  // even when its own reports have not arrived.
  for (const p of input.pages) {
    const i = p.inspection;
    if (i.state !== "answered" || i.doc === null) continue;
    const d = docOf(i.doc, p.page, p.mainFrame);
    if (d.role === "unknown")
      d.role = isAppUrl(i.docUrl ?? i.url) ? "main" : "blank";
    if (!d.created && i.docUrl) d.created = i.docUrl;
    if (!d.url) d.url = i.url;
  }
  const counters = new Map(input.counters.map((c) => [c.doc, c]));
  for (const c of input.counters) {
    const d = docOf(c.doc, 0, null);
    // Only the witness of a MAIN document keeps a counter.
    if (d.role === "unknown") d.role = "main";
    d.witnessed = true;
  }

  const documents: DocumentOutcome[] = [];
  for (const d of docs.values()) {
    const counter = counters.get(d.doc);
    const answer = answered.get(d.doc);
    const loaded = d.witnessLoaded || counter?.loaded === true;
    const base = {
      doc: d.doc,
      page: d.page,
      frame: d.frame,
      generation: null,
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

  // Open pages: what their CURRENT document is, asked in the sealed interval; and their subframes.
  for (const p of input.pages) {
    const i = p.inspection;
    if (i.state === "failed")
      incomplete.push(
        `page ${p.page} (${i.url}) could not be inspected: ${i.error}`,
      );
    // A subframe document no init script reached (a reused Window) is unobserved: its violations could not be seen.
    for (const frame of p.frames ?? [])
      if (frame.observed !== true && isAppUrl(frame.url))
        incomplete.push(
          `page ${p.page}: a subframe document (${frame.url}) ${frame.observed === null ? "could not be inspected" : "is not observed"}`,
        );
  }

  // ---- revision 6 (R5-B): every committed generation is an expected document, matched one-to-one in its own frame ----
  const outcomeOf = new Map(documents.map((o) => [o.doc, o]));
  if (!input.journal.available) {
    incomplete.push(
      `the host's journal of committed documents is unavailable (${input.journal.detail}): no document can be accounted for`,
    );
    for (const p of input.pages) {
      const i = p.inspection;
      if (i.state === "answered" && i.doc === null && isAppUrl(i.url))
        missing.push(
          `page ${p.page}: its current document (${i.url}) has neither witness nor recorder`,
        );
    }
  } else {
    const roleOf = (c: CommitEvent): Role =>
      !isAppUrl(c.url) ? "blank" : c.main ? "main" : "sub";
    const commits = [...input.commits].sort((a, b) => a.ordinal - b.ordinal);
    const matched = new Map<string, number>();
    const byFrame = new Map<number, Doc[]>();
    for (const d of [...docs.values()].sort((a, b) => a.seen - b.seen))
      if (d.frame !== null && d.role !== "blank" && isAppUrl(d.created))
        byFrame.set(d.frame, [...(byFrame.get(d.frame) ?? []), d]);
    // Generations and documents are matched per frame and per creation URL. Within one such group the evidence fixes HOW MANY
    // generations have a document of their own, not which: the escaped ones are named as "one of" the group's generations (never a
    // guessed position), and the group's documents carry no generation number.
    const unmatched: Array<{ commit: CommitEvent; among: number[] | null }> =
      [];
    const groups = new Map<string, CommitEvent[]>();
    for (const c of commits) {
      if (roleOf(c) === "blank") continue;
      const key = `${c.frame} ${c.url}`;
      groups.set(key, [...(groups.get(key) ?? []), c]);
    }
    for (const group of groups.values()) {
      const first = group[0] as CommitEvent;
      const evidence = (byFrame.get(first.frame) ?? []).filter(
        (x) => !matched.has(x.doc) && x.created === first.url,
      );
      // Arrival order is not commit order (a held or late report), so positions inside a repeated URL are never assigned.
      const ambiguous = evidence.length > 0 && group.length > 1;
      group.forEach((c, index) => {
        const d = evidence[index];
        if (!d) {
          unmatched.push({
            commit: c,
            among: ambiguous ? group.map((g) => g.ordinal) : null,
          });
          return;
        }
        matched.set(d.doc, c.ordinal);
        const o = outcomeOf.get(d.doc);
        if (o) o.generation = ambiguous ? null : c.ordinal;
      });
    }
    // Evidence that cannot be placed in a frame (a terminal counter whose document's reports were all lost) might be any generation's.
    const unplaced = [...docs.values()].filter(
      (d) => d.frame === null && d.role !== "blank",
    ).length;
    const latest = new Map<number, CommitEvent>();
    for (const c of commits)
      if (c.main && roleOf(c) === "main") latest.set(c.page, c);
    const pageOf = new Map(input.pages.map((p) => [p.page, p]));
    for (const { commit: c, among } of unmatched) {
      const page = pageOf.get(c.page);
      const current =
        among === null &&
        latest.get(c.page) === c &&
        page !== undefined &&
        page.inspection.state !== "closed";
      const name =
        among === null
          ? `committed document generation ${c.ordinal} of page ${c.page} (${c.url})`
          : `one of committed document generations ${among.join(", ")} of page ${c.page} (${c.url})`;
      let outcome: DocumentOutcome["outcome"];
      let reason: string;
      if (roleOf(c) === "sub") {
        outcome = "incomplete";
        reason = `${name}: a subframe document with neither witness nor recorder is not observed`;
      } else if (
        unplaced > 0 ||
        (current && page?.inspection.state === "failed")
      ) {
        outcome = "incomplete";
        reason = `${name} has neither witness nor recorder; unresolved: ${unplaced > 0 ? `${unplaced} documents' evidence names no frame` : "its page could not be inspected"}`;
      } else {
        outcome = "missing";
        reason = `${name} has neither witness nor recorder`;
      }
      (outcome === "missing" ? missing : incomplete).push(reason);
      documents.push({
        doc:
          among === null
            ? `generation ${c.ordinal}`
            : `one of generations ${among.join(", ")}`,
        page: c.page,
        frame: c.frame,
        generation: among === null ? c.ordinal : null,
        role: roleOf(c),
        url: c.url,
        state: current ? "open" : "retired",
        enrolled: false,
        loaded: false,
        expected: null,
        delivered: [],
        outcome,
        reason,
      });
    }
    // A document whose evidence names a frame and a URL that no committed generation of that frame matches: unresolved.
    for (const ds of byFrame.values())
      for (const d of ds) {
        if (matched.has(d.doc)) continue;
        const reason = `document ${d.doc} of page ${d.page} (${d.created}) matches no committed generation of its frame (unresolved correlation)`;
        incomplete.push(reason);
        const o = outcomeOf.get(d.doc);
        if (o && o.outcome === "complete") {
          o.outcome = "incomplete";
          o.reason = reason;
        }
      }
    // The sealed inspection must have found each open page's LATEST committed generation.
    for (const p of input.pages) {
      const i = p.inspection;
      const last = latest.get(p.page);
      if (i.state !== "answered" || !last || i.doc === null) continue;
      const at = matched.get(i.doc);
      const sameGroup = commits.some(
        (c) => c.ordinal === at && c.frame === last.frame && c.url === last.url,
      );
      // In a group whose positions are not established, the current document needs only to be one of the latest generation's group.
      const group = outcomeOf.get(i.doc)?.generation === null && sameGroup;
      if (at !== last.ordinal && !group)
        incomplete.push(
          `page ${p.page}: the inspected document ${i.doc} is not its latest committed generation (${last.ordinal}, ${last.url})`,
        );
    }
    // The host's loads cross-check its commits: a frame cannot load more documents than it committed.
    for (const p of input.pages) {
      const loads = p.loads.filter((url) => isAppUrl(url)).length;
      const committed = commits.filter(
        (c) => c.frame === p.mainFrame && roleOf(c) === "main",
      ).length;
      if (loads > committed)
        incomplete.push(
          `page ${p.page}: the host saw ${loads} loaded documents but ${committed} commits (the commit journal is incomplete)`,
        );
    }
  }
  return {
    documents,
    missing: [...new Set(missing)],
    incomplete: [...new Set(incomplete)],
    violations: [...violations.values()],
    loaded: input.pages.reduce(
      (n, p) => n + p.loads.filter((url) => isAppUrl(url)).length,
      0,
    ),
    enrolled: documents.filter((d) => d.role === "main" && d.enrolled).length,
  };
}
