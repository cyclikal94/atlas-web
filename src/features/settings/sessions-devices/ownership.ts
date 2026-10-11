import {
  createContext,
  createElement,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type Identity, type Session, useSession } from "../../../session";

/**
 * WEB-08d (review R1 and R3, design assessment of 11 October 2026): three lifetimes, kept apart.
 *
 * - An INTERACTION is one opening of a dialog, or one press of a row's action. It alone may make another attempt (the quiet
 *   `not_sent` retries) and it alone may show its outcome (a message, an announcement, closing its own dialog). Dismissing or
 *   replacing it, leaving the screen, or a change of identity ends it at once. Its `withdraw` signal travels with the request, so a
 *   request that has not been issued by then never is. A completion asks `current()` BEFORE it calls `end()` (review R4): only then
 *   may it change what the person sees (fields, busy state, a message, an announcement, focus, closing). Ending its own operation
 *   (a lock, a ref) needs no permission.
 * - What an ISSUED request may have changed on the server outlives the interaction: a confirmed change, or one whose outcome is
 *   unknown, is reported with `reconcileLists` for the identity (account and epoch) the request was made under, even when the
 *   dialog has gone.
 * - The LISTS on screen read again when told, whichever screen or dialog made the change, while that identity is still the one
 *   settled. A screen that mounts later reads anyway.
 *
 * Page memory only: no name, row, label or credential is kept here, and nothing is shared with other tabs.
 */
export type Scope = string;

export const scopeOf = (identity: Identity | null): Scope | null =>
  identity ? `${identity.account_id}:${identity.epoch}` : null;

export interface Interaction {
  /** Unique on the page: the key of the dialog it opened, so reopening the same row is a new dialog. */
  readonly id: number;
  /** The identity it began under; null when none was settled (it is then never current). */
  readonly scope: Scope | null;
  /** Aborted when the interaction ends; passed to the operation (`SendOptions.withdraw`). */
  readonly withdraw: AbortSignal;
  /** May it still make an attempt, or show what came of one? False once ended, or once the identity moved on. */
  current(): boolean;
  /** Ends it, synchronously. Idempotent. */
  end(): void;
}

let sequence = 0;

export function beginInteraction(session: Session): Interaction {
  const controller = new AbortController();
  const scope = scopeOf(session.identity.get());
  return {
    id: ++sequence,
    scope,
    withdraw: controller.signal,
    current: () =>
      !controller.signal.aborted &&
      scope !== null &&
      scopeOf(session.identity.get()) === scope,
    end: () => controller.abort(),
  };
}

/**
 * WEB-08d review R4: a dialog whose forms begin their own interactions (Signing in) is dismissed by navigating away, and its forms
 * unmount only when the route has changed, a moment later. An answer arriving in that moment belongs to nobody, so the dialog ends
 * every interaction begun inside it in the dismissal itself, synchronously, before it navigates. Only interactions begun BEFORE the
 * dismissal end: a dialog that stays open after all (a navigation that did not happen) keeps working.
 */
export interface DismissalScope {
  /** Ends every interaction begun inside the scope that is still open. */
  dismiss(): void;
  /** Used by `useInteractions` inside the scope. */
  track(interaction: Interaction): void;
}

const ScopeContext = createContext<DismissalScope | null>(null);

function createScope(): DismissalScope {
  const open = new Set<Interaction>();
  return {
    track: (interaction) => {
      open.add(interaction);
      interaction.withdraw.addEventListener(
        "abort",
        () => open.delete(interaction),
        { once: true },
      );
    },
    dismiss: () => {
      for (const interaction of [...open]) interaction.end();
    },
  };
}

/** One scope per mounted dialog: give it to `DismissalScopeProvider`, and call `dismiss()` first in the dialog's close handler. */
export function useDismissalScope(): DismissalScope {
  const [scope] = useState(createScope);
  return scope;
}

export function DismissalScopeProvider({
  scope,
  children,
}: {
  scope: DismissalScope;
  children: ReactNode;
}) {
  return createElement(ScopeContext.Provider, { value: scope }, children);
}

/**
 * Interactions owned by one component: each begins in an event handler, and every one still open ends when the component unmounts
 * (the screen was left, or the tree replaced), or when the dialog it sits in is dismissed (`DismissalScopeProvider`). Nothing begins
 * in an effect, so StrictMode's second mount revives nothing.
 */
export function useInteractions(): { begin(): Interaction } {
  const session = useSession();
  const dismissal = useContext(ScopeContext);
  const open = useRef(new Set<Interaction>());
  useEffect(() => {
    const owned = open.current;
    return () => {
      for (const interaction of owned) interaction.end();
      owned.clear();
    };
  }, []);
  return useMemo(
    () => ({
      begin: () => {
        const interaction = beginInteraction(session);
        open.current.add(interaction);
        interaction.withdraw.addEventListener(
          "abort",
          () => open.current.delete(interaction),
          { once: true },
        );
        dismissal?.track(interaction);
        return interaction;
      },
    }),
    [session, dismissal],
  );
}

const readers = new WeakMap<Session, Set<() => void>>();

/**
 * A list on screen: `reload` runs when a change may have changed what the server answers it. Its own reads are stamped with the
 * identity settled when they are made, so it needs no identity of its own here. Returns the unsubscribe.
 */
export function subscribeLists(
  session: Session,
  reload: () => void,
): () => void {
  let set = readers.get(session);
  if (!set) {
    set = new Set();
    readers.set(session, set);
  }
  const reader = () => reload();
  set.add(reader);
  return () => {
    set.delete(reader);
  };
}

/**
 * The server may have changed what the session and device lists show (a confirmed change, or one whose outcome is unknown) for the
 * identity `scope`: every list on screen reads again, once, if that identity is still the one settled. Nothing is read for an
 * identity that is no longer settled: the new one's screens read for themselves.
 */
export function reconcileLists(session: Session, scope: Scope | null): void {
  if (scope === null || scopeOf(session.identity.get()) !== scope) return;
  for (const reload of [...(readers.get(session) ?? [])]) reload();
}

/** Subscribes a list's `reload` (stable: `useLoad`'s) for as long as the component is mounted. */
export function useListChanges(reload: () => void): void {
  const session = useSession();
  useEffect(() => subscribeLists(session, reload), [session, reload]);
}
