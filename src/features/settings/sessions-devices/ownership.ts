import {
  createContext,
  createElement,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
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
 * The interactions owned by one component, across its effect's setups and cleanups (WEB-08d revision 17, after review r16: a press
 * in the moment between a component's first render and its effects lost its outcome under React StrictMode).
 *
 * A GENUINE unmount ends every interaction still open, at once (the screen was left, or the tree replaced). In development, React
 * StrictMode disconnects a just-mounted component's effects once, right after their FIRST setup and in the same turn, and reconnects
 * them; that simulated unmount must not end what a press began before the effects ran. So only the first cleanup, and only in the
 * turn of the first setup, DETACHES the interactions instead: none is current (nothing is retried, nothing is shown) until the end of
 * that turn; a reconnect in the turn attaches them again, and without one they end then. Every later cleanup ends them at once, in the
 * same turn or later; production React never simulates an unmount, so there every cleanup ends them at once. Dismissal and a change of
 * identity are unaffected (`end()` and the identity check act directly). Two development-only residuals, recorded in the revision-17
 * report: StrictMode also simulates an unmount when a Suspense boundary reveals hidden content, which ends them as before this change;
 * and outside StrictMode a genuine unmount in the turn of the first setup withdraws one microtask late (none is current at once).
 */
export interface InteractionLifetime {
  /** Tracks an interaction for this component; the one returned is not current while detached. */
  adopt(interaction: Interaction): Interaction;
  /** The effect's setup: attaches, and returns the cleanup. */
  connect(): () => void;
}

export function interactionLifetime(
  development: boolean = import.meta.env.DEV,
): InteractionLifetime {
  const open = new Set<Interaction>();
  let detached = false;
  let setups = 0;
  const endAll = () => {
    for (const interaction of [...open]) interaction.end();
    open.clear();
  };
  return {
    adopt: (inner) => {
      const interaction: Interaction = {
        id: inner.id,
        scope: inner.scope,
        withdraw: inner.withdraw,
        current: () => !detached && inner.current(),
        end: inner.end,
      };
      open.add(interaction);
      interaction.withdraw.addEventListener(
        "abort",
        () => open.delete(interaction),
        { once: true },
      );
      return interaction;
    },
    connect: () => {
      detached = false;
      setups += 1;
      const first = setups === 1;
      let sameTurn = true;
      queueMicrotask(() => {
        sameTurn = false;
      });
      return () => {
        if (!development || !first || !sameTurn) return endAll();
        detached = true;
        queueMicrotask(() => {
          if (detached) endAll();
        });
      };
    },
  };
}

/**
 * Interactions owned by one component: each begins in an event handler, and every one still open ends when the component unmounts
 * (the screen was left, or the tree replaced), or when the dialog it sits in is dismissed (`DismissalScopeProvider`). Nothing begins
 * in an effect, so StrictMode's second mount revives nothing; and its simulated unmount ends nothing (`interactionLifetime`).
 */
export function useInteractions(): { begin(): Interaction } {
  const session = useSession();
  const dismissal = useContext(ScopeContext);
  const [lifetime] = useState(() => interactionLifetime());
  useEffect(() => lifetime.connect(), [lifetime]);
  return useMemo(
    () => ({
      begin: () => {
        const interaction = lifetime.adopt(beginInteraction(session));
        dismissal?.track(interaction);
        return interaction;
      },
    }),
    [session, dismissal, lifetime],
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

/**
 * WEB08D-NAVIGATION-FRESHNESS-20261011: a list on screen reads again, quietly, when the person comes back to this tab (it becomes
 * visible) or to its window (it regains focus while visible). One return is one refresh: the page is "away" from `hidden` or the
 * window's `blur` until the first of those notifications, and `refresh` itself never doubles a read in flight. Nothing is read
 * while no identity is settled or the browser says it is offline (the screen's offline presentation stays), and the answer is
 * shown only while the identity the return happened under is still the one settled. The listeners live as long as the list.
 * There is no polling: a tab left visible, a suspended or offline browser, or a change committed after the read is not seen until
 * the next return, entry, Retry or change made on this page.
 */
export function useReturnRefresh(
  refresh: (isCurrent: () => boolean) => void,
): void {
  const session = useSession();
  useEffect(() => {
    let away = false;
    const leave = () => {
      away = true;
    };
    const back = () => {
      if (!away || document.visibilityState !== "visible") return;
      away = false;
      const scope = scopeOf(session.identity.get());
      if (scope === null || !navigator.onLine) return;
      refresh(() => scopeOf(session.identity.get()) === scope);
    };
    const visibility = () => {
      if (document.visibilityState === "visible") back();
      else leave();
    };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("blur", leave);
    window.addEventListener("focus", back);
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("blur", leave);
      window.removeEventListener("focus", back);
    };
  }, [session, refresh]);
}
