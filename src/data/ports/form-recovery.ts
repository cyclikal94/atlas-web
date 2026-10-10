import type {
  FormRecoveryPort,
  RecoverySnapshot,
} from "../../lib/form-recovery/port";
import type { AccountService } from "../engine/account-service";
import type { QuotaGuard, QuotaReservation } from "../engine/quota-guard";
import { digestOf } from "../model/canonical";
import type { FormRecoveryRow } from "../model/types";
import {
  claimFormWriter,
  type FormClaimResult,
  type FormWriteResult,
  loadFormRecovery,
  saveFormRecovery,
} from "../plans/form-recovery";

/**
 * `FormRecoveryPort` (WEB-07's contract) over the `form_recovery` store (plan 5.3.4).
 *
 * `save` returns `"saved"`, `"failed"` or `"refused"` (decision D-16): `"refused"` means `closing` is set, "can't save, signing
 * out", and nothing was written. `"saved"` means THIS capture's content is durable: the transaction wrote it, or found exactly
 * this content already stored. It is never the answer to a write the store declined, and a capture that a LATER capture has
 * overtaken is not durable and is reported as `"failed"`: the newer text stands, and a caller's retry is a new capture.
 *
 * ORDER (R1, revision 6). Captures are ordered by `(writer_gen, capture_seq)` and admitted inside the transaction only when they
 * are after the stored capture (`plans/form-recovery.ts`). The sequence is assigned when `save` or `discard` is CALLED, in call
 * order, before anything is awaited, and the counter belongs to the page's STORE HANDLE for the account (what a reload replaces),
 * not to a port instance: every port over one handle is one writer, so a replacement port continues the order of the one it
 * replaces, and a capture that an earlier instance is still holding (in a quota estimate, a retry, a queue) is later refused by the
 * store, whatever it was numbered, and never promoted. The generation is claimed durably, once per handle and form, by a
 * transaction CREATED at the first call, so a page context that saves later holds a higher generation, and the captures of an
 * earlier context (a page that is still alive after a reload or a restore from the back/forward cache) cannot overtake it. There is
 * no reconciliation loop: an obsolete capture is final. EVERY claim is given a generation no other claim has had, whether the form has
 * a row when it is made or not, and a claim whose first save has not landed holds its generation all the same (R1, revision 19: one
 * counter in the database orders them all, `max(counter, stored) + 1`, and every claim moves it). Where no unique generation can be
 * issued the capture FAILS (`no_generation`) and nothing is written; a generation is never reused or re-numbered above a later claim.
 *
 * The claim is not reserved with the quota guard, and it creates no row (R33, revision 18): it has to be created at the call, not after
 * the guard's estimate, or it could not order the contexts, so it writes only what is already there (an existing row's order record,
 * and the database's counter, which every claim moves; `plans/form-recovery.ts`). A row is growth, and the port admits it first: THE WHOLE ROW is sized (every field
 * of it, its key and the index entries of its key: `recoveryWriteBytes`), reserved, and only then written, and the first write of a
 * form that has no row is the save that was admitted (or, for a discard of a form that has none, a terminal row that is admitted the
 * same way). A save the guard refuses writes nothing, and what is already saved is never touched by it.
 *
 * WHAT IS ADMITTED IS WHAT IS WRITTEN (R33, revision 18). The snapshot belongs to the caller, who may go on editing the object after
 * `save` returns its promise; the port copies it when it is CALLED (synchronously, like the capture's place in the order), sizes that copy,
 * and writes that copy, so a change made while the guard is asked, or the claim answered, is a later capture and not this one.
 *
 * Writes of one form and tab from one port instance run one at a time, in call order. They are NOT serialised across instances
 * (an instance whose write waits must not hold up its replacement); the store's admission orders them.
 *
 * Values arrive already filtered by WEB-07's guard; the port does not widen its allow-list. A failure of the write is
 * `"failed"`, never a throw.
 */
export interface FormRecoveryPortDeps {
  /** The displayed account's service, or null when there is none (then nothing can be saved). */
  service(): AccountService | null;
  quota?: QuotaGuard;
  now(): string;
}

/** The writer of one form and tab in one service: its claimed generation and the last sequence handed out. */
interface Writer {
  /** The claim, started at the first call; null again after a refusal or a failure, so the next call claims afresh. */
  claim: Promise<FormClaimResult> | null;
  seq: number;
  /**
   * The latest discard of a form that had NO row which wrote no terminal row (the guard refused it, or the write failed): no row means
   * nothing in the store can refuse a capture asked for before it, so the writer refuses them itself, from memory, as long as this page's
   * handle lives. (With a row, the store's own order does it.)
   */
  cleared: number;
}

/** Per store handle, then per [form, tab]. A WeakMap: the state lives exactly as long as the page's handle to the account does. */
const writers = new WeakMap<object, Map<string, Writer>>();

/** How many times one copy is admitted when the hold it was admitted under ends before the write begins (the outbox's bound, R28). */
const ADMISSION_ROUNDS = 3;

/**
 * What a recovery row adds to the origin's storage, in bytes, for the quota reserve (R33, revision 18): the WHOLE row, not its values. Every
 * field of it is measured (the form context and the tab id, which are public strings of any length, the timestamp, the digest, the names
 * and values of the fields, the order record at its widest); the key is stored again as the row's primary key and as an entry of the index
 * on `form_context` (which names the primary key as well), so the context is counted three times beyond the row's own copy and the tab id
 * twice; and a fixed allowance stands for the record and index entries of a row of fixed shape, never for anything the caller sizes. The
 * measure is two bytes a unit of text (what an engine may store a string at, and this port's measure from the start), a bound and not an
 * allocation: a bound that is too large refuses early, never late. An existing row is replaced, and the credit is not taken.
 */
export const RECOVERY_ALLOWANCE_BYTES = 512;
const UNIT_BYTES = 2;
const WIDEST_ORDER = Number.MAX_SAFE_INTEGER;
export function recoveryWriteBytes(row: FormRecoveryRow): number {
  // The order record is assigned by the claim and the call, so it is sized at its widest.
  const measured = JSON.stringify({
    ...row,
    capture_seq: WIDEST_ORDER,
    writer_gen: WIDEST_ORDER,
  });
  const keyed = 3 * row.form_context.length + 2 * row.tab_instance_id.length;
  return RECOVERY_ALLOWANCE_BYTES + UNIT_BYTES * (measured.length + keyed);
}

/** What the caller's snapshot says, copied when `save` is called: nothing the caller does to its object afterwards is part of the capture. */
interface Captured {
  formContext: string;
  tabInstanceId: string;
  values: Record<string, string>;
  savedAt: string;
}
const capture = (snapshot: RecoverySnapshot): Captured | null => {
  try {
    return {
      formContext: snapshot.formContext,
      tabInstanceId: snapshot.tabInstanceId,
      values: { ...snapshot.values },
      savedAt: snapshot.savedAt,
    };
  } catch {
    // A getter that throws, a revoked proxy: the capture is not made.
    return null;
  }
};

export function createFormRecoveryPort(
  deps: FormRecoveryPortDeps,
): FormRecoveryPort {
  // Per (incarnation, form, tab): the tail of the writes this instance already requested, so they run one at a time in call order.
  const tails = new Map<string, Promise<unknown>>();
  const keyOf = (service: AccountService, form: string, tab: string): string =>
    JSON.stringify([service.incarnationId, form, tab]);

  /** Runs `job` after every earlier job of the same key; a job that fails does not stop the ones behind it. */
  const serialised = <T>(id: string, job: () => Promise<T>): Promise<T> => {
    const previous = tails.get(id) ?? Promise.resolve();
    const next = previous.then(job, job);
    const tail = next.catch(() => undefined);
    tails.set(id, tail);
    void tail.then(() => {
      if (tails.get(id) === tail) tails.delete(id);
    });
    return next;
  };

  const writerFor = (
    service: AccountService,
    form: string,
    tab: string,
  ): Writer => {
    // The page's handle to the account's database: what a reload (or a re-opened account) replaces, and what every port over the
    // same account on this page shares. Not the service object itself, which a composition may wrap.
    let byKey = writers.get(service.store);
    if (!byKey) {
      byKey = new Map();
      writers.set(service.store, byKey);
    }
    const key = JSON.stringify([form, tab]);
    let writer = byKey.get(key);
    if (!writer) {
      writer = { claim: null, seq: 0, cleared: 0 };
      byKey.set(key, writer);
    }
    return writer;
  };

  /**
   * The capture's place in the order, fixed NOW: the next sequence of this writer, and the claim of its generation (started by the
   * first call and shared by every later one, so the transaction is created before anything is awaited and a later page context's
   * claim is ordered after it).
   */
  const begin = (service: AccountService, form: string, tab: string) => {
    const writer = writerFor(service, form, tab);
    writer.seq += 1;
    if (writer.claim === null) {
      const started = service.store
        .run(claimFormWriter, {
          incarnationId: service.incarnationId,
          formContext: form,
          tabInstanceId: tab,
          now: deps.now(),
        })
        .then(
          (result) => {
            if (result.kind !== "claimed" && writer.claim === started)
              writer.claim = null;
            return result;
          },
          (error: unknown) => {
            if (writer.claim === started) writer.claim = null;
            throw error;
          },
        );
      // Settled by whoever awaits it; a capture that returns early (a refusal by the quota guard) must not leave it unhandled.
      started.catch(() => undefined);
      writer.claim = started;
    }
    return { seq: writer.seq, claim: writer.claim, writer };
  };

  const write = (
    service: AccountService,
    row: FormRecoveryRow,
    options: { leaseLive?: () => boolean; mayCreate?: boolean } = {},
  ): Promise<FormWriteResult> =>
    service.store.run(saveFormRecovery, {
      incarnationId: service.incarnationId,
      row,
      ...(options.leaseLive === undefined
        ? {}
        : { leaseLive: options.leaseLive }),
      ...(options.mayCreate === undefined
        ? {}
        : { mayCreate: options.mayCreate }),
    });

  return {
    async save(snapshot: RecoverySnapshot) {
      const service = deps.service();
      if (!service) return "failed";
      // The capture is fixed NOW, with its place in the order, before anything is awaited: what is sized, admitted and written below is
      // this copy and never the caller's object (R33, revision 18).
      const captured = capture(snapshot);
      if (captured === null) return "failed";
      const id = keyOf(service, captured.formContext, captured.tabInstanceId);
      const { seq, claim, writer } = begin(
        service,
        captured.formContext,
        captured.tabInstanceId,
      );
      return serialised(id, async () => {
        let row: Omit<FormRecoveryRow, "capture_seq" | "writer_gen">;
        let bytes: number;
        try {
          row = {
            form_context: captured.formContext,
            tab_instance_id: captured.tabInstanceId,
            fields: { ...captured.values },
            redacted: [],
            saved_at: captured.savedAt,
            terminal: false,
            content_digest: digestOf(captured.values),
          };
          bytes = recoveryWriteBytes({
            ...row,
            capture_seq: seq,
            writer_gen: 0,
          });
        } catch {
          return "failed";
        }
        // The recovery copy is user input: the last thing the quota reserve refuses, and its WHOLE size (the row and its keys) counts and is
        // held while it is written, like a draft's. The hold is a lease that only stands while the origin's other pages count it, so the
        // write begins only while it does (R28, revision 14), and is admitted afresh, a bounded number of times, when it has ended.
        for (let round = 1; ; round += 1) {
          let reservation: QuotaReservation | undefined;
          let written = false;
          let lapsed = false;
          try {
            reservation = await deps.quota?.reserve("input", bytes);
            if (reservation?.verdict === "refuse") return "failed";
            const claimed = await claim;
            if (claimed.kind !== "claimed")
              // `refused`: closing is set. `no_generation`: no unique generation can be issued (R1, revision 19), so nothing is written.
              return claimed.kind === "refused" ? "refused" : "failed";
            // A discard asked for after this capture, of a form that had no row, may have been decided (and refused) while this capture
            // waited for the guard: nothing in the store would refuse it, so it is refused here, before it can bring discarded text back.
            if (writer.cleared > seq) return "failed";
            const held = reservation;
            const result = await write(
              service,
              {
                ...row,
                fields: { ...row.fields },
                capture_seq: seq,
                writer_gen: claimed.gen,
              },
              held === undefined ? {} : { leaseLive: () => held.live() },
            );
            if (result.kind === "lease_lapsed") lapsed = true;
            else {
              written = result.kind === "saved";
              if (result.kind === "refused") return "refused";
              // `superseded`: a later capture is durable and this one never will be; it is NOT retried above it.
              return result.kind === "superseded" ? "failed" : "saved";
            }
          } catch {
            return "failed";
          } finally {
            reservation?.settle(written ? "written" : "not_written");
          }
          if (lapsed && round >= ADMISSION_ROUNDS) return "failed";
        }
      });
    },

    async load(formContext, tabInstanceId) {
      const service = deps.service();
      if (!service) return null;
      try {
        const row = await service.store.run(loadFormRecovery, {
          incarnationId: service.incarnationId,
          formContext,
          tabInstanceId,
        });
        return row
          ? {
              formContext: row.form_context,
              tabInstanceId: row.tab_instance_id,
              values: { ...row.fields },
              savedAt: row.saved_at,
            }
          : null;
      } catch {
        return null;
      }
    },

    async discard(formContext, tabInstanceId) {
      const service = deps.service();
      if (!service) return;
      const id = keyOf(service, formContext, tabInstanceId);
      const { seq, claim, writer } = begin(service, formContext, tabInstanceId);
      await serialised(id, async () => {
        let reservation: QuotaReservation | undefined;
        let written = false;
        let created = false;
        try {
          const claimed = await claim;
          if (claimed.kind !== "claimed") return;
          // A terminal write is admitted at `>=` in the order of captures, so it overtakes every capture asked for before it and
          // none asked for after it: a late older capture cannot bring the discarded text back, and text typed after the discard
          // is not erased. The fields are cleared and the row is kept (a hard delete could not be ordered against a late write).
          const row: FormRecoveryRow = {
            form_context: formContext,
            tab_instance_id: tabInstanceId,
            fields: {},
            redacted: [],
            saved_at: deps.now(),
            capture_seq: seq,
            writer_gen: claimed.gen,
            terminal: true,
            content_digest: digestOf({}),
          };
          // With a row this replaces what is there with less, and needs no room. With none it would CREATE one, which is growth like any
          // other (R33, revision 18): the transaction says which it is when it runs (`absent`), and the row is then admitted first.
          let result = await write(service, row, { mayCreate: false });
          if (result.kind === "absent") {
            created = true;
            reservation = await deps.quota?.reserve(
              "input",
              recoveryWriteBytes(row),
            );
            if (reservation?.verdict === "refuse") return;
            const held = reservation;
            result = await write(
              service,
              row,
              held === undefined ? {} : { leaseLive: () => held.live() },
            );
          }
          written = result.kind === "saved";
        } catch {
          // `discard` has no result in the contract; the copy stays and is shown again, which is the safe direction.
        } finally {
          reservation?.settle(written ? "written" : "not_written");
          // No row was there to order against and none was written: what this capture was asked after is refused from memory.
          if (created && !written)
            writer.cleared = Math.max(writer.cleared, seq);
        }
      });
    },
  };
}
