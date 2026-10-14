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
export interface OracleOptions {
  /**
   * Account-specific text (usernames, cached content). None of it may be in the document while NO account is authorised: the neutral
   * states and the gate never show anything about an account. (A displayed account's own tree may name OTHER retained accounts: the
   * switcher lists them by their verified names, by design.)
   */
  markers?: string[];
}

interface PageReport {
  type: "enrolled" | "violation" | "boundary";
  page: number;
  url?: string;
  violation?: OracleViolation;
  boundary?: { seq: number; account: string | null; kind: string };
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
  const push = (entry: Record<string, unknown>) => {
    seq += 1;
    const item = { seq, t: performance.now(), ...entry };
    if (log.length < 20_000) log.push(item);
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
  const textOf = (node: Node): string =>
    node.nodeType === Node.TEXT_NODE
      ? (node.textContent ?? "")
      : node instanceof Element
        ? `${node.textContent ?? ""} ${node.getAttribute("aria-label") ?? ""}`
        : "";
  const checkMarkers = (text: string, where: string) => {
    if (episode !== null) return;
    for (const word of config.markers)
      if (text.includes(word)) violate("marker", `${where}: "${word}"`);
  };
  const NEUTRAL_TITLES = new Set([
    "",
    "Atlas",
    // The fixture build's own static title (index.html of the fixture mode): the build's name, nothing about an account.
    "Atlas (fixture)",
    "Sign in · Atlas",
    "Join · Atlas",
  ]);
  /** Judged on the value WRITTEN (a title set and reset in one task is two writes), never on the title as it is now. */
  const checkTitle = (title: string) => {
    push({ op: "title", title });
    if (!NEUTRAL_TITLES.has(title.trim()) && episode === null)
      violate("title", `title "${title}"`);
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
        // The setter's own change of the <title> element is already judged.
        observer.takeRecords();
      },
    });
  }
  const handle = (records: MutationRecord[]) => {
    const root = rootOf();
    // The value an attribute record SET is the next record's old value for the same attribute (records keep every change, in
    // order); only the last one's is the attribute as it is now. Reading the current value instead would hide a change undone in
    // the same task.
    const setTo = new Map<MutationRecord, string | null>();
    const later = new Map<string, MutationRecord>();
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const r = records[index] as MutationRecord;
      if (r.type !== "attributes" || r.target !== root) continue;
      const name = r.attributeName ?? "";
      const next = later.get(name);
      setTo.set(r, next ? next.oldValue : (root?.getAttribute(name) ?? null));
      later.set(name, r);
    }
    for (const r of records) {
      const target = r.target as Node;
      const inRoot =
        root !== null && (target === root || root.contains(target));
      if (r.type === "attributes" && target === root) {
        const now = setTo.get(r) ?? null;
        push({ op: "attr", name: r.attributeName, old: r.oldValue, now });
        if (now === null && r.oldValue !== null) {
          if (r.attributeName === "inert" || r.attributeName === "aria-hidden")
            exposure("lift", `${r.attributeName} removed`);
        } else if (now !== null && r.attributeName === "inert") {
          // A gate: the episode of the account ends (a lift must be authorised again).
          if (episode !== null) push({ op: "episode.close", reason: "gate" });
          episode = null;
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
        for (const node of r.addedNodes)
          checkMarkers(textOf(node), inRoot ? "protected-root" : "document");
        // The parser's own static <title> (the document is still loading) is the build's, not a write by the application.
        if (target.nodeName === "TITLE" && document.readyState !== "loading")
          for (const node of r.addedNodes) checkTitle(node.textContent ?? "");
      } else if (r.type === "characterData") {
        const parent = target.parentNode;
        if (parent?.nodeName === "TITLE") checkTitle(target.textContent ?? "");
        else
          checkMarkers(
            target.textContent ?? "",
            inRoot ? "protected-root" : "document",
          );
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
      attributes: true,
      attributeOldValue: true,
      attributeFilter: ["inert", "aria-hidden"],
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
  /** Every page of the context enrolled before its application ran, and no page reported a violation. */
  assertClean(message?: string): Promise<void>;
  /**
   * Enrolment of the CURRENT document of every open page of the context (asked in the page itself: a page's first `about:blank`
   * document enrolling says nothing about the document it navigated to), and how many documents reported enrolment in all, closed
   * pages included.
   */
  coverage(): Promise<{ open: number; enrolled: number; missing: string[] }>;
}

export async function installDisplayOracle(
  context: BrowserContext,
  options: OracleOptions = {},
): Promise<DisplayOracle> {
  const reports: PageReport[] = [];
  await context.exposeBinding(
    "__displayOracleReport",
    (_source, payload: PageReport) => {
      reports.push(payload);
    },
  );
  // Each document draws its own id in the page (one init script serves every page of the context).
  await context.addInitScript(oracleScript, {
    markers: options.markers ?? [],
  });
  const violations = () =>
    reports
      .filter((r) => r.type === "violation" && r.violation)
      .map((r) => r.violation as OracleViolation);
  return {
    violations,
    assertClean,
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
  async function coverage() {
    const missing: string[] = [];
    const pages = context.pages().filter((page) => !page.isClosed());
    for (const page of pages) {
      if (page.url() === "about:blank") continue;
      const enrolled = await page
        .evaluate(
          () =>
            (window as unknown as { __displayOracle?: unknown })
              .__displayOracle !== undefined,
        )
        .catch(() => null);
      // A page that closed meanwhile is not judged here; its reports stand.
      if (enrolled === false) missing.push(page.url());
    }
    return {
      open: pages.length,
      enrolled: reports.filter((r) => r.type === "enrolled").length,
      missing,
    };
  }
  async function assertClean(message?: string) {
    const { missing } = await coverage();
    expect(missing, `${message ?? ""} pages that escaped the oracle`).toEqual(
      [],
    );
    expect(violations(), `${message ?? ""} early display`).toEqual([]);
  }
}
