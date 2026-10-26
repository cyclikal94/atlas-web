import { lineageOf } from "./control-state";
import {
  forgetHandoff,
  HANDOFF_PREFIX,
  handoffContext,
  handoffFor,
} from "./handoff";
import {
  type CopyTarget,
  type FormRecoveryPort,
  type RecoverySnapshot,
  readCopies,
  readCopy,
} from "./port";
import type { FormSession } from "./session";

/**
 * THE LOOK FOR WHAT WAS LEFT TO A FORM (WEB-14a revision 37, R40; design assessment C2). Moved here unchanged from `useRecoverableForm` so the
 * DOM hook and the model adapter (`model.ts`) read, choose and adopt a copy by ONE rule: the hand-off left to this page (read only while its
 * lock is held), this page's own copy, the copies of tabs that have gone and the hand-offs no live page holds; a read that cannot be made
 * makes the whole look unknown (`null`), never an empty answer (revision 7, R13 and R15).
 */

/** Revision 6 (R13): whether a copy offered is an update hand-off (a page's that never came back, or one left to this page). */
export const isHandoff = (copy: RecoverySnapshot): boolean =>
  copy.formContext.startsWith(HANDOFF_PREFIX);

/** How long the next page waits for the hand-off left to it while another page holds it (revision 6, R13). */
export const HANDOFF_CLAIM_WAIT_MS = 2_000;

/** What a look read (revision 7): the hand-off held and read just now, the gone tabs' copies, the abandoned hand-offs, this page's id. */
export interface Found {
  handed: RecoverySnapshot | null;
  gone: RecoverySnapshot[];
  left: RecoverySnapshot[];
  own: string | null;
}

/**
 * Every read of a look through `through`, pinned by the caller when the look began; null when one could not be made (nothing is then known).
 * `restore`: the hand-off this tab's previous page left for the form comes first (its lock first, then the read; without the lock it is
 * neither read nor shown). `offer`: only the copies other tabs left.
 */
export async function readLeft(
  current: FormSession,
  through: FormRecoveryPort,
  mode: "restore" | "offer",
): Promise<Found | null> {
  const context = current.formContext;
  let handed: RecoverySnapshot | null = null;
  if (mode === "restore") {
    const left = handoffFor(current.handoffs, context, current.scope);
    if (left.kind === "unknown") return null;
    if (
      left.kind === "left" &&
      (await (current.tab.holdHandoff?.(left.id, HANDOFF_CLAIM_WAIT_MS) ??
        true))
    ) {
      const found = await readCopy(through, handoffContext(context), left.id);
      if (found.kind === "unavailable") return null;
      if (found.kind === "found") handed = found.copy;
      // Resolved already (its page submitted or discarded it): nothing to take over; the stale reference goes (this page holds it).
      else forgetHandoff(current.handoffs, left.id);
    }
  }
  const listed = await readCopies(through, context);
  if (listed.kind === "unavailable") return null;
  // What may be restored: THIS page's own copy first (the form was mounted again in the same page after its session ended), then the
  // copies of tabs that have gone, newest first. Another OPEN tab's copy is never taken over.
  const own = current.tab.current();
  const gone: RecoverySnapshot[] = listed.copies.filter(
    (copy) => copy.tabInstanceId === own,
  );
  for (const copy of listed.copies)
    if (
      copy.tabInstanceId !== own &&
      !(await current.tab.ownerOpen(copy.tabInstanceId))
    )
      gone.push(copy);
  // Hand-offs no live page holds (their page never came back): offered, never restored at once, never removed by this page.
  const abandoned = await readCopies(through, handoffContext(context));
  if (abandoned.kind === "unavailable") return null;
  const left: RecoverySnapshot[] = [];
  for (const copy of abandoned.copies)
    if (
      copy.tabInstanceId !== handed?.tabInstanceId &&
      !current.handoffs.written.has(copy.tabInstanceId) &&
      !(await (current.tab.handoffHeld?.(copy.tabInstanceId) ?? false))
    )
      left.push(copy);
  return { handed, gone, left, own };
}

/**
 * Revision 8 (R16, DA-C): whether `copy` is one of the copies a hand-off's lineage names, by its exact key and the capture named (a copy
 * named by key alone, written before captures had identities, by its key). Equal text never makes a copy part of a lineage.
 */
export const inLineage = (
  lineage: readonly CopyTarget[],
  copy: RecoverySnapshot,
): boolean =>
  lineage.some(
    (target) =>
      target.formContext === copy.formContext &&
      target.tabInstanceId === copy.tabInstanceId &&
      (target.capture === null || target.capture === copy.capture),
  );

/** What a look found, in order: the candidates to restore (newest first), the hand-off's lineage, and what is offered beside a copy shown. */
export interface Choice {
  candidates: RecoverySnapshot[];
  lineage: readonly CopyTarget[];
  offered(shown: RecoverySnapshot | null): RecoverySnapshot[];
}

/**
 * Revision 8 (R16; design assessment C3, DA-C): the copies the hand-off's page owed the removal of, named exactly in the hand-off, are part of
 * the hand-off and are not offered on their own; a copy it does not name is another branch, offered whatever text it holds. This page's own
 * copy first (it is newer than anything left to it), then the hand-off, then the gone tabs' copies.
 */
export function chooseLeft(current: FormSession, found: Found): Choice {
  const { handed, gone, left, own } = found;
  const lineage = handed ? lineageOf(handed) : [];
  // What the session already owes the removal of (a source taken earlier, a clean-up not landed yet) is its continuation too.
  const owing = [
    ...lineage,
    ...(current.persisted.source?.lineage ?? []),
    ...current.persisted.debts,
  ];
  const ownCopy = gone.filter((copy) => copy.tabInstanceId === own);
  const candidates = [
    ...ownCopy,
    ...(handed ? [handed] : []),
    ...gone.filter(
      (copy) => copy.tabInstanceId !== own && !inLineage(owing, copy),
    ),
  ];
  return {
    candidates,
    lineage,
    offered: (shown) => [
      ...candidates.filter((copy) => copy !== shown),
      ...left.filter((copy) => !inLineage(owing, copy)),
    ],
  };
}

/**
 * The session takes `newest` as what it was restored from (revision 10, R11: `values` is ALL the copy holds): the hand-off left to this page
 * and held by it is its source with the copies its lineage names; this page's own copy is its own; any other is a gone tab's source.
 */
export function adoptCopy(
  current: FormSession,
  newest: RecoverySnapshot,
  values: Record<string, string>,
  found: Found,
  lineage: readonly CopyTarget[],
): void {
  const capture = newest.capture ?? null;
  if (newest === found.handed)
    current.persisted = {
      ...current.persisted,
      source: {
        id: newest.tabInstanceId,
        context: newest.formContext,
        values,
        capture,
        lineage,
        at: current.order.next,
      },
    };
  else if (newest.tabInstanceId === found.own)
    current.persisted = {
      ...current.persisted,
      own: { values, op: 0, capture },
      ownAsked: true,
    };
  else
    current.persisted = {
      ...current.persisted,
      source: {
        id: newest.tabInstanceId,
        context: current.formContext,
        values,
        capture,
        lineage: [],
        at: current.order.next,
      },
    };
}
