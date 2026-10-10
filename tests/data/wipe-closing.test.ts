// @vitest-environment node
import { describe, expect, test } from "vitest";
import { saveFormRecovery } from "../../src/data/plans/form-recovery";
import { createRegistry } from "../../src/data/store/registry";
import { RealData } from "../support/data/real-ports";
import { recoveryRow } from "../support/data/rows";
import type { Fixture } from "../support/session/harness";
import { newWorld, signedInPage } from "../support/session/scenarios";

/**
 * R12 (revision 8), through the ADAPTER BOUNDARY: the real session wipe, the production deletion and coordination ports, and the
 * production recovery writer (`saveFormRecovery`) over the double of IndexedDB. The review's schedule: the person confirms three
 * drafts, `data.setClosing` fails, and another page context, whose broadcast has not been delivered, commits a recovery copy.
 *
 * Before: the failed write was swallowed, the wipe read the live digest, deleted, and the writer (which consults the durable flag, never
 * set) had been answered `saved`. Now the flag is a PRECONDITION: a transient failure is asked again (the flag is then set before the
 * digest is read, so the late writer is refused); a failure that persists leaves the entry, the fence and the work, and the retry
 * recomputes the population, so work that arrived in the meantime is asked about instead of deleted.
 *
 * FIXTURE evidence: a named injected transaction fault over the double. It is not a native storage fault and not a real logout.
 */
const FAULTS = ["abort", "error", "quota"] as const;

async function build() {
  const real = new RealData();
  const f = await newWorld({ dataPorts: (page) => real.dataPorts(page) });
  real.attach(f.world);
  const signed = await signedInPage(f);
  const account = signed.account;
  await real.createAccountDb(account, "inc-original");
  real.addDrafts(account, 3);
  await f.settle();
  const seen = await f.runWith(
    signed.page.session.operations.summariseLocalWork(),
  );
  expect(seen?.count).toBe(3);
  return { real, f, signed, account, seen: seen as NonNullable<typeof seen> };
}
type Built = Awaited<ReturnType<typeof build>>;

/** Another page context: it never heard the broadcast, so only the durable flag can stop it. */
async function lateWrite(real: RealData, account: string, text: string) {
  const opened = await real.idb
    .openerForPage("late-page", createRegistry("late-page"))
    .open(account, { create: false, single: true, incarnation: "unused" });
  if (opened.kind !== "opened") throw new Error("missing database");
  try {
    return await opened.store.run(saveFormRecovery, {
      incarnationId: opened.store.incarnationId,
      row: recoveryRow({ fields: { name: text } }),
    });
  } finally {
    opened.store.close();
  }
}

/** Drives the world and its clock (the closing retries sleep on the kernel's back-off). */
async function drive<T>(f: Fixture, promise: Promise<T>): Promise<T> {
  let done = false;
  let value: T | undefined;
  let error: unknown;
  promise.then(
    (v) => {
      done = true;
      value = v;
    },
    (e) => {
      done = true;
      error = e;
    },
  );
  for (let i = 0; i < 400 && !done; i += 1) {
    await f.world.runUntilIdle();
    await f.world.settle();
    if (!done) await f.world.advance(1_000);
  }
  if (!done) throw new Error("promise did not settle while the clock ran");
  if (error) throw error;
  return value as T;
}
const entryOf = (b: Built) =>
  b.f.store.records.pending_deletions[b.account] as {
    operation_id: string;
    status: string;
  };

/** Starts the logout and lets it run to its end (every closing attempt, with the back-off between them). */
async function logout(b: Built) {
  const started = await drive(
    b.f,
    b.signed.page.session.operations.logout({ unsynced: b.seen }),
  );
  expect(started.kind).toBe("started");
  await b.f.world.advance(30_000);
  await b.f.settle();
}

describe("a transient closing failure: asked again, so the flag is durable before the digest is read", () => {
  for (const fault of FAULTS)
    test(`${fault}: the review's schedule (a late writer after the digest read) is REFUSED, and the confirmed work is deleted`, async () => {
      const b = await build();
      const { real, account } = b;
      real.idb.inject({
        match: (tx) => tx.label === "data.setClosing",
        mode: fault,
        times: 1,
      });
      // The late writer acts straight after the production digest read, as in the review.
      let late: unknown;
      let flagAtDigest: boolean | undefined;
      const ports = b.signed.page.kernel.ports.deletion.coordination;
      const digest = ports.liveDigest.bind(ports);
      ports.liveDigest = async (a) => {
        const read = await digest(a);
        flagAtDigest = real.sync(a)?.draft_fence?.closing;
        late = await lateWrite(real, a, "new unsaved work");
        return read;
      };
      await logout(b);
      expect(flagAtDigest).toBe(true);
      expect(late).toEqual({ kind: "refused" });
      expect(real.deletes()).toEqual([`delete:${account}`]);
      expect(real.hasDb(account)).toBe(false);
      expect(real.callsOf("setClosing", account)).toHaveLength(2);
    });

  test("the control: no fault, the flag is set at the first ask and the late writer is refused", async () => {
    const b = await build();
    let late: unknown;
    const ports = b.signed.page.kernel.ports.deletion.coordination;
    const digest = ports.liveDigest.bind(ports);
    ports.liveDigest = async (a) => {
      const read = await digest(a);
      late = await lateWrite(b.real, a, "new unsaved work");
      return read;
    };
    await logout(b);
    expect(late).toEqual({ kind: "refused" });
    expect(b.real.callsOf("setClosing", b.account)).toHaveLength(1);
    expect(b.real.hasDb(b.account)).toBe(false);
  });
});

describe("a closing failure that persists: nothing is deleted, and the retry asks about whatever arrived", () => {
  for (const fault of FAULTS) {
    test(`${fault}: no digest, no close, no delete; the entry, the fence and the three drafts stay`, async () => {
      const b = await build();
      const { real, account } = b;
      real.idb.inject({
        match: (tx) => tx.label === "data.setClosing",
        mode: fault,
        times: 50,
      });
      await logout(b);
      expect(real.callsOf("setClosing", account).length).toBeGreaterThan(1);
      expect(real.callsOf("liveDigest", account)).toEqual([]);
      expect(real.callsOf("close", account)).toEqual([]);
      expect(real.deletes()).toEqual([]);
      expect(real.hasDb(account)).toBe(true);
      expect(real.drafts(account)).toBe(3);
      expect(real.sync(account)?.draft_fence?.closing).not.toBe(true);
      expect(real.fenceOf(account)?.operation_ids).toHaveLength(1);
      expect(entryOf(b).status).toBe("pending");
    });

    test(`${fault}: a writer that gets in after the failures is accepted (the pre-closing exemption) and then COUNTED, not deleted`, async () => {
      const b = await build();
      const { real, f, account } = b;
      real.idb.inject({
        match: (tx) => tx.label === "data.setClosing",
        mode: fault,
        times: 50,
      });
      await logout(b);
      // The flag has not been set, so the recovery writer is (correctly) not refused: its copy is work the person did not confirm.
      expect(
        await drive(f, lateWrite(real, account, "new unsaved work")),
      ).toEqual({ kind: "saved" });
      // The fault goes; the next entry repeats step 3a and recomputes the population.
      real.idb.clearInjections();
      const outcome = await drive(
        f,
        b.signed.page.session.wipe.run(account, entryOf(b).operation_id),
      );
      expect(outcome).toMatchObject({ kind: "awaiting_consent" });
      expect(real.hasDb(account)).toBe(true);
      expect(real.deletes()).toEqual([]);
      expect(real.sync(account)?.draft_fence?.closing).toBe(true);
      expect(entryOf(b).status).toBe("awaiting_consent");
      // And now that the flag IS durable, another writer is refused.
      expect(await drive(f, lateWrite(real, account, "even later"))).toEqual({
        kind: "refused",
      });
    });

    test(`${fault}: with nothing new, the retry (the fault gone) completes the very same deletion`, async () => {
      const b = await build();
      const { real, f, account } = b;
      real.idb.inject({
        match: (tx) => tx.label === "data.setClosing",
        mode: fault,
        times: 50,
      });
      await logout(b);
      expect(real.deletes()).toEqual([]);
      real.idb.clearInjections();
      const outcome = await drive(
        f,
        b.signed.page.session.wipe.run(account, entryOf(b).operation_id),
      );
      expect(outcome).toMatchObject({ kind: "deleted" });
      expect(real.hasDb(account)).toBe(false);
      expect(real.deletes()).toEqual([`delete:${account}`]);
    });
  }
});

/**
 * R12 (revision 11), at the consumer boundary: the EXISTING database cannot be OPENED when the closing flag is asked for. The review
 * reproduced, in three real engines, an aborted open REQUEST that the Dexie opener turned into `absent`: the ports then read the account as
 * having no work, `setClosing` answered `closing` with no flag written, and `wipe_imminent` could be announced. The opener is fixed (E-C14
 * proves it in a real engine); this pins what the session does with the failure it now receives, with the real session, the production
 * ports and the production writer over the double: the open is a failure, the closing is `unconfirmed`, no digest is read, nothing is
 * closed or deleted, the work, the fence and the entry stay, and once the database opens the same deletion completes.
 *
 * FIXTURE evidence: a named failure of the opener over the double, not a native storage fault.
 */
describe("R12 (revision 11): a database that cannot be opened is not a database that is not there", () => {
  test("persistently: no flag, no digest, no close, no delete; the entry, the fence and the three drafts stay", async () => {
    const b = await build();
    const { real, account } = b;
    let failing = false;
    // Fails from the moment the wipe announces the closure (step 3a): the logout is accepted and recounted while the database opens,
    // then every open fails, which is where the review's aborted open request met `setClosing`.
    real.onBroadcastImminent = () => {
      failing = true;
    };
    real.idb.beforeOpen = () => {
      if (failing) throw new Error("the open request was aborted");
    };
    await logout(b);
    expect(real.callsOf("setClosing", account).length).toBeGreaterThan(1);
    expect(real.callsOf("liveDigest", account)).toEqual([]);
    expect(real.callsOf("close", account)).toEqual([]);
    expect(real.deletes()).toEqual([]);
    failing = false;
    expect(real.hasDb(account)).toBe(true);
    expect(real.drafts(account)).toBe(3);
    expect(real.sync(account)?.draft_fence?.closing).not.toBe(true);
    expect(real.fenceOf(account)?.operation_ids).toHaveLength(1);
    expect(entryOf(b).status).toBe("pending");
  });

  test("a writer that gets in while the open fails is not refused by a flag that was never written, and is COUNTED when the open works again", async () => {
    const b = await build();
    const { real, f, account } = b;
    let failing = false;
    real.onBroadcastImminent = () => {
      failing = true;
    };
    real.idb.beforeOpen = () => {
      if (failing) throw new Error("aborted");
    };
    await logout(b);
    failing = false;
    expect(
      await drive(f, lateWrite(real, account, "new unsaved work")),
    ).toEqual({ kind: "saved" });
    const outcome = await drive(
      f,
      b.signed.page.session.wipe.run(account, entryOf(b).operation_id),
    );
    expect(outcome).toMatchObject({ kind: "awaiting_consent" });
    expect(real.hasDb(account)).toBe(true);
    expect(real.deletes()).toEqual([]);
    expect(real.sync(account)?.draft_fence?.closing).toBe(true);
  });

  test("with nothing new, the retry (the open works again) completes the very same deletion", async () => {
    const b = await build();
    const { real, f, account } = b;
    let failing = false;
    real.onBroadcastImminent = () => {
      failing = true;
    };
    real.idb.beforeOpen = () => {
      if (failing) throw new Error("aborted");
    };
    await logout(b);
    expect(real.deletes()).toEqual([]);
    failing = false;
    const outcome = await drive(
      f,
      b.signed.page.session.wipe.run(account, entryOf(b).operation_id),
    );
    expect(outcome).toMatchObject({ kind: "deleted" });
    expect(real.hasDb(account)).toBe(false);
    expect(real.deletes()).toEqual([`delete:${account}`]);
  });
});
