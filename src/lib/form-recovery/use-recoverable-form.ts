import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { restoreSnapshot } from "./guard";
import type {
  DiscardResult,
  FormRecoveryPort,
  RecoverableFieldSpec,
  RecoverySnapshot,
  SaveResult,
} from "./port";
import {
  pageFormRegistry,
  type RecoverableFormHandle,
  type RecoverableFormRegistry,
} from "./registry";
import {
  type Attachment,
  acknowledge,
  attach,
  changeSchema,
  detach,
  elementOf,
  type FormSession,
  holdElement,
  noteInput,
  openSession,
  readValues,
  retireOtherScopes,
  type SessionView,
  type Submission,
  type SubmissionResult,
  sameIn,
  sameValues,
  schemaKey,
  setSessionView,
  submissionOf,
  terminalAct,
  track,
  UNSCOPED,
  type Values,
} from "./session";
import { getPageRecoveryTab, type RecoveryTab } from "./tab-identity";

/**
 * THE RECOVERABLE-FORM CONTRACT for feature slices (WEB-14a, D-P7; Q4). A form that may hold unfinished input when the app is updated:
 *
 *   const port = useFormRecoveryPort();            // from src/data: the displayed account's store, or null
 *   const recovery = useRecoverableForm({ formContext: `task-edit:${path}`, allow, formRef, port });
 *   ... {recovery.restored && <RecoveryBanner state={{ kind: "restored", onDiscard: recovery.discard, disabled: recovery.locked }} .../>}
 *   ... alternatives: <Button disabled={recovery.locked} ...> (revision 2: unavailable while this tab prepares an update reload)
 *   ... submitting:  const ticket = recovery.submitting(); if (!ticket) return;   // null: an update reload is being prepared; send nothing
 *                    send(values).then(() => ticket.succeeded(), () => ticket.failed());   // take the ticket in the same task as reading `values`
 *
 * While mounted the form is in the page's registry, so an accepted update saves its copy first (and another tab's accepted update asks
 * it to). On mount it restores the newest copy of the same form left by a tab that has GONE (one reload ago, or a closed tab), never
 * submitting anything; the others are offered as `alternatives`. After this page's own copy has been saved, the copy it was restored from
 * is discarded once; a submission or "Discard instead" discards both. Only allow-listed fields are captured, and never a sensitive one
 * (`guard.ts`). `formContext` names the form and the route it is on; the account is the port's (one database per account).
 *
 * WHAT "DIRTY" MEANS (revision 1, R2). A form is dirty when a reload would NOT bring back what it shows now: when its values differ from
 * the copy the next page would restore (this page's own latest durable copy, else the copy it was restored from, else nothing: what it showed
 * at mount). A flush of a form whose values are back to the CLEAN state (what it showed at mount, or after a submission or a discard)
 * discards its copies instead of saving one, so the next page shows that state.
 *
 * ONE SESSION PER FORM, WHATEVER MOUNTS IT (revision 2; R2, R4, DA-1, DA-2). The form's state, the order of its saves and discards, what
 * is durable and what is still outstanding belong to its SESSION in the page's registry (`session.ts`), bound to the account's database
 * the port reaches when the form first has one; a mount is only a view of it. A mount that goes (another page's boot remounts the
 * protected tree, F-1) leaves its input to the session (memory only), and the same form mounted again in this page for the same database
 * shows it again, with the session's restored copy and alternatives; a save the old mount asked for still lands in the session, and a
 * submission or discard in the new mount still overtakes it (it then writes nothing: R4). A look for copies whose answer comes after any
 * save, discard or submission of the session, or while an update reload is prepared, restores nothing (DA-1); the copies are offered.
 *
 * WHILE THIS TAB PREPARES AN UPDATE RELOAD (revision 2, R3). From "Save and reload" until the page reloads (or the reload is abandoned),
 * `locked` is true: the form is held still (`inert`), and `restoreAlternative`, `discard` and `submitting` refuse (they would change the
 * form after its last save). Controls outside the form must be disabled with `locked`. A submission SENT before (a `submitting` ticket
 * not yet settled) is waited for: its success discards the copies before the reload, so the submitted input never comes back. A caller
 * that only calls `onSubmitted()` after the fact cannot be waited for (use `submitting`).
 *
 * A DISCARD SAYS WHAT IT DID (revision 1, R6). `onSubmitted`, `discard` and the registry's `discard` answer `discarded` only when no copy of
 * the form can come back; otherwise the copies are still owed a discard, the form counts as dirty, and the next flush (an update's save) tries
 * again before anything reloads.
 *
 * A SUBMISSION ACKNOWLEDGES WHAT IT SENT (revision 3, R3, R10). `submitting()` records, when it is called, the form's session, input
 * revision, schema and values: take the ticket in the same task as reading the values you send. Its success acts on THAT session only (the
 * hook may show another form context by then, or none) and only for what was sent: if the person has changed the form since (even back to
 * the same text), the change stays theirs, dirty until saved (`kept`), and an update reload saves it first. Completion is idempotent: a
 * second `succeeded()` or `failed()` answers the first outcome and does nothing more. A ticket taken before the form has a session (no
 * database yet) is held by this mount and joins the session the mount binds to for the same form context, never another; until then the
 * update coordinator still waits for it. `onSubmitted()` acknowledges what the form holds at the moment it is called: use it only in the
 * same task as the send's success, with nothing typed in between (prefer `submitting`).
 *
 * THE MOUNTED ALLOW-LIST IS THE SCHEMA (revision 3, R11). Captures, carries and restores admit the fields of the allow-list this mount was
 * given (a mount with another list, or a changed list while mounted, makes a transition; `session.ts`). Content of a field the list no
 * longer admits is never captured and never silently dropped: the form stays dirty and its saves fail (an update reload stops with "could
 * not save" and offers "Discard and reload anyway") until the field is admitted again, the form is discarded, or the person submits and
 * then discards. Do not narrow an allow-list while a removed field may hold unfinished input; whether such content may be dropped is the
 * form owner's decision (design assessment D1).
 */
export interface UseRecoverableFormOptions {
  formContext: string;
  allow: readonly RecoverableFieldSpec[];
  formRef: RefObject<HTMLFormElement | null>;
  /** `useFormRecoveryPort()`: null while the displayed account has no open database (saving then fails honestly). */
  port: FormRecoveryPort | null;
  /** Tests only. */
  registry?: RecoverableFormRegistry;
  tab?: RecoveryTab;
}

/** A submission sent while the form is mounted (revision 2, R3): the update coordinator waits for it before a reload. */
export interface SubmissionTicket {
  /**
   * The submission succeeded (revision 3, R3): what it SENT is acknowledged in the session it was sent from. `discarded`: the form still
   * held exactly that, and no copy of it can come back; `kept`: the form was changed after the send, and the change stays (dirty until
   * saved); `failed`/`refused`: a copy of what was sent may still come back. A ticket already completed answers its first outcome again.
   */
  succeeded(): Promise<SubmissionResult>;
  /** It did not (or was not sent): the form keeps its input and its copies. Nothing more happens after the first completion. */
  failed(): void;
}

export interface RecoverableForm {
  /** The copy restored at mount (or chosen from the alternatives), or null. */
  restored: RecoverySnapshot | null;
  /** Other restorable copies of this form, newest first. */
  alternatives: readonly RecoverySnapshot[];
  /** Puts another copy in the form. Refused (nothing changes) while `locked`. */
  restoreAlternative(tabInstanceId: string): void;
  /** Whether the look for a copy to restore has finished. */
  ready: boolean;
  /** Revision 2 (R3): this tab is preparing an update reload; the recovery actions are unavailable (disable their controls). */
  locked: boolean;
  /** Before sending a submission (revision 2, R3); null while `locked`: send nothing then. */
  submitting(): SubmissionTicket | null;
  /**
   * The form was submitted with what it holds NOW: its copies are discarded. `failed`/`refused`: a copy may still come back after a reload.
   * Only in the same task as the send's success (revision 3): `submitting` is the contract for a send that takes time.
   */
  onSubmitted(): Promise<SubmissionResult>;
  /** "Discard instead": the copies are discarded and the form shows what it showed before the restore. `failed` (nothing done) while `locked`. */
  discard(): Promise<DiscardResult>;
}

const NO_VIEW: SessionView = { restored: null, alternatives: [] };

/** A ticket taken while the mount had no session (revision 3, R10): held by the mount until the mount binds a session of its context. */
interface Provisional {
  readonly formContext: string;
  /** The mount's input count when it was sent. */
  readonly input: number;
  readonly schema: string;
  readonly values: Values;
  readonly outstanding: Promise<void>;
  /** The submission in the session it joined, once it joined one. */
  sent: Submission | null;
}

export function useRecoverableForm(
  options: UseRecoverableFormOptions,
): RecoverableForm {
  const { formContext, allow, formRef, port } = options;
  // The allow-list is read through `fields`, so a caller that builds it afresh on every render does not restart anything.
  const registry = options.registry ?? pageFormRegistry;
  const tab = options.tab ?? getPageRecoveryTab();
  const [view, setViewState] = useState<SessionView>(NO_VIEW);
  const [ready, setReady] = useState(false);
  const locked = useSyncExternalStore(
    registry.subscribe,
    registry.frozen,
    registry.frozen,
  );
  const fields = useRef<readonly RecoverableFieldSpec[]>(allow);
  fields.current = allow;
  // What this mount showed when it mounted (before any restore).
  const mountValues = useRef<Values | null>(null);
  const session = useRef<FormSession | null>(null);
  const attachment = useRef<Attachment | null>(null);
  // The registration of this mount while it has no session yet (no port): what it shows is dirty if it differs from `unboundClean` (the
  // mount values, or what it showed at a submission or discard), and it cannot be saved.
  const provisional = useRef<(() => void) | null>(null);
  // A mount that resumed its session owes it the look for copies other tabs left since; it is ready when that look has settled.
  const offerOwed = useRef(false);
  const unboundClean = useRef<Values | null>(null);
  // Revision 3 (R3, R10): how many times the person changed this mount's input before it had a session, and the tickets taken meanwhile.
  const unboundInput = useRef(0);
  const provisionalTickets = useRef(new Set<Provisional>());
  // The form context this hook was last rendered with (revision 3, R10): a ticket never joins a session of another context.
  const contextNow = useRef(formContext);
  contextNow.current = formContext;

  // The session the mount was last bound to, kept after it unmounts: a submission sent from it still belongs to that session (R3, R4).
  const owner = useRef<FormSession | null>(null);
  /** The session the form shows now (revision 3, R10): the bound one, else the one it was last bound to if that is still this form context's. */
  const origin = useCallback((): FormSession | null => {
    if (session.current) return session.current;
    const last = owner.current;
    return last && last.formContext === contextNow.current ? last : null;
  }, []);

  const setView = useCallback((next: SessionView) => {
    const current = session.current;
    if (current) setSessionView(current, next);
    else setViewState(next);
  }, []);

  // The mount: registered at once (unbound until the port binds it to a session); at unmount the session keeps what it shows.
  useEffect(() => {
    const element = formRef.current;
    if (!element) return;
    mountValues.current = readValues(element, fields.current);
    unboundClean.current = mountValues.current;
    const tickets = provisionalTickets.current;
    const counted = (): void => {
      unboundInput.current += 1;
    };
    for (const type of ["input", "change", "reset"])
      element.addEventListener(type, counted, true);
    const handle: RecoverableFormHandle = {
      formContext,
      isDirty: () =>
        !sameValues(
          readValues(element, fields.current),
          unboundClean.current ?? {},
        ),
      // No database yet: nothing can be saved, and nothing of this mount's was ever saved.
      flush: async (): Promise<SaveResult> => "failed",
      discard: async (): Promise<DiscardResult> => "discarded",
      freeze: () => holdElement(element),
      // A submission sent before the form had a session is waited for too (revision 3, R10).
      settled: () => {
        const waiting = [...tickets].filter((ticket) => ticket.sent === null);
        return waiting.length === 0
          ? null
          : Promise.allSettled(
              waiting.map((ticket) => ticket.outstanding),
            ).then(() => undefined);
      },
    };
    const unregister = registry.register(handle);
    let registered = true;
    provisional.current = () => {
      if (!registered) return;
      registered = false;
      unregister();
    };
    return () => {
      for (const type of ["input", "change", "reset"])
        element.removeEventListener(type, counted, true);
      provisional.current?.();
      provisional.current = null;
      const current = session.current;
      const shown = attachment.current;
      session.current = null;
      attachment.current = null;
      if (current && shown) detach(current, shown);
      mountValues.current = null;
    };
  }, [registry, formContext, formRef]);

  /**
   * The look, made by `shown` through `through`. Its answer is applied only to this mount, only if nothing of the session has happened since
   * it began (a save, a discard, a submission: DA-1), only if the person has not typed meanwhile, and not while an update reload is
   * prepared (R3): otherwise every copy is offered instead, and the form is not touched. `offer` (a mount resuming its session, which
   * already shows its input): the copies other tabs left since are offered, nothing is restored. Returns the cancellation.
   */
  const look = useCallback(
    (
      current: FormSession,
      shown: Attachment,
      through: FormRecoveryPort,
      mode: "restore" | "offer" = "restore",
    ): (() => void) => {
      if (mode === "restore") current.look = "running";
      const began = current.order.next;
      let cancelled = false;
      let finished = false;
      void (async () => {
        const listed = await through.list(current.formContext);
        // What may be restored: THIS page's own copy first (the form was mounted again in the same page after its session ended), then the
        // copies of tabs that have gone, newest first. Another OPEN tab's copy is never taken over.
        const own = current.tab.current();
        const gone: RecoverySnapshot[] = listed.filter(
          (copy) => copy.tabInstanceId === own,
        );
        for (const copy of listed)
          if (
            copy.tabInstanceId !== own &&
            !(await current.tab.ownerOpen(copy.tabInstanceId))
          )
            gone.push(copy);
        if (cancelled) return;
        finished = true;
        if (current.attached?.token !== shown.token) return;
        if (mode === "offer") {
          offerOwed.current = false;
          const showing = current.view.restored?.tabInstanceId;
          setView({
            restored: current.view.restored,
            alternatives: gone.filter(
              (copy) =>
                copy.tabInstanceId !== own && copy.tabInstanceId !== showing,
            ),
          });
          setReady(true);
          return;
        }
        current.look = "done";
        const form = elementOf(current);
        const untouched =
          form !== null &&
          sameIn(
            readValues(form, current.allow),
            current.initial,
            current.initial,
          ) &&
          current.order.next === began &&
          !current.registry.frozen();
        const newest = gone[0];
        if (newest && form && untouched) {
          restoreSnapshot(form, newest, current.allow);
          noteInput(current);
          const values = readValues(form, current.allow);
          if (newest.tabInstanceId === own)
            current.persisted = {
              ...current.persisted,
              own: { values, op: 0 },
              ownAsked: true,
            };
          else
            current.persisted = {
              ...current.persisted,
              source: { id: newest.tabInstanceId, values, newest: true },
            };
          setView({ restored: newest, alternatives: gone.slice(1) });
        } else if (gone.length > 0)
          setView({ restored: current.view.restored, alternatives: gone });
        setReady(true);
      })().catch(() => {
        if (cancelled) return;
        finished = true;
        if (mode === "offer") offerOwed.current = false;
        else if (current.attached?.token === shown.token) current.look = "done";
        setReady(true);
      });
      return () => {
        cancelled = true;
        // Only a look that did not finish is made again (React replays effects in development; a new port asks again).
        if (!finished && mode === "restore" && current.look === "running")
          current.look = "none";
      };
    },
    [setView],
  );

  // The binding: the first time the form and the port are both there, the mount shows its session (the one this page already has for
  // this form and database, or a new one), and a session that has not looked for copies to restore looks once.
  useEffect(() => {
    const element = formRef.current;
    const initial = mountValues.current;
    if (!element || !port || initial === null) return;
    const pinned = port.pin?.() ?? null;
    const bound = session.current;
    const shownBefore = attachment.current;
    if (bound && shownBefore) {
      // Never bound again to another scope (DA-2); a new port for the same database is used from now on.
      if (port.pin && pinned?.scope !== bound.scope) return;
      bound.port = port;
      // A resumed mount whose look for new copies was cancelled (a new port) makes it again: it is not ready until it has.
      if (offerOwed.current && bound.look === "done")
        return look(bound, shownBefore, port, "offer");
      return bound.look === "none" ? look(bound, shownBefore, port) : undefined;
    }
    if (port.pin && pinned === null) return;
    const scope = pinned?.scope ?? UNSCOPED;
    retireOtherScopes(registry, scope);
    const existing = registry.session(formContext) as FormSession | undefined;
    const resumed =
      existing !== undefined &&
      existing.scope === scope &&
      existing.attached === null
        ? existing
        : null;
    const current =
      resumed ??
      openSession({
        formContext,
        scope,
        account: pinned?.account ?? UNSCOPED,
        registry,
        tab,
        allow: fields.current,
        port,
        initial,
        // Another mount of the same form is showing the context's session: this one has a session of its own.
        keep: existing === undefined || existing.attached === null,
      });
    current.port = port;
    const shown = attach(
      current,
      element,
      formRef,
      initial,
      setViewState,
      fields.current,
    );
    session.current = current;
    owner.current = current;
    attachment.current = shown;
    // Tickets this mount took before it had a session join it, for this form context only (revision 3, R10), before the mount's own
    // registration goes, so the coordinator never stops waiting for them. Input changed since the send makes their revision unknown.
    for (const ticket of provisionalTickets.current) {
      if (ticket.sent !== null || ticket.formContext !== formContext) continue;
      ticket.sent = {
        session: current,
        input: ticket.input === unboundInput.current ? current.input : null,
        schema: ticket.schema === current.schema ? current.schema : "",
        values: ticket.values,
      };
      track(current, ticket.outstanding);
    }
    provisional.current?.();
    provisional.current = null;
    if (current.look === "done") {
      // Resumed: the session's input and view are shown at once; the mount is ready once the copies other tabs left since are known.
      setView(current.view);
      offerOwed.current = true;
      return look(current, shown, port, "offer");
    }
    return look(current, shown, port);
  }, [port, formContext, formRef, tab, registry, setView, look]);

  // The allow-list changed while the form stays mounted (revision 3, R11): the session makes the same transition as a mount with it.
  const schema = schemaKey(allow);
  useEffect(() => {
    const current = session.current;
    if (current && schema) changeSchema(current, fields.current);
  }, [schema]);

  /**
   * The terminal act of the session (R4: in the session's order NOW), with its clean state becoming `clean(form)`, where `form` is what
   * shows the session now (this mount, a later mount of the same form, or none: what the last mount left counts).
   */
  const terminal = useCallback(
    (
      clean: (
        form: HTMLFormElement | null,
        current: FormSession | null,
      ) => Values | null,
    ) => {
      const current = origin();
      if (!current) {
        // No session (no database yet): nothing was ever saved, so nothing can come back.
        unboundClean.current =
          clean(formRef.current, null) ?? unboundClean.current;
        return Promise.resolve<DiscardResult>("discarded");
      }
      const result = terminalAct(current, clean(elementOf(current), current));
      setSessionView(current, { ...current.view, restored: null });
      return result;
    },
    [formRef, origin],
  );

  /** Acknowledges a submission in the session it was sent from (revision 3, R3, R10); its restored banner goes when nothing changed since. */
  const acknowledged = useCallback(
    (sent: Submission): Promise<SubmissionResult> => {
      const current = sent.session;
      const before = current.order.lastTerminal;
      const result = acknowledge(sent);
      if (current.order.lastTerminal !== before)
        setSessionView(current, { ...current.view, restored: null });
      return result;
    },
    [],
  );

  const onSubmitted = useCallback(async (): Promise<SubmissionResult> => {
    const current = origin();
    if (current) return acknowledged(submissionOf(current));
    // No session (no database yet): nothing was ever saved, so nothing can come back; what the form shows is its clean state.
    const form = formRef.current;
    if (form) unboundClean.current = readValues(form, fields.current);
    return "discarded";
  }, [origin, acknowledged, formRef]);

  const submitting = useCallback((): SubmissionTicket | null => {
    if (registry.frozen()) return null;
    let settle: () => void = () => undefined;
    const outstanding = new Promise<void>((resolve) => {
      settle = resolve;
    });
    // What is sent, fixed NOW (revision 3, R3, R10): the session the form shows, its revision, schema and values.
    const current = origin();
    let provisional: Provisional | null = null;
    let sent: Submission | null = null;
    if (current) {
      sent = submissionOf(current);
      track(current, outstanding);
    } else {
      const form = formRef.current;
      provisional = {
        formContext: contextNow.current,
        input: unboundInput.current,
        schema: schemaKey(fields.current),
        values: form ? readValues(form, fields.current) : {},
        outstanding,
        sent: null,
      };
      provisionalTickets.current.add(provisional);
    }
    let outcome: Promise<SubmissionResult> | null = null;
    const done = (): void => {
      if (provisional) provisionalTickets.current.delete(provisional);
      settle();
    };
    return {
      succeeded() {
        if (outcome) return outcome;
        const joined = sent ?? provisional?.sent ?? null;
        if (joined) outcome = acknowledged(joined);
        else {
          // Still no session: nothing was saved; what was sent is the clean state when the form still holds it.
          const form = formRef.current;
          const unchanged =
            provisional !== null &&
            provisional.input === unboundInput.current &&
            form !== null &&
            sameValues(readValues(form, fields.current), provisional.values);
          if (unchanged && provisional)
            unboundClean.current = provisional.values;
          outcome = Promise.resolve<SubmissionResult>(
            unchanged ? "discarded" : "kept",
          );
        }
        // The acknowledgement is outstanding before the ticket is released, so nothing is ever waiting for neither.
        done();
        return outcome;
      },
      failed() {
        if (outcome) return;
        outcome = Promise.resolve<SubmissionResult>("failed");
        done();
      },
    };
  }, [registry, origin, acknowledged, formRef]);

  const discard = useCallback(async (): Promise<DiscardResult> => {
    // Refused while an update reload is prepared (R3): the form keeps what its last save captured.
    if (registry.frozen()) return "failed";
    return terminal((form, current) => {
      const before = current?.initial ?? mountValues.current;
      if (form && before) {
        restoreSnapshot(
          form,
          {
            formContext,
            tabInstanceId: "",
            values: before,
            savedAt: "",
          },
          current?.allow ?? fields.current,
        );
        if (current) noteInput(current);
      }
      return before;
    });
  }, [registry, terminal, formContext]);

  const restoreAlternative = useCallback(
    (tabInstanceId: string) => {
      // Refused while an update reload is prepared (R3): it would change the form after its last save.
      if (registry.frozen()) return;
      const current = session.current;
      const form = current ? elementOf(current) : null;
      const chosen = view.alternatives.find(
        (copy) => copy.tabInstanceId === tabInstanceId,
      );
      if (!current || !form || !chosen) return;
      restoreSnapshot(form, chosen, current.allow);
      noteInput(current);
      const values = readValues(form, current.allow);
      // The copy restored before is still in the store (and newer): only a copy of this page's own makes the chosen one what comes back.
      current.persisted = {
        ...current.persisted,
        source: { id: chosen.tabInstanceId, values, newest: false },
      };
      setView({
        restored: chosen,
        alternatives: [
          ...(view.restored ? [view.restored] : []),
          ...view.alternatives.filter(
            (copy) => copy.tabInstanceId !== tabInstanceId,
          ),
        ],
      });
    },
    [registry, view, setView],
  );

  return {
    restored: view.restored,
    alternatives: view.alternatives,
    restoreAlternative,
    ready,
    locked,
    submitting,
    onSubmitted,
    discard,
  };
}
