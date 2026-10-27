import type { MergedResource } from "../model/overlay";
import type { ResourceId } from "../model/types";
import { readPlan } from "./builders";
import { readMerged } from "./outbox";

/**
 * A resource read WITH its parent (WEB-11a review 16, DA16-S1): in a module of its own, because the shared policy editor, which is part of
 * the first load, uses it; the larger reads of what is shown under a parent stay in the lazy `outstanding-reads.ts`.
 */
/** A resource and its parent as ONE transaction read them, each as `readMerged` reads it; `parent` null when the resource names none. */
export interface MergedUnder {
  resource: MergedResource;
  parent: MergedResource | null;
}

/**
 * `readMerged` of a resource and of its parent in ONE transaction: the parent `parentId` (an editor's route names it) or else the one the
 * cached resource names. A screen shows the resource's content only when this same read holds its parent.
 */
export const readMergedUnder = readPlan<
  { incarnationId: string; id: ResourceId; parentId?: ResourceId },
  {
    resource: Awaited<ReturnType<typeof readMerged.read>>;
    parent: Awaited<ReturnType<typeof readMerged.read>> | null;
  },
  MergedUnder
>({
  name: "data.readMergedUnder",
  scope: ["cache", "pending_effects", "drafts", "draft_commands"],
  read: async (reader, input) => {
    const resource = await readMerged.read(reader, {
      incarnationId: input.incarnationId,
      id: input.id,
    });
    const parentId = input.parentId ?? resource.reads.base?.parent_id ?? null;
    return {
      resource,
      parent:
        parentId === null
          ? null
          : await readMerged.read(reader, {
              incarnationId: input.incarnationId,
              id: parentId,
            }),
    };
  },
  decide: ({ reads, input }) => ({
    resource: readMerged.decide(reads.resource, input).result,
    parent:
      reads.parent === null
        ? null
        : readMerged.decide(reads.parent, input).result,
  }),
});
