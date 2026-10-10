import { digestOf } from "../../../src/data/model/canonical";
import { commandKindOf } from "../../../src/data/model/outbox";
import type {
  CacheRow,
  DraftRow,
  DraftWithCommand,
  FormRecoveryRow,
  PendingEffectRow,
  ResourceVersionRow,
} from "../../../src/data/model/types";

/** Typed row factories for the data-layer tests. Every field is explicit, so a test states only what it cares about. */
let counter = 0;
const next = (): number => {
  counter += 1;
  return counter;
};
export const uuid = (n: number = next()): string =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/**
 * A draft as a test writes it: the header AND its body together. `world.put("drafts", [...])` splits it into the `drafts` row and
 * the `draft_commands` row (decision D-23), exactly as the enqueue plan writes them; `headerOf` strips the body again.
 */
export function draftRow(
  over: Partial<DraftWithCommand> = {},
): DraftWithCommand {
  const seq = over.created_seq ?? next();
  const command = over.command ?? { kind: "edit", n: seq };
  const endpoint = over.endpoint ?? "/commands";
  return {
    local_id: over.local_id ?? uuid(1000 + seq),
    account_id: "acct",
    endpoint: "/commands",
    target_id: null,
    kind: over.kind ?? commandKindOf(command, endpoint),
    command,
    command_digest: over.command_digest ?? digestOf(command),
    defaults_revision: null,
    target_resource_ids: [],
    side_effect_bases: {},
    index_targets: [],
    bases: {},
    bumped: [],
    defaults_context: null,
    review_block: null,
    depends_on: [],
    status: "queued",
    held_pending_cache: false,
    unavailable_outcome: false,
    retry_state: null,
    attempts: 0,
    last_attempt_at: null,
    last_error: null,
    display_patch: null,
    receipt_revision: null,
    created_seq: seq,
    created_at: "2026-10-01T09:00:00.000Z",
    ...over,
  };
}

/** The header of a test draft: the row the `drafts` store holds. */
export function headerOf(draft: DraftWithCommand): DraftRow {
  const { command: _command, ...header } = draft;
  return header;
}

export function recoveryRow(
  over: Partial<FormRecoveryRow> = {},
): FormRecoveryRow {
  const fields = over.fields ?? { name: "x" };
  return {
    form_context: "form",
    tab_instance_id: "tab",
    fields,
    redacted: [],
    saved_at: "2026-10-01T09:00:00.000Z",
    capture_seq: 1,
    terminal: false,
    content_digest: digestOf(fields),
    ...over,
  };
}

export function cacheRow(over: Partial<CacheRow> = {}): CacheRow {
  return {
    id: over.id ?? uuid(),
    kind: "person",
    parent_id: null,
    label: "label",
    value: null,
    version: 1,
    can_edit: true,
    archived: false,
    kind_date: null,
    ...over,
  };
}

export function effectRow(
  over: Partial<PendingEffectRow> = {},
): PendingEffectRow {
  return {
    resource_id: uuid(),
    local_id: uuid(),
    resource_version: 1,
    created_at: "2026-10-01T09:00:00.000Z",
    submitted_at_page_seq: 0,
    last_mentioned_page_seq: null,
    display: null,
    resolved: null,
    no_publication_floor: null,
    receipt_revision: null,
    ...over,
  };
}

export function versionRow(
  over: Partial<ResourceVersionRow> = {},
): ResourceVersionRow {
  return {
    resource_id: uuid(),
    locally_assumed_version: 1,
    basis: "resource",
    ...over,
  };
}
