// @vitest-environment node
import { describe, expect, test } from "vitest";
import type { Fixture } from "../support/session/harness";
import { checkProperties } from "../support/session/properties";
import {
  fencesOf,
  leaseIds,
  newWorld,
  ordinaryGet,
  signedInPage,
  stateOf,
} from "../support/session/scenarios";

/**
 * F-SUR-* (check 2): for `401`, `403` (body slow, unreadable, non-Atlas), the 2xx of `POST /password`, and EVERY
 * answer to an identity read, the lease lock's release is CALLED before the first `await`, body read or storage call
 * that follows the answer (the handler's first synchronous step). An ordinary `403 forbidden` and a same-account
 * `200` delete their lease and post `auth_state_changed`; a clean answer never surrenders.
 */
function surrenderOrder(f: Fixture, page: string, from: number) {
  const logs = f.world.logs.slice(from).filter((entry) => entry.page === page);
  const answered = logs.findIndex((entry) => entry.type === "fetch.answered");
  expect(answered).toBeGreaterThanOrEqual(0);
  const afterAnswer = logs.slice(answered + 1);
  const surrender = afterAnswer.findIndex(
    (entry) => entry.type === "trace.surrender",
  );
  expect(surrender).toBeGreaterThanOrEqual(0);
  const released = afterAnswer.findIndex(
    (entry) =>
      entry.type === "lock.release_called" &&
      String(entry.name).startsWith("atlas-lease-"),
  );
  expect(released).toBeGreaterThanOrEqual(0);
  // Nothing that can fail or wait precedes the release: no body read, no storage call, no lock request, no fetch.
  const before = afterAnswer.slice(0, released);
  const offending = before.filter((entry) =>
    ["spy.body", "store.create", "lock.request", "fetch.sent"].includes(
      entry.type,
    ),
  );
  return { offending, released, surrender };
}

async function answerOnce(f: Fixture, run: () => Promise<unknown>) {
  const start = f.world.logs.length;
  f.world.spyBodies = true;
  const settled = run().then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({
      ok: false as const,
      error: error as { kind?: string },
    }),
  );
  await f.world.runUntilIdle();
  return { start, result: await settled };
}

describe("surrender first (check 2)", () => {
  test("a 401 surrenders before any await, body read or storage call, then records lock-free", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    f.server.revoke(l.sessionId);
    const { start, result } = await answerOnce(f, () =>
      ordinaryGet(l.page, l.account, l.epoch),
    );
    expect(result).toMatchObject({ ok: false, error: { kind: "auth_state" } });
    const { offending } = surrenderOrder(f, l.page.id, start);
    expect(offending).toEqual([]);
    expect(fencesOf(f, l.account)).toEqual(["invalid_session"]);
  });

  test.each([
    ["credential_mismatch (Atlas body)", "atlas-mismatch"],
    ["a body that is not an Atlas error (HTML)", "html"],
    ["a body that cannot be read (malformed JSON)", "garbage"],
  ] as const)(
    "a 403 with %s surrenders on the status alone, classifies afterwards and fails closed",
    async (_name, kind) => {
      const f = await newWorld();
      const l = await signedInPage(f);
      const body =
        kind === "atlas-mismatch"
          ? {
              status: 403,
              body: {
                code: "credential_mismatch",
                message: "m",
                request_id: "r",
                details: [],
              },
            }
          : kind === "html"
            ? {
                status: 403,
                body: "<html>denied</html>",
                contentType: "text/html",
              }
            : {
                status: 403,
                body: "{not json",
                contentType: "application/json",
              };
      f.server.addRule({
        match: (r) => r.path.endsWith("/probe"),
        rewrite: body,
        times: 1,
      });
      const { start, result } = await answerOnce(f, () =>
        ordinaryGet(l.page, l.account, l.epoch),
      );
      expect(result).toMatchObject({
        ok: false,
        error: { kind: "auth_state" },
      });
      expect(surrenderOrder(f, l.page.id, start).offending).toEqual([]);
      // It fails closed: a credential_unverified fence was recorded (lock-free, deleting this request's lease)...
      const recorded = f.world.logs
        .slice(start)
        .find(
          (e) =>
            e.type === "store.commit" &&
            e.label === "record" &&
            e.wrote === true,
        );
      expect(recorded).toBeDefined();
      // ...and one leased current() read then settled it: the session is the settled one, so the fence cleared (O11).
      const verified = f.world.logs
        .slice(start)
        .find((e) => e.type === "trace.verify.outcome");
      expect(verified).toMatchObject({ kind: "RETIRED", cleared: 1 });
      expect(fencesOf(f, l.account)).toEqual([]);
      expect(leaseIds(f)).toEqual([]);
      expect(l.page.session.view.get().kind).toBe("displaying");
    },
  );

  test("an ordinary 403 (forbidden) is NOT an observation: it deletes its lease, posts auth_state_changed on complete, clears the hold, and the page reopens", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    f.server.addRule({
      match: (r) => r.path.endsWith("/probe"),
      rewrite: {
        status: 403,
        body: { code: "forbidden", message: "m", request_id: "r", details: [] },
      },
      times: 1,
    });
    const start = f.world.logs.length;
    const { result } = await answerOnce(f, () =>
      ordinaryGet(l.page, l.account, l.epoch),
    );
    expect(result).toMatchObject({ ok: true });
    expect(surrenderOrder(f, l.page.id, start).offending).toEqual([]);
    expect(fencesOf(f, l.account)).toEqual([]);
    expect(leaseIds(f)).toEqual([]);
    expect(
      f.world.logs
        .slice(start)
        .some(
          (e) =>
            e.type === "hint.post" &&
            (e.hint as { type: string }).type === "auth_state_changed",
        ),
    ).toBe(true);
    await f.world.runUntilIdle();
    expect(l.page.session.view.get().kind).toBe("displaying"); // the brief false close is undone
    expect(checkProperties(f)).toEqual([]);
  });

  test("the 2xx of a self-revoking request (POST /password) surrenders, and the confirmed change raises the row-5 fence", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const { start, result } = await answerOnce(f, () =>
      l.page.session.operations.changePassword({ current: "pw", next: "new" }),
    );
    expect(result).toMatchObject({
      ok: true,
      value: { ok: true, value: "changed" },
    });
    expect(surrenderOrder(f, l.page.id, start).offending).toEqual([]);
    expect(stateOf(f).fences[l.account]?.[0]).toMatchObject({
      kind: "invalid_session",
      reason: "password_changed",
    });
    expect(leaseIds(f)).toEqual([]);
    expect(l.page.session.view.get()).toMatchObject({
      kind: "neutral",
      state: "1b",
    });
  });

  test("OIDC unlink records reason `unlinked`", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    f.server.accounts.get(l.account)?.oidcIssuers.push(f.server.oidcIssuer);
    await answerOnce(f, () =>
      l.page.session.operations.unlinkOidc(f.server.oidcIssuer),
    );
    expect(stateOf(f).fences[l.account]?.[0]).toMatchObject({
      reason: "unlinked",
    });
  });

  test("a wrong current password answers 401 and fails closed exactly as the matrix discloses (F-15)", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const { result } = await answerOnce(f, () =>
      l.page.session.operations.changePassword({
        current: "WRONG",
        next: "new",
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      value: { ok: false, error: "auth_state" },
    });
    expect(fencesOf(f, l.account)).toEqual(["invalid_session"]);
  });

  test.each([
    [
      "401",
      {
        status: 401,
        body: {
          code: "unauthenticated",
          message: "m",
          request_id: "r",
          details: [],
        },
      },
      ["invalid_session"],
    ],
    ["200 for the same account", undefined, []],
    ["a 5xx", { status: 503, body: "x", contentType: "text/plain" }, []],
    ["a 403", { status: 403, body: "x", contentType: "text/plain" }, []],
  ] as const)(
    "EVERY answer to an identity read surrenders first: %s",
    async (_name, rewrite, fences) => {
      const f = await newWorld();
      const l = await signedInPage(f);
      if (rewrite)
        f.server.addRule({
          match: (r) => r.path.endsWith("/browser-sessions/current"),
          rewrite,
          times: 1,
        });
      // The stamped ordinary request needs this page's token; a fresh page obtains it from a leased identity read.
      const other = f.addPage();
      await f.boot(other);
      f.world.logs.length; // keep the log
      const start = f.world.logs.length;
      f.world.spyBodies = true;
      // Force a resume verification on the displaying page.
      await f.world.advance(40_000);
      l.page.session.actions.retry();
      other.session.actions.retry();
      await f.world.runUntilIdle();
      const surrenders = f.world.logs
        .slice(start)
        .filter((e) => e.type === "trace.surrender" && e.identityRead === true);
      if (rewrite || surrenders.length > 0) {
        for (const s of surrenders) {
          const seq = s.seq;
          const page = s.page as string;
          const prior = f.world.logs
            .slice(0, seq)
            .filter((e) => e.page === page);
          const answered = prior
            .map((e) => e.type)
            .lastIndexOf("fetch.answered");
          const between = prior
            .slice(answered + 1)
            .filter((e) =>
              ["spy.body", "store.create", "lock.request"].includes(e.type),
            );
          expect(between).toEqual([]);
        }
      }
      expect(fencesOf(f, l.account).sort()).toEqual([...fences].sort());
    },
  );

  test("a clean answer never surrenders", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const start = f.world.logs.length;
    await answerOnce(f, () => ordinaryGet(l.page, l.account, l.epoch));
    expect(
      f.world.logs
        .slice(start)
        .some((e) => e.type === "trace.surrender" && e.klass === "ordinary"),
    ).toBe(false);
    expect(leaseIds(f)).toEqual([]);
  });
});
