import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import { useFormRecoveryPort } from "../../../data";
import {
  createRecoverableModel,
  type ModelTicket,
  type ModelView,
  type RecoverableModel,
  type RecoveryControls,
} from "../../../lib/form-recovery/model";
import type { DiscardResult } from "../../../lib/form-recovery/port";
import { pageFormRegistry } from "../../../lib/form-recovery/registry";
import type { HouseholdsMemory } from "./memory";
import { restoreName, restoreUsername } from "./model";

/**
 * APP-UPDATE RECOVERY OF THE HOUSEHOLD FORMS (WEB-12b maintenance merge of accepted main 2f42ac35, correction M-1: Kieran, 6 November 2026,
 * "Fix in the second merge"; WEB-14a's Q4 protocol, `docs/pwa.md` "The product's editors"). WEB-14a protected the households' create and
 * invite drafts on `HouseholdsMinimal`'s inline forms (revision 37, R40); WEB-12b replaced that subset with route-addressed dialogs whose
 * drafts live in the households PAGE memory (`memory.ts` `drafts`: they outlive a dialog's close and a `403` remount, never a reload). The
 * three typed inputs (New household's name, Rename's name, an invitation's username) each get a RECOVERABLE MODEL here, on the People
 * forms' pattern (`people/form-recovery.ts`, F-INT-PEOPLE-Q4). Page memory stays the one authority for the input; the model follows it in
 * the same step:
 *
 *  - ONE MODEL PER DRAFT KEY AND IDENTITY. A form that opens with no live session begins one from what it shows untouched (`start`), and
 *    takes a draft page memory already keeps as input (a dialog closed and opened again); a form that opens on a live session resumes it.
 *  - EVERY CHANGE, IN THE SAME STEP. The person's change (typing, or a directory lookup's choice) is given to the model (`edit`) before page
 *    memory takes it; refused while an update reload is being prepared (the field keeps what it shows: React puts a controlled input back).
 *  - LISTED WHILE IT MATTERS. The model is in the page's registry while its form shows it, and while it is dirty or owes work whether or not
 *    a form shows it: a draft kept in page memory after Cancel (WEB-12b's rule) is still saved by an update.
 *  - A SUBMISSION IS A TICKET, taken in the same step as the values it sends (none while an update reload is prepared: nothing is sent), and
 *    completed `succeeded` only for a durable success. The draft is cleared only if it is still what was sent (I7): text typed while the
 *    command was on its way stays. An uncertain answer covers nothing: the update saves the input, and a restored name is a NEW operation
 *    (an unresolved attempt is never part of a copy; WEB-12b's same-name check guards a create, Decision H's residual is unchanged).
 *  - PAGE MEMORY DROPS A DRAFT (a success, a Try again that completed the form, Rename's Escape): the model's session follows (`dropped`):
 *    with its form shown, the copies are discarded and the input becomes the form's start; with none, the session ends (an explicit discard).
 *  - RESTORED, NEVER SUBMITTED, INTO AN UNTOUCHED FORM. The dialogs are route-addressed and an update's reload keeps the URL, so the dialog
 *    that was open mounts again and makes the look itself (no restore host; as the route-addressed defaults dialog). The model is bound, and
 *    so looks, only once its form shows its input (Rename and the invitation form wait for the household list). A copy found when no draft
 *    is kept is put into page memory as the draft; a copy the codec cannot read is offered as it is, never restored in part.
 *  - ANOTHER IDENTITY. Page memory is one identity's: when another's is asked for, every model of the previous identity leaves the registry
 *    (its copies stay in its own store), as for the People forms.
 *
 * The signup link (a credential) and the directory lookup's queries (presentation) are never recovered (D-12b-15; WEB-14a's rules).
 */

/** One form's Q4 codec: its context (stable for the form and its household; the account is the port's) and its versioned, non-secret text. */
export interface HouseholdCodec<T> {
  readonly context: string;
  encode(value: T): string;
  /** Null for a text this build cannot read (offered, never restored in part). */
  decode(text: string): T | null;
}

/**
 * WEB-14a's own household contexts and text (`HouseholdsMinimal`, revision 37: `household-create`, `household-invite:<id>`, `{ v: 1, text }`)
 * are kept, so a copy saved before this merge is restored into the dialog that replaced its form; Rename is new (`household-rename:<id>`).
 */
const textOf =
  (
    valid: (values: Readonly<Record<string, string>>) => string | null,
    field: string,
  ) =>
  (raw: string): string | null => {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown> | null;
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        parsed.v !== 1 ||
        typeof parsed.text !== "string"
      )
        return null;
      return valid({ [field]: parsed.text });
    } catch {
      return null;
    }
  };
export const createRecovery = (): HouseholdCodec<string> => ({
  context: "household-create",
  encode: (text) => JSON.stringify({ v: 1, text }),
  decode: textOf(restoreName, "name"),
});
export const inviteRecovery = (
  householdId: string,
): HouseholdCodec<string> => ({
  context: `household-invite:${householdId}`,
  encode: (text) => JSON.stringify({ v: 1, text }),
  decode: textOf(restoreUsername, "username"),
});
/** A rename's name and the household version it was composed against: a restored rename is saved under THAT version (never an overwrite). */
export interface RenameInput {
  text: string;
  base: number | null;
}
export const renameRecovery = (
  householdId: string,
): HouseholdCodec<RenameInput> => ({
  context: `household-rename:${householdId}`,
  encode: ({ text, base }) => JSON.stringify({ v: 1, text, base }),
  decode: (raw) => {
    const text = textOf(restoreName, "name")(raw);
    if (text === null) return null;
    const { base } = JSON.parse(raw) as { base?: unknown };
    return base === null ||
      (typeof base === "number" && Number.isInteger(base) && base >= 1)
      ? { text, base }
      : null;
  },
});

/** The form showing the model now. */
interface Shown {
  untouched(): boolean;
  /** `chosen`: the person chose the copy (no untouched rule). False: not taken. */
  apply(value: unknown, chosen: boolean): boolean;
  /** What the form shows untouched, encoded (the input a dropped draft returns to). */
  start(): string;
}

interface Linked {
  readonly identity: string;
  readonly key: string;
  readonly model: RecoverableModel;
  readonly codec: HouseholdCodec<unknown>;
  /** The model's session follows a draft of page memory (begun, not ended since). */
  active: boolean;
  shown: Shown | null;
  /**
   * The form closed in this turn with nothing kept: whether the session ends is decided after it, so a form mounted again in the same turn
   * (React's development remount, WEB-14a's S12 rule in `editor.ts`) resumes the session and never begins a new one under a running look.
   */
  leaving: ReturnType<typeof setTimeout> | null;
}

const models = new Map<string, Linked>();
const keyOf = (identity: string, key: string) => `${identity}\u0000${key}`;

/** Another identity's models leave the page's registry (their copies stay in their store; page memory dropped their input). */
export function retireHouseholdRecoveryExcept(identity: string | null): void {
  for (const [id, linked] of [...models])
    if (linked.identity !== identity) {
      linked.model.retire();
      models.delete(id);
    }
}

/** For tests (and `forgetHouseholdsMemory`): every model leaves the registry and is forgotten. */
export function forgetHouseholdRecovery(): void {
  retireHouseholdRecoveryExcept(null);
}

/** Page memory of `identity` dropped the draft of `key` (see above). Nothing happens for a key no form has shown. */
export function dropped(identity: string, key: string): void {
  const linked = models.get(keyOf(identity, key));
  if (linked === undefined || !linked.active) return;
  if (linked.shown !== null) void linked.model.discard(linked.shown.start());
  else {
    linked.active = false;
    void linked.model.end();
  }
}

/** The model of `key` (a draft key of `memory`) for `memory`'s identity, made once (its codec is the first caller's). */
function link(
  memory: HouseholdsMemory,
  key: string,
  codec: HouseholdCodec<unknown>,
): Linked {
  retireHouseholdRecoveryExcept(memory.identity);
  const id = keyOf(memory.identity, key);
  const known = models.get(id);
  if (known !== undefined) return known;
  const linked: Linked = {
    identity: memory.identity,
    key,
    codec,
    active: false,
    shown: null,
    leaving: null,
    model: createRecoverableModel({
      formContext: codec.context,
      start: "",
      restore: (text, chosen) => {
        const value = linked.codec.decode(text);
        // With no form shown nothing is taken (the copy is offered when the dialog opens and looks).
        return value !== null && (linked.shown?.apply(value, chosen) ?? false);
      },
      untouched: () =>
        linked.shown !== null
          ? linked.shown.untouched()
          : !memory.drafts.has(key),
    }),
  };
  models.set(id, linked);
  return linked;
}

export interface HouseholdRecovery<T> extends RecoveryControls {
  /** The person changed the input to `value` (typed, or chose an account): false while an update reload is prepared (do not take it). */
  edit(value: T): boolean;
  /** In the same step as reading what a submission sends: null while an update reload is prepared (send nothing). */
  submitting(): ModelTicket | null;
}

/**
 * The form of `key` (null: the dialog has no such form, as the header-level Invitations). `shown`: the form shows its input now (the field
 * is rendered). `start()` is what the form shows untouched; `value()` its input now; `restored(value)` puts a copy's input into page memory
 * (the session's input from now on, not an edit); `reset()` drops the draft without ending the session ("Discard instead").
 */
export interface HouseholdRecoveryOptions<T> {
  memory: HouseholdsMemory;
  key: string | null;
  shown: boolean;
  codec: HouseholdCodec<T>;
  start(): T;
  value(): T;
  restored(value: T): void;
  reset(): void;
}
export function useHouseholdRecovery<T>(
  options: HouseholdRecoveryOptions<T> & { key: string },
): HouseholdRecovery<T>;
export function useHouseholdRecovery<T>(
  options: HouseholdRecoveryOptions<T>,
): HouseholdRecovery<T> | null;
export function useHouseholdRecovery<T>(
  options: HouseholdRecoveryOptions<T>,
): HouseholdRecovery<T> | null {
  const port = useFormRecoveryPort();
  const latest = useRef(options);
  latest.current = options;
  const { memory, key, shown } = options;
  // biome-ignore lint/correctness/useExhaustiveDependencies: one model per identity and key (its codec is the first caller's)
  const linked = useMemo(
    () =>
      key === null
        ? null
        : link(memory, key, options.codec as HouseholdCodec<unknown>),
    [memory, key],
  );
  // The session is begun or resumed, and the form shown, BEFORE the look (the bind below, a passive effect): the look must find the
  // session's start, never take it for input typed while it read, and give a copy to this form.
  useLayoutEffect(() => {
    if (linked === null || !shown) return;
    const { codec } = latest.current;
    const draftKey = linked.key;
    if (linked.leaving !== null) {
      clearTimeout(linked.leaving);
      linked.leaving = null;
    }
    if (!linked.active) {
      linked.active = true;
      const start = codec.encode(latest.current.start());
      linked.model.begin(start);
      if (memory.drafts.has(draftKey)) {
        const now = codec.encode(latest.current.value());
        if (now !== start) linked.model.edit(now);
      }
    }
    const view: Shown = {
      untouched: () => !memory.drafts.has(draftKey),
      apply: (value, chosen) => {
        if (!chosen && memory.drafts.has(draftKey)) return false;
        latest.current.restored(value as T);
        return true;
      },
      start: () => latest.current.codec.encode(latest.current.start()),
    };
    linked.shown = view;
    const hide = linked.model.show();
    return () => {
      if (linked.shown === view) linked.shown = null;
      hide();
      // Closed with nothing kept: the next opening begins again from what it then shows (a draft kept stays the session's, listed while
      // dirty). Decided after this turn (see `leaving`).
      if (memory.drafts.has(draftKey)) return;
      linked.leaving = setTimeout(() => {
        linked.leaving = null;
        if (linked.shown === null && !memory.drafts.has(draftKey))
          linked.active = false;
      }, 0);
    };
  }, [linked, memory, shown]);
  useEffect(() => {
    if (linked !== null && shown) linked.model.bind(port);
  }, [linked, port, shown]);
  const subscribe = linked?.model.subscribe ?? noSubscribe;
  const read = linked?.model.view ?? noView;
  const view: ModelView = useSyncExternalStore(subscribe, read, read);
  const locked = useSyncExternalStore(
    pageFormRegistry.subscribe,
    pageFormRegistry.frozen,
    pageFormRegistry.frozen,
  );
  if (linked === null) return null;
  const { model } = linked;
  const codec = options.codec;
  return {
    view,
    locked,
    edit: (value) => model.edit(codec.encode(value)),
    submitting: () => model.submitting(),
    discard() {
      // Admitted at the gesture or not at all (WEB-14a revision 38, R40-A): the form shows its start in the same step as the model takes it.
      if (!model.accepting()) return Promise.resolve<DiscardResult>("failed");
      const removal = model.discard(codec.encode(latest.current.start()));
      latest.current.reset();
      return removal;
    },
    retry: () => model.retry(),
    checkAgain: model.checkAgain,
    restoreAlternative: (copy) => model.restoreAlternative(copy.tabInstanceId),
    discardAlternative: (copy) => model.discardAlternative(copy.tabInstanceId),
  };
}

const noSubscribe = () => () => undefined;
/** A dialog without the form (the header-level Invitations): nothing to show. */
const NONE: ModelView = {
  restored: null,
  alternatives: [],
  unavailable: false,
  ready: true,
};
const noView = (): ModelView => NONE;

/** A submission's ticket completed once: `durable` only for a durable success of what it sent. */
export function completeTicket(ticket: ModelTicket, durable: boolean): void {
  if (durable) void ticket.succeeded();
  else ticket.failed();
}
