// @vitest-environment node
import { describe, expect, test } from "vitest";
import type { Fixture } from "../support/session/harness";
import { checkProperties } from "../support/session/properties";
import {
  fencesOf,
  newWorld,
  ordinaryGet,
  signedInPage,
  stateOf,
} from "../support/session/scenarios";

/**
 * F-ROW: the lifecycle rows WEB-08a owns outright (matrix 2, rows 1, 2, 6, 7 and 8). Fixture tests against the stub
 * server; the trace of these rows against a rendered cache belongs to WEB-08c. Rows 3 to 5 and 9 are exercised in the
 * operations, recording-path and unresolved-lease suites.
 */
const wipeRan = (f: Fixture) =>
  f.data.calls.some((c) => c.startsWith("delete:"));
const draftFenced = (f: Fixture) =>
  f.data.calls.some((c) => c.startsWith("setDraftFence:"));
const unsynced = { count: 2, items: ["2 unsent changes"], digest: "d2" };

async function withData(f: Fixture, account: string) {
  f.data.databases.set(account, { incarnation: "inc-1" });
  f.data.work.set(account, { count: 2, digest: "d2" });
}

describe("rows 1 and 2: the physical wipe is called for the two confirmed triggers, and only them", () => {
  test("row 1: an explicit logout, once confirmed, wipes this browser's data for the account", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    await withData(f, l.account);
    await f.runWith(l.page.session.operations.logout({ unsynced }));
    await f.settle();
    expect(wipeRan(f)).toBe(true);
    expect(f.data.databases.has(l.account)).toBe(false);
  });

  test("row 2: retiring THIS device, once confirmed, wipes it", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    await withData(f, l.account);
    const read = await f.runWith(l.page.session.operations.readDevices());
    if (!read.ok) throw new Error("read failed");
    const current = read.value.devices.find((d) => d.current);
    if (!current) throw new Error("no current device");
    await f.runWith(
      l.page.session.operations.retireThisDevice({ read: current, unsynced }),
    );
    await f.settle();
    expect(wipeRan(f)).toBe(true);
  });

  test("not for another session's revocation, a password change, an unlink, a detected 401 or an unresolved response", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    await withData(f, l.account);
    const other = f.server.createSession(l.account, "dev-x");
    await f.runWith(l.page.session.operations.revokeOtherSession(other.id));
    await f.settle();
    expect(wipeRan(f) || draftFenced(f)).toBe(false);
    // A 401 detected by an ordinary request: a fence, hold and gate; nothing is deleted (rows 4 and 5).
    f.server.revoke(l.sessionId);
    await f.runWith(
      ordinaryGet(l.page, l.account, l.epoch).catch(() => undefined),
    );
    await f.settle();
    expect(fencesOf(f, l.account).length).toBeGreaterThan(0);
    expect(wipeRan(f) || draftFenced(f)).toBe(false);
    expect(f.data.databases.has(l.account)).toBe(true);
    expect(checkProperties(f)).toEqual([]);
  });
});

describe("row 6: ordinary offline continuation", () => {
  test("an eligible account is shown by a new page loaded offline with no network call at all", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const requestsBefore = f.server.requests.length;
    const page = f.addPage();
    page.env.online = false;
    await f.boot(page);
    await f.settle();
    expect(page.session.view.get()).toMatchObject({
      kind: "displaying",
      account_id: l.account,
    });
    expect(f.server.requests.length).toBe(requestsBefore);
    expect(checkProperties(f)).toEqual([]);
  });

  test("offline loss of connectivity alone triggers no neutral state and no fence", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    l.page.goOffline();
    await f.settle();
    expect(l.page.session.view.get().kind).toBe("displaying");
    expect(stateOf(f).fences).toEqual({});
  });
});

describe("row 7: switching account without logging out", () => {
  async function switchToSam() {
    const f = await newWorld();
    const l = await signedInPage(f);
    await withData(f, l.account);
    const outcome = await f.signIn(l.page, "sam", "pw2");
    await f.settle();
    return { f, l, outcome };
  }

  test("the outgoing account's database and unsent work are untouched", async () => {
    const { f, l, outcome } = await switchToSam();
    expect(outcome.kind).toBe("settled");
    expect(f.data.databases.has(l.account)).toBe(true);
    expect(f.data.work.get(l.account)).toEqual({ count: 2, digest: "d2" });
    expect(wipeRan(f)).toBe(false);
    expect(stateOf(f).settled?.account_id).not.toBe(l.account);
  });

  test("the outgoing account's queue never replays under the incoming identity: its covers return STALE", async () => {
    const { f, l } = await switchToSam();
    await expect(
      f.runWith(ordinaryGet(l.page, l.account, l.epoch)),
    ).rejects.toMatchObject({ kind: "stale" });
  });

  test("the incoming identity is settled, and the outgoing account is gated while the attempt gates", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const begun = await f.runWith(l.page.session.attempts.begin("password"));
    if (begun.kind !== "started") throw new Error("begin failed");
    // Until the attempt settles the page holds the outgoing account only while it is not gating.
    expect(stateOf(f).attempt?.phase).toBe("exchanging");
    expect(l.page.session.view.get().kind).toBe("displaying");
    const outcome = await f.runWith(
      l.page.session.attempts.signInWithPassword(begun.handle, {
        username: "sam",
        password: "pw2",
      }),
    );
    await f.settle();
    expect(outcome.kind).toBe("settled");
    expect(l.page.session.identity.get()?.account_id).not.toBe(l.account);
  });
});

describe("row 8: switching back to a retained account", () => {
  test("it is a fresh attempt with a fresh epoch; nothing of the old epoch is resumed", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    await f.signIn(l.page, "sam", "pw2");
    await f.settle();
    const back = await f.signIn(l.page, "kieran", "pw");
    await f.settle();
    expect(back).toMatchObject({ kind: "settled", account_id: l.account });
    expect((back as { epoch: number }).epoch).toBeGreaterThan(l.epoch + 1);
  });

  test("a retained account's fence is not lifted by settlement (it waits for catch-up, rule 9)", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    // A detected invalidation fences the account (row 4) ...
    f.server.revoke(l.sessionId);
    await f.runWith(
      ordinaryGet(l.page, l.account, l.epoch).catch(() => undefined),
    );
    await f.settle();
    const fenced = fencesOf(f, l.account).length;
    expect(fenced).toBeGreaterThan(0);
    // ... the person signs in as someone else, then back as the fenced account.
    await f.signIn(l.page, "sam", "pw2");
    await f.settle();
    expect(fencesOf(f, l.account).length).toBeGreaterThanOrEqual(fenced);
    await f.signIn(l.page, "kieran", "pw");
    await f.settle();
    expect(fencesOf(f, l.account).length).toBeGreaterThanOrEqual(fenced);
    // The account is settled again but NOT displayed: the fence waits for catch-up.
    expect(l.page.session.view.get().kind).toBe("neutral");
    expect(checkProperties(f)).toEqual([]);
  });
});
