// @vitest-environment node
import { beforeEach, describe, expect, test } from "vitest";
import type { PeopleResult } from "../../../src/features/people/api";
import type { PeopleEnv } from "../../../src/features/people/env";
import {
  forgetAllPeopleMemory,
  peopleMemory,
} from "../../../src/features/people/memory";
import {
  type Attempt,
  attemptVersion,
  canonicalBody,
  replayFor,
} from "../../../src/features/people/model/attempt";
import {
  renameProfileBody,
  unlinkBody,
} from "../../../src/features/people/model/commands";
import { replayOnline, sendOnline } from "../../../src/features/people/online";

/**
 * Review 26 (R26.1/R26.2; DA26-05/06/08): the retained uncertain attempt is chosen by what was SUBMITTED, at its own version, and is sent
 * again exactly — never with a new key or a body built from the person as read now. The sender keeps the existing outcome rules, never
 * overwrites a later attempt of the target, and does nothing more for an identity that is no longer current.
 */
const P = "55555555-5555-4555-8555-555555555555";
const Q = "77777777-7777-4777-8777-777777777777";
const rename = (version: number, name: string, personId = P) =>
  renameProfileBody({ personId, version, name });
const kept = (body: unknown, key = "k-original"): Attempt => ({
  key,
  body: canonicalBody(body),
});

beforeEach(() => forgetAllPeopleMemory());

describe("attemptVersion", () => {
  test("the version a command's body was made against", () => {
    expect(attemptVersion(kept(unlinkBody({ personId: P, version: 4 })))).toBe(
      4,
    );
    expect(attemptVersion(kept(rename(7, "Mo")))).toBe(7);
  });

  test("none for a body without one, or one that is not JSON", () => {
    expect(
      attemptVersion(kept({ command: { kind: "put_field", id: "f" } })),
    ).toBeNull();
    expect(attemptVersion({ key: "k", body: "not json" })).toBeNull();
    expect(
      attemptVersion(kept({ command: { expected_version: "3" } })),
    ).toBeNull();
  });
});

describe("replayFor", () => {
  test("nothing kept: nothing to replay", () => {
    expect(replayFor(null, (v) => rename(v, "Mo"))).toBeNull();
  });

  test("the same submission is the kept attempt itself, made at ITS version whatever version is read now", () => {
    const attempt = kept(rename(1, "Kieran L."));
    // The intent is asked at the attempt's own version (1), not the version the page knows now.
    const asked: number[] = [];
    const chosen = replayFor(attempt, (v) => {
      asked.push(v);
      return rename(v, "Kieran L.");
    });
    expect(chosen).toBe(attempt);
    expect(asked).toEqual([1]);
    const unlink = kept(unlinkBody({ personId: P, version: 2 }));
    expect(
      replayFor(unlink, (v) => unlinkBody({ personId: P, version: v })),
    ).toBe(unlink);
  });

  test("a changed name, another person or another command is not the kept attempt", () => {
    const attempt = kept(rename(1, "Kieran L."));
    expect(replayFor(attempt, (v) => rename(v, "Kieran Lane"))).toBeNull();
    expect(replayFor(attempt, (v) => rename(v, "Kieran L.", Q))).toBeNull();
    expect(
      replayFor(attempt, (v) => unlinkBody({ personId: P, version: v })),
    ).toBeNull();
    const unlink = kept(unlinkBody({ personId: P, version: 1 }));
    expect(
      replayFor(unlink, (v) => unlinkBody({ personId: Q, version: v })),
    ).toBeNull();
  });

  test("a kept body without a version is never replayed by this rule", () => {
    const create = kept({ command: { kind: "put_field", id: "f" } });
    expect(
      replayFor(create, () => ({ command: { kind: "put_field", id: "f" } })),
    ).toBeNull();
  });
});

type Result = PeopleResult<{ revision: number }>;
const envOf = (identity = "me:1") => {
  let n = 0;
  const memory = peopleMemory(identity);
  const env = {
    memory,
    newId: () => {
      n += 1;
      return `new-${n}`;
    },
  } as unknown as PeopleEnv;
  return { env, memory, newKeys: () => n };
};
const noSleep = async () => {};

describe("replayOnline", () => {
  test("sends the kept attempt exactly, makes no key, and a receipt ends it", async () => {
    const { env, memory, newKeys } = envOf();
    const attempt = kept(rename(1, "Kieran L."));
    memory.attempts.set(`rename:${P}`, attempt);
    const sent: Attempt[] = [];
    const result = await replayOnline(
      env,
      `rename:${P}`,
      attempt,
      async (a) => {
        sent.push(a);
        return { ok: true, value: { revision: 2 } } as Result;
      },
      noSleep,
    );
    expect(result.ok).toBe(true);
    expect(sent).toEqual([attempt]);
    expect(sent[0]).toBe(attempt);
    expect(newKeys()).toBe(0);
    expect(memory.attempts.has(`rename:${P}`)).toBe(false);
  });

  test("uncertain or not sent keeps it; a refusal ends it", async () => {
    const outcomes: Array<[Result, boolean]> = [
      [{ ok: false, kind: "uncertain" }, true],
      [{ ok: false, kind: "offline" }, true],
      [{ ok: false, kind: "closed" }, true],
      [{ ok: false, kind: "conflict" }, false],
      [{ ok: false, kind: "operation_conflict" }, false],
      [{ ok: false, kind: "forbidden" }, false],
    ];
    for (const [outcome, keeps] of outcomes) {
      const { env, memory } = envOf();
      const attempt = kept(unlinkBody({ personId: P, version: 1 }));
      memory.attempts.set(`unlink:${P}`, attempt);
      await replayOnline(env, `unlink:${P}`, attempt, async () => outcome);
      expect(memory.attempts.get(`unlink:${P}`) ?? null).toBe(
        keeps ? attempt : null,
      );
      forgetAllPeopleMemory();
    }
  });

  test("a not_sent is asked again quietly, a bounded number of times, always with the same attempt; then it is still kept", async () => {
    const { env, memory } = envOf();
    const attempt = kept(unlinkBody({ personId: P, version: 1 }));
    memory.attempts.set(`unlink:${P}`, attempt);
    const sent: Attempt[] = [];
    await replayOnline(
      env,
      `unlink:${P}`,
      attempt,
      async (a) => {
        sent.push(a);
        return { ok: false, kind: "not_sent" } as Result;
      },
      noSleep,
    );
    expect(sent).toHaveLength(7);
    expect(sent.every((a) => a === attempt)).toBe(true);
    expect(memory.attempts.get(`unlink:${P}`)).toBe(attempt);
  });

  test("the identity changes during a not_sent wait: nothing more is sent, and neither identity's attempts are touched", async () => {
    const { env, memory } = envOf("me:1");
    const attempt = kept(unlinkBody({ personId: P, version: 1 }));
    memory.attempts.set(`unlink:${P}`, attempt);
    let sends = 0;
    let other: ReturnType<typeof peopleMemory> | null = null;
    const result = await replayOnline(
      env,
      `unlink:${P}`,
      attempt,
      async () => {
        sends += 1;
        return { ok: false, kind: "not_sent" } as Result;
      },
      async () => {
        other = peopleMemory("you:1");
      },
    );
    expect(result).toEqual({ ok: false, kind: "not_sent" });
    expect(sends).toBe(1);
    expect(memory.attempts.get(`unlink:${P}`)).toBe(attempt);
    expect(
      (other as unknown as ReturnType<typeof peopleMemory>).attempts.size,
    ).toBe(0);
    // A → B → A: the first identity's page attempt is not brought back with it.
    expect(peopleMemory("me:1").attempts.size).toBe(0);
  });
});

describe("a send never overwrites a later attempt of its target", () => {
  test("an earlier send's late outcome leaves the attempt a later send made", async () => {
    const { env, memory } = envOf();
    let answer!: (result: Result) => void;
    const late = sendOnline(
      env,
      `rename:${P}`,
      rename(1, "A"),
      () =>
        new Promise<Result>((resolve) => {
          answer = resolve;
        }),
      noSleep,
    );
    const later = kept(rename(1, "B"), "k-later");
    memory.attempts.set(`rename:${P}`, later);
    answer({ ok: false, kind: "uncertain" });
    await late;
    expect(memory.attempts.get(`rename:${P}`)).toBe(later);
  });

  test("control: with nothing else in between, an uncertain send is kept under its own key and body", async () => {
    const { env, memory } = envOf();
    await sendOnline(
      env,
      `rename:${P}`,
      rename(1, "A"),
      async () => ({ ok: false, kind: "uncertain" }) as Result,
      noSleep,
    );
    expect(memory.attempts.get(`rename:${P}`)).toEqual({
      key: "new-1",
      body: canonicalBody(rename(1, "A")),
    });
  });
});
