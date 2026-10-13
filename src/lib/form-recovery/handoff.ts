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
 *    then may the page reload (a failure keeps the form open, as any failed save does).
 *  - The replacement restores that copy first (never submitting it) and, holding its lock, removes it once its own copy is saved, or at its
 *    own submission or discard: the hand-off is its source, and only it may remove it. A page that does not hold the lock (a duplicated or
 *    opener-copied tab carrying the same reference) restores the same input as its own, without the right to remove the hand-off.
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
 * Where a tab keeps its hand-off references across a reload (the page's `sessionStorage`), and what THIS page wrote itself (memory only:
 * a page never takes its own hand-off for one left to it).
 */
export interface HandoffStore {
  read(): HandoffRef[];
  /** False when the references could not be written (nothing then reaches the next page). */
  write(refs: readonly HandoffRef[]): boolean;
  readonly written: Set<string>;
}

const KEY = "atlas-update-handoff";

const valid = (ref: unknown): ref is HandoffRef =>
  typeof ref === "object" &&
  ref !== null &&
  typeof (ref as HandoffRef).form === "string" &&
  typeof (ref as HandoffRef).scope === "string" &&
  typeof (ref as HandoffRef).id === "string";

/** A store over `storage` (the page's `sessionStorage`); an unreadable or malformed record is no reference. */
export function storageHandoffs(storage: () => Storage | null): HandoffStore {
  return {
    read() {
      try {
        const parsed: unknown = JSON.parse(storage()?.getItem(KEY) ?? "[]");
        return Array.isArray(parsed) ? parsed.filter(valid) : [];
      } catch {
        return [];
      }
    },
    write(refs) {
      try {
        const target = storage();
        if (!target) return false;
        if (refs.length === 0) target.removeItem(KEY);
        else target.setItem(KEY, JSON.stringify(refs));
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

/** The hand-off left to this page for `form` in `scope`, unless this page wrote it itself. */
export function handoffFor(
  store: HandoffStore,
  form: string,
  scope: string,
): string | null {
  const ref = store
    .read()
    .find((entry) => entry.form === form && entry.scope === scope);
  return ref && !store.written.has(ref.id) ? ref.id : null;
}

/** Leaves `ref` to the next page (in place of any other for the same form and scope); false when it could not be written. */
export function rememberHandoff(store: HandoffStore, ref: HandoffRef): boolean {
  const others = store
    .read()
    .filter((entry) => entry.form !== ref.form || entry.scope !== ref.scope);
  return store.write([...others, ref]);
}

/** The hand-off `id` is resolved (removed from the store): its reference goes (only that exact one). */
export function forgetHandoff(store: HandoffStore, id: string): void {
  const refs = store.read();
  const rest = refs.filter((entry) => entry.id !== id);
  if (rest.length !== refs.length) store.write(rest);
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
