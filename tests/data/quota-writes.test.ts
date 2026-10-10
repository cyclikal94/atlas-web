// @vitest-environment node
import { describe, expect, test } from "vitest";
import { createQuotaGuard } from "../../src/data/engine/quota-guard";
import { DATA_CONFIG } from "../../src/data/model/config";
import {
  DRAFT_ALLOWANCE_BYTES,
  type EnqueueRequest,
  estimateDraftBytes,
} from "../../src/data/model/outbox";
import { createFormRecoveryPort } from "../../src/data/ports/form-recovery";
import { outboxWorld } from "../support/data/outbox-world";
import { cacheRow } from "../support/data/rows";

/**
 * R7: a successful input write must change what the next admission sees, and the size of a write must count, on EVERY path that
 * grows the stores. The estimate belongs to the origin, so the guard re-reads it after each growth and when another tab says it
 * wrote, and holds the bytes of writes in flight. FIXTURE evidence: the estimate is a stub and the engine's own quota is not
 * exercised (an engine cannot be made to raise `QuotaExceededError` on request).
 */
const MIB = 1024 * 1024;
const RESERVE = DATA_CONFIG.quotaReserveBytes;

const create = (id: string, padding = 0): EnqueueRequest => ({
  endpoint: "/commands",
  targets: [
    {
      resourceId: id,
      role: "primary",
      basis: "resource",
      versionChecked: false,
      seedIfUntracked: 1,
    },
  ],
  build: () => ({
    command: { kind: "create", id, pad: "x".repeat(padding) },
  }),
});

describe("the guard: reservations and re-reads", () => {
  const make = (state: { free: number }, now = { t: 0 }) =>
    createQuotaGuard({
      storage: { estimate: async () => ({ usage: 0, quota: state.free }) },
      now: () => now.t,
    });

  test("a written reservation makes the next check read the free space again (the reviewer's reproduction)", async () => {
    const state = { free: 9 * MIB };
    const guard = make(state);
    const first = await guard.reserve("input", 1024);
    expect(first.verdict).toBe("ok");
    first.settle("written");
    // The space falls by other means (another tab, the engine): the next admission sees it, not a five-second-old figure.
    state.free = 1 * MIB;
    expect((await guard.reserve("input", 1024)).verdict).toBe("refuse");
  });

  test("two writes in flight at once are each judged with the other's bytes held", async () => {
    const state = { free: RESERVE / 2 + 3 * MIB };
    const guard = make(state);
    const first = await guard.reserve("input", 2 * MIB);
    const second = await guard.reserve("input", 2 * MIB);
    expect(first.verdict).toBe("ok");
    expect(second.verdict).toBe("refuse");
    first.settle("not_written");
    // The hold is released when the first write ends without growth: the second can now be admitted.
    expect((await guard.reserve("input", 2 * MIB)).verdict).toBe("ok");
  });

  test("an estimate that lags behind the write cannot admit the next large write (the write's own bytes are debited)", async () => {
    const state = { free: RESERVE / 2 + 3 * MIB };
    const now = { t: 0 };
    const guard = make(state, now);
    const first = await guard.reserve("input", 2 * MIB);
    expect(first.verdict).toBe("ok");
    first.settle("written");
    // The browser still reports the old free space (it updates late): three MiB of room, two of them just used.
    now.t = 100;
    expect((await guard.reserve("input", 2 * MIB)).verdict).toBe("refuse");
    // Once the estimate is trusted again (its lifetime passed) the figure the browser reports stands.
    now.t = DATA_CONFIG.quotaEstimateTtlMs + 200;
    state.free = RESERVE / 2 + 6 * MIB;
    expect((await guard.reserve("input", 2 * MIB)).verdict).toBe("ok");
  });

  test("the size of the write counts: a write that would leave less than half the reserve is refused whatever the space before it", async () => {
    const guard = make({ free: RESERVE / 2 + 1 * MIB });
    expect((await guard.reserve("input", 512 * 1024)).verdict).toBe("ok");
    expect((await guard.reserve("input", 2 * MIB)).verdict).toBe("refuse");
  });

  test("a refused reservation holds nothing, and settle is idempotent", async () => {
    const guard = make({ free: RESERVE / 2 + 1 * MIB });
    const refused = await guard.reserve("input", 8 * MIB);
    expect(refused.verdict).toBe("refuse");
    refused.settle("written");
    const ok = await guard.reserve("input", 512 * 1024);
    ok.settle("not_written");
    ok.settle("not_written");
    expect((await guard.reserve("input", 512 * 1024)).verdict).toBe("ok");
  });
});

describe("the facade: every growing path asks, and the estimate is re-read after a write", () => {
  const started = async () => {
    const w = await outboxWorld();
    w.put("cache", [cacheRow({ id: "r", version: 5 })]);
    return w;
  };

  test("an enqueue at 9 MiB free, then free space falls to 1 MiB: the next enqueue is refused (the reviewer's reproduction)", async () => {
    const w = await started();
    w.freeBytes = 9 * MIB;
    w.quota.invalidate();
    expect((await w.outbox.enqueue(create("one"))).kind).toBe("queued");
    w.freeBytes = 1 * MIB;
    expect(await w.outbox.enqueue(create("two"))).toEqual({
      kind: "refused",
      reason: "quota",
    });
    expect(w.drafts()).toHaveLength(1);
  });

  test("the size of the command is part of the admission: a large import is refused where a small draft would be admitted", async () => {
    const w = await started();
    w.freeBytes = RESERVE / 2 + 1 * MIB;
    expect((await w.outbox.enqueue(create("small"))).kind).toBe("queued");
    expect(await w.outbox.enqueue(create("big", 3 * MIB))).toEqual({
      kind: "refused",
      reason: "quota",
    });
    expect(estimateDraftBytes(create("big", 3 * MIB))).toBeGreaterThan(3 * MIB);
    expect(estimateDraftBytes(create("small"))).toBeGreaterThanOrEqual(
      DRAFT_ALLOWANCE_BYTES,
    );
  });

  test("successive large saves near exhaustion: each is judged against the space the previous ones used", async () => {
    const w = await started();
    // Room for two 1 MiB imports above half the reserve, and the estimate never shows the growth (it lags).
    w.freeBytes = RESERVE / 2 + 2.5 * MIB;
    const outcomes: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const out = await w.outbox.enqueue(create(`big-${i}`, 1 * MIB));
      outcomes.push(out.kind === "queued" ? "queued" : out.reason);
    }
    expect(outcomes).toEqual(["queued", "queued", "quota", "quota"]);
  });

  test("a supersession is held to the same reserve (it stores a new command)", async () => {
    const w = await started();
    w.freeBytes = 500 * MIB;
    const original = await w.outbox.enqueue(create("a"));
    if (original.kind !== "queued") throw new Error("setup");
    // Make the original ineligible for a plain edit so a supersession is what a slice would call: `in_flight` and conflicting.
    w.freeBytes = 1 * MIB;
    w.quota.invalidate();
    expect(await w.outbox.supersede(original.localId, create("a2"))).toEqual({
      kind: "refused",
      reason: "quota",
    });
    expect(await w.outbox.editQueued(original.localId, create("a"))).toEqual({
      kind: "refused",
      reason: "quota",
    });
  });

  test("another tab's growth is seen: a data_changed message makes the next admission read the free space again", async () => {
    const w = await started();
    w.freeBytes = 500 * MIB;
    // This tab has read the origin's free space (and nothing of its own has been written since).
    expect(await w.quota.check("input")).toBe("ok");
    // Another tab filled the origin. Without being told, this tab would trust its five-second-old figure.
    w.freeBytes = 1 * MIB;
    w.deliver({
      type: "data_changed",
      account: "someone-else",
      stores: ["drafts"],
    });
    expect((await w.outbox.enqueue(create("other"))).kind).toBe("queued");
    expect(w.channelListeners.size).toBeGreaterThan(0);
    w.quota.invalidate();
    w.freeBytes = 500 * MIB;
    expect(await w.quota.check("input")).toBe("ok");
    w.freeBytes = 1 * MIB;
    w.deliver({
      type: "data_changed",
      account: w.service.account,
      stores: ["drafts"],
    });
    expect(await w.outbox.enqueue(create("two"))).toEqual({
      kind: "refused",
      reason: "quota",
    });
  });
});

describe("form recovery: the copy is user input and is held to the same reserve", () => {
  const port = (state: { free: number }) =>
    createFormRecoveryPort({
      service: () => stubService(),
      quota: createQuotaGuard({
        storage: { estimate: async () => ({ usage: 0, quota: state.free }) },
        now: () => 0,
      }),
      now: () => "t",
    });
  const calls: number[] = [];
  const stubService = () =>
    ({
      incarnationId: "i",
      store: {
        // (adapted, revision 19) The double answers the claim of a writer generation as the claim answers (`claimed`), and every other plan
        // as it always did. It used to answer the claim with `saved`, which is no answer the claim can give: the port used to go on with a
        // generation of `undefined`, and now fails closed on an answer it does not know (R1, revision 19). `calls` counts the writes only.
        run: async (plan: { name: string }) => {
          if (plan.name === "data.claimFormWriter")
            return { kind: "claimed", gen: 1 };
          calls.push(1);
          return { kind: "saved" };
        },
      },
    }) as never;
  const snap = (text: string) => ({
    formContext: "f",
    tabInstanceId: "t",
    values: { text },
    savedAt: "s",
  });

  test("a large form is refused when the space left would be below half the reserve, a small one is not", async () => {
    const state = { free: RESERVE / 2 + 100 * 1024 };
    const p = port(state);
    expect(await p.save(snap("short"))).toBe("saved");
    expect(await p.save(snap("y".repeat(200 * 1024)))).toBe("failed");
  });

  test("a saved copy makes the next save read the free space again", async () => {
    const state = { free: 500 * MIB };
    const p = port(state);
    expect(await p.save(snap("one"))).toBe("saved");
    state.free = 1 * MIB;
    expect(await p.save(snap("two"))).toBe("failed");
  });
});
