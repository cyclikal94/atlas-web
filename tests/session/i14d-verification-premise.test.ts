// @vitest-environment node
import { describe, expect, test } from "vitest";
import type { KernelEvent } from "../integration/first-observer";
import {
  judgeVerificationPremise,
  type VerificationPremiseInput,
} from "../integration/verification-premise";
import type { FakePage, Fixture } from "../support/session/harness";
import {
  leaseIds,
  newWorld,
  ordinaryGet,
  type SignedIn,
  signedInPage,
  stateOf,
} from "../support/session/scenarios";
import type { EventMeta } from "../support/session/world";

/**
 * WEB-08d revision 33 (review 34 R34-N1, family `i14d-post-navigation-lease-premise`): the premise of the revision-11 I-14d cases
 * ("a target document displays the settled session, then its own optional verification is outstanding") in every schedule the
 * setup can meet, over the REAL kernel in the fake world, each judged by the same witness the released-backend cases use
 * (tests/integration/verification-premise.ts), fed with this world's records.
 *
 * - The seed stays alive and idle: the target displays, then makes one verification with an empty captured set (accepted).
 * - The seed stays alive with a request outstanding: the target's exposure DEFERS on that live lease (neutral, nothing verified);
 *   once the seed's answer arrives the seed retires its lease, and the target displays and verifies as above (accepted).
 * - The seed's request fails on the network while the seed is alive: it retires cleanly, and the target is accepted.
 * - The seed is destroyed with one, or three, requests outstanding (review 34's navigation: `/defaults/snapshot` and two `/daily`):
 *   the leases survive, released to the target, whose exposure closes and whose verification captures EXACTLY those leases before any
 *   display. The witness rejects it for its own reasons; the target stays neutral while that answer is held, and its release
 *   resolves the captured leases and lets the same session display.
 * Each schedule ages the shared confirmation first, as the browser setup does (otherwise no optional verification is made at all).
 */
const CURRENT = "/browser-sessions/current";
const isCurrent = (meta: EventMeta) =>
  typeof meta.path === "string" && meta.path.endsWith(CURRENT);

const traceOf = (f: Fixture, page: FakePage): KernelEvent[] =>
  f.world.logs
    .filter(
      (entry) => entry.page === page.id && entry.type.startsWith("trace."),
    )
    .map(({ type, seq: _seq, t: _t, page: _page, ...data }) => ({
      event: type.slice("trace.".length),
      data,
    }));

/** Age the shared confirmation by 120 s (test set-up with the world idle, as the browser's checked transaction does). */
function age(f: Fixture): string {
  const confirmation = stateOf(f).confirmation;
  if (!confirmation) throw new Error("set-up: no shared confirmation");
  confirmation.confirmed_at = new Date(
    Date.parse(confirmation.confirmed_at) - 120_000,
  ).toISOString();
  return confirmation.confirmed_at;
}

const readsBy = (f: Fixture, page: FakePage) =>
  f.server.requests.filter(
    (r) => r.page === page.id && r.path.endsWith(CURRENT),
  ).length;

function premiseOf(
  f: Fixture,
  seed: SignedIn,
  target: FakePage,
  aged: string,
  readsBefore: number,
): VerificationPremiseInput {
  const state = stateOf(f);
  return {
    identity: {
      account: seed.account,
      epoch: seed.epoch,
      session: seed.sessionId,
    },
    seed: { boot: seed.page.session.bootId },
    target: {
      boot: target.session.bootId,
      token: { atBoot: target.id, atJudgement: target.id },
    },
    trace: traceOf(f, target),
    record: {
      settled: state.settled,
      confirmation: state.confirmation ?? null,
      leases: state.leases as VerificationPremiseInput["record"]["leases"],
    },
    agedConfirmedAt: aged,
    identityReads: {
      seed: readsBy(f, seed.page),
      target: readsBy(f, target),
      wire:
        f.server.requests.filter((r) => r.path.endsWith(CURRENT)).length -
        readsBefore,
      held: f.world.heldCount("Da", isCurrent),
    },
  };
}

/** Hold every identity answer from now on (the browser setup's proxy rule); `release` lets the held ones through. */
function holdVerification(f: Fixture) {
  const stop = f.server.addRule({
    match: (r) => r.path.endsWith(CURRENT),
    delay: "unbounded",
  });
  return {
    release: () => {
      stop();
      return f.world.release("Da", isCurrent);
    },
  };
}

const holdProbe = (f: Fixture) =>
  f.server.addRule({
    match: (r) => r.path.endsWith("/probe"),
    delay: "unbounded",
  });
const releaseProbe = (f: Fixture) =>
  f.world.release(
    "Da",
    (meta) => typeof meta.path === "string" && meta.path.endsWith("/probe"),
  );

async function bootTarget(f: Fixture): Promise<FakePage> {
  const target = f.addPage();
  await f.boot(target);
  await f.world.runUntilIdle();
  return target;
}

describe("I-14d premise over the real kernel: a target document's optional verification after display", () => {
  test("the seed is alive and idle: the target displays, then makes one verification with nothing captured (accepted)", async () => {
    const f = await newWorld();
    const seed = await signedInPage(f);
    expect(leaseIds(f)).toEqual([]);
    const before = f.server.requests.filter((r) =>
      r.path.endsWith(CURRENT),
    ).length;
    const aged = age(f);
    const verification = holdVerification(f);
    const target = await bootTarget(f);
    expect(target.session.view.get().kind).toBe("displaying");
    const verdict = judgeVerificationPremise(
      premiseOf(f, seed, target, aged, before),
    );
    expect(verdict.problems).toEqual([]);
    expect(verdict.exposure).not.toBeNull();
    expect(verdict.verification?.issued).toBeGreaterThan(
      verdict.verification?.committed ?? Infinity,
    );
    expect(verification.release()).toBe(1);
    await f.world.runUntilIdle();
    expect(target.session.view.get().kind).toBe("displaying");
    expect(seed.page.session.view.get().kind).toBe("displaying");
    expect(leaseIds(f)).toEqual([]);
    expect(stateOf(f).fences).toEqual({});
  });

  test("the seed is alive with a request outstanding: the target's exposure waits for that live lease, then is accepted", async () => {
    const f = await newWorld();
    const seed = await signedInPage(f);
    const before = f.server.requests.filter((r) =>
      r.path.endsWith(CURRENT),
    ).length;
    const aged = age(f);
    holdProbe(f);
    const outstanding = ordinaryGet(seed.page, seed.account, seed.epoch);
    await f.world.runUntilIdle();
    const [seedLease] = leaseIds(f);
    expect(leaseIds(f)).toHaveLength(1);
    expect(stateOf(f).leases[seedLease as string]?.boot_id).toBe(
      seed.page.session.bootId,
    );
    const verification = holdVerification(f);
    const target = await bootTarget(f);
    // Deferred on the seed's LIVE lease: neutral, no exposure, no verification of any kind.
    expect(target.session.view.get().kind).toBe("neutral");
    const deferred = traceOf(f, target);
    expect(deferred.some((e) => e.event === "act.begin")).toBe(false);
    expect(
      deferred.some(
        (e) =>
          e.event === "activity.create" && e.data?.klass === "verification",
      ),
    ).toBe(false);
    expect(readsBy(f, target)).toBe(0);
    // The seed's answer arrives; the seed retires its own lease; the target's wait is granted and it displays.
    expect(releaseProbe(f)).toBe(1);
    await f.world.runUntilIdle();
    expect((await outstanding).status).toBe(200);
    expect(target.session.view.get().kind).toBe("displaying");
    const verdict = judgeVerificationPremise(
      premiseOf(f, seed, target, aged, before),
    );
    expect(verdict.problems).toEqual([]);
    expect(leaseIds(f)).toEqual([verdict.verification?.lease]);
    verification.release();
    await f.world.runUntilIdle();
    expect(target.session.view.get().kind).toBe("displaying");
    expect(leaseIds(f)).toEqual([]);
  });

  test("the seed's request fails on the network while the seed is alive: it retires its lease, and the target is accepted", async () => {
    const f = await newWorld();
    const seed = await signedInPage(f);
    const before = f.server.requests.filter((r) =>
      r.path.endsWith(CURRENT),
    ).length;
    const aged = age(f);
    f.server.addRule({
      match: (r) => r.path.endsWith("/probe"),
      dropBeforeForward: true,
    });
    const failed = ordinaryGet(seed.page, seed.account, seed.epoch);
    failed.catch(() => undefined);
    await f.world.runUntilIdle();
    await expect(failed).rejects.toThrow();
    expect(leaseIds(f)).toEqual([]);
    holdVerification(f);
    const target = await bootTarget(f);
    expect(target.session.view.get().kind).toBe("displaying");
    expect(
      judgeVerificationPremise(premiseOf(f, seed, target, aged, before))
        .problems,
    ).toEqual([]);
  });

  for (const count of [1, 3]) {
    test(`the seed is destroyed with ${count} request(s) outstanding: the target verifies exactly those leases BEFORE display (rejected), and their recovery lets it display`, async () => {
      const f = await newWorld();
      const seed = await signedInPage(f);
      const before = f.server.requests.filter((r) =>
        r.path.endsWith(CURRENT),
      ).length;
      const aged = age(f);
      holdProbe(f);
      for (let i = 0; i < count; i += 1)
        void ordinaryGet(seed.page, seed.account, seed.epoch).catch(
          () => undefined,
        );
      await f.world.runUntilIdle();
      const orphans = leaseIds(f).sort();
      expect(orphans).toHaveLength(count);
      // A navigation: the document goes, its locks with it, and its outstanding leases stay in the record.
      seed.page.destroy();
      releaseProbe(f);
      const verification = holdVerification(f);
      const target = await bootTarget(f);
      expect(target.session.view.get().kind).toBe("neutral");
      expect(target.surface.mounted).toBeNull();
      const trace = traceOf(f, target);
      const captured = trace.find(
        (e) =>
          e.event === "cover.committed" && e.data?.klass === "verification",
      );
      expect(
        [...((captured?.data?.unresolved as string[]) ?? [])].sort(),
      ).toEqual(orphans);
      for (const id of orphans)
        expect(stateOf(f).leases[id]?.boot_id).toBe(seed.page.session.bootId);
      const verdict = judgeVerificationPremise(
        premiseOf(f, seed, target, aged, before),
      );
      expect(verdict.problems).toEqual(
        expect.arrayContaining([
          `a verification captured unresolved leases ${JSON.stringify(captured?.data?.unresolved)}: it verifies abandoned requests, it is not the optional check`,
          "the target never exposed the identity (no act.begin/act.end)",
        ]),
      );
      expect(verdict.exposure).toBeNull();
      // Released: the strict same-session answer resolves the captured leases and the same session displays.
      expect(verification.release()).toBe(1);
      await f.world.runUntilIdle();
      expect(target.session.view.get().kind).toBe("displaying");
      expect(target.session.identity.get()?.session_id).toBe(seed.sessionId);
      for (const id of orphans) expect(stateOf(f).leases[id]).toBeUndefined();
      expect(stateOf(f).fences).toEqual({});
    });
  }
});
