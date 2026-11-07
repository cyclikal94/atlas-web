import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import { useFormRecoveryPort } from "../../data";
import {
  createRecoverableModel,
  type ModelTicket,
  type ModelView,
  type RecoverableModel,
  type RecoveryControls,
} from "../../lib/form-recovery/model";
import type { DiscardResult } from "../../lib/form-recovery/port";
import { pageFormRegistry } from "../../lib/form-recovery/registry";
import type { PeopleMemory } from "./memory";

/**
 * APP-UPDATE RECOVERY OF THE PEOPLE FORMS (WEB-14a integration revision; review of 2 November 2026, F-INT-PEOPLE-Q4; Q4).
 *
 * The people forms (new person, rename, the field editor) keep their input in the identity's PAGE memory (`memory.ts` `drafts`), each with
 * its EDITING SESSION (`lifetime.ts`): it outlives a remount and the in-dialog sync control, and a reload forgets it. So each form also has
 * a RECOVERABLE MODEL (`lib/form-recovery/model.ts`) for its Q4 context (`model/recovery.ts`): the session of the page's form registry that
 * the app-update coordinator saves, hands off and seals through. People memory stays the one authority for the input; the model follows it
 * in the same step:
 *
 *  - ONE MODEL SESSION PER PEOPLE SESSION. A form that begins a new editing session begins the model's (`opened`); one that resumes a kept
 *    session (a remount, the sync control, coming back) resumes the model's too. A People session that ends without a save (Cancel, Escape,
 *    the close icon, "Discard mine", leaving an unread editor) ends the model's (`ended`, from `retireSession`): its copies are discarded.
 *  - EVERY CHANGE, IN THE SAME STEP. The person's change is given to the model (`edit`) before the form takes it; refused while an update
 *    reload is being prepared (the form keeps what it shows). What a save's report leaves in the input (a re-binding) is `settle`, never
 *    the person's edit.
 *  - LISTED WHILE IT MATTERS. The model is in the page's registry while a form shows it, and while it is dirty, owes a discard or has a
 *    save outstanding whether or not any form shows it: a session kept in page memory with no form mounted is still saved by an update.
 *  - A SAVE IS A TICKET. A save takes the model's ticket in the same step as its admission (none while an update reload is prepared: nothing
 *    is sent then), and completes it: `succeeded` only for a durable success (queued, a receipt, a durable hold), `failed` otherwise (a
 *    refusal, an uncertain online attempt, a stale binding): the input stays dirty, and an update saves it first.
 *  - RESTORED, NEVER SUBMITTED. The look for what the page before an update left (made once the model is bound) gives the newest copy to the
 *    form shown, only while its session is untouched; with no form shown, to the screen that opens it (`usePeopleRecoveryHost`), which
 *    keeps it as a new editing session in page memory and opens the form on it. A copy the codec cannot read is offered as it is.
 *
 * The held audience changes (`people-held:`, `field/held-store.ts`) are OPERATIONS, written only through the conditional port: never a
 * model here, never restored or discarded as a form. Uncertain online attempts stay in page memory, untouched (`memory.attempts`): a
 * restored input is saved as a new attempt, under the version (`snapshot`) and ids (`newFieldId`) it was composed against.
 */
export interface PeopleCodec<T> {
  /** The Q4 context (`model/recovery.ts`). Stable for the form and its target; the account is the port's. */
  readonly context: string;
  /** The input as one explicitly versioned, non-secret text. */
  encode(value: T): string;
  /** A copy's text back into input; null when this build cannot read it (offered, never restored in part). */
  decode(text: string): T | null;
}

/** The form showing the model now. */
interface Shown {
  untouched(): boolean;
  /** `chosen`: the person chose the copy (no untouched rule). False: not taken. Must not call back into the model. */
  apply(value: unknown, chosen: boolean): boolean;
}

interface Linked {
  readonly identity: string;
  readonly key: string;
  readonly model: RecoverableModel;
  readonly codec: PeopleCodec<unknown>;
  /** The People editing session the model's session follows (null: none yet). */
  session: string | null;
  shown: Shown | null;
  /** The screens that open the form: told when a copy was kept for it while no form showed it. */
  readonly hosts: Set<() => void>;
  /** Keeps a restored value as a new editing session in page memory (null: no screen can); its session id, or null when it cannot. */
  park: ((value: unknown) => string | null) | null;
  /** Whether page memory keeps input of the key (edited, or a save running). */
  holds: () => boolean;
}

const models = new Map<string, Linked>();
const keyOf = (identity: string, key: string) => `${identity}\u0000${key}`;

/** Another identity's models leave the page's registry (their copies stay in their store; page memory dropped their input). */
export function retirePeopleRecoveryExcept(identity: string | null): void {
  for (const [key, linked] of [...models])
    if (linked.identity !== identity) {
      linked.model.retire();
      models.delete(key);
    }
}

/** The model of `key` (a draft key of `memory`) for `memory`'s identity, made once (its codec is the first caller's). */
function link<T>(
  memory: PeopleMemory,
  key: string,
  codec: PeopleCodec<T>,
  start: () => T,
  holds: () => boolean,
): Linked {
  retirePeopleRecoveryExcept(memory.identity);
  const id = keyOf(memory.identity, key);
  const known = models.get(id);
  if (known !== undefined) return known;
  const linked: Linked = {
    identity: memory.identity,
    key,
    codec: codec as PeopleCodec<unknown>,
    session: null,
    shown: null,
    hosts: new Set(),
    park: null,
    holds,
    model: createRecoverableModel({
      formContext: codec.context,
      start: codec.encode(start()),
      restore: (text, chosen) => {
        const value = linked.codec.decode(text);
        if (value === null) return false;
        if (linked.shown !== null) return linked.shown.apply(value, chosen);
        // A choice is made in a form; with none shown, only the look's restore, into a key page memory keeps nothing for.
        if (chosen || linked.park === null || linked.hosts.size === 0)
          return false;
        if (linked.holds()) return false;
        const session = linked.park(value);
        if (session === null) return false;
        linked.session = session;
        for (const open of [...linked.hosts]) open();
        return true;
      },
      untouched: () =>
        linked.shown !== null ? linked.shown.untouched() : !linked.holds(),
    }),
  };
  models.set(id, linked);
  return linked;
}

/**
 * A People editing session of `key` ended without a save (`retireSession`): its model's session ends, and its copies are discarded. Only
 * that session: a model following another session (a later form of the key) is untouched.
 */
export function endPeopleRecovery(
  identity: string,
  key: string,
  session: string,
): void {
  const linked = models.get(keyOf(identity, key));
  if (linked === undefined || linked.session !== session) return;
  linked.session = null;
  void linked.model.end();
}

/** For tests: every model leaves the registry and is forgotten. */
export function forgetPeopleRecovery(): void {
  retirePeopleRecoveryExcept(null);
}

/**
 * The screen that opens the form of `key` (the people list for "New person", the identity header for Rename): binds the model and looks
 * for what the page before an update left to it. A copy found while no form shows the key, and page memory keeps nothing for it, is kept
 * as a new editing session (`park`, returning its id) and `open` is called (now, or when the screen mounts with it kept).
 */
export function usePeopleRecoveryHost<T>(options: {
  memory: PeopleMemory;
  key: string;
  codec: PeopleCodec<T>;
  start(): T;
  holds(): boolean;
  park(value: T): string | null;
  open(): void;
}): void {
  const port = useFormRecoveryPort();
  const latest = useRef(options);
  latest.current = options;
  const { memory, key } = options;
  // biome-ignore lint/correctness/useExhaustiveDependencies: one model per identity and key (its codec is the first caller's)
  const linked = useMemo(
    () =>
      link(
        memory,
        key,
        options.codec,
        () => latest.current.start(),
        () => latest.current.holds(),
      ),
    [memory, key],
  );
  useEffect(() => {
    const open = () => latest.current.open();
    linked.hosts.add(open);
    linked.park = (value) => latest.current.park(value as T);
    return () => {
      linked.hosts.delete(open);
      if (linked.hosts.size === 0) linked.park = null;
    };
  }, [linked]);
  useEffect(() => {
    linked.model.bind(port);
  }, [linked, port]);
}

export interface PeopleRecovery<T> extends RecoveryControls {
  /** The person changed the input to `value`: false while an update reload is being prepared (do not take the change). */
  edit(value: T): boolean;
  /** What a save's report leaves in the input (a re-binding): not the person's edit. */
  settle(value: T): void;
  /** In the same step as a save's admission: null while an update reload is prepared (send nothing). */
  submitting(): ModelTicket | null;
  /** An update reload is being prepared (no new work starts). */
  frozen(): boolean;
}

/**
 * The form of `key` showing `session` (its editing session in page memory). `resumed`: the session was kept in page memory (its model
 * session goes on); otherwise a new one begins from `start()`. `value()` is the form's input now; `restored(value)` puts a copy's input
 * into the form (the session's input from now on, not an edit; a restored input is not untouched); `untouched()` says nothing was changed
 * or saved in the session; `reset(value)` shows `value` as an untouched start ("Discard instead"); `busy()` says a save of the session runs.
 */
export function usePeopleRecovery<T>(options: {
  memory: PeopleMemory;
  key: string;
  session: string;
  codec: PeopleCodec<T>;
  start(): T;
  value(): T;
  holds(): boolean;
  untouched(): boolean;
  busy(): boolean;
  restored(value: T): void;
  reset(value: T): void;
}): PeopleRecovery<T> {
  const port = useFormRecoveryPort();
  const latest = useRef(options);
  latest.current = options;
  const { memory, key, session } = options;
  // biome-ignore lint/correctness/useExhaustiveDependencies: one model per identity and key (its codec is the first caller's)
  const linked = useMemo(
    () =>
      link(
        memory,
        key,
        options.codec,
        () => latest.current.start(),
        () => latest.current.holds(),
      ),
    [memory, key],
  );
  const model = linked.model;
  // The session's model session is begun or resumed, and the form shown, BEFORE the look (bound below, a passive effect): the look must
  // find the session's start, never take it for input typed while it read, and a copy it answers is given to this form, never kept as
  // another session beside it.
  useLayoutEffect(() => {
    if (linked.session !== session) {
      linked.session = session;
      const { codec } = latest.current;
      const start = codec.encode(latest.current.start());
      model.begin(start);
      const now = codec.encode(latest.current.value());
      if (now !== start) model.edit(now);
    }
    const shown: Shown = {
      untouched: () => latest.current.untouched(),
      apply: (value, chosen) => {
        if (latest.current.busy()) return false;
        if (!chosen && !latest.current.untouched()) return false;
        latest.current.restored(value as T);
        return true;
      },
    };
    linked.shown = shown;
    const hide = model.show();
    return () => {
      if (linked.shown === shown) linked.shown = null;
      hide();
    };
  }, [linked, model, session]);
  useEffect(() => {
    model.bind(port);
  }, [model, port]);
  const view: ModelView = useSyncExternalStore(
    model.subscribe,
    model.view,
    model.view,
  );
  const locked = useSyncExternalStore(
    pageFormRegistry.subscribe,
    pageFormRegistry.frozen,
    pageFormRegistry.frozen,
  );
  const codec = options.codec;
  return {
    view,
    locked,
    edit: (value) =>
      linked.session !== session || model.edit(codec.encode(value)),
    settle: (value) => {
      if (linked.session === session) model.settle(codec.encode(value));
    },
    submitting: () => (linked.session === session ? model.submitting() : null),
    frozen: () => model.frozen(),
    discard() {
      // Admitted at the gesture or not at all (revision 38, R40-A): the form shows its start in the same step as the model takes it.
      if (
        linked.session !== session ||
        !model.accepting() ||
        latest.current.busy()
      )
        return Promise.resolve<DiscardResult>("failed");
      const start = latest.current.start();
      const removal = model.discard(codec.encode(start));
      latest.current.reset(start);
      return removal;
    },
    retry: () => model.retry(),
    checkAgain: model.checkAgain,
    restoreAlternative: (copy) => model.restoreAlternative(copy.tabInstanceId),
    discardAlternative: (copy) => model.discardAlternative(copy.tabInstanceId),
  };
}

/** A save's ticket completed once: `durable` only for a durable success of what it sent. */
export function completeTicket(ticket: ModelTicket, durable: boolean): void {
  if (durable) void ticket.succeeded();
  else ticket.failed();
}
