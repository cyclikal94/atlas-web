import {
  type DefaultsRecord,
  parseDefaultsRecord,
  type SharingSnapshot,
} from "../model/sharing-snapshot";
import type {
  Captured,
  DraftRow,
  JsonObject,
  LocalId,
  ResourceId,
  ResourceVersionRow,
} from "../model/types";
import { guardedPlan, readPlan } from "./builders";

/**
 * W14 `writeDefaults` (WEB-12a, reserved by WEB-09a): the B5 sharing snapshot, persisted as ONE record in `sync_state.defaults`.
 *
 * RESPONSE-DERIVED, so it carries the full guard set like W12 (G1 G2 INC CLS EPO): an answer of a former account, epoch or database
 * incarnation, or one that lands while a wipe is closing, writes nothing. It NEVER CREATES THE DATABASE: it runs only through an
 * `AccountService`, which exists only for a database that was opened, and the defaults source never opens one.
 *
 * GROWTH IS ADMITTED like a cache page (R28): the snapshot is server-sized (up to 32 households of 100 members), so its caller reserves
 * its bytes through the origin's quota ledger ("cache": refused before any input) and passes the reservation's `live()`, read here in
 * the step that decides what to write. A hold that lapsed writes nothing (`lapsed`); a refusal is never written around.
 *
 * Two pages may read the snapshot and land their answers in either order. The record kept is the one whose request was issued
 * LATER: a stored record issued after the incoming one stays, and the result says so (`written: false`, with what is stored), so the
 * page shows the newer state rather than its own older one. Otherwise the record is replaced WHOLE, never merged with an older one.
 */
export const writeDefaults = guardedPlan<
  {
    captured: Captured;
    snapshot: SharingSnapshot;
    issuedAt: number;
    now: number;
    /** The quota reservation's `live()`; absent: not admitted through the ledger (a test of the plan alone). */
    leaseLive?: () => boolean;
  },
  null,
  { written: boolean; stored: DefaultsRecord | null; lapsed?: true }
>({
  name: "data.writeDefaults",
  meta: { writer: "W14", guards: ["INC", "CLS", "EPO"], quota: "cache" },
  scope: [],
  durability: "default",
  read: async () => null,
  decide: ({ sync, input }) => {
    const stored = parseDefaultsRecord(sync.defaults);
    if (stored !== null && stored.issued_at > input.issuedAt)
      return { result: { written: false, stored } };
    if (input.leaseLive !== undefined && !input.leaseLive())
      return { result: { written: false, stored, lapsed: true } };
    const record: DefaultsRecord = {
      format: 1,
      snapshot: input.snapshot,
      fetched_at: input.now,
      issued_at: input.issuedAt,
      epoch: input.captured.epoch,
    };
    return {
      sync: { ...sync, defaults: record },
      result: { written: true, stored: record },
    };
  },
});

/** The persisted record, read tolerantly (a seed, another format or damage is "none"). */
export const readDefaults = readPlan<
  { incarnationId: string },
  null,
  DefaultsRecord | null
>({
  name: "data.readDefaults",
  scope: [],
  read: async () => null,
  decide: ({ sync }) => parseDefaultsRecord(sync?.defaults ?? null),
});

/**
 * What the defaults review's confirmation needs of ONE draft (D-12a-6): its header, its body (read for this one draft only, D-23) and the
 * basis on record for each id it targets, so the confirmation can address exactly the draft's own targets. Read only.
 */
export const readReviewDraft = readPlan<
  { incarnationId: string; localId: LocalId },
  {
    draft: DraftRow | undefined;
    command: JsonObject | undefined;
    basis: Array<[ResourceId, ResourceVersionRow["basis"]]>;
  },
  {
    draft: DraftRow;
    command: JsonObject;
    basis: Array<[ResourceId, ResourceVersionRow["basis"]]>;
  } | null
>({
  name: "data.readReviewDraft",
  scope: ["drafts", "draft_commands", "resource_versions"],
  read: async (reader, input) => {
    const draft = await reader.get("drafts", input.localId);
    if (draft === undefined) return { draft, command: undefined, basis: [] };
    const command = (await reader.get("draft_commands", input.localId))
      ?.command;
    const basis: Array<[ResourceId, ResourceVersionRow["basis"]]> = [];
    for (const id of draft.index_targets) {
      const row = await reader.get("resource_versions", id);
      if (row !== undefined) basis.push([id, row.basis]);
    }
    return { draft, command, basis };
  },
  decide: ({ reads }) =>
    reads.draft === undefined || reads.command === undefined
      ? null
      : { draft: reads.draft, command: reads.command, basis: reads.basis },
});
