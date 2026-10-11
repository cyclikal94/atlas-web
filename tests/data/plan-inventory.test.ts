// @vitest-environment node
import { describe, expect, test } from "vitest";
import type { GuardName } from "../../src/data/model/guards";
import { listPlans, listReadPlans } from "../../src/data/plans/registry";
// Importing the plan modules registers their plans.
import "../../src/data/plans/epoch";
import "../../src/data/plans/fence";
import "../../src/data/plans/commit-page";
import "../../src/data/plans/defaults";
import "../../src/data/plans/form-recovery";
import "../../src/data/plans/outbox";
import "../../src/data/plans/pending-reads";
import "../../src/data/plans/profile";
import "../../src/data/plans/sync-writers";
import "../../src/data/plans/retry-state";
import "../../src/data/plans/recovery-writers";

/**
 * F-S7 and lint rule R18 (plan 5.2.4): the writer inventory is the authority. Every registered plan must belong to a writer of
 * the table and list AT LEAST that writer's guards; a plan added without a stated guard set fails the build. G1 and G2 are the
 * account service's (they are not a plan's); the guards below are those a plan applies from the database it reads.
 */
interface Row {
  name: string;
  guards: readonly GuardName[];
  durability: "strict" | "default";
}
const WRITER_TABLE: Readonly<Record<string, Row>> = {
  W1: {
    name: "commitPage",
    guards: ["INC", "CLS", "CAS", "GEN", "OWN", "EPO"],
    durability: "default",
  },
  W2: { name: "enqueueDraft", guards: ["INC", "FEN"], durability: "strict" },
  W3: { name: "editQueuedDraft", guards: ["INC", "FEN"], durability: "strict" },
  W4: {
    name: "discardDraft / cascade / recompute",
    guards: ["INC"],
    durability: "strict",
  },
  W5: { name: "markInFlight", guards: ["INC"], durability: "strict" },
  W6: {
    name: "admitReceipt",
    guards: ["INC", "CLS", "EPO"],
    durability: "strict",
  },
  W7: {
    name: "recordOutcome",
    guards: ["INC", "CLS", "EPO"],
    durability: "strict",
  },
  W8: { name: "recordFailureOfSend", guards: ["INC"], durability: "strict" },
  W9: {
    name: "saveFormRecovery / claimFormWriter / terminalFormRecovery",
    guards: ["INC", "CLS"],
    durability: "strict",
  },
  W10: {
    name: "setDraftFence / setClosing / releaseFence / stale-fence clear",
    guards: ["INC"],
    durability: "strict",
  },
  W11: {
    name: "read_retry_states / local_write_streaks",
    guards: ["INC"],
    durability: "default",
  },
  W12: {
    name: "writeProfile",
    guards: ["INC", "CLS", "EPO"],
    durability: "default",
  },
  W13: {
    name: "recordDeviceVerification",
    guards: ["INC", "CLS", "EPO"],
    durability: "default",
  },
  W14: {
    name: "writeDefaults",
    guards: ["INC", "CLS", "EPO"],
    durability: "default",
  },
  W15: { name: "publishEpoch", guards: [], durability: "strict" },
  W16: {
    name: "recordSizingAttempt / recordSizingOutcome",
    guards: ["INC"],
    durability: "default",
  },
  W17: { name: "createAccountDatabase", guards: [], durability: "strict" },
  W18: {
    name: "invalidateCache",
    guards: ["INC", "CLS", "EPO"],
    durability: "strict",
  },
  W19: { name: "captureRequest", guards: ["INC"], durability: "default" },
  // WEB-09b: ownership, the staged snapshot and its activation, the recovery-scoped retry classes.
  W20: {
    name: "acquireOwnership",
    guards: ["INC", "CLS"],
    durability: "strict",
  },
  W21: {
    name: "captureRecoveryRequest",
    guards: ["INC", "CLS", "OWN"],
    durability: "default",
  },
  W22: {
    name: "commitStagingPage",
    guards: ["INC", "CLS", "STG", "GEN", "OWN", "EPO"],
    durability: "default",
  },
  W23: {
    name: "activateSnapshot",
    guards: ["INC", "CLS", "STG", "GEN", "OWN", "EPO"],
    durability: "default",
  },
  W24: {
    name: "recordRecoveryOutcome",
    // R5 of the review of 10 October 2026: response-derived, so the epoch mirror too (and the stamp's G1/G2/G5 through `commit`).
    guards: ["INC", "CLS", "OWN", "GEN", "EPO"],
    durability: "strict",
  },
  W25: { name: "resetRecoveryBudget", guards: ["INC"], durability: "strict" },
  W26: {
    name: "reconcileOwedReceipts",
    guards: ["INC", "CLS", "OWN", "EPO"],
    durability: "default",
  },
};

/**
 * The writers whose plans exist: every row of the table but W17 (the versionchange transaction of the Dexie adapter, not a plan). W14
 * (`writeDefaults`) was reserved by WEB-09a and is WEB-12a's.
 */
const PRESENT_WRITERS: readonly string[] = [
  "W1",
  "W2",
  "W3",
  "W4",
  "W5",
  "W6",
  "W7",
  "W8",
  "W9",
  "W10",
  "W11",
  "W12",
  "W13",
  "W14",
  "W15",
  "W16",
  "W18",
  "W19",
  "W20",
  "W21",
  "W22",
  "W23",
  "W24",
  "W25",
  "W26",
];

describe("F-S7: the writer inventory", () => {
  const plans = listPlans();
  test("there are registered plans", () => {
    expect(plans.length).toBeGreaterThan(0);
  });
  test("every registered plan belongs to a writer of the table", () => {
    for (const plan of plans)
      expect(
        WRITER_TABLE[plan.writer],
        `${plan.name} names ${plan.writer}`,
      ).toBeDefined();
  });
  test("every registered plan lists AT LEAST its writer's guards; a plan that only READS lists the incarnation (it writes nothing to guard)", () => {
    for (const plan of plans) {
      const row = WRITER_TABLE[plan.writer] as Row;
      const required =
        plan.mode === "readonly"
          ? row.guards.filter((guard) => guard === "INC")
          : row.guards;
      for (const guard of required)
        expect(plan.guards, `${plan.name} must list ${guard}`).toContain(guard);
    }
  });
  test("a plan that applies a guard from the table is not weakened by a lower durability for a user-visible write", () => {
    for (const plan of plans) {
      const row = WRITER_TABLE[plan.writer] as Row;
      if (plan.mode === "readwrite" && row.durability === "strict")
        expect(plan.durability, `${plan.name} is a ${row.name} writer`).toBe(
          "strict",
        );
    }
  });
  test("every plan states its scope, mode and durability, and the names are unique", () => {
    const names = new Set<string>();
    for (const plan of plans) {
      expect(plan.scope.length).toBeGreaterThan(0);
      expect(["readonly", "readwrite"]).toContain(plan.mode);
      expect(["strict", "default"]).toContain(plan.durability);
      expect(names.has(plan.name), plan.name).toBe(false);
      names.add(plan.name);
    }
  });
  test("the writers implemented so far all have a plan", () => {
    const present = new Set(plans.map((plan) => plan.writer));
    for (const writer of PRESENT_WRITERS)
      expect(present.has(writer), `${writer} has no plan`).toBe(true);
  });
  test("plans that only READ are not writers: each is readonly, declares its scope, and none shares a name with a writer", () => {
    const reads = listReadPlans();
    expect(reads.length).toBeGreaterThan(0);
    const writers = new Set(plans.map((plan) => plan.name));
    for (const read of reads) {
      expect(read.mode, read.name).toBe("readonly");
      expect(read.scope.length, read.name).toBeGreaterThan(0);
      expect(writers.has(read.name), read.name).toBe(false);
    }
  });
  test("the feature reads of WEB-13a (D-13a-4) are registered READ plans over exactly the stores they read", () => {
    const by = (name: string) =>
      listReadPlans().find((read) => read.name === name);
    expect(by("data.readPendingCreates")).toMatchObject({ mode: "readonly" });
    expect([...(by("data.readPendingCreates")?.scope ?? [])].sort()).toEqual(
      ["cache", "draft_commands", "drafts", "sync_state"].sort(),
    );
    expect(by("data.readOutstanding")).toMatchObject({ mode: "readonly" });
    expect([...(by("data.readOutstanding")?.scope ?? [])].sort()).toEqual(
      ["draft_commands", "drafts", "sync_state"].sort(),
    );
    // Revision 2: Manage's one read of its source (cache, overlay, version record, drafts and the three bodies it may need).
    expect(by("data.readResourceView")).toMatchObject({ mode: "readonly" });
    expect([...(by("data.readResourceView")?.scope ?? [])].sort()).toEqual(
      [
        "cache",
        "draft_commands",
        "drafts",
        "pending_effects",
        "resource_versions",
        "sync_state",
      ].sort(),
    );
  });
  test("the outbox's writers carry the guards the table gives them, and the fence guard where a draft is inserted or edited", () => {
    const by = (name: string) => plans.find((plan) => plan.name === name);
    expect(by("data.enqueueDraft")?.guards).toEqual(
      expect.arrayContaining(["INC", "FEN"]),
    );
    expect(by("data.editQueuedDraft")?.guards).toEqual(
      expect.arrayContaining(["INC", "FEN"]),
    );
    expect(by("data.supersedeDraft")?.guards).toEqual(
      expect.arrayContaining(["INC", "FEN"]),
    );
    expect(by("data.admitReceipt")?.guards).toEqual(
      expect.arrayContaining(["INC", "CLS", "EPO"]),
    );
    expect(by("data.recordOutcome")?.guards).toEqual(
      expect.arrayContaining(["INC", "CLS", "EPO"]),
    );
    expect(by("data.markInFlight")?.guards).toEqual(
      expect.arrayContaining(["INC", "CLS"]),
    );
    // A person's input is the LAST thing the quota refuses, on EVERY path that grows the stores: an enqueue, an edit that replaces a
    // body, and a supersession (it stores a new command; R7). Nothing else in the outbox is refused by the reserve.
    for (const plan of plans.filter((p) => ["W2", "W3"].includes(p.writer)))
      expect(plan.quota).toBe("input");
    expect(by("data.supersedeDraft")?.quota).toBe("input");
    for (const plan of plans.filter(
      (p) =>
        ["W4", "W5", "W6", "W7", "W8"].includes(p.writer) &&
        p.name !== "data.supersedeDraft",
    ))
      expect(plan.quota).toBeNull();
  });
  test("every plan that declares a quota class is accounted for: admitted through the origin's ledger by its caller, or a fixed-size rewrite (R28, revision 14)", () => {
    // The sync engine's early `check` holds nothing, so a cache page is admitted where it is committed; a draft by the outbox facade; a
    // recovery copy by its port. Each reads the reservation's `live()` where its plan decides what to write (the plan's `leaseLive`).
    const ADMITTED = [
      "data.commitPage",
      // WEB-09b: a staged snapshot page and the activation are admitted like a delta page, by the job that commits them.
      "data.commitStagingPage",
      "data.activateSnapshot",
      "data.enqueueDraft",
      "data.editQueuedDraft",
      "data.supersedeDraft",
      "data.saveFormRecovery",
      // WEB-12a: the B5 sharing snapshot is server-sized (up to 32 households of 100 members), admitted as a cache write by the defaults source.
      "data.writeDefaults",
    ];
    // A fixed few hundred bytes, once per page context and form (the writer claim) or in place in the singleton `sync_state` row (the
    // verified name and the device id): no caller-sized growth, covered by the reserve's slack and the allowance each save carries.
    const FIXED_SIZE = [
      "data.claimFormWriter",
      "data.writeProfile",
      "data.recordDeviceVerification",
    ];
    expect(
      listPlans()
        .filter((plan) => plan.quota !== null)
        .map((plan) => plan.name)
        .sort(),
    ).toEqual([...ADMITTED, ...FIXED_SIZE].sort());
  });
  test("the table is exactly W1 to W26 (W20 to W26 are WEB-09b's; W26 added by R8 of the review of 10 October 2026)", () => {
    expect(Object.keys(WRITER_TABLE)).toEqual(
      Array.from({ length: 26 }, (_, i) => `W${i + 1}`),
    );
  });
});
