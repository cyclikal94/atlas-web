// @vitest-environment node
import { describe, expect, test } from "vitest";
import type { StampedRequestError } from "../../src/session/kernel/types";
import type { FakePage } from "../support/session/harness";
import { checkProperties } from "../support/session/properties";
import {
  fencesOf,
  holdAnswers,
  leaseIds,
  newWorld,
  openPage,
  ordinaryGet,
  signedInPage,
  stateOf,
} from "../support/session/scenarios";

/**
 * F-STALE-*: a response that arrives after the identity it was sent under has been replaced is DROPPED (G4; matrix 3.7.2:
 * "a response arriving after a transition is dropped"). Until now only the admission of a request was checked; a clean
 * answer delivered after the transition reached the caller, who would apply account A's data under account B. The check is
 * made where the answer is handed to its caller, after the last asynchronous step it needs (decoding the body); the
 * surrender, hold and lease-retirement ordering of the handler is unchanged and runs before it.
 */
const errorOf = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => error as StampedRequestError,
  );

const typedGet = (l: { page: FakePage; account: string; epoch: number }) =>
  errorOf(
    l.page.session.api
      .client("ordinary", l.account, l.epoch)
      .GET("/sessions")
      .then((result) => {
        throw Object.assign(new Error("returned"), { result });
      }),
  );

/** What a call has produced so far, without waiting for it. */
const watch = <T>(call: Promise<T>) => {
  const seen: {
    state: "pending" | "returned" | "rejected";
    value?: T;
    error?: StampedRequestError;
  } = { state: "pending" };
  call.then(
    (value) => {
      seen.state = "returned";
      seen.value = value;
    },
    (error: unknown) => {
      seen.state = "rejected";
      seen.error = error as StampedRequestError;
    },
  );
  return seen;
};

/**
 * The position in the world's log of the commit of the transaction `label` made by `page` (the order the store ran them in):
 * the first such commit, or the last (a public call makes two `response_check` transactions: the Response's release, then the
 * result's final check, and it is the last that releases the result).
 */
const commitSeq = (
  f: Awaited<ReturnType<typeof newWorld>>,
  label: string,
  page: string,
  which: "first" | "last" = "first",
): number => {
  const entries = f.world.logs.filter(
    (log) =>
      log.type === "store.commit" && log.label === label && log.page === page,
  );
  const entry = which === "first" ? entries[0] : entries.at(-1);
  if (!entry) throw new Error(`no commit of ${label} by ${page}`);
  return entry.seq;
};

const rule401 = {
  status: 401,
  body: {
    code: "unauthenticated",
    message: "unauthenticated",
    request_id: "req-fixture",
    details: [],
  },
};

describe("a clean answer delivered after a transition", () => {
  test("the typed client rejects with `stale` instead of returning account A's payload after a same-page sign-in as B", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const held = holdAnswers(f, (r) => r.path.endsWith("/sessions"));
    const pending = errorOf(
      l.page.session.api
        .client("ordinary", l.account, l.epoch)
        .GET("/sessions")
        .then((result) => {
          throw Object.assign(new Error("returned"), { result });
        }),
    );
    await f.world.runUntilIdle();
    expect((await f.signIn(l.page, "sam", "pw2")).kind).toBe("settled");
    await f.settle();
    expect(stateOf(f).settled?.account_id).not.toBe(l.account);
    held.stop();
    held.release();
    await f.world.runUntilIdle();
    const error = await pending;
    expect(error?.name).toBe("StampedRequestError");
    expect(error?.kind).toBe("stale");
    // The surrender/lease ordering still ran: nothing is left behind, and the new account displays.
    expect(leaseIds(f)).toEqual([]);
    expect(l.page.session.view.get().kind).toBe("displaying");
    expect(checkProperties(f)).toEqual([]);
  });

  test("a change this page already knows of is refused before the body is decoded: the body of an answer nobody will receive is not read", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const held = holdAnswers(f, (r) => r.path.endsWith("/probe"));
    const pending = errorOf(ordinaryGet(l.page, l.account, l.epoch));
    await f.world.runUntilIdle();
    expect((await f.signIn(l.page, "sam", "pw2")).kind).toBe("settled");
    await f.settle();
    f.world.spyBodies = true;
    held.stop();
    held.release();
    await f.world.runUntilIdle();
    expect((await pending)?.kind).toBe("stale");
    expect(
      f.world.logs.filter(
        (log) => log.type === "spy.body" && log.page === l.page.id,
      ),
    ).toEqual([]);
    expect(leaseIds(f)).toEqual([]);
  });

  test("the same when ANOTHER page completes the transition and this page learns of it by the hint", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const other = await openPage(f);
    const held = holdAnswers(
      f,
      (r) => r.path.endsWith("/probe") && r.page === l.page.id,
    );
    const pending = errorOf(ordinaryGet(l.page, l.account, l.epoch));
    await f.world.runUntilIdle();
    expect((await f.signIn(other, "sam", "pw2")).kind).toBe("settled");
    await f.settle();
    expect(l.page.kernel.memory.settled?.account).not.toBe(l.account);
    held.stop();
    held.release();
    await f.world.runUntilIdle();
    expect((await pending)?.kind).toBe("stale");
    expect(leaseIds(f)).toEqual([]);
    expect(checkProperties(f)).toEqual([]);
  });

  test("the same after the person SIGNS OUT: nothing is settled, so the answer is for nobody", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const held = holdAnswers(f, (r) => r.path.endsWith("/probe"));
    const pending = errorOf(ordinaryGet(l.page, l.account, l.epoch));
    await f.world.runUntilIdle();
    await f.runWith(
      l.page.session.operations.logout({
        unsynced: { count: 0, items: [], digest: "0" },
      }),
    );
    await f.settle();
    expect(stateOf(f).settled).toBeNull();
    held.stop();
    held.release();
    await f.world.runUntilIdle();
    expect((await pending)?.kind).toBe("stale");
  });

  test("an ordinary answer with NO transition is returned whole, decoded and typed (the control)", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const held = holdAnswers(f, (r) => r.path.endsWith("/sessions"));
    const pending = l.page.session.api
      .client("ordinary", l.account, l.epoch)
      .GET("/sessions");
    await f.world.runUntilIdle();
    held.stop();
    held.release();
    const { data, response } = await f.runWith(pending);
    expect(response.status).toBe(200);
    expect(data?.sessions.some((s) => s.current)).toBe(true);
    expect(leaseIds(f)).toEqual([]);
  });

  test("an invalidating answer that is stale is reported as `stale`, never as authentication state for the new account", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const stop = f.server.addRule({
      match: (r) => r.path.endsWith("/probe"),
      delay: "unbounded",
      rewrite: rule401,
    });
    const pending = errorOf(ordinaryGet(l.page, l.account, l.epoch));
    await f.world.runUntilIdle();
    expect((await f.signIn(l.page, "sam", "pw2")).kind).toBe("settled");
    await f.settle();
    const sam = stateOf(f).settled?.account_id as string;
    stop();
    f.world.release("Da");
    await f.world.runUntilIdle();
    expect((await pending)?.kind).toBe("stale");
    // The recording transaction found the stamp stale too: nothing is fenced for either account.
    expect(fencesOf(f, sam)).toEqual([]);
    expect(fencesOf(f, l.account)).toEqual([]);
    expect(l.page.session.view.get().kind).toBe("displaying");
    expect(checkProperties(f)).toEqual([]);
  });
});

describe("what the caller receives is the response, whole", () => {
  test("a 204 (no body) and an error status are returned with their status and headers, and the body is readable once", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    // A second sign-in of the same account: its session can be revoked with an ordinary `DELETE /sessions/{id}` (204).
    const other = f.server.createSession(l.account, "another-device");
    const client = l.page.session.api.client("ordinary", l.account, l.epoch);
    const removed = await f.runWith(
      client.DELETE("/sessions/{id}", {
        params: { path: { id: other.id } },
      }),
    );
    expect(removed.response.status).toBe(204);
    expect(await removed.response.text()).toBe("");
    // Not found: an ordinary 4xx is returned as a response, never thrown, and its typed error body is intact.
    const missing = await f.runWith(
      client.DELETE("/sessions/{id}", {
        params: { path: { id: "no-such-session" } },
      }),
    );
    expect(missing.response.status).toBe(404);
    expect(missing.error).toMatchObject({ code: "not_found" });
    expect(leaseIds(f)).toEqual([]);
  });
});

describe("a transition while the answer's body is being decoded", () => {
  async function decoding() {
    const f = await newWorld();
    const l = await signedInPage(f);
    // The headers arrive at once; the body is held (a large or slow payload).
    const stop = f.server.addRule({
      match: (r) => r.path.endsWith("/probe"),
      bodyDelay: "unbounded",
    });
    const pending = errorOf(
      ordinaryGet(l.page, l.account, l.epoch).then(async (response) => {
        // Only reached when the wrapper returned a response: decode it the way a caller would.
        throw Object.assign(new Error("returned"), {
          status: response.status,
          body: await response.text(),
        });
      }),
    );
    await f.world.runUntilIdle();
    expect(f.world.heldCount("Db")).toBe(1);
    return { f, l, stop, pending };
  }

  test("the transition completes during decoding: the decoded payload is dropped as stale", async () => {
    const { f, l, stop, pending } = await decoding();
    expect((await f.signIn(l.page, "sam", "pw2")).kind).toBe("settled");
    await f.settle();
    stop();
    f.world.release("Db");
    await f.world.runUntilIdle();
    expect((await pending)?.kind).toBe("stale");
    expect(leaseIds(f)).toEqual([]);
    expect(checkProperties(f)).toEqual([]);
  });

  test("no transition: the payload is delivered once decoding ends (the control)", async () => {
    const { f, stop, pending } = await decoding();
    stop();
    f.world.release("Db");
    await f.world.runUntilIdle();
    const outcome = (await pending) as unknown as {
      message: string;
      status: number;
    };
    expect(outcome.message).toBe("returned");
    expect(outcome.status).toBe(200);
  });
});

describe("the recovery class", () => {
  async function recovering() {
    const f = await newWorld();
    const l = await signedInPage(f);
    f.server.revoke(l.sessionId);
    await f.runWith(ordinaryGet(l.page, l.account, l.epoch).catch(() => null));
    await f.world.runUntilIdle();
    expect((await f.signIn(l.page, "kieran", "pw")).kind).toBe("settled");
    await f.settle();
    expect(stateOf(f).settled?.epoch).toBe(2);
    return { f, l };
  }
  const recoveryGet = (page: FakePage, account: string, epoch: number) =>
    page.session.api.fetchFor(
      "recovery",
      account,
      epoch,
    )(new Request(new URL("/api/experimental/v1/sync", "http://localhost")));

  test("a recovery answer for epoch 2 that arrives after a re-authentication (epoch 3) is dropped", async () => {
    const { f, l } = await recovering();
    const held = holdAnswers(f, (r) => r.path.endsWith("/sync"));
    const pending = errorOf(recoveryGet(l.page, l.account, 2));
    await f.world.runUntilIdle();
    expect(
      f.server.requests.filter((r) => r.path.endsWith("/sync")).length,
    ).toBe(1);
    expect((await f.signIn(l.page, "kieran", "pw")).kind).toBe("settled");
    await f.settle();
    expect(stateOf(f).settled?.epoch).toBe(3);
    held.stop();
    held.release();
    await f.world.runUntilIdle();
    expect((await pending)?.kind).toBe("stale");
    expect(leaseIds(f)).toEqual([]);
  });

  test("a recovery answer with no transition is returned (the control)", async () => {
    const { f, l } = await recovering();
    const response = await f.runWith(recoveryGet(l.page, l.account, 2));
    expect(response).toBeInstanceOf(Response);
  });
});

/**
 * The record, not the notice of it, decides. A page's copy of the settled identity is a hint that another page's transition
 * has to reach (by a broadcast and a read); until it does, the page still believes the old identity. The answer is released
 * against the record itself, so a transition completed by ANOTHER page is honoured whether its notice is delayed, queued
 * behind the page's own read, or never arrives.
 */
describe("a transition completed by another page, whatever happens to the notice of it", () => {
  const heldFor = (f: Awaited<ReturnType<typeof newWorld>>, page: FakePage) =>
    f.world.heldCount("D2", (meta) => meta.page === page.id);

  async function requestHeldThenAnotherPageSettles(
    hints: "delayed" | "absent" | "delivered",
  ) {
    const f = await newWorld();
    const l = await signedInPage(f);
    const other = await openPage(f);
    const held = holdAnswers(
      f,
      (r) => r.path.endsWith("/sessions") && r.page === l.page.id,
    );
    const pending = typedGet(l);
    await f.world.runUntilIdle();
    if (hints !== "delivered")
      f.world.setKnob("D2", "unbounded", (meta) => meta.page === l.page.id);
    expect((await f.signIn(other, "sam", "pw2")).kind).toBe("settled");
    await f.settle();
    if (hints === "absent")
      f.world.dropHeld("D2", (meta) => meta.page === l.page.id);
    const sam = stateOf(f).settled?.account_id as string;
    expect(sam).not.toBe(l.account);
    return { f, l, other, held, pending, sam };
  }

  test("the notice is DELAYED: the typed client rejects with `stale`, and the page catches up from the check itself", async () => {
    const { f, l, held, pending, sam } =
      await requestHeldThenAnotherPageSettles("delayed");
    // The page has not been told: its copy still names account A, exactly as in the review's reproduction.
    expect(l.page.kernel.memory.settled?.account).toBe(l.account);
    expect(heldFor(f, l.page)).toBeGreaterThan(0);
    held.stop();
    held.release();
    await f.world.runUntilIdle();
    const error = await pending;
    expect(error?.name).toBe("StampedRequestError");
    expect(error?.kind).toBe("stale");
    expect(leaseIds(f)).toEqual([]);
    // The notice is STILL held, and the page nevertheless re-read the record when the check found it moved on.
    expect(heldFor(f, l.page)).toBeGreaterThan(0);
    expect(l.page.kernel.memory.settled?.account).toBe(sam);
    expect(l.page.session.identity.get()?.account_id).toBe(sam);
    expect(checkProperties(f)).toEqual([]);
  });

  test("the notice NEVER arrives (the channel dropped it): stale", async () => {
    const { f, l, held, pending } =
      await requestHeldThenAnotherPageSettles("absent");
    expect(heldFor(f, l.page)).toBe(0);
    held.stop();
    held.release();
    await f.world.runUntilIdle();
    expect((await pending)?.kind).toBe("stale");
    expect(leaseIds(f)).toEqual([]);
    expect(checkProperties(f)).toEqual([]);
  });

  test("the notice arrives but the page's own read of the record is delayed: stale", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const other = await openPage(f);
    const held = holdAnswers(
      f,
      (r) => r.path.endsWith("/sessions") && r.page === l.page.id,
    );
    const pending = typedGet(l);
    await f.world.runUntilIdle();
    // The hint is delivered at once and starts the page's re-evaluation; the completion of ITS read is held.
    f.world.setKnob(
      "D0",
      "unbounded",
      (meta) => meta.page === l.page.id && meta.label === "read",
    );
    expect((await f.signIn(other, "sam", "pw2")).kind).toBe("settled");
    await f.settle();
    expect(
      f.world.heldCount(
        "D0",
        (meta) => meta.page === l.page.id && meta.label === "read",
      ),
    ).toBeGreaterThan(0);
    expect(l.page.kernel.memory.settled?.account).toBe(l.account);
    held.stop();
    held.release();
    await f.world.runUntilIdle();
    expect((await pending)?.kind).toBe("stale");
    expect(leaseIds(f)).toEqual([]);
    f.world.clearKnobs();
    f.world.release("D0");
    await f.world.runUntilIdle();
    expect(checkProperties(f)).toEqual([]);
  });

  test("the transition completes during BODY DECODING and the notice is delayed: the decoded payload is dropped", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const other = await openPage(f);
    const stop = f.server.addRule({
      match: (r) => r.path.endsWith("/probe") && r.page === l.page.id,
      bodyDelay: "unbounded",
    });
    const pending = errorOf(
      ordinaryGet(l.page, l.account, l.epoch).then(async (response) => {
        throw Object.assign(new Error("returned"), {
          status: response.status,
          body: await response.text(),
        });
      }),
    );
    await f.world.runUntilIdle();
    expect(f.world.heldCount("Db")).toBe(1);
    f.world.setKnob("D2", "unbounded", (meta) => meta.page === l.page.id);
    expect((await f.signIn(other, "sam", "pw2")).kind).toBe("settled");
    await f.settle();
    expect(l.page.kernel.memory.settled?.account).toBe(l.account);
    stop();
    f.world.release("Db");
    await f.world.runUntilIdle();
    expect((await pending)?.kind).toBe("stale");
    expect(leaseIds(f)).toEqual([]);
    expect(checkProperties(f)).toEqual([]);
  });

  test("an invalidating 401 that is stale by another page's transition (notice delayed) fences neither account and never signs the new account out", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const other = await openPage(f);
    const stop = f.server.addRule({
      match: (r) => r.path.endsWith("/probe") && r.page === l.page.id,
      delay: "unbounded",
      rewrite: rule401,
    });
    const pending = errorOf(ordinaryGet(l.page, l.account, l.epoch));
    await f.world.runUntilIdle();
    f.world.setKnob("D2", "unbounded", (meta) => meta.page === l.page.id);
    expect((await f.signIn(other, "sam", "pw2")).kind).toBe("settled");
    await f.settle();
    const sam = stateOf(f).settled?.account_id as string;
    stop();
    f.world.release("Da");
    await f.world.runUntilIdle();
    // An invalidating answer hands back nothing; it is classified by the page's own copy (see `createStampedFetch`), so with
    // the notice still delayed it is reported as authentication state. What matters is what it did NOT do:
    expect((await pending)?.kind).toBe("auth_state");
    expect(fencesOf(f, sam)).toEqual([]);
    expect(fencesOf(f, l.account)).toEqual([]);
    expect(stateOf(f).settled?.account_id).toBe(sam);
    expect(leaseIds(f)).toEqual([]);
    // The recording was discarded as stale, the hold was released, and the page shows the account that IS settled.
    f.world.clearKnobs();
    f.world.release("D2");
    await f.world.runUntilIdle();
    expect(l.page.session.view.get().kind).toBe("displaying");
    expect(l.page.session.identity.get()?.account_id).toBe(sam);
    expect(checkProperties(f)).toEqual([]);
  });

  test("an ordinary call across a re-authentication of the SAME account by another page (epoch 1 to 2)", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const other = await openPage(f);
    const held = holdAnswers(
      f,
      (r) => r.path.endsWith("/probe") && r.page === l.page.id,
    );
    const pending = errorOf(ordinaryGet(l.page, l.account, l.epoch));
    await f.world.runUntilIdle();
    f.world.setKnob("D2", "unbounded", (meta) => meta.page === l.page.id);
    expect((await f.signIn(other, "kieran", "pw")).kind).toBe("settled");
    await f.settle();
    expect(stateOf(f).settled?.epoch).toBe(2);
    expect(l.page.kernel.memory.settled?.epoch).toBe(1);
    held.stop();
    held.release();
    await f.world.runUntilIdle();
    expect((await pending)?.kind).toBe("stale");
    expect(leaseIds(f)).toEqual([]);
    expect(checkProperties(f)).toEqual([]);
  });

  test("the recovery class, across a re-authentication by another page (epoch 2 to 3)", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    f.server.revoke(l.sessionId);
    await f.runWith(ordinaryGet(l.page, l.account, l.epoch).catch(() => null));
    await f.world.runUntilIdle();
    expect((await f.signIn(l.page, "kieran", "pw")).kind).toBe("settled");
    await f.settle();
    expect(stateOf(f).settled?.epoch).toBe(2);
    const other = await openPage(f);
    const held = holdAnswers(
      f,
      (r) => r.path.endsWith("/sync") && r.page === l.page.id,
    );
    const pending = errorOf(
      l.page.session.api.fetchFor(
        "recovery",
        l.account,
        2,
      )(new Request(new URL("/api/experimental/v1/sync", "http://localhost"))),
    );
    await f.world.runUntilIdle();
    f.world.setKnob("D2", "unbounded", (meta) => meta.page === l.page.id);
    expect((await f.signIn(other, "kieran", "pw")).kind).toBe("settled");
    await f.settle();
    expect(stateOf(f).settled?.epoch).toBe(3);
    expect(l.page.kernel.memory.settled?.epoch).toBe(2);
    held.stop();
    held.release();
    await f.world.runUntilIdle();
    expect((await pending)?.kind).toBe("stale");
    expect(leaseIds(f)).toEqual([]);
    expect(checkProperties(f)).toEqual([]);
  });

  test("the check's completion is delayed and the page processes the other page's notice meanwhile: the answer was released in the step that read the record, before the transition", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const other = await openPage(f);
    const held = holdAnswers(
      f,
      (r) => r.path.endsWith("/sessions") && r.page === l.page.id,
    );
    const result = watch(
      l.page.session.api
        .client("ordinary", l.account, l.epoch)
        .GET("/sessions"),
    );
    await f.world.runUntilIdle();
    f.world.setKnob(
      "D0",
      "unbounded",
      (meta) => meta.page === l.page.id && meta.label === "response_check",
    );
    held.stop();
    held.release();
    await f.world.runUntilIdle();
    // The checks have read the record (still A) and their completions are on their way to a busy page: two, the release of
    // the Response to the library and the final check of the decoded result. The answer does not wait for either
    // completion: it was released in the step that read, so the caller already has it, before B exists.
    expect(
      f.world.heldCount(
        "D0",
        (meta) => meta.page === l.page.id && meta.label === "response_check",
      ),
    ).toBe(2);
    expect(result.state).toBe("returned");
    expect((await f.signIn(other, "sam", "pw2")).kind).toBe("settled");
    await f.settle();
    // The notice WAS delivered and processed meanwhile: this page now knows B is settled, and the held completion changes
    // nothing about what the caller was handed before.
    expect(l.page.kernel.memory.settled?.account).not.toBe(l.account);
    f.world.clearKnobs();
    f.world.release("D0");
    await f.world.runUntilIdle();
    expect(result.state).toBe("returned");
    expect(commitSeq(f, "response_check", l.page.id, "last")).toBeLessThan(
      commitSeq(f, "closing:settle", other.id),
    );
    expect(leaseIds(f)).toEqual([]);
    expect(checkProperties(f)).toEqual([]);
  });

  test("controls: an unchanged identity is delivered despite delayed notices, and an answer released BEFORE a transition is not retroactively stale", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const other = await openPage(f);
    f.world.setKnob("D2", "unbounded", (meta) => meta.page === l.page.id);
    const held = holdAnswers(f, (r) => r.path.endsWith("/sessions"));
    const request = l.page.session.api
      .client("ordinary", l.account, l.epoch)
      .GET("/sessions");
    await f.world.runUntilIdle();
    held.stop();
    held.release();
    const response = await f.runWith(request);
    expect(response.data?.sessions.some((s) => s.current)).toBe(true);
    // A transition after the answer was delivered changes nothing about what this call returned.
    expect((await f.signIn(other, "sam", "pw2")).kind).toBe("settled");
    expect(response.response.status).toBe(200);
    expect(leaseIds(f)).toEqual([]);
  });
});

describe("a record that cannot be read when the answer is released is not evidence", () => {
  const released = async (mode: "error" | "pending") => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const stop = f.store.inject({
      match: (tx) => tx.label === "response_check" && tx.page === l.page.id,
      mode,
      times: 1,
    });
    const pending = errorOf(ordinaryGet(l.page, l.account, l.epoch));
    return { f, l, pending, stop };
  };

  test("a failed read: `stale`, the lease is gone, and the next request (whose check succeeds) is answered", async () => {
    const { f, l, pending } = await released("error");
    await f.world.runUntilIdle();
    expect((await pending)?.kind).toBe("stale");
    expect(leaseIds(f)).toEqual([]);
    const again = await f.runWith(ordinaryGet(l.page, l.account, l.epoch));
    expect(again.status).toBe(200);
    expect(checkProperties(f)).toEqual([]);
  });

  test("a read that never completes is abandoned at the stall interval: `stale`", async () => {
    const { f, l, pending } = await released("pending");
    await f.world.advance(l.page.kernel.config.recordingStallMs + 1);
    expect((await pending)?.kind).toBe("stale");
    expect(leaseIds(f)).toEqual([]);
    expect(checkProperties(f)).toEqual([]);
  });
});

/**
 * The record is read, and the answer released, in ONE step (the body of the store transaction that reads it), not at the later
 * delivery of that transaction's completion to a page that may be busy. So a transition is ordered either BEFORE the read (the
 * read sees it: `stale`, whatever the page has been told) or AFTER it (the answer was already released, and the transition is
 * not held up by it). There is no schedule in which the answer is handed back after a transition that the store had committed
 * before it: the two combined delays of the review (the completion and every notice) move nothing.
 */
describe("the verdict is taken where the record is read", () => {
  const recoveryGet = (page: FakePage, account: string, epoch: number) =>
    page.session.api.fetchFor(
      "recovery",
      account,
      epoch,
    )(new Request(new URL("/api/experimental/v1/sync", "http://localhost")));

  type World = Awaited<ReturnType<typeof newWorld>>;
  type Klass = "ordinary" | "recovery";

  /** A page signed in, a second page open, and a request of the given class whose answer is held. */
  async function requestHeld(klass: Klass) {
    const f = await newWorld();
    let l = await signedInPage(f);
    if (klass === "recovery") {
      // Recovery reads are for an account that is closed and has re-authenticated (epoch 2).
      f.server.revoke(l.sessionId);
      await f.runWith(
        ordinaryGet(l.page, l.account, l.epoch).catch(() => null),
      );
      await f.world.runUntilIdle();
      expect((await f.signIn(l.page, "kieran", "pw")).kind).toBe("settled");
      await f.settle();
      l = { ...l, epoch: 2 };
    }
    const other = await openPage(f);
    const held = holdAnswers(
      f,
      (r) =>
        r.path.endsWith(klass === "recovery" ? "/sync" : "/probe") &&
        r.page === l.page.id,
    );
    const call = (): Promise<Response> =>
      klass === "recovery"
        ? recoveryGet(l.page, l.account, l.epoch)
        : ordinaryGet(l.page, l.account, l.epoch);
    const result = watch(call());
    await f.world.runUntilIdle();
    return { f, l, other, held, result };
  }

  const delayCheckAndNotices = (f: World, l: { page: FakePage }) => {
    f.world.setKnob(
      "D0",
      "unbounded",
      (meta) => meta.page === l.page.id && meta.label === "response_check",
    );
    f.world.setKnob("D2", "unbounded", (meta) => meta.page === l.page.id);
  };

  /** The other page's sign-in, run as far as its settling write, which the store is told to hold. */
  async function signInHeldAtSettlement(f: World, other: FakePage) {
    f.world.setKnob(
      "store_start",
      "unbounded",
      (meta) => meta.label === "closing:settle" && meta.txPage === other.id,
    );
    const begun = await f.runWith(other.session.attempts.begin("password"));
    if (begun.kind !== "started") throw new Error("no attempt");
    const signing = other.session.attempts.signInWithPassword(begun.handle, {
      username: "sam",
      password: "pw2",
    });
    await f.world.runUntilIdle();
    expect(f.world.heldCount("store_start")).toBe(1);
    // Wrapped: a bare promise returned from an async function would be awaited here, and it cannot settle until the write runs.
    return { signing };
  }

  describe.each<Klass>(["ordinary", "recovery"])("the %s class", (klass) => {
    test("the completion and the notices are both delayed and the transition is ordered AFTER the read: the answer was released at the read, and the transition is not held up", async () => {
      const { f, l, other, held, result } = await requestHeld(klass);
      delayCheckAndNotices(f, l);
      held.stop();
      held.release();
      await f.world.runUntilIdle();
      expect(
        f.world.heldCount(
          "D0",
          (meta) => meta.page === l.page.id && meta.label === "response_check",
        ),
      ).toBe(1);
      // Released at the read, while the page still holds no notice and no completion.
      expect(result.state).toBe("returned");
      expect((await f.signIn(other, "sam", "pw2")).kind).toBe("settled");
      await f.settle();
      const sam = stateOf(f).settled?.account_id as string;
      expect(sam).not.toBe(l.account);
      expect(l.page.kernel.memory.settled?.account).toBe(l.account);
      expect(commitSeq(f, "response_check", l.page.id)).toBeLessThan(
        commitSeq(f, "closing:settle", other.id),
      );
      // Letting the delayed deliveries through changes nothing about what the caller already holds.
      f.world.clearKnobs();
      f.world.release();
      await f.world.runUntilIdle();
      expect(result.state).toBe("returned");
      expect(l.page.kernel.memory.settled?.account).toBe(sam);
      expect(leaseIds(f)).toEqual([]);
      expect(checkProperties(f)).toEqual([]);
    });

    for (const notices of ["delayed", "never arriving"] as const) {
      test(`the transition is ordered BEFORE the read, the completion is delayed and the notices are ${notices}: \`stale\`, and the page catches up from the read`, async () => {
        const { f, l, other, held, result } = await requestHeld(klass);
        const { signing } = await signInHeldAtSettlement(f, other);
        delayCheckAndNotices(f, l);
        held.stop();
        held.release();
        await f.world.runUntilIdle();
        // The answer is decoded and its check is queued BEHIND the other page's settling write: nothing is released yet.
        expect(result.state).toBe("pending");
        expect(l.page.kernel.memory.settled?.account).toBe(l.account);
        f.world.release("store_start");
        expect((await f.runWith(signing)).kind).toBe("settled");
        await f.settle();
        if (notices === "never arriving")
          f.world.dropHeld("D2", (meta) => meta.page === l.page.id);
        const sam = stateOf(f).settled?.account_id as string;
        expect(sam).not.toBe(l.account);
        // The page has been told of nothing and its check has not been delivered, and it still refused the answer.
        expect(result.error?.kind).toBe("stale");
        expect(
          f.world.heldCount(
            "D0",
            (meta) =>
              meta.page === l.page.id && meta.label === "response_check",
          ),
        ).toBe(1);
        expect(commitSeq(f, "closing:settle", other.id)).toBeLessThan(
          commitSeq(f, "response_check", l.page.id),
        );
        // The read also told the page where the record stands, without waiting for a notice.
        expect(l.page.kernel.memory.settled?.account).toBe(sam);
        f.world.clearKnobs();
        f.world.release();
        await f.world.runUntilIdle();
        expect(leaseIds(f)).toEqual([]);
        expect(checkProperties(f)).toEqual([]);
      });
    }
  });

  test("a check whose completion is lost still releases: the verdict does not depend on the completion", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const stop = f.store.inject({
      match: (tx) => tx.label === "response_check" && tx.page === l.page.id,
      mode: "commit_then_lose_completion",
      times: 1,
    });
    const result = watch(ordinaryGet(l.page, l.account, l.epoch));
    await f.world.runUntilIdle();
    stop();
    expect(result.state).toBe("returned");
    expect(leaseIds(f)).toEqual([]);
    expect(checkProperties(f)).toEqual([]);
  });

  test("a check that does not start in time is abandoned as `stale`; its body, run later, releases nothing", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    f.world.setKnob(
      "store_start",
      "unbounded",
      (meta) => meta.label === "response_check" && meta.txPage === l.page.id,
    );
    const result = watch(ordinaryGet(l.page, l.account, l.epoch));
    await f.world.runUntilIdle();
    expect(f.world.heldCount("store_start")).toBe(1);
    await f.world.advance(l.page.kernel.config.recordingStallMs + 1);
    expect(result.error?.kind).toBe("stale");
    // The store gets to it after all; the page had given up, and the next request is answered normally.
    f.world.clearKnobs();
    f.world.release("store_start");
    await f.world.runUntilIdle();
    expect(result.error?.kind).toBe("stale");
    const again = await f.runWith(ordinaryGet(l.page, l.account, l.epoch));
    expect(again.status).toBe(200);
    expect(leaseIds(f)).toEqual([]);
    expect(checkProperties(f)).toEqual([]);
  });
});

/**
 * V6 is the property that stands behind the tests above across every scenario of the matrices. It must be able to fail: a
 * checker that cannot flag a release separated from its read proves nothing.
 */
describe("property V6 (a release is taken in the step that read the record)", () => {
  const entries = async (commitBetween: boolean, durableAccount: string) => {
    const f = await newWorld();
    f.world.log({
      type: "trace.response.check",
      page: "p1",
      n: 1,
      account: "acct-1",
      epoch: 1,
      durable: { account: durableAccount, epoch: 1 },
      current: true,
    });
    if (commitBetween)
      f.world.log({
        type: "store.commit",
        page: "p2",
        label: "closing:settle",
        order: 1,
        wrote: true,
        durability: "strict",
        result: null,
      });
    f.world.log({
      type: "trace.response.released",
      page: "p1",
      n: 1,
      account: "acct-1",
      epoch: 1,
    });
    return f;
  };

  test("a write committed between the read and the release is flagged", async () => {
    const violations = checkProperties(await entries(true, "acct-1"));
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/^V6: closing:settle committed/);
  });

  test("a release whose read named another identity is flagged", async () => {
    const violations = checkProperties(await entries(false, "acct-2"));
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/^V6: page p1 released answer 1 for acct-1/);
  });

  test("a release with no check of the record is flagged", async () => {
    const f = await newWorld();
    f.world.log({
      type: "trace.response.released",
      page: "p1",
      n: 7,
      account: "acct-1",
      epoch: 1,
    });
    expect(checkProperties(f)[0]).toMatch(/^V6: page p1 released answer 7/);
  });

  test("a release that follows its read directly is not flagged (the control)", async () => {
    expect(checkProperties(await entries(false, "acct-1"))).toEqual([]);
  });
});
