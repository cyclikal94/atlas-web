import type { DraftRow } from "../model/types";
import { readPlan } from "./builders";

/**
 * WEB-10b (revision 2, R2): whether a draft is stored under `localId` now, its header only (what an enqueue's duplicate test reads). The
 * picker asks it of an add whose answer was lost before sending it again. READONLY. A null says nothing is stored under the id NOW, not
 * that nothing ever was: an acknowledged draft is removed once its effect is applied, and a discarded or replaced one is gone. Its own
 * module, so that only the screen that asks it carries it (the boot path's shared modules are hoisted into the entry whole).
 */
export const readDraftHeader = readPlan<
  { incarnationId: string; localId: string },
  { draft: DraftRow | undefined },
  DraftRow | null
>({
  name: "data.readDraftHeader",
  scope: ["drafts"],
  read: async (reader, input) => ({
    draft: await reader.get("drafts", input.localId),
  }),
  decide: ({ reads }) => reads.draft ?? null,
});
