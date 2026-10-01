// @vitest-environment node
import { describe, expect, test } from "vitest";
import type { ConsentTicket } from "../../src/session";
import type { FakePage, Fixture } from "../support/session/harness";
import { checkProperties } from "../support/session/properties";
import { newWorld, signedInPage, stateOf } from "../support/session/scenarios";

/**
 * F-WIPE-*: the FULL canonical deletion procedure (WEB-04 7.8 steps 0 to 5; delivery-slices amendment 26), not the
 * abbreviated four-step version, against fake ports that record the order of every call.
 */
async function ready() {
  const f = await newWorld();
  const l = await signedInPage(f);
  f.data.databases.set(l.account, { incarnation: "inc-1" });
  f.data.work.set(l.account, { count: 2, digest: "d2" });
  return { f, l };
}
const opId = "11111111-1111-4111-8111-111111111111";
/** The ticket of the prompt the person is looking at, as the UI would pass it with their choice. */
function ticketOf(page: FakePage): ConsentTicket {
  const view = page.session.view.get();
  if (view.kind !== "neutral" || !view.consent)
    throw new Error(`no consent prompt is showing: ${JSON.stringify(view)}`);
  return view.consent.ticket;
}
const run = (
  f: Fixture,
  l: {
    page: {
      session: { wipe: { run(a: string, o: string): Promise<unknown> } };
    };
    account: string;
  },
  op = opId,
) =>
  f.runWith(
    l.page.session.wipe.run(l.account, op) as Promise<{ kind: string }>,
  );
const names = (f: Fixture, from = 0) =>
  f.world.logs
    .slice(from)
    .filter((e) => e.type === "lock.grant" || e.type === "lock.release_called")
    .map((e) => `${e.type === "lock.grant" ? "+" : "-"}${e.name}`);

describe("the call order of amendment 26", () => {
  test("record first, the held atlas-delete lock, step 0 consent status, step 1 existence probe (never open), steps 2-3 incarnation, 3a closure and digest, step 4 delete, step 5 ownership-checked clear then the atlas-auth completion", async () => {
    const { f, l } = await ready();
    const start = f.world.logs.length;
    const outcome = await run(f, l);
    expect(outcome.kind).toBe("deleted");
    // Ports, in order. The first pair is the "record first" probe that stamps the ledger entry's incarnation.
    expect(f.data.calls.filter((c) => !c.startsWith("setDraftFence"))).toEqual([
      `exists:${l.account}`,
      `incarnation:${l.account}`,
      `baselineDigest:${l.account}`, // step 0: comparing against the baseline for status `pending`
      `exists:${l.account}`, // step 1: indexedDB.databases(), NEVER open()
      `incarnation:${l.account}`, // steps 2-3: an EXISTING database, read then closed
      `broadcastImminent:${l.account}`, // step 3a
      `setClosing:${l.account}`,
      `waitForClosure:${l.account}`,
      `liveDigest:${l.account}`,
      `close:${l.account}`, // step 4
      `delete:${l.account}`,
    ]);
    // The wipe lock is held across steps 0-5; atlas-auth is requested only AFTER the ledger clear and never while waiting.
    const locks = names(f, start);
    const del = locks.indexOf(`+atlas-delete:${l.account}`);
    const auth = locks.indexOf("+atlas-auth");
    const unlock = locks.indexOf(`-atlas-delete:${l.account}`);
    expect(del).toBeGreaterThanOrEqual(0);
    expect(auth).toBeGreaterThan(del);
    expect(unlock).toBeGreaterThan(auth);
    expect(
      await f.runWith(
        f.pages[0]?.session.wipe.run(l.account, opId) as Promise<{
          kind: string;
        }>,
      ),
    ).toMatchObject({ kind: "absent" }); // re-entry is idempotent
    expect(f.data.databases.has(l.account)).toBe(false);
    const ledger = stateOf(f);
    void ledger;
    expect(f.store.records.pending_deletions[l.account]).toBeUndefined();
    expect(checkProperties(f)).toEqual([]);
  });

  test("an absent database is `absent`: the entry is cleared and nothing is opened", async () => {
    const { f, l } = await ready();
    f.data.databases.delete(l.account);
    expect(await run(f, l)).toMatchObject({ kind: "absent" });
    expect(
      f.data.calls.some(
        (c) => c.startsWith("close:") || c.startsWith("delete:"),
      ),
    ).toBe(false);
    expect(f.store.records.pending_deletions[l.account]).toBeUndefined();
  });

  test("an incarnation that changed (a legitimate new session created the database) is NOT deleted", async () => {
    const { f, l } = await ready();
    // The entry stamps `inc-1`; a later sign-in recreated the database with another incarnation before the wipe ran.
    const creating = f.pages[0]?.session.wipe.run(l.account, opId);
    void creating;
    await f.world.runUntilIdle();
    f.data.databases.set(l.account, { incarnation: "inc-2" });
    // Re-enter through a fresh entry stamped with the OLD incarnation.
    f.store.records.pending_deletions[l.account] = {
      operation_id: "op-b",
      account_id: l.account,
      incarnation_id: "inc-1",
      status: "pending",
      digest: null,
      approved_digest: null,
      count: null,
      created_at: "x",
    };
    expect(await run(f, l, "op-b")).toMatchObject({
      kind: "superseded_incarnation",
    });
    expect(f.data.databases.has(l.account)).toBe(true);
    expect(f.store.records.pending_deletions[l.account]).toBeUndefined();
  });
});

describe("step 4: delete errors and blocked", () => {
  test("a delete error is retry_later and the entry is NOT cleared; a later pass completes", async () => {
    const { f, l } = await ready();
    f.data.deleteResult = "error";
    expect(await run(f, l)).toMatchObject({
      kind: "retry_later",
      reason: "delete_error",
    });
    expect(f.store.records.pending_deletions[l.account]).toBeDefined();
    expect(f.data.databases.has(l.account)).toBe(true);
    f.data.deleteResult = "deleted";
    expect(await run(f, l)).toMatchObject({ kind: "deleted" });
    expect(f.store.records.pending_deletions[l.account]).toBeUndefined();
  });

  test("`blocked` is never reported as success: the port resolves only after onsuccess", async () => {
    const { f, l } = await ready();
    f.data.deleteResult = "blocked_then_deleted";
    expect(await run(f, l)).toMatchObject({ kind: "deleted" });
    expect(f.data.calls.filter((c) => c.startsWith("delete:"))).toHaveLength(1);
  });

  test("indexedDB.databases() unavailable: `adapter_missing`; it NEVER wipes and never claims there is no work when a database exists (D-14, EC-43)", async () => {
    const { f, l } = await ready();
    f.data.existsThrows = true;
    expect(await run(f, l)).toMatchObject({
      kind: "retry_later",
      reason: "adapter_missing",
    });
    expect(f.data.databases.has(l.account)).toBe(true);
    expect(
      f.data.calls.some(
        (c) => c.startsWith("open:") || c.startsWith("delete:"),
      ),
    ).toBe(false);
  });
});

describe("step 3a: the consent digest, and the two answers", () => {
  async function mismatched() {
    const { f, l } = await ready();
    // Changes were saved after the person confirmed: the live digest no longer matches the baseline.
    f.data.baselineDigests.set(l.account, "d2");
    f.data.liveDigests.set(l.account, "d3");
    f.data.work.set(l.account, { count: 3, digest: "d3" });
    return { f, l };
  }
  test("a mismatch writes awaiting_consent with the live digest and STOPS: nothing is deleted", async () => {
    const { f, l } = await mismatched();
    expect(await run(f, l)).toMatchObject({
      kind: "awaiting_consent",
      count: 3,
    });
    expect(f.store.records.pending_deletions[l.account]).toMatchObject({
      status: "awaiting_consent",
      digest: "d3",
      approved_digest: null,
    });
    expect(f.data.databases.has(l.account)).toBe(true);
    expect(f.data.calls.some((c) => c.startsWith("delete:"))).toBe(false);
    expect(l.page.session.view.get()).toMatchObject({
      kind: "neutral",
      state: "wipe.consent",
      consent: { count: 3 },
    });
  });

  test("step 0 with awaiting_consent shows the prompt from the entry's OWN digest and stops (does not fall through)", async () => {
    const { f, l } = await mismatched();
    await run(f, l);
    const calls = f.data.calls.length;
    expect(await run(f, l)).toMatchObject({ kind: "awaiting_consent" });
    expect(
      f.data.calls
        .slice(calls)
        .some((c) => c.startsWith("delete:") || c.startsWith("liveDigest:")),
    ).toBe(false);
  });

  test("'Delete them' -> deletion_approved (never back to pending) and completes on the next pass without re-prompting", async () => {
    const { f, l } = await mismatched();
    await run(f, l);
    expect(
      await f.runWith(
        l.page.session.wipe.resolveConsent(ticketOf(l.page), "delete"),
      ),
    ).toMatchObject({ kind: "deleted" });
    expect(f.data.databases.has(l.account)).toBe(false);
    expect(f.store.records.pending_deletions[l.account]).toBeUndefined();
  });

  test("'Keep for now' is THREE ordered writes; a crash after each is recovered by answering again (through the real logout flow)", async () => {
    for (const crashAfter of [1, 2] as const) {
      const f = await newWorld();
      const l = await signedInPage(f);
      f.data.databases.set(l.account, { incarnation: "inc-1" });
      f.data.work.set(l.account, { count: 2, digest: "d2" });
      f.data.liveDigests.set(l.account, "d3"); // changes were saved after the person confirmed
      expect(
        (
          await f.runWith(
            l.page.session.operations.logout({
              unsynced: { count: 2, items: [], digest: "d2" },
            }),
          )
        ).kind,
      ).toBe("started");
      await f.settle();
      // The confirmed logout reached the wipe, which stopped at the consent prompt with the account still fenced.
      expect(f.store.records.pending_deletions[l.account]?.status).toBe(
        "awaiting_consent",
      );
      expect(l.page.session.view.get()).toMatchObject({
        kind: "neutral",
        state: "wipe.consent",
        consent: { count: 2 },
      });
      const ports = l.page.kernel.ports.deletion;
      if (crashAfter === 2) {
        const real = ports.coordination.releaseFence.bind(ports.coordination);
        ports.coordination.releaseFence = async (a, o) => {
          await real(a, o);
          throw new Error("crash after write (2)");
        };
      } else {
        const real = ports.coordination.releaseFence.bind(ports.coordination);
        ports.coordination.releaseFence = async () => {
          void real;
          throw new Error("crash after write (1)");
        };
      }
      const first = await f.runWith(
        l.page.session.wipe.resolveConsent(ticketOf(l.page), "keep").then(
          () => "ok",
          () => "crashed",
        ),
      );
      expect(first).toBe("crashed");
      // Write (1) is done: the envelope is gone and settled was cleared (3.5.4); nothing was deleted; the entry remains.
      expect(stateOf(f).settled).toBeNull();
      expect(stateOf(f).fences[l.account]).toBeUndefined();
      expect(f.data.databases.has(l.account)).toBe(true);
      expect(f.store.records.pending_deletions[l.account]?.status).toBe(
        "awaiting_consent",
      );
      // Reload: the durable entry re-shows the identical prompt, and answering again completes normally.
      l.page.destroy();
      const fresh = f.addPage();
      await f.boot(fresh);
      expect(fresh.session.view.get()).toMatchObject({
        kind: "neutral",
        state: "wipe.consent",
        consent: { count: 2 },
      });
      expect(
        await f.runWith(
          fresh.session.wipe.resolveConsent(ticketOf(fresh), "keep"),
        ),
      ).toMatchObject({ kind: "absent" });
      expect(f.store.records.pending_deletions[l.account]).toBeUndefined();
      expect(f.data.databases.has(l.account)).toBe(true); // kept
      expect(fresh.session.view.get()).toMatchObject({ kind: "signed_out" });
    }
  });

  test("'Delete them' through the real logout flow completes the wipe and signs out", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    f.data.databases.set(l.account, { incarnation: "inc-1" });
    f.data.work.set(l.account, { count: 2, digest: "d2" });
    f.data.liveDigests.set(l.account, "d3");
    await f.runWith(
      l.page.session.operations.logout({
        unsynced: { count: 2, items: [], digest: "d2" },
      }),
    );
    await f.settle();
    l.page.session.actions.consent("delete", ticketOf(l.page));
    await f.world.runUntilIdle();
    expect(f.data.databases.has(l.account)).toBe(false);
    expect(stateOf(f).settled).toBeNull();
    expect(f.store.records.pending_deletions[l.account]).toBeUndefined();
    expect(l.page.session.view.get()).toMatchObject({ kind: "signed_out" });
  });
});

describe("ownership and recovery", () => {
  test("a different operation_id never clears another's entry", async () => {
    const { f, l } = await ready();
    f.store.records.pending_deletions[l.account] = {
      operation_id: "op-a",
      account_id: l.account,
      incarnation_id: "inc-1",
      status: "pending",
      digest: null,
      approved_digest: null,
      count: null,
      created_at: "x",
    };
    const ports = l.page.kernel.ports.deletion;
    expect(await f.runWith(ports.ledger.clear(l.account, "op-other"))).toBe(
      false,
    );
    expect(
      await f.runWith(
        ports.ledger.setStatus(l.account, "op-other", {
          status: "awaiting_consent",
        }),
      ),
    ).toBe(false);
    expect(f.store.records.pending_deletions[l.account]?.operation_id).toBe(
      "op-a",
    );
  });

  test("a crash at each step is recovered by any page at boot; the completion applies exactly once", async () => {
    for (const crash of ["exists", "delete", "clear"] as const) {
      const { f, l } = await ready();
      const ports = l.page.kernel.ports.deletion;
      let crashed = false;
      if (crash === "delete") {
        const real = ports.database.delete.bind(ports.database);
        ports.database.delete = async (a) => {
          if (!crashed) {
            crashed = true;
            await real(a); // the database is gone, but the page dies before the ledger is cleared
            throw new Error("crash");
          }
          return real(a);
        };
      } else if (crash === "clear") {
        const real = ports.ledger.clear.bind(ports.ledger);
        ports.ledger.clear = async (a, o) => {
          if (!crashed) {
            crashed = true;
            throw new Error("crash");
          }
          return real(a, o);
        };
      } else {
        const real = ports.database.exists.bind(ports.database);
        ports.database.exists = async (a) => {
          if (
            !crashed &&
            f.data.calls.filter((c) => c.startsWith("exists")).length >= 2
          ) {
            crashed = true;
            throw new Error("crash");
          }
          return real(a);
        };
      }
      await run(f, l).catch(() => undefined);
      l.page.destroy();
      const fresh = f.addPage();
      await f.boot(fresh); // boot -> wipe.recoverPending
      await f.world.runUntilIdle();
      expect(f.data.databases.has(l.account)).toBe(false);
      expect(f.store.records.pending_deletions[l.account]).toBeUndefined();
    }
  });

  test("a fresh sign-in for an account whose deletion is outstanding runs the procedure FIRST", async () => {
    const { f, l } = await ready();
    f.data.deleteResult = "error";
    await run(f, l); // leaves the entry outstanding
    f.data.deleteResult = "deleted";
    const outcome = await f.signIn(l.page, "kieran", "pw");
    expect(outcome).toMatchObject({ kind: "settled" });
    expect(f.data.databases.has(l.account)).toBe(false); // the old database was deleted before the new session settled
    expect(f.store.records.pending_deletions[l.account]).toBeUndefined();
  });

  test("a fresh sign-in is not allowed to proceed while the outstanding deletion cannot finish", async () => {
    const { f, l } = await ready();
    f.data.deleteResult = "error";
    await run(f, l);
    expect(await f.signIn(l.page, "kieran", "pw")).toEqual({
      kind: "not_started",
      reason: "wipe_pending",
    });
  });
});
