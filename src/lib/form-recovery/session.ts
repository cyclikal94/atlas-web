import type { RefObject } from "react";
import { buildSnapshot, restoreSnapshot } from "./guard";
import type {
  DiscardResult,
  FormRecoveryPort,
  RecoverableFieldSpec,
  RecoverySnapshot,
  SaveResult,
} from "./port";
import type {
  PageFormSession,
  RecoverableFormHandle,
  RecoverableFormRegistry,
} from "./registry";
import type { RecoveryTab } from "./tab-identity";

/**
 * A FORM SESSION (WEB-14a revision 2; findings R2, R4, DA-1, DA-2 and the design assessment of 10 October 2026): what this page knows and
 * owes for one recoverable form, for as long as the page needs it, whichever MOUNT of the form shows it. A mount of `useRecoverableForm`
 * is only an ATTACHMENT (a view) of the session; the session is what the page's registry lists, and what orders, cancels and reconciles
 * the form's saves and discards. Revision 1 carried a copy of a mount's state to the next mount while the operations it had started kept
 * reading the old mount's state, so the two disagreed: a later save looked older than an earlier one (R2), and a submission in the new
 * mount could not cancel a save still waiting in the old one (R4).
 *
 *  - ONE ORDER. `order.next` numbers every save and discard of the session when it is ASKED FOR (before anything is awaited), and a terminal
 *    act (a submission, "Discard instead", "Discard and reload anyway", a save of a form back at its clean values) records its number in
 *    `order.lastTerminal`: a save asked for before it writes nothing any more, whichever mount asked for either. The port's own order
 *    (`capture_seq`, `writer_gen`) still orders every write that reaches it.
 *  - ONE BASELINE. What is durable (`persisted.own`) changes only when a save LANDS, and only to a newer save's values than the one it
 *    knows, so a save that completes late never makes an older copy look current.
 *  - ONE SCOPE. A session belongs to one account's database as it was when the session began (`scope`: the account and its incarnation,
 *    `FormRecoveryPort.pin`). Every write is pinned when it is asked for and made only if the port still reaches that same scope (DA-2: a
 *    form that stays mounted while its account's database is deleted and created again writes nothing into the new one). A session is
 *    never bound to another scope; detached sessions of another scope are retired when a form binds to a new one (another account, or the
 *    database re-created), so their memory-only input never reaches it.
 *  - OUTSTANDING WORK COUNTS. A session is LISTED in the registry (what the update coordinator saves through) while it is attached,
 *    dirty, owes a discard or has an operation outstanding (`pending`), even when no mount shows it: a remount never takes unfinished work
 *    out of the coordinator's sight. A clean, idle session no mount shows is not listed, but it is KEPT for the next mount of the form in
 *    this page (its input, its baseline, its restored copy and alternatives), until a form binds to another scope.
 *
 *  - WHAT WAS SENT IS NOT WHAT THE FORM HOLDS (revision 3, R3 and R10). Every change of the input (the person's, through the attached
 *    mount's `input`/`change`/`reset` events, or the hook's own restores) moves `input` (the input REVISION). A submission records, when it
 *    is sent, the session it belongs to, that revision, the field schema and the values (`Submission`). Its success is reconciled against
 *    that record only: the submitted input becomes the clean state and its copies are discarded when the form still holds exactly it;
 *    input changed after it was sent stays the form's, dirty until saved (its copy replaces an obsolete one), and is never declared clean
 *    by an older response (`acknowledge`).
 *  - THE ATTACHED MOUNT'S SCHEMA ADMITS (revision 3, R11). The session's allow-list (`allow`, normalised) is the attached mount's; a mount
 *    with another list makes a TRANSITION (`changeSchema`): carried values of the fields both admit are restored, newly admitted fields start
 *    from the mount's values, and the content of a field no longer admitted is never captured: it is held, in memory only, as an
 *    unresolved obligation (`stranded`): the form counts as dirty and cannot be saved until that field is admitted again or the input is
 *    discarded (design assessment D1: whether such content may be dropped is the form owner's decision, not this module's). An operation
 *    already captured keeps the schema it was captured with; comparisons are made in the current schema (`sameIn`).
 *
 * Memory only: nothing here is written anywhere except through the port.
 */
export type Values = Record<string, string>;

export const readValues = (
  form: HTMLFormElement,
  allow: readonly RecoverableFieldSpec[],
): Values =>
  // Never throws for a sensitive field here (that is the save's strict check): it is only compared.
  buildSnapshot({
    form,
    formContext: "",
    tabInstanceId: "",
    allow,
    strict: false,
  }).values;

export const sameValues = (a: Values, b: Values): boolean => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if (a[key] !== b[key]) return false;
  return true;
};

/**
 * Whether `now` (values read in the session's current schema) is what `base` would show (revision 3, R11): a field `base` has no value for
 * (it was captured under a schema without it) would show its initial value; a field `now` lacks (no longer admitted, or not rendered) is
 * not compared.
 */
export const sameIn = (now: Values, base: Values, initial: Values): boolean => {
  for (const [key, value] of Object.entries(now))
    if ((base[key] ?? initial[key]) !== value) return false;
  return true;
};

/** An allow-list in its normal form (each name once, in name order): reordering the same fields is not a change. */
export const normaliseAllow = (
  allow: readonly RecoverableFieldSpec[],
): readonly RecoverableFieldSpec[] =>
  [...new Set(allow.map((spec) => spec.name))].sort().map((name) => ({ name }));

/** The identity of an allow-list's schema (equal for the same fields in any order). */
export const schemaKey = (allow: readonly RecoverableFieldSpec[]): string =>
  normaliseAllow(allow)
    .map((spec) => spec.name)
    .join("\n");

/** What this page believes is durable for the form, and what it owes. */
export interface Persisted {
  /** This page's own latest durable copy (its values), and the order of the save that wrote it. */
  own: { values: Values; op: number } | null;
  /** Whether this page has ever asked to write a copy under its own identifier (so a discard must reach it). */
  ownAsked: boolean;
  /**
   * The copy of another (gone) tab this form was restored from, still in the store: the next page would restore it again while this page
   * has none of its own. `newest`: it is the newest of the copies (an alternative chosen instead may not be).
   */
  source: { id: string; values: Values; newest: boolean } | null;
  /**
   * The order of the newest discard (a submission, "Discard instead", "Discard and reload anyway") that has not landed, or 0: while it is
   * not 0 copies may come back. Only a discard at least as new clears it, so an older discard landing late never clears a newer debt.
   */
  owed: number;
}

/** What the mount shows besides the input: the copy restored and the others offered. */
export interface SessionView {
  restored: RecoverySnapshot | null;
  alternatives: readonly RecoverySnapshot[];
}

/** One mount of the form showing the session. */
export interface Attachment {
  readonly token: number;
  readonly element: HTMLFormElement;
  readonly ref: RefObject<HTMLFormElement | null>;
  /** Shows the session's view in the mount (its restored copy and alternatives). */
  readonly show: (view: SessionView) => void;
  /** Stops counting the mount's input events (revision 3, R3). */
  readonly stop: () => void;
}

export interface FormSession extends PageFormSession {
  readonly formContext: string;
  readonly scope: string;
  readonly account: string;
  readonly registry: RecoverableFormRegistry;
  readonly tab: RecoveryTab;
  /**
   * The attached mount's allow-list, normalised (revision 3, R11): what every read, capture, carry and restore of the session admits NOW.
   * Replaced (never mutated) by a schema transition, so an operation that captured it keeps its own.
   */
  allow: readonly RecoverableFieldSpec[];
  /** `schemaKey(allow)`. */
  schema: string;
  /** The port the session was last bound through (a remount in the same scope brings a new one). */
  port: FormRecoveryPort;
  /**
   * What the form showed when the session began, before any restore ("Discard instead" puts it back); a field admitted later starts from
   * what the form showed for it then (revision 3, R11).
   */
  initial: Values;
  /** The values for which no copy is needed when nothing is durable: the initial values, or what the form showed at a terminal act. */
  clean: Values;
  persisted: Persisted;
  readonly order: { next: number; lastTerminal: number };
  /** The input revision (revision 3, R3): moved by every change of what the form holds, never by carrying it to another mount. */
  input: number;
  /** The newest submission acknowledged (its input revision) and what its acknowledgement answered (revision 3, R3: no older one regresses it). */
  acknowledged: { input: number; result: Promise<SubmissionResult> } | null;
  /**
   * Content of fields the attached schema no longer admits (revision 3, R11; design assessment D1), in memory only: never captured, never
   * dropped silently. While it holds anything the form is dirty and cannot be saved; admitting the field again restores it, and a discard
   * drops it.
   */
  stranded: Values;
  view: SessionView;
  /** The look for copies to restore: not made yet, being made (by the attachment named), or made. */
  look: "none" | "running" | "done";
  attached: Attachment | null;
  /** What the form showed when its last mount went (memory only, allow-listed values only), while no mount shows it. */
  left: { values: Values; sensitive: boolean } | null;
  readonly pending: Set<Promise<unknown>>;
  /** How many freezes hold the session (a mount attached during a freeze is frozen as it attaches). */
  frozen: number;
  /** Whether its handle is in the registry's list now. */
  listed: boolean;
  retired: boolean;
  readonly handle: RecoverableFormHandle;
}

let tokens = 0;

/** The element the session's input is read from: the attached mount's form, or null while no mount shows it. */
export const elementOf = (session: FormSession): HTMLFormElement | null =>
  session.attached
    ? (session.attached.ref.current ?? session.attached.element)
    : null;

/** What the form holds now: the attached mount's allow-listed values, or what its last mount left. */
export const valuesOf = (session: FormSession): Values => {
  const form = elementOf(session);
  if (form) return readValues(form, session.allow);
  return session.left?.values ?? session.clean;
};

const hasStranded = (session: FormSession): boolean =>
  Object.keys(session.stranded).length > 0;

/**
 * What the next page would show for this form if the page went now (R2): dirty when that is not what the form holds, compared in the
 * current schema (revision 3, R11); content of a field no longer admitted is an obligation of its own (`stranded`).
 */
export const isDirty = (session: FormSession): boolean => {
  const { own, source, owed } = session.persisted;
  if (owed > 0 || hasStranded(session)) return true;
  const now = valuesOf(session);
  if (own) return !sameIn(now, own.values, session.initial);
  // A chosen alternative that is not the newest copy is not what the next page would restore: only a copy of this page's own makes it so.
  if (source)
    return !source.newest || !sameIn(now, source.values, session.initial);
  return !sameIn(now, session.clean, session.initial);
};

/** The form's input changed (revision 3, R3): the person's edit, or a restore or discard the hook made. */
export const noteInput = (session: FormSession): void => {
  session.input += 1;
};

/** The port for a write asked for NOW, pinned to the database it reaches now; null when that is not the session's scope (or none). */
export const targetOf = (session: FormSession): FormRecoveryPort | null => {
  const port = session.port;
  if (!port.pin) return session.scope === UNSCOPED ? port : null;
  const pinned = port.pin();
  if (pinned === null) return null;
  // The whole scope (the account AND its incarnation), not the account alone (DA-2).
  if (pinned.scope !== session.scope) return null;
  return pinned.port;
};

/** The scope of a port over a single store, which has nothing to pin. */
export const UNSCOPED = "";

/** Counts an operation as outstanding until it settles; then the session may retire. */
export function track<T>(
  session: FormSession,
  operation: Promise<T>,
): Promise<T> {
  list(session);
  session.pending.add(operation);
  const settle = (): void => {
    session.pending.delete(operation);
    unlistIfIdle(session);
  };
  operation.then(settle, settle);
  return operation;
}

/**
 * Discards the session's copies (this page's own and the one it was restored from) through `target`, as the operation numbered `op`. The
 * caller has already taken its place in the order (a save asked for before it writes nothing any more), so the port orders it after every
 * capture already asked for.
 */
export async function discardAt(
  session: FormSession,
  target: FormRecoveryPort | null,
  op: number,
): Promise<DiscardResult> {
  const state = session.persisted;
  const ids = new Set<string>();
  const own = session.tab.current();
  if (own !== null && (state.ownAsked || state.own !== null)) ids.add(own);
  if (state.source !== null) ids.add(state.source.id);
  if (ids.size === 0) {
    if (state.owed <= op) session.persisted = { ...state, owed: 0 };
    return "discarded";
  }
  if (!target) {
    session.persisted = {
      ...session.persisted,
      owed: Math.max(session.persisted.owed, op),
    };
    return "failed";
  }
  const context = session.formContext;
  const results = await Promise.all(
    [...ids].map((id) =>
      target
        .discard(context, id)
        .catch((): DiscardResult => "failed")
        .then((result) => ({ id, result })),
    ),
  );
  const next = { ...session.persisted };
  let outcome: DiscardResult = "discarded";
  for (const { id, result } of results) {
    if (result === "discarded") {
      if (id === own && next.own !== null && next.own.op < op) next.own = null;
      if (next.source?.id === id) next.source = null;
    } else outcome = outcome === "refused" ? outcome : result;
  }
  if (outcome === "discarded") {
    if (next.owed <= op) next.owed = 0;
  } else next.owed = Math.max(next.owed, op);
  session.persisted = next;
  return outcome;
}

/** Saves a copy of what the form holds now (or discards its copies when it is back to its clean values). Never throws. */
export async function flushSession(session: FormSession): Promise<SaveResult> {
  // Content of a field the form no longer admits cannot be captured, and a capture without it would replace a copy that may hold it
  // (revision 3, R11; D1): nothing is written, and the form stays dirty.
  if (hasStranded(session)) return "failed";
  // Pinned NOW (before anything is awaited): the write reaches this session's database, or nothing.
  const target = targetOf(session);
  if (!target) return "failed";
  // The capture, its schema and its place in the order are fixed NOW, before anything is awaited (R4; revision 3, R11).
  session.order.next += 1;
  const op = session.order.next;
  const allow = session.allow;
  const now = valuesOf(session);
  // Back to the clean state: the copies are discarded instead, so the next page shows that state (R2).
  if (sameIn(now, session.clean, session.initial)) {
    session.order.lastTerminal = op;
    const result = await discardAt(session, target, op);
    return result === "discarded" ? "saved" : result;
  }
  const form = elementOf(session);
  let captured: RecoverySnapshot;
  if (form) {
    try {
      captured = buildSnapshot({
        form,
        formContext: session.formContext,
        tabInstanceId: "",
        allow,
      });
    } catch {
      return "failed";
    }
  } else {
    // No mount shows the form: what its last mount left (allow-listed, never a sensitive field), unless that mount had one in its
    // allow-list (the strict guard refuses such a capture, as it would have refused it then).
    if (session.left?.sensitive) return "failed";
    captured = {
      formContext: session.formContext,
      tabInstanceId: "",
      values: { ...now },
      savedAt: new Date().toISOString(),
    };
  }
  session.persisted = { ...session.persisted, ownAsked: true };
  let id: string;
  try {
    id = await session.tab.id();
  } catch {
    return "failed";
  }
  // A submission or discard asked for after this capture (by any mount of the form) has overtaken it: it is obsolete and is never written.
  if (session.order.lastTerminal > op) return "failed";
  const result = await target
    .save({ ...captured, tabInstanceId: id })
    .catch((): SaveResult => "failed");
  if (result !== "saved") return result;
  const state = session.persisted;
  // Only a save newer than every terminal act and than the copy already known moves the baseline (a late save never regresses it).
  if (session.order.lastTerminal < op && (state.own?.op ?? -1) < op)
    session.persisted = {
      ...state,
      own: { values: captured.values, op },
      // This page's own copy is newer than every discard that did not land: nothing unwanted can be restored in its place.
      owed: state.source === null && state.owed < op ? 0 : state.owed,
    };
  const source = session.persisted.source;
  if (source !== null && source.id !== id) {
    const dropped = await target
      .discard(session.formContext, source.id)
      .catch((): DiscardResult => "failed");
    if (dropped === "discarded" && session.persisted.source?.id === source.id)
      session.persisted = {
        ...session.persisted,
        source: null,
        owed: session.persisted.owed < op ? 0 : session.persisted.owed,
      };
  }
  return result;
}

/**
 * A terminal act, in the session's order NOW (R4): every save asked for before it is obsolete, the form's clean state becomes `clean`,
 * and the copies are discarded (pinned now). Counted as outstanding until it settles.
 */
export function terminalAct(
  session: FormSession,
  clean: Values | null,
  kind: "discard" | "submission" = "discard",
): Promise<DiscardResult> {
  session.order.next += 1;
  const op = session.order.next;
  session.order.lastTerminal = op;
  if (clean !== null) session.clean = clean;
  // A discard drops what the form held, including content of fields no longer admitted (revision 3, R11: the person's explicit act); a
  // submission sent only what it sent.
  if (kind === "discard") session.stranded = {};
  session.persisted = {
    ...session.persisted,
    owed: Math.max(session.persisted.owed, op),
  };
  return track(session, discardAt(session, targetOf(session), op));
}

// ---- submissions (revision 3, R3 and R10) --------------------------------------------------------------------------------------------

/**
 * What a submission's success did: `discarded` (the form still held exactly what was sent; no copy of it can come back), `kept` (input changed
 * after the send stays the form's: dirty until saved, and a copy of it may come back after a reload, by design), or, as a discard,
 * `failed`/`refused` (a copy of the sent input may still come back).
 */
export type SubmissionResult = DiscardResult | "kept";

/**
 * A submission as it was SENT (revision 3, R3, R10), fixed when it is sent and never changed: the session it belongs to (whatever the hook
 * that sent it shows later), the input revision, the schema and the values it sent (allow-listed, never a sensitive field). `input` is null
 * when the revision is unknown (sent before the form had a session, and the input changed before it had one).
 */
export interface Submission {
  readonly session: FormSession;
  readonly input: number | null;
  readonly schema: string;
  readonly values: Values;
}

/** What the session's form holds NOW, as a submission sent now. */
export const submissionOf = (session: FormSession): Submission => ({
  session,
  input: session.input,
  schema: session.schema,
  values: { ...valuesOf(session) },
});

/**
 * A submission succeeded: reconciled in ITS session against what IT sent (revision 3, R3, R10), never against the form's current owner or
 * values.
 *  - A newer submission of the session was acknowledged already: its answer (an older response never regresses it).
 *  - The form still holds exactly what was sent (the same revision, schema and values): a terminal act in the session's order NOW; what was
 *    sent becomes the clean state, and its copies are discarded.
 *  - Otherwise the input changed after the send: it stays the form's (dirty until saved). When the form has a copy in the store (or owes a
 *    discard), it is saved again now, so an obsolete copy never stands in for the later input; nothing is discarded. `kept`.
 * Whatever it starts is outstanding before this returns.
 */
export function acknowledge(sent: Submission): Promise<SubmissionResult> {
  const session = sent.session;
  const known = session.acknowledged;
  if (known && sent.input !== null && sent.input <= known.input)
    return known.result;
  const unchanged =
    sent.input !== null &&
    sent.input === session.input &&
    sent.schema === session.schema &&
    sameIn(valuesOf(session), sent.values, session.initial);
  let result: Promise<SubmissionResult>;
  if (unchanged)
    result = terminalAct(session, { ...sent.values }, "submission");
  else {
    const { own, source, ownAsked, owed } = session.persisted;
    result =
      own !== null || source !== null || ownAsked || owed > 0
        ? track(session, flushSession(session)).then(
            (): SubmissionResult => "kept",
          )
        : Promise.resolve<SubmissionResult>("kept");
  }
  if (sent.input !== null && (known === null || sent.input > known.input))
    session.acknowledged = { input: sent.input, result };
  return result;
}

/** The session's view changes; the mount showing it (if any) shows it. */
export function setSessionView(session: FormSession, view: SessionView): void {
  session.view = view;
  session.attached?.show(view);
}

// ---- holding a form still (R3) -------------------------------------------------------------------------------------------------------

/** Per element: how many holds, and its own `inert` / `aria-busy` before the first, put back after the last. */
const holds = new WeakMap<
  HTMLFormElement,
  { count: number; inert: boolean; busy: string | null }
>();

/** Holds the element still (`inert`: no focus, no click, no typing in it; `aria-busy`); returns the release (idempotent). */
export function holdElement(form: HTMLFormElement): () => void {
  const held = holds.get(form) ?? {
    count: 0,
    inert: form.hasAttribute("inert"),
    busy: form.getAttribute("aria-busy"),
  };
  held.count += 1;
  holds.set(form, held);
  // The attribute, which every supported engine reflects (jsdom has no `inert` property).
  form.setAttribute("inert", "");
  form.setAttribute("aria-busy", "true");
  let released = false;
  return () => {
    if (released) return;
    released = true;
    held.count -= 1;
    if (held.count > 0) return;
    holds.delete(form);
    if (!held.inert) form.removeAttribute("inert");
    if (held.busy === null) form.removeAttribute("aria-busy");
    else form.setAttribute("aria-busy", held.busy);
  };
}

/** The release of the hold on the attached element, while the session is frozen. */
const elementHolds = new WeakMap<FormSession, () => void>();

const holdAttached = (session: FormSession): void => {
  const form = elementOf(session);
  if (!form || session.frozen === 0 || elementHolds.has(session)) return;
  elementHolds.set(session, holdElement(form));
};
const releaseAttached = (session: FormSession): void => {
  elementHolds.get(session)?.();
  elementHolds.delete(session);
};

function freezeSession(session: FormSession): () => void {
  session.frozen += 1;
  holdAttached(session);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    session.frozen -= 1;
    if (session.frozen === 0) releaseAttached(session);
  };
}

// ---- lifetime -------------------------------------------------------------------------------------------------------------------------

export interface OpenSession {
  formContext: string;
  scope: string;
  account: string;
  registry: RecoverableFormRegistry;
  tab: RecoveryTab;
  /** The first mount's allow-list (the session keeps its normal form). */
  allow: readonly RecoverableFieldSpec[];
  port: FormRecoveryPort;
  initial: Values;
  /** Whether the registry keeps it as the context's session (false: another mount of the same context is attached to that one). */
  keep: boolean;
}

/** The registration of each listed session's handle. */
const registrations = new WeakMap<FormSession, () => void>();

/** The session's handle joins the registry's list (a freeze in force holds it as it joins). */
function list(session: FormSession): void {
  if (session.listed || session.retired) return;
  session.listed = true;
  registrations.set(session, session.registry.register(session.handle));
}
function unlist(session: FormSession): void {
  if (!session.listed) return;
  session.listed = false;
  const unregister = registrations.get(session);
  registrations.delete(session);
  unregister?.();
}

/** A new session, listed (its handle is what the coordinator saves through) and, unless `keep` is false, the context's. */
export function openSession(options: OpenSession): FormSession {
  const session: FormSession = {
    formContext: options.formContext,
    scope: options.scope,
    account: options.account,
    registry: options.registry,
    tab: options.tab,
    allow: normaliseAllow(options.allow),
    schema: schemaKey(options.allow),
    port: options.port,
    initial: options.initial,
    clean: options.initial,
    persisted: { own: null, ownAsked: false, source: null, owed: 0 },
    order: { next: 0, lastTerminal: 0 },
    input: 0,
    acknowledged: null,
    stranded: {},
    view: { restored: null, alternatives: [] },
    look: "none",
    attached: null,
    left: null,
    pending: new Set(),
    frozen: 0,
    listed: false,
    retired: false,
    handle: {
      formContext: options.formContext,
      isDirty: () => isDirty(session),
      flush: () => track(session, flushSession(session)),
      // "Discard and reload anyway": the input the form holds is the person's to drop; what counts as clean is what it holds now.
      discard: () => terminalAct(session, valuesOf(session)),
      freeze: () => freezeSession(session),
      settled: () =>
        session.pending.size === 0
          ? null
          : Promise.allSettled([...session.pending]).then(() => undefined),
    },
  };
  if (options.keep) options.registry.keep(session);
  list(session);
  return session;
}

/** Ends the session: no longer listed or kept, never attached again. Operations already asked for run to their end (pinned to their scope). */
export function retire(session: FormSession): void {
  if (session.retired) return;
  releaseAttached(session);
  unlist(session);
  session.retired = true;
  session.registry.forget(session);
}

/**
 * A session no mount shows, that is clean, owes nothing and has nothing outstanding, leaves the registry's list (nothing of it needs
 * saving); the context's session is kept for the next mount, another (a second mount's own) is retired.
 */
export function unlistIfIdle(session: FormSession): void {
  if (
    session.retired ||
    session.attached !== null ||
    session.pending.size > 0 ||
    session.persisted.owed > 0 ||
    isDirty(session)
  )
    return;
  if (session.registry.session(session.formContext) === session)
    unlist(session);
  else retire(session);
}

/** A form bound to `scope`: the page now shows that database, so the sessions no mount shows of any other scope are retired. */
export function retireOtherScopes(
  registry: RecoverableFormRegistry,
  scope: string,
): void {
  for (const other of registry.sessions()) {
    const session = other as FormSession;
    if (session.scope !== scope && session.attached === null) retire(session);
  }
}

/** The value each field starts from in the form as written (its default): what a field admitted while mounted counted as initially. */
function defaultsOf(
  form: HTMLFormElement,
  allow: readonly RecoverableFieldSpec[],
): Values {
  const values: Values = {};
  for (const { name } of allow) {
    const element = form.elements.namedItem(name);
    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement
    )
      values[name] = element.defaultValue;
    else if (element instanceof HTMLSelectElement) {
      const options = [...element.options];
      values[name] =
        (options.find((option) => option.defaultSelected) ?? options[0])
          ?.value ?? "";
    }
  }
  return values;
}

/**
 * The attached schema becomes `allow` (revision 3, R11). `removedFrom`: what the form held for fields no longer admitted (the last mount's
 * carry, or the mounted form); content that differs from the field's initial value is held (`stranded`), never captured or dropped.
 * `addedFrom`: what a newly admitted field starts from. Answers the held content of fields admitted again, to be shown where the person has
 * not typed. Reordering the same fields is no transition.
 */
function transition(
  session: FormSession,
  allow: readonly RecoverableFieldSpec[],
  removedFrom: Values,
  addedFrom: Values,
): Values {
  const next = normaliseAllow(allow);
  const key = schemaKey(next);
  if (key === session.schema) return {};
  const before = new Set(session.allow.map((spec) => spec.name));
  const after = new Set(next.map((spec) => spec.name));
  const stranded = { ...session.stranded };
  const readmitted: Values = {};
  for (const name of before) {
    if (after.has(name)) continue;
    const value = removedFrom[name];
    if (value !== undefined && value !== (session.initial[name] ?? ""))
      stranded[name] = value;
  }
  for (const name of after) {
    if (before.has(name)) continue;
    const held = stranded[name];
    if (held !== undefined) {
      readmitted[name] = held;
      delete stranded[name];
    }
    const start = addedFrom[name];
    if (session.initial[name] === undefined && start !== undefined)
      session.initial = { ...session.initial, [name]: start };
  }
  session.allow = next;
  session.schema = key;
  session.stranded = stranded;
  noteInput(session);
  return readmitted;
}

/** Puts `values` into the fields of `form` that still show `untouched` (the person has not typed into them). */
function restoreUntouched(
  session: FormSession,
  form: HTMLFormElement,
  values: Values,
  untouched: Values,
): void {
  const shown = readValues(form, session.allow);
  const restore: Values = {};
  for (const [name, value] of Object.entries(values))
    if (shown[name] !== undefined && shown[name] === untouched[name])
      restore[name] = value;
  if (Object.keys(restore).length === 0) return;
  restoreSnapshot(
    form,
    {
      formContext: session.formContext,
      tabInstanceId: "",
      values: restore,
      savedAt: "",
    },
    session.allow,
  );
}

/**
 * The mounted form's allow-list changed while it stays mounted (revision 3, R11): the same transition as a mount with that list.
 * A session no mount shows makes it when one attaches.
 */
export function changeSchema(
  session: FormSession,
  allow: readonly RecoverableFieldSpec[],
): void {
  const form = elementOf(session);
  if (!form || schemaKey(allow) === session.schema) return;
  const readmitted = transition(
    session,
    allow,
    readValues(form, session.allow),
    defaultsOf(form, allow),
  );
  restoreUntouched(session, form, readmitted, session.initial);
}

const INPUT_EVENTS = ["input", "change", "reset"] as const;

/**
 * A mount shows the session, with its allow-list (revision 3, R11: a schema transition when it differs). The input the last mount left is
 * put back into every field the person has not typed into in this mount (each still shows `mountValues`); a field the person has typed
 * into keeps what they typed. A freeze in force holds the new element too. From now on the mount's input events move the session's input
 * revision.
 */
export function attach(
  session: FormSession,
  element: HTMLFormElement,
  ref: RefObject<HTMLFormElement | null>,
  mountValues: Values,
  show: (view: SessionView) => void,
  allow: readonly RecoverableFieldSpec[],
): Attachment {
  const left = session.left;
  const readmitted = transition(
    session,
    allow,
    left?.values ?? {},
    mountValues,
  );
  restoreUntouched(
    session,
    element,
    { ...readmitted, ...(left?.values ?? {}) },
    mountValues,
  );
  const onInput = (): void => noteInput(session);
  for (const type of INPUT_EVENTS)
    element.addEventListener(type, onInput, true);
  const attachment: Attachment = {
    token: ++tokens,
    element,
    ref,
    show,
    stop: () => {
      for (const type of INPUT_EVENTS)
        element.removeEventListener(type, onInput, true);
    },
  };
  session.left = null;
  session.attached = attachment;
  list(session);
  holdAttached(session);
  return attachment;
}

/** The mount goes: what it shows is kept (memory only), and the session stays registered while it is still needed. */
export function detach(session: FormSession, attachment: Attachment): void {
  if (session.attached?.token !== attachment.token) return;
  attachment.stop();
  const form = attachment.element;
  const values = readValues(form, session.allow);
  let sensitive = false;
  try {
    buildSnapshot({
      form,
      formContext: session.formContext,
      tabInstanceId: "",
      allow: session.allow,
    });
  } catch {
    sensitive = true;
  }
  releaseAttached(session);
  session.attached = null;
  session.left = { values, sensitive };
  // A look the mount was making is made again by the next mount.
  if (session.look === "running") session.look = "none";
  unlistIfIdle(session);
}
