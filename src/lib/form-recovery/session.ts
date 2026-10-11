import type { RefObject } from "react";
import {
  adopt,
  allResolved,
  capturable,
  copyMatches,
  cover,
  coverUnedited,
  dropRetained,
  type FieldState,
  hasDebt,
  held,
  sameHeld,
  setSchema,
  sync,
  type Values,
  watch,
} from "./fields";
import { buildSnapshot } from "./guard";
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
 *  - WHAT WAS SENT IS NOT WHAT THE FORM HOLDS (revision 3, R3 and R10; revision 4). What the form holds, field by field, with the
 *    provenance of every edit and the coverage of every terminal act, is the session's FIELD STATE (`fields.ts`: `session.fields`). A
 *    submission records, when it is sent, the session it belongs to, the input revision and everything the form held (`Submission`). Its
 *    success is reconciled against that record only: when the form still holds exactly it, it covers it (it needs no copy any more) and its
 *    copies are discarded; input changed after it was sent stays the form's, unfinished until saved, EVEN WHEN IT EQUALS THE TEXT OF THIS
 *    OR AN EARLIER SUCCESSFUL SUBMISSION (revision 4, R3: an edit after the send is never covered by it), and is never declared clean by an
 *    older response (`acknowledge`). Only the form's initial values, which the next page starts from again, need no copy without a terminal
 *    act (`resolved`).
 *  - THE MOUNT'S COMMITTED SCHEMA ADMITS (revision 3, R11; revision 4). The field state's allow-list (normalised; the empty list included)
 *    is the attached mount's committed one; a mount with another list, or a list changed while mounted, makes a transition. The content of a
 *    field no longer admitted, or no longer on the page, is RETAINED (in memory only, from the ledger kept at every input event, so a field
 *    removed in the same render as its admission keeps what it held): never captured, never dropped silently. While retained input is not
 *    resolved the form is dirty and cannot be saved (an update reload stops with retry or an explicit discard, Q4); the field shown again
 *    takes it back (PRODUCT-DECISIONS-20261011: a conditionally hidden field keeps its value while editing and gets it back when it
 *    reappears), and a successful submission covers it (no warning or block for the form's own save). An operation already captured keeps
 *    the schema it was captured with.
 *
 * Memory only: nothing here is written anywhere except through the port.
 */
export type { Values } from "./fields";

/** The values `allow` admits in `form` now (never a sensitive field: that is the save's strict check). */
export const readValues = (
  form: HTMLFormElement,
  allow: readonly RecoverableFieldSpec[],
): Values =>
  buildSnapshot({
    form,
    formContext: "",
    tabInstanceId: "",
    allow,
    strict: false,
  }).values;

export { normaliseAllow, schemaKey } from "./fields";

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
   * What the form holds, field by field (revision 4; `fields.ts`): the ledger, presence, edit provenance and coverage, and the committed
   * schema (`fields.allow`: what every read, capture and restore admits NOW; replaced, never mutated, so an operation keeps its own).
   */
  fields: FieldState;
  /** The port the session was last bound through (a remount in the same scope brings a new one). */
  port: FormRecoveryPort;
  persisted: Persisted;
  readonly order: { next: number; lastTerminal: number };
  /** The newest submission acknowledged (its input revision) and what its acknowledgement answered (revision 3, R3: no older one regresses it). */
  acknowledged: { input: number; result: Promise<SubmissionResult> } | null;
  view: SessionView;
  /** The look for copies to restore: not made yet, being made (by the attachment named), or made. */
  look: "none" | "running" | "done";
  attached: Attachment | null;
  /** While no mount shows the form: whether its last mount had a sensitive field in its allow-list (the strict guard refuses its capture). */
  left: { sensitive: boolean } | null;
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

/** What a copy of the form can hold now: the admitted fields the attached mount shows, or the ones its last mount showed. */
export const valuesOf = (session: FormSession): Values =>
  capturable(session.fields);

/**
 * What the next page would show for this form if the page went now (R2), field by field (revision 4): dirty when that is not what the form
 * holds. With a copy: the copy must give back every value shown and no other value of a field it holds. With none: every value must be
 * resolved (where the form starts from again, or covered by a terminal act and not edited since: R3). Retained input that is not resolved is
 * an obligation of its own (R11).
 */
export const isDirty = (session: FormSession): boolean => {
  const { own, source, owed } = session.persisted;
  const fields = session.fields;
  if (owed > 0 || hasDebt(fields)) return true;
  const now = valuesOf(session);
  if (own) return !copyMatches(fields, own.values, now);
  // A chosen alternative that is not the newest copy is not what the next page would restore: only a copy of this page's own makes it so.
  if (source) return !source.newest || !copyMatches(fields, source.values, now);
  return !allResolved(fields, now);
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
  // Retained input (a field no longer admitted or no longer shown) cannot be captured, and a capture without it would replace a copy that
  // may hold it (revision 3, R11; D1; revision 4): nothing is written, and the form stays dirty.
  if (hasDebt(session.fields)) return "failed";
  // Pinned NOW (before anything is awaited): the write reaches this session's database, or nothing.
  const target = targetOf(session);
  if (!target) return "failed";
  // The capture, its schema and its place in the order are fixed NOW, before anything is awaited (R4; revision 3, R11).
  session.order.next += 1;
  const op = session.order.next;
  const allow = session.fields.allow;
  const now = valuesOf(session);
  // Nothing unfinished (each value is where the form starts from again, or covered by a terminal act and not edited since: revision 4,
  // R3): the copies are discarded instead, so the next page shows that state (R2).
  if (allResolved(session.fields, now)) {
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
  const fields = session.fields;
  // A discard drops what the form held, including retained input (revision 3, R11: the person's explicit act); a submission that covers
  // what the form holds covers its retained values too (PRODUCT-DECISIONS-20261011: the hidden values of the state it saved).
  if (kind === "discard") dropRetained(fields);
  else fields.shadowed = {};
  // What the act leaves needs no copy until it is edited again (revision 4, R3).
  if (clean !== null) cover(fields, clean, fields.input);
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
 * that sent it shows later), the input revision, and everything the form held (`held`: the fields it sent, and the retained values of
 * fields the form did not show then; allow-listed, never a sensitive field). `input` is null when the revision is unknown (sent before the
 * form had a session, and the input changed before it had one).
 */
export interface Submission {
  readonly session: FormSession;
  readonly input: number | null;
  readonly held: Values;
}

/** What the session's form holds NOW, as a submission sent now. */
export const submissionOf = (session: FormSession): Submission => ({
  session,
  input: session.fields.input,
  held: held(session.fields),
});

/**
 * A submission succeeded: reconciled in ITS session against what IT sent (revision 3, R3, R10), never against the form's current owner or
 * values.
 *  - A newer submission of the session was acknowledged already: its answer (an older response never regresses it).
 *  - The form still holds exactly what was sent (the same revision, and the same values field by field, shown or retained): a terminal act
 *    in the session's order NOW; what was sent is covered, and its copies are discarded.
 *  - Otherwise the input changed after the send: it stays the form's (dirty until saved, whatever text it holds: revision 4, R3). Only the
 *    fields not edited since the send are covered by it. When the form has a copy in the store (or owes a discard), it is saved again now,
 *    so an obsolete copy never stands in for the later input; nothing is discarded. `kept`.
 * Whatever it starts is outstanding before this returns.
 */
export function acknowledge(sent: Submission): Promise<SubmissionResult> {
  const session = sent.session;
  const known = session.acknowledged;
  if (known && sent.input !== null && sent.input <= known.input)
    return known.result;
  const fields = session.fields;
  const unchanged =
    sent.input !== null &&
    sent.input === fields.input &&
    sameHeld(fields, held(fields), sent.held);
  let result: Promise<SubmissionResult>;
  if (unchanged) result = terminalAct(session, { ...sent.held }, "submission");
  else {
    // Only what was not edited since the send is covered by it (revision 4, R3).
    if (sent.input !== null) coverUnedited(fields, sent.held, sent.input);
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
  /** The first mount's field state (revision 4): what it has held since it mounted, its schema, edits and coverage. */
  fields: FieldState;
  port: FormRecoveryPort;
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
    fields: options.fields,
    port: options.port,
    persisted: { own: null, ownAsked: false, source: null, owed: 0 },
    order: { next: 0, lastTerminal: 0 },
    acknowledged: null,
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
      // "Discard and reload anyway": the input the form holds is the person's to drop (retained input included); what it shows is covered.
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

/**
 * The mounted form's allow-list changed while it stays mounted (revision 3, R11; revision 4: the empty list included), at the commit that
 * changed it: a field no longer admitted keeps its value retained, a field admitted again takes it back where it is untouched.
 */
export function changeSchema(
  session: FormSession,
  allow: readonly RecoverableFieldSpec[],
): void {
  if (!elementOf(session)) return;
  setSchema(session.fields, allow);
}

/**
 * A mount shows the session (revision 4: with its own field state `mount`, read since it mounted, and its committed schema). A new session
 * was opened with that state; a session resumed takes it in (`adopt`): the session's input comes back into every field the person has not
 * typed into in this mount, a field they have typed into keeps what they typed (the session's value stays owed), and the input the session
 * holds for fields this mount does not show stays retained. A freeze in force holds the new element too. From now on the mount's input
 * events are edits of the session's fields.
 */
export function attach(
  session: FormSession,
  element: HTMLFormElement,
  ref: RefObject<HTMLFormElement | null>,
  mount: FieldState,
  show: (view: SessionView) => void,
): Attachment {
  const form = (): HTMLFormElement | null => ref.current ?? element;
  if (session.fields === mount) session.fields.form = form;
  else adopt(session.fields, mount, form);
  const stop = watch(session.fields, element);
  const attachment: Attachment = {
    token: ++tokens,
    element,
    ref,
    show,
    stop,
  };
  session.left = null;
  session.attached = attachment;
  list(session);
  holdAttached(session);
  return attachment;
}

/** The mount goes: what it shows is kept (memory only, in the field state), and the session stays registered while it is still needed. */
export function detach(session: FormSession, attachment: Attachment): void {
  if (session.attached?.token !== attachment.token) return;
  attachment.stop();
  const form = attachment.element;
  const fields = session.fields;
  fields.form = () => form;
  sync(fields);
  let sensitive = false;
  try {
    buildSnapshot({
      form,
      formContext: session.formContext,
      tabInstanceId: "",
      allow: fields.allow,
    });
  } catch {
    sensitive = true;
  }
  fields.form = () => null;
  releaseAttached(session);
  session.attached = null;
  session.left = { sensitive };
  // A look the mount was making is made again by the next mount.
  if (session.look === "running") session.look = "none";
  unlistIfIdle(session);
}
