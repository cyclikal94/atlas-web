// @vitest-environment node
import { describe, expect, test } from "vitest";
import type { RequestAdmission } from "../../src/session";
import type { StampedRequestError } from "../../src/session/kernel/types";
import type { Fixture } from "../support/session/harness";
import { unverified } from "../support/session/records";
import {
  installAttempt,
  newWorld,
  signedInPage,
  stateOf,
} from "../support/session/scenarios";

/**
 * WEB-09b (R3 of the review of 10 October 2026, second cycle): `session.api.admission`, the READ a refused caller (the recovery job)
 * probes while it waits for what admits its request to change. It must follow every input the send loop refuses on (the durable stamp,
 * a gating attempt, the account's fences, this page's hold and closing write), change its revision when another page's lease or this
 * page's token changes, ignore this page's own leases, and write nothing. And `session.api.seal` refuses once the session is disposed.
 */
async function reauthenticated() {
  const f = await newWorld();
  const l = await signedInPage(f);
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

const probe = async (
  f: Fixture,
  page: Awaited<ReturnType<typeof signedInPage>>["page"],
  klass: "ordinary" | "recovery",
  account: string,
  epoch: number,
): Promise<RequestAdmission> => {
  const answer = await f.runWith(
    page.session.api.admission(klass, account, epoch),
  );
  if (answer === null) throw new Error("the record could not be read");
  return answer;
};

describe("WEB-08c K-2 (R3 of the review of 11 October 2026): a refusal's own revision and attempts that come and go", () => {
  test("a displayed account's same-account sign-in gates it; `begin` refuses with the revision of its read; the refusal clears the gate before any probe, and the first probe differs from it (nothing fenced: still blocked)", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    installAttempt(f, { epoch: 2, phase: "activating" });
    stateOf(f).latest_epoch = 2;
    const begun = await f.runWith(l.page.session.recovery.begin(l.account));
    expect(begun).toMatchObject({
      kind: "ineligible",
      reason: "attempt_gating",
      revision: expect.any(String),
    });
    const refusedAt = begun.kind === "ineligible" ? begun.revision : null;
    // The activation is refused at once: the attempt is cleared before the waiter's first probe.
    stateOf(f).attempt = null;
    const first = await probe(f, l.page, "recovery", l.account, l.epoch);
    expect(first.blocked).toBe(true);
    expect(first.revision).not.toBe(refusedAt);
    // And `begin` now says why recovery has nothing to do.
    expect(
      await f.runWith(l.page.session.recovery.begin(l.account)),
    ).toMatchObject({ kind: "ineligible", reason: "no_fence" });
  });
  test("an attempt that begins and ends between two probes leaves the rest of the record as it was, and still changes the revision (`latest_epoch`)", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const before = await probe(f, l.page, "recovery", l.account, l.epoch);
    stateOf(f).latest_epoch += 1;
    installAttempt(f, { epoch: stateOf(f).latest_epoch, phase: "activating" });
    stateOf(f).attempt = null;
    const after = await probe(f, l.page, "recovery", l.account, l.epoch);
    expect(after.blocked).toBe(before.blocked);
    expect(after.revision).not.toBe(before.revision);
  });
});

describe("session.api.admission (R3, second cycle)", () => {
  test("a displayed account: the ordinary class is open, the recovery class blocked (no fence to recover from)", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    expect((await probe(f, l.page, "ordinary", l.account, 1)).blocked).toBe(
      false,
    );
    expect((await probe(f, l.page, "recovery", l.account, 1)).blocked).toBe(
      true,
    );
    // Another epoch is not the settled stamp: blocked.
    expect((await probe(f, l.page, "ordinary", l.account, 2)).blocked).toBe(
      true,
    );
  });

  test("an older-epoch entry after re-authentication: recovery open; a credential_unverified entry added and removed IN THE SAME EPOCH blocks it and changes the revision each way", async () => {
    const { f, l } = await reauthenticated();
    const open = await probe(f, l.page, "recovery", l.account, 2);
    expect(open.blocked).toBe(false);
    expect((await probe(f, l.page, "ordinary", l.account, 2)).blocked).toBe(
      true,
    );
    stateOf(f).fences[l.account]?.push(unverified(stateOf(f).fence_seq + 1, 2));
    stateOf(f).fence_seq += 1;
    const gated = await probe(f, l.page, "recovery", l.account, 2);
    expect(gated.blocked).toBe(true);
    expect(gated.revision).not.toBe(open.revision);
    // O11 removes the entry; `fence_seq` does not move on a removal, and the epoch and view stay as they were.
    const fences = stateOf(f).fences[l.account] ?? [];
    stateOf(f).fences[l.account] = fences.filter(
      (fence) => fence.kind !== "credential_unverified",
    );
    const resolved = await probe(f, l.page, "recovery", l.account, 2);
    expect(resolved.blocked).toBe(false);
    expect(resolved.revision).not.toBe(gated.revision);
  });

  test("a gating attempt blocks both classes, and its resolution changes the revision", async () => {
    const { f, l } = await reauthenticated();
    const before = await probe(f, l.page, "recovery", l.account, 2);
    installAttempt(f, { epoch: 3, phase: "indeterminate" });
    const gating = await probe(f, l.page, "recovery", l.account, 2);
    expect(gating.blocked).toBe(true);
    expect(gating.revision).not.toBe(before.revision);
    stateOf(f).attempt = null;
    const after = await probe(f, l.page, "recovery", l.account, 2);
    expect(after.blocked).toBe(false);
    expect(after.revision).not.toBe(gating.revision);
  });

  test("this page's hold and closing write block it (page memory); releasing them changes the revision", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const memory = l.page.kernel.memory;
    const before = await probe(f, l.page, "ordinary", l.account, 1);
    memory.addHold(l.account, "test-hold");
    const held = await probe(f, l.page, "ordinary", l.account, 1);
    expect(held.blocked).toBe(true);
    memory.releaseHold(l.account, "test-hold");
    const released = await probe(f, l.page, "ordinary", l.account, 1);
    expect(released).toEqual(before);
    memory.closing += 1;
    const closing = await probe(f, l.page, "ordinary", l.account, 1);
    expect(closing.blocked).toBe(true);
    expect(closing.revision).not.toBe(before.revision);
    memory.closing -= 1;
  });

  test("another page's request lease changes the revision (not `blocked`: the send loop waits for or resolves it); this page's own leases and token churn do not block", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const before = await probe(f, l.page, "ordinary", l.account, 1);
    const lease = {
      account_id: l.account,
      epoch: 1,
      created_at: "2026-10-10T00:00:00.000Z",
      class: "ordinary" as const,
    };
    stateOf(f).leases["own-lease"] = {
      ...lease,
      boot_id: l.page.kernel.bootId,
    };
    expect(await probe(f, l.page, "ordinary", l.account, 1)).toEqual(before);
    stateOf(f).leases["foreign-lease"] = { ...lease, boot_id: "another-page" };
    const foreign = await probe(f, l.page, "ordinary", l.account, 1);
    expect(foreign.blocked).toBe(false);
    expect(foreign.revision).not.toBe(before.revision);
    const key = l.page.kernel.memory.csrfKey(l.account, 1);
    const token = l.page.kernel.memory.csrf.get(key);
    l.page.kernel.memory.csrf.delete(key);
    const tokenless = await probe(f, l.page, "ordinary", l.account, 1);
    expect(tokenless.blocked).toBe(false);
    expect(tokenless.revision).not.toBe(foreign.revision);
    if (token !== undefined) l.page.kernel.memory.csrf.set(key, token);
  });

  test("it is a read: nothing in the record changes, no hint is posted, the revision is a digest", async () => {
    const { f, l } = await reauthenticated();
    const record = JSON.stringify(f.store.records);
    const hints = f.world.logs.filter((e) => e.type.startsWith("hint")).length;
    const answer = await probe(f, l.page, "recovery", l.account, 2);
    await f.world.runUntilIdle();
    expect(JSON.stringify(f.store.records)).toBe(record);
    expect(f.world.logs.filter((e) => e.type.startsWith("hint")).length).toBe(
      hints,
    );
    expect(answer.revision).toMatch(/^[0-9a-f]{16}$/);
    expect(answer.revision).not.toContain(l.account);
  });
});

describe("session.api.seal (R7, second cycle)", () => {
  test("a disposed session hands nothing back; a live one releases the caller's whole result", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    expect(
      await f.runWith(l.page.session.api.seal(l.account, 1, { n: 1 })),
    ).toEqual({ n: 1 });
    let release!: (value: { n: number }) => void;
    const pending = new Promise<{ n: number }>((resolve) => {
      release = resolve;
    });
    const sealed = l.page.session.api.seal(l.account, 1, pending).then(
      () => "returned",
      (error: StampedRequestError) => error.kind,
    );
    l.page.session.dispose();
    release({ n: 2 });
    expect(await f.runWith(sealed)).toBe("stale");
  });
});
