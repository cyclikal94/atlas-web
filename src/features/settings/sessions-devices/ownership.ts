import { useEffect, useMemo, useRef } from "react";
import { type Identity, type Session, useSession } from "../../../session";

/**
 * WEB-08d (review R1 and R3, design assessment of 11 October 2026): three lifetimes, kept apart.
 *
 * - An INTERACTION is one opening of a dialog, or one press of a row's action. It alone may make another attempt (the quiet
 *   `not_sent` retries) and it alone may show its outcome (a message, an announcement, closing its own dialog). Dismissing or
 *   replacing it, leaving the screen, or a change of identity ends it at once. Its `withdraw` signal travels with the request, so a
 *   request that has not been issued by then never is.
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
 * Interactions owned by one component: each begins in an event handler, and every one still open ends when the component unmounts
 * (the screen was left, or the tree replaced). Nothing begins in an effect, so StrictMode's second mount revives nothing.
 */
export function useInteractions(): { begin(): Interaction } {
  const session = useSession();
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
        return interaction;
      },
    }),
    [session],
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
