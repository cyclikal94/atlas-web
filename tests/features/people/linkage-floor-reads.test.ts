// @vitest-environment node
import { beforeEach, describe, expect, test } from "vitest";
import type {
  PeopleResult,
  PersonDetailAnswer,
} from "../../../src/features/people/api";
import type { usePeopleEnv } from "../../../src/features/people/env";
import {
  forgetAllPeopleMemory,
  notePersonVersion,
  type PeopleMemory,
  peopleMemory,
  personFloor,
} from "../../../src/features/people/memory";
import {
  currentLinkage,
  type LinkageState,
} from "../../../src/features/people/model/linkage";
import { linkageIn, readLinkage } from "../../../src/features/people/reads";

/**
 * Review 25, R25.1 (DA25-02, DA25-04..07): a linkage answer is current only at the latest version of the person this page knows
 * (`personFloor`: the linkage answers, the synced row and the summaries). The floor never goes back; an out-of-date answer is read again
 * ONCE for each later version (an answer still older stops; a later version, a failure's reconnection or Try again asks again); only the
 * read asked last changes anything (R20.1). Each answer is released by the test; every request is counted.
 */
const ME = "11111111-1111-4111-8111-111111111111";
const MO = "22222222-2222-4222-8222-222222222222";
const P = "55555555-5555-4555-8555-555555555555";
const Q = "77777777-7777-4777-8777-777777777777";
type Answer = PeopleResult<PersonDetailAnswer>;

const linked = (version: number, account: string | null, id = P): Answer => ({
  ok: true,
  value: {
    person: { id, label: `v${version}`, version } as never,
    linked_account_id: account,
  },
});

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
              await Promise.resolve();
              await Promise.resolve();
            },
          });
        }),
    },
  } as unknown as ReturnType<typeof usePeopleEnv> & { online: boolean };
  return { env, requests };
}

/** A summary of `id` at `version` was admitted (what `admitSummary` keeps). */
const summarised = (memory: PeopleMemory, id: string, version: number) =>
  memory.summaryFloors.set(id, { version, policyVersion: 1 });

const known = (
  kind: "self" | "other" | "unlinked",
  version: number,
): LinkageState => ({
  known: true,
  kind,
  accountId: kind === "self" ? ME : kind === "other" ? MO : null,
  version,
  readAt: 1,
});

beforeEach(() => forgetAllPeopleMemory());

describe("currentLinkage: an answer is current only at the latest version known (DA25-02)", () => {
  test.each([
    ["nothing kept", undefined, 0, null],
    ["an unknown state", { known: false, reason: "failed" } as const, 0, null],
    ["below the floor", known("other", 1), 2, null],
    ["at the floor", known("other", 2), 2, "other"],
    ["above the floor", known("unlinked", 3), 2, "unlinked"],
    ["self at the floor", known("self", 4), 4, "self"],
  ])("%s", (_name, kept, floor, kind) => {
    const current = currentLinkage(kept as LinkageState | undefined, floor);
    expect(current === null ? null : current.known && current.kind).toBe(kind);
  });
});

describe("personFloor never goes back (DA25-02, I2)", () => {
  test("the highest of the linkage answers, the synced row and the summaries; another person's is its own", () => {
    const { env } = world();
    const memory = env.memory;
    expect(personFloor(memory, P)).toBe(0);
    notePersonVersion(memory, P, 3);
    notePersonVersion(memory, P, 2);
    expect(personFloor(memory, P)).toBe(3);
    summarised(memory, P, 5);
    expect(personFloor(memory, P)).toBe(5);
    summarised(memory, Q, 9);
    expect(personFloor(memory, P)).toBe(5);
    // Reading the summaries again keeps their floors.
    memory.invalidateSummaries();
    expect(personFloor(memory, P)).toBe(5);
  });

  test("a refusal withdraws the answer, not the version known: a later answer of an earlier version is not current", async () => {
    const { env, requests } = world();
    readLinkage(env, P);
    await requests[0]?.answer(linked(3, MO));
    readLinkage(env, P, { force: true });
    await requests[1]?.answer({ ok: false, kind: "forbidden" });
    expect(env.memory.linkage.has(P)).toBe(false);
    expect(personFloor(env.memory, P)).toBe(3);
    readLinkage(env, P, { force: true });
    await requests[2]?.answer(linked(2, null));
    expect(linkageIn(env, P).known).toBe(false);
  });

  test("an answer of an earlier version never replaces the kept later one", async () => {
    const { env, requests } = world();
    readLinkage(env, P);
    await requests[0]?.answer(linked(3, null));
    readLinkage(env, P, { force: true });
    await requests[1]?.answer(linked(2, MO));
    expect(env.memory.linkage.get(P)?.state).toMatchObject({
      kind: "unlinked",
      version: 3,
    });
    expect(linkageIn(env, P)).toMatchObject({ kind: "unlinked", version: 3 });
  });

  test("A→B→A: a new memory knows no floor of the old one", () => {
    const first = world("acct:1#1");
    summarised(first.env.memory, P, 4);
    world("acct:2#1");
    const again = world("acct:1#1");
    expect(personFloor(again.env.memory, P)).toBe(0);
  });
});

describe("an out-of-date answer is withdrawn and read again once (DA25-04, DA25-05)", () => {
  test("withdrawn at once (never 'unlinked'), one read shared by every caller, and none after it answers", async () => {
    const { env, requests } = world();
    readLinkage(env, P);
    await requests[0]?.answer(linked(1, MO));
    summarised(env.memory, P, 2);
    expect(linkageIn(env, P)).toEqual({ known: false, reason: "loading" });
    const header = readLinkage(env, P);
    const editor = readLinkage(env, P);
    expect(header).not.toBeNull();
    expect(editor).toBe(header);
    expect(requests).toHaveLength(2);
    await requests[1]?.answer(linked(2, null));
    expect(linkageIn(env, P)).toMatchObject({ kind: "unlinked", version: 2 });
    expect(readLinkage(env, P)).toBeNull();
    expect(requests).toHaveLength(2);
  });

  test("offline: withdrawn, nothing asked; online again: one read", async () => {
    const { env, requests } = world();
    readLinkage(env, P);
    await requests[0]?.answer(linked(1, MO));
    summarised(env.memory, P, 2);
    env.online = false;
    expect(linkageIn(env, P)).toEqual({ known: false, reason: "offline" });
    expect(readLinkage(env, P)).toBeNull();
    expect(readLinkage(env, P, { force: true })).toBeNull();
    expect(requests).toHaveLength(1);
    env.online = true;
    expect(readLinkage(env, P)).not.toBeNull();
    expect(requests).toHaveLength(2);
  });

  test("an answer still older than the version it was asked at: not current, and not asked again by itself (no loop)", async () => {
    const { env, requests } = world();
    readLinkage(env, P);
    await requests[0]?.answer(linked(1, MO));
    summarised(env.memory, P, 2);
    readLinkage(env, P);
    await requests[1]?.answer(linked(1, MO));
    expect(linkageIn(env, P)).toEqual({ known: false, reason: "failed" });
    for (let i = 0; i < 5; i += 1) expect(readLinkage(env, P)).toBeNull();
    expect(requests).toHaveLength(2);
    // A later version asks once more; so does Try again.
    summarised(env.memory, P, 3);
    expect(linkageIn(env, P)).toEqual({ known: false, reason: "loading" });
    readLinkage(env, P);
    await requests[2]?.answer(linked(2, MO));
    expect(readLinkage(env, P)).toBeNull();
    expect(requests).toHaveLength(3);
    readLinkage(env, P, { force: true });
    await requests[3]?.answer(linked(3, MO));
    expect(linkageIn(env, P)).toMatchObject({ kind: "other", version: 3 });
    expect(requests).toHaveLength(4);
  });

  test("a later version while a read is on its way: the read is joined; an answer below it asks ONE catch-up at the latest version", async () => {
    const { env, requests } = world();
    readLinkage(env, P);
    await requests[0]?.answer(linked(1, MO));
    summarised(env.memory, P, 2);
    const asked = readLinkage(env, P);
    summarised(env.memory, P, 3);
    expect(linkageIn(env, P)).toEqual({ known: false, reason: "loading" });
    expect(readLinkage(env, P)).toBe(asked);
    await requests[1]?.answer(linked(2, null));
    expect(linkageIn(env, P)).toEqual({ known: false, reason: "loading" });
    readLinkage(env, P);
    expect(requests).toHaveLength(3);
    await requests[2]?.answer(linked(2, null));
    expect(linkageIn(env, P)).toEqual({ known: false, reason: "failed" });
    expect(readLinkage(env, P)).toBeNull();
    expect(requests).toHaveLength(3);
  });

  test("a later version while a read is on its way, answered AT it: current, nothing more asked", async () => {
    const { env, requests } = world();
    readLinkage(env, P);
    await requests[0]?.answer(linked(1, MO));
    summarised(env.memory, P, 2);
    readLinkage(env, P);
    summarised(env.memory, P, 3);
    await requests[1]?.answer(linked(3, null));
    expect(linkageIn(env, P)).toMatchObject({ kind: "unlinked", version: 3 });
    expect(readLinkage(env, P)).toBeNull();
    expect(requests).toHaveLength(2);
  });

  test("the synced row's version is a floor too (linkageIn's `synced`), never lowering one known", async () => {
    const { env, requests } = world();
    readLinkage(env, P);
    await requests[0]?.answer(linked(2, MO));
    expect(linkageIn(env, P, 2)).toMatchObject({ kind: "other" });
    expect(linkageIn(env, P, 1)).toMatchObject({ kind: "other" });
    expect(linkageIn(env, P, 3)).toEqual({ known: false, reason: "loading" });
    notePersonVersion(env.memory, P, 3);
    expect(readLinkage(env, P)).not.toBeNull();
    expect(requests).toHaveLength(2);
  });
});

describe("ownership and the floor are both required (DA25-06, DA25-07)", () => {
  test("a superseded read changes nothing, not even the floor, whatever version it answers; the current one at the floor is applied", async () => {
    const { env, requests } = world();
    readLinkage(env, P);
    readLinkage(env, P, { force: true });
    await requests[0]?.answer(linked(9, ME));
    expect(personFloor(env.memory, P)).toBe(0);
    expect(env.memory.linkage.has(P)).toBe(false);
    await requests[1]?.answer(linked(3, null));
    expect(linkageIn(env, P)).toMatchObject({ kind: "unlinked", version: 3 });
  });

  test("a refusal while out of date is remembered: no later version asks again by itself; Try again does", async () => {
    const { env, requests } = world();
    readLinkage(env, P);
    await requests[0]?.answer(linked(1, MO));
    summarised(env.memory, P, 2);
    readLinkage(env, P);
    await requests[1]?.answer({ ok: false, kind: "not_found" });
    expect(linkageIn(env, P)).toEqual({ known: false, reason: "refused" });
    summarised(env.memory, P, 3);
    expect(readLinkage(env, P)).toBeNull();
    expect(requests).toHaveLength(2);
    readLinkage(env, P, { force: true });
    await requests[2]?.answer(linked(3, null));
    expect(linkageIn(env, P)).toMatchObject({ kind: "unlinked" });
  });

  test.each([
    ["uncertain", { ok: false, kind: "uncertain" } as Answer],
    ["not sent", { ok: false, kind: "not_sent" } as Answer],
    ["closed", { ok: false, kind: "closed" } as Answer],
  ])(
    "a %s renewal: failed (never the old answer); the reconnection's ordinary call asks once",
    async (_name, outcome) => {
      const { env, requests } = world();
      readLinkage(env, P);
      await requests[0]?.answer(linked(1, MO));
      summarised(env.memory, P, 2);
      readLinkage(env, P);
      await requests[1]?.answer(outcome);
      expect(linkageIn(env, P)).toEqual({ known: false, reason: "failed" });
      readLinkage(env, P);
      expect(requests).toHaveLength(3);
      // ...and joins it while it is on its way.
      readLinkage(env, P);
      expect(requests).toHaveLength(3);
    },
  );

  test("control: a current answer at an unchanged version stays current after a transient failure (R20's cache policy)", async () => {
    const { env, requests } = world();
    readLinkage(env, P);
    await requests[0]?.answer(linked(1, MO));
    summarised(env.memory, P, 1);
    readLinkage(env, P, { force: true });
    await requests[1]?.answer({ ok: false, kind: "uncertain" });
    expect(linkageIn(env, P)).toMatchObject({ kind: "other", version: 1 });
    expect(readLinkage(env, P)).toBeNull();
  });

  test("another person's version and reads are its own", async () => {
    const { env, requests } = world();
    readLinkage(env, P);
    readLinkage(env, Q);
    await requests[0]?.answer(linked(1, MO));
    await requests[1]?.answer(linked(1, null, Q));
    summarised(env.memory, Q, 2);
    expect(linkageIn(env, P)).toMatchObject({ kind: "other" });
    expect(readLinkage(env, P)).toBeNull();
    expect(readLinkage(env, Q)).not.toBeNull();
    expect(requests.map((r) => r.id)).toEqual([P, Q, Q]);
  });
});
