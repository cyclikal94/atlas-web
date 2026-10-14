import type { BrowserContext, Page } from "@playwright/test";
import { expect } from "./helpers";

/**
 * WEB-08c revision 3 (R5; design assessment P1, Q1): a CONTINUOUS no-early-display oracle for real pages. TEST-ONLY: it is an init script,
 * installed in every page of a context before any application script runs, and a binding that reports to the test process.
 *
 * What it decides. A page may expose an account (put a node into `#protected-root`, remove its `inert` or `aria-hidden`, set a protected
 * title, or show an account's marker text anywhere in the document) only while the LATEST `atlas-auth` record THIS page has seen COMMITTED
 * names that account as settled with no fence entry for it. That record is observed at the durable boundary itself: every `atlas-auth`
 * transaction of the page is followed, the record it read (`getAll`) or wrote (`put` of `auth_state`) is summarised, and the summary is
 * adopted only when the transaction's `complete` event is delivered (a completion listener added when the transaction is created runs before
 * the application's own `oncomplete`). An aborted transaction changes nothing. The exposure cover is such a transaction, so a correct page
 * always has the authorising record in hand before its `act`; a page that lifts or mounts while its last committed record still holds the
 * fence is a violation, whatever happens afterwards.
 *
 * Why not the final state. Every DOM change is taken from a `MutationObserver`'s RECORDS, which keep each change (an `inert` removed and set
 * again in one task is two records; a node appended and removed is two records), and the records are drained synchronously into the same
 * ordered log before every observed `atlas-auth` event and kernel trace event, so the order of a mutation and a durable boundary is the
 * order in the page. A violation is recorded when it happens and reported at once; a later re-gate cannot erase it.
 *
 * Enrolment. Each page reports `enrolled` from the init script, before the document has any application script; `assertClean` fails for
 * any page of the context that did not enrol (a page that escaped the oracle is a failed setup, never a silent pass).
 *
 * The kernel trace of the fixture's session harness (`window.__atlasFixture.session.trace`) is followed when it exists, as annotations
 * only (the production build has none); it never authorises anything.
 */

export interface OracleViolation {
  page: number;
  seq: number;
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

export interface OracleOptions {
  /**
   * Account-specific text (usernames, cached content). None of it may be in the document while NO account is authorised: the neutral
   * states and the gate never show anything about an account. (A displayed account's own tree may name OTHER retained accounts: the
   * switcher lists them by their verified names, by design.)
   */
  markers?: string[];
}

interface PageReport {
  type: "enrolled" | "violation" | "boundary" | "incomplete";
  page: number;
  url?: string;
  violation?: OracleViolation;
  boundary?: { seq: number; account: string | null; kind: string };
  detail?: string;
}

/** The in-page part. Self-contained: it is serialised into the init script. */
function oracleScript(config: { markers: string[] }): void {
  const w = window as unknown as {
    __displayOracle?: unknown;
    __displayOracleReport?: (report: unknown) => void;
    __atlasFixture?: unknown;
  };
  if (new URL(location.href).searchParams.get("oracle") === "off") return;
  const pageId = Math.floor(Math.random() * 1e9);
  const log: Array<Record<string, unknown>> = [];
  const violations: Array<Record<string, unknown>> = [];
  let seq = 0;
  let record: {
    settled: string | null;
    epoch: number | null;
    fences: Record<string, number>;
    tx: number;
  } | null = null;
  /** The account whose exposure this page is in (opened by an authorised exposure, ended by a gate or an empty root). */
  let episode: string | null = null;
  const report = (payload: Record<string, unknown>) => {
    try {
      w.__displayOracleReport?.({ page: pageId, ...payload });
    } catch {
      // The binding is gone (the page is closing): the in-page log keeps it.
    }
  };
  /** A limit of the recorder that was reached: the page's qualification is INCOMPLETE (never a clean result). */
  const limits: string[] = [];
  const incomplete = (what: string) => {
    if (limits.includes(what)) return;
    limits.push(what);
    report({ type: "incomplete", detail: what });
  };
  const push = (entry: Record<string, unknown>) => {
    seq += 1;
    const item = { seq, t: performance.now(), ...entry };
    if (log.length < 20_000) log.push(item);
    else incomplete("log over 20000 entries");
    return item;
  };
  const authorised = (): string | null => {
    if (!record || record.settled === null) return null;
    return (record.fences[record.settled] ?? 0) === 0 ? record.settled : null;
  };
  const violate = (kind: string, detail: string) => {
    const item = push({ op: "VIOLATION", kind, detail, record });
    const v = { page: pageId, seq: item.seq, kind, detail, record };
    violations.push(v);
    report({ type: "violation", violation: v });
  };
  const rootOf = () => document.getElementById("protected-root");
  /** An exposure event: allowed only for the authorised account; it opens (or continues) that account's episode. */
  const exposure = (kind: string, detail: string) => {
    const allowed = authorised();
    if (allowed === null) {
      violate(kind, detail);
      return;
    }
    if (episode !== allowed) {
      episode = allowed;
      const item = push({ op: "episode.open", account: allowed, record });
      report({
        type: "boundary",
        boundary: { seq: item.seq, account: allowed, kind: "episode.open" },
      });
    }
  };
  /**
   * WEB-08c revision 4 (R5 of the review of 14 October 2026; design assessment P1, S13/S14): what a node EXPOSES to a reader or to
   * assistive technology is its text AND its name-bearing attributes. Every one of them is watched, on every element of the document,
   * and judged on each value WRITTEN, reconstructed per target from the records (an attribute: the next record's old value for the same
   * element and attribute; a text node: the next record's old value for the same node), so a value set and reset in one task is seen.
   */
  const NAMED = [
    "aria-label",
    "aria-description",
    "aria-roledescription",
    "aria-valuetext",
    "aria-placeholder",
    "aria-labelledby",
    "aria-describedby",
    "title",
    "alt",
    "placeholder",
    "value",
    "label",
  ];
  const GATES = ["inert", "aria-hidden"];
  /** The text an attribute value exposes: an id reference names the text of the elements it refers to. */
  const attributeText = (name: string, value: string | null): string => {
    if (value === null) return "";
    if (name !== "aria-labelledby" && name !== "aria-describedby") return value;
    return value
      .split(/\s+/)
      .map((id) => (id ? document.getElementById(id) : null))
      .map((el) =>
        el
          ? `${el.textContent ?? ""} ${el.getAttribute("aria-label") ?? ""}`
          : "",
      )
      .join(" ");
  };
  /** A node's text and the name-bearing attributes of it and of every element under it. */
  const exposedText = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
    if (!(node instanceof Element)) return "";
    const parts = [node.textContent ?? ""];
    const elements = [node, ...node.querySelectorAll("*")];
    for (const el of elements.slice(0, 5_000))
      for (const name of NAMED)
        if (
          el.hasAttribute(name) &&
          // HF-14: a value the person entered into this field is not judged (below).
          !(name === "value" && entered.get(el) === el.getAttribute(name))
        )
          parts.push(attributeText(name, el.getAttribute(name)));
    if (elements.length > 5_000) incomplete("subtree over 5000 elements");
    return parts.join(" ");
  };
  /**
   * Nodes INSERTED while no exposure episode was open (and everything under them then). Their earlier values are as prohibited as their
   * later ones: an old value of one of their records, or the text of one that is removed again, is judged too. (A node that was present
   * during an authorised episode is not: its unmount under the gate is legitimate.)
   */
  /**
   * WEB-08c revision 4 (HF-14): what the PERSON entered into a form field is not something the application disclosed. React mirrors a
   * controlled input's value into its `value` attribute, so a username typed into the sign-in form while another account is fenced was
   * reported as a marker (I-L13 R1/R2 in three engines: "kate", "liam", "nora", each the test's own typing). The value of every `input`
   * event is recorded per element (capture phase, before the framework mirrors it), and a `value` attribute written EQUAL to what the person
   * entered in that element is not judged. Any other value write (a prefill with no input event, another field's value) still is.
   */
  const entered = new WeakMap<Node, string>();
  document.addEventListener(
    "input",
    (event) => {
      const target = event.target as { value?: unknown } | null;
      if (target && typeof target.value === "string")
        entered.set(target as unknown as Node, target.value);
    },
    true,
  );
  const insertedClosed = new WeakSet<Node>();
  /** The inserted subtree a node came with: one exposure of that subtree is reported once, whichever of its records shows it. */
  const insertedWith = new WeakMap<Node, Node>();
  const enrolClosed = (node: Node) => {
    insertedClosed.add(node);
    insertedWith.set(node, node);
    const walker = document.createTreeWalker(node);
    let count = 0;
    while (walker.nextNode() && count < 20_000) {
      insertedClosed.add(walker.currentNode);
      insertedWith.set(walker.currentNode, node);
      count += 1;
    }
    if (count >= 20_000) incomplete("inserted subtree over 20000 nodes");
  };
  /** The markers already reported for a node: one exposure is one violation, however many of its records show it. */
  const reportedOn = new WeakMap<Node, Set<string>>();
  const checkMarkers = (text: string, where: string, from: Node) => {
    if (episode !== null) return;
    const node = insertedWith.get(from) ?? from;
    for (const word of config.markers) {
      if (!text.includes(word)) continue;
      {
        let seen = reportedOn.get(node);
        if (!seen) {
          seen = new Set();
          reportedOn.set(node, seen);
        }
        if (seen.has(word)) continue;
        seen.add(word);
      }
      violate("marker", `${where}: "${word}"`);
    }
  };
  const NEUTRAL_TITLES = new Set([
    "",
    "Atlas",
    // The fixture build's own static title (index.html of the fixture mode): the build's name, nothing about an account.
    "Atlas (fixture)",
    "Sign in · Atlas",
    "Join · Atlas",
  ]);
  /**
   * Judged on the value WRITTEN (a title set and reset in one task is two writes), never on the title as it is now. A value of one
   * title text node is reported once, however many of its records show it.
   */
  const titlesOn = new WeakMap<Node, Set<string>>();
  const checkTitle = (title: string, from?: Node) => {
    push({ op: "title", title });
    if (NEUTRAL_TITLES.has(title.trim()) || episode !== null) return;
    if (from) {
      const node = insertedWith.get(from) ?? from;
      let seen = titlesOn.get(node);
      if (!seen) {
        seen = new Set();
        titlesOn.set(node, seen);
      }
      if (seen.has(title)) return;
      seen.add(title);
    }
    violate("title", `title "${title}"`);
  };
  /** Whether a record is the setter's own change of the <title> element (already judged on the value written). */
  const titleRecord = (r: MutationRecord): boolean => {
    const target = r.target as Node;
    if (target.nodeName === "TITLE" || target.parentNode?.nodeName === "TITLE")
      return true;
    return [...r.addedNodes].some((node) => node.nodeName === "TITLE");
  };
  const titleDescriptor = Object.getOwnPropertyDescriptor(
    Document.prototype,
    "title",
  );
  if (titleDescriptor?.set) {
    const setTitle = titleDescriptor.set;
    Object.defineProperty(Document.prototype, "title", {
      ...titleDescriptor,
      set(this: Document, value: string) {
        drain();
        checkTitle(String(value));
        setTitle.call(this, value);
        // The setter's own change of the <title> element is already judged; every OTHER record is handled (none is discarded unseen).
        handle(observer.takeRecords().filter((r) => !titleRecord(r)));
      },
    });
  }
  const inTitle = (node: Node) =>
    node.nodeName === "TITLE" || node.parentNode?.nodeName === "TITLE";
  const handle = (records: MutationRecord[]) => {
    const root = rootOf();
    // The value a record SET is the next record's old value for the same TARGET (and attribute); only the last record's is the value as
    // it is now. Reading the current value instead hides a change undone in the same task (attributes: revision 3; text: revision 4).
    const setTo = new Map<MutationRecord, string | null>();
    const laterAttr = new Map<Node, Map<string, MutationRecord>>();
    const laterText = new Map<Node, MutationRecord>();
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const r = records[index] as MutationRecord;
      const target = r.target as Node;
      if (r.type === "attributes") {
        const key = `${r.attributeNamespace ?? ""}|${r.attributeName ?? ""}`;
        let byName = laterAttr.get(target);
        if (!byName) {
          byName = new Map();
          laterAttr.set(target, byName);
        }
        const next = byName.get(key);
        const current =
          target instanceof Element
            ? r.attributeNamespace
              ? target.getAttributeNS(
                  r.attributeNamespace,
                  r.attributeName ?? "",
                )
              : target.getAttribute(r.attributeName ?? "")
            : null;
        setTo.set(r, next ? next.oldValue : current);
        byName.set(key, r);
      } else if (r.type === "characterData") {
        const next = laterText.get(target);
        setTo.set(r, next ? next.oldValue : (target.textContent ?? ""));
        laterText.set(target, r);
      }
    }
    for (const r of records) {
      const target = r.target as Node;
      const inRoot =
        root !== null && (target === root || root.contains(target));
      const where = inRoot ? "protected-root" : "document";
      if (r.type === "attributes") {
        const name = r.attributeName ?? "";
        const now = setTo.get(r) ?? null;
        if (target === root && GATES.includes(name)) {
          push({ op: "attr", name, old: r.oldValue, now });
          // A lift: `inert` removed; `aria-hidden` removed or made "false" (both expose the tree to assistive technology).
          const lifted =
            name === "inert"
              ? now === null && r.oldValue !== null
              : (now === null || now === "false") &&
                r.oldValue !== null &&
                r.oldValue !== "false";
          if (lifted)
            exposure(
              "lift",
              `${name} ${now === null ? "removed" : `set to "${now}"`}`,
            );
          else if (now !== null && name === "inert") {
            // A gate: the episode of the account ends (a lift must be authorised again).
            if (episode !== null) push({ op: "episode.close", reason: "gate" });
            episode = null;
          }
        } else if (NAMED.includes(name)) {
          // HF-14: the person's own entry into this field, mirrored by the framework, is not a disclosure.
          if (name === "value" && now !== null && entered.get(target) === now)
            continue;
          checkMarkers(attributeText(name, now), `${where} [${name}]`, target);
          if (insertedClosed.has(target))
            checkMarkers(
              attributeText(name, r.oldValue),
              `${where} [${name}] (earlier)`,
              target,
            );
        }
      } else if (r.type === "childList") {
        // A tree is mounted by inserting its root container DIRECTLY into #protected-root (and portals stay inside the tree, lint R3).
        // Re-renders deep inside a retained, inert tree are not an exposure; its lift is.
        if (target === root && r.addedNodes.length > 0) {
          push({ op: "add", nodes: r.addedNodes.length });
          if (episode === null)
            exposure("mount", "node inserted into #protected-root");
        }
        if (target === root && r.removedNodes.length > 0) {
          push({ op: "remove", nodes: r.removedNodes.length });
          if (root && root.childNodes.length === 0) {
            if (episode !== null)
              push({ op: "episode.close", reason: "unmounted" });
            episode = null;
          }
        }
        for (const node of r.addedNodes) {
          if (episode === null) enrolClosed(node);
          // The parser's own static <title> (the document is still loading) is the build's, not a write by the application.
          if (inTitle(node) || target.nodeName === "TITLE") {
            if (document.readyState !== "loading")
              checkTitle(node.textContent ?? "");
          } else if (episode === null)
            checkMarkers(exposedText(node), where, node);
        }
        // A node inserted while closed and removed again (in this task or later) was in the document: what it showed then is judged.
        if (episode === null)
          for (const node of r.removedNodes)
            if (
              insertedClosed.has(node) &&
              !inTitle(node) &&
              target.nodeName !== "TITLE"
            )
              checkMarkers(exposedText(node), `${where} (removed)`, node);
      } else if (r.type === "characterData") {
        const now = setTo.get(r) ?? "";
        if (inTitle(target)) {
          checkTitle(now, target);
          if (insertedClosed.has(target) && r.oldValue !== null)
            checkTitle(r.oldValue, target);
        } else {
          checkMarkers(now, where, target);
          if (insertedClosed.has(target) && r.oldValue !== null)
            checkMarkers(r.oldValue, `${where} (earlier)`, target);
        }
      }
    }
  };
  const observer = new MutationObserver(handle);
  const drain = () => handle(observer.takeRecords());
  const arm = () =>
    observer.observe(document, {
      subtree: true,
      childList: true,
      characterData: true,
      characterDataOldValue: true,
      attributes: true,
      attributeOldValue: true,
      attributeFilter: [...GATES, ...NAMED],
    });
  arm();

  // ---- the durable boundary: every atlas-auth transaction of this page ----
  type TxInfo = { id: number; mode: string; read: unknown; written: unknown };
  const txs = new WeakMap<IDBTransaction, TxInfo>();
  let txIds = 0;
  const summarise = (values: unknown[], id: number) => {
    const state = values.find(
      (v) =>
        v !== null &&
        typeof v === "object" &&
        "fences" in (v as object) &&
        "settled" in (v as object),
    ) as
      | {
          settled: { account_id: string; epoch: number } | null;
          fences: Record<string, unknown[]>;
        }
      | undefined;
    if (!state) return { settled: null, epoch: null, fences: {}, tx: id };
    const fences: Record<string, number> = {};
    for (const [account, list] of Object.entries(state.fences ?? {}))
      fences[account] = Array.isArray(list) ? list.length : 0;
    return {
      settled: state.settled?.account_id ?? null,
      epoch: state.settled?.epoch ?? null,
      fences,
      tx: id,
    };
  };
  const transaction = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function (
    this: IDBDatabase,
    ...args: Parameters<IDBDatabase["transaction"]>
  ) {
    const tx = transaction.apply(this, args);
    if (this.name === "atlas-auth") {
      const info: TxInfo = {
        id: ++txIds,
        mode: String(args[1] ?? "readonly"),
        read: null,
        written: null,
      };
      txs.set(tx, info);
      tx.addEventListener("complete", () => {
        drain();
        const summary = (info.written ?? info.read) as typeof record;
        if (summary) {
          record = summary;
          push({ op: "auth.commit", tx: info.id, record: summary });
        }
      });
      tx.addEventListener("abort", () => {
        drain();
        push({ op: "auth.abort", tx: info.id });
      });
    }
    return tx;
  } as IDBDatabase["transaction"];
  const getAll = IDBObjectStore.prototype.getAll;
  IDBObjectStore.prototype.getAll = function (
    this: IDBObjectStore,
    ...args: Parameters<IDBObjectStore["getAll"]>
  ) {
    const request = getAll.apply(this, args);
    const info = txs.get(this.transaction);
    if (info)
      request.addEventListener("success", () => {
        info.read = summarise(request.result as unknown[], info.id);
      });
    return request;
  } as IDBObjectStore["getAll"];
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (
    this: IDBObjectStore,
    ...args: Parameters<IDBObjectStore["put"]>
  ) {
    const info = txs.get(this.transaction);
    if (info && args[1] === "auth_state")
      info.written = summarise([args[0]], info.id);
    return put.apply(this, args);
  } as IDBObjectStore["put"];

  // ---- annotations: the fixture harness's kernel trace, when there is one ----
  let fixture: unknown;
  const follow = (value: unknown) => {
    const trace = (value as { session?: { trace?: unknown[] } } | undefined)
      ?.session?.trace;
    if (!Array.isArray(trace) || (trace as { __oracle?: boolean }).__oracle)
      return;
    (trace as { __oracle?: boolean }).__oracle = true;
    const original = trace.push.bind(trace);
    Object.defineProperty(trace, "push", {
      configurable: true,
      writable: true,
      value: (...items: Array<{ event?: string; data?: unknown }>) => {
        drain();
        for (const item of items)
          if (
            item.event &&
            /^(act\.|display\.|gate\.|hold\.|data\.recovery_|evaluate$)/.test(
              item.event,
            )
          )
            push({ op: `k:${item.event}`, data: item.data });
        return original(...items);
      },
    });
  };
  Object.defineProperty(window, "__atlasFixture", {
    configurable: true,
    get: () => fixture,
    set: (value) => {
      fixture = value;
      follow(value);
    },
  });

  w.__displayOracle = {
    log,
    violations,
    mark(label: string) {
      drain();
      push({ op: "mark", label });
    },
    state: () => ({ record, episode }),
    /** Drains every pending record and answers what this document holds (the final acknowledgement of `assertClean`). */
    flush: () => {
      drain();
      return { page: pageId, violations: [...violations], limits: [...limits] };
    },
  };
  push({ op: "enrolled", readyState: document.readyState });
  report({ type: "enrolled", url: location.href });
}

export interface DisplayOracle {
  /** Violations reported by every page of the context so far, including pages that have closed. */
  violations(): OracleViolation[];
  /** The test marks a point in a page's log (for example "finish released"). */
  mark(page: Page, label: string): Promise<void>;
  /** The page's own ordered log (diagnostic). */
  log(page: Page): Promise<Array<Record<string, unknown>>>;
  /**
   * Every DOCUMENT the context loaded enrolled before its application ran, every open document can be inspected and acknowledges what
   * it holds, no recorder limit was reached, and no document (open or closed) reported a violation.
   */
  assertClean(message?: string): Promise<void>;
  /**
   * The coverage of the oracle (WEB-08c revision 4, DA-H1/S16): `missing` lists every document that did not enrol (an open page whose
   * CURRENT document is not enrolled, asked in the page itself; a page that loaded more documents than enrolled from it, closed pages
   * included) and every open document that could not be inspected (unknown is never enrolled). `incomplete` lists recorder limits.
   */
  coverage(): Promise<{
    open: number;
    enrolled: number;
    loaded: number;
    missing: string[];
    incomplete: string[];
  }>;
  /** The marker vocabulary this installation checks (a caller's evidence states it). */
  readonly markers: readonly string[];
}

export async function installDisplayOracle(
  context: BrowserContext,
  options: OracleOptions = {},
): Promise<DisplayOracle> {
  const reports: Array<PageReport & { from: Page | null }> = [];
  const markers = [...(options.markers ?? [])];
  await context.exposeBinding(
    "__displayOracleReport",
    (source, payload: PageReport) => {
      // Only a page's MAIN frame is an application document (the app has no frames; a frame's report still counts as a violation).
      const main = source.frame === source.page?.mainFrame();
      reports.push({ ...payload, from: main ? source.page : null });
    },
  );
  // Each document draws its own id in the page (one init script serves every page of the context).
  await context.addInitScript(oracleScript, { markers });
  /**
   * Every document a page LOADED (its main frame's `domcontentloaded`), by page: each must have enrolled. A document that loaded and was
   * replaced or closed before it could be asked is still accounted for here.
   */
  const loaded = new Map<Page, string[]>();
  const watch = (page: Page) => {
    if (loaded.has(page)) return;
    loaded.set(page, []);
    page.on("domcontentloaded", () => {
      const url = page.url();
      if (url !== "about:blank") loaded.get(page)?.push(url);
    });
  };
  for (const page of context.pages()) watch(page);
  context.on("page", watch);
  type Flushed = {
    page: number;
    violations: OracleViolation[];
    limits: string[];
  } | null;
  const flushed: Flushed[] = [];
  const violations = () =>
    reports
      .filter((r) => r.type === "violation" && r.violation)
      .map((r) => r.violation as OracleViolation);
  return {
    violations,
    assertClean,
    markers,
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
    coverage,
  };
  /** Asks the page's current document to drain and acknowledge; `undefined` when it cannot be inspected (after a few tries). */
  async function flush(page: Page): Promise<Flushed | "closed" | undefined> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (page.isClosed()) return "closed";
      try {
        return await page.evaluate(
          () =>
            (
              window as unknown as {
                __displayOracle?: { flush(): Flushed };
              }
            ).__displayOracle?.flush() ?? null,
        );
      } catch {
        // A navigation replaced the document while it was asked: ask the new one.
        await page.waitForLoadState("domcontentloaded").catch(() => undefined);
      }
    }
    return page.isClosed() ? "closed" : undefined;
  }
  async function coverage() {
    const missing: string[] = [];
    const incomplete: string[] = [];
    const pages = context.pages().filter((page) => !page.isClosed());
    flushed.length = 0;
    /** Pages whose CURRENT document is already reported missing (its load is not counted twice below). */
    const reported = new Set<Page>();
    for (const page of pages) {
      if (page.url() === "about:blank") continue;
      const answer = await flush(page);
      if (answer === "closed") continue;
      if (answer === undefined) {
        missing.push(`${page.url()} (uninspectable)`);
        reported.add(page);
      } else if (answer === null) {
        missing.push(page.url());
        reported.add(page);
      } else {
        flushed.push(answer);
        for (const limit of answer.limits)
          incomplete.push(`${page.url()}: ${limit}`);
      }
    }
    // Every loaded document of every page (closed ones too) must have enrolled from that page.
    for (const [page, urls] of loaded) {
      // A page's initial `about:blank` document enrols too, and is not one of the documents it LOADED (revision 3 found it hiding one).
      const enrolledHere = reports.filter(
        (r) =>
          r.type === "enrolled" &&
          r.from === page &&
          r.url !== undefined &&
          r.url !== "about:blank",
      ).length;
      const deficit = urls.length - enrolledHere - (reported.has(page) ? 1 : 0);
      if (deficit > 0)
        missing.push(
          `${deficit} more of ${urls.length} documents of a page (${urls.at(-1) ?? ""}) did not enrol`,
        );
    }
    for (const r of reports)
      if (r.type === "incomplete")
        incomplete.push(`page ${r.page}: ${r.detail ?? ""}`);
    return {
      open: pages.length,
      enrolled: reports.filter((r) => r.type === "enrolled").length,
      loaded: [...loaded.values()].reduce((n, urls) => n + urls.length, 0),
      missing: [...new Set(missing)],
      incomplete: [...new Set(incomplete)],
    };
  }
  async function assertClean(message?: string) {
    const { missing, incomplete } = await coverage();
    expect(missing, `${message ?? ""} pages that escaped the oracle`).toEqual(
      [],
    );
    expect(
      incomplete,
      `${message ?? ""} recorder limits reached (incomplete)`,
    ).toEqual([]);
    // What each open document holds is acknowledged: a violation whose report was not delivered (yet) is still counted.
    const all = new Map<string, OracleViolation>();
    for (const v of violations()) all.set(`${v.page}:${v.seq}`, v);
    for (const answer of flushed)
      for (const v of answer?.violations ?? [])
        all.set(`${v.page}:${v.seq}`, v);
    expect([...all.values()], `${message ?? ""} early display`).toEqual([]);
  }
}
