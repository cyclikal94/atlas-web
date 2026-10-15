/**
 * WEB-08c revision 5 (R5-A/R5-B of the review of 14 October 2026; design assessment P1-P3): the IN-PAGE parts of the continuous display
 * oracle (`display-oracle.ts`). TEST-ONLY. Both functions are serialised into init scripts, so neither may refer to anything outside its
 * own body (configuration arrives as the argument).
 *
 * `witnessScript` runs first in every document of the context. It gives the document its IDENTITY (a random id, its role: the main
 * document of a page, a subframe, or a blank document) and announces it; it keeps the document's terminal counters in a cookie that only
 * the test reads (path `/__atlas-display-oracle/`, which the application never requests and `document.cookie` at the application's own
 * paths never shows). The cookie is written synchronously before every report, so the counters survive a document that is closed or
 * replaced before its last reports reach the test (measured in Chromium, Firefox and WebKit: a report sent just before `page.close()` is
 * often lost, the cookie never was). The witness proves only that the document EXISTED; enrolment is the recorder's own report.
 *
 * `oracleScript` is the recorder. What it decides is unchanged from revision 4: a page may expose an account (insert into
 * `#protected-root`, lift its `inert`/`aria-hidden`, show a protected title, or show an account marker anywhere) only while the latest
 * `atlas-auth` record THIS document saw COMMITTED names that account settled with no fence. How it reads the DOM changed (R5-A): every
 * batch of mutation records is interpreted against the document AS IT WAS at each record, never against the live tree. The batch's start
 * is reconstructed by undoing the records, in reverse, from the live end state (attributes and text by their old values, child lists by
 * their added/removed nodes and sibling anchors); the records are then replayed forwards and each one is judged with the node values,
 * parentage, connectedness, root and title membership and id references of that moment. A subtree inserted and dismantled in one task is
 * judged with the descendants it had when it was inserted; a title text node is judged as title content while it was in `<title>`.
 */

export interface RecorderLimits {
  /** Entries in the document's ordered log. */
  log: number;
  /** Nodes walked when one inserted subtree is judged. */
  subtree: number;
  /** Ancestors walked to decide whether a node is in the document. */
  depth: number;
  /** Mutation records in one batch. */
  records: number;
}

export interface RecorderConfig {
  markers: string[];
  limits: RecorderLimits;
}

export interface WitnessConfig {
  cookiePrefix: string;
  cookiePath: string;
}

export const DEFAULT_LIMITS: RecorderLimits = {
  log: 20_000,
  subtree: 20_000,
  depth: 10_000,
  records: 100_000,
};

export const EVIDENCE_COOKIE: WitnessConfig = {
  cookiePrefix: "__atlas_oracle_",
  cookiePath: "/__atlas-display-oracle/",
};

/** What the witness leaves on `window` for the recorder of the same document (non-enumerable, frozen). */
export interface WitnessHandle {
  doc: string;
  role: "main" | "sub" | "blank";
  /** Whether the window still shows the document this witness was made for (a reused Window can show a later, unwitnessed one). */
  current(): boolean;
  note(update: { enrolled?: boolean; sequence?: number }): void;
}

/** The document witness (in-page). Self-contained. */
export function witnessScript(config: WitnessConfig): void {
  const w = window as unknown as {
    __displayOracleWitness?: (report: unknown) => unknown;
  };
  let href = "";
  try {
    href = location.href;
  } catch {
    href = "";
  }
  let off = false;
  try {
    off = new URL(href).searchParams.get("witness") === "off";
  } catch {
    off = false;
  }
  // Test-only seam (qualification): a document that escapes the witness as well as the recorder.
  if (off) return;
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const doc = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  let top = true;
  try {
    top = window.top === window;
  } catch {
    top = false;
  }
  const role: "main" | "sub" | "blank" = !top
    ? "sub"
    : href === "" || href.startsWith("about:")
      ? "blank"
      : "main";
  const counters = { enrolled: 0, loaded: 0, sequence: 0 };
  const write = () => {
    if (role !== "main") return;
    try {
      // biome-ignore lint/suspicious/noDocumentCookie: the write must be SYNCHRONOUS (the asynchronous Cookie Store can be lost with the document).
      document.cookie = `${config.cookiePrefix}${doc}=m.e${counters.enrolled}.d${counters.loaded}.s${counters.sequence}; path=${config.cookiePath}; SameSite=Strict`;
    } catch {
      // No cookie (an opaque origin): the test then has no terminal evidence for this document, which it reports as incomplete.
    }
  };
  const send = (payload: Record<string, unknown>) => {
    try {
      const result = w.__displayOracleWitness?.({ doc, role, ...payload }) as
        | Promise<unknown>
        | undefined;
      result?.catch?.(() => undefined);
    } catch {
      // The binding is unavailable (the document is going away): the cookie holds the counters.
    }
  };
  const own = document;
  const handle: WitnessHandle = Object.freeze({
    doc,
    role,
    current: () => document === own,
    note(update: { enrolled?: boolean; sequence?: number }) {
      if (update.enrolled) counters.enrolled = 1;
      if (update.sequence !== undefined)
        counters.sequence = Math.max(counters.sequence, update.sequence);
      write();
    },
  });
  // Configurable: a Window can be REUSED by the next document (the initial about:blank and its first same-origin document share one), and
  // that document's own witness, when its init scripts run, replaces this one.
  Object.defineProperty(window, "__displayOracleDocument", {
    value: handle,
    enumerable: false,
    configurable: true,
    writable: false,
  });
  write();
  send({ type: "document", url: href, readyState: document.readyState });
  document.addEventListener(
    "DOMContentLoaded",
    () => {
      counters.loaded = 1;
      write();
      send({ type: "loaded", url: location.href });
    },
    { once: true },
  );
}

/** The recorder (in-page). Self-contained: it is serialised into the init script. */
export function oracleScript(config: RecorderConfig): void {
  const w = window as unknown as {
    __displayOracle?: unknown;
    __displayOracleReport?: (report: unknown) => unknown;
    __displayOracleDocument?: WitnessHandle;
    __atlasFixture?: unknown;
  };
  // Test-only seams (qualification): a document that escapes the recorder by its URL, or, keeping the SAME URL across a reload, by the
  // browsing context's name.
  try {
    if (new URL(location.href).searchParams.get("oracle") === "off") return;
  } catch {
    // An initial document with no URL yet: recorded like any other.
  }
  if (window.name === "__display_oracle_off__") return;
  const LIMITS = config.limits;
  /**
   * This recorder's OWN document. Its wrappers sit on prototypes the Window keeps when a later document reuses it (Firefox runs no init
   * script for that document): they pass through for any other document, and the test reports such a document as unobserved.
   */
  const own = document;
  const mine = () => document === own;
  const witnessed = w.__displayOracleDocument;
  const witness = witnessed?.current() ? witnessed : null;
  const doc =
    witness?.doc ??
    `unwitnessed-${Math.floor(Math.random() * 1e12).toString(16)}`;
  const log: Array<Record<string, unknown>> = [];
  const violations: Array<Record<string, unknown>> = [];
  const limits: string[] = [];
  let seq = 0;
  /** The SUBSTANTIVE report sequence of this document (enrolment, violations, limits); the witness's cookie holds its latest value. */
  let sseq = 0;
  let record: {
    settled: string | null;
    epoch: number | null;
    fences: Record<string, number>;
    tx: number;
  } | null = null;
  /** The account whose exposure this page is in (opened by an authorised exposure, ended by a gate or an empty root). */
  let episode: string | null = null;
  const report = (payload: Record<string, unknown>, substantive: boolean) => {
    const item: Record<string, unknown> = { doc, ...payload };
    if (substantive) {
      sseq += 1;
      item.sseq = sseq;
      // The terminal counter first: a report lost with its document is still known to have existed.
      witness?.note({ sequence: sseq });
    }
    try {
      const result = w.__displayOracleReport?.(item) as
        | Promise<unknown>
        | undefined;
      result?.catch?.(() => undefined);
    } catch {
      // The binding is gone (the document is closing): the in-page log and the cookie keep it.
    }
  };
  /** A limit of the recorder that was reached: the document's evidence is INCOMPLETE (never a clean result). */
  const incomplete = (what: string) => {
    if (limits.includes(what)) return;
    limits.push(what);
    report({ type: "incomplete", detail: what }, true);
  };
  const push = (entry: Record<string, unknown>) => {
    seq += 1;
    const item = { seq, t: performance.now(), ...entry };
    if (log.length < LIMITS.log) log.push(item);
    else incomplete(`log over ${LIMITS.log} entries`);
    return item;
  };
  const authorised = (): string | null => {
    if (!record || record.settled === null) return null;
    return (record.fences[record.settled] ?? 0) === 0 ? record.settled : null;
  };
  const violate = (kind: string, detail: string) => {
    const item = push({ op: "VIOLATION", kind, detail, record });
    const v = { doc, seq: item.seq, kind, detail, record };
    violations.push(v);
    report({ type: "violation", violation: v }, true);
    (v as Record<string, unknown>).sseq = sseq;
  };
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
      report(
        {
          type: "boundary",
          boundary: { seq: item.seq, account: allowed, kind: "episode.open" },
        },
        false,
      );
    }
  };
  /** Name-bearing attributes (revision 4): what a node exposes to a reader or to assistive technology besides its text. */
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
  const ROOT_ID = "protected-root";
  const NEUTRAL_TITLES = new Set([
    "",
    "Atlas",
    // The fixture build's own static title (fixture.html): the build's name, nothing about an account.
    "Atlas (fixture)",
    "Sign in · Atlas",
    "Join · Atlas",
  ]);
  /**
   * HF-14 (revision 4), now in event order: what the PERSON entered into a form field is not something the application disclosed. Each
   * `input` event first drains the records queued BEFORE it (so an earlier application write is judged without this exemption), then
   * records the entered value; a `value` written equal to it afterwards (React mirrors it into the attribute) is not judged.
   */
  const entered = new WeakMap<Node, string>();
  own.addEventListener(
    "input",
    (event) => {
      drain();
      const target = event.target as { value?: unknown } | null;
      if (target && typeof target.value === "string")
        entered.set(target as unknown as Node, target.value);
    },
    true,
  );

  // ---- the event-time model of one batch of records ----
  type Virtual = {
    parent?: Node | null;
    children?: Node[];
    attrs: Map<string, string | null>;
    data?: string;
  };
  let V = new Map<Node, Virtual>();
  const at = (node: Node): Virtual => {
    let v = V.get(node);
    if (!v) {
      v = { attrs: new Map() };
      V.set(node, v);
    }
    return v;
  };
  // Each field is captured from the live node the first time it is needed. A field no record of the batch changes is the same at every
  // moment of the batch; a field a record changes is first needed (in the reverse pass) at the LAST record that changes it, when the live
  // value is still the value that record left.
  const parentOf = (node: Node): Node | null => {
    const v = at(node);
    if (v.parent === undefined) v.parent = node.parentNode;
    return v.parent;
  };
  const childrenOf = (node: Node): Node[] => {
    const v = at(node);
    if (v.children === undefined) v.children = Array.from(node.childNodes);
    return v.children;
  };
  const attrKey = (ns: string | null, name: string) => `${ns ?? ""}|${name}`;
  const attrOf = (node: Node, ns: string | null, name: string) => {
    const v = at(node);
    const key = attrKey(ns, name);
    if (!v.attrs.has(key))
      v.attrs.set(
        key,
        node instanceof Element
          ? ns
            ? node.getAttributeNS(ns, name)
            : node.getAttribute(name)
          : null,
      );
    return v.attrs.get(key) ?? null;
  };
  const setAttr = (
    node: Node,
    ns: string | null,
    name: string,
    value: string | null,
  ) => {
    attrOf(node, ns, name);
    at(node).attrs.set(attrKey(ns, name), value);
  };
  const dataOf = (node: Node): string => {
    const v = at(node);
    if (v.data === undefined) v.data = (node as CharacterData).data ?? "";
    return v.data;
  };
  const connected = (node: Node): boolean => {
    let n: Node | null = node;
    for (let depth = 0; depth < LIMITS.depth; depth += 1) {
      if (n === null) return false;
      if (n === own) return true;
      n = parentOf(n);
    }
    incomplete(`ancestry over ${LIMITS.depth} nodes`);
    return true;
  };
  const isElement = (node: Node) => node.nodeType === 1;
  const isText = (node: Node) =>
    node.nodeType === 3 || node.nodeType === 4 || node.nodeType === 8;
  const isTitle = (node: Node) => node.nodeName === "TITLE";
  /** The document's protected root AT THIS MOMENT: a connected element whose id (then) is `protected-root`. */
  const roots = new Set<Node>();
  const rootNow = (): Node | null => {
    for (const candidate of roots)
      if (attrOf(candidate, null, "id") === ROOT_ID && connected(candidate))
        return candidate;
    return null;
  };
  /** Walks a subtree as it is at this moment (bounded). */
  const walk = (start: Node, visit: (node: Node) => void) => {
    const stack = [start];
    let count = 0;
    while (stack.length > 0) {
      const node = stack.pop() as Node;
      count += 1;
      if (count > LIMITS.subtree) {
        incomplete(`subtree over ${LIMITS.subtree} nodes`);
        return;
      }
      visit(node);
      const kids = childrenOf(node);
      for (let i = kids.length - 1; i >= 0; i -= 1) stack.push(kids[i] as Node);
    }
  };
  const titleText = (title: Node) =>
    childrenOf(title)
      .filter((n) => n.nodeType === 3)
      .map((n) => dataOf(n))
      .join("");
  /** The element an id refers to AT THIS MOMENT (connected, with that id then). */
  const byId = (id: string): Node | null => {
    const live = own.getElementById(id);
    if (live && attrOf(live, null, "id") === id && connected(live)) return live;
    for (const node of V.keys())
      if (isElement(node) && attrOf(node, null, "id") === id && connected(node))
        return node;
    return null;
  };
  const textOf = (node: Node): string => {
    const parts: string[] = [];
    walk(node, (n) => {
      if (n.nodeType === 3 || n.nodeType === 4) parts.push(dataOf(n));
    });
    return parts.join("");
  };
  /** The text an attribute value exposes (an id reference names the text and label of the elements it refers to, then). */
  const attributeText = (name: string, value: string | null): string => {
    if (value === null) return "";
    if (name !== "aria-labelledby" && name !== "aria-describedby") return value;
    return value
      .split(/\s+/)
      .map((id) => (id ? byId(id) : null))
      .map((el) =>
        el ? `${textOf(el)} ${attrOf(el, null, "aria-label") ?? ""}` : "",
      )
      .join(" ");
  };
  /** Markers judged per EVENT: one violation per marker word found by this event (no node-lifetime deduplication). */
  const checkMarkers = (text: string, where: string) => {
    if (episode !== null) return;
    for (const word of config.markers)
      if (text.includes(word)) violate("marker", `${where}: "${word}"`);
  };
  /** The title is judged on the value it HAD at each event, never on the title as it is now. */
  let suppressTitle: string | null = null;
  let suppressed = 0;
  const checkTitle = (title: string, how: string) => {
    if (suppressTitle !== null && title === suppressTitle) {
      suppressed += 1;
      return;
    }
    push({ op: "title", title, how });
    if (NEUTRAL_TITLES.has(title.trim()) || episode !== null) return;
    violate("title", `title "${title}" (${how})`);
  };
  /** HF-14 at event time: a value attribute equal to what the person entered into that element is not a disclosure. */
  const exempt = (node: Node, name: string, value: string | null) =>
    name === "value" && value !== null && entered.get(node) === value;
  const ungated = (root: Node) =>
    attrOf(root, null, "inert") === null ||
    attrOf(root, null, "aria-hidden") !== "true";
  /** A subtree that has just become part of the document: everything it shows, judged as it is at this moment. */
  const judgeInserted = (node: Node, where: string) => {
    const parts: string[] = [];
    walk(node, (n) => {
      if (isText(n)) {
        const parent = parentOf(n);
        // A title's text is judged as the title (below), not as marker text.
        if (n.nodeType !== 8 && !(parent && isTitle(parent)))
          parts.push(dataOf(n));
        return;
      }
      if (!isElement(n)) return;
      if (attrOf(n, null, "id") === ROOT_ID) {
        roots.add(n);
        // A protected root that APPEARS (a replacement) is judged like a lift or a mount of the one it replaces.
        if (ungated(n)) exposure("lift", "an ungated #protected-root inserted");
        if (childrenOf(n).length > 0 && episode === null)
          exposure("mount", "#protected-root inserted with content");
      }
      if (isTitle(n)) checkTitle(titleText(n), "title inserted");
      for (const name of NAMED) {
        const value = attrOf(n, null, name);
        if (value !== null && !exempt(n, name, value))
          parts.push(attributeText(name, value));
      }
    });
    checkMarkers(parts.join(" "), where);
  };
  const where = (target: Node) => {
    const root = rootNow();
    if (!root) return "document";
    for (let n: Node | null = target; n !== null; n = parentOf(n))
      if (n === root) return "protected-root";
    return "document";
  };
  let mismatch = false;
  const fail = (what: string) => {
    mismatch = true;
    incomplete(`history: ${what}`);
  };
  type Annotated = { r: MutationRecord; now: string | null };
  /** Undo the batch from the live end state, recording the value each attribute/text record SET (the state after it). */
  const reverse = (records: MutationRecord[]): Annotated[] => {
    const annotated: Annotated[] = records.map((r) => ({ r, now: null }));
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const entry = annotated[index] as Annotated;
      const r = entry.r;
      const target = r.target as Node;
      if (r.type === "attributes") {
        const name = r.attributeName ?? "";
        entry.now = attrOf(target, r.attributeNamespace, name);
        setAttr(target, r.attributeNamespace, name, r.oldValue);
      } else if (r.type === "characterData") {
        entry.now = dataOf(target);
        at(target).data = r.oldValue ?? "";
      } else {
        const kids = childrenOf(target);
        for (const added of Array.from(r.addedNodes)) {
          const i = kids.indexOf(added);
          if (i < 0) {
            fail("an added node is not where its record put it");
            continue;
          }
          kids.splice(i, 1);
          at(added).parent = null;
        }
        const anchor = r.previousSibling;
        const position = anchor ? kids.indexOf(anchor) + 1 : 0;
        if (anchor && position === 0) fail("a sibling anchor is missing");
        const removed = Array.from(r.removedNodes);
        kids.splice(position, 0, ...removed);
        for (const node of removed) at(node).parent = target;
        if (r.nextSibling && kids[position + removed.length] !== r.nextSibling)
          fail("a sibling anchor does not follow");
      }
    }
    return annotated;
  };
  /** Replay forwards from the reconstructed start, judging each record with the document as it is at that record. */
  const replay = (annotated: Annotated[]) => {
    for (const { r, now } of annotated) {
      const target = r.target as Node;
      if (r.type === "attributes") {
        const name = r.attributeName ?? "";
        const ns = r.attributeNamespace;
        setAttr(target, ns, name, now);
        if (!ns && name === "id" && now === ROOT_ID) roots.add(target);
        if (!connected(target)) continue;
        const root = rootNow();
        if (!ns && name === "id" && now === ROOT_ID && target === root) {
          if (ungated(target))
            exposure("lift", "an ungated element became #protected-root");
          if (childrenOf(target).length > 0 && episode === null)
            exposure("mount", "an element with content became #protected-root");
          continue;
        }
        if (target === root && !ns && GATES.includes(name)) {
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
          if (exempt(target, name, now)) continue;
          checkMarkers(attributeText(name, now), `${where(target)} [${name}]`);
        }
      } else if (r.type === "characterData") {
        at(target).data = now ?? "";
        if (!connected(target)) continue;
        const parent = parentOf(target);
        if (parent && isTitle(parent))
          checkTitle(titleText(parent), "title text changed");
        else if (target.nodeType !== 8) checkMarkers(now ?? "", where(target));
      } else {
        const kids = childrenOf(target);
        const removed = Array.from(r.removedNodes);
        for (const node of removed) {
          const i = kids.indexOf(node);
          if (i < 0) {
            fail("a removed node is not in its parent");
            continue;
          }
          kids.splice(i, 1);
          at(node).parent = null;
        }
        const anchor = r.previousSibling;
        const position = anchor ? kids.indexOf(anchor) + 1 : 0;
        const added = Array.from(r.addedNodes);
        kids.splice(position, 0, ...added);
        for (const node of added) at(node).parent = target;
        if (!connected(target)) continue;
        const root = rootNow();
        if (target === root && removed.length > 0) {
          push({ op: "remove", nodes: removed.length });
          if (kids.length === 0) {
            if (episode !== null)
              push({ op: "episode.close", reason: "unmounted" });
            episode = null;
          }
        }
        if (target === root && added.length > 0) {
          push({ op: "add", nodes: added.length });
          // A tree is mounted by inserting its container DIRECTLY into #protected-root; re-renders inside a retained tree are not.
          if (episode === null)
            exposure("mount", "node inserted into #protected-root");
        }
        if (isTitle(target) && added.length + removed.length > 0)
          checkTitle(titleText(target), "title children changed");
        for (const node of added)
          if (!(isTitle(target) && isText(node)))
            judgeInserted(node, where(target));
      }
    }
  };
  /** The records of one batch, interpreted in event order. */
  const handle = (records: MutationRecord[]) => {
    if (records.length === 0) return;
    if (records.length > LIMITS.records) {
      incomplete(`batch over ${LIMITS.records} records`);
    }
    V = new Map();
    mismatch = false;
    const live = own.getElementById(ROOT_ID);
    if (live) roots.add(live);
    replay(reverse(records));
    // The replay must arrive exactly at the live end state (a self-check of the model).
    if (!mismatch)
      for (const r of records)
        if (r.type === "childList") {
          const kids = childrenOf(r.target as Node);
          const actual = (r.target as Node).childNodes;
          if (
            kids.length !== actual.length ||
            kids.some((node, i) => node !== actual[i])
          ) {
            fail("the replay does not reach the live child list");
            break;
          }
        }
    V = new Map();
  };
  const observer = new MutationObserver((records) =>
    handle([...records, ...observer.takeRecords()]),
  );
  const drain = () => handle(observer.takeRecords());
  observer.observe(own, {
    subtree: true,
    childList: true,
    characterData: true,
    characterDataOldValue: true,
    attributes: true,
    attributeOldValue: true,
    attributeFilter: [...GATES, ...NAMED, "id"],
  });

  // ---- writes that no mutation record shows ----
  const titleDescriptor = Object.getOwnPropertyDescriptor(
    Document.prototype,
    "title",
  );
  if (titleDescriptor?.set) {
    const setTitle = titleDescriptor.set;
    Object.defineProperty(Document.prototype, "title", {
      ...titleDescriptor,
      set(this: Document, value: string) {
        if (this !== own || !mine()) {
          setTitle.call(this, value);
          return;
        }
        drain();
        const text = String(value);
        checkTitle(text, "document.title");
        setTitle.call(this, value);
        // The setter's own records are replayed like any other (the model needs them); only a title check of exactly the value
        // already judged is not counted twice. Every other judgement of these records stands.
        suppressTitle = text;
        suppressed = 0;
        try {
          handle(observer.takeRecords());
        } finally {
          suppressTitle = null;
        }
        push({ op: "title.setter", suppressed });
      },
    });
  }
  // A form field's `value` PROPERTY shows text without any mutation record (S6): judged when written, unless it is what the person entered.
  for (const proto of [
    typeof HTMLInputElement === "undefined" ? null : HTMLInputElement.prototype,
    typeof HTMLTextAreaElement === "undefined"
      ? null
      : HTMLTextAreaElement.prototype,
  ]) {
    if (!proto) continue;
    const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
    if (!descriptor?.set) {
      incomplete("a form field's value property cannot be observed");
      continue;
    }
    const set = descriptor.set;
    Object.defineProperty(proto, "value", {
      ...descriptor,
      set(this: HTMLInputElement, value: unknown) {
        if (this.ownerDocument !== own || !mine()) {
          set.call(this, value);
          return;
        }
        drain();
        const text = String(value ?? "");
        const type = this instanceof HTMLInputElement ? this.type : "textarea";
        if (
          this.isConnected &&
          type !== "hidden" &&
          type !== "password" &&
          entered.get(this) !== text
        )
          checkMarkers(text, `${where(this)} [value property]`);
        set.call(this, value);
      },
    });
  }
  // A shadow tree is outside what the observer sees: its content would be unobserved, so the evidence is incomplete.
  if (typeof Element !== "undefined" && Element.prototype.attachShadow) {
    const attachShadow = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (
      this: Element,
      ...args: Parameters<Element["attachShadow"]>
    ) {
      if (this.ownerDocument === own && mine())
        incomplete("a shadow root was attached (its content is not observed)");
      return attachShadow.apply(this, args);
    } as Element["attachShadow"];
  }

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
  if (typeof IDBDatabase !== "undefined") {
    const transaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (
      this: IDBDatabase,
      ...args: Parameters<IDBDatabase["transaction"]>
    ) {
      const tx = transaction.apply(this, args);
      if (this.name === "atlas-auth" && mine()) {
        const info: TxInfo = {
          id: ++txIds,
          mode: String(args[1] ?? "readonly"),
          read: null,
          written: null,
        };
        txs.set(tx, info);
        tx.addEventListener("complete", () => {
          // Causal order: every DOM change made before this completion is judged under the record that held until now.
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
  }

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
    doc,
    log,
    violations,
    mark(label: string) {
      drain();
      push({ op: "mark", label });
    },
    state: () => ({ record, episode }),
    /** Drains every pending record and answers what THIS document holds (the acknowledgement of the sealed interval). */
    flush: () => {
      drain();
      return {
        doc,
        role: witness?.role ?? null,
        current: mine(),
        sseq,
        violations: [...violations],
        limits: [...limits],
      };
    },
  };
  push({ op: "enrolled", readyState: document.readyState });
  witness?.note({ enrolled: true });
  report({ type: "enrolled", url: location.href }, true);
}
