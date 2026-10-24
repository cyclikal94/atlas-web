// @vitest-environment node
import { describe, expect, test } from "vitest";
import type {
  CacheRow,
  DraftWithCommand,
  EnqueueRequest,
} from "../../../src/data";
import {
  archive,
  exclude,
  record,
  reviseTask,
} from "../../../src/features/tasks/model/commands";
import type { TaskDefinition } from "../../../src/features/tasks/model/contract";
import { taskCommandSpecs } from "../../../src/features/tasks/register";
import { outboxWorld } from "../../support/data/outbox-world";
import { cacheRow } from "../../support/data/rows";
import { record as defaultsRecord, ME } from "../../support/data/sharing";

/**
 * R5 (review of 13 October 2026, family `task-conflict-rebuild-command-contract`): "Save as new" of a task command is the SAME request the
 * person's act made, rebuilt by its own builder on the REVIEWED current version: every target with its role and version check, the
 * captured defaults (header and wire), and a version record raised from the reviewed version, so a following save is based on what the
 * replacement leaves. Through the PRODUCTION outbox, dispatcher and supersession over the double: a real `409`, a real supersession.
 */
const OCC = "70000000-0000-4000-8000-000000000013";
const PROG = "70000000-0000-4000-8000-000000000014";
const TASK = "70000000-0000-4000-8000-000000000021";
const EXEC = "70000000-0000-4000-8000-000000000022";
const specs = taskCommandSpecs();

const tick = (over: Partial<Parameters<typeof record>[0]> = {}) =>
  record({
    occurrenceId: OCC,
    progressId: PROG,
    me: ME,
    entryId: crypto.randomUUID(),
    evidence: { kind: "checkbox", complete: true },
    happenedAt: 1_700_000_000,
    replaces: null,
    firstAnyoneStream: false,
    defaults: null,
    ...over,
  });

async function world(progressVersion: number | null = 3) {
  const w = await outboxWorld();
  w.put("cache", [
    cacheRow({ id: OCC, kind: "occurrence", version: 1 }),
    ...(progressVersion === null
      ? []
      : [cacheRow({ id: PROG, kind: "progress", version: progressVersion })]),
    cacheRow({ id: TASK, kind: "task", version: 4, policy_version: 2 }),
    cacheRow({ id: EXEC, kind: "execution", parent_id: TASK, version: 1 }),
  ]);
  w.start();
  await w.settle();
  return w;
}
type World = Awaited<ReturnType<typeof world>>;
const enqueue = async (w: World, request: EnqueueRequest) => {
  const out = await w.outbox.enqueue(request);
  if (out.kind !== "queued") throw new Error(`enqueue: ${out.kind}`);
  return out.localId;
};
const stored = (w: World, localId: string): DraftWithCommand => {
  const header = w.drafts().find((d) => d.local_id === localId);
  if (header === undefined) throw new Error(`no draft ${localId}`);
  return {
    ...header,
    command: w.commandOf(localId) as DraftWithCommand["command"],
  };
};
const sentBodies = (w: World) =>
  w.sent.map(
    (s) => (JSON.parse(s.body) as { command: Record<string, unknown> }).command,
  );
const reviewed = (id: string, kind: CacheRow["kind"], version: number) =>
  cacheRow({ id, kind, version, policy_version: 2 });

/** A draft refused by the server with `code`, as it is stored after the dispatcher's answer. */
async function refused(w: World, request: EnqueueRequest, code: string) {
  w.script.push(w.error(409, code));
  const id = await enqueue(w, request);
  await w.settle();
  return id;
}

describe("a rebuilt record and the save after it", () => {
  test("control: two ordinary records expect 3, then 4", async () => {
    const w = await world();
    await enqueue(w, tick());
    await enqueue(w, tick());
    await w.settle();
    expect(sentBodies(w).map((c) => c.expected_version)).toEqual([3, 4]);
  });

  test("version conflict, reviewed at 5: the replacement is sent on 5 and the next record expects 6", async () => {
    const w = await world();
    const old = await refused(w, tick(), "conflict");
    expect(w.drafts().find((d) => d.local_id === old)?.status).toBe(
      "version_conflict",
    );
    const rebuilt = specs.record?.rebuild?.(
      stored(w, old),
      reviewed(PROG, "progress", 5),
    );
    expect(rebuilt).not.toBeNull();
    const out = await w.outbox.supersede(old, rebuilt as EnqueueRequest);
    expect(out.kind).toBe("superseded");
    const replacement = w
      .drafts()
      .find((d) => out.kind === "superseded" && d.local_id === out.localId);
    expect(replacement).toMatchObject({
      expected_version: 5,
      bases: { [PROG]: 5 },
      bumped: [PROG],
      target_resource_ids: [PROG, OCC],
    });
    expect(
      w.versions().find((v) => v.resource_id === PROG)?.locally_assumed_version,
    ).toBe(6);
    await enqueue(w, tick());
    await w.settle();
    const bodies = sentBodies(w);
    expect(bodies.slice(1).map((c) => c.expected_version)).toEqual([5, 6]);
    expect(bodies[1]?.entry_id).not.toBe(bodies[0]?.entry_id);
  });

  test("an amount (not version-checked) after an operation conflict: the stream stays a side effect raised from the reviewed version", async () => {
    const w = await world();
    const old = await refused(
      w,
      tick({ evidence: { kind: "quantity", amount: "2" } }),
      "operation_conflict",
    );
    const rebuilt = specs.record?.rebuild?.(
      stored(w, old),
      reviewed(PROG, "progress", 7),
    ) as EnqueueRequest;
    expect(rebuilt.targets).toEqual([
      expect.objectContaining({
        resourceId: PROG,
        role: "side_effect",
        versionChecked: true,
        reviewedBase: 7,
      }),
      expect.objectContaining({
        resourceId: OCC,
        role: "primary",
        versionChecked: false,
      }),
    ]);
    const out = await w.outbox.supersede(old, rebuilt);
    expect(out.kind).toBe("superseded");
    await enqueue(w, tick());
    await w.settle();
    const bodies = sentBodies(w).slice(1);
    expect(bodies[0]).not.toHaveProperty("expected_version");
    expect(bodies[1]?.expected_version).toBe(8);
  });

  test("the first record of an Anyone task keeps the defaults it captured, in its header and on the wire, with no review block", async () => {
    const w = await world(null);
    const original = tick({
      firstAnyoneStream: true,
      defaults: defaultsRecord(),
      evidence: { kind: "quantity", amount: "1" },
    });
    const captured = original.build({ [PROG]: 1 });
    expect(captured.defaultsRevision).toBeTruthy();
    const old = await refused(w, original, "operation_conflict");
    // No stream could be read (it is created on demand): the person continued without a current read.
    const rebuilt = specs.record?.rebuild?.(stored(w, old), null);
    expect(rebuilt).not.toBeNull();
    const out = await w.outbox.supersede(old, rebuilt as EnqueueRequest);
    expect(out.kind).toBe("superseded");
    if (out.kind !== "superseded") return;
    const header = w.drafts().find((d) => d.local_id === out.localId);
    expect(header?.defaults_revision).toBe(captured.defaultsRevision);
    expect(header?.defaults_context).toEqual(captured.defaultsContext);
    expect(header?.review_block).toBeNull();
    expect(
      (w.commandOf(out.localId) as { defaults_revision?: string })
        .defaults_revision,
    ).toBe(captured.defaultsRevision);
    await w.settle();
    expect(
      (
        JSON.parse(w.sent[w.sent.length - 1]?.body ?? "{}") as {
          defaults_revision?: string;
        }
      ).defaults_revision,
    ).toBe(captured.defaultsRevision);
  });

  test("control: an ordinary record captures no defaults and its rebuild adds none", () => {
    const draft = {
      local_id: "x",
      command: tick().build({ [PROG]: 3 }).command,
      target_resource_ids: [PROG, OCC],
      defaults_revision: null,
      defaults_context: null,
      status: "version_conflict",
      command_digest: "d",
    } as unknown as DraftWithCommand;
    const built = specs.record
      ?.rebuild?.(draft, reviewed(PROG, "progress", 3))
      ?.build({ [PROG]: 3 });
    expect(built?.defaultsRevision ?? null).toBeNull();
    expect(built?.command).not.toHaveProperty("defaults_revision");
  });

  test("the current-state read of an amount finds my stream among its side effects (it is not a primary target)", async () => {
    const w = await world();
    const old = await refused(
      w,
      tick({ evidence: { kind: "quantity", amount: "2" } }),
      "operation_conflict",
    );
    const asked: string[] = [];
    const stream = {
      id: PROG,
      kind: "progress",
      parent_id: OCC,
      label: "Progress",
      value: {},
      version: 7,
      can_edit: true,
    };
    const read = await specs.record?.readCurrent?.(stored(w, old), {
      signal: new AbortController().signal,
      get: async (path) => {
        asked.push(path);
        return new Response(
          JSON.stringify({ items: [stream], next_after: null }),
          { status: 200 },
        );
      },
    });
    expect(asked).toEqual([`/progress?parent_id=${OCC}&limit=200`]);
    expect(read).toMatchObject({
      kind: "loaded",
      value: { id: PROG, version: 7 },
    });
  });

  test("a draft that changed since it was read is not replaced (draft_changed)", async () => {
    const w = await world();
    const old = await refused(w, tick(), "conflict");
    const stale = { ...stored(w, old), command_digest: "an older body" };
    const rebuilt = specs.record?.rebuild?.(
      stale,
      reviewed(PROG, "progress", 5),
    ) as EnqueueRequest;
    expect(await w.outbox.supersede(old, rebuilt)).toEqual({
      kind: "refused",
      reason: "draft_changed",
    });
    expect(w.drafts().find((d) => d.local_id === old)?.status).toBe(
      "version_conflict",
    );
  });
});

describe("every rebuildable task kind keeps its builder's targets", () => {
  const definition: TaskDefinition = {
    schedule: {
      start_date: "2026-10-13",
      time: null,
      timezone: "UTC",
      repeat: null,
    },
    goal: { kind: "checkbox" },
    carry: "close_incomplete",
    participation: "personal",
    open_days_before: 0,
    close_days_after: 1,
    allow_streak_exclusions: true,
  };
  const draftOf = (request: EnqueueRequest, targets: string[]) =>
    ({
      local_id: "x",
      kind: "k",
      status: "version_conflict",
      command_digest: "d",
      command: request.build({ [TASK]: 4, [EXEC]: 1, [PROG]: 3, [OCC]: 1 })
        .command,
      target_resource_ids: targets,
      side_effect_bases: {},
      defaults_revision: null,
      defaults_context: null,
    }) as unknown as DraftWithCommand;
  const withoutBuild = (request: EnqueueRequest) =>
    request.targets.map(({ reviewedBase: _r, ...target }) => target);

  test("revise_task: the details stay a side effect; the reviewed task version and policy version are sent", () => {
    const original = reviseTask({
      taskId: TASK,
      executionId: EXEC,
      title: "T",
      definition,
      policyVersion: 1,
    });
    const rebuilt = specs.revise_task?.rebuild?.(
      draftOf(original, [TASK, EXEC]),
      reviewed(TASK, "task", 9),
    ) as EnqueueRequest;
    expect(withoutBuild(rebuilt)).toEqual(withoutBuild(original));
    expect(rebuilt.targets[0]?.reviewedBase).toBe(9);
    expect(rebuilt.targets[1]?.reviewedBase).toBeUndefined();
    expect(
      (
        rebuilt.build({ [TASK]: 9, [EXEC]: 1 }).command as {
          command: object;
        }
      ).command,
    ).toMatchObject({ expected_version: 9, expected_policy_version: 2 });
  });

  test("exclude: my stream on its reviewed version, ordered after the occurrence's queued work", () => {
    const original = exclude({
      occurrenceId: OCC,
      progressId: PROG,
      excluded: true,
    });
    const rebuilt = specs.exclude?.rebuild?.(
      draftOf(original, [PROG, OCC]),
      reviewed(PROG, "progress", 6),
    ) as EnqueueRequest;
    expect(withoutBuild(rebuilt)).toEqual(withoutBuild(original));
    expect(rebuilt.targets[0]?.reviewedBase).toBe(6);
  });

  test("archive: the task on its reviewed version", () => {
    const original = archive({ taskId: TASK, archived: true });
    const rebuilt = specs.archive?.rebuild?.(
      draftOf(original, [TASK]),
      reviewed(TASK, "task", 8),
    ) as EnqueueRequest;
    expect(withoutBuild(rebuilt)).toEqual(withoutBuild(original));
    expect(rebuilt.targets[0]?.reviewedBase).toBe(8);
  });

  test("a read of another resource is never taken as the reviewed version", () => {
    const original = archive({ taskId: TASK, archived: true });
    expect(
      specs.archive?.rebuild?.(
        draftOf(original, [TASK]),
        reviewed(EXEC, "execution", 8),
      ),
    ).toBeNull();
  });

  test("resolve has no authorised read of one occurrence, so it is not offered a rebuild", () => {
    expect(specs.resolve?.rebuild).toBeUndefined();
    expect(specs.resolve?.readCurrent).toBeUndefined();
  });
});
