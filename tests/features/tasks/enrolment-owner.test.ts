/**
 * WEB-10a revision 12 (R23/R25; design assessment I2-I8, C1-C3, C5, C6, Q9, Q10, Q14, Q15): the page owner of a task's enrolment change
 * and unsaved draft (`memory.ts`), on its own. A draft ends ONLY when a success acknowledged exactly its session and revision and a current
 * read followed (or on Discard, a refused read of the enrolment, another identity); never by being sent, refused, uncertain or by a version
 * that moved. Late answers and reads cannot reach another identity, a later cycle or a later session. Nothing held is evicted to make room.
 */
import { afterEach, describe, expect, test } from "vitest";
import type { Policy } from "../../../src/data";
import type { EnrolCommand } from "../../../src/features/tasks/api";
import {
  answerEnrolment,
  askEnrolment,
  discardEnrolmentDraft,
  editEnrolmentDraft,
  enrolmentAttemptOf,
  enrolmentDraftOf,
  enrolmentFull,
  enrolmentLock,
  forgetTaskMemory,
  noteRefusal,
  openEnrolmentDraft,
  settleEnrolment,
  startEnrolment,
  subscribeEnrolment,
} from "../../../src/features/tasks/memory";
import type { Enrolment } from "../../../src/features/tasks/model/contract";

afterEach(() => forgetTaskMemory());

const ME = "me:1";
const TASK = "task-a";
const PRIVATE: Policy = { grants: [], exclude_accounts: [] };
const GRANT: Policy = {
  grants: [{ kind: "account", id: "third", edit: false }],
  exclude_accounts: [],
};
const base = (version: number): Enrolment => ({
  version,
  active: true,
  aggregate_consent: true,
  policy: PRIVATE,
});
const command = (policy: Policy, version = 7): EnrolCommand => ({
  kind: "enrol",
  task_id: TASK,
  expected_version: version,
  active: true,
  aggregate_consent: true,
  initial_policy: policy,
});
let keys = 0;
const newKey = () => {
  keys += 1;
  return `key-${keys}`;
};

/** An edited draft of TASK at `version`, its policy `policy`: its ticket. */
function drafted(policy: Policy, version = 7, task = TASK) {
  expect(editEnrolmentDraft(ME, task, base(version), PRIVATE, { policy })).toBe(
    true,
  );
  const d = enrolmentDraftOf(ME, task);
  if (d === null) throw new Error("no draft");
  return { session: d.session, revision: d.revision };
}

/** A whole cycle: the change sent and answered `outcome`, then a read asked after it answered with `shown`. */
function cycle(
  sent: EnrolCommand,
  outcome: "saved" | "refused" | "uncertain",
  shown: Enrolment,
  ticket: { session: number; revision: number } | null = null,
) {
  const attempt = startEnrolment(ME, TASK, sent, newKey, ticket);
  if (attempt === null) throw new Error("not admitted");
  settleEnrolment(ME, TASK, attempt, outcome);
  const read = askEnrolment(ME, TASK);
  expect(answerEnrolment(ME, TASK, read, shown)).toBe("current");
  expect(enrolmentLock(ME, TASK)).toBeNull();
  return attempt;
}

describe("acknowledgement (I4): only a success for the exact session and revision, then the current read, ends a draft", () => {
  test("success: the draft submitted ends at the read that follows (not at the answer)", () => {
    const ticket = drafted(GRANT);
    const attempt = startEnrolment(ME, TASK, command(GRANT), newKey, ticket);
    expect(attempt?.ticket).toEqual(ticket);
    settleEnrolment(ME, TASK, attempt as never, "saved");
    expect(enrolmentDraftOf(ME, TASK)).not.toBeNull();
    const read = askEnrolment(ME, TASK);
    answerEnrolment(ME, TASK, read, { ...base(8), policy: GRANT });
    expect(enrolmentDraftOf(ME, TASK)).toBeNull();
  });

  for (const outcome of ["refused", "uncertain"] as const)
    for (const version of [7, 8])
      test(`${outcome}, the read at version ${version}: the draft is kept, unchanged`, () => {
        const ticket = drafted(GRANT);
        const before = enrolmentDraftOf(ME, TASK);
        cycle(command(GRANT), outcome, base(version), ticket);
        expect(enrolmentDraftOf(ME, TASK)).toEqual(before);
      });

  test("a failed read after a success keeps the draft and the cycle; the next current read ends both", () => {
    const ticket = drafted(GRANT);
    const attempt = startEnrolment(ME, TASK, command(GRANT), newKey, ticket);
    settleEnrolment(ME, TASK, attempt as never, "saved");
    expect(answerEnrolment(ME, TASK, askEnrolment(ME, TASK), null)).toBe(
      "current",
    );
    expect(enrolmentLock(ME, TASK)?.phase).toBe("reading");
    expect(enrolmentDraftOf(ME, TASK)).not.toBeNull();
    answerEnrolment(ME, TASK, askEnrolment(ME, TASK), base(8));
    expect(enrolmentLock(ME, TASK)).toBeNull();
    expect(enrolmentDraftOf(ME, TASK)).toBeNull();
  });

  test("a read asked while the change was sent (early) acknowledges nothing", () => {
    const ticket = drafted(GRANT);
    const attempt = startEnrolment(ME, TASK, command(GRANT), newKey, ticket);
    const early = askEnrolment(ME, TASK);
    settleEnrolment(ME, TASK, attempt as never, "saved");
    expect(answerEnrolment(ME, TASK, early, base(8))).toBe("early");
    expect(enrolmentDraftOf(ME, TASK)).not.toBeNull();
    expect(enrolmentLock(ME, TASK)?.phase).toBe("reading");
  });

  test("Leave/consent (no ticket) acknowledges no audience draft; an editor opened with nothing in it ends at another version", () => {
    drafted(GRANT);
    const before = enrolmentDraftOf(ME, TASK);
    cycle(command(PRIVATE), "saved", base(8));
    expect(enrolmentDraftOf(ME, TASK)).toEqual(before);
    forgetTaskMemory();
    expect(openEnrolmentDraft(ME, TASK, base(7))).toBe(true);
    cycle(command(PRIVATE), "saved", base(7));
    expect(enrolmentDraftOf(ME, TASK)?.revision).toBe(0);
    cycle(command(PRIVATE), "saved", base(8));
    expect(enrolmentDraftOf(ME, TASK)).toBeNull();
  });
});

describe("Q9: tickets name a session and a revision; a retry submits what it submitted", () => {
  test("a later revision survives the success of the revision before it", () => {
    const first = drafted(GRANT);
    const attempt = startEnrolment(ME, TASK, command(GRANT), newKey, first);
    settleEnrolment(ME, TASK, attempt as never, "uncertain");
    answerEnrolment(ME, TASK, askEnrolment(ME, TASK), base(7));
    drafted(PRIVATE);
    const later = enrolmentDraftOf(ME, TASK);
    expect(later?.revision).toBe(first.revision + 1);
    // Try again: the held command, no ticket given: it carries the old one, and the old key.
    const retry = cycle(
      enrolmentAttemptOf(ME, TASK)?.command as EnrolCommand,
      "saved",
      base(8),
    );
    expect(retry.ticket).toEqual(first);
    expect(retry.key).toBe(attempt?.key);
    expect(enrolmentDraftOf(ME, TASK)).toEqual(later);
  });

  test("another session with the same revision and values survives the old session's success", () => {
    const first = drafted(GRANT);
    const attempt = startEnrolment(ME, TASK, command(GRANT), newKey, first);
    settleEnrolment(ME, TASK, attempt as never, "uncertain");
    answerEnrolment(ME, TASK, askEnrolment(ME, TASK), base(7));
    discardEnrolmentDraft(ME, TASK, first.session);
    expect(enrolmentDraftOf(ME, TASK)).toBeNull();
    const second = drafted(GRANT);
    expect(second.session).not.toBe(first.session);
    expect(second.revision).toBe(first.revision);
    cycle(attempt?.command as EnrolCommand, "saved", base(8));
    expect(enrolmentDraftOf(ME, TASK)?.session).toBe(second.session);
  });

  test("an explicit Save of the same body names its own (current) ticket, keeping the uncertain key", () => {
    const first = drafted(GRANT);
    const attempt = startEnrolment(ME, TASK, command(GRANT), newKey, first);
    settleEnrolment(ME, TASK, attempt as never, "uncertain");
    answerEnrolment(ME, TASK, askEnrolment(ME, TASK), base(7));
    drafted(PRIVATE);
    const now = drafted(GRANT);
    const again = cycle(command(GRANT), "saved", base(8), now);
    expect(again.key).toBe(attempt?.key);
    expect(again.ticket).toEqual(now);
    expect(enrolmentDraftOf(ME, TASK)).toBeNull();
  });

  test("Discard ends only its own session, and nothing while a change is sent or confirmed", () => {
    const first = drafted(GRANT);
    discardEnrolmentDraft(ME, TASK, first.session + 1);
    expect(enrolmentDraftOf(ME, TASK)).not.toBeNull();
    const attempt = startEnrolment(ME, TASK, command(GRANT), newKey, first);
    discardEnrolmentDraft(ME, TASK, first.session);
    expect(enrolmentDraftOf(ME, TASK)).not.toBeNull();
    settleEnrolment(ME, TASK, attempt as never, "refused");
    discardEnrolmentDraft(ME, TASK, first.session);
    expect(enrolmentDraftOf(ME, TASK)).not.toBeNull();
    answerEnrolment(ME, TASK, askEnrolment(ME, TASK), base(8));
    discardEnrolmentDraft(ME, TASK, first.session);
    expect(enrolmentDraftOf(ME, TASK)).toBeNull();
  });

  test("sessions are never reused, not even after the page memory is forgotten", () => {
    const first = drafted(GRANT);
    forgetTaskMemory();
    expect(drafted(GRANT).session).toBeGreaterThan(first.session);
  });
});

describe("I6/C5: edits and openings are admitted when they happen; a kept draft is never edited or replaced", () => {
  test("nothing is edited or opened while a change is sent or confirmed", () => {
    const ticket = drafted(GRANT);
    const before = enrolmentDraftOf(ME, TASK);
    const attempt = startEnrolment(ME, TASK, command(GRANT), newKey, ticket);
    expect(
      editEnrolmentDraft(ME, TASK, base(7), PRIVATE, { policy: PRIVATE }),
    ).toBe(false);
    expect(openEnrolmentDraft(ME, TASK, base(7))).toBe(false);
    settleEnrolment(ME, TASK, attempt as never, "refused");
    expect(
      editEnrolmentDraft(ME, TASK, base(7), PRIVATE, { consent: false }),
    ).toBe(false);
    expect(enrolmentDraftOf(ME, TASK)).toEqual(before);
  });

  test("a draft of another version is never edited, and an edited draft is never replaced by an opening", () => {
    drafted(GRANT, 7);
    const before = enrolmentDraftOf(ME, TASK);
    expect(
      editEnrolmentDraft(ME, TASK, base(8), PRIVATE, { policy: PRIVATE }),
    ).toBe(false);
    expect(openEnrolmentDraft(ME, TASK, base(8))).toBe(false);
    expect(enrolmentDraftOf(ME, TASK)).toEqual(before);
  });

  test("the draft is a frozen copy: nothing the caller holds can change it", () => {
    const policy = clonePolicy(GRANT);
    editEnrolmentDraft(ME, TASK, base(7), PRIVATE, { policy });
    policy.grants.push({ kind: "account", id: "late", edit: true });
    expect(enrolmentDraftOf(ME, TASK)?.policy).toEqual(GRANT);
    expect(Object.isFrozen(enrolmentDraftOf(ME, TASK)?.policy.grants)).toBe(
      true,
    );
  });
});

describe("Q6/Q14: a refused read of the enrolment and another identity remove the draft; late answers reach no other owner", () => {
  test("a 403/404 of the enrolment read removes its draft only (another task's stays)", () => {
    drafted(GRANT);
    drafted(GRANT, 7, "task-b");
    noteRefusal(ME, `journal:${TASK}`, "forbidden");
    expect(enrolmentDraftOf(ME, TASK)).not.toBeNull();
    noteRefusal(ME, `enrolment:${TASK}`, "not_found");
    expect(enrolmentDraftOf(ME, TASK)).toBeNull();
    expect(enrolmentDraftOf(ME, "task-b")).not.toBeNull();
  });

  test("another identity starts with nothing; the first identity's late answer and read change nothing of it", () => {
    const ticket = drafted(GRANT);
    const attempt = startEnrolment(ME, TASK, command(GRANT), newKey, ticket);
    const read = askEnrolment(ME, TASK);
    const theirs = (() => {
      expect(
        editEnrolmentDraft("them:1", TASK, base(7), PRIVATE, {
          policy: GRANT,
        }),
      ).toBe(true);
      return enrolmentDraftOf("them:1", TASK);
    })();
    settleEnrolment(ME, TASK, attempt as never, "saved");
    expect(answerEnrolment(ME, TASK, read, base(8))).toBe("outdated");
    expect(enrolmentDraftOf("them:1", TASK)).toEqual(theirs);
    expect(enrolmentLock("them:1", TASK)).toBeNull();
    expect(enrolmentDraftOf(ME, TASK)).toBeNull();
    expect(enrolmentAttemptOf(ME, TASK)).toBeNull();
  });
});

describe("Q15 (I8/C6): a full page refuses new work; nothing held is evicted; only neutral cycles are reclaimed", () => {
  test("at capacity a NEW task's draft, opening and change are refused; held ones are kept and keep working", () => {
    forgetTaskMemory(2);
    drafted(GRANT, 7, "a");
    drafted(GRANT, 7, "b");
    expect(enrolmentFull(ME, "c")).toBe(true);
    expect(enrolmentFull(ME, "a")).toBe(false);
    expect(
      editEnrolmentDraft(ME, "c", base(7), PRIVATE, { policy: GRANT }),
    ).toBe(false);
    expect(openEnrolmentDraft(ME, "c", base(7))).toBe(false);
    expect(
      startEnrolment(ME, "c", { ...command(GRANT), task_id: "c" }, newKey),
    ).toBeNull();
    expect(enrolmentDraftOf(ME, "a")).not.toBeNull();
    expect(enrolmentDraftOf(ME, "b")).not.toBeNull();
    expect(
      editEnrolmentDraft(ME, "a", base(7), PRIVATE, { policy: PRIVATE }),
    ).toBe(true);
    // Room again (one discarded): the new task is admitted.
    discardEnrolmentDraft(
      ME,
      "b",
      enrolmentDraftOf(ME, "b")?.session as number,
    );
    expect(
      editEnrolmentDraft(ME, "c", base(7), PRIVATE, { policy: GRANT }),
    ).toBe(true);
  });

  test("an unconfirmed cycle is never reclaimed: its lock stays while neutral cycles beyond the limit are dropped", () => {
    forgetTaskMemory(2);
    const attempt = startEnrolment(
      ME,
      "locked",
      { ...command(GRANT), task_id: "locked" },
      newKey,
    );
    settleEnrolment(ME, "locked", attempt as never, "refused");
    expect(enrolmentLock(ME, "locked")?.phase).toBe("reading");
    for (const id of ["n1", "n2", "n3", "n4"]) askEnrolment(ME, id);
    expect(enrolmentLock(ME, "locked")?.phase).toBe("reading");
    answerEnrolment(ME, "locked", askEnrolment(ME, "locked"), base(8));
    expect(enrolmentLock(ME, "locked")).toBeNull();
  });

  test("control: subscribers hear every change of the owner, and stop hearing once unsubscribed", () => {
    let heard = 0;
    const stop = subscribeEnrolment(() => {
      heard += 1;
    });
    drafted(GRANT);
    expect(heard).toBe(1);
    stop();
    drafted(PRIVATE);
    expect(heard).toBe(1);
  });
});

function clonePolicy(policy: Policy): Policy {
  return JSON.parse(JSON.stringify(policy)) as Policy;
}
