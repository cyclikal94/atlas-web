import type { DraftWithCommand } from "../model/types";
import { readPlan } from "./builders";

/**
 * WEB-09b (WF-QUEUE-02): ONE draft with its body, for the generic item-detail dialog's "save as new" (a registered `rebuild` needs the
 * command it rebuilds). READONLY, and read for exactly one draft, as every body read is (decision D-23).
 */
export const readDraftWithCommand = readPlan<
  { incarnationId: string; localId: string },
  { draft: DraftWithCommand | null },
  DraftWithCommand | null
>({
  name: "data.readDraftWithCommand",
  scope: ["drafts", "draft_commands"],
  read: async (reader, input) => {
    const header = await reader.get("drafts", input.localId);
    if (header === undefined) return { draft: null };
    const body = await reader.get("draft_commands", input.localId);
    if (body === undefined) return { draft: null };
    return { draft: { ...header, command: body.command } };
  },
  decide: ({ reads }) => reads.draft,
});
