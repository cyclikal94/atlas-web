// @vitest-environment node
import { describe, expect, test } from "vitest";
import { checkProperties } from "../support/session/properties";
import {
  holdAnswers,
  leaseIds,
  newWorld,
  signedInPage,
} from "../support/session/scenarios";

/**
 * F-AD-* (WEB-10c revision 11, review R36; design assessment C1/Q2): `SendOptions.admits` on the typed client (`session.api.client(…,
 * { admits })`), through the real kernel send path over the fake world. The permission is asked at every top guard and in the boundary's
 * synchronous step: false before the request is issued, wherever it was waiting (the token, the lease lock, the cover transaction, the
 * issue lock), and it is never sent (`not_sent`, nothing left behind); false after the issue aborts nothing. Fixture evidence against
 * the stand-in, not integration.
 */
const PATH = /\/sessions$/;

async function setup() {
  const f = await newWorld();
  const l = await signedInPage(f);
  const sent = () =>
    f.server.requests.filter((r) => r.method === "GET" && PATH.test(r.path))
      .length;
  const issued = () =>
    f.world.logs.filter((e) => e.type === "trace.request.issued").length;
  const get = (admits?: () => boolean) =>
    l.page.session.api
      .client(
        "ordinary",
        l.account,
        l.epoch,
        admits === undefined ? undefined : { admits },
      )
      .GET("/sessions")
      .then(
        ({ response }) => ({
          kind: "answered" as const,
          status: response.status,
        }),
        (error: { kind?: string }) => ({
          kind: "rejected" as const,
          error: error.kind ?? String(error),
        }),
      );
  return { f, l, sent, issued, get };
}

describe("F-AD-1: a permission that is false before the issue sends nothing", () => {
  test("false from the start: `not_sent`, no request and no lease", async () => {
    const { f, sent, get } = await setup();
    const outcome = await f.runWith(get(() => false));
    expect(outcome).toEqual({ kind: "rejected", error: "not_sent" });
    await f.world.runUntilIdle();
    expect(sent()).toBe(0);
    expect(leaseIds(f)).toEqual([]);
    expect(checkProperties(f)).toEqual([]);
  });

  test("turned false after every step of the admission before the issue, it is never sent; at or after the issue it is answered", async () => {
    // A sweep over the world's schedule, as F-WD-1's: for each k a fresh world delivers k events after the call, then the permission
    // ends. Until `request.issued` is logged the outcome must be `not_sent` with nothing on the wire; once it is, nothing is aborted.
    let beforeIssue = 0;
    let asked = 0;
    for (let k = 0; k < 400; k += 1) {
      const { f, sent, issued, get } = await setup();
      const issuedBefore = issued();
      let allowed = true;
      let outcome: Awaited<ReturnType<typeof get>> | "pending" = "pending";
      void get(() => {
        asked += 1;
        return allowed;
      }).then((value) => {
        outcome = value;
      });
      await f.world.settle();
      for (let step = 0; step < k; step += 1)
        if (!(await f.world.step())) break;
      const wasIssued = issued() > issuedBefore;
      allowed = false;
      await f.world.runUntilIdle();
      expect(outcome).not.toBe("pending");
      if (!wasIssued) {
        beforeIssue += 1;
        expect(outcome, `k=${k}`).toEqual({
          kind: "rejected",
          error: "not_sent",
        });
        expect(sent(), `k=${k}`).toBe(0);
        expect(issued(), `k=${k}`).toBe(issuedBefore);
        expect(leaseIds(f), `k=${k}`).toEqual([]);
        expect(checkProperties(f), `k=${k}`).toEqual([]);
        continue;
      }
      expect(sent(), `k=${k}`).toBe(1);
      expect(outcome, `k=${k}`).toEqual({ kind: "answered", status: 200 });
      break;
    }
    // The admission takes several deliveries (the lease lock, the cover transaction, the issue lock): more than one point is swept.
    expect(beforeIssue).toBeGreaterThan(1);
    expect(asked).toBeGreaterThan(0);
  });

  test("it is asked in the step that issues: the last answer it gave before the issue is the one the boundary used", async () => {
    const { f, sent, issued, get } = await setup();
    const before = issued();
    // Every answer is recorded with whether the request had been issued at that moment.
    const answers: boolean[] = [];
    const outcome = await f.runWith(
      get(() => {
        answers.push(issued() > before);
        return true;
      }),
    );
    expect(outcome).toEqual({ kind: "answered", status: 200 });
    expect(sent()).toBe(1);
    // Asked at least once at the top guard and once at the boundary, and never after the issue.
    expect(answers.length).toBeGreaterThan(1);
    expect(answers.every((was) => was === false)).toBe(true);
  });

  test("control: always true, the same call is sent once and answered; and with no permission at all", async () => {
    const a = await setup();
    expect(await a.f.runWith(a.get(() => true))).toEqual({
      kind: "answered",
      status: 200,
    });
    expect(a.sent()).toBe(1);
    expect(checkProperties(a.f)).toEqual([]);
    const b = await setup();
    expect(await b.f.runWith(b.get())).toEqual({
      kind: "answered",
      status: 200,
    });
    expect(b.sent()).toBe(1);
  });
});

describe("F-AD-2: a permission that ends after the issue aborts nothing", () => {
  test("false while its answer is held: the answer is still returned", async () => {
    const { f, sent, get } = await setup();
    const hold = holdAnswers(f, (r) => r.method === "GET" && PATH.test(r.path));
    let allowed = true;
    let outcome: Awaited<ReturnType<typeof get>> | "pending" = "pending";
    void get(() => allowed).then((value) => {
      outcome = value;
    });
    await f.world.runUntilIdle();
    expect(sent()).toBe(1);
    expect(outcome).toBe("pending");
    allowed = false;
    await f.world.runUntilIdle();
    expect(outcome).toBe("pending");
    hold.release();
    hold.stop();
    await f.world.runUntilIdle();
    expect(outcome).toEqual({ kind: "answered", status: 200 });
    expect(sent()).toBe(1);
    expect(leaseIds(f)).toEqual([]);
    expect(checkProperties(f)).toEqual([]);
  });
});
