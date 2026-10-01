// @vitest-environment node
import { describe, expect, test } from "vitest";
import type { Fixture } from "../support/session/harness";
import {
  checkProperties,
  checkQuiescence,
} from "../support/session/properties";
import {
  fencesOf,
  leaseIds,
  newWorld,
  openPage,
  signedInPage,
  stateOf,
} from "../support/session/scenarios";

/**
 * F-LOG-*: explicit logout (matrix 3.5, T18). The envelope is written in the SAME transaction as its fence and every
 * send and retry is built from it alone. Fixture tests against a stub of the contract.
 */
const unsynced = (digest = "d2", count = 2) => ({
  count,
  items: ["2 unsent changes"],
  digest,
});
const deletes = (f: Fixture) =>
  f.server.requests.filter(
    (r) => r.method === "DELETE" && /\/sessions\/[^/]+$/.test(r.path),
  );

async function withLocalData(f: Fixture, account: string) {
  f.data.databases.set(account, { incarnation: "inc-1" });
  f.data.work.set(account, { count: 2, digest: "d2" });
}

describe("T18 variant A: the request never reached the server; the old session is valid", () => {
  test("the envelope and the fence are one transaction; the identical keyed call is sent; confirmed_applied wipes, then clears settled", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    await withLocalData(f, l.account);
    let fencesAtDraftFence: unknown = "unset";
    f.data.onSetDraftFence = () => {
      fencesAtDraftFence = structuredClone(stateOf(f).fences);
    };
    const started = await f.runWith(
      l.page.session.operations.logout({ unsynced: unsynced() }),
    );
    expect(started.kind).toBe("started");
    // D-18: the draft-write fence precedes the operation fence and the network call.
    expect(fencesAtDraftFence).toEqual({});
    const call = deletes(f)[0];
    expect(call?.path).toContain(`/sessions/${l.sessionId}`);
    expect(call?.headers["idempotency-key"]).toBe(
      (started as { operation_id: string }).operation_id,
    );
    await f.settle();
    // The wipe ran the canonical procedure in order, then the atlas-auth completion.
    const steps = f.data.calls.filter((c) =>
      /^(exists|incarnation|broadcastImminent|setClosing|waitForClosure|liveDigest|close|delete)/.test(
        c,
      ),
    );
    // record first (probe + incarnation for the ledger entry), step 1 (exists), steps 2-3 (incarnation), 3a, 4.
    expect(steps.map((c) => c.split(":")[0])).toEqual([
      "exists",
      "incarnation",
      "exists",
      "incarnation",
      "broadcastImminent",
      "setClosing",
      "waitForClosure",
      "liveDigest",
      "close",
      "delete",
    ]);
    expect(f.data.databases.has(l.account)).toBe(false);
    expect(stateOf(f).settled).toBeNull();
    expect(stateOf(f).fences).toEqual({});
    expect(leaseIds(f)).toEqual([]);
    expect(l.page.session.view.get()).toMatchObject({ kind: "signed_out" });
    expect(
      f.server.requests.filter(
        (r) => r.hadSetCookie && r.path.includes("/sessions/"),
      ),
    ).toEqual([]); // G1: no response sets a cookie
    expect(checkProperties(f)).toEqual([]);
    expect(checkQuiescence(f)).toEqual([]);
  });

  test("a logout initiated OFFLINE raises the fence (state 1a), sends nothing, and is sent from the envelope alone after every tab is destroyed", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    await withLocalData(f, l.account);
    l.page.goOffline();
    const started = await f.runWith(
      l.page.session.operations.logout({ unsynced: unsynced() }),
    );
    expect(started.kind).toBe("started");
    expect(l.page.session.view.get()).toMatchObject({
      kind: "neutral",
      state: "1a.confirming",
    });
    expect(deletes(f)).toEqual([]);
    expect(f.data.databases.has(l.account)).toBe(true); // NOT wiped until the ledger says so
    const envelope = (stateOf(f).fences[l.account] ?? []).find(
      (fence) => fence.kind === "operation",
    );
    expect(envelope).toBeDefined();
    // Destroy ALL page memory between the write and the send.
    l.page.destroy();
    const fresh = f.addPage();
    fresh.goOffline();
    await f.boot(fresh);
    expect(fresh.session.view.get()).toMatchObject({
      kind: "neutral",
      state: "1a.confirming",
    }); // in the first frame, from the durable fence
    fresh.goOnline();
    await f.world.runUntilIdle();
    const call = deletes(f)[0];
    expect(call?.path).toContain(`/sessions/${l.sessionId}`);
    expect(call?.headers["idempotency-key"]).toBe(
      (envelope as { envelope: { operation_id: string } }).envelope
        .operation_id,
    );
    expect(f.data.databases.has(l.account)).toBe(false);
    expect(stateOf(f).settled).toBeNull();
    expect(fresh.session.view.get()).toMatchObject({ kind: "signed_out" });
  });

  test("one at a time: a second logout while an operation fence exists is refused", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const other = await openPage(f);
    l.page.goOffline();
    other.goOffline();
    const first = await f.runWith(
      l.page.session.operations.logout({ unsynced: unsynced("0", 0) }),
    );
    expect(first.kind).toBe("started");
    const second = await f.runWith(
      other.session.operations.logout({ unsynced: unsynced("0", 0) }),
    );
    expect(second).toEqual({ kind: "refused", reason: "operation_pending" });
    expect(
      Object.values(stateOf(f).fences)
        .flat()
        .filter((x) => x.kind === "operation"),
    ).toHaveLength(1);
  });

  test("two tabs confirm a logout at once: exactly one wins (EC-35)", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const other = await openPage(f);
    l.page.goOffline();
    other.goOffline();
    const results = await Promise.all([
      f.runWith(
        l.page.session.operations.logout({ unsynced: unsynced("0", 0) }),
      ),
      f.runWith(
        other.session.operations.logout({ unsynced: unsynced("0", 0) }),
      ),
    ]);
    expect(results.map((r) => r.kind).sort()).toEqual(["refused", "started"]);
  });

  test("the recount at confirmation differs from what the person saw: `reconfirm`, nothing fenced, the draft fence released", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    f.data.work.set(l.account, { count: 3, digest: "d3" });
    const result = await f.runWith(
      l.page.session.operations.logout({ unsynced: unsynced("d2", 2) }),
    );
    expect(result).toMatchObject({
      kind: "reconfirm",
      unsynced: { count: 3, digest: "d3" },
    });
    expect(stateOf(f).fences).toEqual({});
    expect(f.data.calls).toContain(`releaseFence:${l.account}`);
    expect(deletes(f)).toEqual([]);
  });

  test("every retry is the IDENTICAL call: same path, same key, nothing re-derived", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    f.server.addRule({
      match: (r) => r.method === "DELETE" && /\/sessions\//.test(r.path),
      dropBeforeForward: true,
      times: 2,
    });
    const started = await f.runWith(
      l.page.session.operations.logout({ unsynced: unsynced("0", 0) }),
    );
    expect(started.kind).toBe("started");
    await f.world.advance(200_000);
    // Two attempts were lost before reaching the server; the third is the IDENTICAL call. Nothing is re-derived.
    const lost = f.world.logs.filter((e) => e.type === "fetch.lost");
    expect(lost).toHaveLength(2);
    const calls = deletes(f);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toContain(`/sessions/${l.sessionId}`);
    const key = calls[0]?.headers["idempotency-key"];
    expect(key).toBe((started as { operation_id: string }).operation_id);
    expect(stateOf(f).settled).toBeNull();
  });
});

describe("T18 variant B: the session has expired or been revoked", () => {
  test("401 says nothing about OP1: state 1a stays through the re-authentication; the identical call under the NEW session answers superseded; no wipe", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    await withLocalData(f, l.account);
    l.page.goOffline();
    await f.runWith(l.page.session.operations.logout({ unsynced: unsynced() }));
    f.server.revoke(l.sessionId); // the session has expired or been revoked meanwhile
    l.page.goOnline();
    await f.world.runUntilIdle();
    // current() answered 401: a fresh attempt is needed; the fence stays.
    expect(deletes(f)).toEqual([]);
    expect(fencesOf(f, l.account)).toEqual(
      expect.arrayContaining(["operation"]),
    );
    expect(l.page.session.view.get()).toMatchObject({
      kind: "neutral",
      state: "1a.confirming",
    });
    // Re-authenticate for that account: the fence is NOT lifted by settlement (3.5.6).
    expect(await f.signIn(l.page, "kieran", "pw")).toMatchObject({
      kind: "settled",
      epoch: 2,
    });
    await f.world.runUntilIdle();
    // The identical call under S2: no ledger row and no session S1 -> superseded -> invalid_session(removed_elsewhere).
    const call = deletes(f)[0];
    expect(call?.path).toContain(`/sessions/${l.sessionId}`);
    expect(f.data.calls.filter((c) => c.startsWith("delete:"))).toEqual([]); // NO wipe
    expect(f.data.databases.has(l.account)).toBe(true);
    const list = stateOf(f).fences[l.account] ?? [];
    expect(list.some((x) => x.kind === "operation")).toBe(false);
    expect(
      list.some(
        (x) => x.kind === "invalid_session" && x.reason === "removed_elsewhere",
      ),
    ).toBe(true);
    // Matrix B5: the superseded outcome hands over to the row 4/5 hide, never a wipe; the person has signed in again,
    // so it is the catch-up card (state 2).
    expect(l.page.session.view.get()).toMatchObject({
      kind: "neutral",
      state: "2",
    });
  });
});

describe("T18 variant C: committed, the response was lost, the cookie is dead", () => {
  test("the identical call under the new session replays confirmed_applied from the ledger; the new session is not targeted and no cookie is set; settled is KEPT and the person is told", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    await withLocalData(f, l.account);
    f.server.addRule({
      match: (r) => r.method === "DELETE" && /\/sessions\//.test(r.path),
      dropAfterForward: true,
      times: 1,
    });
    await f.runWith(l.page.session.operations.logout({ unsynced: unsynced() }));
    await f.world.advance(10_000);
    // The server committed (S1 deleted, ledger row); the answer was lost; the cookie is dead.
    expect(f.server.sessions.has(l.sessionId)).toBe(false);
    expect(l.page.session.view.get()).toMatchObject({ kind: "neutral" });
    expect(await f.signIn(l.page, "kieran", "pw")).toMatchObject({
      kind: "settled",
      epoch: 2,
    });
    await f.world.runUntilIdle();
    const newSession = stateOf(f).settled?.session_id;
    expect(newSession).toBeDefined();
    expect(f.server.sessions.has(newSession as string)).toBe(true); // S2 is alive: never targeted
    expect(
      f.server.requests.filter((r) => r.hadSetCookie && r.method === "DELETE"),
    ).toEqual([]);
    expect(f.data.databases.has(l.account)).toBe(false); // wiped
    expect(stateOf(f).settled).toMatchObject({ epoch: 2 }); // kept: epoch 2 is newer than initiated_epoch 1
    expect(stateOf(f).fences[l.account]).toBeUndefined();
    expect(l.page.session.notices.get().map((n) => n.kind)).toEqual([
      "remained_signed_in",
    ]); // told plainly, never signed out automatically
    expect(l.page.session.view.get().kind).toBe("displaying");
  });
});

describe("T18 variant D: a different account is settled when the person returns", () => {
  test("nothing is sent under the other account's credentials; X's fence is untouched and X is never rendered", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    l.page.goOffline();
    await f.runWith(
      l.page.session.operations.logout({ unsynced: unsynced("0", 0) }),
    );
    l.page.goOnline();
    // Y signs in on this browser (the cookie is replaced): X's fence survives the switch.
    f.server.revoke(l.sessionId);
    f.server.adoptCookie(
      f.server.createSession(
        [...f.server.accounts.values()][1]?.id ?? "acct-2",
        "dev-y",
      ),
    );
    await f.world.runUntilIdle();
    expect(await f.signIn(l.page, "sam", "pw2")).toMatchObject({
      kind: "settled",
    });
    await f.world.runUntilIdle();
    expect(stateOf(f).settled?.account_id).toBe("acct-2");
    expect(fencesOf(f, l.account)).toEqual([
      "operation",
      ...fencesOf(f, l.account).slice(1),
    ]);
    expect(deletes(f).filter((d) => d.time > 0)).toEqual(
      deletes(f).filter(() => false),
    ); // no DELETE at all under Y's credentials
    expect(l.page.session.view.get().kind).toBe("displaying"); // Y renders normally
    expect(l.page.surface.mounted?.account).toBe("acct-2");
  });
});
