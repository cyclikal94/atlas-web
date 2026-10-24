// @vitest-environment node
import { describe, expect, test } from "vitest";
import { StampedRequestError } from "../../src/session/api";
import { checkProperties } from "../support/session/properties";
import {
  fencesOf,
  newWorld,
  ordinaryGet,
  signedInPage,
  stateOf,
} from "../support/session/scenarios";

/**
 * WEB-08c §2.3 (gap G-23) with the REAL kernel: "Confirm it's you" is an ordinary password sign-in as the account that is already
 * settled. A same-account settlement makes a new session at a NEWER epoch and is not a switch: the account's database, its unsent
 * work and its cursor stay (lifecycle row 7 does not apply to the same account), no row 4/5 fence appears, and a request stamped with
 * the old epoch is `stale` afterwards (it is never sent under the new session). The component side is `confirm-its-you.test.tsx`.
 */
describe("same-account re-authentication in place", () => {
  test("a new epoch and session for the SAME account; local data and work kept; nothing wiped; no fence; the tree mounts again for it", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    f.data.databases.set(l.account, { incarnation: "inc-1" });
    f.data.work.set(l.account, { count: 3, digest: "d3" });
    const before = stateOf(f).settled;
    const outcome = await f.signIn(l.page, "kieran", "pw");
    await f.settle();
    expect(outcome).toMatchObject({
      kind: "settled",
      account_id: l.account,
      method: "password",
    });
    const after = stateOf(f).settled;
    expect(after?.account_id).toBe(l.account);
    expect(after?.epoch).toBeGreaterThan(before?.epoch ?? 0);
    expect(after?.session_id).not.toBe(before?.session_id);
    expect(f.data.databases.get(l.account)).toEqual({ incarnation: "inc-1" });
    expect(f.data.work.get(l.account)).toEqual({ count: 3, digest: "d3" });
    expect(f.data.calls.filter((c) => c.startsWith("delete:"))).toEqual([]);
    expect(fencesOf(f, l.account)).toEqual([]);
    expect(l.page.session.view.get()).toMatchObject({
      kind: "displaying",
      account_id: l.account,
      epoch: after?.epoch,
    });
    // The older session is still the server's (re-authentication does not revoke it), but nothing of this page uses it again.
    expect(f.server.sessions.has(before?.session_id ?? "")).toBe(true);
    expect(checkProperties(f)).toEqual([]);
  });

  test("a request stamped with the OLD epoch is stale afterwards: nothing is sent under either session", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    await f.signIn(l.page, "kieran", "pw");
    await f.settle();
    const sent = f.server.requests.filter((r) =>
      r.path.endsWith("/probe"),
    ).length;
    const error = await f.runWith(
      ordinaryGet(l.page, l.account, l.epoch).then(
        () => null,
        (e: unknown) => e,
      ),
    );
    expect(error).toBeInstanceOf(StampedRequestError);
    expect((error as StampedRequestError).kind).toBe("stale");
    expect(
      f.server.requests.filter((r) => r.path.endsWith("/probe")).length,
    ).toBe(sent);
  });

  test("the new session is fresh: its own created_at is the server's newest for this account (the five-minute window starts again)", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    await f.world.advance(10 * 60_000);
    await f.signIn(l.page, "kieran", "pw");
    await f.settle();
    const listed = await f.runWith(l.page.session.operations.listSessions());
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const current = listed.value.sessions.find((s) => s.current);
    const older = listed.value.sessions.find((s) => !s.current);
    expect(current).toBeDefined();
    expect(Date.parse(current?.created_at ?? "")).toBeGreaterThan(
      Date.parse(older?.created_at ?? "1970-01-01T00:00:00Z"),
    );
  });
});
