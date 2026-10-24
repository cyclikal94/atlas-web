// @vitest-environment node
import { describe, expect, test } from "vitest";
import * as commands from "../../../src/features/tasks/model/commands";
import type { TaskDefinition } from "../../../src/features/tasks/model/contract";
import { resolveWallTime } from "../../../src/features/tasks/model/time";
import { outboxWorld } from "../../support/data/outbox-world";
import { cacheRow } from "../../support/data/rows";
import { record as defaultsRecord, ME } from "../../support/data/sharing";

/**
 * The queued task commands (A7, A8, A16; DES 3158-3242): each builder through the PRODUCTION enqueue plan over the IndexedDB double, so
 * the stored header (kind, targets, bases, bumps, review block) and the version records are what the real outbox writes.
 */
const TASK = "70000000-0000-4000-8000-000000000011";
const EXEC = "70000000-0000-4000-8000-000000000012";
const OCC = "4cc26047-d75e-5cb3-ad46-fe81937bde57";
const PROG = "70000000-0000-4000-8000-000000000014";
const OTHER_PROG = "70000000-0000-4000-8000-000000000015";
const ENTRY = "70000000-0000-4000-8000-000000000013";

const definition: TaskDefinition = {
  schedule: {
    start_date: "2026-09-08",
    time: null,
    timezone: "Europe/Vienna",
    repeat: { frequency: "daily", interval: 1 },
  },
  goal: { kind: "checkbox" },
  carry: "close_incomplete",
  participation: "personal",
  open_days_before: 0,
  close_days_after: 1,
  allow_streak_exclusions: false,
};

async function world() {
  const w = await outboxWorld();
  return w;
}
const bodyOf = (w: Awaited<ReturnType<typeof world>>, localId: string) =>
  (
    w.rows("draft_commands") as Array<{
      local_id: string;
      command: Record<string, unknown>;
    }>
  ).find((r) => r.local_id === localId)?.command as {
    command: Record<string, unknown>;
    defaults_revision?: string;
  };

describe("create_task then an immediate record (TASK-26, TASK-27 #1)", () => {
  test("a create seeds task, details, first occurrence and my progress at 1; a checkbox record depends on it and expects version 1", async () => {
    const w = await world();
    const created = await w.outbox.enqueue(
      commands.createTask({
        taskId: TASK,
        executionId: EXEC,
        occurrenceId: OCC,
        progressId: PROG,
        title: "Brush your teeth",
        definition,
        sharing: "only_me",
        defaults: defaultsRecord(),
      }),
    );
    expect(created.kind).toBe("queued");
    const recorded = await w.outbox.enqueue(
      commands.record({
        occurrenceId: OCC,
        progressId: PROG,
        me: ME,
        entryId: ENTRY,
        evidence: { kind: "checkbox", complete: true },
        happenedAt: 1788861600,
        replaces: null,
        firstAnyoneStream: false,
        defaults: null,
      }),
    );
    expect(recorded.kind).toBe("queued");
    const [create, rec] = [...w.drafts()].sort(
      (a, b) => a.created_seq - b.created_seq,
    );
    expect(create?.kind).toBe("create_task");
    expect(create?.target_resource_ids).toEqual([TASK, EXEC, OCC, PROG]);
    expect(create?.bumped).toEqual([]);
    expect(rec?.kind).toBe("record");
    expect(rec?.depends_on).toEqual([create?.local_id]);
    expect(rec?.expected_version).toBe(1);
    const versions = Object.fromEntries(
      w.versions().map((v) => [v.resource_id, v.locally_assumed_version]),
    );
    expect(versions).toMatchObject({
      [TASK]: 1,
      [EXEC]: 1,
      [OCC]: 1,
      [PROG]: 2,
    });
    const body = bodyOf(w, rec?.local_id as string);
    expect(body.command).toEqual({
      kind: "record",
      occurrence_id: OCC,
      subject_account_id: ME,
      entry_id: ENTRY,
      evidence: { kind: "checkbox", complete: true },
      expected_version: 1,
      happened_at: 1788861600,
    });
    // "Only me" is an explicit empty policy, still queueable on /task-commands; the progress defaults are captured.
    const createBody = bodyOf(w, create?.local_id as string);
    expect(createBody.command.initial_policy).toEqual({
      grants: [],
      exclude_accounts: [],
    });
    expect(typeof createBody.defaults_revision).toBe("string");
  });

  test("a create captured from defaults never fetched is held for review (progress always; task with 'Use my defaults')", async () => {
    const w = await world();
    await w.outbox.enqueue(
      commands.createTask({
        taskId: TASK,
        executionId: EXEC,
        occurrenceId: null,
        progressId: null,
        title: "T",
        definition,
        sharing: "only_me",
        defaults: null,
      }),
    );
    expect(w.drafts()[0]?.review_block).toEqual({
      kind: "defaults",
      kinds: ["progress"],
    });
    const v = await world();
    await v.outbox.enqueue(
      commands.createTask({
        taskId: TASK,
        executionId: EXEC,
        occurrenceId: null,
        progressId: null,
        title: "T",
        definition,
        sharing: "defaults",
        defaults: null,
      }),
    );
    expect(v.drafts()[0]?.review_block).toEqual({
      kind: "defaults",
      kinds: ["task", "progress"],
    });
    expect(
      bodyOf(v, v.drafts()[0]?.local_id as string).command.initial_policy,
    ).toBeUndefined();
  });
});

describe("record preconditions (TASK-12/12a)", () => {
  test("a quantity raises my stream as a side effect and sends no expected_version; a correction does the same", async () => {
    const w = await world();
    w.put("cache", [
      cacheRow({ id: PROG, kind: "progress", version: 4 }),
      cacheRow({ id: OCC, kind: "occurrence", version: 2 }),
    ]);
    await w.outbox.enqueue(
      commands.record({
        occurrenceId: OCC,
        progressId: PROG,
        me: ME,
        entryId: ENTRY,
        evidence: { kind: "quantity", amount: "2" },
        happenedAt: 10,
        replaces: null,
        firstAnyoneStream: false,
        defaults: null,
      }),
    );
    await w.outbox.enqueue(
      commands.record({
        occurrenceId: OCC,
        progressId: PROG,
        me: ME,
        entryId: OTHER_PROG,
        evidence: { kind: "checkbox", complete: true },
        happenedAt: 11,
        replaces: ENTRY,
        firstAnyoneStream: false,
        defaults: null,
      }),
    );
    const [first, second] = [...w.drafts()].sort(
      (a, b) => a.created_seq - b.created_seq,
    );
    expect(first?.expected_version).toBeUndefined();
    expect(first?.side_effect_bases).toEqual({ [PROG]: 4 });
    expect(
      bodyOf(w, first?.local_id as string).command.expected_version,
    ).toBeUndefined();
    expect(bodyOf(w, second?.local_id as string).command).toMatchObject({
      replaces: ENTRY,
    });
    expect(
      bodyOf(w, second?.local_id as string).command.expected_version,
    ).toBeUndefined();
    expect(
      Object.fromEntries(
        w.versions().map((v) => [v.resource_id, v.locally_assumed_version]),
      )[PROG],
    ).toBe(6);
  });

  test("a checkbox record with no base anywhere is refused `no_base`; an Anyone first stream is seeded at 1 and captures progress", async () => {
    const w = await world();
    const refused = await w.outbox.enqueue(
      commands.record({
        occurrenceId: OCC,
        progressId: PROG,
        me: ME,
        entryId: ENTRY,
        evidence: { kind: "checkbox", complete: true },
        happenedAt: 1,
        replaces: null,
        firstAnyoneStream: false,
        defaults: null,
      }),
    );
    expect(refused).toEqual({ kind: "refused", reason: "no_base" });
    const ok = await w.outbox.enqueue(
      commands.record({
        occurrenceId: OCC,
        progressId: PROG,
        me: ME,
        entryId: ENTRY,
        evidence: { kind: "checkbox", complete: true },
        happenedAt: 1,
        replaces: null,
        firstAnyoneStream: true,
        defaults: null,
      }),
    );
    expect(ok.kind).toBe("queued");
    expect(w.drafts()[0]?.expected_version).toBe(1);
    expect(w.drafts()[0]?.review_block).toEqual({
      kind: "defaults",
      kinds: ["progress"],
    });
  });
});

describe("version bases of the other commands", () => {
  test("revise_task: the task's version and its policy_version; the details are raised", async () => {
    const w = await world();
    w.put("cache", [
      cacheRow({ id: TASK, kind: "task", version: 3, policy_version: 7 }),
      cacheRow({ id: EXEC, kind: "execution", version: 5 }),
    ]);
    await w.outbox.enqueue(
      commands.reviseTask({
        taskId: TASK,
        executionId: EXEC,
        title: "New",
        definition,
        policyVersion: 7,
      }),
    );
    const d = w.drafts()[0];
    expect(bodyOf(w, d?.local_id as string).command).toMatchObject({
      kind: "revise_task",
      expected_version: 3,
      expected_policy_version: 7,
      title: "New",
    });
    expect(d?.side_effect_bases).toEqual({ [EXEC]: 5 });
    expect(d?.display_patch?.[TASK]).toEqual({ label: "New" });
  });

  test("exclude is checked against MY PROGRESS version, resolve and archive against the occurrence's and the task's", async () => {
    const w = await world();
    w.put("cache", [
      cacheRow({ id: PROG, kind: "progress", version: 9 }),
      cacheRow({ id: OCC, kind: "occurrence", version: 2 }),
      cacheRow({ id: TASK, kind: "task", version: 4 }),
    ]);
    await w.outbox.enqueue(
      commands.exclude({ occurrenceId: OCC, progressId: PROG, excluded: true }),
    );
    await w.outbox.enqueue(
      commands.resolve({ occurrenceId: OCC, resolved: true }),
    );
    await w.outbox.enqueue(commands.archive({ taskId: TASK, archived: true }));
    const [ex, re, ar] = [...w.drafts()].sort(
      (a, b) => a.created_seq - b.created_seq,
    );
    expect(bodyOf(w, ex?.local_id as string).command).toMatchObject({
      kind: "exclude",
      expected_version: 9,
      excluded: true,
    });
    expect(bodyOf(w, re?.local_id as string).command).toMatchObject({
      kind: "resolve",
      expected_version: 2,
      resolved: true,
    });
    expect(bodyOf(w, ar?.local_id as string).command).toMatchObject({
      kind: "archive",
      expected_version: 4,
      archived: true,
    });
    expect(ar?.display_patch?.[TASK]).toEqual({ archived: true });
  });

  test("revise_occurrence: the occurrence's version, and EVERY known progress stream raised; the key is kept", async () => {
    const w = await world();
    w.put("cache", [
      cacheRow({ id: OCC, kind: "occurrence", version: 2 }),
      cacheRow({ id: PROG, kind: "progress", version: 3 }),
      cacheRow({ id: OTHER_PROG, kind: "progress", version: 6 }),
    ]);
    const current = {
      task_id: TASK,
      definition,
      slot: {
        key: "2026-09-08Tdate",
        date: "2026-09-08",
        intended_time: null,
        timezone: "Europe/Vienna",
        instant: null,
      },
      opens_at: 0,
      closes_at: 1,
      participants: [ME],
      covered_by: null,
      resolved: false,
    };
    await w.outbox.enqueue(
      commands.reviseOccurrence(
        {
          occurrenceId: OCC,
          current,
          definition,
          date: "2026-09-09",
          time: "07:30:00",
          progressIds: [PROG, OTHER_PROG],
        },
        resolveWallTime,
      ),
    );
    const d = w.drafts()[0];
    expect(bodyOf(w, d?.local_id as string).command).toMatchObject({
      kind: "revise_occurrence",
      expected_version: 2,
      date: "2026-09-09",
      time: "07:30:00",
    });
    expect(d?.side_effect_bases).toEqual({ [PROG]: 3, [OTHER_PROG]: 6 });
    const patch = d?.display_patch?.[OCC]?.value as {
      slot: { key: string; date: string };
    };
    expect(patch.slot).toMatchObject({
      key: "2026-09-08Tdate",
      date: "2026-09-09",
    });
  });
});

describe("reading drafts back", () => {
  test("pendingEvidenceOf reads only MY records", () => {
    const draft = {
      kind: "record",
      command: {
        command: {
          kind: "record",
          occurrence_id: OCC,
          subject_account_id: ME,
          entry_id: ENTRY,
          evidence: { kind: "observe" },
          happened_at: 5,
        },
      },
    };
    expect(commands.pendingEvidenceOf(draft as never, ME)).toEqual({
      occurrenceId: OCC,
      entryId: ENTRY,
      evidence: { kind: "observe" },
      happenedAt: 5,
      replaces: null,
    });
    expect(commands.pendingEvidenceOf(draft as never, TASK)).toBeNull();
    expect(
      commands.pendingEvidenceOf({ ...draft, kind: "exclude" } as never, ME),
    ).toBeNull();
  });
});
