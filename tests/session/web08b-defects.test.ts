// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  attemptOf,
  newWorld,
  signedInPage,
  stateOf,
} from "../support/session/scenarios";

/**
 * WEB-08b step 1: failing tests first for the three defects the plan found in the delivered WEB-08a code (plan 1: K-1,
 * K-2, C-4). Each fails on the delivered code and passes once the defect is fixed. Fixture evidence only.
 */
describe("K-1: a stale exchange ERROR is discarded as superseded (matrix O7, T3)", () => {
  test("the older attempt's wrong-password 401 reports `superseded`, not `refused`, and touches nothing of the newer attempt", async () => {
    const f = await newWorld();
    const a = f.addPage();
    const b = f.addPage();
    await f.boot(a);
    await f.boot(b);
    const [ra, rb] = await Promise.all([
      f.runWith(a.session.attempts.begin("password")),
      f.runWith(b.session.attempts.begin("password")),
    ]);
    if (ra.kind !== "started" || rb.kind !== "started")
      throw new Error("both should start");
    const newest = Math.max(ra.handle.epoch, rb.handle.epoch);
    const older = ra.handle.epoch === newest ? rb : ra;
    const olderPage = ra.handle.epoch === newest ? b : a;
    const before = structuredClone(attemptOf(f));
    const staleError = await f.runWith(
      olderPage.session.attempts.signInWithPassword(older.handle, {
        username: "kieran",
        password: "WRONG",
      }),
    );
    // The caller must NOT be told "wrong password": that error belongs to an attempt nobody is waiting on any more.
    expect(staleError).toEqual({ kind: "superseded" });
    expect(attemptOf(f)).toEqual(before);
    expect(stateOf(f).settled).toBeNull();
    expect(f.store.violations).toEqual([]);
  });

  test("a stale network failure is also `superseded`", async () => {
    const f = await newWorld();
    const a = f.addPage();
    const b = f.addPage();
    await f.boot(a);
    await f.boot(b);
    const [ra, rb] = await Promise.all([
      f.runWith(a.session.attempts.begin("password")),
      f.runWith(b.session.attempts.begin("password")),
    ]);
    if (ra.kind !== "started" || rb.kind !== "started")
      throw new Error("both should start");
    const newest = Math.max(ra.handle.epoch, rb.handle.epoch);
    const older = ra.handle.epoch === newest ? rb : ra;
    const olderPage = ra.handle.epoch === newest ? b : a;
    f.server.addRule({
      match: ({ path }) => path.endsWith("/browser-sessions"),
      dropBeforeForward: true,
      times: 1,
    });
    const outcome = await f.runWith(
      olderPage.session.attempts.signInWithPassword(older.handle, {
        username: "kieran",
        password: "pw",
      }),
    );
    expect(outcome).toEqual({ kind: "superseded" });
    expect(attemptOf(f).epoch).toBe(newest);
  });

  test("the CURRENT attempt's wrong password is still a definitive refusal", async () => {
    const f = await newWorld();
    const page = f.addPage();
    await f.boot(page);
    expect(await f.signIn(page, "kieran", "WRONG")).toMatchObject({
      kind: "refused",
      definitive: true,
    });
    expect(stateOf(f).attempt).toBeNull();
  });
});

describe("K-3: a refusal says which request was refused", () => {
  test("a wrong password is refused at the `exchange` stage", async () => {
    const f = await newWorld();
    const page = f.addPage();
    await f.boot(page);
    expect(await f.signIn(page, "kieran", "WRONG")).toMatchObject({
      kind: "refused",
      stage: "exchange",
    });
  });

  test("a good grant refused at `activate` (device capacity) is refused at the `activation` stage", async () => {
    const f = await newWorld();
    const page = f.addPage();
    await f.boot(page);
    f.server.deviceCapacity = 1;
    expect(await f.signIn(page, "kieran", "pw")).toMatchObject({
      kind: "refused",
      error: { code: "device_capacity" },
      stage: "activation",
    });
  });
});

describe("K-2: a settlement says which method settled it", () => {
  test("a password sign-in settles with method `password`", async () => {
    const f = await newWorld();
    const page = f.addPage();
    await f.boot(page);
    const outcome = await f.signIn(page, "kieran", "pw");
    expect(outcome).toMatchObject({ kind: "settled", method: "password" });
  });
});

describe("C-4: unlinking sends the issuer the contract requires", () => {
  test("DELETE /oidc/identities carries { issuer } and the unlink succeeds", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const issuer = f.server.oidcIssuer;
    f.server.accounts.get(l.account)?.oidcIssuers.push(issuer);
    const result = await f.runWith(
      l.page.session.operations.unlinkOidc(issuer),
    );
    expect(result).toEqual({ ok: true, value: "unlinked" });
    const sent = f.server.recordsFor("/api/experimental/v1/oidc/identities");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toEqual({ issuer });
    expect(sent[0]?.headers["content-type"]).toBe("application/json");
  });
});
