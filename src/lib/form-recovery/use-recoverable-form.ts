import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { buildSnapshot, restoreSnapshot } from "./guard";
import type {
  DiscardResult,
  FormRecoveryPort,
  RecoverableFieldSpec,
  RecoverySnapshot,
  SaveResult,
} from "./port";
import { pageFormRegistry, type RecoverableFormRegistry } from "./registry";
import { getPageRecoveryTab, type RecoveryTab } from "./tab-identity";

/**
 * THE RECOVERABLE-FORM CONTRACT for feature slices (WEB-14a, D-P7; Q4). A form that may hold unfinished input when the app is updated:
 *
 *   const port = useFormRecoveryPort();            // from src/data: the displayed account's store, or null
 *   const recovery = useRecoverableForm({ formContext: `task-edit:${path}`, allow, formRef, port });
 *   ... {recovery.restored && <RecoveryBanner state={{ kind: "restored", onDiscard: recovery.discard }} firstFieldRef={...} />}
 *   ... on a successful submission: await recovery.onSubmitted();   // "discarded", or "failed"/"refused": a copy may come back
 *
 * While mounted the form is in the page's registry, so an accepted update saves its copy first (and another tab's accepted update asks
 * it to). On mount it restores the newest copy of the same form left by a tab that has GONE (one reload ago, or a closed tab), never
 * submitting anything; the others are offered as `alternatives`. After this page's own copy has been saved, the copy it was restored from
 * is discarded once; a submission or "Discard instead" discards both. Only allow-listed fields are captured, and never a sensitive one
 * (`guard.ts`). `formContext` names the form and the route it is on; the account is the port's (one database per account).
 *
 * WHAT "DIRTY" MEANS (revision 1, R2). A form is dirty when a reload would NOT bring back what it shows now: when its values differ from
 * the copy the next page would restore (this page's own latest durable copy, else the copy it was restored from, else nothing: what it showed
 * at mount). Revision 0 compared only with the mount (or restore) values, so a form returned to them after a save looked clean while its
 * obsolete copy was restored by the next page. A flush of a form whose values are back to the CLEAN state (what it showed at mount, or after
 * a submission or a discard) discards its copies instead of saving one, so the next page shows that state.
 *
 * THE ORDER OF CAPTURES AND DISCARDS IS FIXED WHEN THEY ARE ASKED FOR (revision 1, R4). A flush captures the values and takes its place in
 * the hook's order SYNCHRONOUSLY, at the call; the page's recovery identifier may still be on its way (its Web Lock), and a submission or
 * discard asked for meanwhile overtakes it: the flush then writes nothing ("failed": an obsolete capture), so it can never bring back input
 * that was submitted or discarded after it was asked for. The port's own order (`capture_seq`, `writer_gen`) still orders every write.
 *
 * NEVER INTO ANOTHER ACCOUNT, AND NOT LOST TO A REMOUNT (revision 1). Every flush and discard PINS the port when it is asked for
 * (`FormRecoveryPort.pin`): a write that waits can never land in another account's store, and one made for an account other than the one
 * the form was mounted for is not made at all. A form that UNMOUNTS dirty (another page's boot remounts the protected tree, finding F-1)
 * leaves its input and its recovery state in the page's registry (memory only: nothing is written while the tree is torn down, when the
 * account's service may already have ended), and the same form mounted again in its place in this page, for the same account's database
 * (`pin().scope`), takes them back before it looks for copies: the person's input is where it was.
 *
 * A DISCARD SAYS WHAT IT DID (revision 1, R6). `onSubmitted`, `discard` and the registry's `discard` answer `discarded` only when no copy of
 * the form can come back; otherwise the copies are still owed a discard, the form counts as dirty, and the next flush (an update's save) tries
 * again before anything reloads.
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

export interface RecoverableForm {
  /** The copy restored at mount (or chosen from the alternatives), or null. */
  restored: RecoverySnapshot | null;
  /** Other restorable copies of this form, newest first. */
  alternatives: readonly RecoverySnapshot[];
  restoreAlternative(tabInstanceId: string): void;
  /** Whether the look for a copy to restore has finished. */
  ready: boolean;
  /** The form was submitted: its copies are discarded. `failed`/`refused`: a copy may still come back after a reload. */
  onSubmitted(): Promise<DiscardResult>;
  /** "Discard instead": the copies are discarded and the form shows what it showed before the restore. */
  discard(): Promise<DiscardResult>;
}

type Values = Record<string, string>;
const read = (
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
const sameValues = (a: Values, b: Values): boolean => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if (a[key] !== b[key]) return false;
  return true;
};

/** What this page believes is durable for the form, and what it owes. */
interface Persisted {
  /** This page's own latest durable copy (its values), and the order of the flush that wrote it. */
  own: { values: Values; op: number } | null;
  /** Whether this page has ever asked to write a copy under its own identifier (so a discard must reach it). */
  ownAsked: boolean;
  /**
   * The copy of another (gone) tab this form was restored from, still in the store: the next page would restore it again while this page
   * has none of its own. `newest`: it is the newest of the copies (an alternative chosen instead may not be).
   */
  source: { id: string; values: Values; newest: boolean } | null;
  /** A discard (a submission, "Discard instead", "Discard and reload anyway") that did not land: copies may come back. */
  owed: boolean;
}

/** What a form carries across a remount in this page (`RecoverableFormRegistry.carry`). */
interface CarriedState {
  initial: Values | null;
  clean: Values | null;
  persisted: Persisted;
}

export function useRecoverableForm(
  options: UseRecoverableFormOptions,
): RecoverableForm {
  const { formContext, allow, formRef, port } = options;
  // The allow-list is read through `latest`, so a caller that builds it afresh on every render does not restart anything.
  const registry = options.registry ?? pageFormRegistry;
  const tab = options.tab ?? getPageRecoveryTab();
  const [restored, setRestored] = useState<RecoverySnapshot | null>(null);
  const [alternatives, setAlternatives] = useState<readonly RecoverySnapshot[]>(
    [],
  );
  const [ready, setReady] = useState(false);
  // What the form showed at mount (before any restore).
  const initial = useRef<Values | null>(null);
  // The values for which no copy is needed when nothing is durable: the mount values, or what the form showed when it was submitted or
  // discarded.
  const clean = useRef<Values | null>(null);
  const persisted = useRef<Persisted>({
    own: null,
    ownAsked: false,
    source: null,
    owed: false,
  });
  // The hook's order of flushes and discards (R4): taken synchronously when each is asked for.
  const order = useRef({ next: 0, lastTerminal: 0 });
  const looked = useRef(false);
  // The account the form was mounted for, and its database as it was then (the first port's `pin`): nothing is ever written for another.
  const mountedAccount = useRef<string | null>(null);
  const mountedScope = useRef<string | null>(null);
  const latest = useRef({ formContext, allow, port });
  latest.current = { formContext, allow, port };

  // The restore: ONCE per mount, the first time the form and the port are both there. A look that finished is never made again (the
  // account's store may be bound again later, which gives a new port), and a copy is never restored over input the person has typed since
  // the form mounted: then every copy is offered as an alternative instead.
  useEffect(() => {
    const form = formRef.current;
    if (!form) return;
    const fields = latest.current.allow;
    if (initial.current === null) {
      initial.current = read(form, fields);
      clean.current = initial.current;
    }
    if (port && mountedAccount.current === null) {
      const pinned = port.pin?.() ?? null;
      mountedAccount.current = pinned?.account ?? null;
      mountedScope.current = pinned?.scope ?? null;
    }
    if (!port || looked.current) return;
    looked.current = true;
    // The same form mounted again in its place in this page (a remount, F-1): its previous mount's input and state are put back as they
    // were, unless the person has typed into this one meanwhile, and nothing is looked for (the copies it knew of are in that state).
    const carried =
      mountedScope.current === null
        ? null
        : registry.take(formContext, mountedScope.current);
    if (carried && sameValues(read(form, fields), initial.current ?? {})) {
      const state = carried.state as CarriedState;
      restoreSnapshot(
        form,
        { formContext, tabInstanceId: "", values: carried.values, savedAt: "" },
        fields,
      );
      initial.current = state.initial ?? initial.current;
      clean.current = state.clean ?? clean.current;
      persisted.current = state.persisted;
      setReady(true);
      return;
    }
    let cancelled = false;
    let finished = false;
    void (async () => {
      const listed = await port.list(formContext);
      // What may be restored: THIS page's own copy first (the form was mounted again in the same page: another page's boot makes every
      // tab check its session, which remounts the protected tree, and the copy saved before is this tab's own latest input), then the
      // copies of tabs that have gone, newest first. Another OPEN tab's copy is never taken over.
      const own = tab.current();
      const gone: RecoverySnapshot[] = listed.filter(
        (copy) => copy.tabInstanceId === own,
      );
      for (const copy of listed)
        if (
          copy.tabInstanceId !== own &&
          !(await tab.ownerOpen(copy.tabInstanceId))
        )
          gone.push(copy);
      if (cancelled) return;
      finished = true;
      const current = formRef.current;
      const typed =
        current !== null &&
        !sameValues(read(current, fields), initial.current ?? {});
      const newest = gone[0];
      if (newest && current && !typed) {
        restoreSnapshot(current, newest, fields);
        const values = read(current, fields);
        if (newest.tabInstanceId === own)
          persisted.current = {
            ...persisted.current,
            own: { values, op: 0 },
            ownAsked: true,
          };
        else
          persisted.current = {
            ...persisted.current,
            source: { id: newest.tabInstanceId, values, newest: true },
          };
        setRestored(newest);
        setAlternatives(gone.slice(1));
      } else if (gone.length > 0) setAlternatives(gone);
      setReady(true);
    })().catch(() => {
      if (cancelled) return;
      finished = true;
      setReady(true);
    });
    return () => {
      cancelled = true;
      // Only a look that did not finish is made again (React replays effects in development).
      if (!finished) looked.current = false;
    };
  }, [port, formContext, formRef, tab, registry]);

  /** The port for a write asked for NOW, pinned to the account it reaches now; null when that is not the form's account (or none). */
  const targetOf = useCallback(
    (current: FormRecoveryPort): FormRecoveryPort | null => {
      if (!current.pin) return current;
      const pinned = current.pin();
      if (pinned === null) return null;
      if (
        mountedAccount.current !== null &&
        pinned.account !== mountedAccount.current
      )
        return null;
      return pinned.port;
    },
    [],
  );

  /** What the next page would show for this form if the page went now (R2). */
  const dirtyOf = useCallback((form: HTMLFormElement): boolean => {
    const { own, source, owed } = persisted.current;
    if (owed) return true;
    const now = read(form, latest.current.allow);
    if (own) return !sameValues(now, own.values);
    // A chosen alternative that is not the newest copy is not what the next page would restore: only a copy of this page's own makes it so.
    if (source) return !source.newest || !sameValues(now, source.values);
    return !sameValues(now, clean.current ?? {});
  }, []);
  const isDirty = useCallback((): boolean => {
    const form = formRef.current;
    return form ? dirtyOf(form) : false;
  }, [formRef, dirtyOf]);

  /**
   * Discards this form's copies (this page's own and the one it was restored from), in the hook's order at `op`: a flush asked for before
   * it writes nothing any more (R4), and the port orders it after every capture already asked for.
   */
  const discardAt = useCallback(
    async (op: number): Promise<DiscardResult> => {
      const { port: unpinned, formContext: context } = latest.current;
      const current = unpinned ? targetOf(unpinned) : null;
      const state = persisted.current;
      const ids = new Set<string>();
      const own = tab.current();
      if (own !== null && (state.ownAsked || state.own !== null)) ids.add(own);
      if (state.source !== null) ids.add(state.source.id);
      if (ids.size === 0) {
        persisted.current = { ...state, owed: false };
        return "discarded";
      }
      if (!current) {
        persisted.current = { ...persisted.current, owed: true };
        return "failed";
      }
      const results = await Promise.all(
        [...ids].map((id) =>
          current
            .discard(context, id)
            .catch((): DiscardResult => "failed")
            .then((result) => ({ id, result })),
        ),
      );
      const next = { ...persisted.current };
      let outcome: DiscardResult = "discarded";
      for (const { id, result } of results) {
        if (result === "discarded") {
          if (id === own && next.own !== null && next.own.op < op)
            next.own = null;
          if (next.source?.id === id) next.source = null;
        } else outcome = outcome === "refused" ? outcome : result;
      }
      next.owed = outcome !== "discarded";
      persisted.current = next;
      return outcome;
    },
    [tab, targetOf],
  );

  const flushOf = useCallback(
    async (form: HTMLFormElement | null): Promise<SaveResult> => {
      const {
        port: unpinned,
        formContext: context,
        allow: fields,
      } = latest.current;
      // Pinned NOW (before anything is awaited): the write reaches this account's store, or nothing.
      const current = unpinned ? targetOf(unpinned) : null;
      if (!form || !current) return "failed";
      // The capture and its place in the hook's order are fixed NOW, before anything is awaited (R4).
      order.current.next += 1;
      const op = order.current.next;
      const now = read(form, fields);
      // Back to the clean state: the copies are discarded instead, so the next page shows that state (R2).
      if (sameValues(now, clean.current ?? {})) {
        order.current.lastTerminal = op;
        const result = await discardAt(op);
        return result === "discarded" ? "saved" : result;
      }
      let captured: RecoverySnapshot;
      try {
        captured = buildSnapshot({
          form,
          formContext: context,
          tabInstanceId: "",
          allow: fields,
        });
      } catch {
        return "failed";
      }
      persisted.current = { ...persisted.current, ownAsked: true };
      let id: string;
      try {
        id = await tab.id();
      } catch {
        return "failed";
      }
      // A submission or discard asked for after this capture has overtaken it: it is obsolete and is never written (R4).
      if (order.current.lastTerminal > op) return "failed";
      const snapshot = { ...captured, tabInstanceId: id };
      const result = await current
        .save(snapshot)
        .catch((): SaveResult => "failed");
      if (result !== "saved") return result;
      const state = persisted.current;
      if (order.current.lastTerminal < op && (state.own?.op ?? -1) < op)
        persisted.current = {
          ...state,
          own: { values: captured.values, op },
          // This page's own copy is newer than every discard that did not land: nothing unwanted can be restored in its place.
          owed: state.source === null ? false : state.owed,
        };
      const source = persisted.current.source;
      if (source !== null && source.id !== id) {
        const dropped = await current
          .discard(context, source.id)
          .catch((): DiscardResult => "failed");
        if (
          dropped === "discarded" &&
          persisted.current.source?.id === source.id
        )
          persisted.current = {
            ...persisted.current,
            source: null,
            owed: false,
          };
      }
      return result;
    },
    [tab, discardAt, targetOf],
  );
  const flush = useCallback(
    (): Promise<SaveResult> => flushOf(formRef.current),
    [flushOf, formRef],
  );

  /** A terminal act, in the hook's order NOW (R4): the form's clean state becomes `cleanValues`, then the copies are discarded. */
  const terminal = useCallback(
    (cleanValues: () => Values | null): Promise<DiscardResult> => {
      order.current.next += 1;
      const op = order.current.next;
      order.current.lastTerminal = op;
      const values = cleanValues();
      if (values !== null) clean.current = values;
      persisted.current = { ...persisted.current, owed: true };
      return discardAt(op);
    },
    [discardAt],
  );

  // Registered while mounted. A form that unmounts dirty saves a copy from the element it leaves behind (F-1, above).
  useEffect(() => {
    const element = formRef.current;
    const unregister = registry.register({
      formContext,
      isDirty,
      flush,
      // "Discard and reload anyway": the input on screen is the person's to drop; what counts as clean is what it shows now.
      discard: () =>
        terminal(() => {
          const form = formRef.current;
          return form ? read(form, latest.current.allow) : null;
        }),
      freeze: () => {
        const form = formRef.current;
        if (!form) return () => undefined;
        // `inert`: no focus, no click, no typing anywhere in the form (the attribute, which every supported engine reflects).
        const before = form.hasAttribute("inert");
        form.setAttribute("inert", "");
        form.setAttribute("aria-busy", "true");
        return () => {
          if (!before) form.removeAttribute("inert");
          form.removeAttribute("aria-busy");
        };
      },
    });
    return () => {
      unregister();
      // Memory only, and only for this account's database: a remount in this page takes it back (F-1).
      const scope = mountedScope.current;
      if (element && scope !== null && dirtyOf(element)) {
        const state: CarriedState = {
          initial: initial.current,
          clean: clean.current,
          persisted: persisted.current,
        };
        registry.carry(formContext, {
          scope,
          values: read(element, latest.current.allow),
          state,
        });
      }
    };
  }, [registry, formContext, formRef, isDirty, flush, dirtyOf, terminal]);

  const onSubmitted = useCallback(async (): Promise<DiscardResult> => {
    const result = terminal(() => {
      const form = formRef.current;
      return form ? read(form, latest.current.allow) : null;
    });
    setRestored(null);
    return result;
  }, [terminal, formRef]);

  const discard = useCallback(async (): Promise<DiscardResult> => {
    const result = terminal(() => {
      const form = formRef.current;
      const before = initial.current;
      if (form && before)
        restoreSnapshot(
          form,
          {
            formContext: latest.current.formContext,
            tabInstanceId: "",
            values: before,
            savedAt: "",
          },
          latest.current.allow,
        );
      return before;
    });
    setRestored(null);
    return result;
  }, [terminal, formRef]);

  const restoreAlternative = useCallback(
    (tabInstanceId: string) => {
      const form = formRef.current;
      const chosen = alternatives.find(
        (copy) => copy.tabInstanceId === tabInstanceId,
      );
      if (!form || !chosen) return;
      restoreSnapshot(form, chosen, latest.current.allow);
      const values = read(form, latest.current.allow);
      setAlternatives((others) => [
        ...(restored ? [restored] : []),
        ...others.filter((copy) => copy.tabInstanceId !== tabInstanceId),
      ]);
      // The copy restored before is still in the store (and newer): only a copy of this page's own makes the chosen one what comes back.
      persisted.current = {
        ...persisted.current,
        source: { id: chosen.tabInstanceId, values, newest: false },
      };
      setRestored(chosen);
    },
    [alternatives, restored, formRef],
  );

  return {
    restored,
    alternatives,
    restoreAlternative,
    ready,
    onSubmitted,
    discard,
  };
}
