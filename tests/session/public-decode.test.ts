// @vitest-environment node
import { afterEach, describe, expect, test } from "vitest";
import type { FakePage } from "../support/session/harness";
import { checkProperties } from "../support/session/properties";
import {
  leaseIds,
  newWorld,
  openPage,
  type SignedIn,
  signedInPage,
  stateOf,
} from "../support/session/scenarios";

/**
 * F-DECODE-*: the decode of the answer's body is part of the public call. Reading a body is asynchronous even when its bytes
 * are already in memory (`Response.json()` returns a promise, and the processing of a buffered body is queued as a fetch task),
 * so a check taken BEFORE the library's or the operation's own decode is overtaken by a transition that completes while the
 * decode runs: the call would hand the application account A's list although B is settled. The call is therefore validated
 * again, at the record, after its last decode (`sealResult`), and the typed client and the public operations resolve only
 * through it.
 *
 * The decode is held by wrapping `Response.prototype.json`: the real decode runs and its settlement is then held until the
 * test releases it. That is TEST INSTRUMENTATION that places the interval deterministically; it is not a measured delay.
 * Every case holds the PUBLIC promise: it must still be pending while the decode is held, however long the transition takes.
 */
type World = Awaited<ReturnType<typeof newWorld>>;
type Outcome = "returned" | "stale" | "closed" | "other";

const original = Response.prototype.json;
afterEach(() => {
  Response.prototype.json = original;
});

/** Hold the first decode whose value `match` accepts, after the real decode, until `release()`. */
function holdDecode(match: (value: unknown) => boolean) {
  let release!: () => void;
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen = { held: false };
  Response.prototype.json = async function json(this: Response) {
    const value: unknown = await original.call(this);
    if (!seen.held && match(value)) {
      seen.held = true;
      await paused;
    }
    return value;
  };
  return {
    seen,
    release: () => {
      release();
      Response.prototype.json = original;
    },
  };
}

const hasKey = (key: string) => (value: unknown) =>
  typeof value === "object" &&
  value !== null &&
  Array.isArray((value as Record<string, unknown>)[key]);
const hasField = (key: string) => (value: unknown) =>
  typeof value === "object" && value !== null && key in value;

interface Stamp {
  account: string;
  epoch: number;
}
interface Call {
  name: string;
  /** What the call's own refusal is called. */
  refusal: "stale" | "closed";
  match: (value: unknown) => boolean;
  start(page: FakePage, stamp: Stamp): Promise<Outcome>;
  /** Set up before the call (for example another device to retire). */
  prepare?(f: World, l: SignedIn): Promise<unknown>;
}

const outcomeOfResult = (
  promise: Promise<{ ok: boolean; error?: string }>,
): Promise<Outcome> =>
  promise.then(
    (result) =>
      result.ok
        ? "returned"
        : result.error === "closed"
          ? "closed"
          : ("other" as const),
    () => "other" as const,
  );
const outcomeOfTyped = (promise: Promise<unknown>): Promise<Outcome> =>
  promise.then(
    () => "returned" as const,
    (error: { kind?: string }) =>
      error.kind === "stale" ? "stale" : ("other" as const),
  );

let device: unknown = null;
const operations: Call[] = [
  {
    name: "operations.listSessions",
    refusal: "closed",
    match: hasKey("sessions"),
    start: (page) => outcomeOfResult(page.session.operations.listSessions()),
  },
  {
    name: "operations.readDevices",
    refusal: "closed",
    match: hasKey("devices"),
    start: (page) => outcomeOfResult(page.session.operations.readDevices()),
  },
  {
    name: "operations.retireOtherDevice",
    refusal: "closed",
    match: hasField("outcome"),
    prepare: async (f, l) => {
      f.server.createSession(l.account, "second-device");
      const read = await f.runWith(l.page.session.operations.readDevices());
      if (!read.ok) throw new Error("devices read failed");
      device = read.value.devices.find((d) => !d.current);
      if (!device) throw new Error("no other device");
    },
    start: (page) =>
      outcomeOfResult(
        page.session.operations.retireOtherDevice(
          device as Parameters<
            FakePage["session"]["operations"]["retireOtherDevice"]
          >[0],
        ),
      ),
  },
];
const typed: Call[] = (["ordinary"] as const).flatMap((klass) => [
  {
    name: `the ${klass} typed client, GET /sessions`,
    refusal: "stale" as const,
    match: hasKey("sessions"),
    start: (page: FakePage, stamp: Stamp) =>
      outcomeOfTyped(
        page.session.api
          .client(klass, stamp.account, stamp.epoch)
          .GET("/sessions"),
      ),
  },
  {
    name: `the ${klass} typed client, GET /devices`,
    refusal: "stale" as const,
    match: hasKey("devices"),
    start: (page: FakePage, stamp: Stamp) =>
      outcomeOfTyped(
        page.session.api
          .client(klass, stamp.account, stamp.epoch)
          .GET("/devices"),
      ),
  },
]);

/** What a call has produced so far, without waiting for it. */
const watch = (call: Promise<Outcome>) => {
  const seen: { done: boolean; value?: Outcome } = { done: false };
  void call.then((value) => {
    seen.done = true;
    seen.value = value;
  });
  return seen;
};

/** The call is started and its decode is held: the public promise is pending, and the check before the decode has passed. */
async function decodeHeld(call: Call) {
  const f = await newWorld();
  const l = await signedInPage(f);
  const other = await openPage(f);
  await call.prepare?.(f, l);
  const results = () =>
    f.world.logs.filter(
      (entry) =>
        entry.type === "trace.response.released" && entry.to === "result",
    ).length;
  const releases = () =>
    f.world.logs.filter((entry) => entry.type === "trace.response.released")
      .length;
  const [resultsBefore, releasesBefore] = [results(), releases()];
  const hold = holdDecode(call.match);
  const seen = watch(
    call.start(l.page, { account: l.account, epoch: l.epoch }),
  );
  await f.world.runUntilIdle();
  expect(hold.seen.held).toBe(true);
  expect(seen.done).toBe(false);
  // The Response was released to the library or the operation (the first check), and nothing has reached the application.
  expect(releases()).toBeGreaterThan(releasesBefore);
  expect(results()).toBe(resultsBefore);
  const finish = async () => {
    hold.release();
    await f.world.runUntilIdle();
  };
  return { f, l, other, seen, finish };
}

describe.each([...operations, ...typed])("$name", (call) => {
  test("no transition: the held decode ends and the result is returned whole (the control)", async () => {
    const { f, seen, finish } = await decodeHeld(call);
    await finish();
    expect(seen.value).toBe("returned");
    expect(leaseIds(f)).toEqual([]);
    expect(checkProperties(f)).toEqual([]);
  });

  test("a sign-in as B on the SAME page while the decode is held: the public promise stays pending, then refuses account A's result", async () => {
    const { f, l, seen, finish } = await decodeHeld(call);
    expect((await f.signIn(l.page, "sam", "pw2")).kind).toBe("settled");
    await f.settle();
    const sam = stateOf(f).settled?.account_id as string;
    expect(sam).not.toBe(l.account);
    expect(l.page.session.identity.get()?.account_id).toBe(sam);
    // B is settled, durably and in this page's identity, and the public call has still not resolved.
    expect(seen.done).toBe(false);
    await finish();
    expect(seen.value).toBe(call.refusal);
    expect(leaseIds(f)).toEqual([]);
    expect(checkProperties(f)).toEqual([]);
  });

  test("the same after a re-authentication of the SAME account (epoch 1 to 2)", async () => {
    const { f, l, seen, finish } = await decodeHeld(call);
    expect((await f.signIn(l.page, "kieran", "pw")).kind).toBe("settled");
    await f.settle();
    expect(stateOf(f).settled?.epoch).toBe(2);
    expect(seen.done).toBe(false);
    await finish();
    expect(seen.value).toBe(call.refusal);
    expect(checkProperties(f)).toEqual([]);
  });

  for (const notices of ["delayed", "never arriving"] as const) {
    test(`ANOTHER page settles B while this page's notices are ${notices}: the page's own copy still names A, and the result is refused`, async () => {
      const { f, l, other, seen, finish } = await decodeHeld(call);
      f.world.setKnob("D2", "unbounded", (meta) => meta.page === l.page.id);
      expect((await f.signIn(other, "sam", "pw2")).kind).toBe("settled");
      await f.settle();
      if (notices === "never arriving")
        f.world.dropHeld("D2", (meta) => meta.page === l.page.id);
      const sam = stateOf(f).settled?.account_id as string;
      expect(sam).not.toBe(l.account);
      // No notice has reached this page: only the record knows.
      expect(l.page.kernel.memory.settled?.account).toBe(l.account);
      expect(seen.done).toBe(false);
      await finish();
      expect(seen.value).toBe(call.refusal);
      expect(checkProperties(f)).toEqual([]);
      f.world.clearKnobs();
      f.world.release();
      await f.world.runUntilIdle();
      expect(leaseIds(f)).toEqual([]);
    });
  }

  test("the person SIGNS OUT while the decode is held: nothing is settled, so the result is for nobody", async () => {
    const { f, l, seen, finish } = await decodeHeld(call);
    await f.runWith(
      l.page.session.operations.logout({
        unsynced: { count: 0, items: [], digest: "0" },
      }),
    );
    await f.settle();
    expect(stateOf(f).settled).toBeNull();
    expect(seen.done).toBe(false);
    await finish();
    expect(seen.value).toBe(call.refusal);
    expect(checkProperties(f)).toEqual([]);
  });

  test("the transition is ordered BEFORE the final read (the other page's settling write is held at the store): refused, however the notices go", async () => {
    const { f, l, other, seen, finish } = await decodeHeld(call);
    f.world.setKnob(
      "store_start",
      "unbounded",
      (meta) => meta.label === "closing:settle" && meta.txPage === other.id,
    );
    f.world.setKnob("D2", "unbounded", (meta) => meta.page === l.page.id);
    const begun = await f.runWith(other.session.attempts.begin("password"));
    if (begun.kind !== "started") throw new Error("no attempt");
    const signing = other.session.attempts.signInWithPassword(begun.handle, {
      username: "sam",
      password: "pw2",
    });
    await f.world.runUntilIdle();
    expect(f.world.heldCount("store_start")).toBe(1);
    // The decode ends; the final read of the record is queued BEHIND the other page's settling write.
    f.world.dropHeld("D2", (meta) => meta.page === l.page.id);
    await finish();
    expect(seen.done).toBe(false);
    f.world.release("store_start");
    expect((await f.runWith(signing)).kind).toBe("settled");
    await f.settle();
    expect(seen.value).toBe(call.refusal);
    f.world.clearKnobs();
    f.world.release();
    await f.world.runUntilIdle();
    expect(leaseIds(f)).toEqual([]);
    expect(checkProperties(f)).toEqual([]);
  });

  test("the transition is ordered AFTER the final read (the check's completion and the notices are held): the result was handed back at the read, before B exists", async () => {
    const { f, l, other, seen, finish } = await decodeHeld(call);
    f.world.setKnob(
      "D0",
      "unbounded",
      (meta) => meta.page === l.page.id && meta.label === "response_check",
    );
    f.world.setKnob("D2", "unbounded", (meta) => meta.page === l.page.id);
    await finish();
    // The final check has read the record (still A); its completion has not reached the page, and the result needs none.
    expect(seen.value).toBe("returned");
    expect((await f.signIn(other, "sam", "pw2")).kind).toBe("settled");
    await f.settle();
    const lastCheck = f.world.logs
      .filter(
        (entry) =>
          entry.type === "store.commit" &&
          entry.label === "response_check" &&
          entry.page === l.page.id,
      )
      .at(-1);
    const settle = f.world.logs.find(
      (entry) =>
        entry.type === "store.commit" &&
        entry.label === "closing:settle" &&
        entry.page === other.id,
    );
    expect(lastCheck?.seq).toBeLessThan(settle?.seq as number);
    f.world.clearKnobs();
    f.world.release();
    await f.world.runUntilIdle();
    expect(seen.value).toBe("returned");
    expect(leaseIds(f)).toEqual([]);
    expect(checkProperties(f)).toEqual([]);
  });
});

/**
 * The recovery typed client. Its answers are released and sealed like the ordinary class's, against the epoch it was made
 * under; a re-authentication of the same account (epoch 2 to 3), or another account, makes its result obsolete too.
 */
describe("the recovery typed client, GET /sync", () => {
  async function recoveringDecodeHeld() {
    const f = await newWorld();
    const l = await signedInPage(f);
    const other = await openPage(f);
    f.server.revoke(l.sessionId);
    await f.runWith(
      l.page.session.api
        .fetchFor(
          "ordinary",
          l.account,
          l.epoch,
        )(
          new Request(
            new URL("/api/experimental/v1/probe", "http://localhost"),
          ),
        )
        .catch(() => null),
    );
    await f.world.runUntilIdle();
    expect((await f.signIn(l.page, "kieran", "pw")).kind).toBe("settled");
    await f.settle();
    expect(stateOf(f).settled?.epoch).toBe(2);
    const hold = holdDecode(hasField("path"));
    const seen = watch(
      outcomeOfTyped(
        l.page.session.api
          .client("recovery", l.account, 2)
          .GET("/sync" as never),
      ),
    );
    await f.world.runUntilIdle();
    expect(hold.seen.held).toBe(true);
    expect(seen.done).toBe(false);
    const finish = async () => {
      hold.release();
      await f.world.runUntilIdle();
    };
    return { f, l, other, seen, finish };
  }

  test("no transition: the result is returned whole (the control)", async () => {
    const { f, seen, finish } = await recoveringDecodeHeld();
    await finish();
    expect(seen.value).toBe("returned");
    expect(checkProperties(f)).toEqual([]);
  });

  test("a re-authentication of the same account (epoch 2 to 3) while the decode is held: refused", async () => {
    const { f, l, seen, finish } = await recoveringDecodeHeld();
    expect((await f.signIn(l.page, "kieran", "pw")).kind).toBe("settled");
    await f.settle();
    expect(stateOf(f).settled?.epoch).toBe(3);
    expect(seen.done).toBe(false);
    await finish();
    expect(seen.value).toBe("stale");
    expect(leaseIds(f)).toEqual([]);
    expect(checkProperties(f)).toEqual([]);
  });

  test("ANOTHER page settles account B (notices delayed) while the decode is held: refused", async () => {
    const { f, l, other, seen, finish } = await recoveringDecodeHeld();
    f.world.setKnob("D2", "unbounded", (meta) => meta.page === l.page.id);
    expect((await f.signIn(other, "sam", "pw2")).kind).toBe("settled");
    await f.settle();
    expect(l.page.kernel.memory.settled?.account).toBe(l.account);
    expect(seen.done).toBe(false);
    await finish();
    expect(seen.value).toBe("stale");
    f.world.clearKnobs();
    f.world.release();
    await f.world.runUntilIdle();
    expect(leaseIds(f)).toEqual([]);
    expect(checkProperties(f)).toEqual([]);
  });
});

/**
 * An operation's HTTP error carries a body that is decoded after the release too (it becomes the call's `atlasError`), so it is
 * sealed like a list: a 500 with an Atlas error body, read by `listSessions` for account A, is refused after a transition.
 */
describe("an operation's error answer", () => {
  const errorBody = {
    code: "internal_error",
    message: "internal error",
    request_id: "req-fixture",
    details: [],
  };
  async function errorHeld() {
    const f = await newWorld();
    const l = await signedInPage(f);
    f.server.addRule({
      match: (r) => r.path.endsWith("/sessions") && r.page === l.page.id,
      rewrite: { status: 500, body: errorBody },
    });
    const hold = holdDecode(hasField("code"));
    const seen = watch(
      l.page.session.operations
        .listSessions()
        .then(
          (result) =>
            (result.ok
              ? "returned"
              : result.error === "http"
                ? `http:${result.status}:${result.atlasError?.code ?? ""}`
                : result.error) as Outcome,
        ),
    );
    await f.world.runUntilIdle();
    expect(hold.seen.held).toBe(true);
    expect(seen.done).toBe(false);
    return { f, l, seen, hold };
  }

  test("no transition: the error is returned with its Atlas code (the control)", async () => {
    const { f, seen, hold } = await errorHeld();
    hold.release();
    await f.world.runUntilIdle();
    expect(seen.value).toBe("http:500:internal_error");
    expect(checkProperties(f)).toEqual([]);
  });

  test("a sign-in as B while the error body's decode is held: `closed`, never account A's error", async () => {
    const { f, l, seen, hold } = await errorHeld();
    expect((await f.signIn(l.page, "sam", "pw2")).kind).toBe("settled");
    await f.settle();
    expect(seen.done).toBe(false);
    hold.release();
    await f.world.runUntilIdle();
    expect(seen.value).toBe("closed");
    expect(checkProperties(f)).toEqual([]);
  });
});

/**
 * The typed client's other result shapes: an error body is decoded after the fetch returns too (`await response.text()`), and
 * a status with no body has nothing to decode. Both resolve through the same final validation.
 */
describe("the typed client's error and empty results", () => {
  test("an error answer's body is decoded after the stamped fetch returns, and is refused after a transition", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    // The probe route answers 200; a 404 route answers with an Atlas error body that the library decodes with `.text()`.
    const original = Response.prototype.text;
    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    Response.prototype.text = async function text(this: Response) {
      const value = await original.call(this);
      if (!held && value.includes("not_found")) {
        held = true;
        await paused;
      }
      return value;
    };
    try {
      const seen = watch(
        outcomeOfTyped(
          l.page.session.api
            .client("ordinary", l.account, l.epoch)
            .GET("/unknown-route" as never),
        ),
      );
      await f.world.runUntilIdle();
      expect(held).toBe(true);
      expect(seen.done).toBe(false);
      expect((await f.signIn(l.page, "sam", "pw2")).kind).toBe("settled");
      await f.settle();
      expect(seen.done).toBe(false);
      release();
      await f.world.runUntilIdle();
      expect(seen.value).toBe("stale");
      expect(checkProperties(f)).toEqual([]);
    } finally {
      release();
      Response.prototype.text = original;
    }
  });

  test("a result with no body (nothing to decode) is returned, and the final check still ran", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const target = f.server.createSession(l.account, "another-device");
    const outcome = await f.runWith(
      l.page.session.api.client("ordinary", l.account, l.epoch).DELETE(
        "/sessions/{id}" as never,
        {
          params: { path: { id: target.id } },
        } as never,
      ) as Promise<{ response: Response }>,
    );
    expect(outcome.response.status).toBe(204);
    const finals = f.world.logs.filter(
      (entry) =>
        entry.type === "trace.response.released" && entry.to === "result",
    );
    expect(finals.length).toBeGreaterThan(0);
    expect(checkProperties(f)).toEqual([]);
  });
});

/**
 * Property V7: the release of a public call's result names the decode it follows, and the read of the record that decided it
 * was made after that decode finished. V6 (read and release are one step) cannot see this: the release it observes is the
 * Response's, which precedes the decode. The self-tests show V7 can fail.
 */
describe("property V7 (a result is validated after its last decode)", () => {
  async function fixtureWithCall() {
    const f = await newWorld();
    const l = await signedInPage(f);
    await f.runWith(
      l.page.session.api
        .client("ordinary", l.account, l.epoch)
        .GET("/sessions"),
    );
    await f.world.runUntilIdle();
    return f;
  }
  const final = (f: World) =>
    f.world.logs.find(
      (entry) =>
        entry.type === "trace.response.released" && entry.to === "result",
    );

  test("a result released after its decode is not flagged (the control)", async () => {
    const f = await fixtureWithCall();
    expect(final(f)).toBeDefined();
    expect(checkProperties(f)).toEqual([]);
  });

  test("a read of the record made BEFORE the decode finished is flagged", async () => {
    const f = await fixtureWithCall();
    const released = final(f);
    const decode = f.world.logs.find(
      (entry) =>
        entry.type === "trace.response.decoded" &&
        entry.d === released?.decoded &&
        entry.page === released?.page,
    );
    if (!released || !decode) throw new Error("no final release");
    decode.seq = (f.world.logs.at(-1)?.seq ?? 0) + 1;
    expect(checkProperties(f).some((v) => v.startsWith("V7:"))).toBe(true);
  });

  test("a result that names no finished decode is flagged", async () => {
    const f = await fixtureWithCall();
    const released = final(f);
    if (!released) throw new Error("no final release");
    released.decoded = 9999;
    expect(checkProperties(f).some((v) => v.startsWith("V7:"))).toBe(true);
  });
});
