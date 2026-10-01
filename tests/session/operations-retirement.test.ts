// @vitest-environment node
import { describe, expect, test } from "vitest";
import type { DeviceRow } from "../../src/session/api";
import type { FakePage, Fixture } from "../support/session/harness";
import { checkProperties } from "../support/session/properties";
import {
  fencesOf,
  newWorld,
  signedInPage,
  stateOf,
} from "../support/session/scenarios";

/**
 * F-RET-*: self-retirement of the current device (matrix 3.5, T19). The approved state token is sent verbatim and
 * never derived by the client; a `rejected_stale` outcome is NEVER retried against the changed state. Fixture tests
 * against a stub of the contract (not the backend's concurrency, which is the backend's own suite).
 */
const unsynced = { count: 2, items: ["2 unsent changes"], digest: "d2" };
const retirements = (f: Fixture) =>
  f.server.requests.filter(
    (r) => r.method === "DELETE" && /\/devices\/[^/]+$/.test(r.path),
  );

async function confirmedRead(f: Fixture, page: FakePage): Promise<DeviceRow> {
  const read = await f.runWith(page.session.operations.readDevices());
  if (!read.ok) throw new Error("devices read failed");
  const current = read.value.devices.find((d) => d.current);
  if (!current) throw new Error("no current device");
  return current;
}
async function setup() {
  const f = await newWorld();
  const l = await signedInPage(f);
  f.data.databases.set(l.account, { incarnation: "inc-1" });
  f.data.work.set(l.account, { count: 2, digest: "d2" });
  const row = await confirmedRead(f, l.page);
  return { f, l, row };
}

describe("applied: the approved state is unchanged", () => {
  test("the token and summary of the SAME read are in the envelope; the identical call confirms; the wipe runs; sessions are revoked with no Set-Cookie", async () => {
    const { f, l, row } = await setup();
    expect(row.state_token).toMatch(/^v1\.[A-Za-z0-9_-]{43}$/);
    const result = await f.runWith(
      l.page.session.operations.retireThisDevice({ read: row, unsynced }),
    );
    expect(result.kind).toBe("started");
    const call = retirements(f)[0];
    expect(call?.path).toContain(`/devices/${row.id}`);
    expect(call?.headers["atlas-device-state"]).toBe(row.state_token); // verbatim: the client never derives it
    expect(call?.hadSetCookie).toBe(false);
    await f.settle();
    expect(f.server.sessions.size).toBe(0);
    expect(f.data.databases.has(l.account)).toBe(false);
    expect(stateOf(f).settled).toBeNull();
    expect(l.page.session.view.get()).toMatchObject({ kind: "signed_out" });
    expect(checkProperties(f)).toEqual([]);
  });

  test("retirement needs the current device of that read; offline it is refused (online-only to initiate)", async () => {
    const { f, l, row } = await setup();
    expect(
      await f.runWith(
        l.page.session.operations.retireThisDevice({
          read: { ...row, current: false },
          unsynced,
        }),
      ),
    ).toEqual({ kind: "refused", reason: "no_current_device" });
    l.page.goOffline();
    expect(
      await f.runWith(
        l.page.session.operations.retireThisDevice({ read: row, unsynced }),
      ),
    ).toEqual({ kind: "refused", reason: "offline" });
    expect(stateOf(f).fences).toEqual({});
    expect(retirements(f)).toEqual([]);
  });
});

describe("T19 stale rejections S1 to S8: nothing is deleted, nothing is retried, no wipe", () => {
  const stale: Array<
    [string, (f: Fixture, device: string, account: string) => void]
  > = [
    [
      "S1 a subscription changed",
      (f, d) => f.server.device(d).subscriptions.push("P1@4"),
    ],
    [
      "S2 a native handoff started for D",
      (f, d) => f.server.device(d).handoffs.push("H1"),
    ],
    [
      "S3 a grant issued for (X, D) by another tab",
      (f, d, a) =>
        f.server.grants.set("g-x", {
          grant: "g-x",
          account: a,
          device: d,
          challenge: "c".repeat(43),
          state: "issued",
          wrongVerifiers: 0,
          session: null,
        }),
    ],
    [
      "S4 the grant was redeemed: a session was added",
      (f, d, a) => {
        f.server.createSession(a, d);
      },
    ],
    [
      "S5 D was recreated: new session and new sync key",
      (f, d, a) => {
        f.server.createSession(a, d);
        f.server.device(d).sync_registered = true;
      },
    ],
    [
      "S6 the sync registration was removed by cleanup (S1 remains)",
      (f, d) => {
        f.server.device(d).sync_registered = false;
      },
    ],
    [
      "S8 a session expired between confirmation and processing",
      (f, d, a) => {
        f.server.createSession(a, d);
      },
    ],
  ];
  test.each(stale)("%s", async (name, mutate) => {
    const { f, l, row } = await setup();
    if (name.startsWith("S6")) {
      // The registration existed when the person confirmed.
      f.server.device(row.id).sync_registered = true;
    }
    const fresh = name.startsWith("S6") ? await confirmedRead(f, l.page) : row;
    if (name.startsWith("S8")) {
      const extra = f.server.createSession(l.account, row.id);
      const read = await confirmedRead(f, l.page);
      f.server.revoke(extra.id); // it expires before processing
      const started = await f.runWith(
        l.page.session.operations.retireThisDevice({ read, unsynced }),
      );
      expect(started.kind).toBe("started");
    } else {
      mutate(f, row.id, l.account);
      const started = await f.runWith(
        l.page.session.operations.retireThisDevice({ read: fresh, unsynced }),
      );
      expect(started.kind).toBe("started");
    }
    await f.settle();
    const calls = retirements(f);
    expect(calls).toHaveLength(1); // NEVER retried against the changed state
    expect(calls[0]?.status).toBe(409);
    expect(f.server.sessions.has(l.sessionId)).toBe(true); // nothing was deleted
    expect(f.data.calls.filter((c) => c.startsWith("delete:"))).toEqual([]); // no wipe
    expect(fencesOf(f, l.account)).toEqual([]);
    expect(stateOf(f).settled).not.toBeNull();
    expect(f.data.calls).toContain(`releaseFence:${l.account}`);
    expect(l.page.session.view.get()).toMatchObject({
      kind: "neutral",
      state: "1a.device_changed",
    }); // "review the device"
    // A new retirement needs a fresh read, a fresh confirmation and a NEW operation id.
    l.page.session.actions.reviewDevice();
    await f.world.runUntilIdle();
    expect(l.page.session.view.get().kind).toBe("displaying");
    expect(stateOf(f).fences).toEqual({});
  });

  test("S7 every component was removed by another cause: superseded -> the row-4/5 hide, NO wipe", async () => {
    const { f, l, row } = await setup();
    const session = f.server.sessions.get(l.sessionId);
    if (!session) throw new Error("no session");
    // The calling session now belongs to another device, so the retired device has no members at all.
    session.device = "another-device";
    const started = await f.runWith(
      l.page.session.operations.retireThisDevice({ read: row, unsynced }),
    );
    expect(started.kind).toBe("started");
    await f.settle();
    expect(retirements(f)[0]?.status).toBe(200);
    expect(f.data.calls.filter((c) => c.startsWith("delete:"))).toEqual([]);
    expect(
      stateOf(f).fences[l.account]?.some(
        (x) => x.kind === "invalid_session" && x.reason === "removed_elsewhere",
      ),
    ).toBe(true);
  });
});

describe("applied with the response lost, and not processed, with every tab closed", () => {
  test("P1 to P4: the ledger replays confirmed_applied under the NEW session; the recovery session is never deleted; settled is kept", async () => {
    const { f, l, row } = await setup();
    f.server.addRule({
      match: (r) => r.method === "DELETE" && /\/devices\//.test(r.path),
      dropAfterForward: true,
      times: 1,
    });
    const started = await f.runWith(
      l.page.session.operations.retireThisDevice({ read: row, unsynced }),
    );
    expect(started.kind).toBe("started");
    await f.world.advance(5000);
    expect(f.server.sessions.size).toBe(0); // P1: the request committed; the cookie is dead
    l.page.destroy();
    const fresh = f.addPage();
    fresh.goOffline();
    await f.boot(fresh);
    expect(fresh.session.view.get()).toMatchObject({
      kind: "neutral",
      state: "1a.confirming",
    }); // P2
    fresh.goOnline();
    await f.world.runUntilIdle();
    expect(fresh.session.view.get()).toMatchObject({
      kind: "neutral",
      state: "1a.confirming",
    }); // sign in again to check
    expect(await f.signIn(fresh, "kieran", "pw")).toMatchObject({
      kind: "settled",
      epoch: 2,
    }); // P3: creates S2 on D
    await f.world.runUntilIdle();
    // P4: the identical call answers from the ledger FIRST; nothing is recomputed and S2 is untouched.
    const replay = retirements(f).at(-1);
    expect(replay?.status).toBe(200);
    expect(replay?.headers["atlas-device-state"]).toBe(row.state_token);
    expect(f.server.sessions.size).toBe(1);
    expect(f.data.databases.has(l.account)).toBe(false);
    expect(stateOf(f).settled).toMatchObject({ epoch: 2 });
    expect(fresh.session.notices.get().map((n) => n.kind)).toEqual([
      "remained_signed_in",
    ]);
  });

  test("Q3: the request never reached the server and the person re-authenticated on D: rejected_stale, and the recovery session S2 is NEVER deleted", async () => {
    const { f, l, row } = await setup();
    f.server.addRule({
      match: (r) => r.method === "DELETE" && /\/devices\//.test(r.path),
      dropBeforeForward: true,
      times: 1,
    });
    l.page.goOffline();
    await f
      .runWith(
        l.page.session.operations.retireThisDevice({ read: row, unsynced }),
      )
      .catch(() => undefined);
    l.page.goOnline();
    f.server.revoke(l.sessionId); // the old cookie is dead
    await f.world.runUntilIdle();
    expect(await f.signIn(l.page, "kieran", "pw")).toMatchObject({
      kind: "settled",
    });
    await f.world.runUntilIdle();
    expect(f.server.sessions.size).toBe(1); // S2 alive
    expect(retirements(f).every((c) => c.status !== 200)).toBe(true);
  });
});

describe("other devices and sessions (SA-10)", () => {
  test("retiring ANOTHER device is an ordinary request with a fresh key and no fence, wipe or sign-out; rejected_stale is reported, never retried", async () => {
    const { f, l } = await setup();
    const other = f.server.createSession(l.account, "phone");
    const read = await f.runWith(l.page.session.operations.readDevices());
    if (!read.ok) throw new Error("read");
    const phone = read.value.devices.find((d) => d.id === "phone");
    expect(phone?.current).toBe(false);
    if (!phone) throw new Error("no phone");
    f.server.device("phone").subscriptions.push("P9"); // changes after the read
    const stale = await f.runWith(
      l.page.session.operations.retireOtherDevice(phone),
    );
    expect(stale).toEqual({ ok: true, value: "rejected_stale" });
    expect(f.server.sessions.has(other.id)).toBe(true);
    expect(stateOf(f).fences).toEqual({});
    const read2 = await f.runWith(l.page.session.operations.readDevices());
    if (!read2.ok) throw new Error("read");
    const fresh = read2.value.devices.find((d) => d.id === "phone");
    if (!fresh) throw new Error("no phone");
    expect(
      await f.runWith(l.page.session.operations.retireOtherDevice(fresh)),
    ).toEqual({ ok: true, value: "confirmed_applied" });
    expect(f.server.sessions.has(other.id)).toBe(false);
    expect(l.page.session.view.get().kind).toBe("displaying");
  });

  test("revokeOtherSession refuses the current session (use logout) and removes another", async () => {
    const { f, l } = await setup();
    const other = f.server.createSession(l.account, "phone");
    expect(
      await f.runWith(
        l.page.session.operations.revokeOtherSession(l.sessionId),
      ),
    ).toMatchObject({ ok: false, error: "closed" });
    expect(
      await f.runWith(l.page.session.operations.revokeOtherSession(other.id)),
    ).toEqual({ ok: true, value: "revoked" });
    expect(
      await f.runWith(l.page.session.operations.revokeOtherSession(other.id)),
    ).toEqual({ ok: true, value: "gone" });
    const sessions = await f.runWith(l.page.session.operations.listSessions());
    expect(
      sessions.ok && sessions.value.sessions.filter((s) => s.current),
    ).toHaveLength(1);
  });
});
