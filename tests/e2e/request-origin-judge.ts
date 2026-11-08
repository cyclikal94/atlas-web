/**
 * WEB-14a revision 43 (F-FRESH-2), corrected in revision 44: WHO made each request the generation server received, and whether every
 * request of an observation window reached a terminal outcome, judged per occurrence. Pure (no Playwright), so the rules have deterministic
 * unit tests (tests/pwa/request-origin-judge.test.ts); tests/e2e/request-origin.ts records the inputs and bounds the wait.
 *
 * The server gives every request a unique, increasing id and sends it back in the `X-Atlas-Fixture-Request` response header
 * (scripts/serve-generations.mjs). The browser side is Playwright's own record of the context's network: each request with its origin
 * (a page's frame, or a service worker), whether it was a navigation, its response (status, the id header, and whether a worker's fetch
 * handler answered it, `fromServiceWorker`) and its END: `requestfinished` or `requestfailed`. A server entry is joined to the browser
 * records that carry ITS id, never by URL or arrival order, so two equal reads from different tabs stay two occurrences.
 *
 * Qualified per engine (.agtx/evidence/revision-r43-20261102/q2, requalified in revision 44): every page read and navigation of a controlled
 * page is observed with its id in Chromium, Firefox and WebKit; a worker's OWN request is reported as a worker request in Chromium and is not
 * reported at all in Firefox and WebKit (so it stays unobserved); a page request that a worker answers by forwarding it has
 * `fromServiceWorker` true in all three. `Request.serviceWorker()` is null outside Chromium, so its absence never proves page origin: only
 * an observed page frame does.
 *
 * REVISION 44 (review r43, F-FRESH-2 incomplete_fix; design assessment C1-C6). Revision 43 waited on one predicate (`settled`) and judged
 * with another (`judge`) over different sets, so an observed backend request that never finished, failed without a server receipt, or had
 * an unknown origin could leave the verdict with no problem at all. `reconcile` replaces both: ONE pass over immutable snapshots that
 * returns `failures` (known wrong outcomes) and `unresolved` (obligations not yet terminal), and the window passes only when BOTH are empty.
 * The recorder waits while anything is unresolved and, at its bound, reports what is still unresolved as problems; nothing that was
 * admitted can drop out by origin, status or a missing receipt. The domain:
 *  - every server entry of the window (from, to], and every earlier entry a backend browser record of the window names as its receipt;
 *  - every browser record of the window (seenFrom, seenTo], and every earlier record still unfinished when the window opened (`carry`);
 * restricted, on both sides, by the same scope (`backend`: backend paths; `all`: everything of the origin).
 */

/** The backend paths (deploy/nginx/web.conf): never the shell, never a worker's request. */
export const BACKEND_PATH = /^\/(?:api|health|ready|auth|oidc)(?:[/?]|$)/;

/**
 * The browser's OWN requests, made outside any page or worker script, which no engine reports as a page's: the worker SCRIPT's update check
 * and the tab icon. ADAPTED in revision 2 (labelled; kept): the original offline check excluded exactly these two (WebKit's `/sw.js` check
 * fell inside a probe window with no page request for it in the trace). Neither is a backend path or the shell. Nothing else is exempt.
 */
export const BROWSER_OWN: ReadonlySet<string> = new Set([
  "GET /sw.js",
  "GET /favicon.ico",
]);

export interface LedgerEntry {
  id: number;
  method: string;
  /** Path and query. */
  path: string;
  at: number;
  status: number;
  end: "finished" | "closed" | null;
}

/** One reply of the server's append-only ledger: every entry with an id in (after, high], in order. */
export interface Ledger {
  after: number;
  high: number;
  entries: readonly LedgerEntry[];
}

/** One request as the browser reported it (tests/e2e/request-origin.ts). */
export interface Seen {
  /** The recorder's own order (1, 2, ...). */
  n: number;
  method: string;
  /** Path and query, same origin only. */
  path: string;
  /** `page`: made by a page's frame; `worker`: reported as a service worker's request; `unknown`: neither could be established. */
  origin: "page" | "worker" | "unknown";
  /** The page's label when `origin` is `page`. */
  page: string | null;
  navigation: boolean;
  /** The `X-Atlas-Fixture-Request` header exactly as received; null before a response, or when the response carried none. */
  idHeader: string | null;
  /** The server id when `idHeader` is a positive safe integer in canonical form; null otherwise. */
  id: number | null;
  /** The response status once headers arrived; null before (headers alone are NOT an end). */
  status: number | null;
  fromServiceWorker: boolean | null;
  /** True once the browser reported `requestfinished`. */
  finished: boolean;
  /** The browser's failure text once it reported `requestfailed`, before or after headers. */
  failed: string | null;
}

export type Phase = "pending" | "headers" | "finished" | "failed";

export const phaseOf = (record: Seen): Phase =>
  record.failed !== null
    ? "failed"
    : record.finished
      ? "finished"
      : record.status !== null
        ? "headers"
        : "pending";

/** True once the browser reported the request's end (finished or failed). */
export const terminal = (record: Seen): boolean =>
  record.failed !== null || record.finished;

/** The server id in a header value, or null unless it is a canonical positive safe integer (no sign, no leading zero, no exponent). */
export function parseRequestId(header: string | null): number | null {
  if (header === null || !/^[1-9][0-9]*$/.test(header)) return null;
  const id = Number(header);
  return Number.isSafeInteger(id) ? id : null;
}

export interface Window {
  /** Server ids after `from` ... */
  from: number;
  /** ... up to and including `to`. */
  to: number;
  /** Browser records after `seenFrom` ... */
  seenFrom: number;
  /** ... up to and including `seenTo`. */
  seenTo: number;
  /** Browser records at or before `seenFrom` that were unfinished when the window opened: still this window's to account for. */
  carry: readonly number[];
}

export type Verdict =
  | "page"
  | "browser-own"
  | "worker-origin"
  | "worker-fulfilled"
  | "unobserved"
  | "duplicate"
  | "unfinished"
  | "status-mismatch"
  | "field-mismatch"
  | "failed"
  | "not-get"
  | "pending";

export interface Attribution {
  entry: LedgerEntry;
  seen: Seen[];
  verdict: Verdict;
}

export interface Probe {
  /** The probe page's label. */
  page: string;
  /** The path (and query) the probe navigated to. */
  path: string;
  status: number;
}

export interface JudgeOptions {
  /**
   * `backend`: every BACKEND request in the window must be a page's own, answered by the server (not a worker's fetch handler), and must
   * end; other requests are not judged (a worker's installation fetches its static files). `all`: additionally, every other request must
   * be a page's and end, except exactly BROWSER_OWN, which may go unobserved.
   */
  scope: "backend" | "all";
  /** A navigation that must have reached the server exactly once in this window, from this page, with this status. */
  probe?: Probe;
}

export interface Reconciliation {
  /** Every owned server entry, judged or not, with its verdict. */
  attributions: Attribution[];
  /** The backend entries attributed to a page (non-vacuity). */
  pageBackend: Attribution[];
  /** Known wrong outcomes. */
  failures: string[];
  /** Obligations without a terminal outcome yet: an end, a receipt or an observation still missing. Never a pass. */
  unresolved: string[];
  /** `failures` then `unresolved`: empty only when the window passes. */
  problems: string[];
  /** The browser records this window accounted for (their `n`). */
  owned: number[];
  /** The server ids this window accounted for. */
  receipts: number[];
}

const pathname = (path: string) => path.split("?")[0] ?? path;
const isBackend = (path: string) => BACKEND_PATH.test(path);
const own = (entry: LedgerEntry) =>
  BROWSER_OWN.has(`${entry.method} ${pathname(entry.path)}`);
const describe = (entry: LedgerEntry) =>
  `#${entry.id} ${entry.method} ${entry.path} (${entry.status}, ${entry.end ?? "unfinished"})`;
const who = (record: Seen) =>
  record.origin === "page" ? `page ${record.page}` : `${record.origin}`;
const seenAs = (observed: readonly Seen[]) =>
  observed.length > 0
    ? ` (seen as ${observed.map((record) => `${record.origin}${record.page ? ` ${record.page}` : ""}${record.navigation ? " navigation" : ""}${record.fromServiceWorker ? " answered by the worker" : ""}`).join("; ")})`
    : "";
const isEntry = (value: unknown): value is LedgerEntry => {
  const entry = value as LedgerEntry;
  return (
    typeof entry === "object" &&
    entry !== null &&
    Number.isSafeInteger(entry.id) &&
    entry.id > 0 &&
    typeof entry.method === "string" &&
    typeof entry.path === "string" &&
    entry.path.startsWith("/") &&
    Number.isSafeInteger(entry.status) &&
    (entry.end === null || entry.end === "finished" || entry.end === "closed")
  );
};

/**
 * Judges one window over one consistent pair of snapshots (`ledger` read, then `seen` copied). The same call decides both whether the
 * recorder may stop waiting (`unresolved` empty) and whether the window passes (`problems` empty), so what is waited for and what is judged
 * can never differ.
 */
export function reconcile(
  window: Window,
  ledger: Ledger,
  seen: readonly Seen[],
  options: JudgeOptions,
): Reconciliation {
  const failures: string[] = [];
  const unresolved: string[] = [];
  const inScope = (path: string) => options.scope === "all" || isBackend(path);

  // The ledger reply itself: contiguous, unique, well formed, and covering the window. Anything else is an unknown, never a pass.
  if (
    !Number.isSafeInteger(ledger.after) ||
    !Number.isSafeInteger(ledger.high) ||
    ledger.after < 0 ||
    ledger.high < ledger.after
  )
    failures.push(
      `ledger reply (after ${ledger.after}, high ${ledger.high}) is malformed`,
    );
  if (window.from < ledger.after || window.to > ledger.high)
    failures.push(
      `ledger reply (${ledger.after}, ${ledger.high}] does not cover window (${window.from}, ${window.to}]`,
    );
  const counts = new Map<number, number>();
  const byId = new Map<number, LedgerEntry>();
  for (const value of ledger.entries) {
    if (!isEntry(value)) {
      failures.push(`ledger entry ${JSON.stringify(value)} is malformed`);
      continue;
    }
    if (value.id <= ledger.after || value.id > ledger.high) {
      failures.push(
        `server request #${value.id} is outside the ledger reply (${ledger.after}, ${ledger.high}]`,
      );
      continue;
    }
    counts.set(value.id, (counts.get(value.id) ?? 0) + 1);
    if (!byId.has(value.id)) byId.set(value.id, value);
  }
  for (let id = ledger.after + 1; id <= ledger.high; id++) {
    const count = counts.get(id) ?? 0;
    if (count === 0)
      failures.push(`server request #${id} is missing from the ledger`);
    if (count > 1)
      failures.push(
        `server request #${id} appears ${count} times in the ledger`,
      );
  }

  // The browser records this window owns, and the earlier receipts its backend records name.
  const carried = new Set(window.carry);
  const owned = seen.filter(
    (record) =>
      (record.n > window.seenFrom && record.n <= window.seenTo) ||
      carried.has(record.n),
  );
  const receipts = new Set<number>();
  for (const entry of byId.values())
    if (entry.id > window.from && entry.id <= window.to) receipts.add(entry.id);
  // A backend record answered by the network names its receipt. (A worker-answered response carries a stale COPY of a cached header, so
  // its id is never a receipt; a backend one fails below anyway.)
  const names = (record: Seen) =>
    isBackend(record.path) &&
    record.fromServiceWorker === false &&
    record.id !== null;
  for (const record of owned)
    if (inScope(record.path) && names(record) && byId.has(record.id as number))
      receipts.add(record.id as number);

  const observedBy = new Map<number, Seen[]>();
  for (const record of seen)
    if (record.id !== null)
      observedBy.set(record.id, [...(observedBy.get(record.id) ?? []), record]);

  // Server side: every owned entry the scope judges must be a page's own, ended, consistent request.
  const attributions: Attribution[] = [];
  for (const id of [...receipts].sort((a, b) => a - b)) {
    const entry = byId.get(id) as LedgerEntry;
    const observed = observedBy.get(id) ?? [];
    const pages = observed.filter((record) => record.origin === "page");
    const others = observed.filter((record) => record.origin !== "page");
    const first = pages[0];
    let verdict: Verdict;
    // A backend receipt that a worker's record carries is known wrong as soon as it is seen, ended or not (the product worker never
    // fetches a backend path); a static one may still be a page's forwarded request whose page record has not ended yet, so it waits.
    const workerBackend = isBackend(entry.path) && others.length > 0;
    if (entry.end === "closed") verdict = "unfinished";
    else if (workerBackend)
      verdict = pages.length === 0 ? "worker-origin" : "worker-fulfilled";
    else if (entry.end === null || observed.some((r) => !terminal(r)))
      verdict = "pending";
    else if (observed.length === 0)
      verdict = own(entry) ? "browser-own" : "unobserved";
    else if (pages.length === 0 || first === undefined)
      verdict = "worker-origin";
    else if (pages.length > 1) verdict = "duplicate";
    else if (
      isBackend(entry.path) &&
      (others.length > 0 || first.fromServiceWorker !== false)
    )
      verdict = "worker-fulfilled";
    else if (first.status !== entry.status) verdict = "status-mismatch";
    else if (first.method !== entry.method || first.path !== entry.path)
      verdict = "field-mismatch";
    else if (first.failed !== null) verdict = "failed";
    else if (isBackend(entry.path) && entry.method !== "GET")
      verdict = "not-get";
    else verdict = "page";
    attributions.push({ entry, seen: observed, verdict });
    if (!inScope(entry.path)) continue;
    // (BROWSER_OWN holds no backend path. A static request that a page made and the worker answered from its asset route is "page":
    // `worker-fulfilled` is a backend verdict only.)
    if (verdict === "page" || verdict === "browser-own") continue;
    if (verdict === "pending")
      unresolved.push(
        `${describe(entry)}: ${entry.end === null ? "the server has not finished it" : "the browser has not ended it"}${seenAs(observed)}`,
      );
    // Not seen YET: the browser's report of a request can lag the server's receipt, so this is waited for; at the bound it is a problem.
    else if (verdict === "unobserved")
      unresolved.push(`${describe(entry)}: unobserved`);
    else failures.push(`${describe(entry)}: ${verdict}${seenAs(observed)}`);
  }

  // Browser side: every owned record the scope judges must end, from a page, and a backend one with its own receipt from the server, even
  // when the server never saw it.
  for (const record of owned) {
    if (!inScope(record.path)) continue;
    const label = `${who(record)} ${record.method} ${record.path}`;
    const at = `browser record ${record.n}`;
    if (record.idHeader !== null && record.id === null)
      failures.push(
        `${label}: malformed server request id ${JSON.stringify(record.idHeader)} (${at})`,
      );
    if (record.failed !== null) {
      failures.push(
        `${label}: failed${record.status !== null ? ` after headers (${record.status})` : ""}: ${record.failed} (${at})`,
      );
      continue;
    }
    // A backend answer from a worker's fetch handler is known wrong from its headers, whether or not the request has ended yet.
    const workerAnswered =
      record.origin === "page" &&
      isBackend(record.path) &&
      record.status !== null &&
      record.fromServiceWorker === true;
    if (workerAnswered)
      failures.push(`${label}: answered by the worker (${at})`);
    // Likewise a worker's backend request is known wrong from its admission.
    const workerRequest = record.origin === "worker" && isBackend(record.path);
    if (workerRequest)
      failures.push(`${label}: a worker's backend request (${at})`);
    if (!record.finished) {
      unresolved.push(
        `${label}: no end yet (${at}, ${record.status === null ? "pending" : `headers ${record.status} only`})`,
      );
      continue;
    }
    if (record.origin === "unknown") {
      failures.push(`${label}: no page frame made it (${at})`);
      continue;
    }
    if (record.origin === "worker") {
      // A worker's backend request is never allowed. A worker's static fetch is judged through its receipt (in scope `all`); one with no
      // receipt at all is unattributable.
      if (workerRequest) continue;
      if (record.id === null)
        failures.push(`${label}: no server receipt (${at})`);
      continue;
    }
    if (!isBackend(record.path)) continue;
    if (record.status === null)
      failures.push(`${label}: ended without a response (${at})`);
    else if (workerAnswered) continue;
    else if (record.fromServiceWorker !== false)
      failures.push(`${label}: answered by the worker (${at})`);
    else if (record.idHeader === null)
      failures.push(`${label}: answered without a server request id (${at})`);
    else if (record.id !== null && !byId.has(record.id)) {
      if (record.id > ledger.high)
        unresolved.push(
          `${label}: its server request #${record.id} is not in the ledger yet (${at})`,
        );
      else
        failures.push(
          `${label}: names server request #${record.id}, which ${record.id <= ledger.after ? "is outside the ledger read" : "does not exist"} (${at})`,
        );
    }
  }

  if (options.probe) {
    const { probe } = options;
    const navigations = attributions.filter(
      (attribution) =>
        attribution.entry.path === probe.path &&
        attribution.seen.some(
          (record) =>
            record.origin === "page" &&
            record.page === probe.page &&
            record.navigation,
        ),
    );
    if (navigations.length !== 1)
      failures.push(
        `probe ${probe.page} ${probe.path}: reached the server ${navigations.length} times, not once`,
      );
    for (const navigation of navigations) {
      if (navigation.verdict !== "page")
        failures.push(
          `probe ${probe.page} ${probe.path}: ${navigation.verdict}`,
        );
      if (navigation.entry.status !== probe.status)
        failures.push(
          `probe ${probe.page} ${probe.path}: server answered ${navigation.entry.status}, not ${probe.status}`,
        );
    }
  }

  return {
    attributions,
    pageBackend: attributions.filter(
      (attribution) =>
        isBackend(attribution.entry.path) && attribution.verdict === "page",
    ),
    failures,
    unresolved,
    problems: [...failures, ...unresolved],
    owned: owned.map((record) => record.n),
    receipts: [...receipts].sort((a, b) => a - b),
  };
}
