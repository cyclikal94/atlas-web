import type { FormRecoveryRow } from "../model/types";
import { w } from "../store/port";
import { singletonPlan } from "./builders";

/**
 * SEVERAL conditional form copies in ONE transaction (WEB-11a review 4 of 23 October 2026, findings 1–3; the third design assessment's C7):
 * an OPERATION kept as form copies (WEB-11a's held audience changes, `people-held:`) sometimes has to change two rows as one commit, for
 * example a new hold AND its field's head (the record of which hold is the field's current one), so that no crash, refused write or other
 * page can ever see one without the other.
 *
 * Every row is written only when EVERY row is stored exactly as its caller read it (`expect`: absent, or live/terminal with exactly that
 * `content_digest`), judged in the same transaction; otherwise NOTHING is written and the answer names the first row that differed and
 * what is stored there. A terminal row may be compared and replaced here (a head is a terminal row: never listed, never counted as unsynced
 * work, never restored as a form), which the single-row `saveFormRecovery` never does. Refused while signing out (`closing`, D-16) and
 * admitted like any recovery copy: the caller reserves the whole growth with the quota guard and the write begins only while that hold
 * stands (`leaseLive`, R28). Rows are written with the caller's writer generation (the conditional port's is the highest, so the ordinary
 * form port can never claim them).
 */
export type FormState = "absent" | "ended" | "live";

export interface FormOperation {
  /** The row as it is to be stored; its key is `[form_context, tab_instance_id]`. Keys are distinct within one call. */
  row: FormRecoveryRow;
  /** What must be stored now for the call to write anything. */
  expect: { state: "absent" } | { state: "live" | "ended"; digest: string };
}

export type FormOperationResult =
  | { kind: "saved" }
  /** Row `index` is not stored as expected (`stored` says what is there): nothing was written. */
  | { kind: "changed"; index: number; stored: FormState }
  /** `closing` is set: nothing was written. */
  | { kind: "refused" }
  /** The quota hold the rows were admitted under has ended (R28): nothing was written; the port admits them again. */
  | { kind: "lease_lapsed" };

export const saveFormOperation = singletonPlan<
  {
    incarnationId: string;
    operations: readonly FormOperation[];
    leaseLive?: () => boolean;
  },
  Array<FormRecoveryRow | undefined>,
  FormOperationResult
>({
  name: "data.saveFormOperation",
  meta: { writer: "W9", guards: ["INC", "CLS"], quota: "input" },
  scope: ["form_recovery"],
  durability: "strict",
  read: async (reader, input) => {
    const stored: Array<FormRecoveryRow | undefined> = [];
    for (const operation of input.operations)
      stored.push(
        await reader.get("form_recovery", [
          operation.row.form_context,
          operation.row.tab_instance_id,
        ]),
      );
    return stored;
  },
  decide: ({ sync, reads, input }) => {
    if (sync?.draft_fence?.closing === true)
      return { result: { kind: "refused" } };
    if (input.leaseLive !== undefined && !input.leaseLive())
      return { result: { kind: "lease_lapsed" } };
    for (const [index, operation] of input.operations.entries()) {
      const stored = reads[index];
      const state: FormState = !stored
        ? "absent"
        : stored.terminal
          ? "ended"
          : "live";
      const want = operation.expect;
      if (
        want.state !== state ||
        (want.state !== "absent" && stored?.content_digest !== want.digest)
      )
        return { result: { kind: "changed", index, stored: state } };
    }
    return {
      writes: input.operations.map((operation) =>
        w.put("form_recovery", operation.row),
      ),
      result: { kind: "saved" },
    };
  },
});
