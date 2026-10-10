// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  checkGuards,
  type GuardName,
  publishEpoch,
} from "../../src/data/model/guards";
import { initialSyncState } from "../../src/data/model/sync-state";
import type { Captured, SyncStateRow } from "../../src/data/model/types";
import { A, B, runScenario } from "../support/data/stamp-world";

/**
 * F-S6 (plan 8.2): each guard is exercised SEPARATELY, including the halves of a two-part guard, so that removing any one of
 * them is a distinct failure. G3 is the part that runs inside the data transaction; G1 and G2 are the service's.
 */
const sync = (over: Partial<SyncStateRow> = {}): SyncStateRow => ({
  ...initialSyncState("inc-1"),
  ...over,
});
const captured = (over: Partial<Captured> = {}): Captured => ({
  account: A,
  epoch: 3,
  incarnationId: "inc-1",
  requestSeq: 1,
  ownershipToken: null,
  recoveryGeneration: 0,
  expectedPosition: null,
  ...over,
});
const ALL: readonly GuardName[] = ["INC", "CLS", "CAS", "GEN", "OWN", "EPO"];

describe("G3: each guard drops on its own and only on its own", () => {
  test("everything matches: nothing is dropped", () => {
    expect(checkGuards(sync(), captured(), ALL)).toBeNull();
  });
  test("INC: another incarnation (the database was re-created)", () => {
    expect(
      checkGuards(sync({ incarnation_id: "inc-2" }), captured(), ALL),
    ).toBe("incarnation");
    expect(
      checkGuards(sync({ incarnation_id: "inc-2" }), captured(), [
        "CLS",
        "CAS",
        "GEN",
        "OWN",
        "EPO",
      ]),
    ).toBeNull();
  });
  test("a missing singleton drops whatever the guard set (nothing is applied to a damaged database)", () => {
    expect(checkGuards(undefined, captured(), [])).toBe("incarnation");
  });
  test("CLS: a closing fence", () => {
    const closing = sync({
      draft_fence: {
        token: "t",
        started_at: 1,
        operation_ids: [],
        consent_digest: "",
        closing: true,
      },
    });
    expect(checkGuards(closing, captured(), ALL)).toBe("closing");
    expect(
      checkGuards(closing, captured(), ["INC", "CAS", "GEN", "OWN", "EPO"]),
    ).toBeNull();
    const fenced = sync({
      draft_fence: {
        token: "t",
        started_at: 1,
        operation_ids: ["op"],
        consent_digest: "x",
        closing: false,
      },
    });
    expect(checkGuards(fenced, captured(), ALL)).toBeNull();
  });
  test("CAS: the cursor must equal the captured expected position", () => {
    expect(
      checkGuards(
        sync({ cursor: "p2" }),
        captured({ expectedPosition: "p1" }),
        ALL,
      ),
    ).toBe("position");
    expect(
      checkGuards(
        sync({ cursor: "p1" }),
        captured({ expectedPosition: "p1" }),
        ALL,
      ),
    ).toBeNull();
    expect(
      checkGuards(
        sync({ cursor: null }),
        captured({ expectedPosition: null }),
        ALL,
      ),
    ).toBeNull();
    expect(
      checkGuards(
        sync({ cursor: "p2" }),
        captured({ expectedPosition: "p1" }),
        ["INC", "CLS", "GEN", "OWN", "EPO"],
      ),
    ).toBeNull();
  });
  test("GEN: a different recovery generation", () => {
    expect(
      checkGuards(
        sync({ recovery_generation: 4 }),
        captured({ recoveryGeneration: 3 }),
        ALL,
      ),
    ).toBe("generation");
    expect(
      checkGuards(
        sync({ recovery_generation: 4 }),
        captured({ recoveryGeneration: 3 }),
        ["INC", "CLS", "CAS", "OWN", "EPO"],
      ),
    ).toBeNull();
  });
  test("OWN: a different ownership token (a null owner equals a null token)", () => {
    const owned = sync({
      owner: { tab_id: "t", ownership_token: "tok-1", heartbeat_at: 1 },
    });
    expect(checkGuards(owned, captured({ ownershipToken: "tok-2" }), ALL)).toBe(
      "owner",
    );
    expect(checkGuards(owned, captured({ ownershipToken: null }), ALL)).toBe(
      "owner",
    );
    expect(
      checkGuards(sync(), captured({ ownershipToken: "tok-1" }), ALL),
    ).toBe("owner");
    expect(
      checkGuards(owned, captured({ ownershipToken: "tok-1" }), ALL),
    ).toBeNull();
    expect(
      checkGuards(sync(), captured({ ownershipToken: null }), ALL),
    ).toBeNull();
    expect(
      checkGuards(owned, captured({ ownershipToken: "tok-2" }), [
        "INC",
        "CLS",
        "CAS",
        "GEN",
        "EPO",
      ]),
    ).toBeNull();
  });
  test("EPO: a later epoch was already published; an equal or earlier one was not", () => {
    expect(
      checkGuards(sync({ stamp: { epoch: 4 } }), captured({ epoch: 3 }), ALL),
    ).toBe("epoch_superseded");
    expect(
      checkGuards(sync({ stamp: { epoch: 3 } }), captured({ epoch: 3 }), ALL),
    ).toBeNull();
    expect(
      checkGuards(sync({ stamp: { epoch: 2 } }), captured({ epoch: 3 }), ALL),
    ).toBeNull();
    expect(
      checkGuards(sync({ stamp: null }), captured({ epoch: 3 }), ALL),
    ).toBeNull();
    expect(
      checkGuards(sync({ stamp: { epoch: 4 } }), captured({ epoch: 3 }), [
        "INC",
        "CLS",
        "CAS",
        "GEN",
        "OWN",
      ]),
    ).toBeNull();
  });
  test("a plan that lists a guard is subject to it; one that does not list it is not (the inventory test relies on this)", () => {
    expect(
      checkGuards(sync({ stamp: { epoch: 9 } }), captured(), ["INC"]),
    ).toBeNull();
  });
});

describe("the epoch mirror is monotone", () => {
  test("published only when it raises the stored epoch", () => {
    expect(publishEpoch(sync({ stamp: null }), 3)).toEqual({ epoch: 3 });
    expect(publishEpoch(sync({ stamp: { epoch: 3 } }), 5)).toEqual({
      epoch: 5,
    });
    expect(publishEpoch(sync({ stamp: { epoch: 5 } }), 3)).toBeNull();
    expect(publishEpoch(sync({ stamp: { epoch: 5 } }), 5)).toBeNull();
    expect(publishEpoch(sync({ stamp: null }), undefined)).toBeNull();
  });
});

describe("G1 and the halves of G2 (the service's), as separate failures", () => {
  const base = {
    transition: "none",
    position: "before_g2",
    hint: "delivered",
    completion: "normal",
    db: "open",
  } as const;
  test("account EQUAL, epoch DIFFERENT: dropped", async () => {
    const o = await runScenario({ ...base, transition: "self_reauth" });
    expect([o.result, o.reason]).toEqual(["dropped", "identity_changed"]);
  });
  test("epoch EQUAL, account DIFFERENT is also dropped (the epoch is global, but the comparison is on both)", async () => {
    const o = await runScenario({ ...base, transition: "self_switch" });
    expect([o.result, o.reason]).toEqual(["dropped", "identity_changed"]);
    expect(o.foreignWrites).toEqual([]);
  });
  test("G1: a request stamped with another account never reaches this account's service", async () => {
    // The service for A refuses a `captured` that names B before it touches the store.
    const { DataTestWorld } = await import("../support/data/env");
    const env = new DataTestWorld();
    env.idb.autoDrive = true;
    const page = env.page("A");
    page.identity.account = A;
    const identity = {
      get: () => ({ account_id: A, epoch: 1, session_id: "s" }),
      subscribe: () => () => undefined,
    };
    const runtime = new env.modules.accountService.DataRuntime({
      identity,
      persistence: env.modules.accountService.unorderedPersistence,
      registry: page.registry,
      open: (a, o) => page.open(a, o),
    });
    const opened = await runtime.open(A, { create: true });
    if (opened.kind !== "opened") throw new Error("setup");
    const { recordReadOutcome } = env.modules.retryPlans;
    const outcome = await opened.service.commit(recordReadOutcome, {
      captured: { ...opened.service.capture(1), account: B },
      caller: "k",
      outcome: { kind: "failure" },
      now: 1,
    });
    expect(outcome).toEqual({ kind: "dropped", reason: "identity_changed" });
    runtime.dispose();
  });
});
