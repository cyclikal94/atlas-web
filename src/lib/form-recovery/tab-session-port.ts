import { handoffContext } from "./handoff";
import type {
  DiscardResult,
  FormRecoveryPort,
  RecoverySnapshot,
  SaveResult,
} from "./port";

/**
 * THE PRE-ACCOUNT USERNAME'S RECOVERY STORE (WEB-14a revision 38; Kieran's decision WEB14A-PREACCOUNT-USERNAME-RECOVERY-20261026). The
 * sign-in and join forms are shown before any account is displayed, so there is no account store to keep their input in. Approved: ONLY
 * the unfinished username, only in THIS tab's session storage, only for an app-update reload, removed once it is restored or the form is
 * left; never a password, an invitation or connection secret, never submitted automatically, and never an account's store.
 *
 * A port over the tab's `sessionStorage` for the named form contexts (and their update hand-offs) only, holding a copy's one model text
 * (`values.model`, at most `MAX_TEXT` characters) and nothing else of a form: anything else is refused. The session writes through it as
 * through an account's store (ordered captures, hand-offs, discards). Two deliberate narrowings:
 *
 *  - `list` answers no copies: the next page restores only the hand-off left to it (read by its exact id, under its lock); a copy
 *    another page of this tab, or a duplicated tab's inherited storage, left is never offered or restored.
 *  - `sweep` removes every copy of a context but the current page's: the form's editor calls it once its look has read the store, so
 *    nothing of an earlier page outlives the restore.
 *
 * A storage that cannot be read rejects (the look is then unavailable, never an empty answer); one that cannot be written fails the save
 * (the update stops with retry or an explicit discard).
 */
const PREFIX = "atlas-preaccount-recovery:";
/** Far beyond any username the forms accept; a bound on what this store may ever hold. */
const MAX_TEXT = 1_000;

export interface TabSessionRecoveryPort extends FormRecoveryPort {
  /** Removes every copy of `formContext` (and its hand-offs) but those `keep` answers true for (the current page's own and hand-offs). */
  sweep(formContext: string, keep: (tabInstanceId: string) => boolean): void;
}

export function tabSessionRecoveryPort(
  storage: () => Storage,
  contexts: readonly string[],
): TabSessionRecoveryPort {
  const allowed = new Set(
    contexts.flatMap((context) => [context, handoffContext(context)]),
  );
  const key = (formContext: string, tabInstanceId: string) =>
    `${PREFIX}${JSON.stringify([formContext, tabInstanceId])}`;
  const read = (name: string): RecoverySnapshot | null => {
    const text = storage().getItem(name);
    if (text === null) return null;
    try {
      const copy = JSON.parse(text) as RecoverySnapshot;
      return typeof copy?.values?.model === "string" ? copy : null;
    } catch {
      return null;
    }
  };
  return {
    async save(snapshot: RecoverySnapshot): Promise<SaveResult> {
      const fields = Object.keys(snapshot.values);
      const text = snapshot.values.model;
      if (
        !allowed.has(snapshot.formContext) ||
        fields.length !== 1 ||
        typeof text !== "string" ||
        text.length > MAX_TEXT ||
        snapshot.controls !== undefined
      )
        return "refused";
      try {
        storage().setItem(
          key(snapshot.formContext, snapshot.tabInstanceId),
          JSON.stringify({
            formContext: snapshot.formContext,
            tabInstanceId: snapshot.tabInstanceId,
            values: { model: text },
            savedAt: snapshot.savedAt,
            ...(snapshot.capture === undefined
              ? {}
              : { capture: snapshot.capture }),
            ...(snapshot.lineage === undefined
              ? {}
              : { lineage: snapshot.lineage }),
          }),
        );
        return "saved";
      } catch {
        return "failed";
      }
    },
    async load(formContext, tabInstanceId) {
      if (!allowed.has(formContext)) return null;
      return read(key(formContext, tabInstanceId));
    },
    async discard(formContext, tabInstanceId, capture): Promise<DiscardResult> {
      try {
        const name = key(formContext, tabInstanceId);
        // A conditional discard removes the copy only while it holds that capture (a newer one there is left as it is).
        if (capture !== undefined && read(name)?.capture !== capture)
          return "discarded";
        storage().removeItem(name);
        return "discarded";
      } catch {
        return "failed";
      }
    },
    async list(formContext) {
      // Read, so that a storage that cannot be read rejects as any store's list does; nothing is offered (see above).
      void storage().length;
      void formContext;
      return [];
    },
    sweep(formContext, keep) {
      const contexts = new Set([formContext, handoffContext(formContext)]);
      try {
        const store = storage();
        const names: string[] = [];
        for (let i = 0; i < store.length; i += 1) {
          const name = store.key(i);
          if (name?.startsWith(PREFIX)) names.push(name);
        }
        for (const name of names) {
          const [context, tab] = JSON.parse(name.slice(PREFIX.length)) as [
            string,
            string,
          ];
          if (contexts.has(context) && !keep(tab)) store.removeItem(name);
        }
      } catch {
        // A storage that cannot be read or written now: what it holds goes with the tab.
      }
    },
  };
}

/** The page's pre-account port (the sign-in and join forms' username), over this tab's session storage. */
let page: TabSessionRecoveryPort | null = null;
export function preAccountRecoveryPort(): TabSessionRecoveryPort {
  page ??= tabSessionRecoveryPort(() => window.sessionStorage, PRE_ACCOUNT);
  return page;
}
export const PRE_ACCOUNT = ["sign-in", "join"] as const;
