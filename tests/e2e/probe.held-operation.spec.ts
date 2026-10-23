import type { BrowserContext, Page } from "@playwright/test";
import type {
  HoldRelease,
  HoldToken,
} from "../../src/fixture/data-harness/main";
import { edit, serveIdentityReads } from "./data-local-faults";
import { untilDraftWriteCommitted } from "./data-operation-barriers";
import {
  ACCOUNT,
  bootSession,
  dataPage,
  seedSettled,
  startOutbox,
  stubNetwork,
  untilTreeSettled,
  uuid,
} from "./data-sync-helpers";
import { privateLedger, withHeldOperations } from "./held-operation";
import type { HeldOperationLedger } from "./held-operation-ledger";
import { expect, test } from "./helpers";

/**
 * WEB-08d revision 21 (review r20 R20-N1, design assessment 4645b621 Q1-Q8, Q12-Q13): qualification of the held-operation owner
 * (tests/e2e/held-operation.ts) and of the fixture's hold seam (`holdOutboxPlan`/`holdEnginePlan` tokens, disarm and stale release) in a
 * real engine, over the production outbox facade and real IndexedDB, as the native cases use them.
 *
 * Opt-in: discovered only with ATLAS_E2E_PROBES=held-operation (playwright.config.ts), run and judged by
 * scripts/validation/held-operation-probes.mjs. Two kinds of case:
 *  - `P..` controls PASS: a failure is placed deterministically at a named barrier (a thrown sentinel, never a sleep) inside a scope with a
 *    PRIVATE ledger, the sentinel is caught by the case, and what the scope did (released, disarmed, joined, what it recorded) is asserted.
 *  - `S..` reporter-shape probes FAIL ON PURPOSE with the case's own ledger, so the `heldOperations` fixture publishes it: the runner's
 *    oracle checks the exact Playwright errors of each (an assertion alone; an operation error alone; an assertion beside a separate
 *    operation, cleanup or page-loss error; a timeout), and the all-error reader's verdict for each.
 *
 * Revision 22 (review r21 R21-N1, design assessment 58bc72cc Q2-Q4): P14/P15 and S10-S21 qualify H7, an operation's rejection that the
 * case explicitly joins (`settled()`) and that then escapes the body. S10/S11 are the review's J1 (page-origin, assertion-like and plain),
 * S12 its J2 (the launched callback's own rejection); the others cover a synchronous throw, a value that is not an Error, a joined
 * rejection beside an unjoined one or a failed release, genuine assertions after a join or about an expected rejection, a handled but
 * unexpected rejection, and an expected rejection that escapes unasserted.
 *
 * FIXTURE evidence for this engine on this machine: the HTTP answers are scripted, the holds and the failing/never-settling operations are
 * the probes' own, and nothing here is product evidence.
 */
const A = uuid(61);
const SENTINEL = "probe sentinel: the body failed here";

const editDraft = (page: Page, label: string) =>
  page.evaluate(({ id, spec }) => window.__atlasData?.editQueued(id, spec), {
    id: A,
    spec: edit("r", A, label),
  });
/** An edit whose answer is held like any other, and which then really fails in the page (a genuine operation rejection). */
const failingEdit = (page: Page, label: string) =>
  page.evaluate(
    async ({ id, spec }) => {
      const answer = await window.__atlasData?.editQueued(id, spec);
      throw new Error(`probe operation failure after ${answer?.kind}`);
    },
    { id: A, spec: edit("r", A, label) },
  );
/** As `failingEdit`, but the operation's own error READS like an assertion (`Error: expect(`): it must still be reported as an error. */
const assertionLikeFailure = (page: Page, label: string) =>
  page.evaluate(
    async ({ id, spec }) => {
      await window.__atlasData?.editQueued(id, spec);
      throw new Error("expect(received).toBe(expected) inside the operation");
    },
    { id: A, spec: edit("r", A, label) },
  );
/** The launched callback's own (Node-side) rejection after the real edit: its text READS like an assertion (the review's J2). */
const callbackFailure = (page: Page, label: string) => async () => {
  await editDraft(page, label);
  throw new Error(
    "expect(received).toBe(expected) inside the operation callback",
  );
};
const neverSettles = (page: Page) =>
  page.evaluate(() => new Promise<never>(() => undefined));
const landed = (page: Page, text: string) =>
  untilDraftWriteCommitted(page, ACCOUNT, text);
const releaseRaw = (
  page: Page,
  kind: "outbox" | "engine",
  token?: HoldToken,
): Promise<HoldRelease | undefined> =>
  page.evaluate(
    ({ kind: which, token: owned }) =>
      which === "outbox"
        ? window.__atlasData?.releaseOutboxPlan(owned)
        : window.__atlasData?.releaseEnginePlan(owned),
    { kind, token },
  );
const armRaw = (page: Page): Promise<HoldToken | undefined> =>
  page.evaluate(() =>
    window.__atlasData?.holdOutboxPlan("data.editQueuedDraft"),
  );

/**
 * A page whose outbox (the production facade over real IndexedDB, with NO dispatcher: nothing is ever sent) has draft A queued. The page
 * stays online, so a probe can reload it.
 */
async function queued(context: BrowserContext): Promise<Page> {
  await stubNetwork(context);
  await serveIdentityReads(context);
  await seedSettled(context);
  const page = await bootSession(context);
  await untilTreeSettled(page, { connections: 0 });
  await startOutbox(page, ACCOUNT, { start: false });
  await untilTreeSettled(page, { connections: 2 });
  await page.evaluate(
    (acct) =>
      window.__atlasData?.put(acct, "cache", [
        {
          id: "r",
          kind: "person",
          parent_id: null,
          label: "r",
          value: null,
          version: 5,
          can_edit: true,
          archived: false,
          kind_date: null,
        },
      ]),
    ACCOUNT,
  );
  expect(
    await page.evaluate(
      (spec) => window.__atlasData?.enqueue(spec),
      edit("r", A, "original"),
    ),
  ).toMatchObject({ kind: "queued" });
  return page;
}
/** Runs `body` in a scope with a private ledger; returns the failure it threw (the sentinel, when placed) and the ledger. */
async function failing(
  body: Parameters<typeof withHeldOperations>[0],
  settleMs?: number,
): Promise<{ thrown: unknown; ledger: HeldOperationLedger }> {
  const ledger = privateLedger();
  let thrown: unknown = null;
  try {
    await withHeldOperations(body, { ledger, settleMs });
  } catch (error) {
    thrown = error;
  }
  return { thrown, ledger };
}
const sentinel = (): never => {
  throw new Error(SENTINEL);
};
const cleanup = (ledger: HeldOperationLedger, hold = 0) =>
  ledger.scopes[0]?.holds[hold]?.events.find(
    (e) => e.event === "cleanup-release",
  )?.detail as HoldRelease | string | undefined;

test.describe("held-operation probes: controls (pass)", () => {
  test("P01 healthy: the held edit is released at its success-path position and settles with its real answer; nothing stays armed or held", async ({
    context,
  }) => {
    const page = await queued(context);
    const ledger = privateLedger();
    await withHeldOperations(
      async (holds) => {
        const hold = await holds.holdOutbox(page, "data.editQueuedDraft");
        const saved = holds.launch("the saved edit", () =>
          editDraft(page, "saved"),
        );
        await hold.untilHeld();
        await landed(page, "saved");
        await hold.release();
        expect(await saved.settled()).toMatchObject({ kind: "edited" });
      },
      { ledger },
    );
    expect(ledger.errors).toEqual([]);
    const scope = ledger.scopes[0];
    expect(scope?.finalised).toBe(true);
    expect(scope?.problems).toEqual([]);
    expect(scope?.holds[0]?.events.map((e) => e.event)).toEqual([
      "armed",
      "held",
      "release",
    ]);
    expect(scope?.holds[0]?.events[2]?.detail).toEqual({
      outcome: "released",
      armed: false,
      held: false,
    });
    expect(scope?.calls[0]).toMatchObject({
      state: "fulfilled",
      joined: true,
    });
    expect(await releaseRaw(page, "outbox")).toEqual({
      outcome: "idle",
      armed: false,
      held: false,
    });
  });

  test("P02 a body that fails after arming, before the plan is reached: the arm is cancelled, the body's own failure is the one thrown, and a later edit is not held", async ({
    context,
  }) => {
    const page = await queued(context);
    const { thrown, ledger } = await failing(async (holds) => {
      await holds.holdOutbox(page, "data.editQueuedDraft");
      sentinel();
    });
    expect((thrown as Error | null)?.message).toBe(SENTINEL);
    expect(ledger.errors).toEqual([]);
    expect(cleanup(ledger)).toEqual({
      outcome: "disarmed",
      armed: false,
      held: false,
    });
    // The arm is gone: the next edit runs and answers at once (the seam's own state is read, not inferred from a time).
    expect(await editDraft(page, "after")).toMatchObject({ kind: "edited" });
    expect(
      await page.evaluate(() => window.__atlasData?.outboxPlanHeld()),
    ).toBe(false);
  });

  for (const at of ["held", "landed"] as const)
    test(`P03 a body that fails once the answer is held (${at === "held" ? "before its write is observed" : "after its write is observed"}): the hold is released, the edit settles with its real answer and is joined before the failure is thrown`, async ({
      context,
    }) => {
      const page = await queued(context);
      const { thrown, ledger } = await failing(async (holds) => {
        const hold = await holds.holdOutbox(page, "data.editQueuedDraft");
        holds.launch("the saved edit", () => editDraft(page, "saved"));
        await hold.untilHeld();
        if (at === "landed") await landed(page, "saved");
        sentinel();
      });
      expect((thrown as Error | null)?.message).toBe(SENTINEL);
      expect(ledger.errors).toEqual([]);
      expect(cleanup(ledger)).toEqual({
        outcome: "released",
        armed: false,
        held: false,
      });
      expect(ledger.scopes[0]?.calls[0]).toMatchObject({
        state: "fulfilled",
        joined: true,
      });
      await landed(page, "saved");
    });

  test("P04 a body that fails after its explicit release: the cleanup finds nothing to release, and joins the edit", async ({
    context,
  }) => {
    const page = await queued(context);
    const { thrown, ledger } = await failing(async (holds) => {
      const hold = await holds.holdOutbox(page, "data.editQueuedDraft");
      holds.launch("the saved edit", () => editDraft(page, "saved"));
      await hold.untilHeld();
      await hold.release();
      sentinel();
    });
    expect((thrown as Error | null)?.message).toBe(SENTINEL);
    expect(ledger.errors).toEqual([]);
    expect(cleanup(ledger)).toEqual({
      outcome: "idle",
      armed: false,
      held: false,
    });
    expect(ledger.scopes[0]?.calls[0]).toMatchObject({
      state: "fulfilled",
      joined: true,
    });
  });

  test("P05 the cleanup of an earlier arm cannot release a later one: a stale token does nothing, and the later arm's own cleanup disarms it", async ({
    context,
  }) => {
    const page = await queued(context);
    let first: HoldToken | null = null;
    await withHeldOperations(
      async (holds) => {
        const hold = await holds.holdOutbox(page, "data.editQueuedDraft");
        first = hold.token;
        const saved = holds.launch("the first edit", () =>
          editDraft(page, "first"),
        );
        await hold.untilHeld();
        await hold.release();
        await saved.settled();
      },
      { ledger: privateLedger() },
    );
    const { thrown, ledger } = await failing(async (holds) => {
      const later = await holds.holdOutbox(page, "data.editQueuedDraft");
      expect(later.token.generation).toBeGreaterThan(
        (first as HoldToken | null)?.generation ?? Number.POSITIVE_INFINITY,
      );
      expect(await releaseRaw(page, "outbox", first ?? undefined)).toEqual({
        outcome: "stale",
        armed: true,
        held: false,
      });
      sentinel();
    });
    expect((thrown as Error | null)?.message).toBe(SENTINEL);
    expect(ledger.errors).toEqual([]);
    expect(cleanup(ledger)).toEqual({
      outcome: "disarmed",
      armed: false,
      held: false,
    });
  });

  test("P06 an operation that really fails while its answer is held: its rejection is kept, and delivered to the case after the release", async ({
    context,
  }) => {
    const page = await queued(context);
    const ledger = privateLedger();
    await withHeldOperations(
      async (holds) => {
        const hold = await holds.holdOutbox(page, "data.editQueuedDraft");
        const call = holds.launch("the failing edit", () =>
          failingEdit(page, "saved"),
        );
        await hold.untilHeld();
        await hold.release();
        await expect(call.settled()).rejects.toThrow(
          "probe operation failure after edited",
        );
      },
      { ledger },
    );
    expect(ledger.errors).toEqual([]);
    expect(ledger.scopes[0]?.calls[0]).toMatchObject({
      state: "rejected",
      joined: true,
    });
  });

  test("P07 a body that fails while an operation that really fails is held: the body's failure is thrown, the operation's is recorded separately", async ({
    context,
  }) => {
    const page = await queued(context);
    const { thrown, ledger } = await failing(async (holds) => {
      const hold = await holds.holdOutbox(page, "data.editQueuedDraft");
      holds.launch("the failing edit", () => failingEdit(page, "saved"));
      await hold.untilHeld();
      sentinel();
    });
    expect((thrown as Error | null)?.message).toBe(SENTINEL);
    expect(ledger.errors).toHaveLength(1);
    expect(ledger.errors[0]).toContain("the operation the failing edit failed");
    expect(ledger.errors[0]).toContain("probe operation failure after edited");
    expect(ledger.errors[0]).not.toContain(SENTINEL);
  });

  test("P08 an operation that cannot settle: the cleanup's wait is bounded and the failure to settle is recorded, not treated as success", async ({
    context,
  }) => {
    const page = await queued(context);
    const { thrown, ledger } = await failing(async (holds) => {
      await holds.holdOutbox(page, "data.editQueuedDraft");
      holds.launch("the never-settling call", () => neverSettles(page));
      sentinel();
    }, 1_000);
    expect((thrown as Error | null)?.message).toBe(SENTINEL);
    expect(ledger.errors).toEqual([
      "the operation the never-settling call did not settle within 1000 ms of its hold's release",
    ]);
    // The call is owned by this probe: closing its page ends it (observed, never unhandled).
    await page.close();
    await expect
      .poll(() => ledger.scopes[0]?.calls[0]?.state, { timeout: 10_000 })
      .toBe("rejected");
  });

  test("P09 the page is navigated to a new document while its edit is held: the edit's loss and the gone hold are recorded, the new document's hold is untouched, and the committed row survives", async ({
    context,
  }) => {
    const page = await queued(context);
    let replacement: HoldToken | undefined;
    const { thrown, ledger } = await failing(async (holds) => {
      const hold = await holds.holdOutbox(page, "data.editQueuedDraft");
      holds.launch("the saved edit", () => editDraft(page, "saved"));
      await hold.untilHeld();
      await landed(page, "saved");
      // A new document in the same page, booted as `bootSession` boots one (the session moves the address to the app's route, so
      // `page.reload()` would load the app without the harness).
      await page.goto("/__session?route=%2Ftoday");
      await page.waitForFunction(
        () => window.__atlasFixture?.session?.booted !== undefined,
      );
      await page.evaluate(() => window.__atlasFixture?.session?.ready);
      await page.waitForFunction(() => window.__atlasData !== undefined);
      replacement = await armRaw(page);
      expect(replacement?.document).not.toBe(hold.token.document);
      sentinel();
    });
    expect((thrown as Error | null)?.message).toBe(SENTINEL);
    expect(cleanup(ledger)).toEqual({
      outcome: "stale",
      armed: true,
      held: false,
    });
    expect(ledger.errors).toHaveLength(2);
    expect(ledger.errors[0]).toContain(
      "could not be released: its document or arm is gone (stale token)",
    );
    expect(ledger.errors[1]).toContain("the operation the saved edit failed");
    // The replacement document's own hold was never released by the old cleanup: its owner disarms it now.
    expect(await releaseRaw(page, "outbox", replacement)).toEqual({
      outcome: "disarmed",
      armed: false,
      held: false,
    });
    // The edit's transaction committed before the document went: the new document's own store reads its row.
    await startOutbox(page, ACCOUNT, { start: false });
    await untilTreeSettled(page, { connections: 2 });
    await landed(page, "saved");
  });

  test("P10 two pages hold independently: one hold at a time per page, another page's token is stale, a repeated release is harmless, and one scope releases each page's hold by its own token", async ({
    context,
  }) => {
    const page = await queued(context);
    const other = await dataPage(context);
    const mine = await armRaw(page);
    const theirs = await armRaw(other);
    expect(mine?.document).not.toBe(theirs?.document);
    await expect(armRaw(other)).rejects.toThrow("one hold at a time");
    expect(await releaseRaw(page, "outbox", theirs)).toEqual({
      outcome: "stale",
      armed: true,
      held: false,
    });
    expect(await releaseRaw(other, "outbox", theirs)).toEqual({
      outcome: "disarmed",
      armed: false,
      held: false,
    });
    expect(await releaseRaw(other, "outbox", theirs)).toEqual({
      outcome: "idle",
      armed: false,
      held: false,
    });
    expect(await releaseRaw(page, "outbox", mine)).toEqual({
      outcome: "disarmed",
      armed: false,
      held: false,
    });
    const { thrown, ledger } = await failing(async (holds) => {
      const hold = await holds.holdOutbox(page, "data.editQueuedDraft");
      await holds.holdOutbox(other, "data.editQueuedDraft");
      holds.launch("the saved edit", () => editDraft(page, "saved"));
      await hold.untilHeld();
      sentinel();
    });
    expect((thrown as Error | null)?.message).toBe(SENTINEL);
    expect(ledger.errors).toEqual([]);
    expect(cleanup(ledger, 0)).toEqual({
      outcome: "released",
      armed: false,
      held: false,
    });
    expect(cleanup(ledger, 1)).toEqual({
      outcome: "disarmed",
      armed: false,
      held: false,
    });
  });

  test("P11 an engine hold the body never reaches: disarmed by its own token, and the engine seam is idle", async ({
    context,
  }) => {
    const page = await queued(context);
    const { thrown, ledger } = await failing(async (holds) => {
      await holds.holdEngine(page, "data.commitPage");
      sentinel();
    });
    expect((thrown as Error | null)?.message).toBe(SENTINEL);
    expect(ledger.errors).toEqual([]);
    expect(cleanup(ledger)).toEqual({
      outcome: "disarmed",
      armed: false,
      held: false,
    });
    expect(await releaseRaw(page, "engine")).toEqual({
      outcome: "idle",
      armed: false,
      held: false,
    });
  });

  test("P12 a body that ends without releasing its hold or joining its edit: the scope releases and joins them, and says so as its error", async ({
    context,
  }) => {
    const page = await queued(context);
    const ledger = privateLedger();
    let thrown: unknown = null;
    try {
      await withHeldOperations(
        async (holds) => {
          const hold = await holds.holdOutbox(page, "data.editQueuedDraft");
          holds.launch("the saved edit", () => editDraft(page, "saved"));
          await hold.untilHeld();
        },
        { ledger },
      );
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error | null)?.message).toBe(
      "held operations: the body did not release the held data.editQueuedDraft answer (released by the cleanup)",
    );
    expect(ledger.scopes[0]?.calls[0]).toMatchObject({
      state: "fulfilled",
      joined: true,
    });
  });
  test("P14 an operation the case expects to reject: `expectRejection()` with its matcher passes and nothing is witnessed, even when the body fails later for another reason", async ({
    context,
  }) => {
    const page = await queued(context);
    const ledger = privateLedger();
    await withHeldOperations(
      async (holds) => {
        const hold = await holds.holdOutbox(page, "data.editQueuedDraft");
        const call = holds.launch("the failing edit", () =>
          failingEdit(page, "saved"),
        );
        await hold.untilHeld();
        await hold.release();
        await expect(call.expectRejection()).rejects.toThrow(
          "probe operation failure after edited",
        );
      },
      { ledger },
    );
    expect(ledger.errors).toEqual([]);
    expect(ledger.escaped).toEqual([]);
    expect(ledger.scopes[0]?.calls[0]).toMatchObject({
      id: "s1.c1",
      state: "rejected",
      joined: true,
      rejectionExpected: true,
      rejectionsDelivered: 0,
    });
    const later = await failing(async (holds) => {
      const call = holds.launch("the expected rejection", () =>
        Promise.reject(new Error("the expected rejection")),
      );
      await expect(call.expectRejection()).rejects.toThrow(
        "the expected rejection",
      );
      sentinel();
    });
    expect((later.thrown as Error | null)?.message).toBe(SENTINEL);
    expect(later.ledger.errors).toEqual([]);
    expect(later.ledger.escaped).toEqual([]);
    expect(later.ledger.scopes[0]?.escaped).toEqual([]);
  });

  test("P15 witnesses are per call, by id: a rejection handed over twice, a value that is not an Error that escapes, and an unjoined synchronous throw are three entries, each once", async ({
    context,
  }) => {
    const page = await queued(context);
    const notAnError = "a rejection that is not an Error";
    const { thrown, ledger } = await failing(async (holds) => {
      const hold = await holds.holdOutbox(page, "data.editQueuedDraft");
      const first = holds.launch("the failing edit", () =>
        failingEdit(page, "saved"),
      );
      await hold.untilHeld();
      await hold.release();
      for (let i = 0; i < 2; i += 1)
        await first.settled().catch(() => undefined);
      holds.launch("the synchronous throw", () => {
        throw new Error("thrown synchronously");
      });
      const value = holds.launch("the value", () => Promise.reject(notAnError));
      await value.settled();
    });
    expect(thrown).toBe(notAnError);
    const calls = ledger.scopes[0]?.calls ?? [];
    expect(calls.map((c) => [c.id, c.state, c.rejectionsDelivered])).toEqual([
      ["s1.c1", "rejected", 2],
      ["s1.c2", "rejected", 0],
      ["s1.c3", "rejected", 1],
    ]);
    expect(calls[2]?.rejection).toEqual({
      type: "string",
      message: notAnError,
    });
    expect(calls[1]?.rejection).toMatchObject({
      type: "Error",
      message: "thrown synchronously",
    });
    expect(ledger.scopes[0]?.escaped).toEqual(["s1.c1", "s1.c3"]);
    expect(ledger.escaped).toHaveLength(2);
    expect(ledger.escaped.join("\n")).not.toContain(notAnError);
    expect(ledger.escaped.join("\n")).not.toContain("probe operation failure");
    expect(ledger.errors).toEqual([
      "the operation the synchronous throw failed: thrown synchronously",
    ]);
  });
});

test.describe("held-operation probes: a harness older than its seam (revision 21 attempt 1)", () => {
  test("P13 a release answered with something that is not a hold release (as a fixture build older than the seam answers): the body's failure is thrown, the bad answer is recorded, and the scope finishes", async ({
    context,
  }) => {
    const page = await queued(context);
    const { thrown, ledger } = await failing(async (holds) => {
      await holds.holdOutbox(page, "data.editQueuedDraft");
      // The page's harness now answers a release as one built before the tokens did.
      await page.evaluate(() => {
        const harness = window.__atlasData as unknown as Record<
          string,
          unknown
        >;
        harness.releaseOutboxPlan = () => undefined;
      });
      sentinel();
    });
    expect((thrown as Error | null)?.message).toBe(SENTINEL);
    expect(ledger.scopes[0]?.finalised).toBe(true);
    expect(ledger.errors).toHaveLength(1);
    expect(ledger.errors[0]).toContain(
      "the harness answered a release with undefined, not a hold release",
    );
  });
});

test.describe("held-operation probes: reporter shapes (fail on purpose; judged by the runner)", () => {
  test("S1 shape: an assertion fails while an edit's answer is held (the MU-990 schedule's shape): the assertion is the case's only error", async ({
    context,
  }) => {
    const page = await queued(context);
    await withHeldOperations(async (holds) => {
      const hold = await holds.holdOutbox(page, "data.editQueuedDraft");
      const saved = holds.launch("the saved edit", () =>
        editDraft(page, "saved"),
      );
      await hold.untilHeld();
      await landed(page, "saved");
      expect("fixed.1", "the probe's intended assertion").not.toBe("fixed.1");
      await hold.release();
      await saved.settled();
    });
  });

  test("S2 shape: an operation fails and the body never asks for its answer: the operation's error is the case's only error", async ({
    context,
  }) => {
    const page = await queued(context);
    await withHeldOperations(async (holds) => {
      const hold = await holds.holdOutbox(page, "data.editQueuedDraft");
      holds.launch("the failing edit", () => failingEdit(page, "saved"));
      await hold.untilHeld();
      await hold.release();
    });
  });

  test("S3 shape: an assertion fails while an operation that really fails is held: two errors, the assertion and the operation's", async ({
    context,
  }) => {
    const page = await queued(context);
    await withHeldOperations(async (holds) => {
      const hold = await holds.holdOutbox(page, "data.editQueuedDraft");
      holds.launch("the failing edit", () => failingEdit(page, "saved"));
      await hold.untilHeld();
      expect("fixed.1", "the probe's intended assertion").not.toBe("fixed.1");
    });
  });

  test("S4 shape: an assertion fails while an operation cannot settle: two errors, the assertion and the cleanup's", async ({
    context,
  }) => {
    const page = await queued(context);
    await withHeldOperations(
      async (holds) => {
        await holds.holdOutbox(page, "data.editQueuedDraft");
        holds.launch("the never-settling call", () => neverSettles(page));
        expect("fixed.1", "the probe's intended assertion").not.toBe("fixed.1");
      },
      { settleMs: 1_000 },
    );
  });

  test("S5 shape: the page is lost while its edit is held, then an assertion fails: the assertion and the cleanup's failure are separate errors", async ({
    context,
  }) => {
    const page = await queued(context);
    await withHeldOperations(async (holds) => {
      const hold = await holds.holdOutbox(page, "data.editQueuedDraft");
      holds.launch("the saved edit", () => editDraft(page, "saved"));
      await hold.untilHeld();
      await page.close();
      expect("fixed.1", "the probe's intended assertion").not.toBe("fixed.1");
    });
  });

  test("S6 shape: the case times out while its edit is held: a timeout, and the scope that never finished is reported", async ({
    context,
  }) => {
    // The probe's own deadline (not a product timer or an observation window): the case must end while the scope is still waiting.
    // Revision 22: the deadline starts once the page is ready (its fixtures and `queued` setup ran under the default timeout), so a slow
    // setup cannot end the case before the scope exists (revision 22 validation attempt 2: Firefox spent the old 15 s in
    // `untilTreeSettled`). The scope's wait below never ends, so the case still times out inside it, whatever the margin.
    const began = Date.now();
    const page = await queued(context);
    test.setTimeout(Date.now() - began + 30_000);
    await withHeldOperations(async (holds) => {
      const hold = await holds.holdOutbox(page, "data.editQueuedDraft");
      holds.launch("the saved edit", () => editDraft(page, "saved"));
      await hold.untilHeld();
      await new Promise<never>(() => undefined);
    });
  });

  test("S8 shape: an assertion fails while an operation whose error reads like an assertion is held: the operation's error is still an error", async ({
    context,
  }) => {
    const page = await queued(context);
    await withHeldOperations(async (holds) => {
      const hold = await holds.holdOutbox(page, "data.editQueuedDraft");
      holds.launch("the assertion-like failure", () =>
        assertionLikeFailure(page, "saved"),
      );
      await hold.untilHeld();
      expect("fixed.1", "the probe's intended assertion").not.toBe("fixed.1");
    });
  });

  test("S9 shape: an operation whose error reads like an assertion fails and the body never asks for its answer: an error, not an assertion", async ({
    context,
  }) => {
    const page = await queued(context);
    await withHeldOperations(async (holds) => {
      const hold = await holds.holdOutbox(page, "data.editQueuedDraft");
      holds.launch("the assertion-like failure", () =>
        assertionLikeFailure(page, "saved"),
      );
      await hold.untilHeld();
      await hold.release();
    });
  });

  test("S10 shape: an explicitly joined page operation whose error reads like an assertion escapes the body (the review's J1): the case is an error, with a separate runtime-origin witness", async ({
    context,
  }) => {
    const page = await queued(context);
    await withHeldOperations(async (holds) => {
      const hold = await holds.holdOutbox(page, "data.editQueuedDraft");
      const saved = holds.launch("the assertion-like failure", () =>
        assertionLikeFailure(page, "saved"),
      );
      await hold.untilHeld();
      await landed(page, "saved");
      await hold.release();
      await saved.settled();
    });
  });

  test("S11 shape: an explicitly joined page operation that fails plainly escapes the body: its error and a separate runtime-origin witness", async ({
    context,
  }) => {
    const page = await queued(context);
    await withHeldOperations(async (holds) => {
      const hold = await holds.holdOutbox(page, "data.editQueuedDraft");
      const saved = holds.launch("the failing edit", () =>
        failingEdit(page, "saved"),
      );
      await hold.untilHeld();
      await landed(page, "saved");
      await hold.release();
      await saved.settled();
    });
  });

  test("S12 shape: the launched callback's own rejection, reading like an assertion, escapes through an explicit join (the review's J2): an error, never a catch", async ({
    context,
  }) => {
    const page = await queued(context);
    await withHeldOperations(async (holds) => {
      const hold = await holds.holdOutbox(page, "data.editQueuedDraft");
      const saved = holds.launch(
        "the callback failure",
        callbackFailure(page, "saved"),
      );
      await hold.untilHeld();
      await landed(page, "saved");
      await hold.release();
      await saved.settled();
    });
  });

  test("S13 shape: a callback that throws synchronously, reading like an assertion, escapes through an explicit join: an error", async () => {
    await withHeldOperations(async (holds) => {
      const thrown = holds.launch("the synchronous throw", () => {
        throw new Error("expect(received).toBe(expected) thrown synchronously");
      });
      await thrown.settled();
    });
  });

  test("S14 shape: a rejection that is not an Error, reading like an assertion, escapes through an explicit join: an error", async () => {
    await withHeldOperations(async (holds) => {
      const value = holds.launch("the value", () =>
        Promise.reject("expect(received).toBe(expected) as a string"),
      );
      await value.settled();
    });
  });

  test("S15 shape: a joined rejection escapes while another operation fails unjoined: the escaped error, then one error with both the cleanup failure and the witness", async ({
    context,
  }) => {
    const page = await queued(context);
    await withHeldOperations(async (holds) => {
      const hold = await holds.holdOutbox(page, "data.editQueuedDraft");
      const saved = holds.launch("the assertion-like failure", () =>
        assertionLikeFailure(page, "saved"),
      );
      holds.launch("the second failure", () =>
        Promise.reject(new Error("the second operation failed")),
      );
      await hold.untilHeld();
      await hold.release();
      await saved.settled();
    });
  });

  test("S16 shape: a joined rejection escapes and a later hold's release fails: the escaped error, then one error with the release failure and the witness", async ({
    context,
  }) => {
    const page = await queued(context);
    await withHeldOperations(async (holds) => {
      const hold = await holds.holdOutbox(page, "data.editQueuedDraft");
      const saved = holds.launch("the assertion-like failure", () =>
        assertionLikeFailure(page, "saved"),
      );
      await hold.untilHeld();
      await hold.release();
      await holds.holdEngine(page, "data.commitPage");
      await page.evaluate(() => {
        const harness = window.__atlasData as unknown as Record<
          string,
          unknown
        >;
        harness.releaseEnginePlan = () => undefined;
      });
      await saved.settled();
    });
  });

  test("S17 shape: a successful join, then a genuine assertion fails: the assertion is the case's only error", async ({
    context,
  }) => {
    const page = await queued(context);
    await withHeldOperations(async (holds) => {
      const hold = await holds.holdOutbox(page, "data.editQueuedDraft");
      const saved = holds.launch("the saved edit", () =>
        editDraft(page, "saved"),
      );
      await hold.untilHeld();
      await hold.release();
      expect(await saved.settled()).toMatchObject({ kind: "edited" });
      expect("fixed.1", "the probe's intended assertion").not.toBe("fixed.1");
    });
  });

  test("S18 shape: an expected rejection whose message is not the expected one: the matcher's assertion is the case's only error", async ({
    context,
  }) => {
    const page = await queued(context);
    await withHeldOperations(async (holds) => {
      const hold = await holds.holdOutbox(page, "data.editQueuedDraft");
      const call = holds.launch("the failing edit", () =>
        failingEdit(page, "saved"),
      );
      await hold.untilHeld();
      await hold.release();
      await expect(call.expectRejection()).rejects.toThrow(
        "a message the operation never had",
      );
    });
  });

  test("S19 shape: a rejection handed over by `settled()` and handled, then a genuine assertion fails: observing is not expecting, so the case is an error", async ({
    context,
  }) => {
    const page = await queued(context);
    await withHeldOperations(async (holds) => {
      const hold = await holds.holdOutbox(page, "data.editQueuedDraft");
      const call = holds.launch("the failing edit", () =>
        failingEdit(page, "saved"),
      );
      await hold.untilHeld();
      await hold.release();
      await call.settled().catch(() => undefined);
      expect("fixed.1", "the probe's intended assertion").not.toBe("fixed.1");
    });
  });

  test("S20 shape: an expected rejection asserted by its matcher, then a different genuine assertion fails: the assertion is the case's only error", async ({
    context,
  }) => {
    const page = await queued(context);
    await withHeldOperations(async (holds) => {
      const hold = await holds.holdOutbox(page, "data.editQueuedDraft");
      const call = holds.launch("the failing edit", () =>
        failingEdit(page, "saved"),
      );
      await hold.untilHeld();
      await hold.release();
      await expect(call.expectRejection()).rejects.toThrow(
        "probe operation failure after edited",
      );
      expect("fixed.1", "the probe's intended assertion").not.toBe("fixed.1");
    });
  });

  test("S21 shape: an expected rejection, reading like an assertion, escapes the body unasserted: it is the body's failure, so it is witnessed and the case is an error", async ({
    context,
  }) => {
    const page = await queued(context);
    await withHeldOperations(async (holds) => {
      const hold = await holds.holdOutbox(page, "data.editQueuedDraft");
      const call = holds.launch("the assertion-like failure", () =>
        assertionLikeFailure(page, "saved"),
      );
      await hold.untilHeld();
      await hold.release();
      await call.expectRejection();
    });
  });

  test("S7 shape: a plain assertion with no hold at all (the reporter's baseline)", async () => {
    expect("fixed.1", "the probe's intended assertion").not.toBe("fixed.1");
  });
});
