// @vitest-environment node
import { describe, expect, test } from "vitest";
import type { StampedRequestError } from "../../src/session/kernel/types";
import type { FakePage, Fixture } from "../support/session/harness";
import {
  checkProperties,
  checkQuiescence,
} from "../support/session/properties";
import {
  logoutEnvelope,
  operation,
  unverified,
} from "../support/session/records";
import {
  fencesOf,
  holdLock,
  installAttempt,
  leaseIds,
  newWorld,
  openPage,
  signedInPage,
  stateOf,
} from "../support/session/scenarios";

/**
 * F-REC2-*: `recovery.begin` / `recovery.finish` and the RECOVERY request class (matrix 3.7.3, T24 at API level).
 * The recovery JOB (cursor, snapshot, retry budgets) is WEB-09b's; WEB-08a provides the class, the eligibility
 * decision and the release transaction. Fixture tests against a stub of the contract.
 */
async function reauthenticated() {
  const f = await newWorld();
  const l = await signedInPage(f);
  // C's session is found invalid (epoch 1), the person re-authenticates (epoch 2): the fence stays (row 4/5).
  f.server.revoke(l.sessionId);
  await f.runWith(
    l.page.session.api
      .fetchFor(
        "ordinary",
        l.account,
        l.epoch,
      )(new Request("http://localhost/api/experimental/v1/probe"))
      .catch(() => undefined),
  );
  await f.world.runUntilIdle();
  expect(await f.signIn(l.page, "kieran", "pw")).toMatchObject({
    kind: "settled",
    epoch: 2,
  });
  await f.settle();
  return { f, l };
}
const recoveryGet = (
  page: FakePage,
  account: string,
  epoch: number,
  path = "/sync",
) =>
  page.session.api.fetchFor(
    "recovery",
    account,
    epoch,
  )(new Request(new URL(`/api/experimental/v1${path}`, "http://localhost")));

describe("T24 A: a valid saved cursor", () => {
  test("recovery is eligible; a recovery request is covered by its own lease while an ordinary one is refused; finish clears by identity; the account then exposes", async () => {
    const { f, l } = await reauthenticated();
    // The person has already signed in again: the older-epoch entry is what recovery clears (state 2, "Catching up").
    expect(l.page.session.view.get()).toMatchObject({
      kind: "neutral",
      state: "2",
    });
    expect(
      l.page.kernel.memory.csrf.has(l.page.kernel.memory.csrfKey(l.account, 2)),
    ).toBe(true);
    const begun = await f.runWith(l.page.session.recovery.begin(l.account));
    expect(begun.kind).toBe("eligible");
    if (begun.kind !== "eligible") return;
    expect(begun.handle).toEqual({
      account: l.account,
      epoch: 2,
      s: stateOf(f).fence_seq,
    });
    // Recovery sends the read-only pull under its OWN lease; nothing else can be sent while the fence stands.
    const pulled = await f.runWith(recoveryGet(l.page, l.account, 2));
    expect(pulled.status).toBe(200);
    const ordinary = await f.runWith(
      l.page.session.api
        .fetchFor(
          "ordinary",
          l.account,
          2,
        )(new Request("http://localhost/api/experimental/v1/probe"))
        .then(
          () => "sent",
          (e: StampedRequestError) => e.kind,
        ),
    );
    expect(ordinary).toBe("closed");
    expect(
      f.server.requests.filter((r) => r.path.endsWith("/probe")).length,
    ).toBe(1); // only the earlier 401 one
    expect(leaseIds(f)).toEqual([]); // the recovery request's clean outcome deleted its lease
    expect(l.page.surface.mounted).toBeNull(); // #protected-root never mounted before the clear
    expect(await f.runWith(l.page.session.recovery.finish(begun.handle))).toBe(
      "cleared",
    );
    expect(fencesOf(f, l.account)).toEqual([]);
    await f.world.runUntilIdle();
    expect(l.page.session.view.get().kind).toBe("displaying");
    expect(checkProperties(f, { invalidating: [401] })).toEqual([]);
  });

  test("leases are untouched by finish (rule 12)", async () => {
    const { f, l } = await reauthenticated();
    const begun = await f.runWith(l.page.session.recovery.begin(l.account));
    if (begun.kind !== "eligible") throw new Error("not eligible");
    const other = f.addPage();
    await f.boot(other);
    stateOf(f).leases["x-lease"] = {
      account_id: "somebody-else",
      epoch: 1,
      boot_id: other.kernel.bootId,
      created_at: "x",
      class: "ordinary",
    };
    expect(await f.runWith(l.page.session.recovery.finish(begun.handle))).toBe(
      "cleared",
    );
    expect(stateOf(f).leases["x-lease"]).toBeDefined();
  });
});

describe("T24 C: a recovery-time 401 stops recovery", () => {
  test("the entry is recorded under the CURRENT epoch, so the next cover is CLOSED and finish is NOT_ELIGIBLE with nothing cleared; a further re-authentication restarts it", async () => {
    const { f, l } = await reauthenticated();
    const begun = await f.runWith(l.page.session.recovery.begin(l.account));
    if (begun.kind !== "eligible") throw new Error("not eligible");
    f.server.revoke(stateOf(f).settled?.session_id as string); // S_C' is revoked
    const outcome = await f.runWith(
      recoveryGet(l.page, l.account, 2).then(
        () => "ok",
        (e: StampedRequestError) => e.kind,
      ),
    );
    expect(outcome).toBe("auth_state");
    await f.world.runUntilIdle();
    const list = stateOf(f).fences[l.account] ?? [];
    expect(
      list.some((x) => x.kind === "invalid_session" && x.epoch === 2),
    ).toBe(true);
    // The next recovery cover is CLOSED: recovery stops; committed pages would stay applied.
    expect(
      await f.runWith(
        recoveryGet(l.page, l.account, 2).then(
          () => "ok",
          (e: StampedRequestError) => e.kind,
        ),
      ),
    ).toBe("closed");
    expect(await f.runWith(l.page.session.recovery.finish(begun.handle))).toBe(
      "not_eligible",
    );
    expect(stateOf(f).fences[l.account]).toHaveLength(list.length);
    // The person re-authenticates (epoch 3): both earlier entries are older and recovery restarts with a new s.
    expect(await f.signIn(l.page, "kieran", "pw")).toMatchObject({
      kind: "settled",
      epoch: 3,
    });
    await f.settle();
    const again = await f.runWith(l.page.session.recovery.begin(l.account));
    expect(again.kind).toBe("eligible");
    if (again.kind !== "eligible") return;
    expect(await f.runWith(l.page.session.recovery.finish(again.handle))).toBe(
      "cleared",
    );
    expect(fencesOf(f, l.account)).toEqual([]);
  });
});

describe("finish removes only what the recovery covered", () => {
  test("an entry recorded AFTER `s` survives: RERUN, and a second pass with a new s clears it", async () => {
    const { f, l } = await reauthenticated();
    const begun = await f.runWith(l.page.session.recovery.begin(l.account));
    if (begun.kind !== "eligible") throw new Error("not eligible");
    // A late observation from the OLD epoch is recorded after the recovery began.
    stateOf(f).fences[l.account]?.push({
      seq: stateOf(f).fence_seq + 1,
      epoch: 1,
      obs_id: "late",
      kind: "invalid_session",
      reason: "unauthenticated",
      created_at: "x",
    });
    stateOf(f).fence_seq += 1;
    expect(await f.runWith(l.page.session.recovery.finish(begun.handle))).toBe(
      "rerun",
    );
    expect(stateOf(f).fences[l.account]).toHaveLength(1);
    const again = await f.runWith(l.page.session.recovery.begin(l.account));
    if (again.kind !== "eligible") throw new Error("not eligible");
    expect(await f.runWith(l.page.session.recovery.finish(again.handle))).toBe(
      "cleared",
    );
  });

  test("G: a newer settlement makes a stale handle SUPERSEDED, and its in-flight stamp is STALE", async () => {
    const { f, l } = await reauthenticated();
    const begun = await f.runWith(l.page.session.recovery.begin(l.account));
    if (begun.kind !== "eligible") throw new Error("not eligible");
    expect(await f.signIn(l.page, "kieran", "pw")).toMatchObject({
      kind: "settled",
      epoch: 3,
    });
    await f.settle();
    expect(await f.runWith(l.page.session.recovery.finish(begun.handle))).toBe(
      "superseded",
    );
    expect(
      await f.runWith(
        recoveryGet(l.page, l.account, 2).then(
          () => "ok",
          (e: StampedRequestError) => e.kind,
        ),
      ),
    ).toBe("stale");
  });

  test("F: a failed release (atlas-auth cannot be obtained) leaves the account hidden, never open", async () => {
    const { f, l } = await reauthenticated();
    const begun = await f.runWith(l.page.session.recovery.begin(l.account));
    if (begun.kind !== "eligible") throw new Error("not eligible");
    const release = await holdLock(f, "H", "atlas-auth");
    const finishing = l.page.session.recovery.finish(begun.handle);
    await f.world.runUntilIdle();
    await f.world.advance(20_000);
    expect(await finishing).toBe("lock_timeout");
    expect(fencesOf(f, l.account)).toEqual(["invalid_session"]);
    expect(l.page.surface.mounted).toBeNull();
    release();
  });
});

describe("H: the eligibility rule refuses", () => {
  const ineligible = async (
    mutate: (f: Fixture, account: string) => void,
    reason: string,
  ) => {
    const { f, l } = await reauthenticated();
    mutate(f, l.account);
    const begun = await f.runWith(l.page.session.recovery.begin(l.account));
    // ADAPTED (WEB-08c K-2, R3 of the review of 11 October 2026): was `toEqual({ kind: "ineligible", reason })`. The refusal keeps its
    // reason and now also carries the admission revision of the read it was decided on: exactly what the recovery-class probe answers
    // for the same record, so a waiter's baseline is the refusal's own state.
    const probed = await f.runWith(
      l.page.session.api.admission(
        "recovery",
        l.account,
        stateOf(f).settled?.epoch ?? 0,
      ),
    );
    expect(probed?.blocked).toBe(true);
    expect(begun).toEqual({
      kind: "ineligible",
      reason,
      revision: probed?.revision,
    });
  };
  test("(ii) an operation entry: the operation resolves first", () =>
    ineligible((f, a) => {
      stateOf(f).fences[a]?.push(
        operation(stateOf(f).fence_seq + 1, logoutEnvelope("op9", a, 1)),
      );
      stateOf(f).fence_seq += 1;
    }, "operation_pending"));
  test("(iii) a credential_unverified entry: O11 resolves it first", () =>
    ineligible((f, a) => {
      stateOf(f).fences[a]?.push(unverified(stateOf(f).fence_seq + 1, 1));
      stateOf(f).fence_seq += 1;
    }, "credential_unverified"));
  test("an entry of the current epoch: re-authenticate first", () =>
    ineligible((f, a) => {
      stateOf(f).fences[a]?.push({
        seq: stateOf(f).fence_seq + 1,
        epoch: 2,
        obs_id: "n",
        kind: "drift",
        created_at: "x",
      });
      stateOf(f).fence_seq += 1;
    }, "current_epoch_entry"));
  test("a gating attempt", () =>
    ineligible(
      (f) => installAttempt(f, { epoch: 3, phase: "activating" }),
      "attempt_gating",
    ));
  test("no fence at all", () =>
    ineligible((f, a) => {
      delete stateOf(f).fences[a];
    }, "no_fence"));
  test("offline", async () => {
    const { f, l } = await reauthenticated();
    l.page.goOffline();
    expect(await f.runWith(l.page.session.recovery.begin(l.account))).toEqual({
      kind: "ineligible",
      reason: "offline",
    });
  });
  test("(iv) an unresolved lease of an OLDER epoch is converted (E5) and recovery then covers it", async () => {
    const { f, l } = await reauthenticated();
    const n = f.addPage();
    await f.boot(n);
    stateOf(f).leases["old-lease"] = {
      account_id: l.account,
      epoch: 1,
      boot_id: "dead-boot",
      created_at: "x",
      class: "ordinary",
    };
    const begun = await f.runWith(l.page.session.recovery.begin(l.account));
    expect(begun.kind).toBe("eligible");
    expect(stateOf(f).leases["old-lease"]).toBeUndefined();
    expect(
      stateOf(f).fences[l.account]?.some(
        (x) =>
          x.kind === "invalid_session" &&
          x.reason === "unresolved_response" &&
          x.epoch === 1,
      ),
    ).toBe(true);
    expect(checkQuiescence(f)).toEqual([]);
  });
  test("(i) an unresolved lease of the CURRENT epoch is verified first: a strict 200 lets recovery start", async () => {
    const { f, l } = await reauthenticated();
    stateOf(f).leases["cur-lease"] = {
      account_id: l.account,
      epoch: 2,
      boot_id: "dead-boot",
      created_at: "x",
      class: "ordinary",
    };
    const begun = await f.runWith(l.page.session.recovery.begin(l.account));
    expect(begun.kind).toBe("eligible");
    expect(stateOf(f).leases["cur-lease"]).toBeUndefined();
  });
});

describe("recovery states are presentational", () => {
  test("report() shows states 2 and 3 over a closed account and clears them", async () => {
    const { f, l } = await reauthenticated();
    l.page.session.recovery.report("catching_up");
    await f.world.runUntilIdle();
    expect(l.page.session.view.get()).toMatchObject({
      kind: "neutral",
      state: "2",
    });
    l.page.session.recovery.report("failed");
    await f.world.runUntilIdle();
    expect(l.page.session.view.get()).toMatchObject({
      kind: "neutral",
      state: "3",
    });
    l.page.session.recovery.report(null);
    await f.world.runUntilIdle();
    expect(l.page.session.view.get()).toMatchObject({
      kind: "neutral",
      state: "2",
    });
  });
});

/**
 * WEB-08c revision 4 (R9 of the review of 14 October 2026; design assessment P2/P3, invariants 3 and 4): a recovery report is presentation,
 * SCOPED to the identity it was made for, and it chooses between states 2 and 3 only while older-epoch recovery fences close the account.
 * Completion is learned from the page's OWN record read (a hint, a visibility change, or the scan of a visible page that shows state 2 or 3),
 * never from a withdrawal message: the review's reproduction was a follower left on "Catching up" with `fences: []` because the leading
 * page's single "none" was lost.
 */
describe("R9: a report never outlives the recovery it describes", () => {
  async function twoPagesOnState3() {
    const { f, l } = await reauthenticated();
    const two = await openPage(f);
    await f.settle();
    const scope = { account: l.account, epoch: 2 };
    for (const page of [l.page, two])
      page.session.recovery.report("failed", scope);
    await f.settle();
    for (const page of [l.page, two])
      expect(page.session.view.get()).toMatchObject({
        kind: "neutral",
        state: "3",
      });
    return { f, l, two, scope };
  }
  const clearFence = async (f: Fixture, page: FakePage, account: string) => {
    const begun = await f.runWith(page.session.recovery.begin(account));
    if (begun.kind !== "eligible") throw new Error("not eligible");
    expect(await f.runWith(page.session.recovery.finish(begun.handle))).toBe(
      "cleared",
    );
    expect(fencesOf(f, account)).toEqual([]);
  };

  test("S1: the fence is cleared and NO page is told 'none': every page displays from its own record read (original: stranded on state 3)", async () => {
    const { f, l, two } = await twoPagesOnState3();
    await clearFence(f, l.page, l.account);
    await f.settle();
    // Nobody called report(null). The auth hint after `finish` made each page read its record: no fence, so the report names nothing.
    for (const page of [l.page, two])
      expect(page.session.view.get().kind).toBe("displaying");
    expect(l.page.kernel.neutral.recovery).toBeNull();
    expect(two.kernel.neutral.recovery).toBeNull();
    expect(checkProperties(f, { invalidating: [401] })).toEqual([]);
  });

  test("S3: every hint to the follower is LOST too: it finds the completion by its own record read within one scan interval while visible", async () => {
    const { f, l, two } = await twoPagesOnState3();
    f.world.setKnob("D2", "unbounded", (meta) => meta.page === two.id);
    await clearFence(f, l.page, l.account);
    await f.settle();
    expect(l.page.session.view.get().kind).toBe("displaying");
    // Its hint is held (lost): the follower has read nothing yet.
    expect(
      f.world.heldCount("D2", (meta) => meta.page === two.id),
    ).toBeGreaterThan(0);
    expect(two.session.view.get()).toMatchObject({
      kind: "neutral",
      state: "3",
    });
    // Within one scan interval it reads its record and displays.
    await f.world.advance(two.kernel.config.scanIntervalMs);
    await f.settle();
    expect(two.session.view.get().kind).toBe("displaying");
    expect(
      f.world.logs.some(
        (entry) =>
          entry.page === two.id &&
          entry.type === "trace.evaluate" &&
          entry.reason === "scan",
      ),
    ).toBe(true);
    f.world.dropHeld("D2");
  });

  test("S3/S8 control: a HIDDEN page on state 3 reads nothing on its own; it reads at `visible` and displays then", async () => {
    const { f, l, two } = await twoPagesOnState3();
    f.world.setKnob("D2", "unbounded", (meta) => meta.page === two.id);
    two.hide();
    await f.settle();
    await clearFence(f, l.page, l.account);
    await f.settle();
    const rechecks = () =>
      f.world.logs.filter(
        (entry) =>
          entry.page === two.id &&
          entry.type === "trace.evaluate" &&
          entry.reason === "scan",
      ).length;
    await f.world.advance(4 * two.kernel.config.scanIntervalMs);
    await f.settle();
    expect(rechecks()).toBe(0);
    expect(two.session.view.get().kind).not.toBe("displaying");
    two.show();
    await f.settle();
    expect(two.session.view.get().kind).toBe("displaying");
    f.world.dropHeld("D2");
  });

  test("control: while the fence stands the scan keeps state 3 (it is a read, never a display or a request)", async () => {
    const { f, two } = await twoPagesOnState3();
    const before = f.server.requests.length;
    await f.world.advance(3 * two.kernel.config.scanIntervalMs);
    await f.settle();
    expect(two.session.view.get()).toMatchObject({
      kind: "neutral",
      state: "3",
    });
    expect(two.surface.mounted).toBeNull();
    expect(f.server.requests.length).toBe(before);
  });

  test("a report scoped to ANOTHER identity shows nothing; the identity's own report shows state 3 and its withdrawal state 2", async () => {
    const { f, l } = await reauthenticated();
    const session = l.page.session;
    session.recovery.report("failed", { account: l.account, epoch: 1 });
    await f.settle();
    expect(session.view.get()).toMatchObject({ kind: "neutral", state: "2" });
    expect(l.page.kernel.neutral.recovery).toBeNull();
    session.recovery.report("failed", { account: "someone-else", epoch: 2 });
    await f.settle();
    expect(session.view.get()).toMatchObject({ kind: "neutral", state: "2" });
    session.recovery.report("failed", { account: l.account, epoch: 2 });
    await f.settle();
    expect(session.view.get()).toMatchObject({ kind: "neutral", state: "3" });
    session.recovery.report(null, { account: l.account, epoch: 2 });
    await f.settle();
    expect(session.view.get()).toMatchObject({ kind: "neutral", state: "2" });
  });

  test("a report made while the account has NO fence is withdrawn at the page's next read, and a later fence starts from state 2, not the old report", async () => {
    const { f, l } = await reauthenticated();
    await clearFence(f, l.page, l.account);
    await f.settle();
    expect(l.page.session.view.get().kind).toBe("displaying");
    l.page.session.recovery.report("failed", { account: l.account, epoch: 2 });
    await f.settle();
    expect(l.page.session.view.get().kind).toBe("displaying");
    expect(l.page.kernel.neutral.recovery).toBeNull();
  });
});

describe("WEB-09b R2: the neutral state's Try again is the recovery owner's act too", () => {
  test("`actions.retry` tells every `recovery.onRetry` listener once per press; a listener that unsubscribed or threw does not stop the rest", async () => {
    const { f, l } = await reauthenticated();
    const heard: string[] = [];
    const off = l.page.session.recovery.onRetry(() => heard.push("first"));
    l.page.session.recovery.onRetry(() => {
      throw new Error("a listener's own failure");
    });
    l.page.session.recovery.onRetry(() => heard.push("third"));
    l.page.session.actions.retry();
    await f.settle();
    expect(heard).toEqual(["first", "third"]);
    off();
    l.page.session.actions.retry();
    await f.settle();
    expect(heard).toEqual(["first", "third", "third"]);
    // It is a request, never a permission: the fence still stands and nothing was released by it.
    expect(fencesOf(f, l.account).length).toBeGreaterThan(0);
  });
});
