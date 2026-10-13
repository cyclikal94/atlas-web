import type { SaveResult } from "./port";
import type {
  RecoverableFormHandle,
  RecoverableFormRegistry,
} from "./registry";

/**
 * THE UPDATE HAND-OFF (WEB-14a revision 6, R13; owner decision recorded 12 October 2026 in `.agtx/execute.md`: "protected hand-off", and
 * an abandoned hand-off is "revealed, can't be removed"). A page's own recovery copy protects its input only while the page lives: once an
 * update reload unloads it, any other page could restore that copy and, by saving, submitting or discarding its own form, remove it before
 * the replacement page reads it. So before an update reload (`prepareHandoffs`, the coordinator's "Save and reload") the page writes, for
 * each form with a copy, an extra copy under a NEW random hand-off identifier:
 *
 *  - It is stored under the form's HAND-OFF CONTEXT (`handoffContext`), which no ordinary read of the form lists, so no other page can
 *    take it for its own source; and it is never a writer identity (the page's `tab_instance_id` stays fresh and memory-only).
 *  - The page holds the hand-off's Web Lock (`atlas-recovery-handoff-<id>`) before writing it, and its replacement takes that lock over.
 *    A hand-off whose lock is held belongs to a live page (the one that wrote it, or the one that claimed it) and is shown to nobody else.
 *  - A REFERENCE reaches the replacement page in `sessionStorage` (this tab only; a reload keeps it): only the form context, the account
 *    database's scope and the hand-off identifier, never any form value. Only after the copy is durable is the reference written, and only
 *    then may the page reload (a failure keeps the form open, as any failed save does). Revision 7 (DA-A): the record is never rewritten
 *    from one that could not be read, and the reload is certified on the record itself.
 *  - The replacement takes its lock, THEN reads it (revision 7, R15: what it shows is what it read while holding the lock, so nobody can
 *    have resolved it since), restores it first (never submitting it) and removes it once its own copy is saved, or at its own submission
 *    or discard: the hand-off is its source, and only it may remove it. A page that cannot take the lock in time (a duplicated or
 *    opener-copied tab carrying the same reference, while the page holding it lives) neither reads nor shows it: it falls back to the
 *    ordinary copies (the owner's decision).
 *  - A hand-off nobody holds (its replacement never came: the tab closed or crashed during the reload) is offered to later pages of the
 *    form as an alternative they may restore, never remove; only an explicit "Discard this copy" of that alternative removes it.
 *
 * No timer ever removes a hand-off. A closed tab, an ordinary browser reload and the sync-recovery reload write no hand-off: their copies
 * are the ordinary ones, as before.
 */
export const HANDOFF_PREFIX = "atlas-update-handoff:";

/** Where a form's hand-off copies are stored (never a form context of its own: `useRecoverableForm` refuses such a name). */
export const handoffContext = (formContext: string): string =>
  HANDOFF_PREFIX + formContext;

/** One hand-off this tab's next page should take: the form, the account database's scope, the hand-off identifier. */
export interface HandoffRef {
  form: string;
  scope: string;
  id: string;
}

/**
 * What the tab's reference record holds (revision 7, DA-A): its references, with every entry this page cannot read KEPT as it is (another
 * build's, say), or `unknown` when the record could not be read or is not a list. An unknown record is never an empty one: nothing is
 * written over it (that could drop another form's reference while its hand-off still counts as made), and no reference is taken from it.
 */
export type HandoffRecord =
  | { kind: "read"; refs: HandoffRef[]; others: unknown[] }
  | { kind: "unknown" };

/**
 * Where a tab keeps its hand-off references across a reload (the page's `sessionStorage`), and what THIS page wrote itself (memory only:
 * a page never takes its own hand-off for one left to it).
 */
export interface HandoffStore {
  read(): HandoffRecord;
  /** False when the record could not be written (nothing then reaches the next page). */
  write(entries: readonly unknown[]): boolean;
  readonly written: Set<string>;
}

const KEY = "atlas-update-handoff";

const valid = (ref: unknown): ref is HandoffRef =>
  typeof ref === "object" &&
  ref !== null &&
  typeof (ref as HandoffRef).form === "string" &&
  typeof (ref as HandoffRef).scope === "string" &&
  typeof (ref as HandoffRef).id === "string";

/** A store over `storage` (the page's `sessionStorage`). No record is an empty one; one that cannot be read, or is not a list, is `unknown`. */
export function storageHandoffs(storage: () => Storage | null): HandoffStore {
  return {
    read() {
      try {
        const target = storage();
        if (!target) return { kind: "unknown" };
        const parsed: unknown = JSON.parse(target.getItem(KEY) ?? "[]");
        if (!Array.isArray(parsed)) return { kind: "unknown" };
        return {
          kind: "read",
          refs: parsed.filter(valid),
          others: parsed.filter((entry) => !valid(entry)),
        };
      } catch {
        return { kind: "unknown" };
      }
    },
    write(entries) {
      try {
        const target = storage();
        if (!target) return false;
        if (entries.length === 0) target.removeItem(KEY);
        else target.setItem(KEY, JSON.stringify(entries));
        return true;
      } catch {
        return false;
      }
    },
    written: new Set(),
  };
}

/** The page's own store. */
export const pageHandoffs: HandoffStore = storageHandoffs(() => {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
});

/**
 * The hand-off left to this page for `form` in `scope` (revision 7): `none` (no reference for it, or one this page wrote itself), its
 * identifier, or `unknown` (the record could not be read: whether one was left is not known, so the look cannot finish).
 */
export type HandoffLeft =
  | { kind: "none" }
  | { kind: "left"; id: string }
  | { kind: "unknown" };

export function handoffFor(
  store: HandoffStore,
  form: string,
  scope: string,
): HandoffLeft {
  const record = store.read();
  if (record.kind === "unknown") return record;
  const ref = record.refs.find(
    (entry) => entry.form === form && entry.scope === scope,
  );
  return ref && !store.written.has(ref.id)
    ? { kind: "left", id: ref.id }
    : { kind: "none" };
}

/**
 * Leaves `ref` to the next page (in place of any other for the same form and scope; every other entry kept as it is); false when it could
 * not be written, or the record could not be read (revision 7, DA-A: never written over from an unknown base).
 */
export function rememberHandoff(store: HandoffStore, ref: HandoffRef): boolean {
  const record = store.read();
  if (record.kind === "unknown") return false;
  const others = record.refs.filter(
    (entry) => entry.form !== ref.form || entry.scope !== ref.scope,
  );
  return store.write([...record.others, ...others, ref]);
}

/** Whether the record holds exactly `ref` now (revision 7, DA-A: what the reload is certified on, read in the same step). */
export function referenced(store: HandoffStore, ref: HandoffRef): boolean {
  const record = store.read();
  return (
    record.kind === "read" &&
    record.refs.some(
      (entry) =>
        entry.id === ref.id &&
        entry.form === ref.form &&
        entry.scope === ref.scope,
    )
  );
}

/**
 * The hand-off `id` is resolved (removed from the store): its reference goes (only that exact one). False when the record could not be
 * read or written (a stale reference is harmless: the next page reads the hand-off again and finds it gone).
 */
export function forgetHandoff(store: HandoffStore, id: string): boolean {
  const record = store.read();
  if (record.kind === "unknown") return false;
  const rest = record.refs.filter((entry) => entry.id !== id);
  return (
    rest.length === record.refs.length ||
    store.write([...record.others, ...rest])
  );
}

/** Every form handle the page has: the registered ones and the sessions it keeps for a later mount (a clean form with a copy included). */
export function handoffHandles(
  registry: RecoverableFormRegistry,
): RecoverableFormHandle[] {
  const handles = new Set(registry.all());
  for (const session of registry.sessions())
    if (session.handle) handles.add(session.handle);
  return [...handles];
}

/** Whether every form with a copy has its hand-off written for that copy (read in the same step as the reload). */
export const handedOff = (registry: RecoverableFormRegistry): boolean =>
  handoffHandles(registry).every((handle) => {
    try {
      return handle.handedOff?.() ?? true;
    } catch {
      return false;
    }
  });

/** Writes the hand-off of every form that needs one; the results (a handle that throws counts as `failed`). */
export function prepareHandoffs(
  registry: RecoverableFormRegistry,
): Promise<SaveResult[]> {
  return Promise.all(
    handoffHandles(registry)
      .filter((handle) => handle.handoff && !handle.handedOff?.())
      .map((handle) =>
        (handle.handoff?.() ?? Promise.resolve<SaveResult>("saved")).catch(
          (): SaveResult => "failed",
        ),
      ),
  );
}
