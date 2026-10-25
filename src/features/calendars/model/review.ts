import type {
  CacheRow,
  EnqueueRequest,
  JsonObject,
  LocalId,
  Observation,
} from "../../../data";
import { parseSlot, type Slot } from "../../tasks/model/contract";
import { CALENDAR_COMMANDS } from "./commands";

/**
 * Anchor review items (WEB-13b §4.5; R17): the synced `review` resources the server creates, privately for the binding's author, when an
 * anchored occurrence needs the person (`v0.29.0-rc.1`, `anchors.rs` `anchor_review`). The resource's parent is the occurrence; its value
 * is `{reason, resolved, slot}`:
 *
 *  - `moved`: the occurrence followed its calendar automatically; `slot` is the PREVIOUS slot.
 *  - `work_started`: it was not moved because work was recorded on it; `slot` is the PROPOSED slot (what "Review this move…" fills in).
 *  - `cancelled`, `missing`, `no_longer_eligible`: its timing is kept as last known; `slot` is null.
 *  - `context_unavailable`: the generic private review; `slot` is null and nothing about a date, a title or a task is shown.
 *
 * The api-types have no schema for the value, so it is read STRICTLY here: anything else is "can't be shown". Resolving it is explicit and
 * versioned (`resolve_review`, the review's own version); it changes no occurrence.
 */
export type ReviewReason =
  | "moved"
  | "work_started"
  | "cancelled"
  | "missing"
  | "no_longer_eligible"
  | "context_unavailable";

const REASONS: readonly ReviewReason[] = [
  "moved",
  "work_started",
  "cancelled",
  "missing",
  "no_longer_eligible",
  "context_unavailable",
];

export interface ReviewValue {
  reason: ReviewReason;
  resolved: boolean;
  slot: Slot | null;
}

export function parseReview(
  value: JsonObject | null | undefined,
): ReviewValue | null {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v).sort().join(",");
  if (keys !== "reason,resolved,slot") return null;
  if (!REASONS.includes(v.reason as ReviewReason)) return null;
  if (typeof v.resolved !== "boolean") return null;
  const slot = v.slot === null ? null : parseSlot(v.slot);
  if (v.slot !== null && slot === null) return null;
  const reason = v.reason as ReviewReason;
  // A slot belongs only to the two reasons that carry one; the generic review never does (it would be a date to hide).
  if ((reason === "moved" || reason === "work_started") !== (slot !== null))
    return null;
  return { reason, resolved: v.resolved, slot };
}

/**
 * "Acknowledge": the queued `resolve_review` on the REVIEW's version (`expected_version`, from the outbox's bases), with `resolved: true`
 * shown at once (the display patch). `observed`: the read the card was shown from, checked again when the change is written, so a review
 * that changed or left between showing and pressing is never acknowledged blindly.
 */
export function resolveReviewRequest(
  row: Pick<CacheRow, "id" | "value">,
  localId?: LocalId,
  observed?: Observation,
): EnqueueRequest {
  const { id } = row;
  return {
    endpoint: CALENDAR_COMMANDS,
    targets: [
      {
        resourceId: id,
        role: "primary",
        basis: "resource",
        versionChecked: true,
        requiresEdit: true,
      },
    ],
    build: (bases) => ({
      command: {
        command: {
          kind: "resolve_review",
          id,
          expected_version: bases[id] as number,
          resolved: true,
        },
      },
      displayPatch: {
        [id]: {
          value: {
            ...((row.value ?? {}) as Record<string, unknown>),
            resolved: true,
          },
        },
      },
    }),
    ...(localId === undefined ? {} : { localId }),
    ...(observed === undefined ? {} : { observed }),
  };
}

/** The proposed move a `work_started` review offers to "Review this move…" (`YYYY-MM-DD` or `YYYY-MM-DDTHH:MM:SS`), or null. */
export function proposedMove(review: ReviewValue): string | null {
  if (review.reason !== "work_started" || review.slot?.date == null)
    return null;
  return review.slot.intended_time === null
    ? review.slot.date
    : `${review.slot.date}T${review.slot.intended_time}`;
}

/** The anchored occurrence's reference id as its slot key carries it (`anchor:<event id>` or `anchor:<field id>:<year>`), or null. */
export function anchorKeyReference(slotKey: string): string | null {
  if (!slotKey.startsWith("anchor:")) return null;
  const rest = slotKey.slice("anchor:".length);
  const id = rest.split(":")[0] ?? "";
  return /^[0-9a-f-]{36}$/.test(id) ? id : null;
}
