import { unreadable } from "./control-state";
import { decode, encodeText, internalOf, OPAQUE } from "./controls";
import {
  allResolved,
  capturable,
  cover,
  coverUnedited,
  type FieldState,
  held,
  noteInput,
  openFields,
  sameHeld,
  shownOf,
} from "./fields";
import { HANDOFF_PREFIX, type HandoffStore, pageHandoffs } from "./handoff";
import { adoptCopy, chooseLeft, isHandoff, readLeft } from "./look";
import {
  type DiscardResult,
  type FormRecoveryPort,
  type RecoverySnapshot,
  readCopy,
  type SaveResult,
} from "./port";
import {
  pageFormRegistry,
  type RecoverableFormHandle,
  type RecoverableFormRegistry,
} from "./registry";
import {
  acknowledge,
  type FormSession,
  list,
  openSession,
  retire,
  retireOtherScopes,
  type SubmissionResult,
  targetOf,
  terminalAct,
  track,
  UNSCOPED,
  unlistIfIdle,
} from "./session";
import { getPageRecoveryTab, type RecoveryTab } from "./tab-identity";

/**
 * A RECOVERABLE MODEL (WEB-14a revision 37; review of 25 October 2026, R40; design assessment C1-C4, I1-I9). The recoverable-form contract
 * (`useRecoverableForm`) reads a FORM ELEMENT: its named fields, as the browser shows them. The product's editors are not such forms: their
 * input is a model in the feature's own owner (the task form's kept-input session, a sharing editor's draft), shown through controlled
 * inputs that React writes back from that model, with values no control shows (a stage chosen, the values a locked choice is judged
 * against, a hidden interval). So they never reached the update: the registry had no form, the banner offered a plain Reload, the
 * coordinator found the page sealed, and the reload took the unfinished task with it.
 *
 * A model is the SAME form session (`session.ts`), with one admitted field whose value the OWNER gives, as one text (the feature's
 * explicitly versioned codec of its raw, non-secret input), instead of a DOM element whose value the session reads:
 *
 *  - ONE AUTHORITY FOR THE INPUT. The owner keeps the input; every change of it (an edit, a stage chosen, a restore) reaches the model in the
 *    same step (`edit`), which moves the session's input revision. A capture is a copy of that text, fixed when it is asked for. Saves,
 *    hand-offs, discards, submission acknowledgement, terminal acts, ordering, account pinning, copy lineage and clean-up debts are the
 *    session's own (nothing here writes to the port except through them).
 *  - LISTED WHILE IT MATTERS. Like a mounted form, a model is listed in the page's registry while an editor shows it (`show`), and while it
 *    is dirty, owes a discard or has work outstanding, whether or not any editor shows it (a retained editor of a visit to the sync screens
 *    still saves before an update). Before the displayed account's database is open, a PROVISIONAL handle stands in for it: dirty by the same
 *    rule, and its save fails (an update stops with retry or an explicit discard: a missing store is never taken for a saved copy).
 *  - FROZEN MEANS NO INPUT. While an update reload is prepared (`registry.frozen()`), `edit`, `submitting`, `discard` and the recovery
 *    actions refuse: a controlled editor's model does not change, so neither does what it shows (React puts the text back). The owner must
 *    send every change of the input through `edit` and honour a refusal.
 *  - RESTORED, NEVER SUBMITTED. The look for what was left to the form (`look.ts`: the hand-off left to this page under its lock, the copies of
 *    tabs that have gone, abandoned hand-offs) is made once the model is bound; the newest copy is given to the owner (`restore`) only while
 *    the owner's input is untouched and nothing happened in the session since the look began, and only if the owner can read it (its codec
 *    refuses a copy of another version: offered, never restored in part, never removed). Everything else is offered (`alternatives`). A look
 *    that could not read the store makes the model `unavailable` (an update's save does not reload the page until a look has read it).
 *
 * Memory only: nothing here is written anywhere except through the port.
 */

const MODEL = "model";
/** The model field's identity in the field state's presence (no element shows it; nothing ever reads one from a page). */
const MODEL_KEY = Object.freeze({}) as unknown as Element;

/** What a model's editor shows besides its input. */
export interface ModelView {
  restored: RecoverySnapshot | null;
  alternatives: readonly RecoverySnapshot[];
  /** The look could not read the store: what was left to the form is not known. */
  unavailable: boolean;
  /** The look has read the store (or there is nothing to look in yet). */
  ready: boolean;
}

/** A submission of the model's input (as `useRecoverableForm().submitting`): take it in the same step as reading the input you send. */
export interface ModelTicket {
  succeeded(): Promise<SubmissionResult>;
  failed(): void;
}

export type ModelAlternativeResult =
  | "restored"
  | "gone"
  | "unavailable"
  | "refused";

/** What an editor shows of its model's recovery (`RecoveryNotice`), and its actions. */
export interface RecoveryControls {
  view: ModelView;
  /** An update reload is being prepared: input, saves and the recovery actions are unavailable (disable their controls). */
  locked: boolean;
  /** "Discard instead": the copies are discarded and the editor shows where it starts from. */
  discard(): Promise<DiscardResult>;
  retry(): Promise<boolean>;
  restoreAlternative(copy: RecoverySnapshot): Promise<ModelAlternativeResult>;
  discardAlternative(copy: RecoverySnapshot): Promise<DiscardResult>;
}

export interface ModelOptions {
  /** The form context: stable for the editor and its target, never `HANDOFF_PREFIX`. The account is the port's. */
  formContext: string;
  /** The text the editor starts from (what the next page shows without a copy). "" when opening the editor at all is input. */
  start: string;
  /**
   * The owner takes a restored copy's text (the copy chosen, or the newest left to it). False: it cannot (its input is no longer untouched,
   * or its codec cannot read that text): nothing changes, and the copy is offered. Called while the look applies its answer: it must only
   * take the text into the owner's input (never call back into the model).
   */
  restore(text: string): boolean;
  /** The owner's input is untouched (nothing typed, chosen or submitted since it opened): a copy left to it may be restored into it. */
  untouched(): boolean;
  /**
   * The editor shows input the model cannot hold: a native editing state with no value (a date or time field partly typed,
   * `validity.badInput`). While it does the model is unfinished: dirty, and its saves fail (an update reload stops with retry or an
   * explicit discard), never a copy of the last value as if the field held it. Set by the editor shown (`probe`).
   */
  /** Tests only. */
  registry?: RecoverableFormRegistry;
  tab?: RecoveryTab;
  handoffs?: HandoffStore;
}

export interface RecoverableModel {
  readonly formContext: string;
  /** The page shows the account's store through `port` (null: none open yet). The first port binds the model; a later one of the same scope is used from then on. */
  bind(port: FormRecoveryPort | null): void;
  /** An editor shows the model; returns its release. */
  show(): () => void;
  /**
   * The editor shown asks this when the model is read: whether it shows a native editing state the model cannot hold (a date or time field
   * partly typed: `validity.badInput`). Unfinished input is dirty and cannot be saved (the update stops with retry or an explicit discard);
   * it is never taken for the model's last value. Null: no editor shows one (what it showed stays as it was last read).
   */
  probe(unfinished: (() => boolean) | null): void;
  /** The owner starts a new editing session from `text` (`opened`: opening the editor is itself input, a stage chosen). */
  begin(text: string, opened?: boolean): void;
  /** The person changed the input to `text`. False while an update reload is prepared: the owner must not take the change. */
  edit(text: string): boolean;
  /** An update reload is being prepared: the recovery actions are unavailable (disable their controls). */
  frozen(): boolean;
  /** Before sending a submission; null while an update reload is prepared (send nothing). */
  submitting(): ModelTicket | null;
  /** "Discard instead" (or Cancel): the copies are discarded and the input becomes `text` (what the editor shows after it). */
  discard(text: string): Promise<DiscardResult>;
  /** The owner's session ended without a submission (a departure drops it): its copies are discarded, as an explicit discard. */
  end(): Promise<DiscardResult>;
  /** The owner forgets the input for good (another identity): the model leaves the page's registry, its copies stay in their store. */
  retire(): void;
  /** Revision 7 (R13): makes a look that could not read the store again; true once it has. */
  retry(): Promise<boolean>;
  restoreAlternative(tabInstanceId: string): Promise<ModelAlternativeResult>;
  discardAlternative(tabInstanceId: string): Promise<DiscardResult>;
  view(): ModelView;
  subscribe(listener: () => void): () => void;
}

/** The model's text as the field state holds it, and back (`decode` of a stored copy's text: never anything but a text). */
const fieldText = (text: string): string => encodeText(text);
const textOf = (encoded: string | undefined): string | null => {
  if (encoded === undefined) return null;
  const decoded = decode(encoded);
  return decoded.kind === "text" ? decoded.text : null;
};

function modelFields(start: string): FieldState {
  const fields = openFields(() => null, [{ name: MODEL }]);
  fields.present.set(MODEL, MODEL_KEY);
  fields.ledger[MODEL] = fieldText(start);
  fields.initial[MODEL] = fieldText(start);
  return fields;
}

/** A ticket taken before the model had a session: its revision is in the same field state the session will have. */
interface Provisional {
  readonly input: number;
  readonly held: Record<string, string>;
  readonly outstanding: Promise<void>;
  done: boolean;
}

export function createRecoverableModel(
  options: ModelOptions,
): RecoverableModel {
  const { formContext } = options;
  if (formContext.startsWith(HANDOFF_PREFIX))
    throw new Error(`"${HANDOFF_PREFIX}" is reserved for update hand-offs`);
  const registry = options.registry ?? pageFormRegistry;
  const tab = options.tab ?? getPageRecoveryTab();
  const handoffs = options.handoffs ?? pageHandoffs;
  const fields = modelFields(options.start);
  /** The owner's input as last given (an edit, a start, a restore): what the field holds while the editor shows no native editing state. */
  let text = options.start;
  let unfinished: (() => boolean) | null = null;
  /** Revision 37 (R40): the field holds the editor's native editing state (`OPAQUE`: never captured, an obligation) or the owner's text. */
  const refresh = (): void => {
    let opaque = fields.ledger[MODEL] === OPAQUE;
    if (unfinished) {
      try {
        opaque = unfinished();
      } catch {
        opaque = true;
      }
    }
    const want = opaque ? OPAQUE : fieldText(text);
    if (fields.ledger[MODEL] === want) return;
    fields.ledger[MODEL] = want;
    noteInput(fields, [MODEL]);
  };
  const take = (next: string): void => {
    text = next;
    fields.ledger[MODEL] = fieldText(next);
  };
  let session: FormSession | null = null;
  let presence = 0;
  let retired = false;
  let view: ModelView = {
    restored: null,
    alternatives: [],
    unavailable: false,
    ready: false,
  };
  const listeners = new Set<() => void>();
  const setView = (next: Partial<ModelView>): void => {
    view = { ...view, ...next };
    for (const listener of [...listeners]) listener();
  };
  const tickets = new Set<Provisional>();

  // ---- before the account's store is open: a provisional handle (dirty by the same rule; its save fails) ----------------------------
  let unregister: (() => void) | null = null;
  const provisional: RecoverableFormHandle = {
    formContext,
    isDirty: () => !allResolved(fields, capturable(fields)),
    flush: async (): Promise<SaveResult> => "failed",
    discard: async (): Promise<DiscardResult> => {
      cover(fields, shownOf(fields), fields.input);
      return "discarded";
    },
    // The model refuses every change while frozen (`edit`): it is held whatever shows it.
    freeze: () => Object.assign(() => undefined, { holds: () => true }),
    settled: () => {
      const waiting = [...tickets].filter((ticket) => !ticket.done);
      return waiting.length === 0
        ? null
        : Promise.allSettled(waiting.map((ticket) => ticket.outstanding)).then(
            () => undefined,
          );
    },
  };
  const provisionalNeeded = (): boolean =>
    !retired &&
    session === null &&
    (presence > 0 ||
      provisional.isDirty() ||
      [...tickets].some((ticket) => !ticket.done));
  const relist = (): void => {
    if (session) {
      if (!session.retired) {
        list(session);
        unlistIfIdle(session);
      }
      return;
    }
    if (provisionalNeeded()) {
      unregister ??= registry.register(provisional);
    } else if (unregister) {
      const go = unregister;
      unregister = null;
      go();
    }
  };

  // ---- the look -------------------------------------------------------------------------------------------------------------------
  let running: { cancel(): void } | null = null;
  const look = (
    current: FormSession,
    mode: "restore" | "offer",
  ): Promise<boolean> => {
    running?.cancel();
    if (mode === "restore") current.look = "running";
    const began = current.order.next;
    const beganInput = fields.input;
    const reader = targetOf(current);
    let cancelled = false;
    let finished = false;
    const done = (async (): Promise<boolean> => {
      const found = reader
        ? await readLeft(current, reader, mode).catch(() => null)
        : null;
      if (cancelled || current.retired) return false;
      finished = true;
      if (found === null || targetOf(current) === null) {
        if (mode === "restore") current.look = "none";
        current.recovery = "unavailable";
        current.relook = () => retry();
        setView({ unavailable: true, ready: false });
        return false;
      }
      current.recovery = "ok";
      current.relook = null;
      if (found.handed) current.claimed = found.handed.tabInstanceId;
      const { candidates, lineage, offered } = chooseLeft(current, found);
      if (mode === "offer") {
        const showing = view.restored?.tabInstanceId;
        setView({
          unavailable: false,
          ready: true,
          alternatives: offered(null).filter(
            (copy) =>
              copy.tabInstanceId !== found.own &&
              copy.tabInstanceId !== showing,
          ),
        });
        return true;
      }
      current.look = "done";
      const newest = candidates[0];
      const untouched =
        fields.input === beganInput &&
        current.order.next === began &&
        !registry.frozen() &&
        options.untouched();
      const copied =
        newest && !unreadable(newest)
          ? textOf(internalOf(newest)[MODEL])
          : null;
      if (newest && copied !== null && untouched && options.restore(copied)) {
        const values = internalOf(newest);
        take(copied);
        noteInput(fields, [MODEL]);
        adoptCopy(current, newest, values, found, lineage);
        relist();
        setView({
          unavailable: false,
          ready: true,
          restored: newest,
          alternatives: offered(newest),
        });
      } else
        setView({
          unavailable: false,
          ready: true,
          alternatives: offered(null),
        });
      return true;
    })();
    track(current, done);
    running = {
      cancel: () => {
        cancelled = true;
        if (!finished && mode === "restore" && current.look === "running")
          current.look = "none";
      },
    };
    return done;
  };
  const retry = (): Promise<boolean> => {
    const current = session;
    if (!current || current.retired) return Promise.resolve(false);
    if (current.recovery !== "unavailable") return Promise.resolve(true);
    setView({ unavailable: false });
    return look(current, current.look === "done" ? "offer" : "restore");
  };

  const model: RecoverableModel = {
    formContext,
    bind(port) {
      if (retired || !port) return;
      const pinned = port.pin?.() ?? null;
      if (session) {
        // Never bound again to another scope (DA-2); a new port for the same database is used from now on.
        if (port.pin && pinned?.scope !== session.scope) return;
        session.port = port;
        return;
      }
      if (port.pin && pinned === null) return;
      const scope = pinned?.scope ?? UNSCOPED;
      retireOtherScopes(registry, scope);
      const existing = registry.session(formContext) as FormSession | undefined;
      session = openSession({
        formContext,
        scope,
        account: pinned?.account ?? UNSCOPED,
        registry,
        tab,
        handoffs,
        fields,
        port,
        keep:
          existing === undefined ||
          (existing.attached === null && existing.present === 0),
        refresh,
      });
      session.present = presence;
      // Tickets taken before the model had a session are waited for by it (their revisions are this field state's).
      for (const ticket of tickets)
        if (!ticket.done) track(session, ticket.outstanding);
      if (unregister) {
        const go = unregister;
        unregister = null;
        go();
      }
      relist();
      void look(session, "restore");
    },
    show() {
      presence += 1;
      if (session) {
        session.present = presence;
        relist();
      } else relist();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        presence -= 1;
        if (session) {
          session.present = presence;
          unlistIfIdle(session);
        } else relist();
      };
    },
    probe(next) {
      unfinished = next;
      refresh();
      relist();
    },
    begin(next, opened = false) {
      fields.initial[MODEL] = opened ? fieldText("") : fieldText(next);
      take(next);
      // A new session is a new edit (an older submission's ticket never covers it); its start needs no copy unless opening is input.
      noteInput(fields, [MODEL]);
      setView({ restored: null });
      relist();
    },
    edit(next) {
      if (registry.frozen() || retired) return false;
      take(next);
      noteInput(fields, [MODEL]);
      refresh();
      relist();
      return true;
    },
    frozen: () => registry.frozen(),
    submitting() {
      if (registry.frozen()) return null;
      let settle: () => void = () => undefined;
      const outstanding = new Promise<void>((resolve) => {
        settle = resolve;
      });
      const ticket: Provisional = {
        input: fields.input,
        held: held(fields),
        outstanding,
        done: false,
      };
      tickets.add(ticket);
      if (session) track(session, outstanding);
      else relist();
      let outcome: Promise<SubmissionResult> | null = null;
      const finish = (): void => {
        ticket.done = true;
        tickets.delete(ticket);
        settle();
        if (!session) relist();
      };
      return {
        succeeded() {
          if (outcome) return outcome;
          const current = session;
          if (current) {
            const before = current.order.lastTerminal;
            outcome = acknowledge({
              session: current,
              input: ticket.input,
              held: ticket.held,
            });
            if (current.order.lastTerminal !== before)
              setView({ restored: null });
          } else {
            const unchanged =
              ticket.input === fields.input &&
              sameHeld(fields, held(fields), ticket.held);
            if (unchanged) cover(fields, ticket.held, fields.input);
            else coverUnedited(fields, ticket.held, ticket.input);
            outcome = Promise.resolve<SubmissionResult>(
              unchanged ? "discarded" : "kept",
            );
          }
          finish();
          return outcome;
        },
        failed() {
          if (outcome) return;
          outcome = Promise.resolve<SubmissionResult>("failed");
          finish();
        },
      };
    },
    discard(text) {
      if (registry.frozen()) return Promise.resolve<DiscardResult>("failed");
      return terminal(text);
    },
    end() {
      return terminal(textOf(fields.initial[MODEL]) ?? "");
    },
    retire() {
      if (retired) return;
      retired = true;
      running?.cancel();
      if (session) retire(session);
      if (unregister) {
        const go = unregister;
        unregister = null;
        go();
      }
    },
    retry,
    restoreAlternative(tabInstanceId) {
      const current = session;
      if (registry.frozen() || !current || current.retired)
        return Promise.resolve<ModelAlternativeResult>("refused");
      const chosen = view.alternatives.find(
        (copy) => copy.tabInstanceId === tabInstanceId,
      );
      if (!chosen || unreadable(chosen))
        return Promise.resolve<ModelAlternativeResult>("refused");
      const reader = targetOf(current);
      if (!reader)
        return Promise.resolve<ModelAlternativeResult>("unavailable");
      const began = current.order.next;
      const beganInput = fields.input;
      const handoff = isHandoff(chosen);
      const ours = handoff && tabInstanceId === current.claimed;
      const apply = (copy: RecoverySnapshot): ModelAlternativeResult => {
        const chosenText = unreadable(copy)
          ? null
          : textOf(internalOf(copy)[MODEL]);
        if (
          current.retired ||
          registry.frozen() ||
          targetOf(current) === null ||
          current.order.next !== began ||
          fields.input !== beganInput ||
          chosenText === null ||
          !options.restore(chosenText)
        )
          return "refused";
        take(chosenText);
        noteInput(fields, [MODEL]);
        current.persisted = {
          ...current.persisted,
          source:
            !handoff || ours
              ? {
                  id: tabInstanceId,
                  context: copy.formContext,
                  values: internalOf(copy),
                  capture: copy.capture ?? null,
                  lineage: [],
                  at: current.order.next,
                }
              : null,
        };
        relist();
        setView({
          restored: copy,
          alternatives: [
            ...(view.restored ? [view.restored] : []),
            ...view.alternatives.filter(
              (other) => other.tabInstanceId !== tabInstanceId,
            ),
          ],
        });
        return "restored";
      };
      const fresh = async (): Promise<ModelAlternativeResult> => {
        const found = await readCopy(reader, chosen.formContext, tabInstanceId);
        if (found.kind === "unavailable") return "unavailable";
        return found.kind === "absent" ? "gone" : apply(found.copy);
      };
      const chose = (async (): Promise<ModelAlternativeResult> => {
        if (handoff && !ours)
          return (
            (await (current.tab.whileFree
              ? current.tab.whileFree(tabInstanceId, fresh)
              : fresh())) ?? "refused"
          );
        if (
          !handoff &&
          tabInstanceId !== current.tab.current() &&
          (await current.tab.ownerOpen(tabInstanceId))
        )
          return "refused";
        return fresh();
      })()
        .catch((): ModelAlternativeResult => "unavailable")
        .then((result) => {
          if (result === "gone")
            setView({
              alternatives: view.alternatives.filter(
                (other) => other.tabInstanceId !== tabInstanceId,
              ),
            });
          return result;
        });
      return track(current, chose);
    },
    async discardAlternative(tabInstanceId) {
      const current = registry.frozen() ? null : session;
      const chosen = view.alternatives.find(
        (copy) => copy.tabInstanceId === tabInstanceId && isHandoff(copy),
      );
      const target = current ? targetOf(current) : null;
      if (!current || !chosen || !target) return "failed";
      const remove = () =>
        target
          .discard(chosen.formContext, tabInstanceId)
          .catch((): DiscardResult => "failed");
      const result =
        (await track(
          current,
          (current.tab.whileFree
            ? current.tab.whileFree(tabInstanceId, remove)
            : remove()
          ).catch((): DiscardResult => "failed"),
        )) ?? "failed";
      if (result === "discarded")
        setView({
          alternatives: view.alternatives.filter((copy) => copy !== chosen),
        });
      return result;
    },
    view: () => view,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  /** A terminal act of the person's (a discard, a departure): the copies go, and the input is `text` from now on (not edited since). */
  function terminal(next: string): Promise<DiscardResult> {
    take(next);
    const clean = { [MODEL]: fieldText(next) };
    setView({ restored: null });
    if (!session) {
      cover(fields, clean, fields.input);
      relist();
      return Promise.resolve<DiscardResult>("discarded");
    }
    const result = terminalAct(session, clean);
    relist();
    return result;
  }

  return model;
}
