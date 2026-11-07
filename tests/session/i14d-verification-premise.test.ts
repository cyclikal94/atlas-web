// @vitest-environment node
import { describe, expect, test } from "vitest";
import type { KernelEvent } from "../integration/first-observer";
import {
  type DocumentSample,
  judgeAbandonment,
  judgeReplacement,
} from "../integration/navigation-premise";
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

/**
 * WEB-14a revision 46 (review r45 F-R45-I14D, R34-N1): the INTENTIONAL-ABANDONMENT witnesses (tests/integration/navigation-premise.ts,
 * used by `abandonHarnessDocument`) over the real kernel, in both orders a navigation can meet a request and in the schedules its setup
 * must refuse. The browser control freezes the request's continuation so that destruction always comes first; here the world holds the
 * answer and the test chooses the order.
 */
const isProbe = (meta: EventMeta) =>
  typeof meta.path === "string" && meta.path.endsWith("/probe");

const sampleOf = (f: Fixture, page: FakePage): DocumentSample => {
  const state = stateOf(f);
  return {
    bridged: true,
    boot: page.session.bootId,
    document: page.id,
    settled: state.settled,
    leases: state.leases as DocumentSample["leases"],
    trace: traceOf(f, page),
  };
};

const identityOf = (seed: SignedIn) => ({
  account_id: seed.account,
  epoch: seed.epoch,
  session_id: seed.sessionId,
});

/** The seed with `count` probe requests issued and their answers held; returns the leases they hold, in creation order. */
async function seedWithHeldRequests(count: number) {
  const f = await newWorld();
  const seed = await signedInPage(f);
  age(f);
  holdProbe(f);
  for (let i = 0; i < count; i += 1)
    void ordinaryGet(seed.page, seed.account, seed.epoch).catch(
      () => undefined,
    );
  await f.world.runUntilIdle();
  const issued = traceOf(f, seed.page)
    .filter((e) => e.event === "request.issued")
    .map((e) => e.data?.lease as string);
  expect(issued).toHaveLength(count);
  expect(leaseIds(f).sort()).toEqual([...issued].sort());
  return { f, seed, issued };
}

describe("intentional abandonment over the real kernel (revision 46): before and after the navigation", () => {
  test("the frozen owner is destroyed first: accepted before, the new boot still holds the lease, and its recovery displays the session", async () => {
    const { f, seed, issued } = await seedWithHeldRequests(1);
    const witness = {
      lease: issued[0] as string,
      boot: seed.page.session.bootId,
      held: "probe",
    };
    const before = judgeAbandonment({
      expected: identityOf(seed),
      witness,
      document: seed.page.id,
      before: sampleOf(f, seed.page),
      held: f.world.heldCount("Da", isProbe),
    });
    expect(before).toEqual({
      problems: [],
      waiting: [],
      issued: expect.any(Number),
    });
    seed.page.destroy();
    releaseProbe(f);
    const verification = holdVerification(f);
    const target = await bootTarget(f);
    expect(
      judgeReplacement({
        expected: identityOf(seed),
        witness,
        document: seed.page.id,
        after: sampleOf(f, target),
      }),
    ).toEqual([]);
    // What the browser control then asserts: neutral, the exact lease captured, then recovered.
    expect(target.session.view.get().kind).toBe("neutral");
    const captured = traceOf(f, target).find(
      (e) => e.event === "cover.committed" && e.data?.klass === "verification",
    );
    expect(captured?.data?.unresolved).toEqual([witness.lease]);
    expect(verification.release()).toBe(1);
    await f.world.runUntilIdle();
    expect(target.session.view.get().kind).toBe("displaying");
    expect(stateOf(f).leases[witness.lease]).toBeUndefined();
    expect(stateOf(f).fences).toEqual({});
  });

  test("the live owner handles the answer before it is destroyed: accepted before, REJECTED after (the lease was retired: not an abandonment)", async () => {
    const { f, seed, issued } = await seedWithHeldRequests(1);
    const witness = {
      lease: issued[0] as string,
      boot: seed.page.session.bootId,
      held: "probe",
    };
    expect(
      judgeAbandonment({
        expected: identityOf(seed),
        witness,
        document: seed.page.id,
        before: sampleOf(f, seed.page),
        held: f.world.heldCount("Da", isProbe),
      }).problems,
    ).toEqual([]);
    // The other order: the answer reaches the live owner, which retires its lease, and only then is the document destroyed.
    expect(releaseProbe(f)).toBe(1);
    await f.world.runUntilIdle();
    expect(leaseIds(f)).toEqual([]);
    seed.page.destroy();
    holdVerification(f);
    const target = await bootTarget(f);
    expect(target.session.view.get().kind).toBe("displaying");
    expect(
      judgeReplacement({
        expected: identityOf(seed),
        witness,
        document: seed.page.id,
        after: sampleOf(f, target),
      }),
    ).toEqual([
      `after: the abandoned request's lease ${witness.lease} is not in the record (retired, or never written): this is not an abandonment`,
    ]);
  });

  test("the request fails on the network while its owner is alive: the lease is retired, and the abandonment is REJECTED before navigating", async () => {
    const f = await newWorld();
    const seed = await signedInPage(f);
    f.server.addRule({
      match: (r) => r.path.endsWith("/probe"),
      dropBeforeForward: true,
    });
    const failed = ordinaryGet(seed.page, seed.account, seed.epoch);
    failed.catch(() => undefined);
    await f.world.runUntilIdle();
    await expect(failed).rejects.toThrow();
    const [lease] = traceOf(f, seed.page)
      .filter((e) => e.event === "request.issued")
      .map((e) => e.data?.lease as string);
    expect(typeof lease).toBe("string");
    expect(
      judgeAbandonment({
        expected: identityOf(seed),
        witness: {
          lease: lease as string,
          boot: seed.page.session.bootId,
          held: "probe",
        },
        document: seed.page.id,
        before: sampleOf(f, seed.page),
        held: f.world.heldCount("Da", isProbe),
      }).problems,
    ).toEqual(
      expect.arrayContaining([
        `before: the abandoned request's lease ${lease} is not in the record (retired, or never written): this is not an abandonment`,
        "before: the owner's trace retired the abandoned lease",
        "before: the proxy holds no response for rule probe (the abandoned request's answer is not held)",
      ]),
    );
  });

  test("other requests are still outstanding: the witness waits for them; abandoned regardless, the next document verifies them all (why it must wait)", async () => {
    const { f, seed, issued } = await seedWithHeldRequests(3);
    const witness = {
      lease: issued[2] as string,
      boot: seed.page.session.bootId,
      held: "probe",
    };
    const before = judgeAbandonment({
      expected: identityOf(seed),
      witness,
      document: seed.page.id,
      before: sampleOf(f, seed.page),
      held: f.world.heldCount("Da", isProbe),
    });
    expect(before.problems).toEqual([]);
    expect(before.waiting).toHaveLength(2);
    seed.page.destroy();
    releaseProbe(f);
    holdVerification(f);
    const target = await bootTarget(f);
    const captured = traceOf(f, target).find(
      (e) => e.event === "cover.committed" && e.data?.klass === "verification",
    );
    expect(
      [...((captured?.data?.unresolved as string[]) ?? [])].sort(),
    ).toEqual([...issued].sort());
  });
});
