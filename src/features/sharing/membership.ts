import { useCallback, useEffect, useRef, useState } from "react";
import type { SnapshotHousehold } from "../../data";
import { type SharingFailure, type SharingResult, untilSent } from "./api";

/** The households one `GET /households` answer listed, and when it answered. */
export interface Inventory {
  households: readonly SnapshotHousehold[];
  at: number;
}

/**
 * The caller's COMPLETE household membership, as `GET /households` lists it: the editing metadata of the grant editors (WEB-12a R11). It
 * is NOT the B5 record's `households`, which names only the primary household and the households the RESOLVED defaults name (so a
 * membership a resolved default does not name, or one only an overridden template names, is absent from it). The two are never merged:
 * B5 stays the revision evidence of the defaults (capture, Was and Now, W14), and this list is read on its own, at its own time, only
 * for what a person can add and how a granted household is named while editing.
 *
 * Only `ready` is the complete list of the latest read. `loading` and `failed` keep the last list this editor read (`last`) for NAMES
 * only: they prove neither that you are in no household nor that you left one, and nothing can be added from them.
 */
export type Membership =
  | { status: "idle"; last: Inventory | null }
  | { status: "loading"; last: Inventory | null }
  | { status: "ready"; current: Inventory }
  | { status: "failed"; failure: SharingFailure; last: Inventory | null };

/** The households this editor knows names for: the complete list when ready, else the last one it read (or none). */
export const knownMembership = (membership: Membership): Inventory | null =>
  membership.status === "ready" ? membership.current : membership.last;

const IDLE: Membership = { status: "idle", last: null };
const LOADING: Membership = { status: "loading", last: null };
const sameTarget = (a: readonly unknown[], b: readonly unknown[]) =>
  a.length === b.length && a.every((value, at) => Object.is(value, b[at]));

/**
 * The membership list of ONE target (`[client]`: the displayed account and epoch), read when the editor opens online, again each time
 * it comes back online, and on `retry` (admitted only while enabled). Each read supersedes the earlier ones: an answer to an older read,
 * to another target, or after unmount is dropped. Reading it never touches what the editor is composing (drafts, versions, attempts):
 * it is metadata, with its own loading and failure states. Nothing about it is stored on the device.
 */
export function useMembership(options: {
  enabled: boolean;
  read(): Promise<SharingResult<SnapshotHousehold[]>>;
  now(): number;
  target: readonly unknown[];
}): [Membership, () => void] {
  const [state, setState] = useState<{
    target: readonly unknown[];
    membership: Membership;
  }>(() => ({ target: options.target, membership: IDLE }));
  const generation = useRef(0);
  const reader = useRef(options.read);
  reader.current = options.read;
  const now = useRef(options.now);
  now.current = options.now;
  const enabled = useRef(options.enabled);
  enabled.current = options.enabled;
  const target = useRef(options.target);
  const run = useCallback(() => {
    if (!enabled.current) return;
    const mine = ++generation.current;
    const asked = target.current;
    // What this target's list said before stays for names while the new read is on its way, never another target's.
    const lastOf = (prior: {
      target: readonly unknown[];
      membership: Membership;
    }) =>
      sameTarget(prior.target, asked)
        ? knownMembership(prior.membership)
        : null;
    setState((prior) => ({
      target: asked,
      membership: { status: "loading", last: lastOf(prior) },
    }));
    const settle = (result: SharingResult<SnapshotHousehold[]>) => {
      if (mine !== generation.current) return;
      setState((prior) => ({
        target: asked,
        membership: result.ok
          ? {
              status: "ready",
              current: { households: result.value, at: now.current() },
            }
          : { status: "failed", failure: result, last: lastOf(prior) },
      }));
    };
    void untilSent(() => reader.current(), {
      isCurrent: () => mine === generation.current,
    }).then(settle, () => settle({ ok: false, kind: "uncertain" }));
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the target's elements are the dependencies (a fixed number per caller)
  useEffect(() => {
    if (!sameTarget(target.current, options.target)) {
      // Another target: nothing asked for the old one may land.
      generation.current += 1;
      target.current = options.target;
    }
    // Opening online, coming back online, or another target: read the list again.
    if (options.enabled) run();
  }, [options.enabled, run, ...options.target]);
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );
  const current = sameTarget(state.target, options.target)
    ? state.membership
    : options.enabled
      ? LOADING
      : IDLE;
  return [current, run];
}
