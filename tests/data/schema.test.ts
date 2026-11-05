// @vitest-environment node
import { describe, expect, test } from "vitest";
import { DATA_CONFIG, maxResponseBytesFor } from "../../src/data/model/config";
import {
  accountDatabaseName,
  COMPOSITION_BARRIER_VERSION,
  D_INDEX_NAMES,
  DELTA_STAGING_VERSION,
  DEXIE_SCHEMA,
  DEXIE_SCHEMA_V1,
  DEXIE_SCHEMA_V3,
  KEY_PATHS,
  parseSchema,
  SCHEMA_VERSION,
  SPLIT_BODIES_VERSION,
  STORE_NAMES,
} from "../../src/data/model/schema";
import {
  FORBIDDEN_STREAK_FIELDS,
  initialSyncState,
} from "../../src/data/model/sync-state";

describe("F-A1: the schema constants equal plan 5.0.1", () => {
  test("ten stores (the nine of version 1 and `draft_commands`), in version 2, and the database name is exactly atlas-<account>", () => {
    // WEB-09c ADAPTATION (labelled, BOUNDED-SYNC-PAGINATION-20261027): version 4 adds ONE store, `delta_staging`. The original ten-store
    // assertion is kept unchanged for the version 2-3 schema, and the current schema is asserted to be exactly those ten plus that one.
    expect(Object.keys(DEXIE_SCHEMA_V3).sort()).toEqual(
      [
        "cache",
        "cache_staging",
        "draft_commands",
        "drafts",
        "form_recovery",
        "materialise_sequences",
        "pending_effects",
        "reminder_firings",
        "resource_versions",
        "sync_state",
      ].sort(),
    );
    expect([...STORE_NAMES].sort()).toEqual(
      [
        "cache",
        "cache_staging",
        "delta_staging",
        "draft_commands",
        "drafts",
        "form_recovery",
        "materialise_sequences",
        "pending_effects",
        "reminder_firings",
        "resource_versions",
        "sync_state",
      ].sort(),
    );
    // Adapted (WEB-10a revision 3): the version that introduced `draft_commands` is still 2; the current version is 3 (next test).
    expect(SPLIT_BODIES_VERSION).toBe(2);
    expect(accountDatabaseName("0f9f5a1e-aaaa-4bbb-8ccc-123456789abc")).toBe(
      "atlas-0f9f5a1e-aaaa-4bbb-8ccc-123456789abc",
    );
  });

  test("version 3 (WEB-10a revision 3) is the composition-generation barrier: it changes no store", () => {
    // WEB-09c ADAPTATION (labelled): the barrier is still version 3 and still changes no store (version 2 and 3 declare the same
    // schema); the CURRENT version is 4, which adds `delta_staging` and nothing else (next test).
    // BASE-MERGE NOTE (WEB-13b, 5 November 2026): unchanged; the current version is now 5 (below), still above the barrier.
    expect(COMPOSITION_BARRIER_VERSION).toBe(3);
    expect(SPLIT_BODIES_VERSION).toBeLessThan(COMPOSITION_BARRIER_VERSION);
    expect(COMPOSITION_BARRIER_VERSION).toBeLessThan(SCHEMA_VERSION);
  });

  test("version 4 (WEB-09c) adds exactly `delta_staging` (id, by revision) and changes no other store; version 1 never had it", () => {
    // BASE-MERGE ADAPTATION (labelled, WEB-13b, 5 November 2026): `expect(SCHEMA_VERSION).toBe(4)` is false by design once WEB-13b's
    // invalidation-witness barrier follows as version 5. Its intent, that version 4 is the version adding `delta_staging`, is kept on the
    // constant that now names it; the adapter declares version 5 with the same stores (`DEXIE_SCHEMA`), and the native E-CG2 reads them.
    expect(DELTA_STAGING_VERSION).toBe(4);
    expect(COMPOSITION_BARRIER_VERSION).toBeLessThan(DELTA_STAGING_VERSION);
    const { delta_staging, ...rest } = DEXIE_SCHEMA;
    expect(delta_staging).toBe("id, revision");
    expect(rest).toEqual(DEXIE_SCHEMA_V3);
    expect(Object.keys(DEXIE_SCHEMA_V1)).not.toContain("delta_staging");
    expect(KEY_PATHS.delta_staging).toBe("id");
  });

  // ADAPTED (WEB-13b revision 8, review 8 R7b; renumbered at the base merge of 5 November 2026): WEB-13b's branch numbered this barrier 4
  // and asserted `expect(SCHEMA_VERSION).toBe(4)` with the composition barrier before it. The accepted base's version 4 is WEB-09c's
  // `delta_staging`, so the witness barrier is version 5, after it; the original assertions are kept against the version now before it.
  test("version 5 (WEB-13b revision 8) is the invalidation-witness barrier: it changes no store, after the composition barrier and delta staging", () => {
    expect(SCHEMA_VERSION).toBe(5);
    expect(COMPOSITION_BARRIER_VERSION).toBeLessThan(SCHEMA_VERSION);
    expect(DELTA_STAGING_VERSION).toBeLessThan(SCHEMA_VERSION);
  });

  test("the Dexie strings and the design's index names (table of 5.0.1)", () => {
    // WEB-09c ADAPTATION (labelled): the table of 5.0.1 is the version 2-3 schema, unchanged; version 4's one addition is asserted above.
    expect(DEXIE_SCHEMA_V3).toEqual({
      cache: "id, kind, parent_id, [kind+kind_date]",
      cache_staging:
        "id, kind, parent_id, [kind+kind_date], recovery_generation",
      pending_effects: "[resource_id+local_id], resource_id, local_id",
      drafts:
        "local_id, status, created_seq, [status+created_seq], *depends_on, *index_targets, review_block.kind, retry_state.state",
      draft_commands: "local_id",
      resource_versions: "resource_id",
      materialise_sequences: "[task_id+through_date]",
      reminder_firings: "[rule_id+rule_version+occurrence_version]",
      form_recovery: "[form_context+tab_instance_id], form_context",
      sync_state: "key",
    });
    expect(D_INDEX_NAMES).toMatchObject({
      "cache.by_kind": "kind",
      "cache.by_parent": "parent_id",
      "cache.by_kind_date": "[kind+kind_date]",
      "pending_effects.by_resource": "resource_id",
      "pending_effects.by_draft": "local_id",
      "drafts.by_status": "status",
      "drafts.by_created_at": "created_seq",
      "drafts.by_depends_on": "depends_on",
      "drafts.by_target_resource": "index_targets",
      // Version 2 additions of this slice's own store.
      "drafts.by_status_seq": "[status+created_seq]",
      "drafts.by_review": "review_block.kind",
      "drafts.by_retry_state": "retry_state.state",
    });
  });

  test("the parsed definitions: key paths, compound keys and the multi-entry flags", () => {
    expect(parseSchema("drafts")).toEqual({
      keyPath: "local_id",
      indexes: [
        { name: "status", keyPath: "status", multiEntry: false },
        { name: "created_seq", keyPath: "created_seq", multiEntry: false },
        {
          name: "[status+created_seq]",
          keyPath: ["status", "created_seq"],
          multiEntry: false,
        },
        { name: "depends_on", keyPath: "depends_on", multiEntry: true },
        { name: "index_targets", keyPath: "index_targets", multiEntry: true },
        {
          name: "review_block.kind",
          keyPath: "review_block.kind",
          multiEntry: false,
        },
        {
          name: "retry_state.state",
          keyPath: "retry_state.state",
          multiEntry: false,
        },
      ],
    });
    expect(parseSchema("pending_effects").keyPath).toEqual([
      "resource_id",
      "local_id",
    ]);
    expect(
      parseSchema("cache").indexes.find((i) => i.name === "[kind+kind_date]")
        ?.keyPath,
    ).toEqual(["kind", "kind_date"]);
    for (const store of STORE_NAMES) {
      expect(parseSchema(store).keyPath, store).toEqual(KEY_PATHS[store]);
    }
  });
});

describe("F-A2: the seed", () => {
  const seed = initialSyncState("incarnation-1");
  test("every field of plan 5.0.3 is seeded", () => {
    expect(Object.keys(seed).sort()).toEqual(
      [
        "key",
        "incarnation_id",
        "cursor",
        "phase",
        "cache_status",
        "applied_revision",
        "page_seq",
        "request_seq",
        "last_synced_at",
        "draft_seq",
        "draft_fence",
        "defaults",
        "device_id",
        "device_verified",
        "device_verified_for",
        "read_retry_states",
        "local_write_streaks",
        "sizing",
        "profile",
        "stamp",
        "recovery_generation",
        "owner",
        "staging_position",
        "expected_position",
      ].sort(),
    );
    expect(seed).toMatchObject({
      key: "singleton",
      incarnation_id: "incarnation-1",
      cursor: null,
      phase: "snapshot",
      cache_status: "empty",
      applied_revision: null,
      page_seq: 0,
      request_seq: 0,
      draft_seq: 0,
      draft_fence: null,
      device_verified: false,
      read_retry_states: {},
      local_write_streaks: {},
      recovery_generation: 0,
      owner: null,
      stamp: null,
    });
    expect(seed.sizing).toEqual({
      limit: 1,
      class: null,
      floor_hits: 0,
      attempt: null,
    });
  });
  test("the fields that belong to WEB-09b, and the ones never defined, are not created", () => {
    for (const field of FORBIDDEN_STREAK_FIELDS)
      expect(seed).not.toHaveProperty(field);
  });
});

describe("the provisional constants are named in one module and none is a measured figure", () => {
  test("the sync limit never exceeds the SyncPage.batches maxItems", () => {
    expect(DATA_CONFIG.syncLimitMax).toBe(80);
    expect(DATA_CONFIG.initialLimitUnconstrained).toBeLessThanOrEqual(
      DATA_CONFIG.syncLimitMax,
    );
  });
  test("maxResponseBytesFor follows the contract maxima (800 changes x 9 KiB x 1.5 + 64 KiB per unit of limit)", () => {
    expect(maxResponseBytesFor(1)).toBe(
      Math.ceil(800 * 9 * 1024 * 1.5 + 64 * 1024),
    );
    expect(maxResponseBytesFor(4)).toBeGreaterThan(maxResponseBytesFor(1));
  });
});
