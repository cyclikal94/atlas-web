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
 *
 * Revision 7 (R5-A of review 7): nodes are read through NATIVE accessors (a field or element adopted from another window keeps that window's
 * prototypes), every route to a field's type is ordered before its native side effect, and each document's recorder is a SERVICE on its
 * Document that the wrappers of any same-origin realm reach through the node's owner (see "the recorder service" below). An unknown value, an
 * unordered change that decides a verdict, or a field of a window without a recorder is INCOMPLETE, never clean.
 *
 * Revision 8 (R5-A of review 8: application handlers inside a native operation): an operation is an INTERVAL, not an atomic call. Every
 * structural route judges its own records as soon as the native call returns (so an exposure made inside a reset or click handler is
 * judged before the default action that follows it can erase the value), no operation refreshes a field's reference before the records
 * still queued are judged, and an operation's participants are the fields it had at entry and exit and every field touched inside it.
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
  /** Operations open inside one another (revision 8: a handler's reset inside a click inside a dispatch...). */
  operations: number;
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
  operations: 1_000,
};

export const EVIDENCE_COOKIE: WitnessConfig = {
  cookiePrefix: "__atlas_oracle_",
  cookiePath: "/__atlas-display-oracle/",
};

/** What the witness leaves on `window` for the recorder of the same document (non-enumerable, frozen). */
export interface WitnessHandle {
  doc: string;
  role: "main" | "sub" | "blank";
  /** The document's URL when it was created (before any script of its own ran): what the host's commit of it names. */
  url: string;
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
  // Test-only seams (qualification): a document that escapes the witness as well as the recorder, by its URL or, keeping the SAME URL
  // across a reload, by the browsing context's name (revision 6).
  if (off || window.name === "__display_oracle_and_witness_off__") return;
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
  // A document the application could not have served (an initial or `about:` document, an engine's error page) is "blank".
  const role: "main" | "sub" | "blank" = !top
    ? "sub"
    : !/^https?:/i.test(href)
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
    url: href,
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
  if (
    window.name === "__display_oracle_off__" ||
    window.name === "__display_oracle_and_witness_off__"
  )
    return;
  const LIMITS = config.limits;
  /**
   * This recorder's OWN document. The prototype wrappers (below) are installed once per realm and act for the document that OWNS the node
   * they are called on (revision 7), whichever realm installed them; a later document that reuses this Window (Firefox runs no init script
   * for it) has no recorder service, so they pass through for it and the test reports that document as unobserved.
   */
  const own = document;
  const mine = () => document === own;
  /** The document's URL when the recorder was installed (the host's commit of the document names it). */
  let created = "";
  try {
    created = location.href;
  } catch {
    created = "";
  }
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

  // ---- realm-independent native readers (revision 7, R5-A/realm of the review of 15 October 2026; design assessment P1) ----
  /**
   * A node keeps the prototypes of the realm (Window) that created it when it is adopted into another document (measured in Chromium,
   * Firefox and WebKit: `instanceof` the destination's interfaces is false). So nothing here asks `instanceof` or which prototype a node
   * has: the readers are this realm's NATIVE getters and methods, captured before any wrapper, applied to the node (an interface's own
   * native accessors accept a node of that interface from any same-origin realm, measured in all three engines). A read that fails is
   * UNKNOWN, never an empty value.
   */
  const SERVICE = Symbol.for("atlas.displayOracle.service");
  const WRAPPED = Symbol.for("atlas.displayOracle.wrapped");
  const XHTML = "http://www.w3.org/1999/xhtml";
  const getterOf = (proto: object | undefined, name: string) =>
    (proto ? Object.getOwnPropertyDescriptor(proto, name)?.get : undefined) ??
    null;
  const NATIVE = {
    inputValue: getterOf(
      typeof HTMLInputElement === "undefined"
        ? undefined
        : HTMLInputElement.prototype,
      "value",
    ),
    textareaValue: getterOf(
      typeof HTMLTextAreaElement === "undefined"
        ? undefined
        : HTMLTextAreaElement.prototype,
      "value",
    ),
    inputType: getterOf(
      typeof HTMLInputElement === "undefined"
        ? undefined
        : HTMLInputElement.prototype,
      "type",
    ),
    nodeType: getterOf(Node.prototype, "nodeType"),
    ownerDocument: getterOf(Node.prototype, "ownerDocument"),
    namespaceURI: getterOf(Element.prototype, "namespaceURI"),
    localName: getterOf(Element.prototype, "localName"),
    getAttributeNS: Element.prototype.getAttributeNS,
    eventPhase: getterOf(
      typeof Event === "undefined" ? undefined : Event.prototype,
      "eventPhase",
    ),
  };
  /** The node type of a NODE (null for anything else; no getter of the value itself runs). */
  const nodeTypeOf = (value: unknown): number | null => {
    if (
      value === null ||
      (typeof value !== "object" && typeof value !== "function")
    )
      return null;
    try {
      return NATIVE.nodeType ? (NATIVE.nodeType.call(value) as number) : null;
    } catch {
      return null;
    }
  };
  /** The document a node belongs to NOW (a document is its own). */
  const docOf = (value: unknown): Document | null => {
    const type = nodeTypeOf(value);
    if (type === null) return null;
    if (type === 9) return value as Document;
    try {
      return (NATIVE.ownerDocument?.call(value) as Document | null) ?? null;
    } catch {
      return null;
    }
  };
  const fieldKind = (node: unknown): "input" | "textarea" | null => {
    if (nodeTypeOf(node) !== 1) return null;
    try {
      if (NATIVE.namespaceURI?.call(node) !== XHTML) return null;
      const name = NATIVE.localName?.call(node);
      return name === "input" || name === "textarea" ? name : null;
    } catch {
      return null;
    }
  };
  const isField = (node: unknown): node is HTMLInputElement =>
    fieldKind(node) !== null;
  type FieldState =
    | { known: true; value: string }
    | { known: false; reason: string };
  /** A field's value BEFORE an operation whose argument conversion changed the document: the records made then are judged with it. */
  const overrides = new Map<Node, string>();
  const readField = (field: Node): FieldState => {
    if (overrides.has(field))
      return { known: true, value: overrides.get(field) as string };
    const kind = fieldKind(field);
    const get =
      kind === "input"
        ? NATIVE.inputValue
        : kind === "textarea"
          ? NATIVE.textareaValue
          : null;
    if (!get)
      return {
        known: false,
        reason: kind ? `no native ${kind} value getter` : "not a form field",
      };
    try {
      return { known: true, value: String(get.call(field) ?? "") };
    } catch (error) {
      return {
        known: false,
        reason: `the native value getter refused it (${String(error).slice(0, 120)})`,
      };
    }
  };
  const typeOf = (field: Node): string => {
    if (fieldKind(field) !== "input") return "textarea";
    try {
      return String(NATIVE.inputType?.call(field) ?? "text").toLowerCase();
    } catch {
      // Unreadable: judged as shown (the conservative side).
      return "text";
    }
  };
  const isWrapped = (fn: unknown) =>
    typeof fn === "function" &&
    (fn as unknown as Record<symbol, unknown>)[WRAPPED] === true;
  const mark = <T extends object>(fn: T): T => {
    Object.defineProperty(fn, WRAPPED, { value: true });
    return fn;
  };
  /** Whether the realm that made this field has the recorder's ordered routes (its prototype's value setter is one of ours). */
  const instrumented = (field: Node): boolean => {
    let proto = Object.getPrototypeOf(field) as object | null;
    for (let i = 0; proto !== null && i < 64; i += 1) {
      const d = Object.getOwnPropertyDescriptor(proto, "value");
      if (d) return isWrapped(d.set);
      proto = Object.getPrototypeOf(proto) as object | null;
    }
    return false;
  };

  /**
   * Form fields (revisions 6 and 7, R5-A). A text field's `value` PROPERTY can show text that no attribute or child node holds: written
   * while the field is detached, copied with it by `cloneNode`/`importNode`, kept when it is adopted (from another window too). Such a
   * value is judged when the field BECOMES visible: when it is inserted (`judgeInserted`) and when its type stops concealing it (password
   * to text), as well as when it is written into a connected field.
   *
   * What a record of a batch is judged with is the field's value AT that record. The routes below are ordered operations: the records
   * queued before one are judged first (with the value as it still is), then the change happens. Revision 7 added the routes whose NATIVE
   * side effect changes the value without the value setter: the type (and the constraint attributes `min`, `max`, `step`, `multiple`)
   * through its property, every attribute method of the element (`setAttribute`, `setAttributeNS`, `removeAttribute`, `removeAttributeNS`,
   * `toggleAttribute`, `setAttributeNode`, `setAttributeNodeNS`, `removeAttributeNode`), an attached attribute node's
   * `value`/`nodeValue`/`textContent`, and the `NamedNodeMap` setters and removers. Their string arguments are converted ONCE, before the
   * records are judged (a conversion that changes the document happens before the operation, as natively). The property-only routes
   * (`value`, `valueAsNumber`, `valueAsDate`, `setRangeText`, `stepUp`/`stepDown`) keep the native conversion; records made during it are
   * judged with the value the field had before the operation. `defaultValue`, `form.reset()`, a reset by its event, `click()`,
   * `dispatchEvent` and `execCommand` are ordered as in revision 6, and native editing is preceded by `beforeinput`.
   *
   * Revision 8 (review 8): ordering BEFORE a call is not ordering of the call. A reset, a click or a dispatched event runs the application's
   * handlers and then a default action that changes values with no setter; records the handlers made would be judged with the value that
   * action left. So (1) every structural route (insertion, removal, replacement and the HTML/text setters; same document or not) judges its
   * own records when the native call returns, while the values it exposed are still the values; (2) every ordered operation judges what is
   * still queued BEFORE it refreshes a field's reference (`known` never advances over unjudged records); (3) an operation's participants
   * are its fields at entry, at exit and every field touched inside it (nested operations included), each refreshed by the recorder of the
   * document that owns it then; (4) a trusted reset's reference is settled only after its dispatch has ended (the default action has run).
   * Routes that only create NEW nodes from markup (`innerHTML`, `insertAdjacentHTML`, `document.write`, `execCommand("insertHTML")`) give
   * those fields no property-only value: their attributes and text are history. Anything else that changes a field between two ordered
   * points is unordered (engine autofill, restoration, a borrowed method of a window with no recorder).
   *
   * Uncertainty is explicit: each field's value at its last ordered change is kept (`known`); a field judged with a DIFFERENT live value
   * was changed by a route that is not ordered, and if that difference decides whether an account marker was shown, the evidence is
   * INCOMPLETE. A field that cannot be read, or whose realm has no recorder, is INCOMPLETE when it is shown (never an empty value).
   *
   * HF-14 (revision 4), provenance per element: what the PERSON entered is not something the application disclosed. Only a TRUSTED
   * `input` event (the engine's own editing, not one a script dispatched, not one inside a scripted `execCommand`) records the entered
   * value, after draining the records queued before it; the same value written back afterwards (React mirrors it into the property and the
   * attribute) is not judged. Any application write of a different value, or a reset, ends that exemption: it is never a permanent safe
   * string, and another field (a copy, or the same field in another document's recorder) never shares it.
   */
  const entered = new WeakMap<Node, string>();
  const editing = new WeakSet<Node>();
  const known = new WeakMap<Node, string>();
  const CONCEALED = new Set(["hidden", "password", "file"]);
  /**
   * The open operations of this document (revision 8), innermost last: each collects the fields touched while it runs (a nested
   * operation's fields are its parents' too), so its end refreshes the fields its handlers reached and not only those it can name then.
   */
  const frames: Array<Set<Node>> = [];
  const touch = (field: Node) => {
    for (const frame of frames) {
      if (frame.size >= LIMITS.subtree) {
        incomplete(`an operation touched over ${LIMITS.subtree} fields`);
        continue;
      }
      frame.add(field);
    }
  };
  const open = (): Set<Node> => {
    const frame = new Set<Node>();
    if (frames.length >= LIMITS.operations)
      incomplete(`operations nested over ${LIMITS.operations} deep`);
    else frames.push(frame);
    return frame;
  };
  const close = (frame: Set<Node>) => {
    const i = frames.lastIndexOf(frame);
    if (i >= 0) frames.splice(i, 1);
  };
  /** After an ORDERED change: the field's value now is the reference for every later record. */
  /**
   * The fields of THIS document whose reference is kept (revision 8, bounded): `audit` asks, when the evidence is collected, whether one
   * still shown has a value no ordered route gave it. A structural route judges an insertion at once, so an unordered change made AFTER
   * that judgement leaves no record to compare at; the collection is where that uncertainty is asked instead (never a verdict on its own).
   */
  const tracked = new Set<Node>();
  const track = (field: Node) => {
    if (docOf(field) !== own || tracked.has(field)) return;
    if (tracked.size >= LIMITS.subtree)
      for (const old of tracked) if (!old.isConnected) tracked.delete(old);
    if (tracked.size >= LIMITS.subtree)
      incomplete(`over ${LIMITS.subtree} fields with a reference`);
    else tracked.add(field);
  };
  const note = (field: Node): FieldState => {
    touch(field);
    const state = readField(field);
    if (state.known) {
      known.set(field, state.value);
      track(field);
    } else known.delete(field);
    return state;
  };
  /** After a write the application made: its effect is judged when the field is visible; the person's exemption ends if it changed. */
  const written = (field: Node, judge: boolean) => {
    const state = note(field);
    if (!state.known) {
      entered.delete(field);
      if (judge)
        incomplete(`a written field's value is unknown (${state.reason})`);
      return;
    }
    const value = state.value;
    if (entered.has(field) && entered.get(field) !== value)
      entered.delete(field);
    let connectedNow = false;
    try {
      connectedNow = field.isConnected;
    } catch {
      connectedNow = true;
    }
    if (
      judge &&
      connectedNow &&
      !CONCEALED.has(typeOf(field)) &&
      entered.get(field) !== value
    )
      checkMarkers(value, `${where(field)} [value property]`);
  };
  /** The fields a form operation (a reset, a button's activation) can change. */
  const formFields = (target: unknown): Node[] => {
    const out: Node[] = [];
    const add = (form: unknown) => {
      try {
        for (const el of Array.from(
          (form as HTMLFormElement | null)?.elements ?? [],
        ))
          if (isField(el)) out.push(el);
      } catch {
        // Not a form: nothing to add.
      }
    };
    if (isField(target)) out.push(target);
    if (nodeTypeOf(target) === 1) {
      let name: unknown = null;
      try {
        name = NATIVE.localName?.call(target);
      } catch {
        name = null;
      }
      if (name === "form") add(target);
      else {
        let form: unknown = null;
        try {
          form = (target as HTMLButtonElement).form;
        } catch {
          form = null;
        }
        if (form) add(form);
      }
    }
    return out;
  };
  /** Set while a scripted `execCommand` runs: the `input` events it fires are the script's, not the person's. */
  let scripted = 0;
  // Window, capturing, registered before any application script: the first listener of each event.
  window.addEventListener(
    "beforeinput",
    (event) => {
      if (!mine()) return;
      drain();
      if (isField(event.target)) editing.add(event.target);
    },
    true,
  );
  window.addEventListener(
    "input",
    (event) => {
      if (!mine()) return;
      const field = isField(event.target) ? event.target : null;
      const records = observer.takeRecords();
      if (
        field &&
        !editing.has(field) &&
        records.some(
          (r) =>
            r.type === "childList" &&
            Array.from(r.addedNodes).some(
              (n) => n === field || n.contains(field),
            ),
        )
      )
        incomplete(
          "a field was edited with no beforeinput in the task that inserted it (its value at insertion is unknown)",
        );
      // Judged with the value each field had at its last ordered change: an edit with no beforeinput is not one.
      handle(records);
      if (!field) return;
      editing.delete(field);
      // The person's edit is theirs. A scripted `execCommand` edit is the application's: judged like any other write. A dispatched
      // event changes no value (a value it "confirms" was judged when it was written).
      if (scripted > 0) written(field, true);
      else if (event.isTrusted) {
        const state = note(field);
        if (state.known) entered.set(field, state.value);
        else entered.delete(field);
      } else {
        const state = readField(field);
        if (!state.known || entered.get(field) !== state.value)
          entered.delete(field);
      }
    },
    true,
  );
  /**
   * Trusted resets still being dispatched (revision 8). The reset happens after its event, and the event's handlers run before it: a
   * reference dropped here (revision 6) would let records those handlers queue be judged, with no question asked, by the value the reset
   * leaves. The reference is kept until the event's dispatch has ENDED (its phase is NONE: the default action has run, or was cancelled),
   * and is then settled after the records queued until then are judged against it.
   */
  const resets: Array<{ event: Event; form: unknown; fields: Node[] }> = [];
  const dispatched = (event: Event) => {
    try {
      return NATIVE.eventPhase?.call(event) === 0;
    } catch {
      return true;
    }
  };
  window.addEventListener(
    "reset",
    (event) => {
      if (!mine()) return;
      drain();
      // The person's exemption ends with a reset (revision 6's policy, unchanged).
      const fields = formFields(event.target);
      for (const el of fields) entered.delete(el);
      // Only the engine's own reset event has a default action (a script's `dispatchEvent(new Event("reset"))` changes no value).
      if (event.isTrusted) resets.push({ event, form: event.target, fields });
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
  /** An attribute (by namespace and local name, as a record names it) through the NATIVE reader: any realm's element (revision 7). */
  const attrOf = (node: Node, ns: string | null, name: string) => {
    const v = at(node);
    const key = attrKey(ns, name);
    if (!v.attrs.has(key)) {
      let value: string | null = null;
      if (nodeTypeOf(node) === 1)
        try {
          value = NATIVE.getAttributeNS.call(node, ns, name);
        } catch (error) {
          incomplete(
            `an attribute could not be read (${String(error).slice(0, 120)})`,
          );
        }
      v.attrs.set(key, value);
    }
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
  const markerIn = (text: string | null) =>
    text !== null && config.markers.some((word) => text.includes(word));
  /** What a field shows when the page never wrote its property, AS IT WAS at this record: its `value` attribute, or a textarea's text. */
  const followedAt = (field: Node): string[] => {
    const raw =
      fieldKind(field) === "textarea"
        ? childrenOf(field)
            .filter((n) => n.nodeType === 3)
            .map((n) => dataOf(n))
            .join("")
        : (attrOf(field, null, "value") ?? "");
    const line = raw.replace(/[\r\n]/g, "");
    return [raw, raw.replace(/\r\n?/g, "\n"), line, line.trim()];
  };
  /**
   * The property-only text a field shows at this record with the given type (null: none, concealed, what the person entered, or what its
   * attribute/text at this record already shows). An unknown value, an unobserved realm, or an unordered change that decides the verdict
   * is INCOMPLETE (and contributes nothing it could be mistaken for).
   */
  const fieldText = (field: Node, type: string | null): string | null => {
    const kind = fieldKind(field);
    if (kind === null) return null;
    touch(field);
    if (kind === "input" && CONCEALED.has((type ?? "").toLowerCase()))
      return null;
    const state = readField(field);
    if (!state.known) {
      incomplete(`a shown field's value is unknown (${state.reason})`);
      return null;
    }
    if (!instrumented(field)) {
      incomplete(
        "a field from a realm with no recorder was shown (its writes are not ordered)",
      );
      return null;
    }
    const shown = (value: string) =>
      value === "" ||
      entered.get(field) === value ||
      followedAt(field).includes(value)
        ? null
        : value;
    const now = shown(state.value);
    const before = overrides.has(field) ? undefined : known.get(field);
    if (before === undefined || before === state.value || episode !== null)
      return now;
    if (markerIn(now) === markerIn(shown(before))) return now;
    incomplete(
      "a field's value was changed by a route that is not ordered (its value at a record is unknown)",
    );
    return null;
  };
  /** A shown field whose value differs from its reference with no record left to judge it at (revision 8): incomplete when the difference
   * decides whether a marker was shown. A field no longer shown is judged again (against its reference) when it is next inserted. */
  const audit = () => {
    V = new Map();
    for (const field of tracked) {
      let shownNow = false;
      try {
        shownNow = field.isConnected && docOf(field) === own;
      } catch {
        shownNow = false;
      }
      if (!shownNow) {
        tracked.delete(field);
        continue;
      }
      const before = known.get(field);
      const state = readField(field);
      if (
        episode !== null ||
        before === undefined ||
        !state.known ||
        before === state.value ||
        CONCEALED.has(typeOf(field))
      )
        continue;
      const shown = (value: string) =>
        value === "" ||
        entered.get(field) === value ||
        followedAt(field).includes(value)
          ? null
          : value;
      if (markerIn(shown(state.value)) !== markerIn(shown(before)))
        incomplete(
          "a field's value was changed by a route that is not ordered (its value at a record is unknown)",
        );
    }
    V = new Map();
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
      // R5-A: a field's property-only value, with the type the field had at this record.
      const field = fieldText(n, attrOf(n, null, "type"));
      if (field !== null) parts.push(field);
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
        } else if (!ns && name === "type" && fieldKind(target) === "input") {
          // R5-A: a type that stops concealing a field (password → text) shows its property-only value at this record.
          const was = (r.oldValue ?? "").toLowerCase();
          if (!CONCEALED.has(was)) continue;
          const shown = fieldText(target, now);
          if (shown !== null)
            checkMarkers(
              shown,
              `${where(target)} [value property, type ${was} → ${now ?? "text"}]`,
            );
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
  /** The records of one batch, interpreted in event order; then the references of trusted resets that ended before it are settled. */
  const handle = (records: MutationRecord[]) => {
    const ended =
      resets.length === 0
        ? []
        : resets.filter((reset) => dispatched(reset.event));
    if (ended.length > 0) {
      for (const reset of ended) resets.splice(resets.indexOf(reset), 1);
    }
    // Judged BEFORE the settlement: a record of this batch may precede the reset (its value is the reference) or follow it (the live
    // value); where that difference decides a verdict the evidence is incomplete (`fieldText`).
    judge(records);
    for (const reset of ended)
      for (const field of new Set([...reset.fields, ...formFields(reset.form)]))
        written(field, false);
  };
  const judge = (records: MutationRecord[]) => {
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
    attributeFilter: [...GATES, ...NAMED, "id", "type"],
  });

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

  // ---- this document's recorder SERVICE (revision 7, design assessment P2/P3) ----
  /**
   * What the prototype wrappers of ANY same-origin realm ask of the document that owns the node they act on. Only observation: draining,
   * judging, ordering, incompleteness. No authority (the `atlas-auth` record, the episode) ever passes between documents. It lives on the
   * Document object itself under a registry symbol (`Symbol.for` is shared by every realm of the agent), so a node adopted from another
   * window, or written through another window's prototype, reaches the recorder of the document it belongs to NOW, and a donor window
   * that has gone (removed, navigated, closed) does not take that observation with it.
   */
  const service = {
    document: own,
    drain,
    incomplete,
    /** A property-only write (no record of its own): ordered; records made DURING it (its argument conversion) are judged with the value
     * the field had before it; the write itself is judged by its actual effect. */
    operate(field: Node, run: () => unknown, judge: boolean) {
      drain();
      const before = readField(field);
      // Revision 8: an exceptional exit (a conversion that throws after its side effects) is reconciled too; the native error is kept.
      try {
        return run();
      } finally {
        const during = observer.takeRecords();
        if (during.length > 0) {
          const after = readField(field);
          if (before.known && after.known && before.value !== after.value) {
            overrides.set(field, before.value);
            try {
              handle(during);
            } finally {
              overrides.delete(field);
            }
          } else handle(during);
        }
        written(field, judge);
      }
    },
    /** An operation whose native side effect can change a field's value (its arguments are already converted): ordered before it; its
     * own records (a type that stops concealing) judged with the value it left, before the reference moves on. */
    change(field: Node, run: () => unknown) {
      drain();
      try {
        return run();
      } finally {
        drain();
        written(field, false);
      }
    },
    /**
     * An operation that runs the application's handlers and then may change fields as a DEFAULT ACTION (a reset, a button's activation,
     * a dispatched event): an interval (revision 8). Its handlers' structural exposures are judged by their own routes as they happen;
     * what is still queued at its end is judged against the references from before it (an ambiguity that decides a verdict is
     * incomplete); only then are its participants (entry, exit and every field touched inside it) refreshed, each by its own document.
     */
    around(run: () => unknown, fields: () => Node[], reset: boolean) {
      const entry = fields();
      const frame = open();
      drain();
      try {
        return run();
      } finally {
        close(frame);
        drain();
        settle([...entry, ...fields()], reset);
        settle([...frame], false);
      }
    },
    /** Nodes moving INTO this document from another (explicit or implicit adoption): ordered; their records judged when the move
     * returns; their fields observed from then on. */
    adopt(fields: Node[], run: () => unknown) {
      drain();
      // The reference of an arriving field is its value on arrival: what this document knew from an earlier stay is not (another
      // document's recorder ordered the writes made meanwhile).
      for (const field of fields) note(field);
      try {
        return run();
      } finally {
        drain();
        for (const field of fields) {
          if (!instrumented(field))
            incomplete(
              "a field from a realm with no recorder was adopted (its writes are not ordered)",
            );
          note(field);
        }
      }
    },
    /** A structural route within this document (revision 8): what is queued is judged before it, and its OWN records as soon as it
     * returns, while the values it exposed are still the values (a later default action cannot change what they showed). */
    structure(run: () => unknown) {
      drain();
      try {
        return run();
      } finally {
        drain();
      }
    },
    /** The end of an operation for one of its participants: what is queued is judged, then the reference moves to the value now. */
    refresh(field: Node, reset: boolean) {
      drain();
      if (reset) entered.delete(field);
      written(field, false);
    },
    title(value: unknown, set: (text: string) => void) {
      drain();
      // Converted ONCE (as the native setter would): the value judged is the value set.
      const text = `${value}`;
      checkTitle(text, "document.title");
      set(text);
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
    /** A scripted edit: an interval like `around` (its participants: the focused field at entry and exit, and every field touched,
     * including those its `input` events reached), and its `input` events are not the person's. */
    exec(run: () => unknown, fields: () => Node[]) {
      const entry = fields();
      const frame = open();
      drain();
      scripted += 1;
      try {
        return run();
      } finally {
        scripted -= 1;
        close(frame);
        drain();
        settle([...entry, ...fields(), ...frame], false);
      }
    },
    begin(tx: IDBTransaction, mode: unknown) {
      const info: TxInfo = {
        id: ++txIds,
        mode: String(mode ?? "readonly"),
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
    },
    read(tx: IDBTransaction, request: IDBRequest) {
      const info = txs.get(tx);
      if (info)
        request.addEventListener("success", () => {
          info.read = summarise(request.result as unknown[], info.id);
        });
    },
    put(tx: IDBTransaction, value: unknown, key: unknown) {
      const info = txs.get(tx);
      if (info && key === "auth_state")
        info.written = summarise([value], info.id);
    },
  };
  type Service = typeof service;
  Object.defineProperty(own, SERVICE, {
    value: service,
    enumerable: false,
    configurable: true,
  });
  const serviceOf = (target: unknown): Service | null => {
    if (target === null || typeof target !== "object") return null;
    let s: Service | undefined;
    try {
      s = (target as Record<symbol, Service | undefined>)[SERVICE];
    } catch {
      return null;
    }
    return s && s.document === target ? s : null;
  };
  /** The recorder of the document that owns `target` now (a node), or null. */
  const serviceFor = (target: unknown) => serviceOf(docOf(target));
  /** The recorder of this realm's CURRENT document (for operations that belong to no node). */
  const current = () => serviceOf(document);
  /** The end of an operation (revision 8): each participant once, by the recorder of the document that owns it NOW (moved inside a
   * handler, it is that document's; with none, this one's). */
  const settle = (fields: Node[], reset: boolean) => {
    for (const field of new Set(fields))
      (serviceFor(field) ?? service).refresh(field, reset);
  };

  // ---- the realm's ordered routes (installed once per realm; each acts for the node's own document) ----
  type Around = (
    self: unknown,
    args: unknown[],
    call: (args: unknown[]) => unknown,
  ) => unknown;
  const setter = (
    proto: object | undefined,
    name: string,
    around: (self: unknown, value: unknown, set: (v: unknown) => void) => void,
    missing?: string,
  ) => {
    const d = proto ? Object.getOwnPropertyDescriptor(proto, name) : undefined;
    if (!d?.set) {
      // Without the value property no field could be judged; an absent optional route changes nothing to order.
      if (missing) incomplete(missing);
      return;
    }
    if (isWrapped(d.set)) return;
    const set = d.set;
    Object.defineProperty(proto as object, name, {
      ...d,
      set: mark(function (this: unknown, value: unknown) {
        around(this, value, (v) => set.call(this, v));
      }),
    });
  };
  const method = (proto: object | undefined, name: string, around: Around) => {
    const d = proto ? Object.getOwnPropertyDescriptor(proto, name) : undefined;
    const original = d?.value as ((...args: unknown[]) => unknown) | undefined;
    if (typeof original !== "function" || isWrapped(original)) return;
    Object.defineProperty(proto as object, name, {
      ...d,
      value: mark(function (this: unknown, ...args: unknown[]) {
        return around(this, args, (a) => original.apply(this, a));
      }),
    });
  };
  /** WebIDL DOMString / nullable DOMString conversion, done once by the wrapper (the native setter then receives a string). */
  const S = (v: unknown) => `${v}`;
  const NS = (v: unknown) => (v === null || v === undefined ? null : `${v}`);
  /** `[LegacyNullToEmptyString] DOMString` (revision 8: a textarea's `innerText`). */
  const LN = (v: unknown) => (v === null ? "" : `${v}`);
  type Kind = "S" | "NS" | "LN" | "-";
  /** Converts the arguments an operation would convert, in order; with fewer than it requires it throws natively before converting any. */
  const convert = (args: unknown[], kinds: Kind[], required: number) =>
    args.length < required
      ? args
      : args.map((a, i) =>
          kinds[i] === "S" ? S(a) : kinds[i] === "NS" ? NS(a) : a,
        );
  const property = (judge: boolean) =>
    ((self, args, call) => {
      const s = isField(self) ? serviceFor(self) : null;
      if (!s) return call(args);
      return s.operate(self as Node, () => call(args), judge);
    }) as Around;
  /** A property-only setter (the value, `valueAsNumber`, `valueAsDate`): the native conversion is kept. */
  const propertySet = (
    self: unknown,
    value: unknown,
    set: (v: unknown) => void,
  ) => {
    property(true)(self, [value], (a) => {
      set(a[0]);
    });
  };
  const converting =
    (kind: Kind) =>
    (self: unknown, value: unknown, set: (v: unknown) => void) => {
      const s = isField(self) ? serviceFor(self) : null;
      if (!s) {
        set(value);
        return;
      }
      const v =
        kind === "S"
          ? S(value)
          : kind === "NS"
            ? NS(value)
            : kind === "LN"
              ? LN(value)
              : value;
      s.change(self as Node, () => set(v));
    };
  const ownerOf = (attr: unknown): unknown => {
    try {
      return (attr as Attr).ownerElement;
    } catch {
      return null;
    }
  };
  /**
   * Nodes (and the fields inside them) about to move INTO the document of `destination`. Within one document (revision 8) the route is
   * structural: its records are judged when it returns. From another document each source is drained first, then the destination.
   */
  const moving = (
    destination: unknown,
    nodes: unknown[],
    call: () => unknown,
  ) => {
    const target = docOf(destination);
    let foreign: Node[] | null = null;
    for (const node of nodes) {
      const from = docOf(node);
      if (from !== null && from !== target && nodeTypeOf(node) !== 9) {
        foreign ??= [];
        foreign.push(node as Node);
      }
    }
    if (!foreign) {
      const s = serviceOf(target);
      return s ? s.structure(call) : call();
    }
    const fields: Node[] = [];
    for (const node of foreign) {
      serviceFor(node)?.drain();
      if (isField(node)) fields.push(node);
      const type = nodeTypeOf(node);
      if (type === 1 || type === 11)
        try {
          for (const found of Array.from(
            (node as ParentNode).querySelectorAll("input,textarea"),
          ))
            if (fields.length < LIMITS.subtree) fields.push(found);
        } catch {
          // Not searchable: its own fields are judged when shown.
        }
    }
    const s = serviceOf(target);
    return s ? s.adopt(fields, call) : call();
  };
  const all: Around = (self, args, call) =>
    moving(self, args, () => call(args));
  const first: Around = (self, args, call) =>
    moving(self, [args[0]], () => call(args));
  /** A structural route that brings no node in (a removal, or markup parsed into NEW nodes): judged when it returns (revision 8). */
  const local: Around = (self, args, call) => {
    const s = serviceFor(self);
    return s ? s.structure(() => call(args)) : call(args);
  };
  const localSet = (
    self: unknown,
    value: unknown,
    set: (v: unknown) => void,
  ) => {
    const s = serviceFor(self);
    if (s) s.structure(() => set(value));
    else set(value);
  };
  const on = (ctor: unknown) =>
    typeof ctor === "function"
      ? ((ctor as { prototype?: object }).prototype ?? undefined)
      : undefined;
  const install = () => {
    const input = on(
      typeof HTMLInputElement === "undefined" ? undefined : HTMLInputElement,
    );
    const textarea = on(
      typeof HTMLTextAreaElement === "undefined"
        ? undefined
        : HTMLTextAreaElement,
    );
    // The value routes (S6; R5-A): ordered, judged by their actual effect when the field is visible; native conversion, return values
    // and thrown errors are the engine's own.
    for (const proto of [input, textarea]) {
      if (!proto) continue;
      setter(
        proto,
        "value",
        propertySet,
        "a form field's value property cannot be observed",
      );
      method(proto, "setRangeText", property(true));
      // The default value is an attribute (input) or the text (textarea): its records are judged; here only the order and the exemption.
      setter(proto, "defaultValue", converting("S"));
    }
    if (input) {
      setter(input, "valueAsNumber", propertySet);
      setter(input, "valueAsDate", propertySet);
      method(input, "stepUp", property(true));
      method(input, "stepDown", property(true));
      // Revision 7 (R5-A/type): the type and the constraints whose change runs the value sanitisation algorithm.
      setter(
        input,
        "type",
        converting("S"),
        "a field's type cannot be ordered",
      );
      for (const name of ["min", "max", "step"])
        setter(input, name, converting("S"));
      setter(input, "multiple", converting("-"));
    }
    // Every attribute route of a field's element (revision 7): ordered before the native side effect.
    const element = on(typeof Element === "undefined" ? undefined : Element);
    const ATTRIBUTE: Array<[string, Kind[], number]> = [
      ["setAttribute", ["S", "S"], 2],
      ["setAttributeNS", ["NS", "S", "S"], 3],
      ["removeAttribute", ["S"], 1],
      ["removeAttributeNS", ["NS", "S"], 2],
      ["toggleAttribute", ["S", "-"], 1],
      ["setAttributeNode", ["-"], 1],
      ["setAttributeNodeNS", ["-"], 1],
      ["removeAttributeNode", ["-"], 1],
    ];
    for (const [name, kinds, required] of ATTRIBUTE)
      method(element, name, (self, args, call) => {
        const s = isField(self) ? serviceFor(self) : null;
        if (!s) return call(args);
        const converted = convert(args, kinds, required);
        return s.change(self as Node, () => call(converted));
      });
    // An attribute node attached to a field: its value by `value`, `nodeValue` or `textContent` (and a textarea's text by `textContent`).
    setter(
      on(typeof Attr === "undefined" ? undefined : Attr),
      "value",
      (self, value, set) => converting("S")(ownerOf(self), value, set),
    );
    for (const name of ["nodeValue", "textContent"])
      setter(on(Node), name, (self, value, set) => {
        const target = nodeTypeOf(self) === 2 ? ownerOf(self) : self;
        // An element's `textContent` replaces its children: structural (revision 8) unless it is a field's own text or attribute.
        if (
          name === "textContent" &&
          !isField(target) &&
          nodeTypeOf(self) === 1
        )
          localSet(self, value, set);
        else converting("NS")(target, value, set);
      });
    // A NamedNodeMap knows no element: the element whose `attributes` returned it.
    const maps = new WeakMap<object, unknown>();
    const attributes = element
      ? Object.getOwnPropertyDescriptor(element, "attributes")
      : undefined;
    if (attributes?.get && !isWrapped(attributes.get)) {
      const get = attributes.get;
      Object.defineProperty(element as object, "attributes", {
        ...attributes,
        get: mark(function (this: unknown) {
          const map = get.call(this) as unknown;
          if (map !== null && typeof map === "object") maps.set(map, this);
          return map;
        }),
      });
    }
    const NAMED_MAP: Array<[string, Kind[], number]> = [
      ["setNamedItem", ["-"], 1],
      ["setNamedItemNS", ["-"], 1],
      ["removeNamedItem", ["S"], 1],
      ["removeNamedItemNS", ["NS", "S"], 2],
    ];
    for (const [name, kinds, required] of NAMED_MAP)
      method(
        on(typeof NamedNodeMap === "undefined" ? undefined : NamedNodeMap),
        name,
        (self, args, call) => {
          const field = maps.get(self as object);
          const s = isField(field) ? serviceFor(field) : null;
          if (!s) return call(args);
          const converted = convert(args, kinds, required);
          return s.change(field as Node, () => call(converted));
        },
      );
    // Ordering boundaries for routes that change field values as a DEFAULT ACTION or a side effect (no field setter is called).
    method(
      on(typeof HTMLFormElement === "undefined" ? undefined : HTMLFormElement),
      "reset",
      (self, args, call) => {
        // `form.reset()` resets detached forms too (no event reaches the window then); the person's exemption ends for its fields.
        const s = serviceFor(self) ?? current();
        if (!s) return call(args);
        return s.around(
          () => call(args),
          () => formFields(self),
          true,
        );
      },
    );
    // A reset (or other) button activated in a detached form: by `click()` or a dispatched click.
    const activation: Around = (self, args, call) => {
      const s = serviceFor(self) ?? current();
      if (!s) return call(args);
      return s.around(
        () => call(args),
        () => formFields(self),
        false,
      );
    };
    method(
      on(typeof HTMLElement === "undefined" ? undefined : HTMLElement),
      "click",
      activation,
    );
    method(
      on(typeof EventTarget === "undefined" ? undefined : EventTarget),
      "dispatchEvent",
      activation,
    );
    const documentProto = on(
      typeof Document === "undefined" ? undefined : Document,
    );
    method(documentProto, "execCommand", (self, args, call) => {
      const s = serviceOf(self);
      if (!s) return call(args);
      return s.exec(
        () => call(args),
        () => {
          try {
            const active = (self as Document).activeElement;
            return isField(active) ? [active] : [];
          } catch {
            return [];
          }
        },
      );
    });
    // Writes that no mutation record shows: the title.
    setter(documentProto, "title", (self, value, set) => {
      const s = serviceOf(self);
      if (!s) set(value);
      else s.title(value, set);
    });
    // A shadow tree is outside what the observer sees: its content would be unobserved, so the evidence is incomplete.
    method(element, "attachShadow", (self, args, call) => {
      serviceFor(self)?.incomplete(
        "a shadow root was attached (its content is not observed)",
      );
      return call(args);
    });
    // Adoption, explicit and implicit (every insertion route a node of another document can take): the source first (revision 7).
    method(documentProto, "adoptNode", first);
    const node = on(typeof Node === "undefined" ? undefined : Node);
    for (const name of ["appendChild", "insertBefore", "replaceChild"])
      method(node, name, first);
    for (const proto of [
      element,
      documentProto,
      on(
        typeof DocumentFragment === "undefined" ? undefined : DocumentFragment,
      ),
    ])
      for (const name of ["append", "prepend", "replaceChildren"])
        method(proto, name, all);
    for (const proto of [
      element,
      on(typeof CharacterData === "undefined" ? undefined : CharacterData),
      on(typeof DocumentType === "undefined" ? undefined : DocumentType),
    ])
      for (const name of ["before", "after", "replaceWith"])
        method(proto, name, all);
    method(element, "insertAdjacentElement", (self, args, call) =>
      moving(self, [args[1]], () => call(args)),
    );
    const startOf = (range: unknown): unknown => {
      try {
        return (range as Range).startContainer;
      } catch {
        return null;
      }
    };
    const range = on(typeof Range === "undefined" ? undefined : Range);
    for (const name of ["insertNode", "surroundContents"])
      method(range, name, (self, args, call) =>
        moving(startOf(self), [args[0]], () => call(args)),
      );
    // Revision 8: the remaining structural routes. A move within a document (where the engine has it); the table's and the document's
    // element setters (they insert the element given); removals; markup and text that replace children.
    for (const proto of [
      element,
      documentProto,
      on(
        typeof DocumentFragment === "undefined" ? undefined : DocumentFragment,
      ),
    ])
      method(proto, "moveBefore", all);
    const table = on(
      typeof HTMLTableElement === "undefined" ? undefined : HTMLTableElement,
    );
    for (const name of ["caption", "tHead", "tFoot"])
      setter(table, name, (self, value, set) =>
        moving(self, [value], () => set(value)),
      );
    setter(documentProto, "body", (self, value, set) =>
      moving(self, [value], () => set(value)),
    );
    method(node, "removeChild", local);
    for (const proto of [
      element,
      on(typeof CharacterData === "undefined" ? undefined : CharacterData),
      on(typeof DocumentType === "undefined" ? undefined : DocumentType),
    ])
      method(proto, "remove", local);
    for (const name of ["deleteContents", "extractContents"])
      method(range, name, (self, args, call) =>
        local(startOf(self), args, () => call(args)),
      );
    for (const name of [
      "insertAdjacentHTML",
      "insertAdjacentText",
      "setHTMLUnsafe",
    ])
      method(element, name, local);
    // A textarea's own markup or text is its default value: a route that changes the field (its records judged with the value it
    // leaves, then its reference refreshed). `innerHTML` keeps the native conversion (it may take a TrustedHTML): stated residual.
    setter(element, "innerHTML", (self, value, set) => {
      const s = isField(self) ? serviceFor(self) : null;
      if (s) s.change(self as Node, () => set(value));
      else localSet(self, value, set);
    });
    setter(element, "outerHTML", localSet);
    const html = on(
      typeof HTMLElement === "undefined" ? undefined : HTMLElement,
    );
    setter(html, "innerText", (self, value, set) =>
      isField(self)
        ? converting("LN")(self, value, set)
        : localSet(self, value, set),
    );
    setter(html, "outerText", localSet);
    // The durable boundary: the atlas-auth transactions of this realm's CURRENT document.
    if (typeof IDBDatabase !== "undefined") {
      method(IDBDatabase.prototype, "transaction", (self, args, call) => {
        const tx = call(args) as IDBTransaction;
        if ((self as IDBDatabase).name === "atlas-auth")
          current()?.begin(tx, args[1]);
        return tx;
      });
      method(IDBObjectStore.prototype, "getAll", (self, args, call) => {
        const request = call(args) as IDBRequest;
        current()?.read((self as IDBObjectStore).transaction, request);
        return request;
      });
      method(IDBObjectStore.prototype, "put", (self, args, call) => {
        current()?.put((self as IDBObjectStore).transaction, args[0], args[1]);
        return call(args);
      });
    }
  };
  install();

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
      // Revision 8: a test's mark is where a shown field changed by no ordered route is asked about while it is still shown (`audit`).
      audit();
      push({ op: "mark", label });
    },
    state: () => ({ record, episode }),
    /** Drains every pending record and answers what THIS document holds (the acknowledgement of the sealed interval). */
    flush: () => {
      drain();
      audit();
      return {
        doc,
        role: witness?.role ?? null,
        current: mine(),
        url: created,
        sseq,
        violations: [...violations],
        limits: [...limits],
      };
    },
  };
  push({ op: "enrolled", readyState: document.readyState });
  witness?.note({ enrolled: true });
  report({ type: "enrolled", url: created }, true);
}
