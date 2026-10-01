// @vitest-environment node
import { describe, expect, test } from "vitest";
import { StampedRequestError } from "../../src/session/kernel/types";
import {
  checkProperties,
  checkQuiescence,
} from "../support/session/properties";
import {
  fencesOf,
  holdAnswers,
  leaseIds,
  newWorld,
  ordinaryGet,
  signedInPage,
  stateOf,
} from "../support/session/scenarios";

/** F-WRAP-*: the stamped wrapper's wire behaviour (plan 7.10) and every result of decision D-06. */
const url = (path: string) =>
  new URL(`/api/experimental/v1${path}`, "http://localhost");

describe("headers, stamps and tokens", () => {
  test("a stamped request carries X-CSRF-Token from this page's own token; an identity read carries X-Atlas-Session: 1 and no CSRF header", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    await f.runWith(ordinaryGet(l.page, l.account, l.epoch));
    const stamped = f.server.requests
      .filter((r) => r.path.endsWith("/probe"))
      .at(-1);
    expect(stamped?.headers["x-csrf-token"]).toBe(`csrf.${l.sessionId}`);
    expect(stamped?.headers["x-atlas-session"]).toBeUndefined();
    // A second page obtains ITS OWN token from a leased identity read (never from another page).
    const n = f.addPage();
    await f.boot(n);
    await f.runWith(ordinaryGet(n, l.account, l.epoch));
    const identityRead = f.server.requests
      .filter(
        (r) => r.path.endsWith("/browser-sessions/current") && r.page === n.id,
      )
      .at(0);
    expect(identityRead?.headers["x-atlas-session"]).toBe("1");
    expect(identityRead?.headers["x-csrf-token"]).toBeUndefined();
    expect(
      f.server.requests.filter((r) => r.path.endsWith("/probe")).at(-1)
        ?.headers["x-csrf-token"],
    ).toBe(`csrf.${l.sessionId}`);
  });

  test("the token is tagged (account, epoch): after a re-authentication the old token is never sent", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    await f.runWith(ordinaryGet(l.page, l.account, l.epoch));
    expect(await f.signIn(l.page, "kieran", "pw")).toMatchObject({
      kind: "settled",
      epoch: 2,
    });
    await f.settle();
    expect(
      l.page.kernel.memory.csrf.has(l.page.kernel.memory.csrfKey(l.account, 1)),
    ).toBe(true); // still tagged epoch 1
    const before = f.server.requests.length;
    await f.runWith(ordinaryGet(l.page, l.account, 2));
    const sent = f.server.requests
      .slice(before)
      .filter((r) => r.path.endsWith("/probe"));
    const newSession = stateOf(f).settled?.session_id;
    expect(sent[0]?.headers["x-csrf-token"]).toBe(`csrf.${newSession}`);
  });

  test("an identity read naming ANOTHER account never refreshes a token", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const key = l.page.kernel.memory.csrfKey(l.account, l.epoch);
    const before = l.page.kernel.memory.csrf.get(key);
    const sam = [...f.server.accounts.values()].find(
      (a) => a.username === "sam",
    );
    if (!sam) throw new Error("no sam");
    f.server.adoptCookie(f.server.createSession(sam.id, "dev"));
    await f.world.advance(40_000);
    l.page.hide();
    l.page.show(); // a lift is an exposure; the resume verification then runs one leased current()
    await f.world.runUntilIdle();
    expect(l.page.kernel.memory.csrf.get(key)).toBe(before);
    expect(fencesOf(f, l.account)).toEqual(["drift"]);
  });

  test("a request stamped with an epoch that is no longer settled is STALE: nothing is sent", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    await f.signIn(l.page, "sam", "pw2");
    await f.settle();
    const sent = f.server.requests.length;
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
    ).toBe(0);
    void sent;
  });
});

describe("outcomes of decision D-06", () => {
  test("an ordinary 4xx/5xx other than 401/403 is RETURNED as a response, never an error", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    for (const status of [400, 404, 409, 422, 429, 500, 503]) {
      f.server.addRule({
        match: (r) => r.path.endsWith("/probe"),
        rewrite: {
          status,
          body: { code: "x", message: "m", request_id: "r", details: [] },
        },
        times: 1,
      });
      const response = await f.runWith(ordinaryGet(l.page, l.account, l.epoch));
      expect(response.status).toBe(status);
    }
    expect(leaseIds(f)).toEqual([]);
    expect(checkQuiescence(f)).toEqual([]);
  });

  test("the 30 s request time-out is a CLEAN outcome: the platform's own error, the lease deleted, nothing recorded", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const held = holdAnswers(f, (r) => r.path.endsWith("/probe"));
    const outcome = ordinaryGet(l.page, l.account, l.epoch).then(
      () => "response",
      (e: Error) => e.name,
    );
    await f.world.runUntilIdle();
    expect(leaseIds(f)).toHaveLength(1);
    await f.world.advance(30_000);
    expect(await outcome).not.toBe("response");
    held.stop();
    await f.world.runUntilIdle();
    expect(leaseIds(f)).toEqual([]);
    expect(fencesOf(f, l.account)).toEqual([]);
    expect(l.page.session.view.get().kind).toBe("displaying");
    expect(checkQuiescence(f)).toEqual([]);
  });

  test("EC-23: a caller that aborts after the cover and before the issue: retired unsent, lease deleted THEN lock released, draft untouched", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    f.world.setKnob("D0", "unbounded", (m) => m.label === "cover:ordinary");
    const controller = new AbortController();
    const outcome = l.page.session.api
      .fetchFor(
        "ordinary",
        l.account,
        l.epoch,
      )(new Request(url("/probe"), { signal: controller.signal }))
      .then(
        () => "sent",
        (e: { kind?: string; name?: string }) => e.kind ?? e.name,
      );
    await f.world.runUntilIdle();
    controller.abort();
    f.world.release("D0");
    await f.world.runUntilIdle();
    expect(await outcome).toBe("not_sent");
    expect(f.server.requests.some((r) => r.path.endsWith("/probe"))).toBe(
      false,
    );
    expect(leaseIds(f)).toEqual([]);
    expect(
      f.locks
        .allHeldNames()
        .filter(
          (h) =>
            h.name.startsWith("atlas-issue") ||
            h.name.startsWith("atlas-lease"),
        ),
    ).toEqual([]);
    expect(checkProperties(f)).toEqual([]);
  });

  test("EC-24: fetch throws synchronously: the issue lock is released in the same step, a clean network failure, the lease deleted", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    f.faults.throwSync = 1;
    const outcome = await f.runWith(
      ordinaryGet(l.page, l.account, l.epoch).then(
        () => "sent",
        (e: Error) => e.message,
      ),
    );
    expect(outcome).toBe("fetch threw synchronously");
    expect(leaseIds(f)).toEqual([]);
    expect(
      f.locks.allHeldNames().filter((h) => h.name.startsWith("atlas-")),
    ).toEqual([]);
    expect(
      await f.runWith(ordinaryGet(l.page, l.account, l.epoch)),
    ).toBeInstanceOf(Response);
  });

  test("every kind of StampedRequestError is a closed set", () => {
    const kinds = [
      "not_sent",
      "stale",
      "closed",
      "closed_unresolved",
      "not_covered",
      "auth_state",
    ] as const;
    for (const kind of kinds)
      expect(new StampedRequestError(kind).kind).toBe(kind);
  });
});

describe("the typed client", () => {
  test("session.api.client() sends through the stamped wrapper (a lease per call) and returns typed data", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const client = l.page.session.api.client("ordinary", l.account, l.epoch);
    const before = f.world.logs.filter(
      (e) => e.type === "trace.request.issued",
    ).length;
    const { data, response } = await f.runWith(client.GET("/sessions"));
    expect(response.status).toBe(200);
    expect(data?.sessions.some((s) => s.current)).toBe(true);
    expect(
      f.world.logs.filter((e) => e.type === "trace.request.issued").length,
    ).toBeGreaterThan(before);
    expect(leaseIds(f)).toEqual([]);
  });

  test("a client for a stale stamp rejects with StampedRequestError instead of returning data", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    f.server.revoke(l.sessionId);
    const client = l.page.session.api.client("ordinary", l.account, l.epoch);
    await expect(f.runWith(client.GET("/sessions"))).rejects.toMatchObject({
      kind: "auth_state",
    });
    await f.world.runUntilIdle();
    expect(fencesOf(f, l.account)).toEqual(["invalid_session"]);
  });
});
