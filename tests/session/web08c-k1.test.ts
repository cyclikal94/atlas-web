// @vitest-environment node
import { describe, expect, test } from "vitest";
import { recordObservation } from "../../src/session/model/reducers/observation";
import { checkProperties } from "../support/session/properties";
import {
  apply,
  invalid,
  NOW,
  records,
  unverified,
} from "../support/session/records";
import {
  fencesOf,
  newWorld,
  ordinaryGet,
  signedInPage,
} from "../support/session/scenarios";

/**
 * WEB-08c K-1 (found by the T21 trace, `web08c-traces.test.ts`): a `credential_mismatch` whose O11 verification reads ANOTHER account
 * (`200 X`) or `401` must REPLACE the `credential_unverified` entry by `drift` / `invalid_session` (matrix T21 t4b/t4c). Before the fix the
 * entry stayed beside the stronger fence, so every evaluation restarted the verification, which read the same answer again with no
 * back-off: an unbounded stream of `GET /browser-sessions/current` (thousands at one instant in the fake world) that also starved the
 * "Sign in again" attempt of the 1d card. Reducer cases and the fake world end to end.
 */
const settled = (extra = {}) =>
  records({
    settled: { account_id: "A", epoch: 3, session_id: "s3" },
    leases: { l9: { account_id: "A", epoch: 3 } },
    ...extra,
  });
const kinds = (recs: ReturnType<typeof records>) =>
  (recs.auth_state.fences.A ?? []).map((f) => `${f.kind}:${f.seq}`);
const verifierAnswer = (
  kind: "different_account" | "current_401",
  over = {},
) => ({
  lease_id: "l9",
  account_id: "A",
  stamp_epoch: 3,
  kind,
  obs_id: "o9",
  now: NOW,
  ...over,
});

describe("K-1, the reducer: an identity read's answer replaces the entries it covered", () => {
  test.each(["different_account", "current_401"] as const)(
    "%s: entries with seq <= replaces_unverified are replaced by the stronger fence; a later entry (seq above) stays",
    (kind) => {
      const start = settled({
        fences: { A: [unverified(1, 3), unverified(4, 3)] },
        fence_seq: 4,
      });
      const { records: next } = apply(start, (r) =>
        recordObservation(r, verifierAnswer(kind, { replaces_unverified: 2 })),
      );
      const strong = kind === "different_account" ? "drift" : "invalid_session";
      expect(
        kinds(next)
          .map((k) => k.split(":")[0])
          .sort(),
      ).toEqual(["credential_unverified", strong].sort());
      expect(kinds(next)).toContain("credential_unverified:4");
      expect(kinds(next)).not.toContain("credential_unverified:1");
    },
  );

  test("without replaces_unverified (an ordinary request's 401, a page recording from a hint) nothing is replaced", () => {
    const start = settled({ fences: { A: [unverified(1, 3)] }, fence_seq: 1 });
    const { records: next } = apply(start, (r) =>
      recordObservation(r, verifierAnswer("current_401")),
    );
    expect(
      kinds(next)
        .map((k) => k.split(":")[0])
        .sort(),
    ).toEqual(["credential_unverified", "invalid_session"]);
  });

  test("the observation already recorded by another page (from its hint): the replacement still applies", () => {
    const start = settled({
      fences: {
        A: [
          unverified(1, 3),
          { ...invalid(2, 3), obs_id: "o9", kind: "invalid_session" } as never,
        ],
      },
      fence_seq: 2,
    });
    const { records: next, result } = apply(start, (r) =>
      recordObservation(
        r,
        verifierAnswer("current_401", { replaces_unverified: 1 }),
      ),
    );
    expect(result).toBe("DONE");
    expect(kinds(next).map((k) => k.split(":")[0])).toEqual([
      "invalid_session",
    ]);
  });

  test("a gating attempt defers the observation (no stronger fence): the entry is NOT removed, so the account never loses its cover", () => {
    const start = settled({
      fences: { A: [unverified(1, 3)] },
      fence_seq: 1,
      attempt: { epoch: 4, phase: "activating" },
    });
    const { records: next } = apply(start, (r) =>
      recordObservation(
        r,
        verifierAnswer("different_account", { replaces_unverified: 1 }),
      ),
    );
    expect(kinds(next)).toEqual(["credential_unverified:1"]);
  });

  test("a stale stamp records nothing and replaces nothing", () => {
    const start = settled({ fences: { A: [unverified(1, 3)] }, fence_seq: 1 });
    const { records: next, result } = apply(start, (r) =>
      recordObservation(
        r,
        verifierAnswer("different_account", {
          stamp_epoch: 2,
          replaces_unverified: 1,
        }),
      ),
    );
    expect(result).toBe("STALE");
    expect(kinds(next)).toEqual(["credential_unverified:1"]);
  });
});

describe("K-1, end to end (fake world): no unbounded re-verification", () => {
  const currentReads = (f: Awaited<ReturnType<typeof newWorld>>) =>
    f.server.requests.filter((r) =>
      r.path.endsWith("/browser-sessions/current"),
    ).length;

  test.each(["drift", "invalid"] as const)(
    "T21 t4%s: one verification, the fence replaced, the reads stop; then 'Sign in again' settles and recovery shows the account",
    async (branch) => {
      const f = await newWorld();
      const y = await signedInPage(f, "sam", "pw2");
      const kieran = [...f.server.accounts.values()].find(
        (a) => a.username === "kieran",
      );
      if (!kieran) throw new Error("no kieran");
      const x = f.server.createSession(kieran.id, "dev-x");
      f.server.adoptCookie(x);
      if (branch === "invalid") f.server.revoke(x.id);
      const before = currentReads(f);
      await f
        .runWith(ordinaryGet(y.page, y.account, y.epoch))
        .catch(() => undefined);
      await f.settle();
      await f.world.advance(120_000);
      await f.settle();
      expect(fencesOf(f, y.account)).toEqual(
        branch === "drift" ? ["drift"] : ["invalid_session"],
      );
      // One verification read the answer (a page may also make its own CSRF read): never a stream of them.
      expect(currentReads(f) - before).toBeLessThanOrEqual(3);
      const ySession = f.server.sessions.get(y.sessionId);
      if (ySession && branch === "invalid") f.server.adoptCookie(ySession);
      const again = await f.signIn(y.page, "sam", "pw2");
      expect(again).toMatchObject({ kind: "settled", account_id: y.account });
      await f.settle();
      expect(y.page.session.view.get()).toMatchObject({
        kind: "neutral",
        state: "2",
      });
      const begun = await f.runWith(y.page.session.recovery.begin(y.account));
      expect(begun.kind).toBe("eligible");
      if (begun.kind === "eligible")
        expect(
          await f.runWith(y.page.session.recovery.finish(begun.handle)),
        ).toBe("cleared");
      await f.settle();
      expect(y.page.session.view.get()).toMatchObject({
        kind: "displaying",
        account_id: y.account,
      });
      expect(checkProperties(f)).toEqual([]);
    },
  );
});
