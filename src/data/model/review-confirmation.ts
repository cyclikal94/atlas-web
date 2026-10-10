import { canonicalJson } from "./canonical";
import type { Bases, EnqueueRequest, TargetSpec } from "./outbox";
import type {
  DraftRow,
  JsonObject,
  LocalId,
  ResourceId,
  ResourceVersionRow,
} from "./types";

/**
 * The defaults review's CONFIRMATION, as a pure rebuild of a stored draft (WEB-12a, D-12a-6; WEB-04 §5.7). PURE: no clock, no store.
 *
 * The person has looked at the audience (the "Was" captured with the draft and the "Now" of a snapshot fetched for the review) and
 * confirmed it. The data layer does not know what the command means, so the confirmation changes EXACTLY two things and nothing else:
 *
 *  - the command's top-level `defaults_revision` becomes the revision the person reviewed (every queueable body that carries the guard
 *    carries it at the top level: `ContentCommands`, `AccessCommands`, `TaskCommandInput`), and
 *  - the draft's captured context becomes the one shown as "Now", and its review block is cleared (`defaultsReview: []`).
 *
 * A queued draft that was blocked locally (never sent) is EDITED IN PLACE: same `local_id`, nothing superseded. A draft that was sent
 * and refused with `defaults_changed` (in flight, frozen) is SUPERSEDED by a new draft with a fresh `local_id`. Either way the request
 * addresses exactly the draft's own targets and is built only on the versions the draft was built on: if the versions the plan hands
 * the build differ from the draft's stored bases, the build REFUSES (`BasesMoved`), because a body this layer did not author must never
 * be sent on a version it was not composed against. That draft is reviewed from its own feature's screen instead.
 *
 * The confirmation is CONDITIONAL on the draft the person reviewed (WEB-12a R2). The rebuild is made from a body read before the write,
 * so it states what it was decided on (`reviewed`: the draft's body digest, revision, captured context, review block and status), and
 * the edit or supersession re-checks it inside its own transaction (`expectDraft`). A change committed in between, such as another
 * page's edit of the same queued draft, refuses the confirmation (`draft_changed`): it is never overwritten by the older body, and the
 * person reviews the draft as it now is.
 */
export class BasesMoved extends Error {
  constructor() {
    super("the versions this draft was built on have moved");
    this.name = "BasesMoved";
  }
}

/** What the person reviewed of a draft: the confirmation applies only while the stored draft is still exactly this. */
export type ReviewedDraft = Pick<
  DraftRow,
  | "local_id"
  | "status"
  | "command_digest"
  | "defaults_revision"
  | "defaults_context"
  | "review_block"
>;

/** The part of a draft a confirmation was decided on, as it is shown (a queue row is a whole `DraftRow`). */
export function reviewedOf(draft: ReviewedDraft): ReviewedDraft {
  return {
    local_id: draft.local_id,
    status: draft.status,
    command_digest: draft.command_digest,
    defaults_revision: draft.defaults_revision,
    defaults_context: draft.defaults_context,
    review_block: draft.review_block,
  };
}

/** Whether a stored draft is still the one that was reviewed: its body, revision, captured context, review block and status. */
export function isReviewedDraft(
  stored: ReviewedDraft,
  reviewed: ReviewedDraft,
): boolean {
  return (
    canonicalJson(reviewedOf(stored)) === canonicalJson(reviewedOf(reviewed))
  );
}

export interface ReviewConfirmation {
  /** The draft as the person reviewed it (`reviewedOf` the row the review showed). */
  reviewed: ReviewedDraft;
  /** The revision of the snapshot the person reviewed (64 hex). */
  defaultsRevision: string;
  /** What that snapshot captures for the draft's kinds: stored as the draft's `defaults_context`. */
  defaultsContext: unknown;
  /** The replacement's identity, for a supersession: the same on a retry, so a lost completion is recognised (R24). */
  replacementId?: LocalId;
}

const sameBases = (a: Bases, b: Readonly<Record<ResourceId, number>>) => {
  const keys = Object.keys(b);
  return (
    Object.keys(a).length === keys.length && keys.every((id) => a[id] === b[id])
  );
};

/** The targets of a stored draft, as the request that built it named them (ids, roles, version checks), with the basis on record. */
export function targetsOf(
  draft: DraftRow,
  basis: ReadonlyMap<ResourceId, ResourceVersionRow["basis"]>,
): TargetSpec[] {
  const targets: TargetSpec[] = [];
  for (const id of draft.target_resource_ids) {
    const versionChecked =
      draft.expected_version !== undefined && draft.bumped.includes(id);
    const base = draft.bases[id];
    targets.push({
      resourceId: id,
      role: "primary",
      basis: basis.get(id) ?? "resource",
      versionChecked,
      // A primary that is not version-checked was seeded at its base when the draft was made (a create): the same seed again.
      ...(versionChecked || base === undefined
        ? {}
        : { seedIfUntracked: base }),
    });
  }
  for (const id of Object.keys(draft.side_effect_bases))
    targets.push({
      resourceId: id,
      role: "side_effect",
      basis: basis.get(id) ?? "resource",
      versionChecked: true,
    });
  return targets;
}

/** The request that confirms a reviewed draft. Its `build` refuses (`BasesMoved`) unless handed exactly the draft's stored bases. */
export function confirmationRequest(
  draft: DraftRow,
  command: JsonObject,
  basis: ReadonlyMap<ResourceId, ResourceVersionRow["basis"]>,
  confirmation: ReviewConfirmation,
): EnqueueRequest {
  const stored = { ...draft.bases };
  const patch = draft.display_patch;
  return {
    endpoint: draft.endpoint,
    ...(draft.target_id === null ? {} : { targetId: draft.target_id }),
    targets: targetsOf(draft, basis),
    ...(confirmation.replacementId === undefined
      ? {}
      : { localId: confirmation.replacementId }),
    // Re-checked in the writing transaction: a draft changed since the read above is refused, never rebuilt from the older body.
    expectDraft: (current) => isReviewedDraft(current, confirmation.reviewed),
    build: (bases) => {
      if (!sameBases(bases, stored)) throw new BasesMoved();
      return {
        command: {
          ...command,
          defaults_revision: confirmation.defaultsRevision,
        },
        ...(patch === null ? {} : { displayPatch: patch }),
        defaultsRevision: confirmation.defaultsRevision,
        defaultsContext: confirmation.defaultsContext,
        // The person's explicit confirmation: the only thing that clears a defaults review block.
        defaultsReview: [],
      };
    },
  };
}

/** Which path confirms the draft: an edit in place (queued, blocked locally), a supersession (sent, refused), or none. */
export function confirmationPath(
  draft: Pick<DraftRow, "status" | "review_block">,
): "edit" | "supersede" | null {
  if (draft.review_block === null) return null;
  if (draft.status === "queued") return "edit";
  if (draft.status === "in_flight") return "supersede";
  return null;
}
