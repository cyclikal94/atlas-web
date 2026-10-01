// @vitest-environment node
import { describe, expect, test } from "vitest";
import type { Result } from "../../src/session/api";
import type { FakePage } from "../support/session/harness";
import { checkProperties } from "../support/session/properties";
import {
  fencesOf,
  holdAnswers,
  leaseIds,
  newWorld,
  openPage,
  type SignedIn,
  signedInPage,
  stateOf,
} from "../support/session/scenarios";

/**
 * F-OPS-STALE-*: the public Settings operations are stamped requests too. Their answers used to be returned by status and by
 * a decode made AFTER the call had returned, without any check against the identity the call was made under, so a list read
 * for account A could be handed to a page that had since settled account B (G4: "its result is dropped if the identity has
 * since changed"). Every clean answer now passes the boundary the typed client uses (`releaseResponse`): the body is read
 * inside the call, and the answer is handed back only if the durable record, read in the step that releases it, still names
 * the identity the call was made under. `closed` is the operations' spelling of `stale`. The two list reads are the ones the
 * Settings sections call; the same boundary serves the sign-out, retirement and self-revoking calls.
 */
type World = Awaited<ReturnType<typeof newWorld>>;
type List = Result<{ readonly length?: number } & Record<string, unknown>>;

const readers = [
  {
    name: "listSessions",
    path: "/sessions",
    call: (page: FakePage): Promise<List> =>
      page.session.operations.listSessions() as Promise<List>,
    items: (result: List) =>
      result.ok ? (result.value.sessions as unknown[]) : null,
  },
  {
    name: "readDevices",
    path: "/devices",
    call: (page: FakePage): Promise<List> =>
      page.session.operations.readDevices() as Promise<List>,
    items: (result: List) =>
      result.ok ? (result.value.devices as unknown[]) : null,
  },
] as const;

/** What a call has produced so far, without waiting for it. */
const watch = <T>(call: Promise<T>) => {
  const seen: { done: boolean; value?: T } = { done: false };
  void call.then((value) => {
    seen.done = true;
    seen.value = value;
  });
  return seen;
};

const commitSeq = (
  f: World,
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

describe.each(readers)("$name", (reader) => {
  async function readHeld() {
    const f = await newWorld();
    const l = await signedInPage(f);
    const other = await openPage(f);
    const held = holdAnswers(
      f,
      (r) => r.path.endsWith(reader.path) && r.page === l.page.id,
    );
    const call = watch(reader.call(l.page));
    await f.world.runUntilIdle();
    expect(call.done).toBe(false);
    return { f, l, other, held, call };
  }
  const release = async (
    f: World,
    held: { stop: () => void; release: () => number },
  ) => {
    held.stop();
    held.release();
    await f.world.runUntilIdle();
  };
  const closed = { ok: false, error: "closed" };

  test("no transition: the list is returned whole (the control)", async () => {
    const { f, held, call } = await readHeld();
    await release(f, held);
    expect(call.value).toMatchObject({ ok: true });
    expect(reader.items(call.value as List)?.length).toBeGreaterThan(0);
    expect(leaseIds(f)).toEqual([]);
    expect(checkProperties(f)).toEqual([]);
  });

  test("a sign-in as B on the SAME page while the answer is held: `closed`, never account A's list", async () => {
    const { f, l, held, call } = await readHeld();
    expect((await f.signIn(l.page, "sam", "pw2")).kind).toBe("settled");
    await f.settle();
    const sam = stateOf(f).settled?.account_id as string;
    expect(sam).not.toBe(l.account);
    await release(f, held);
    expect(call.value).toEqual(closed);
    expect(leaseIds(f)).toEqual([]);
    expect(l.page.session.view.get().kind).toBe("displaying");
    expect(l.page.session.identity.get()?.account_id).toBe(sam);
    expect(checkProperties(f)).toEqual([]);
  });

  test("the same after a re-authentication of the SAME account (epoch 1 to 2) on the same page", async () => {
    const { f, l, held, call } = await readHeld();
    expect((await f.signIn(l.page, "kieran", "pw")).kind).toBe("settled");
    await f.settle();
    expect(stateOf(f).settled?.epoch).toBe(2);
    await release(f, held);
    expect(call.value).toEqual(closed);
    expect(leaseIds(f)).toEqual([]);
    expect(checkProperties(f)).toEqual([]);
  });

  test("the same after the person SIGNS OUT: nothing is settled, so the list is for nobody", async () => {
    const { f, l, held, call } = await readHeld();
    await f.runWith(
      l.page.session.operations.logout({
        unsynced: { count: 0, items: [], digest: "0" },
      }),
    );
    await f.settle();
    expect(stateOf(f).settled).toBeNull();
    await release(f, held);
    expect(call.value).toEqual(closed);
    expect(checkProperties(f)).toEqual([]);
  });

  for (const notices of ["delayed", "never arriving"] as const) {
    test(`ANOTHER page settles B while this page's notices are ${notices}: \`closed\`, and the page catches up from the read`, async () => {
      const { f, l, other, held, call } = await readHeld();
      f.world.setKnob("D2", "unbounded", (meta) => meta.page === l.page.id);
      expect((await f.signIn(other, "sam", "pw2")).kind).toBe("settled");
      await f.settle();
      if (notices === "never arriving")
        f.world.dropHeld("D2", (meta) => meta.page === l.page.id);
      const sam = stateOf(f).settled?.account_id as string;
      expect(l.page.kernel.memory.settled?.account).toBe(l.account);
      await release(f, held);
      expect(call.value).toEqual(closed);
      expect(l.page.kernel.memory.settled?.account).toBe(sam);
      expect(leaseIds(f)).toEqual([]);
      f.world.clearKnobs();
      f.world.release();
      await f.world.runUntilIdle();
      expect(checkProperties(f)).toEqual([]);
    });
  }

  test("the transition completes while the body is being DECODED (notice delayed): the decoded list is dropped", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const other = await openPage(f);
    // The headers arrive at once; the body is held (a large or slow payload).
    const stop = f.server.addRule({
      match: (r) => r.path.endsWith(reader.path) && r.page === l.page.id,
      bodyDelay: "unbounded",
    });
    const call = watch(reader.call(l.page));
    await f.world.runUntilIdle();
    expect(f.world.heldCount("Db")).toBe(1);
    f.world.setKnob("D2", "unbounded", (meta) => meta.page === l.page.id);
    expect((await f.signIn(other, "sam", "pw2")).kind).toBe("settled");
    await f.settle();
    expect(l.page.kernel.memory.settled?.account).toBe(l.account);
    stop();
    f.world.release("Db");
    await f.world.runUntilIdle();
    expect(call.value).toEqual(closed);
    expect(leaseIds(f)).toEqual([]);
    f.world.clearKnobs();
    f.world.release();
    await f.world.runUntilIdle();
    expect(checkProperties(f)).toEqual([]);
  });

  test("no transition, body decoded late: the list is returned once decoding ends (the control)", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const stop = f.server.addRule({
      match: (r) => r.path.endsWith(reader.path) && r.page === l.page.id,
      bodyDelay: "unbounded",
    });
    const call = watch(reader.call(l.page));
    await f.world.runUntilIdle();
    expect(f.world.heldCount("Db")).toBe(1);
    stop();
    f.world.release("Db");
    await f.world.runUntilIdle();
    expect(call.value).toMatchObject({ ok: true });
    expect(checkProperties(f)).toEqual([]);
  });

  test("the check's completion and the notices are both delayed and B is ordered AFTER the read: the list was released at the read, and B is not held up", async () => {
    const { f, l, other, held, call } = await readHeld();
    f.world.setKnob(
      "D0",
      "unbounded",
      (meta) => meta.page === l.page.id && meta.label === "response_check",
    );
    f.world.setKnob("D2", "unbounded", (meta) => meta.page === l.page.id);
    await release(f, held);
    // Two checks have read the record (the Response's release, then the result's final check after the decode); both
    // completions are held, and the call has returned at the last read.
    expect(
      f.world.heldCount(
        "D0",
        (meta) => meta.page === l.page.id && meta.label === "response_check",
      ),
    ).toBe(2);
    expect(call.value).toMatchObject({ ok: true });
    expect((await f.signIn(other, "sam", "pw2")).kind).toBe("settled");
    await f.settle();
    expect(commitSeq(f, "response_check", l.page.id, "last")).toBeLessThan(
      commitSeq(f, "closing:settle", other.id),
    );
    f.world.clearKnobs();
    f.world.release();
    await f.world.runUntilIdle();
    expect(call.value).toMatchObject({ ok: true });
    expect(leaseIds(f)).toEqual([]);
    expect(checkProperties(f)).toEqual([]);
  });

  test("the completion and the notices are both delayed and B is ordered BEFORE the read: `closed`", async () => {
    const { f, l, other, held, call } = await readHeld();
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
    f.world.setKnob(
      "D0",
      "unbounded",
      (meta) => meta.page === l.page.id && meta.label === "response_check",
    );
    f.world.setKnob("D2", "unbounded", (meta) => meta.page === l.page.id);
    await release(f, held);
    // The answer is read and its check is queued BEHIND the other page's settling write: nothing is returned yet.
    expect(call.done).toBe(false);
    f.world.release("store_start");
    expect((await f.runWith(signing)).kind).toBe("settled");
    await f.settle();
    expect(call.value).toEqual(closed);
    expect(commitSeq(f, "closing:settle", other.id)).toBeLessThan(
      commitSeq(f, "response_check", l.page.id),
    );
    f.world.clearKnobs();
    f.world.release();
    await f.world.runUntilIdle();
    expect(leaseIds(f)).toEqual([]);
    expect(checkProperties(f)).toEqual([]);
  });
});

describe("the other stamped operations share the boundary", () => {
  async function held(path: (r: { path: string }) => boolean) {
    const f = await newWorld();
    const l: SignedIn = await signedInPage(f);
    const stop = holdAnswers(f, (r) => path(r) && r.page === l.page.id);
    return { f, l, stop };
  }

  test("revoking another sign-in: its status is not returned after a transition (no body is read for it)", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const target = f.server.createSession(l.account, "another-device");
    const stop = holdAnswers(
      f,
      (r) => r.method === "DELETE" && r.path.endsWith(`/sessions/${target.id}`),
    );
    const call = watch(l.page.session.operations.revokeOtherSession(target.id));
    await f.world.runUntilIdle();
    expect(call.done).toBe(false);
    expect((await f.signIn(l.page, "sam", "pw2")).kind).toBe("settled");
    await f.settle();
    stop.stop();
    stop.release();
    await f.world.runUntilIdle();
    expect(call.value).toEqual({ ok: false, error: "closed" });
    expect(leaseIds(f)).toEqual([]);
    expect(checkProperties(f)).toEqual([]);
  });

  test("a password change whose answer arrives after another page settled B (notice delayed): `closed`, and it fences neither account", async () => {
    const { f, l, stop } = await held((r) => r.path.endsWith("/password"));
    const other = await openPage(f);
    const call = watch(
      l.page.session.operations.changePassword({ current: "pw", next: "new" }),
    );
    await f.world.runUntilIdle();
    expect(call.done).toBe(false);
    f.world.setKnob("D2", "unbounded", (meta) => meta.page === l.page.id);
    expect((await f.signIn(other, "sam", "pw2")).kind).toBe("settled");
    await f.settle();
    const sam = stateOf(f).settled?.account_id as string;
    stop.stop();
    stop.release();
    await f.world.runUntilIdle();
    expect(call.value).toEqual({ ok: false, error: "closed" });
    // The answer still took its first step (the lock surrendered, the lease deleted); its recording was discarded as stale.
    expect(leaseIds(f)).toEqual([]);
    expect(fencesOf(f, sam)).toEqual([]);
    expect(fencesOf(f, l.account)).toEqual([]);
    f.world.clearKnobs();
    f.world.release();
    await f.world.runUntilIdle();
    expect(l.page.session.identity.get()?.account_id).toBe(sam);
    expect(checkProperties(f)).toEqual([]);
  });

  test("a password change with no transition still surrenders and is confirmed (the control)", async () => {
    const { f, l, stop } = await held((r) => r.path.endsWith("/password"));
    const call = watch(
      l.page.session.operations.changePassword({ current: "pw", next: "new" }),
    );
    await f.world.runUntilIdle();
    stop.stop();
    stop.release();
    await f.world.runUntilIdle();
    expect(call.value).toEqual({ ok: true, value: "changed" });
    expect(fencesOf(f, l.account)).toEqual(["invalid_session"]);
    expect(leaseIds(f)).toEqual([]);
  });

  test("retiring another device: the outcome is read inside the call and dropped after a transition", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const other = f.server.createSession(l.account, "second-device");
    const read = await f.runWith(l.page.session.operations.readDevices());
    if (!read.ok) throw new Error("devices read failed");
    const row = read.value.devices.find((d) => !d.current);
    if (!row) throw new Error(`no other device (${other.id})`);
    const stop = holdAnswers(
      f,
      (r) => r.method === "DELETE" && /\/devices\/[^/]+$/.test(r.path),
    );
    const call = watch(l.page.session.operations.retireOtherDevice(row));
    await f.world.runUntilIdle();
    expect(call.done).toBe(false);
    expect((await f.signIn(l.page, "sam", "pw2")).kind).toBe("settled");
    await f.settle();
    stop.stop();
    stop.release();
    await f.world.runUntilIdle();
    expect(call.value).toEqual({ ok: false, error: "closed" });
    expect(checkProperties(f)).toEqual([]);
  });
});
