import type { FormRecoveryRow, IsoInstant } from "../model/types";
import { w } from "../store/port";
import { singletonPlan } from "./builders";

/**
 * W9: the form-recovery copy (Q4, WEB-04 design D:2053). One row per `[form_context, tab_instance_id]`, so two tabs editing the
 * same form never overwrite one another.
 *
 * Every write transaction's scope includes `sync_state`, because the `closing` argument depends on overlapping-scope ordering
 * (D:919-934): a write that was created before `setClosing` finishes first and is counted by the digest, and one created after
 * sees `closing` and is REFUSED. A test asserts the scope (MU-15).
 *
 * ORDER OF CAPTURES (R1, revision 6; reopened and corrected in revision 19). A capture is ordered by `(writer_gen, capture_seq)`. The
 * generation is CLAIMED, durably, by a page context before its first write (`claimFormWriter`, in its own transaction), and the sequence is
 * assigned when the capture is ASKED FOR, in call order, not when it is written. A write is admitted INSIDE the transaction only if
 * it is after the stored capture in that order (a terminal one, `>=`), so an obsolete capture (one that waited in a quota estimate,
 * a retry or an earlier port instance while a later capture was written) is refused whatever its sequence number says, and is
 * FINAL: nothing ever re-numbers it above the newer one. A new writer initialising does not need to reconcile anything: its
 * claim is the generation above every one handed out before it.
 *
 * ONE ORDER FOR EVERY CLAIM (R1, revision 19). The invariant: *every claim of a form and tab, whether or not the form has a row when it
 * is made, is a generation no other claim has had and above every claim made before it, including a claim whose capture has not landed.*
 * Revision 18 broke it by giving a claim of an EXISTING row `stored + 1` and a claim of an absent one the database counter + 1, and only
 * the second moved the counter: with A and B claiming while the row was absent (generations 1 and 2), A's save landing, and a later
 * context C claiming the row, C was handed 2 as well, so B's second pending capture (generation 2, sequence 2) overwrote C's newer text
 * (and a pending discard of B's, or an older save after C's discard, did the same harm). Now both paths take
 * `max(the database's counter, the stored generation) + 1` and BOTH move the counter (`form_writer_gen`, in the `sync_state` row
 * that every claim's transaction already holds), so the transaction order of the claims is the order of the generations. The stored
 * generation is in the maximum for a row written before the counter existed (or seeded above it). A generation is never reused,
 * never lowered and never re-numbered above a later claim: where no unique one can be issued (the counter row is missing, a value is
 * not a non-negative safe integer, or the next would pass `Number.MAX_SAFE_INTEGER`, where integers stop being told apart) the claim
 * answers `no_generation`, nothing is written, the capture fails, and an existing text is untouched. Terminal rows are overwritten in place with their fields cleared and are never
 * hard-deleted (a hard delete could not be ordered against a late write), and they keep their `(writer_gen, capture_seq)`, so a
 * capture taken before a discard cannot resurrect the text the person discarded.
 *
 * NO ROW IS CREATED BEFORE ITS WRITE HAS BEEN ADMITTED (R33, revision 18). A recovery row is the person's text, and a new key is growth like
 * a draft: the quota guard admits it (the port reserves the WHOLE row and its keys) before this plan is asked to write one. The claim of a
 * generation therefore writes only what is already there (an existing row's order record, or the database's counter), and `saveFormRecovery`
 * is the only writer of a new row (a discard of a form that has no row would create one, and is admitted the same way).
 */
export interface FormWrite {
  incarnationId: string;
  row: FormRecoveryRow;
  /**
   * The quota reservation's `live()` (R28, revision 14): the copy was admitted under a hold that the origin's other pages count only
   * while it stands, so it may begin only while it does. Absent for a write that reserved nothing (a discard, the claim).
   */
  leaseLive?: () => boolean;
  /**
   * `false`: the write is not to CREATE a row (R33, revision 18). A form with no row answers `absent` and nothing is written, so that the
   * port can admit the new row with the quota guard first (a discard's terminal row: with a row it replaces what is there with less,
   * with none it is growth). Absent: the write may create one, because the port has admitted it (a save).
   */
  mayCreate?: boolean;
}

export type FormWriteResult =
  /** Written. */
  | { kind: "saved" }
  /**
   * THIS content is already stored, so the capture is durable. Nothing but the order record moves (and only when this capture is
   * after the stored one): no `saved_at` bump and no change of `content_digest`, so the digest of the unsynced work does not move.
   */
  | { kind: "unchanged" }
  /**
   * Nothing written, and this capture is NOT durable: a capture taken after it is. FINAL; the stored text is the newer one, and
   * nothing is retried above it.
   */
  | { kind: "superseded" }
  /** `closing` is set: "can't save, signing out". Nothing was written. */
  | { kind: "refused" }
  /** The hold the copy was admitted under has ended (R28): nothing was written; the port admits it again. */
  | { kind: "lease_lapsed" }
  /** The form has no row and the write was not to create one (`mayCreate: false`): nothing was written. */
  | { kind: "absent" };

const generationOf = (row: Pick<FormRecoveryRow, "writer_gen">): number =>
  row.writer_gen ?? 0;

/**
 * Whether `incoming` is after `stored` in the order of captures: the writer generation first, then the sequence within it. A
 * terminal write (a discard) also wins a tie, so it overtakes the capture it was asked after in the same step.
 */
export function capturedAfter(
  incoming: Pick<FormRecoveryRow, "writer_gen" | "capture_seq" | "terminal">,
  stored: Pick<FormRecoveryRow, "writer_gen" | "capture_seq">,
): boolean {
  const incomingGen = generationOf(incoming);
  const storedGen = generationOf(stored);
  if (incomingGen !== storedGen) return incomingGen > storedGen;
  return incoming.terminal
    ? incoming.capture_seq >= stored.capture_seq
    : incoming.capture_seq > stored.capture_seq;
}

export const saveFormRecovery = singletonPlan<
  FormWrite,
  FormRecoveryRow | undefined,
  FormWriteResult
>({
  name: "data.saveFormRecovery",
  meta: { writer: "W9", guards: ["INC", "CLS"], quota: "input" },
  scope: ["form_recovery"],
  durability: "strict",
  read: (reader, input) =>
    reader.get("form_recovery", [
      input.row.form_context,
      input.row.tab_instance_id,
    ]),
  decide: ({ sync, reads: stored, input }) => {
    if (sync?.draft_fence?.closing === true)
      return { result: { kind: "refused" } };
    // In the step that decides what is written: a copy whose hold has ended writes nothing (R28, revision 14).
    if (input.leaseLive !== undefined && !input.leaseLive())
      return { result: { kind: "lease_lapsed" } };
    const incoming = input.row;
    if (!stored && input.mayCreate === false)
      return { result: { kind: "absent" } };
    if (stored) {
      const after = capturedAfter(incoming, stored);
      // The same content again is durable whatever its number: it is judged BEFORE the order. It writes no content, so the
      // digest of the unsynced work does not move and an autosave landing between the fence transaction and the recount cannot
      // cause a spurious renewed-consent prompt. When this capture is the later one the ORDER record moves up (and only that), so
      // an earlier capture with other content that is still on its way cannot land above it.
      if (
        !incoming.terminal &&
        !stored.terminal &&
        stored.content_digest === incoming.content_digest
      )
        return after
          ? {
              writes: [
                w.put("form_recovery", {
                  ...stored,
                  writer_gen: generationOf(incoming),
                  capture_seq: incoming.capture_seq,
                }),
              ],
              result: { kind: "unchanged" },
            }
          : { result: { kind: "unchanged" } };
      if (!after) return { result: { kind: "superseded" } };
    }
    return {
      writes: [w.put("form_recovery", incoming)],
      result: { kind: "saved" },
    };
  },
});

export interface FormClaim {
  incarnationId: string;
  formContext: string;
  tabInstanceId: string;
  now: IsoInstant;
}

export type FormClaimResult =
  /**
   * The generation this page context writes this form under: above every generation stored before, and above every other claim, of a
   * form that had a row and of one that had none (R1, revision 19). A claim of a form with no row creates NOTHING (R33, revision 18);
   * whether a row exists is not part of the answer, because it is not true for longer than the transaction that read it (the write that
   * needs to know asks at the time it writes).
   */
  | { kind: "claimed"; gen: number }
  /** `closing` is set: nothing was written, and nothing can be saved. */
  | { kind: "refused" }
  /**
   * No unique generation can be issued (R1, revision 19): the `sync_state` row that holds the counter is missing, the counter or the
   * stored generation is not a non-negative safe integer, or the next generation would pass `MAX_WRITER_GEN`. Nothing was written. The
   * capture fails (the port answers `failed`); the claim is never answered with a generation that another claim may already have had.
   */
  | { kind: "no_generation" };

/** The last generation that can be handed out: above it two integers are no longer told apart, and two claims could be given one. */
export const MAX_WRITER_GEN = Number.MAX_SAFE_INTEGER;

const isGeneration = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * Claims the next writer generation of a form and tab, durably. Once per page context and form, before its first capture can be
 * written, in a transaction created when the capture is asked for (R1: that is what orders the contexts). An existing row keeps its
 * content (the claim moves the order record, `writer_gen` up and `capture_seq` back to 0, and nothing else, so neither `saved_at` nor
 * `content_digest` changes and the digest of the unsynced work does not move: a rewrite of a row that is there, bounded by what it
 * already holds, is not growth).
 *
 * WITH NO ROW THE CLAIM CREATES NOTHING (R33, revision 18). It used to write an empty terminal row carrying the caller's form context and
 * tab id, and a new row is GROWTH: it was written before the quota guard had been asked, so a refused save left it behind (with whatever
 * length of key the caller supplied), and below the floor a first claim still created a record. The row is created by the save that was
 * ADMITTED, and by nothing else. The claim is refused while `closing` is set, like every other write of this store.
 *
 * ONE COUNTER ORDERS EVERY CLAIM (R1, revision 19). The generation is `max(counter, stored generation) + 1`, and the counter moves to it
 * whether or not the form has a row (the `sync_state` row is in every plan's scope, so claims are ordered by the transaction order, and a
 * claim whose capture has not landed yet still holds its generation). Revision 18 moved the counter only for a form with no row, and took
 * `stored + 1` for one with a row, so a claim made while another's save was still waiting could be given the generation that other claim
 * already held, and the later context's newer text could be overwritten by the earlier one's second capture.
 */
export const claimFormWriter = singletonPlan<
  FormClaim,
  FormRecoveryRow | undefined,
  FormClaimResult
>({
  name: "data.claimFormWriter",
  meta: { writer: "W9", guards: ["INC", "CLS"], quota: "input" },
  scope: ["form_recovery"],
  durability: "strict",
  read: (reader, input) =>
    reader.get("form_recovery", [input.formContext, input.tabInstanceId]),
  decide: ({ sync, reads: stored }) => {
    if (sync?.draft_fence?.closing === true)
      return { result: { kind: "refused" } };
    // Without the row that holds the counter nothing can say what has been handed out, and a generation guessed (1) could be one that
    // another claim has: fail closed, nothing written.
    if (sync === undefined) return { result: { kind: "no_generation" } };
    const counter = sync.form_writer_gen ?? 0;
    const held = stored === undefined ? 0 : (stored.writer_gen ?? 0);
    if (!isGeneration(counter) || !isGeneration(held))
      return { result: { kind: "no_generation" } };
    // A row written before the counter existed (or seeded above it) can hold more than it, so both are in the maximum.
    const gen = Math.max(counter, held) + 1;
    if (gen > MAX_WRITER_GEN) return { result: { kind: "no_generation" } };
    // The sequence of an existing row restarts at 0 in the new generation: the order is the generation first, so `(gen, 0)` is already
    // after every capture of an earlier generation, and the claimant's first capture (sequence 1) is after the claim. With no row there is
    // nothing to move: only the counter.
    return {
      ...(stored === undefined
        ? {}
        : {
            writes: [
              w.put("form_recovery", {
                ...stored,
                writer_gen: gen,
                capture_seq: 0,
              }),
            ],
          }),
      sync: { ...sync, form_writer_gen: gen },
      result: { kind: "claimed", gen },
    };
  },
});

/** The snapshot for one form, or null. A terminal row has had its fields cleared and reads as nothing. READONLY. */
export const loadFormRecovery = singletonPlan<
  { incarnationId: string; formContext: string; tabInstanceId: string },
  FormRecoveryRow | undefined,
  FormRecoveryRow | null
>({
  name: "data.loadFormRecovery",
  // A read is not refused by `closing` (restoring a copy after a reload is not a write); it needs only its incarnation.
  meta: { writer: "W9", guards: ["INC"], quota: null },
  scope: ["form_recovery"],
  mode: "readonly",
  durability: "default",
  read: (reader, input) =>
    reader.get("form_recovery", [input.formContext, input.tabInstanceId]),
  decide: ({ reads: stored }) => ({
    result: stored && !stored.terminal ? stored : null,
  }),
});
