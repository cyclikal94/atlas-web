import { type EnqueueRequest, isSameSave } from "../model/outbox";
import type { DraftRow } from "../model/types";
import { readPlan } from "./builders";

/**
 * What a draft stored under a save's local id says of that save NOW (WEB-10b revision 3, D1): exact, local evidence for a caller whose
 * answer was lost, never an outcome on the server. READONLY: it cannot write, so no answer it gives can become a second write under the
 * old id, whatever happens to the draft after it is read.
 *
 * - `stored`: the draft is that save as it was sent (the same targets, and the request builds again, from the bases the draft holds, to the
 *   digest it carries: `isSameSave`), in any state that is not a refusal (queued, sent, acknowledged, held for a decision in Sync).
 * - `refused`: a draft of the id was refused or discarded (`rejected`, a discard of a conflict among them) or replaced (`superseded`).
 * - `changed`: a draft of the id is there but is not that save as sent (edited in place since, its defaults confirmed in Sync, or another
 *   command under the key).
 * - `absent`: nothing is stored under the id now, which is NOT proof that nothing ever was: an acknowledged draft is removed once its
 *   effect is applied, and a discarded or replaced one is gone. No lineage of retired drafts is kept (none is authorised).
 *
 * Its own module, so that only the screen that asks it carries it (the boot path's shared modules are hoisted into the entry whole).
 */
export type DraftEvidence = "stored" | "refused" | "changed" | "absent";

export const readDraftEvidence = readPlan<
  { incarnationId: string; localId: string; request: EnqueueRequest },
  { draft: DraftRow | undefined },
  DraftEvidence
>({
  name: "data.readDraftEvidence",
  scope: ["drafts"],
  read: async (reader, input) => ({
    draft: await reader.get("drafts", input.localId),
  }),
  decide: ({ reads, input }) => {
    const draft = reads.draft;
    if (draft === undefined) return "absent";
    if (draft.status === "rejected" || draft.status === "superseded")
      return "refused";
    return isSameSave(input.request, draft) ? "stored" : "changed";
  },
});
