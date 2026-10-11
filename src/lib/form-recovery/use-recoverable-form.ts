import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  allowOf,
  allResolved,
  applySnapshot,
  capturable,
  cover,
  coverUnedited,
  dropRetained,
  type FieldState,
  hasDebt,
  held,
  noteInput,
  openFields,
  refresh,
  sameHeld,
  setSchema,
  sync,
  type Values,
  watch,
} from "./fields";
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
  openSession,
  retireOtherScopes,
  type SessionView,
  type Submission,
  type SubmissionResult,
  schemaKey,
  setSessionView,
  submissionOf,
  terminalAct,
  track,
  UNSCOPED,
  valuesOf,
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
 * WHAT "DIRTY" MEANS (revision 1, R2; revision 5, R13). A form is dirty when a reload is not CERTAIN to bring back what it shows now: when
 * its values differ from this page's own latest durable copy, or, with no copy, from its clean state (what it showed at mount, or after a
 * submission or a discard). A form whose only copy is the one it was RESTORED from is dirty until this page has saved a copy of its own,
 * even unedited: another page may have restored the same copy and may discard it at any time (revision 5, R13), so it protects nobody. A
 * flush of a form whose values are back to the clean state discards its copies instead of saving one, so the next page shows that state.
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
 * A SUBMISSION ACKNOWLEDGES WHAT IT SENT (revision 3, R3, R10; revision 4). `submitting()` records, when it is called, the form's session,
 * input revision and everything the form holds: take the ticket in the same task as reading the values you send. Its success acts on THAT
 * session only (the hook may show another form context by then, or none) and only for what was sent: if the person has changed the form
 * since (even back to the same text, or to the text of an earlier successful submission), the change stays theirs, unfinished until saved
 * (`kept`), and an update reload saves it first. A successful submission covers exactly what it sent; only the form's initial values need no
 * copy without one. Completion is idempotent: a second `succeeded()` or `failed()` answers the first outcome and does nothing more. A ticket
 * taken before the form has a session (no database yet) is held by this mount and joins the session the mount binds to for the same form
 * context, never another; until then the update coordinator still waits for it. `onSubmitted()` acknowledges what the form holds at the
 * moment it is called: use it only in the same task as the send's success, with nothing typed in between (prefer `submitting`).
 *
 * THE MOUNTED ALLOW-LIST IS THE SCHEMA; A HIDDEN FIELD KEEPS ITS VALUE (revision 3, R11; revision 4; PRODUCT-DECISIONS-20261011 item 2).
 * Captures and restores admit the fields of the allow-list this mount COMMITTED (the empty list too; a mount with another list, or a list
 * changed while mounted, makes a transition at the commit, `fields.ts`). The hook keeps the latest value of every admitted field in memory,
 * read at each input event before your handlers run, so a field that leaves the page (a conditional field hidden, its admission removed in
 * the same render, or both) keeps what it held, and gets it back when it is shown again untouched; content typed into a field that is NOT
 * admitted is never read. Retained input that is not covered (not the field's initial value, nor sent by a successful submission and
 * unchanged since) cannot be written into a copy: the form stays dirty and an update reload stops with "could not save", offering retry
 * (after showing the field again) or "Discard and reload anyway" (Q4: never a silent loss). A successful submission of the form's visible
 * state covers its hidden values: no warning or block. Your code must change field values through the DOM with an input event (or before
 * the hook's form re-renders), never silently on a field it hides in the same commit.
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
  /** The mount's field state it was sent from, and its input revision then (revision 4). */
  readonly fields: FieldState | null;
  readonly input: number;
  /** Everything the mount held when it was sent. */
  readonly held: Values;
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
  // The allow-list as COMMITTED (revision 4, R11): set at the commit that renders it (a layout effect), never from a render that may not
  // commit. The schema key identifies it; the empty list is a list like any other.
  const schema = schemaKey(allow);
  const committed = useRef<readonly RecoverableFieldSpec[] | null>(null);
  // This mount's field state (revision 4): what it holds, field by field, since it mounted; the session's once it binds (a new session
  // takes it; a resumed one takes it in).
  const mountFields = useRef<FieldState | null>(null);
  const unwatch = useRef<(() => void) | null>(null);
  const session = useRef<FormSession | null>(null);
  const attachment = useRef<Attachment | null>(null);
  // The registration of this mount while it has no session yet (no port): dirty by the same rule as a session with no copy, and it cannot
  // be saved.
  const provisional = useRef<(() => void) | null>(null);
  // A mount that resumed its session owes it the look for copies other tabs left since; it is ready when that look has settled.
  const offerOwed = useRef(false);
  // Revision 3 (R3, R10): the tickets taken before the mount had a session.
  const provisionalTickets = useRef(new Set<Provisional>());
  // The form context this hook was last rendered with (revision 3, R10): a ticket never joins a session of another context.
  const contextNow = useRef(formContext);
  contextNow.current = formContext;
  // Revision 4 (R11): while the hook renders, the page still shows what the last commit left; the values of the fields followed are read
  // now, so a commit that removes a field changed without an input event does not take its value with it.
  const live = session.current?.fields ?? mountFields.current;
  if (live) refresh(live);

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

  // The schema transition (revision 3, R11; revision 4): at the commit that changes the list (a layout effect, before the page can take any
  // input or the coordinator any save), the empty list included, for the session the mount shows or, before it has one, its own fields.
  useLayoutEffect(() => {
    const now = allowOf(schema);
    committed.current = now;
    const current = session.current;
    if (current) changeSchema(current, now);
    else if (mountFields.current) setSchema(mountFields.current, now);
  }, [schema]);

  // The mount: registered at once (unbound until the port binds it to a session); at unmount the session keeps what it shows.
  useEffect(() => {
    const element = formRef.current;
    if (!element) return;
    const own = openFields(
      () => formRef.current ?? element,
      committed.current ?? [],
    );
    mountFields.current = own;
    unwatch.current = watch(own, element);
    const tickets = provisionalTickets.current;
    const handle: RecoverableFormHandle = {
      formContext,
      // No database yet, so no copy: dirty unless every value is resolved and nothing retained is owed (revision 4).
      isDirty: () => hasDebt(own) || !allResolved(own, capturable(own)),
      // No database yet: nothing can be saved, and nothing of this mount's was ever saved.
      flush: async (): Promise<SaveResult> => "failed",
      discard: async (): Promise<DiscardResult> => {
        cover(own, capturable(own), own.input);
        dropRetained(own);
        return "discarded";
      },
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
      unwatch.current?.();
      unwatch.current = null;
      sync(own);
      provisional.current?.();
      provisional.current = null;
      const current = session.current;
      const shown = attachment.current;
      session.current = null;
      attachment.current = null;
      if (current && shown) detach(current, shown);
      mountFields.current = null;
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
      // Revision 4 (design assessment Q8): an edit while the look runs, even one undone since, keeps the copy out of the form.
      const beganInput = current.fields.input;
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
        const fields = current.fields;
        const untouched =
          form !== null &&
          Object.entries(valuesOf(current)).every(
            ([name, value]) => value === (fields.initial[name] ?? ""),
          ) &&
          !hasDebt(fields) &&
          fields.input === beganInput &&
          current.order.next === began &&
          !current.registry.frozen();
        const newest = gone[0];
        if (newest && form && untouched) {
          applySnapshot(fields, form, newest);
          const values = valuesOf(current);
          if (newest.tabInstanceId === own)
            current.persisted = {
              ...current.persisted,
              own: { values, op: 0 },
              ownAsked: true,
            };
          else
            current.persisted = {
              ...current.persisted,
              source: { id: newest.tabInstanceId, values },
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
    const mount = mountFields.current;
    if (!element || !port || mount === null) return;
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
    // The mount's own follower stops: from now on the session's attachment follows the form's input (revision 4).
    unwatch.current?.();
    unwatch.current = null;
    const current =
      resumed ??
      openSession({
        formContext,
        scope,
        account: pinned?.account ?? UNSCOPED,
        registry,
        tab,
        fields: mount,
        port,
        // Another mount of the same form is showing the context's session: this one has a session of its own.
        keep: existing === undefined || existing.attached === null,
      });
    current.port = port;
    const shown = attach(current, element, formRef, mount, setViewState);
    session.current = current;
    owner.current = current;
    attachment.current = shown;
    // Tickets this mount took before it had a session join it, for this form context only (revision 3, R10), before the mount's own
    // registration goes, so the coordinator never stops waiting for them. Each keeps its place in the session's order (revision 5, R3): a
    // ticket of the field state the session took keeps its revision, one of the mount whose state the session took in has it translated
    // (`adopt`), so every one keeps its own revision and an edit made after it stays the person's. A ticket of any other state, or one whose
    // revision a submission the session acknowledged already reaches (its answer is not this ticket's), has none: it covers nothing.
    const acknowledged = current.acknowledged?.input ?? -1;
    for (const ticket of provisionalTickets.current) {
      if (ticket.sent !== null || ticket.formContext !== formContext) continue;
      const revision =
        ticket.fields === current.fields
          ? ticket.input
          : ticket.fields === mount
            ? shown.revisionOf(ticket.input)
            : null;
      ticket.sent = {
        session: current,
        input: revision !== null && revision > acknowledged ? revision : null,
        held: ticket.held,
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

  /**
   * The terminal act of the session (R4: in the session's order NOW), with its clean state becoming `clean(form)`, where `form` is what
   * shows the session now (this mount, a later mount of the same form, or none: what the last mount left counts).
   */
  const terminal = useCallback(
    (
      clean: (
        form: HTMLFormElement | null,
        fields: FieldState | null,
      ) => Values | null,
    ) => {
      const current = origin();
      if (!current) {
        // No session (no database yet): nothing was ever saved, so nothing can come back; the form's input is dropped and what it shows is
        // covered.
        const own = mountFields.current;
        const values = clean(formRef.current, own);
        if (own) {
          dropRetained(own);
          if (values) cover(own, values, own.input);
        }
        return Promise.resolve<DiscardResult>("discarded");
      }
      const result = terminalAct(
        current,
        clean(elementOf(current), current.fields),
      );
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
    // No session (no database yet): nothing was ever saved, so nothing can come back; what the form holds is covered.
    const own = mountFields.current;
    if (own) {
      own.shadowed = {};
      cover(own, held(own), own.input);
    }
    return "discarded";
  }, [origin, acknowledged]);

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
      const own = mountFields.current;
      provisional = {
        formContext: contextNow.current,
        fields: own,
        input: own?.input ?? 0,
        held: own ? held(own) : {},
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
          // Still no session: nothing was saved; what was sent is covered when the mount still holds exactly it, else only its fields not
          // edited since (revision 4, R3).
          const own = provisional?.fields ?? null;
          const unchanged =
            provisional !== null &&
            own !== null &&
            provisional.input === own.input &&
            sameHeld(own, held(own), provisional.held);
          if (own && provisional) {
            if (unchanged) {
              own.shadowed = {};
              cover(own, provisional.held, own.input);
            } else coverUnedited(own, provisional.held, provisional.input);
          }
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
  }, [registry, origin, acknowledged]);

  const discard = useCallback(async (): Promise<DiscardResult> => {
    // Refused while an update reload is prepared (R3): the form keeps what its last save captured.
    if (registry.frozen()) return "failed";
    return terminal((form, fields) => {
      if (!fields) return null;
      const before = { ...fields.initial };
      if (form) {
        restoreSnapshot(
          form,
          {
            formContext,
            tabInstanceId: "",
            values: before,
            savedAt: "",
          },
          fields.allow,
        );
        noteInput(fields);
        sync(fields);
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
      applySnapshot(current.fields, form, chosen);
      const values = valuesOf(current);
      // The copy restored before is still in the store (and newer): only a copy of this page's own makes the chosen one what comes back.
      current.persisted = {
        ...current.persisted,
        source: { id: chosen.tabInstanceId, values },
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
