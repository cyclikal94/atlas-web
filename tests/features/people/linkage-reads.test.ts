// @vitest-environment node
import { beforeEach, describe, expect, test } from "vitest";
import type {
  PeopleResult,
  PersonDetailAnswer,
} from "../../../src/features/people/api";
import type { usePeopleEnv } from "../../../src/features/people/env";
import {
  forgetAllPeopleMemory,
  type PeopleMemory,
  peopleMemory,
} from "../../../src/features/people/memory";
import { linkageIn, readLinkage } from "../../../src/features/people/reads";

/**
 * Who reads a person's linkage (review 20, R20.1): an ordinary read joins the one on its way; a forced read (after a command, "Reload",
 * "Try again") supersedes it, and only the latest read of the person changes what the page knows — its answer, its refusal, its failure,
 * the read on its way and the notification. Each answer is released by the test (no timers); every request is counted.
 */
const ME = "11111111-1111-4111-8111-111111111111";
const MO = "22222222-2222-4222-8222-222222222222";
const P = "55555555-5555-4555-8555-555555555555";
const Q = "77777777-7777-4777-8777-777777777777";
type Answer = PeopleResult<PersonDetailAnswer>;

const linked = (version: number, account: string | null): Answer => ({
  ok: true,
  value: {
    person: { id: P, label: `v${version}`, version } as never,
    linked_account_id: account,
  },
});
const OUTCOMES: ReadonlyArray<[string, Answer]> = [
  ["a linked answer", linked(2, ME)],
  ["forbidden", { ok: false, kind: "forbidden" }],
  ["not found", { ok: false, kind: "not_found" }],
  ["uncertain", { ok: false, kind: "uncertain" }],
  ["not sent", { ok: false, kind: "not_sent" }],
  ["closed", { ok: false, kind: "closed" }],
];

/** The env `readLinkage` reads, over a REAL page memory; each `readPerson` waits until the test answers it. */
function world(identity = "acct:1#1") {
  const requests: Array<{ id: string; answer(result: Answer): Promise<void> }> =
    [];
  const env = {
    memory: peopleMemory(identity),
    online: true,
    accountId: ME,
    now: () => 10,
    api: {
      readPerson: (id: string) =>
        new Promise<Answer>((resolve) => {
          requests.push({
            id,
            answer: async (result) => {
              resolve(result);
              // Lets the completion run before the test looks.
              await Promise.resolve();
              await Promise.resolve();
            },
          });
        }),
    },
  } as unknown as ReturnType<typeof usePeopleEnv> & { online: boolean };
  let touched = 0;
  env.memory.subscribe(() => {
    touched += 1;
  });
  return { env, requests, touched: () => touched };
}

/** What the page knows about P, as one comparable value. */
const known = (memory: PeopleMemory, id = P) => ({
  linkage: memory.linkage.get(id) ?? null,
  refused: memory.refused.get(id) ?? null,
  failed: memory.failed.has(id),
  reading: memory.linkageReads.get(id) ?? null,
});

beforeEach(() => forgetAllPeopleMemory());

describe("ordinary reads join; a forced read supersedes (DA20-02)", () => {
  test("two ordinary callers make one request; a forced read is a second; a later ordinary caller joins the FORCED one; Q is its own", () => {
    const { env, requests } = world();
    const header = readLinkage(env, P);
    const editor = readLinkage(env, P);
    expect(header).not.toBeNull();
    expect(editor).toBe(header);
    expect(requests.map((r) => r.id)).toEqual([P]);
    const forced = readLinkage(env, P, { force: true });
    expect(forced).not.toBe(header);
    expect(requests.map((r) => r.id)).toEqual([P, P]);
    expect(readLinkage(env, P)).toBe(forced);
    const other = readLinkage(env, Q);
    expect(other).not.toBeNull();
    expect(requests.map((r) => r.id)).toEqual([P, P, Q]);
    expect(env.memory.linkageReads.get(P)).toBe(forced);
    expect(env.memory.linkageReads.get(Q)).toBe(other);
  });

  test("a known or refused person is not read again by an ordinary caller", async () => {
    const { env, requests } = world();
    readLinkage(env, P);
    await requests[0]?.answer(linked(1, ME));
    expect(readLinkage(env, P)).toBeNull();
    readLinkage(env, Q);
    await requests[1]?.answer({ ok: false, kind: "forbidden" });
    expect(readLinkage(env, Q)).toBeNull();
    expect(requests).toHaveLength(2);
  });

  test("a forced read of P never supersedes a read of Q", async () => {
    const { env, requests } = world();
    readLinkage(env, Q);
    readLinkage(env, P, { force: true });
    await requests[0]?.answer({
      ok: true,
      value: {
        person: { id: Q, label: "Q", version: 1 } as never,
        linked_account_id: MO,
      },
    });
    expect(linkageIn(env, Q)).toMatchObject({ known: true, kind: "other" });
    expect(env.memory.linkageReads.has(Q)).toBe(false);
    expect(env.memory.linkageReads.has(P)).toBe(true);
  });
});

describe("an answer read before an unlink never replaces the one read after it (DA20-03)", () => {
  for (const order of ["in order", "older answer last"] as const) {
    test(`${order}: the page knows the unlinked person at version 3`, async () => {
      const { env, requests } = world();
      readLinkage(env, P, { force: true }); // after the rename
      readLinkage(env, P, { force: true }); // after the unlink
      const [before, after] = requests;
      if (order === "in order") {
        await before?.answer(linked(2, ME));
        await after?.answer(linked(3, null));
      } else {
        await after?.answer(linked(3, null));
        await before?.answer(linked(2, ME));
      }
      expect(linkageIn(env, P)).toMatchObject({
        known: true,
        kind: "unlinked",
        version: 3,
      });
      expect(known(env.memory).linkage?.person?.version).toBe(3);
      expect(known(env.memory)).toMatchObject({
        refused: null,
        failed: false,
        reading: null,
      });
    });
  }
});

describe("a superseded read changes nothing, whatever it answers (DA20-04)", () => {
  for (const [name, outcome] of OUTCOMES) {
    test(`superseded, ${name}, after the current read answered: nothing changes and nobody is told`, async () => {
      const { env, requests, touched } = world();
      readLinkage(env, P, { force: true });
      readLinkage(env, P, { force: true });
      await requests[1]?.answer(linked(3, null));
      const was = known(env.memory);
      const seen = touched();
      await requests[0]?.answer(outcome);
      expect(known(env.memory)).toEqual(was);
      expect(touched()).toBe(seen);
      expect(linkageIn(env, P)).toMatchObject({ kind: "unlinked" });
    });
  }

  // The controls: the same answers, from the CURRENT read, are applied.
  test.each([
    ["forbidden", { ok: false, kind: "forbidden" } as Answer, "refused"],
    ["not found", { ok: false, kind: "not_found" } as Answer, "refused"],
    ["uncertain", { ok: false, kind: "uncertain" } as Answer, "failed"],
    ["not sent", { ok: false, kind: "not_sent" } as Answer, "failed"],
  ])("current, %s: applied (%s)", async (_name, outcome, reason) => {
    const { env, requests } = world();
    readLinkage(env, P, { force: true });
    readLinkage(env, P, { force: true });
    await requests[0]?.answer(linked(2, ME));
    await requests[1]?.answer(outcome);
    expect(linkageIn(env, P)).toEqual({ known: false, reason });
    expect(env.memory.linkageReads.has(P)).toBe(false);
  });

  test("current, a linked answer: applied", async () => {
    const { env, requests } = world();
    readLinkage(env, P, { force: true });
    readLinkage(env, P, { force: true });
    await requests[0]?.answer(linked(3, null));
    await requests[1]?.answer(linked(4, ME));
    expect(linkageIn(env, P)).toMatchObject({ kind: "self", version: 4 });
  });
});

describe("a superseded read answering while the current one waits (DA20-05)", () => {
  for (const [name, outcome] of OUTCOMES) {
    test(`superseded, ${name}: still loading, the current read stays the one joined, and only it settles`, async () => {
      const { env, requests, touched } = world();
      readLinkage(env, P, { force: true });
      const current = readLinkage(env, P, { force: true });
      const seen = touched();
      await requests[0]?.answer(outcome);
      expect(touched()).toBe(seen);
      expect(known(env.memory)).toEqual({
        linkage: null,
        refused: null,
        failed: false,
        reading: current,
      });
      expect(linkageIn(env, P)).toEqual({ known: false, reason: "loading" });
      expect(readLinkage(env, P)).toBe(current);
      expect(requests).toHaveLength(2);
      // A third forced read supersedes the second in turn; the second's answer is then nothing either.
      const third = readLinkage(env, P, { force: true });
      await requests[1]?.answer(linked(9, ME));
      expect(known(env.memory).reading).toBe(third);
      expect(linkageIn(env, P)).toEqual({ known: false, reason: "loading" });
      await requests[2]?.answer(linked(3, null));
      expect(linkageIn(env, P)).toMatchObject({
        kind: "unlinked",
        version: 3,
      });
      expect(env.memory.linkageReads.has(P)).toBe(false);
    });
  }
});

describe("the current read's refusals and failures stay what they are (DA20-06)", () => {
  test("a current refusal is not resurrected by an older linked answer", async () => {
    const { env, requests } = world();
    readLinkage(env, P);
    readLinkage(env, P, { force: true });
    await requests[1]?.answer({ ok: false, kind: "forbidden" });
    await requests[0]?.answer(linked(2, ME));
    expect(linkageIn(env, P)).toEqual({ known: false, reason: "refused" });
    expect(env.memory.linkage.has(P)).toBe(false);
  });

  test("a current refusal withdraws a known linkage; 'Try again' asks again and its answer clears the refusal", async () => {
    const { env, requests } = world();
    readLinkage(env, P);
    await requests[0]?.answer(linked(1, ME));
    readLinkage(env, P, { force: true });
    await requests[1]?.answer({ ok: false, kind: "not_found" });
    expect(linkageIn(env, P)).toEqual({ known: false, reason: "refused" });
    readLinkage(env, P, { force: true });
    expect(linkageIn(env, P)).toEqual({ known: false, reason: "loading" });
    await requests[2]?.answer(linked(2, null));
    expect(known(env.memory)).toMatchObject({
      refused: null,
      failed: false,
      reading: null,
    });
    expect(linkageIn(env, P)).toMatchObject({ kind: "unlinked" });
  });

  test("a current transient failure keeps the known answer shown (the cache policy is unchanged); a later answer clears the failure", async () => {
    const { env, requests } = world();
    readLinkage(env, P);
    await requests[0]?.answer(linked(1, ME));
    readLinkage(env, P, { force: true });
    await requests[1]?.answer({ ok: false, kind: "uncertain" });
    expect(env.memory.failed.has(P)).toBe(true);
    expect(linkageIn(env, P)).toMatchObject({ kind: "self", version: 1 });
    readLinkage(env, P, { force: true });
    expect(env.memory.failed.has(P)).toBe(false);
    await requests[2]?.answer(linked(2, null));
    expect(known(env.memory)).toMatchObject({ failed: false, reading: null });
    expect(linkageIn(env, P)).toMatchObject({ kind: "unlinked" });
  });

  test("a current transient failure with nothing known: failed, and 'Try again' is a new current read", async () => {
    const { env, requests } = world();
    readLinkage(env, P);
    await requests[0]?.answer({ ok: false, kind: "not_sent" });
    expect(linkageIn(env, P)).toEqual({ known: false, reason: "failed" });
    readLinkage(env, P, { force: true });
    expect(linkageIn(env, P)).toEqual({ known: false, reason: "loading" });
    await requests[1]?.answer(linked(1, ME));
    expect(linkageIn(env, P)).toMatchObject({ kind: "self" });
  });
});

describe("a read that cannot start supersedes nothing (offline)", () => {
  test("offline 'Try again' keeps the refusal and asks nothing", () => {
    const { env, requests } = world();
    env.memory.refused.set(P, "forbidden");
    env.online = false;
    expect(readLinkage(env, P, { force: true })).toBeNull();
    expect(env.memory.refused.get(P)).toBe("forbidden");
    expect(requests).toHaveLength(0);
    env.online = true;
    expect(readLinkage(env, P, { force: true })).not.toBeNull();
    expect(env.memory.refused.has(P)).toBe(false);
  });

  test("an offline forced read leaves the read on its way the current one", async () => {
    const { env, requests } = world();
    const reading = readLinkage(env, P);
    env.online = false;
    expect(readLinkage(env, P, { force: true })).toBeNull();
    expect(env.memory.linkageReads.get(P)).toBe(reading);
    await requests[0]?.answer(linked(3, null));
    expect(linkageIn(env, P)).toMatchObject({ kind: "unlinked" });
  });
});

describe("another identity's memory is never touched (DA20-07)", () => {
  test("a read answering after the account changed changes neither memory", async () => {
    const first = world("acct:1#1");
    readLinkage(first.env, P);
    const second = world("acct:2#1");
    await first.requests[0]?.answer(linked(1, ME));
    expect(known(second.env.memory)).toEqual({
      linkage: null,
      refused: null,
      failed: false,
      reading: null,
    });
    expect(first.env.memory.linkage.has(P)).toBe(false);
  });

  test("A→B→A: the first memory's read never answers into the new memory of the same account", async () => {
    const first = world("acct:1#1");
    readLinkage(first.env, P);
    world("acct:2#1");
    const again = world("acct:1#1");
    expect(again.env.memory).not.toBe(first.env.memory);
    await first.requests[0]?.answer(linked(1, ME));
    expect(again.env.memory.linkage.has(P)).toBe(false);
    expect(linkageIn(again.env, P)).toEqual({
      known: false,
      reason: "loading",
    });
  });

  test("a later epoch of the same account: the old epoch's read changes nothing", async () => {
    const first = world("acct:1#1");
    readLinkage(first.env, P);
    const later = world("acct:1#2");
    await first.requests[0]?.answer(linked(1, ME));
    expect(later.env.memory.linkage.has(P)).toBe(false);
  });

  test("an env of a superseded identity asks nothing at all", () => {
    const first = world("acct:1#1");
    world("acct:2#1");
    expect(readLinkage(first.env, P)).toBeNull();
    expect(readLinkage(first.env, P, { force: true })).toBeNull();
    expect(first.requests).toHaveLength(0);
  });

  test("control: the same identity keeps its memory, and a read on its way answers into it", async () => {
    const first = world("acct:1#1");
    readLinkage(first.env, P);
    const remounted = world("acct:1#1");
    expect(remounted.env.memory).toBe(first.env.memory);
    expect(readLinkage(remounted.env, P)).toBe(
      first.env.memory.linkageReads.get(P),
    );
    await first.requests[0]?.answer(linked(3, null));
    expect(linkageIn(remounted.env, P)).toMatchObject({ kind: "unlinked" });
  });
});
