// @vitest-environment node
import { describe, expect, test } from "vitest";
import { DEFAULT_CONFIG } from "../../src/session/constants";
import type { Fixture } from "../support/session/harness";
import { checkProperties } from "../support/session/properties";
import { newWorld, signedInPage } from "../support/session/scenarios";

/**
 * R12 (revision 8): a deletion may not go on without the DURABLE closing flag.
 *
 * `setClosing` used to swallow a failed transaction and resolve, so the wipe read the live digest and deleted although
 * `draft_fence.closing` was still false. A recovery writer in a tab that had not heard the broadcast (delayed or absent) could then
 * commit a copy between the digest read and the deletion, and the writer, which correctly consults the durable flag, found none. The
 * port now answers `closing` or `unconfirmed`; the kernel asks up to `closingWriteAttempts` times, treats ANY other answer (a
 * rejection, `undefined`) as `unconfirmed`, and without the flag reads no digest, closes nothing and deletes nothing: the entry, the
 * fence and the work stay, and the next entry repeats step 3a and recomputes the consent population.
 *
 * These run the real session kernel over the fake ports; the adapter boundary (the real `setClosing` over the double of IndexedDB,
 * with the real writer) is `tests/data/wipe-closing.test.ts` and `tests/data/wipe-coordination.test.ts`. FIXTURE evidence.
 */
const opId = "11111111-1111-4111-8111-111111111111";

async function ready() {
  const f = await newWorld();
  const l = await signedInPage(f);
  f.data.databases.set(l.account, { incarnation: "inc-1" });
  f.data.work.set(l.account, { count: 2, digest: "d2" });
  return { f, l };
}
/**
 * Drives the world AND its clock until the promise settles: the closing retries sleep on the kernel's back-off, which the harness's
 * `runWith` (it only runs what is due now) does not reach.
 */
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
const run = (f: Fixture, l: Awaited<ReturnType<typeof ready>>["l"]) =>
  drive(
    f,
    l.page.session.wipe.run(l.account, opId) as Promise<{
      kind: string;
      reason?: string;
      count?: number;
    }>,
  );
const calls = (f: Fixture, prefix: string) =>
  f.data.calls.filter((c) => c.startsWith(prefix));
const ATTEMPTS = DEFAULT_CONFIG.closingWriteAttempts;

describe("a closing write that fails once is asked again, and the deletion waits for it", () => {
  test("one transient failure: asked again at once, and the wipe completes with the flag set BEFORE the digest is read", async () => {
    const { f, l } = await ready();
    f.data.closingFailures = 1;
    expect(await run(f, l)).toMatchObject({ kind: "deleted" });
    const order = f.data.calls.filter(
      (c) =>
        c.startsWith("setClosing:") ||
        c.startsWith("liveDigest:") ||
        c.startsWith("delete:"),
    );
    expect(order).toEqual([
      `setClosing:${l.account}`,
      `setClosing:${l.account}`,
      `liveDigest:${l.account}`,
      `delete:${l.account}`,
    ]);
    expect(f.data.closing.has(l.account)).toBe(true);
    expect(checkProperties(f)).toEqual([]);
  });

  test("a writer that gets in after the FAILED attempt is counted: the retry sets the flag, the digest is recomputed, and the person is asked again", async () => {
    const { f, l } = await ready();
    f.data.closingFailures = 1;
    // A page whose broadcast was delayed commits a recovery copy while the flag is still false.
    f.data.afterSetClosing = () => {
      expect(f.data.closing.has(l.account)).toBe(false);
      f.data.work.set(l.account, { count: 3, digest: "d3" });
      f.data.liveDigests.set(l.account, "d3");
    };
    expect(await run(f, l)).toMatchObject({
      kind: "awaiting_consent",
      count: 3,
    });
    expect(f.data.databases.has(l.account)).toBe(true);
    expect(calls(f, "delete:")).toEqual([]);
    expect(f.store.records.pending_deletions[l.account]).toMatchObject({
      status: "awaiting_consent",
      digest: "d3",
    });
  });
});

describe("a closing write that cannot be made: nothing is read, closed or deleted, and everything stays", () => {
  test(`${ATTEMPTS} failures: retry_later/closing_unconfirmed, no digest read, no connection closed, no delete, the entry and the work stay`, async () => {
    const { f, l } = await ready();
    f.data.closingFailures = ATTEMPTS;
    expect(await run(f, l)).toEqual({
      kind: "retry_later",
      reason: "closing_unconfirmed",
    });
    expect(calls(f, "setClosing:")).toHaveLength(ATTEMPTS);
    for (const step of ["waitForClosure:", "liveDigest:", "close:", "delete:"])
      expect(calls(f, step), step).toEqual([]);
    expect(f.data.databases.has(l.account)).toBe(true);
    expect(f.data.work.get(l.account)).toEqual({ count: 2, digest: "d2" });
    expect(f.store.records.pending_deletions[l.account]).toMatchObject({
      status: "pending",
    });
    expect(f.data.closing.has(l.account)).toBe(false);
    expect(checkProperties(f)).toEqual([]);
  });

  test("a writer that gets in after the failures: the next entry sets the flag and RECOMPUTES the population (renewed consent), it does not delete it", async () => {
    const { f, l } = await ready();
    // What the person confirmed is the fence's digest, recorded when the fence was set; it does not follow later work.
    f.data.baselineDigests.set(l.account, "d2");
    f.data.closingFailures = ATTEMPTS;
    expect(await run(f, l)).toMatchObject({ reason: "closing_unconfirmed" });
    // Unconsented work arrives while the flag is still false (the pre-closing recovery exemption: it is accepted and counted).
    f.data.work.set(l.account, { count: 4, digest: "d4" });
    f.data.liveDigests.set(l.account, "d4");
    expect(await run(f, l)).toMatchObject({
      kind: "awaiting_consent",
      count: 4,
    });
    expect(f.data.closing.has(l.account)).toBe(true);
    expect(f.data.databases.has(l.account)).toBe(true);
    expect(calls(f, "delete:")).toEqual([]);
  });

  test("the fault gone, the next entry completes the very same deletion (a retry), with the flag set before the digest", async () => {
    const { f, l } = await ready();
    f.data.closingFailures = ATTEMPTS;
    expect(await run(f, l)).toMatchObject({ reason: "closing_unconfirmed" });
    expect(await run(f, l)).toMatchObject({ kind: "deleted" });
    expect(f.data.databases.has(l.account)).toBe(false);
    expect(f.store.records.pending_deletions[l.account]).toBeUndefined();
    const last = f.data.calls.slice(-8);
    expect(last.indexOf(`setClosing:${l.account}`)).toBeLessThan(
      last.indexOf(`liveDigest:${l.account}`),
    );
  });

  test("a port that REJECTS (it breaks its totality) is not a flag either", async () => {
    const { f, l } = await ready();
    f.data.closingRejections = ATTEMPTS;
    expect(await run(f, l)).toMatchObject({
      kind: "retry_later",
      reason: "closing_unconfirmed",
    });
    expect(calls(f, "delete:")).toEqual([]);
    expect(f.data.databases.has(l.account)).toBe(true);
  });

  test("a port that answers anything but exactly `closing` (the old swallowing shape, `undefined`) is not a flag", async () => {
    const { f, l } = await ready();
    const coordination = l.page.kernel.ports.deletion.coordination;
    coordination.setClosing = async () => undefined as never;
    expect(await run(f, l)).toMatchObject({
      kind: "retry_later",
      reason: "closing_unconfirmed",
    });
    for (const step of ["liveDigest:", "close:", "delete:"])
      expect(calls(f, step), step).toEqual([]);
    expect(f.data.databases.has(l.account)).toBe(true);
  });

  test("an approved deletion (the person said delete) is held back the same way, and completes on the retry without asking again", async () => {
    const { f, l } = await ready();
    f.data.baselineDigests.set(l.account, "d2");
    f.data.liveDigests.set(l.account, "d3");
    f.data.work.set(l.account, { count: 3, digest: "d3" });
    expect(await run(f, l)).toMatchObject({ kind: "awaiting_consent" });
    const view = l.page.session.view.get();
    if (view.kind !== "neutral" || !view.consent) throw new Error("no prompt");
    f.data.closingFailures = ATTEMPTS;
    expect(
      await drive(
        f,
        l.page.session.wipe.resolveConsent(view.consent.ticket, "delete"),
      ),
    ).toMatchObject({ kind: "retry_later", reason: "closing_unconfirmed" });
    expect(f.store.records.pending_deletions[l.account]).toMatchObject({
      status: "deletion_approved",
    });
    expect(f.data.databases.has(l.account)).toBe(true);
    expect(await run(f, l)).toMatchObject({ kind: "deleted" });
  });
});

describe("the entry that stayed is picked up again, by a boot and by a fresh sign-in", () => {
  test("a fresh page's boot (`recoverPending`) completes the deletion once the flag can be set, and recomputes the population first", async () => {
    const { f, l } = await ready();
    f.data.baselineDigests.set(l.account, "d2");
    f.data.closingFailures = ATTEMPTS;
    expect(await run(f, l)).toMatchObject({ reason: "closing_unconfirmed" });
    expect(f.data.databases.has(l.account)).toBe(true);
    l.page.destroy();
    const fresh = f.addPage();
    await f.boot(fresh);
    await f.world.runUntilIdle();
    expect(f.data.databases.has(l.account)).toBe(false);
    expect(f.store.records.pending_deletions[l.account]).toBeUndefined();
  });

  test("a boot that finds work that arrived in between asks about it instead of deleting", async () => {
    const { f, l } = await ready();
    f.data.baselineDigests.set(l.account, "d2");
    f.data.closingFailures = ATTEMPTS;
    expect(await run(f, l)).toMatchObject({ reason: "closing_unconfirmed" });
    f.data.work.set(l.account, { count: 5, digest: "d5" });
    f.data.liveDigests.set(l.account, "d5");
    l.page.destroy();
    const fresh = f.addPage();
    await f.boot(fresh);
    await f.world.runUntilIdle();
    expect(f.data.databases.has(l.account)).toBe(true);
    expect(f.store.records.pending_deletions[l.account]).toMatchObject({
      status: "awaiting_consent",
      digest: "d5",
    });
    expect(calls(f, "delete:")).toEqual([]);
  });

  test("a fresh sign-in for the account runs the procedure FIRST, and the old database is deleted before the new session settles", async () => {
    const { f, l } = await ready();
    f.data.closingFailures = ATTEMPTS;
    expect(await run(f, l)).toMatchObject({ reason: "closing_unconfirmed" });
    expect(f.store.records.pending_deletions[l.account]).toBeDefined();
    const outcome = await f.signIn(l.page, "kieran", "pw");
    expect(outcome).toMatchObject({ kind: "settled" });
    expect(f.data.databases.has(l.account)).toBe(false);
    expect(f.store.records.pending_deletions[l.account]).toBeUndefined();
  });
});

describe("the control and the contract", () => {
  test("the flag is set at the first ask: one call, the ordinary order, no sleep", async () => {
    const { f, l } = await ready();
    const before = f.world.time;
    expect(await run(f, l)).toMatchObject({ kind: "deleted" });
    expect(calls(f, "setClosing:")).toHaveLength(1);
    expect(f.world.time - before).toBeLessThan(DEFAULT_CONFIG.backoffInitialMs);
  });

  test("the asks are bounded by `closingWriteAttempts`: the first re-ask is at once, the later ones follow the back-off, and none comes after the last", async () => {
    const { f, l } = await ready();
    f.data.closingFailures = 99;
    const start = f.world.time;
    expect(await run(f, l)).toMatchObject({ reason: "closing_unconfirmed" });
    expect(calls(f, "setClosing:")).toHaveLength(ATTEMPTS);
    const waited = f.world.time - start;
    let expected = 0;
    for (let attempt = 2; attempt < ATTEMPTS; attempt += 1)
      expected += Math.min(
        DEFAULT_CONFIG.backoffInitialMs * 2 ** (attempt - 2),
        DEFAULT_CONFIG.backoffMaxMs,
      );
    expect(waited).toBeGreaterThanOrEqual(expected);
    expect(waited).toBeLessThan(expected + DEFAULT_CONFIG.backoffInitialMs);
  });
});
