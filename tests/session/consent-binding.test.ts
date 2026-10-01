// @vitest-environment node
import { describe, expect, test } from "vitest";
import type { ConsentTicket } from "../../src/session";
import type { FakePage, Fixture } from "../support/session/harness";
import { checkProperties } from "../support/session/properties";
import {
  newWorld,
  type SignedIn,
  signedInPage,
  stateOf,
} from "../support/session/scenarios";

/**
 * F-CONSENT-*: the renewed-consent choice is applied to the prompt the person SAW (answers Q3 and Q20(a); WEB-04 7.8 and 4):
 * its account, its operation and its consent digest, carried by an opaque ticket. Before this, the action deleted "the
 * first entry waiting in the ledger", so with two accounts waiting the prompt of one could delete the data of the other.
 */
const deletes = (f: Fixture) =>
  f.data.calls.filter((call) => call.startsWith("delete:"));

function promptOf(page: FakePage) {
  const view = page.session.view.get();
  if (view.kind !== "neutral" || !view.consent)
    throw new Error(`no consent prompt is showing: ${JSON.stringify(view)}`);
  return view.consent;
}

/** A confirmed logout whose local work changed after the confirmation: the account is left awaiting renewed consent. */
async function logoutWithChangedWork(
  f: Fixture,
  l: SignedIn,
  account: string,
  count: number,
) {
  f.data.databases.set(account, { incarnation: `inc-${account}` });
  f.data.work.set(account, { count, digest: `d-${account}` });
  f.data.liveDigests.set(account, `live-${account}`);
  const started = await f.runWith(
    l.page.session.operations.logout({
      unsynced: { count, items: [], digest: `d-${account}` },
    }),
  );
  expect(started.kind).toBe("started");
  await f.settle();
  expect(f.store.records.pending_deletions[account]?.status).toBe(
    "awaiting_consent",
  );
}

/** Two accounts left awaiting renewed consent, in either order; the page shows the second account's prompt. */
async function twoWaiting(firstName: "kieran" | "sam") {
  const secondName = firstName === "kieran" ? "sam" : "kieran";
  const passwords = { kieran: "pw", sam: "pw2" } as const;
  const f = await newWorld();
  const l = await signedInPage(f, firstName, passwords[firstName]);
  const first = l.account;
  await logoutWithChangedWork(f, l, first, 3);
  expect((await f.signIn(l.page, secondName, passwords[secondName])).kind).toBe(
    "settled",
  );
  await f.settle();
  const second = stateOf(f).settled?.account_id as string;
  expect(second).not.toBe(first);
  await logoutWithChangedWork(f, l, second, 8);
  return { f, l, first, second };
}

describe("the choice is applied to the prompt on screen (Q3, Q20(a); WEB-04 7.8, 4)", () => {
  for (const firstName of ["kieran", "sam"] as const) {
    test(`two accounts waiting (${firstName} first): 'Delete them' deletes only the account whose count is on screen`, async () => {
      const { f, l, first, second } = await twoWaiting(firstName);
      const prompt = promptOf(l.page);
      expect(prompt.count).toBe(8);
      l.page.session.actions.consent("delete", prompt.ticket);
      await f.world.runUntilIdle();
      expect(deletes(f)).toEqual([`delete:${second}`]);
      expect(f.data.databases.has(second)).toBe(false);
      expect(f.data.databases.has(first)).toBe(true);
      // The other account still waits for ITS OWN choice, with its own count, and nothing was said about it meanwhile.
      expect(f.store.records.pending_deletions[first]?.status).toBe(
        "awaiting_consent",
      );
      expect(f.store.records.pending_deletions[second]).toBeUndefined();
      const next = promptOf(l.page);
      expect(next.count).toBe(3);
      expect(next.ticket).not.toBe(prompt.ticket);
      // Its own answer deletes it, and only it.
      l.page.session.actions.consent("delete", next.ticket);
      await f.world.runUntilIdle();
      expect(deletes(f)).toEqual([`delete:${second}`, `delete:${first}`]);
      expect(f.store.records.pending_deletions).toEqual({});
      expect(checkProperties(f)).toEqual([]);
    });

    test(`two accounts waiting (${firstName} first): 'Keep for now' keeps the account on screen and leaves the other's prompt waiting`, async () => {
      const { f, l, first, second } = await twoWaiting(firstName);
      const prompt = promptOf(l.page);
      expect(prompt.count).toBe(8);
      l.page.session.actions.consent("keep", prompt.ticket);
      await f.world.runUntilIdle();
      expect(deletes(f)).toEqual([]);
      expect(f.data.databases.has(first)).toBe(true);
      expect(f.data.databases.has(second)).toBe(true);
      expect(f.store.records.pending_deletions[second]).toBeUndefined();
      expect(f.store.records.pending_deletions[first]?.status).toBe(
        "awaiting_consent",
      );
      expect(promptOf(l.page).count).toBe(3);
    });
  }

  test("seeded entries: the prompt for the settled account wins, whatever order the ledger holds them in, and its choice reaches only it", async () => {
    for (const order of ["settled-first", "other-first"] as const) {
      const f = await newWorld();
      const l = await signedInPage(f);
      const sam = [...f.server.accounts.values()].find(
        (account) => account.username === "sam",
      )?.id as string;
      const seeded: Array<[string, number]> =
        order === "settled-first"
          ? [
              [l.account, 8],
              [sam, 3],
            ]
          : [
              [sam, 3],
              [l.account, 8],
            ];
      for (const [account, count] of seeded) {
        f.data.databases.set(account, { incarnation: `inc-${account}` });
        f.data.work.set(account, { count, digest: `d-${account}` });
        f.store.records.pending_deletions[account] = {
          account_id: account,
          operation_id: `op-${account}`,
          incarnation_id: `inc-${account}`,
          status: "awaiting_consent",
          digest: `d-${account}`,
          approved_digest: null,
          count,
          created_at: "2026-09-30T12:00:00.000Z",
        };
      }
      const reload = f.addPage();
      await f.boot(reload);
      expect(promptOf(reload).count).toBe(8);
      reload.session.actions.consent("delete", promptOf(reload).ticket);
      await f.world.runUntilIdle();
      expect(deletes(f)).toEqual([`delete:${l.account}`]);
      expect(f.data.databases.has(sam)).toBe(true);
      expect(f.store.records.pending_deletions[sam]?.status).toBe(
        "awaiting_consent",
      );
    }
  });

  test("the ticket and the view carry no account or operation identifier", async () => {
    const { f, l, first, second } = await twoWaiting("kieran");
    const text = JSON.stringify(l.page.session.view.get());
    for (const secret of [first, second])
      expect(text).not.toContain(secret as string);
    for (const entry of Object.values(f.store.records.pending_deletions))
      expect(text).not.toContain(entry.operation_id);
    expect(Object.keys(promptOf(l.page)).sort()).toEqual(["count", "ticket"]);
  });
});

describe("a choice made on a prompt that is no longer the current one applies nothing, and the prompt is re-derived", () => {
  test("a ticket from a prompt that was replaced by another account's prompt", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    await logoutWithChangedWork(f, l, l.account, 3);
    const stale = promptOf(l.page).ticket;
    expect((await f.signIn(l.page, "sam", "pw2")).kind).toBe("settled");
    await f.settle();
    const sam = stateOf(f).settled?.account_id as string;
    await logoutWithChangedWork(f, l, sam, 8);
    const current = promptOf(l.page).ticket;
    expect(current).not.toBe(stale);
    // The old prompt's 'Delete them' is refused: nothing is deleted, the current prompt is unchanged.
    expect(
      await f.runWith(l.page.session.wipe.resolveConsent(stale, "delete")),
    ).toEqual({ kind: "prompt_superseded" });
    await f.settle();
    expect(deletes(f)).toEqual([]);
    expect(promptOf(l.page)).toMatchObject({ count: 8, ticket: current });
    expect(
      Object.values(f.store.records.pending_deletions).map((e) => e.status),
    ).toEqual(["awaiting_consent", "awaiting_consent"]);
  });

  test("a ticket the page never issued (another page's, or invented) applies nothing", async () => {
    const { f, l } = await twoWaiting("kieran");
    for (const choice of ["delete", "keep"] as const)
      expect(
        await f.runWith(
          l.page.session.wipe.resolveConsent(
            "not-a-ticket" as ConsentTicket,
            choice,
          ),
        ),
      ).toEqual({ kind: "prompt_superseded" });
    expect(deletes(f)).toEqual([]);
    expect(Object.keys(f.store.records.pending_deletions)).toHaveLength(2);
  });

  test("an entry whose consent digest changed since the prompt was shown is not deleted on the old prompt's say-so", async () => {
    const { f, l, second } = await twoWaiting("kieran");
    const old = promptOf(l.page);
    // The entry is re-armed with different work (a new digest and count) by another page.
    const entry = f.store.records.pending_deletions[second];
    if (!entry) throw new Error("no entry");
    entry.digest = "live-changed";
    entry.count = 9;
    f.data.liveDigests.set(second, "live-changed");
    f.data.work.set(second, { count: 9, digest: "live-changed" });
    expect(
      await f.runWith(l.page.session.wipe.resolveConsent(old.ticket, "delete")),
    ).toEqual({ kind: "prompt_superseded" });
    await f.settle();
    expect(deletes(f)).toEqual([]);
    expect(f.data.databases.has(second)).toBe(true);
    // The prompt is re-derived from the entry as it now is: a new count and a new ticket.
    const now = promptOf(l.page);
    expect(now.count).toBe(9);
    expect(now.ticket).not.toBe(old.ticket);
    // And its own ticket works.
    l.page.session.actions.consent("delete", now.ticket);
    await f.world.runUntilIdle();
    expect(deletes(f)).toEqual([`delete:${second}`]);
  });

  test("answering twice (a double click) applies once; the second answer is refused", async () => {
    const { f, l, second } = await twoWaiting("sam");
    const { ticket } = promptOf(l.page);
    l.page.session.actions.consent("delete", ticket);
    l.page.session.actions.consent("delete", ticket);
    await f.world.runUntilIdle();
    expect(deletes(f)).toEqual([`delete:${second}`]);
  });
});
