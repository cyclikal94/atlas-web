import type { BrowserContext, Frame, Page } from "@playwright/test";
import {
  type Answer,
  assess,
  type CommitEvent,
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
 * replaced or closed, every substantive report it says it made delivered). A failure to observe is MISSING or INCOMPLETE, never clean.
 *
 * Which documents are expected (revision 6, R5-B of the review of 15 October 2026): the host's own JOURNAL of committed documents, kept
 * independently of both scripts and of loading. Playwright's public `framenavigated` does not say whether a navigation committed a new
 * document (it fires for same-document navigations too); the navigation event it is made from does (`newDocument`). This adapter reads
 * that event from Playwright 1.63's client frame (`_eventEmitter`, "navigated"), for every frame of every page from the moment the page
 * or frame is known. It is a TEST-ONLY dependency on a pinned private shape: when the shape is absent the journal is UNAVAILABLE and every
 * coverage is incomplete (never clean). The page's `DOMContentLoaded` events cross-check it (a frame cannot load more documents than it
 * committed), and so does every witnessed document (it must match a commit of its own frame).
 *
 * The witness and the recorder are ONE init script, the witness first: Playwright does not define the order of separate init scripts.
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
  /** QUALIFICATION ONLY: loses a commit notification (a fault of the host's journal). Consumers never set it. */
  commits?: (commit: CommitEvent) => "deliver" | "drop";
  /** QUALIFICATION ONLY: the host's commit adapter is treated as absent (a Playwright without the pinned shape). */
  withoutCommitJournal?: boolean;
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
  url: string;
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
  /** Reports the test has received but not yet decided on (a held transport): a sealed interval has none. */
  let inTransit = 0;
  const pages = new Map<Page, { id: number; loads: string[] }>();
  const frames = new WeakMap<Frame, number>();
  let frameCount = 0;
  const frameId = (frame: Frame) => {
    let id = frames.get(frame);
    if (id === undefined) {
      frameCount += 1;
      id = frameCount;
      frames.set(frame, id);
    }
    return id;
  };
  const commits: CommitEvent[] = [];
  let ordinal = 0;
  const journal = options.withoutCommitJournal
    ? {
        available: false,
        detail: "QUALIFICATION: the commit adapter is treated as absent",
      }
    : { available: true, detail: "" };
  const hooked = new WeakSet<Frame>();
  const isBlank = (url: string) => url === "" || url.startsWith("about:");
  const commit = (entry: Omit<CommitEvent, "ordinal">) => {
    activity += 1;
    ordinal += 1;
    const event = { ordinal, ...entry };
    if (options.commits?.(event) === "drop") return;
    commits.push(event);
  };
  /** The host's commit journal for one frame: registered when the frame is first known, before anything it shows can be judged. */
  const hookFrame = (page: number, frame: Frame) => {
    if (hooked.has(frame) || !journal.available) return;
    hooked.add(frame);
    const id = frameId(frame);
    const main = frame.parentFrame() === null;
    const emitter = (
      frame as unknown as {
        _eventEmitter?: {
          on?: (event: string, listener: (e: unknown) => void) => unknown;
        };
      }
    )._eventEmitter;
    if (typeof emitter?.on !== "function") {
      journal.available = false;
      journal.detail =
        "Playwright's client frame has no navigation event emitter (the pinned 1.63 shape)";
      return;
    }
    emitter.on("navigated", (raw) => {
      activity += 1;
      const event = raw as {
        url?: unknown;
        newDocument?: unknown;
        error?: unknown;
      };
      if (typeof event?.url !== "string") {
        journal.available = false;
        journal.detail = "a navigation event without a URL (an unpinned shape)";
        return;
      }
      // An aborted attempt (error) and a same-document navigation (no newDocument) commit no document.
      if (event.error || !event.newDocument) return;
      commit({ page, frame: id, main, url: event.url, kind: "commit" });
    });
    // A document the frame already showed when the host first saw it (a popup that committed before it was reported).
    const url = frame.url();
    if (!isBlank(url))
      commit({ page, frame: id, main, url, kind: "registration" });
  };
  // The expected-document side is registered BEFORE any script or binding: every page of the context, and every page it opens later.
  const watch = (page: Page) => {
    if (pages.has(page)) return pages.get(page)?.id ?? 0;
    const state = { id: pages.size + 1, loads: [] as string[] };
    pages.set(page, state);
    activity += 1;
    for (const frame of page.frames()) hookFrame(state.id, frame);
    page.on("frameattached", (frame) => {
      activity += 1;
      hookFrame(state.id, frame);
    });
    page.on("domcontentloaded", () => {
      activity += 1;
      state.loads.push(page.url());
    });
    const busy = () => {
      activity += 1;
    };
    page.on("framenavigated", busy);
    page.on("framedetached", busy);
    page.on("close", busy);
    return state.id;
  };
  for (const page of context.pages()) watch(page);
  context.on("page", watch);
  const idOf = (page: Page | null | undefined) => (page ? watch(page) : 0);
  /** Where a report came from, captured when it is RECEIVED (before any transport delay): its page, its frame, and whether that is main. */
  const origin = (source: { page?: Page | null; frame: Frame }) => ({
    page: idOf(source.page),
    // A frame the journal never saw keeps a frame identity of its own (its documents then match no commit: incomplete, never clean).
    frame: frameId(source.frame),
    // Only a page's MAIN frame is an application document (the app has no frames; a frame's violation still counts).
    main: source.frame.parentFrame() === null,
  });

  const witness: WitnessEvent[] = [];
  const reports: OracleEvent[] = [];
  const decide = async (report: TransportReport) => {
    inTransit += 1;
    try {
      return options.transport ? await options.transport(report) : "deliver";
    } finally {
      inTransit -= 1;
    }
  };
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
      const from = origin(source);
      const fate = await decide({
        binding: "witness",
        doc: payload.doc,
        type: payload.type,
        url: payload.url,
      });
      if (fate !== "deliver") return;
      activity += 1;
      witness.push({
        ...from,
        doc: payload.doc,
        role: payload.role,
        type: payload.type,
        url: payload.url,
      });
    },
  );
  await context.exposeBinding(
    "__displayOracleReport",
    async (source, payload: Omit<OracleEvent, "page" | "main" | "frame">) => {
      const from = origin(source);
      const fate = await decide({
        binding: "oracle",
        doc: payload.doc,
        type: payload.type,
        sseq: payload.sseq,
        url: payload.url,
      });
      if (fate !== "deliver") return;
      activity += 1;
      reports.push({ ...payload, ...from });
    },
  );
  // ONE ordered bootstrap: the witness first (the recorder of the same document takes its identity from it). Each part is isolated: a
  // failed witness leaves an unwitnessed recorder, a failed recorder an unenrolled document (missing), never a clean one.
  await context.addInitScript({
    content: [
      "(() => {",
      `  try { (${witnessScript.toString()})(${JSON.stringify(EVIDENCE_COOKIE)}); } catch (_) {}`,
      `  try { (${oracleScript.toString()})(${JSON.stringify({ markers, limits })}); } catch (_) {}`,
      "})();",
    ].join("\n"),
  });

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

  /** Bounds one in-page question (an unanswered question is a failed inspection, never a clean one). */
  async function bounded<T>(question: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        question,
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
  /** Asks a page's CURRENT document, once, for its identity and what it holds. */
  function ask(page: Page) {
    return bounded(
      page.evaluate(() => {
        const w = window as unknown as {
          __displayOracleDocument?: {
            doc: string;
            url: string;
            current(): boolean;
          };
          __displayOracle?: { flush(): unknown };
        };
        // A witness or recorder left by an EARLIER document of a reused Window does not witness or answer for this one.
        const handle = w.__displayOracleDocument;
        const witnessed = handle?.current() ? handle : null;
        return {
          witness: witnessed?.doc ?? null,
          created: witnessed?.url ?? null,
          answer: (w.__displayOracle?.flush() ?? null) as FlushAnswer | null,
          url: location.href,
        };
      }),
    );
  }
  /** Whether each SUBFRAME's current document is observed by its own witness and recorder. */
  async function framesOf(page: Page) {
    const found: Array<{ url: string; observed: boolean | null }> = [];
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      const url = frame.url();
      const observed = await bounded(
        frame.evaluate(() => {
          const w = window as unknown as {
            __displayOracleDocument?: { current(): boolean };
            __displayOracle?: { flush(): { current?: boolean } };
          };
          return (
            w.__displayOracleDocument?.current() === true &&
            w.__displayOracle?.flush().current === true
          );
        }),
      ).catch(() => null);
      found.push({ url, observed });
    }
    return found;
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
        const mainFrame = frameId(page.mainFrame());
        if (page.isClosed()) {
          states.push({
            page: state.id,
            mainFrame,
            loads,
            inspection: { state: "closed" },
          });
          continue;
        }
        const url = page.url();
        try {
          const got = await ask(page);
          // Only the CURRENT document's own recorder answers for it (a reused Window can hold an earlier document's recorder).
          const answer = got.answer?.current ? got.answer : null;
          if (answer) answers.push({ ...answer, page: state.id });
          states.push({
            page: state.id,
            mainFrame,
            loads,
            frames: await framesOf(page),
            inspection: {
              state: "answered",
              // The CURRENT document: its witness, or a recorder of its own when the witness was switched off (a test seam).
              doc: got.witness ?? answer?.doc ?? null,
              docUrl: got.created ?? answer?.url ?? null,
              url: got.url,
            },
          });
        } catch (error) {
          states.push({
            page: state.id,
            mainFrame,
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
      if (activity === before && inTransit === 0) {
        unstable = undefined;
        break;
      }
      unstable = `the sealed collection never found an interval with no activity (5 attempts; last ${before} → ${activity}, ${inTransit} reports in transit)`;
    }
    const result: LedgerResult = assess({
      pages: states,
      witness: [...witness],
      reports: [...reports],
      answers,
      counters,
      commits: [...commits],
      journal: { ...journal },
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
