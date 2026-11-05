// @vitest-environment node
import { describe, expect, test } from "vitest";
import type {
  QuotaGuard,
  QuotaReservation,
} from "../../src/data/engine/quota-guard";
import { createConditionalFormPort } from "../../src/data/ports/conditional-form";
import { fixtureData } from "../../src/fixture/data-env";
import type { RecoverySnapshot } from "../../src/lib/form-recovery/port";

/**
 * Review 10, finding 2 (`people-qualification-fixture-inventory`): the query-driven fixture's data env (`src/fixture/data-env.ts`, used by
 * the Sync screens' fixture pages) carries a quota stub that answers "ok", but it never binds a database: no service, no outbox, an empty
 * service store. So nothing can be admitted against it: the conditional form port (the held changes' port, built over `data.quota` as
 * `features/people/env.tsx` does) answers `failed` before any reservation is asked, and the outbox saves refuse (`useOutboxSave`'s
 * `not_ready`, covered by the people world's `noDatabase()` cases). A bound service's quota behaviour is the real port's, with its real
 * control (`conditional-form.test.ts`, "a put the quota guard refuses writes nothing"); no quota claim is made from this stub.
 */
const snap: RecoverySnapshot = {
  formContext: "people-held:p:f",
  tabInstanceId: "hold-1",
  values: { held: "a" },
  savedAt: "2026-10-24T09:00:00.000Z",
};

/** The fixture's own quota, counting what is asked of it. */
function counted(quota: QuotaGuard) {
  const asked = { check: 0, reserve: 0 };
  const guard: QuotaGuard = {
    check: (kind, bytes) => {
      asked.check += 1;
      return quota.check(kind, bytes);
    },
    reserve: (kind, bytes): Promise<QuotaReservation> => {
      asked.reserve += 1;
      return quota.reserve(kind, bytes);
    },
    lastFree: () => quota.lastFree(),
    invalidate: () => quota.invalidate(),
  };
  return { guard, asked };
}

describe("the query-driven fixture's data env", () => {
  test("binds no database: no service, no outbox, an empty service store", () => {
    const { env } = fixtureData(new URLSearchParams("drafts=3"));
    expect(env.service()).toBeNull();
    expect(env.outbox()).toBeNull();
    expect(env.serviceStore.get()).toBeNull();
  });

  test("its quota stub answers ok, but cannot supply a database", async () => {
    const { env } = fixtureData(new URLSearchParams());
    const quota = env.quota as QuotaGuard;
    expect(await quota.check("input", 10)).toBe("ok");
    const reservation = await quota.reserve("input", 10);
    expect(reservation.verdict).toBe("ok");
    reservation.settle("not_written");
    expect(quota.lastFree()).toBeNull();
    expect(env.service()).toBeNull();
  });

  test("the conditional form port over it writes nothing and asks no reservation (no service)", async () => {
    const { env } = fixtureData(new URLSearchParams());
    const { guard, asked } = counted(env.quota as QuotaGuard);
    const port = createConditionalFormPort({
      service: () => env.service(),
      quota: guard,
      now: () => snap.savedAt,
    });
    expect(await port.put(snap, null)).toEqual({ kind: "failed" });
    expect(asked).toEqual({ check: 0, reserve: 0 });
  });

  test("control: the same port over a service it can reach does ask the quota first", async () => {
    const { env } = fixtureData(new URLSearchParams());
    const { guard, asked } = counted(env.quota as QuotaGuard);
    const service = {
      incarnationId: "i",
      store: {
        run: async () => {
          throw new Error("a store that cannot write");
        },
      },
    };
    const port = createConditionalFormPort({
      service: () => service as never,
      quota: guard,
      now: () => snap.savedAt,
    });
    expect(await port.put(snap, null)).toEqual({ kind: "failed" });
    expect(asked.reserve).toBe(1);
  });
});
