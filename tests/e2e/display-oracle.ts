import type { BrowserContext, Page } from "@playwright/test";
import {
  type Answer,
  assess,
  type Counter,
  type DocumentOutcome,
  type LedgerResult,
  type OracleEvent,
  type PageState,
  parseCounter,
  type Role,
  type WitnessEvent,
} from "./display-ledger";
import {
  DEFAULT_LIMITS,
  EVIDENCE_COOKIE,
  oracleScript,
  type RecorderLimits,
  witnessScript,
} from "./display-recorder";
import { expect } from "./helpers";

/**
 * WEB-08c revision 3 (R5; design assessment P1, Q1), revised in revisions 4 and 5: a CONTINUOUS no-early-display oracle for real pages.
 * TEST-ONLY: two init scripts installed in every document of a context before any application script runs (`display-recorder.ts`: the
 * document WITNESS, then the RECORDER), two bindings that report to the test process, and the document LEDGER (`display-ledger.ts`).
 *
 * What it decides. A page may expose an account (put a node into `#protected-root`, remove its `inert` or `aria-hidden`, set a protected
 * title, or show an account's marker text anywhere in the document) only while the LATEST `atlas-auth` record THIS page has seen COMMITTED
 * names that account as settled with no fence entry for it. That record is observed at the durable boundary itself: every `atlas-auth`
 * transaction of the page is followed, the record it read (`getAll`) or wrote (`put` of `auth_state`) is summarised, and the summary is
 * adopted only when the transaction's `complete` event is delivered, after every DOM change made before it has been judged. An aborted
 * transaction changes nothing. A page that lifts or mounts while its last committed record still holds the fence is a violation, whatever
 * happens afterwards.
 *
 * How it reads the DOM (revision 5, R5-A). Every change is taken from `MutationObserver` records and judged as the document WAS at that
 * record (reconstructed from the records; see `display-recorder.ts`), never by its final topology: a subtree inserted and dismantled in one
 * task, a title text node changed and detached, a name or text set and reset, are each judged on what they showed while they showed it.
 *
 * What it covers (revision 5, R5-B). Every DOCUMENT of the context is accounted for by its own identity (`display-ledger.ts`): each
 * witnessed main document must have enrolled, and its evidence must be complete (answered for itself when the run is sealed, or, once
 * replaced or closed, every substantive report it says it made delivered); documents that escaped the witness too are found from the
 * host's own loads. A failure to observe is MISSING or INCOMPLETE, never clean.
 *
 * The kernel trace of the fixture's session harness (`window.__atlasFixture.session.trace`) is followed when it exists, as annotations
 * only (the production build has none); it never authorises anything.
 */

export interface OracleViolation {
  /** The controller's ordinal of the page that delivered it (1 for the first page the installation saw; 0 unknown). */
  page: number;
  /** The document that recorded it (the witness's identity). */
  doc: string;
  /** Its position in the document's ordered log. */
  seq: number;
  /** Its position in the document's substantive report sequence. */
  sseq: number;
  kind: "mount" | "lift" | "title" | "marker";
  detail: string;
  /** The page's latest committed `atlas-auth` record when it happened (null: none yet). */
  record: RecordSummary | null;
}
export interface RecordSummary {
  settled: string | null;
  epoch: number | null;
  /** Fence entries per account. */
  fences: Record<string, number>;
  tx: number;
}
/**
 * The verified username the fixture network answers for the signed-in account (`data-leader-helpers.ts`, `/me`): the account marker of
 * every production-session fixture case (LR, E-R, E-B), so that each consumer checks the same vocabulary (WEB-08c revision 4, DA-H1).
 */
export const FIXTURE_ACCOUNT_MARKERS: readonly string[] = ["alice"];

/** One report as it crosses from a document to the test (qualification only: a transport fault is injected here). */
export interface TransportReport {
  binding: "witness" | "oracle";
  doc: string;
  type: string;
  sseq?: number;
  url?: string;
}

export interface OracleOptions {
  /**
   * Account-specific text (usernames, cached content). None of it may be in the document while NO account is authorised: the neutral
   * states and the gate never show anything about an account. (A displayed account's own tree may name OTHER retained accounts: the
   * switcher lists them by their verified names, by design.)
   */
  markers?: string[];
  /** Recorder bounds (qualification lowers them to reach each one); reaching one is incomplete evidence. */
  limits?: Partial<RecorderLimits>;
  /** QUALIFICATION ONLY: decides the fate of each report (deliver, lose it, or deliver it later). Consumers never set it. */
  transport?: (
    report: TransportReport,
  ) => "deliver" | "drop" | Promise<"deliver" | "drop">;
}

export interface Coverage {
  open: number;
  enrolled: number;
  loaded: number;
  missing: string[];
  incomplete: string[];
  documents: DocumentOutcome[];
  violations: OracleViolation[];
}

export interface DisplayOracle {
  /** Violations DELIVERED so far by every document of the context, including documents that were replaced or closed. */
  violations(): OracleViolation[];
  /** The test marks a point in a page's log (for example "finish released"). */
  mark(page: Page, label: string): Promise<void>;
  /** The page's own ordered log (diagnostic; empty when its document has no recorder). */
  log(page: Page): Promise<Array<Record<string, unknown>>>;
  /**
   * Seals the run: every document of the context is accounted for (its enrolment, and complete evidence), no recorder limit was reached,
   * and no document (open, replaced or closed) recorded a violation.
   */
  assertClean(message?: string): Promise<void>;
  /**
   * The sealed ledger (WEB-08c revision 5, R5-B): one outcome per document. Calls are serialised; each collects its own state, repeated
   * until nothing happened in the context during the collection (else incomplete).
   */
  coverage(): Promise<Coverage>;
  /** The last sealed ledger (diagnostic attachments). */
  lastCoverage(): Coverage | null;
  /** The marker vocabulary this installation checks (a caller's evidence states it). */
  readonly markers: readonly string[];
}

type FlushAnswer = {
  doc: string;
  role: Role | null;
  /** Whether the window still shows this recorder's own document. */
  current: boolean;
  sseq: number;
  violations: Array<Omit<OracleViolation, "page">>;
  limits: string[];
};

export async function installDisplayOracle(
  context: BrowserContext,
  options: OracleOptions = {},
): Promise<DisplayOracle> {
  const markers = [...(options.markers ?? [])];
  const limits: RecorderLimits = { ...DEFAULT_LIMITS, ...options.limits };
  /** Anything that happened in the context (a page, a load, a navigation, a close, a delivered report): a sealed interval has none. */
  let activity = 0;
  const pages = new Map<Page, { id: number; loads: string[] }>();
  // The expected-document side is registered BEFORE any script or binding: every page of the context, and every page it opens later.
  const watch = (page: Page) => {
    if (pages.has(page)) return pages.get(page)?.id ?? 0;
    const state = { id: pages.size + 1, loads: [] as string[] };
    pages.set(page, state);
    activity += 1;
    page.on("domcontentloaded", () => {
      activity += 1;
      state.loads.push(page.url());
    });
    const busy = () => {
      activity += 1;
    };
    page.on("framenavigated", busy);
    page.on("frameattached", busy);
    page.on("framedetached", busy);
    page.on("close", busy);
    return state.id;
  };
  for (const page of context.pages()) watch(page);
  context.on("page", watch);
  const idOf = (page: Page | null | undefined) => (page ? watch(page) : 0);

  const witness: WitnessEvent[] = [];
  const reports: OracleEvent[] = [];
  const decide = async (report: TransportReport) =>
    options.transport ? await options.transport(report) : "deliver";
  await context.exposeBinding(
    "__displayOracleWitness",
    async (
      source,
      payload: {
        doc: string;
        role: Role;
        type: "document" | "loaded";
        url: string;
      },
    ) => {
      const fate = await decide({
        binding: "witness",
        doc: payload.doc,
        type: payload.type,
        url: payload.url,
      });
      if (fate !== "deliver") return;
      activity += 1;
      witness.push({
        page: idOf(source.page),
        main: source.frame === source.page?.mainFrame(),
        doc: payload.doc,
        role: payload.role,
        type: payload.type,
        url: payload.url,
      });
    },
  );
  await context.exposeBinding(
    "__displayOracleReport",
    async (source, payload: Omit<OracleEvent, "page" | "main">) => {
      const fate = await decide({
        binding: "oracle",
        doc: payload.doc,
        type: payload.type,
        sseq: payload.sseq,
        url: payload.url,
      });
      if (fate !== "deliver") return;
      activity += 1;
      reports.push({
        ...payload,
        page: idOf(source.page),
        // Only a page's MAIN frame is an application document (the app has no frames; a frame's violation still counts).
        main: source.frame === source.page?.mainFrame(),
      });
    },
  );
  // The witness first: the recorder of the same document takes its identity from it.
  await context.addInitScript(witnessScript, EVIDENCE_COOKIE);
  await context.addInitScript(oracleScript, { markers, limits });

  const violations = (): OracleViolation[] =>
    reports
      .filter((r) => r.type === "violation" && r.violation)
      .map(
        (r) =>
          ({
            ...(r.violation as object),
            page: r.page,
            sseq: r.sseq ?? 0,
          }) as OracleViolation,
      );
  let last: Coverage | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  const coverage = () => {
    const run = chain.then(collect);
    chain = run.catch(() => undefined);
    return run;
  };
  return {
    violations,
    assertClean,
    markers,
    coverage,
    lastCoverage: () => last,
    async mark(page, label) {
      await page.evaluate(
        (l) =>
          (
            window as unknown as {
              __displayOracle?: { mark(label: string): void };
            }
          ).__displayOracle?.mark(l),
        label,
      );
    },
    async log(page) {
      return page.evaluate(
        () =>
          ((
            window as unknown as {
              __displayOracle?: { log: Array<Record<string, unknown>> };
            }
          ).__displayOracle?.log ?? []) as Array<Record<string, unknown>>,
      );
    },
  };

  /** Asks a page's CURRENT document, once, for its identity and what it holds (bounded: an unanswered question is a failed inspection). */
  async function ask(page: Page) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        page.evaluate(() => {
          const w = window as unknown as {
            __displayOracleDocument?: { doc: string; current(): boolean };
            __displayOracle?: { flush(): unknown };
          };
          // A witness left by an EARLIER document of a reused Window does not witness this one.
          const handle = w.__displayOracleDocument;
          return {
            witness: handle?.current() ? handle.doc : null,
            answer: (w.__displayOracle?.flush() ?? null) as FlushAnswer | null,
            url: location.href,
          };
        }),
        new Promise<never>((_, fail) => {
          timer = setTimeout(
            () => fail(new Error("no answer in 10 s")),
            10_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  /** Whether each SUBFRAME's current document is observed by its own witness and recorder. */
  async function framesOf(page: Page) {
    const frames: Array<{ url: string; observed: boolean | null }> = [];
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      const url = frame.url();
      const observed = await frame
        .evaluate(() => {
          const w = window as unknown as {
            __displayOracleDocument?: { current(): boolean };
            __displayOracle?: { flush(): { current?: boolean } };
          };
          return (
            w.__displayOracleDocument?.current() === true &&
            w.__displayOracle?.flush().current === true
          );
        })
        .catch(() => null);
      frames.push({ url, observed });
    }
    return frames;
  }
  async function collect(): Promise<Coverage> {
    let states: PageState[] = [];
    let answers: Answer[] = [];
    let counters: Counter[] = [];
    let unstable: string | undefined;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const before = activity;
      states = [];
      answers = [];
      for (const [page, state] of [...pages]) {
        const loads = [...state.loads];
        if (page.isClosed()) {
          states.push({
            page: state.id,
            loads,
            inspection: { state: "closed" },
          });
          continue;
        }
        const url = page.url();
        try {
          const got = await ask(page);
          if (got.answer) answers.push({ ...got.answer, page: state.id });
          states.push({
            page: state.id,
            loads,
            frames: await framesOf(page),
            inspection: {
              state: "answered",
              // The CURRENT document: its witness, or a recorder of its own when the witness was switched off (a test seam).
              doc: got.witness ?? (got.answer?.current ? got.answer.doc : null),
              url: got.url,
            },
          });
        } catch (error) {
          states.push({
            page: state.id,
            loads,
            inspection: page.isClosed()
              ? { state: "closed" }
              : {
                  state: "failed",
                  url,
                  error: String(error).split("\n")[0]?.slice(0, 200) ?? "",
                },
          });
        }
      }
      counters = (await context.cookies())
        .map((c) => parseCounter(c.name, c.value, EVIDENCE_COOKIE.cookiePrefix))
        .filter((c): c is Counter => c !== null);
      if (activity === before) {
        unstable = undefined;
        break;
      }
      unstable = `the sealed collection never found an interval with no activity (5 attempts; last ${before} → ${activity})`;
    }
    const result: LedgerResult = assess({
      pages: states,
      witness: [...witness],
      reports: [...reports],
      answers,
      counters,
      unstable,
    });
    last = {
      open: states.filter((s) => s.inspection.state !== "closed").length,
      enrolled: result.enrolled,
      loaded: result.loaded,
      missing: result.missing,
      incomplete: result.incomplete,
      documents: result.documents,
      violations: result.violations as OracleViolation[],
    };
    return last;
  }
  async function assertClean(message?: string) {
    const { missing, incomplete, violations: all } = await coverage();
    expect(
      missing,
      `${message ?? ""} documents that escaped the oracle`,
    ).toEqual([]);
    expect(
      incomplete,
      `${message ?? ""} incomplete evidence (recorder limits, undelivered reports, uninspectable pages)`,
    ).toEqual([]);
    expect(all, `${message ?? ""} early display`).toEqual([]);
  }
}
