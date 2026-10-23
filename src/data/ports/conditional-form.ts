import type { RecoverySnapshot } from "../../lib/form-recovery/port";
import type { QuotaReservation } from "../engine/quota-guard";
import { digestOf } from "../model/canonical";
import type { FormRecoveryRow } from "../model/types";
import {
  type FormCopiesPage,
  type FormCopyCursor,
  inspectFormRecovery,
  readFormCopies,
} from "../plans/form-copies";
import {
  type FormOperation,
  type FormState,
  saveFormOperation,
} from "../plans/form-operations";
import {
  type FormWriteResult,
  MAX_WRITER_GEN,
  saveFormRecovery,
} from "../plans/form-recovery";
import { type FormRecoveryPortDeps, recoveryWriteBytes } from "./form-recovery";

/**
 * CONDITIONAL form copies (WEB-11a review 2 of 22 October 2026, findings 2 and 4): the `form_recovery` rows of a family whose copy is
 * an OPERATION, not a form that may be typed again (WEB-11a's held audience changes, `people-held:`). Every write is a compare-and-set
 * of the stored row in ONE transaction (`saveFormRecovery`'s `expect`): it is written only when the row is exactly the state the caller
 * read (`expect` = its `content_digest`, or null for a row that must not exist yet), and every outcome is TYPED, so nothing is reported
 * as done that the store did not commit:
 *
 *  - `put`: `saved` (with the new digest, the caller's next `expect`), `changed` (another state is stored: nothing written, and what is
 *    there), `refused` (`closing`: signing out, D-16), `failed` (no service, the quota guard refused, the write failed).
 *  - `end`: the row becomes TERMINAL (kept, never hard-deleted) only from the state the caller read; `ended`, or `changed`/`refused`/
 *    `failed` as above. A row that is already terminal answers `changed` with `stored: "ended"`. Its content is cleared; what it keeps is
 *    only the caller's small `tombstone` (WEB-11a review 4: WHY the operation ended, so that an ended operation is never taken for one
 *    that can run again). A tombstone is far smaller than any live copy of the family, so ending needs no room.
 *  - `read`: `live` (the row), `ended` (with what its tombstone kept), `absent`, or `failed` (no service, the read failed): a failure is
 *    never absence.
 *  - `apply`: several rows in ONE transaction, each only while it is stored as read (`saveFormOperation`): all are written or none.
 *  - `list`: one bounded, resumable page of the family (`readFormCopies`), or null when it could not be read.
 *
 * ONE BINDING PER OPERATION (WEB-11a review 4; the design assessment's C10): `pinned()` is a port bound to the service displayed when it is
 * called. An operation that makes several calls (a held change's run, its replacement) takes one at its start, so a call made after the
 * displayed account or its database changed FAILS instead of reaching whichever service is current then.
 *
 * The rows are admitted like any recovery copy (the WHOLE row is sized and reserved with the quota guard before it is written, and written
 * only while that hold stands, R28/R33), are counted in the unsynced local work, refused while signing out, and deleted only with the
 * account's data. They are written with the HIGHEST writer generation, so the ordinary form port (whose writers claim `stored + 1`) can
 * never claim one: its save and discard of such a form fail closed (`no_generation`), and no later generic capture can bring an ended
 * operation back. A condition is judged against the row itself, so the order of captures is not needed between conditional writers.
 */
export type ConditionalPut =
  | { kind: "saved"; digest: string }
  | { kind: "changed"; stored: "absent" | "ended" | "live" }
  | { kind: "refused" }
  | { kind: "failed" };

export type ConditionalEnd =
  | { kind: "ended" }
  | { kind: "changed"; stored: "absent" | "ended" | "live" }
  | { kind: "refused" }
  | { kind: "failed" };

export type FormRowRead =
  | { kind: "live"; row: FormRecoveryRow }
  | { kind: "ended"; fields: Record<string, string>; digest: string }
  | { kind: "absent" }
  | { kind: "failed" };

/** One row of an `apply`: the copy to store, whether it is terminal, and what must be stored now. */
export interface ConditionalOperation {
  snapshot: RecoverySnapshot;
  terminal: boolean;
  expect: FormOperation["expect"];
}

export type ConditionalApply =
  /** Every row was written; `digests` are their new `content_digest`s, in order. */
  | { kind: "saved"; digests: string[] }
  /** Row `index` is not stored as expected: nothing was written. */
  | { kind: "changed"; index: number; stored: FormState }
  | { kind: "refused" }
  | { kind: "failed" };

export interface ConditionalFormPort {
  put(
    snapshot: RecoverySnapshot,
    expect: string | null,
  ): Promise<ConditionalPut>;
  end(
    formContext: string,
    tabInstanceId: string,
    expect: string,
    tombstone?: Record<string, string>,
  ): Promise<ConditionalEnd>;
  read(formContext: string, tabInstanceId: string): Promise<FormRowRead>;
  apply(operations: readonly ConditionalOperation[]): Promise<ConditionalApply>;
  list(
    prefix: string,
    after: FormCopyCursor | null,
  ): Promise<FormCopiesPage | null>;
  /** This port bound to the service displayed NOW: once another one is displayed, every call fails. */
  pinned(): ConditionalFormPort;
}

/** How many times one copy is admitted when the hold it was admitted under ends before the write begins (the outbox's bound, R28). */
const ADMISSION_ROUNDS = 3;

const unwritten = (result: FormWriteResult): ConditionalPut | null =>
  result.kind === "changed"
    ? { kind: "changed", stored: result.stored }
    : result.kind === "refused"
      ? { kind: "refused" }
      : result.kind === "saved" || result.kind === "unchanged"
        ? null
        : { kind: "failed" };

/** The row a conditional copy is stored as (the highest writer generation; a terminal one keeps `values` as its tombstone). */
const rowOf = (
  snapshot: RecoverySnapshot,
  terminal: boolean,
): FormRecoveryRow => {
  const fields = { ...snapshot.values };
  return {
    form_context: snapshot.formContext,
    tab_instance_id: snapshot.tabInstanceId,
    fields,
    redacted: [],
    saved_at: snapshot.savedAt,
    capture_seq: 0,
    writer_gen: MAX_WRITER_GEN,
    terminal,
    content_digest: digestOf(fields),
  };
};

export function createConditionalFormPort(
  deps: FormRecoveryPortDeps,
): ConditionalFormPort {
  return {
    async put(snapshot, expect) {
      const service = deps.service();
      if (!service) return { kind: "failed" };
      // The capture is fixed NOW (the caller may go on changing its object): what is sized and written is this copy.
      let row: FormRecoveryRow;
      try {
        row = rowOf(snapshot, false);
      } catch {
        return { kind: "failed" };
      }
      const bytes = recoveryWriteBytes(row);
      for (let round = 1; ; round += 1) {
        let reservation: QuotaReservation | undefined;
        let written = false;
        try {
          reservation = await deps.quota?.reserve("input", bytes);
          if (reservation?.verdict === "refuse") return { kind: "failed" };
          const held = reservation;
          const result = await service.store.run(saveFormRecovery, {
            incarnationId: service.incarnationId,
            row,
            expect: { digest: expect },
            ...(held === undefined ? {} : { leaseLive: () => held.live() }),
          });
          if (result.kind !== "lease_lapsed") {
            written = result.kind === "saved";
            return (
              unwritten(result) ?? { kind: "saved", digest: row.content_digest }
            );
          }
        } catch {
          return { kind: "failed" };
        } finally {
          reservation?.settle(written ? "written" : "not_written");
        }
        if (round >= ADMISSION_ROUNDS) return { kind: "failed" };
      }
    },

    async end(formContext, tabInstanceId, expect, tombstone = {}) {
      const service = deps.service();
      if (!service) return { kind: "failed" };
      try {
        // It replaces a live row with less (a tombstone is far smaller than a copy), so it needs no room; with no row it writes nothing
        // (`mayCreate: false`).
        const result = await service.store.run(saveFormRecovery, {
          incarnationId: service.incarnationId,
          row: rowOf(
            {
              formContext,
              tabInstanceId,
              values: tombstone,
              savedAt: deps.now(),
            },
            true,
          ),
          expect: { digest: expect },
          mayCreate: false,
        });
        if (result.kind === "saved") return { kind: "ended" };
        if (result.kind === "absent")
          return { kind: "changed", stored: "absent" };
        return (
          (unwritten(result) as ConditionalEnd | null) ?? { kind: "failed" }
        );
      } catch {
        return { kind: "failed" };
      }
    },

    async read(formContext, tabInstanceId) {
      const service = deps.service();
      if (!service) return { kind: "failed" };
      try {
        return await service.store.run(inspectFormRecovery, {
          incarnationId: service.incarnationId,
          formContext,
          tabInstanceId,
        });
      } catch {
        return { kind: "failed" };
      }
    },

    async apply(operations) {
      const service = deps.service();
      if (!service) return { kind: "failed" };
      let rows: FormRecoveryRow[];
      try {
        rows = operations.map((operation) =>
          rowOf(operation.snapshot, operation.terminal),
        );
      } catch {
        return { kind: "failed" };
      }
      // Every row is reserved whole: an `apply` creates rows (a new hold, a field's first head).
      const bytes = rows.reduce((sum, row) => sum + recoveryWriteBytes(row), 0);
      for (let round = 1; ; round += 1) {
        let reservation: QuotaReservation | undefined;
        let written = false;
        try {
          reservation = await deps.quota?.reserve("input", bytes);
          if (reservation?.verdict === "refuse") return { kind: "failed" };
          const held = reservation;
          const result = await service.store.run(saveFormOperation, {
            incarnationId: service.incarnationId,
            operations: rows.map((row, index) => ({
              row,
              expect: (operations[index] as ConditionalOperation).expect,
            })),
            ...(held === undefined ? {} : { leaseLive: () => held.live() }),
          });
          if (result.kind !== "lease_lapsed") {
            written = result.kind === "saved";
            return result.kind === "saved"
              ? {
                  kind: "saved",
                  digests: rows.map((row) => row.content_digest),
                }
              : result;
          }
        } catch {
          return { kind: "failed" };
        } finally {
          reservation?.settle(written ? "written" : "not_written");
        }
        if (round >= ADMISSION_ROUNDS) return { kind: "failed" };
      }
    },

    async list(prefix, after) {
      const service = deps.service();
      if (!service) return null;
      try {
        return await service.store.run(readFormCopies, {
          incarnationId: service.incarnationId,
          prefix,
          after,
        });
      } catch {
        return null;
      }
    },

    pinned() {
      const bound = deps.service();
      return createConditionalFormPort({
        ...deps,
        service: () => {
          const now = deps.service();
          return bound !== null && now === bound ? bound : null;
        },
      });
    },
  };
}
