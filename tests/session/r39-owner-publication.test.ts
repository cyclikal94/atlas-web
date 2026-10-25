// @vitest-environment node
import { describe, expect, test } from "vitest";
import { clearNonGating } from "../../src/session/model/reducers/attempt";
import type { AttemptMethod } from "../../src/session/model/types";
import type { FakePage, Fixture } from "../support/session/harness";
import { checkQuiescence } from "../support/session/properties";
import {
  holdLock,
  installAttempt,
  logsOf,
  newWorld,
  signedInPage,
  stateOf,
} from "../support/session/scenarios";

/**
 * F-R39-*: WEB-14a revision 36 (review of 25 October 2026, R39; design assessment S1-S10). `begin` commits a new epoch and only then takes
 * its owner lock `atlas-attempt-<epoch>`, both while it holds `atlas-auth`. Any page's evaluator can read the new epoch in between, and a
 * free owner lock seen THEN is an owner still on its way, not one that has gone. The attempt sweep therefore decides under `atlas-auth`
 * from the record as it is then, and its clearing transaction re-checks the reason it acts on.
 *
 * The interval is held with the fake platform's admission gate: the owner's request has not reached the queue, so another page's real
 * `ifAvailable` request on that name is granted (the review's diagnostic, at the unit layer). Nothing is fabricated: no lock answer, no
 * record write, no shortened timer.
 */
const API = "/api/experimental/v1";
const ownerOf = (page: FakePage, epoch: number) => (p: string, name: string) =>
  p === page.id && name === `atlas-attempt-${epoch}`;
/** Real `ifAvailable` requests of `page` for the owner lock that were GRANTED (it saw the name free). */
const freeProbes = (f: Fixture, page: FakePage, epoch: number) =>
  logsOf(f, "lock.grant").filter(
    (e) => e.page === page.id && e.name === `atlas-attempt-${epoch}`,
  ).length;
const clears = (f: Fixture) =>
  logsOf(f, "store.commit").filter(
    (e) => e.label === "clear_attempt" && e.result === "CLEARED",
  );
const activations = (f: Fixture) =>
  f.server.requests.filter((r) => r.path === `${API}/browser-sessions/activate`)
    .length;

/** Begin `method` in `page` with its owner request held before admission; returns once the epoch is durable and auth is held. */
async function publishing(
  f: Fixture,
  page: FakePage,
  method: AttemptMethod,
  epoch: number,
) {
  const gate = f.locks.gate("admission", ownerOf(page, epoch));
  const begun = page.session.attempts.begin(method);
  await f.world.runUntilIdle();
  // The schedule itself: the epoch is committed, its allocator holds atlas-auth, and the owner lock is free (its request is not queued).
  expect(gate.held()).toBe(1);
  expect(stateOf(f).attempt).toMatchObject({ epoch, phase: "exchanging" });
  expect(f.locks.holdsExclusive(page.id, "atlas-auth")).toBe(true);
  expect(f.locks.isFree(`atlas-attempt-${epoch}`)).toBe(true);
  return { gate, begun };
}

async function started(
  f: Fixture,
  begun: ReturnType<FakePage["session"]["attempts"]["begin"]>,
) {
  const result = await f.runWith(begun);
  if (result.kind !== "started")
    throw new Error(`begin did not start: ${result.kind}`);
  return result.handle;
}

const METHODS: AttemptMethod[] = [
  "password",
  "registration",
  "oidc",
  "oidc_link",
];

describe("F-R39-1 (S1): an evaluator that reads the new epoch while its owner lock is still on its way leaves the attempt alone", () => {
  test.each(METHODS)(
    "a PEER evaluating in the publication interval keeps a live %s attempt: it is the owner's, unexpired, after the owner lock is held",
    async (method) => {
      const f = await newWorld();
      const owner = f.addPage();
      await f.boot(owner);
      const peer = f.addPage();
      await f.boot(peer);
      const { gate, begun } = await publishing(f, owner, method, 1);
      peer.session.actions.retry();
      await f.world.runUntilIdle();
      expect(freeProbes(f, peer, 1)).toBeGreaterThan(0); // the peer's real probe found the name free
      gate.release();
      const handle = await started(f, begun);
      await f.world.runUntilIdle();
      expect(clears(f)).toEqual([]);
      expect(stateOf(f).attempt).toMatchObject({
        epoch: 1,
        phase: "exchanging",
        method,
      });
      expect(f.locks.heldNames(owner.id)).toContain(
        `atlas-attempt-${handle.epoch}`,
      );
      expect(checkQuiescence(f)).toEqual([]);
    },
  );

  test.each(METHODS)(
    "the INITIATING page's own evaluator in the publication interval keeps its %s attempt",
    async (method) => {
      const f = await newWorld();
      const owner = f.addPage();
      await f.boot(owner);
      const { gate, begun } = await publishing(f, owner, method, 1);
      owner.session.actions.retry();
      await f.world.runUntilIdle();
      expect(freeProbes(f, owner, 1)).toBeGreaterThan(0);
      gate.release();
      const handle = await started(f, begun);
      await f.world.runUntilIdle();
      expect(clears(f)).toEqual([]);
      expect(stateOf(f).attempt).toMatchObject({
        epoch: 1,
        phase: "exchanging",
        method,
      });
      expect(f.locks.heldNames(owner.id)).toContain(
        `atlas-attempt-${handle.epoch}`,
      );
    },
  );

  test("the review's S05 shape: a second sign-in while another page displays the first account still activates and settles", async () => {
    const f = await newWorld();
    const first = await signedInPage(f, "sam", "pw2");
    const peer = f.addPage();
    await f.boot(peer);
    expect(peer.session.view.get()).toMatchObject({ kind: "displaying" });
    const settledBefore = stateOf(f).settled;
    const { gate, begun } = await publishing(f, first.page, "password", 2);
    peer.session.actions.retry();
    first.page.session.actions.retry();
    await f.world.runUntilIdle();
    expect(freeProbes(f, peer, 2)).toBeGreaterThan(0);
    expect(stateOf(f).settled).toEqual(settledBefore);
    gate.release();
    const handle = await started(f, begun);
    const outcome = await f.runWith(
      first.page.session.attempts.signInWithPassword(handle, {
        username: "kieran",
        password: "pw",
      }),
    );
    await f.settle();
    const kieran = [...f.server.accounts.values()].find(
      (a) => a.username === "kieran",
    );
    expect(outcome).toMatchObject({
      kind: "settled",
      epoch: 2,
      account_id: kieran?.id,
    });
    expect(activations(f)).toBe(2); // Sam's, then Kieran's: the second activation is issued
    expect(stateOf(f).settled).toMatchObject({
      account_id: kieran?.id,
      epoch: 2,
    });
    expect(stateOf(f).attempt).toBeNull();
    expect(clears(f)).toEqual([]);
    expect(f.store.violations).toEqual([]);
  });

  test("a registration whose allocation a peer reads in the interval still redeems its invitation and settles (never a spent invitation without a sign-in)", async () => {
    const f = await newWorld();
    const owner = f.addPage();
    await f.boot(owner);
    const peer = f.addPage();
    await f.boot(peer);
    const { gate, begun } = await publishing(f, owner, "registration", 1);
    peer.session.actions.retry();
    await f.world.runUntilIdle();
    gate.release();
    const handle = await started(f, begun);
    const input = {
      token: f.server.addInvitation().token,
      username: "newbie",
      password: "correct-horse-battery-9271",
    };
    const outcome = await f.runWith(
      owner.session.attempts.registerWithInvitation(handle, input),
    );
    expect(outcome).toMatchObject({ kind: "settled", method: "registration" });
    expect(f.server.invitations.get(input.token)?.state).toBe("redeemed");
    expect(activations(f)).toBe(1);
  });

  test("an OIDC attempt a peer reads in the interval is still the owner's to redirect: it becomes `redirected` with its own expiry", async () => {
    const f = await newWorld();
    const owner = f.addPage();
    await f.boot(owner);
    const peer = f.addPage();
    await f.boot(peer);
    const { gate, begun } = await publishing(f, owner, "oidc", 1);
    peer.session.actions.retry();
    await f.world.runUntilIdle();
    gate.release();
    const handle = await started(f, begun);
    await f.runWith(owner.session.attempts.markRedirected(handle));
    await f.world.runUntilIdle();
    expect(stateOf(f).attempt).toMatchObject({ epoch: 1, phase: "redirected" });
    expect(clears(f)).toEqual([]);
  });
});

describe("F-R39-2 (S2/S3): the controls on either side of the interval", () => {
  test("an owner lock already GRANTED whose callback is still on its way is held: the peer's probe is refused and the attempt is kept", async () => {
    const f = await newWorld();
    const owner = f.addPage();
    await f.boot(owner);
    const peer = f.addPage();
    await f.boot(peer);
    const gate = f.locks.gate("callback", ownerOf(owner, 1));
    const begun = owner.session.attempts.begin("password");
    await f.world.runUntilIdle();
    expect(gate.held()).toBe(1);
    expect(f.locks.heldNames(owner.id)).toContain("atlas-attempt-1");
    peer.session.actions.retry();
    await f.world.runUntilIdle();
    expect(freeProbes(f, peer, 1)).toBe(0);
    gate.release();
    await started(f, begun);
    await f.world.runUntilIdle();
    expect(stateOf(f).attempt).toMatchObject({ epoch: 1, phase: "exchanging" });
    expect(clears(f)).toEqual([]);
  });

  test("a GENUINE orphan in the interval (the initiating page destroyed) is cleared by a peer under atlas-auth; the earlier settlement is untouched", async () => {
    const f = await newWorld();
    const first = await signedInPage(f, "sam", "pw2");
    const peer = f.addPage();
    await f.boot(peer);
    const settledBefore = stateOf(f).settled;
    const { gate } = await publishing(f, first.page, "password", 2);
    peer.session.actions.retry();
    await f.world.runUntilIdle();
    first.page.destroy();
    gate.release(); // the destroyed page's request is dropped, as the platform drops it
    await f.world.runUntilIdle();
    expect(stateOf(f).attempt).toBeNull();
    expect(stateOf(f).latest_epoch).toBe(2);
    expect(stateOf(f).settled).toEqual(settledBefore);
    expect(clears(f).map((e) => e.page)).toEqual([peer.id]);
    expect(activations(f)).toBe(1);
  });

  test("an owner that is alive but hidden and frozen keeps its exchanging attempt until the phase's expiry (90 s); then a peer clears it", async () => {
    const f = await newWorld();
    const owner = f.addPage();
    await f.boot(owner);
    const peer = f.addPage();
    await f.boot(peer);
    await f.runWith(owner.session.attempts.begin("password"));
    owner.hide();
    owner.freeze();
    peer.session.actions.retry();
    await f.world.runUntilIdle();
    await f.world.advance(89_000);
    expect(stateOf(f).attempt).toMatchObject({ epoch: 1, phase: "exchanging" });
    await f.world.advance(2_000);
    expect(stateOf(f).attempt).toBeNull();
    expect(clears(f).map((e) => e.page)).toEqual([peer.id]);
  });

  test("a gating attempt is never swept, whatever its owner lock and its expiry say", async () => {
    const f = await newWorld();
    const page = f.addPage();
    await f.boot(page);
    installAttempt(f, { epoch: 3, phase: "indeterminate" });
    page.goOffline();
    page.session.actions.retry();
    await f.world.advance(24 * 60 * 60 * 1000);
    expect(stateOf(f).attempt).toMatchObject({
      epoch: 3,
      phase: "indeterminate",
    });
    expect(clears(f)).toEqual([]);
  });
});

describe("F-R39-3 (S4/S8/S9/S10): supersession, cancellation and failures", () => {
  test("a failed owner request is not a started attempt: begin reports it, and the orphaned epoch is swept", async () => {
    const f = await newWorld();
    const owner = f.addPage();
    await f.boot(owner);
    const peer = f.addPage();
    await f.boot(peer);
    const gate = f.locks.gate("admission", ownerOf(owner, 1));
    const begun = owner.session.attempts.begin("password");
    await f.world.runUntilIdle();
    gate.fail();
    expect(await f.runWith(begun)).toEqual({ kind: "storage_unavailable" });
    expect(f.locks.heldNames(owner.id)).not.toContain("atlas-attempt-1");
    peer.session.actions.retry();
    await f.world.runUntilIdle();
    expect(stateOf(f).attempt).toBeNull();
    expect(f.locks.allHeldNames()).toEqual([]);
  });

  test("a decision that cannot get atlas-auth clears nothing and looks again after the back-off (no busy loop); then the orphan goes", async () => {
    const f = await newWorld();
    const owner = f.addPage();
    await f.boot(owner);
    const peer = f.addPage();
    await f.boot(peer);
    await f.runWith(owner.session.attempts.begin("password"));
    owner.destroy();
    await f.world.runUntilIdle();
    const releaseAuth = await holdLock(f, "frozen-tab", "atlas-auth");
    // A plain evaluation (the page shown again), not the retry action: that also starts terminal resolution, whose own back-off
    // would evaluate again and hide whether the sweep looks again by itself.
    peer.hide();
    peer.show();
    await f.world.runUntilIdle();
    const sweepsBefore = logsOf(f, "store.create").filter(
      (e) => e.page === peer.id,
    ).length;
    await f.world.advance(peer.kernel.config.lockWaitMs);
    expect(stateOf(f).attempt).toMatchObject({ epoch: 1, phase: "exchanging" });
    expect(clears(f)).toEqual([]);
    releaseAuth();
    await f.world.advance(peer.kernel.config.backoffInitialMs + 1_000);
    expect(stateOf(f).attempt).toBeNull();
    expect(clears(f).map((e) => e.page)).toEqual([peer.id]);
    // One timed look again, not a loop: a handful of reads, far below what a spin over 22 s of fake time would make.
    const reads =
      logsOf(f, "store.create").filter((e) => e.page === peer.id).length -
      sweepsBefore;
    expect(reads).toBeLessThan(20);
    expect(f.world.livelocked).toBe(false);
  });

  test("a redirect that renews the expiry between the protected read and the clear wins: the redirected attempt is kept (S5)", async () => {
    const f = await newWorld();
    const owner = f.addPage();
    await f.boot(owner);
    const peer = f.addPage();
    await f.boot(peer);
    const begun = await f.runWith(owner.session.attempts.begin("oidc"));
    if (begun.kind !== "started") throw new Error("x");
    await f.world.runUntilIdle();
    // Hold the completion of the peer's protected read (made while it holds atlas-auth) so the redirect commits after it.
    let heldRead: number | null = null;
    f.world.onLog((entry) => {
      if (
        heldRead === null &&
        entry.type === "store.create" &&
        entry.page === peer.id &&
        entry.label === "read" &&
        f.locks.holdsExclusive(peer.id, "atlas-auth")
      ) {
        heldRead = entry.order as number;
        f.world.setKnob("D0", "unbounded", (m) => m.tx === heldRead);
      }
    });
    await f.world.advance(owner.kernel.config.redirectedExpiryMs + 1_000);
    expect(heldRead).not.toBeNull();
    expect(f.world.heldCount("D0")).toBe(1);
    await f.runWith(owner.session.attempts.markRedirected(begun.handle));
    expect(stateOf(f).attempt).toMatchObject({ epoch: 1, phase: "redirected" });
    f.world.release("D0");
    await f.world.runUntilIdle();
    expect(stateOf(f).attempt).toMatchObject({ epoch: 1, phase: "redirected" });
    expect(clears(f)).toEqual([]);
    expect(
      logsOf(f, "store.commit").filter(
        (e) => e.label === "clear_attempt" && e.page === peer.id,
      ),
    ).toMatchObject([{ result: "NOT_ALLOWED" }]);
    // At the renewed deadline it goes (phase-specific expiry still applies).
    await f.world.advance(owner.kernel.config.redirectedExpiryMs + 1_000);
    expect(stateOf(f).attempt).toBeNull();
  });

  test("two peers sweeping one genuine orphan: it is cleared once, the other finds nothing to do", async () => {
    const f = await newWorld();
    const owner = f.addPage();
    await f.boot(owner);
    const b = f.addPage();
    await f.boot(b);
    const c = f.addPage();
    await f.boot(c);
    await f.runWith(owner.session.attempts.begin("password"));
    owner.destroy();
    await f.world.runUntilIdle();
    b.session.actions.retry();
    c.session.actions.retry();
    await f.world.runUntilIdle();
    expect(stateOf(f).attempt).toBeNull();
    expect(clears(f)).toHaveLength(1);
    expect(f.store.violations).toEqual([]);
  });

  test("a newer epoch allocated while a peer's look at the older one waits for atlas-auth is not cleared by that look (S4)", async () => {
    const f = await newWorld();
    const old = f.addPage();
    await f.boot(old);
    const peer = f.addPage();
    await f.boot(peer);
    const next = f.addPage();
    await f.boot(next);
    await f.runWith(old.session.attempts.begin("password"));
    old.destroy();
    await f.world.runUntilIdle();
    // The peer's look at epoch 1 queues behind `next`'s allocation, which holds atlas-auth while its owner request is held.
    const { gate, begun } = await publishing(f, next, "password", 2);
    peer.session.actions.retry();
    await f.world.runUntilIdle();
    gate.release();
    await started(f, begun);
    await f.world.runUntilIdle();
    expect(stateOf(f).attempt).toMatchObject({ epoch: 2, phase: "exchanging" });
    expect(f.locks.heldNames(next.id)).toContain("atlas-attempt-2");
    expect(clears(f)).toEqual([]);
  });

  test("the owner's explicit cancel clears its live, unexpired attempt at once (it needs no orphan or expiry reason) and releases the owner", async () => {
    const f = await newWorld();
    const owner = f.addPage();
    await f.boot(owner);
    const peer = f.addPage();
    await f.boot(peer);
    const begun = await f.runWith(owner.session.attempts.begin("password"));
    if (begun.kind !== "started") throw new Error("x");
    expect(f.locks.heldNames(owner.id)).toContain("atlas-attempt-1");
    await f.runWith(owner.session.attempts.cancel(begun.handle));
    expect(stateOf(f).attempt).toBeNull();
    expect(clears(f).map((e) => e.page)).toEqual([owner.id]);
    expect(
      f.locks.allHeldNames().some((h) => h.name.startsWith("atlas-attempt-")),
    ).toBe(false);
  });
});

describe("F-R39-4 (C3): the clearing transaction re-checks its reason against the record it rewrites", () => {
  const records = (attempt: Partial<ReturnType<typeof base>> = {}) => {
    const a = { ...base(), ...attempt };
    return {
      auth_state: {
        latest_epoch: a.epoch,
        attempt: a,
        settled: null,
      },
    } as unknown as Parameters<typeof clearNonGating>[0];
  };
  function base() {
    return {
      epoch: 4,
      method: "oidc" as AttemptMethod,
      phase: "exchanging" as string,
      previous_account_id: null,
      target_account_id: null,
      verifier: "v".repeat(43),
      observations_deferred: null,
      cancel_result: null,
      started_at: "2026-10-25T00:00:00.000Z",
      expires_at: "2026-10-25T00:12:00.000Z",
    };
  }
  const at = (iso: string) => Date.parse(iso);

  test("an orphan decision needs the attempt still `exchanging`: a redirected one is refused (its owner is absent by design)", () => {
    expect(
      clearNonGating(records(), { epoch: 4, phase: "exchanging" }).result,
    ).toBe("CLEARED");
    expect(
      clearNonGating(records({ phase: "redirected" }), {
        epoch: 4,
        phase: "exchanging",
      }),
    ).toEqual({ write: null, result: "NOT_ALLOWED" });
  });

  test("an expiry decision needs the deadline still past at its own time: a renewed one is refused", () => {
    const decidedAt = at("2026-10-25T00:12:00.000Z");
    expect(
      clearNonGating(records(), { epoch: 4, expiredAt: decidedAt }).result,
    ).toBe("CLEARED");
    expect(
      clearNonGating(
        records({
          phase: "redirected",
          expires_at: "2026-10-25T00:24:00.000Z",
        }),
        {
          epoch: 4,
          expiredAt: decidedAt,
        },
      ),
    ).toEqual({ write: null, result: "NOT_ALLOWED" });
    expect(
      clearNonGating(records(), { epoch: 4, expiredAt: decidedAt - 1 }).result,
    ).toBe("NOT_ALLOWED");
  });

  const REASONS = [
    { epoch: 4 },
    { epoch: 4, phase: "exchanging" as const },
    { epoch: 4, expiredAt: Number.MAX_SAFE_INTEGER },
  ];

  test("another epoch is superseded for every reason", () => {
    for (const input of REASONS)
      expect(clearNonGating(records(), { ...input, epoch: 5 }).result).toBe(
        "SUPERSEDED",
      );
  });

  test("a gating phase is refused for every reason", () => {
    for (const input of REASONS)
      for (const phase of ["activating", "indeterminate", "verifying"])
        expect(clearNonGating(records({ phase }), input).result).toBe(
          "NOT_ALLOWED",
        );
  });

  test("the owner's own clear needs no reason: an unexpired redirected attempt of its epoch is cleared", () => {
    expect(
      clearNonGating(records({ phase: "redirected" }), { epoch: 4 }).result,
    ).toBe("CLEARED");
  });
});
