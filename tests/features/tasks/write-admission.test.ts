// @vitest-environment node
import { describe, expect, test } from "vitest";
import type {
  CacheRow,
  CurrentReadIo,
  DraftWithCommand,
  EnqueueRequest,
} from "../../../src/data";
import { knownDenial, planEnqueue } from "../../../src/data/model/outbox";
import { createCommandRegistry } from "../../../src/data/outbox/registries";
import {
  archive,
  reviseOccurrence,
  reviseTask,
} from "../../../src/features/tasks/model/commands";
import type {
  OccurrenceData,
  TaskDefinition,
} from "../../../src/features/tasks/model/contract";
import {
  registerTaskCommands,
  taskCommandSpecs,
} from "../../../src/features/tasks/register";
import { outboxWorld } from "../../support/data/outbox-world";
import { cacheRow } from "../../support/data/rows";

/**
 * R30 / DA-A1..A3 (WEB-10a revision 16, families `occurrence-correction-permission-admission` and `task-edit-permission-admission`): a
 * command that needs the person's write access to a resource (`TargetSpec.requiresEdit`: a correction's occurrence, a revision's task AND
 * details, an archive's task) is refused `denied`, writing nothing, when the transaction that would write it finds that resource cached
 * with `can_edit: false`: an ordinary save (W2), an edit of a queued one (W3) and a replacement (W4) alike, so a denial committed AFTER a
 * screen offered the save is honoured too. A resource the cache does not hold is no known denial. The generic "save as new" rebuild of a
 * revision or an archive declines under a denial its authorised read returned, the details' included. Through the PRODUCTION facade,
 * dispatcher and plans over the IndexedDB double: fixture evidence (the server still decides when the change is sent).
 */
const OCC = "70000000-0000-4000-8000-000000000101";
const PROG = "70000000-0000-4000-8000-000000000102";
const TASK = "70000000-0000-4000-8000-000000000103";
const EXEC = "70000000-0000-4000-8000-000000000104";

const definition: TaskDefinition = {
  schedule: {
    start_date: "2026-10-21",
    time: "07:30:45",
    timezone: "UTC",
    repeat: null,
  },
  goal: { kind: "checkbox" },
  carry: "close_incomplete",
  participation: "everyone",
  open_days_before: 0,
  close_days_after: 1,
  allow_streak_exclusions: false,
};
const occurrence: OccurrenceData = {
  task_id: TASK,
  definition,
  slot: {
    key: "2026-10-21T07:30:45",
    date: "2026-10-21",
    intended_time: "07:30:45",
    timezone: "UTC",
    instant: 1_792_567_845,
  },
  opens_at: 1_792_540_800,
  closes_at: 1_792_627_200,
  participants: [],
  covered_by: null,
  resolved: false,
};

const correction = () =>
  reviseOccurrence(
    {
      occurrenceId: OCC,
      current: occurrence,
      definition: { ...definition, close_days_after: 3 },
      date: "2026-10-21",
      time: "07:30:45",
      progressIds: [PROG],
    },
    () => 1_792_567_845,
  );
const revision = (title = "Renamed") =>
  reviseTask({
    taskId: TASK,
    executionId: EXEC,
    title,
    definition,
    policyVersion: 2,
  });

type Permits = { occurrence?: boolean; task?: boolean; execution?: boolean };
const rows = (p: Permits = {}): CacheRow[] => [
  cacheRow({
    id: OCC,
    kind: "occurrence",
    version: 1,
    can_edit: p.occurrence ?? true,
  }),
  cacheRow({ id: PROG, kind: "progress", version: 3 }),
  cacheRow({
    id: TASK,
    kind: "task",
    version: 4,
    policy_version: 2,
    can_edit: p.task ?? true,
  }),
  cacheRow({
    id: EXEC,
    kind: "execution",
    parent_id: TASK,
    version: 1,
    can_edit: p.execution ?? true,
  }),
];

async function world(p: Permits = {}, start = false) {
  const w = await outboxWorld();
  w.put("cache", rows(p));
  if (start) w.start();
  await w.settle();
  return w;
}
type World = Awaited<ReturnType<typeof world>>;
/** Another tab commits a denial: the cache row changes, nothing tells this page's screens (it is the transaction that must see it). */
const denyNow = (w: World, id: string) => {
  const row = rows().find((r) => r.id === id) as CacheRow;
  w.put("cache", [{ ...row, can_edit: false }]);
};
const durable = (w: World) =>
  JSON.stringify({
    drafts: w.drafts(),
    versions: w.versions(),
    bodies: w.drafts().map((d) => w.commandOf(d.local_id)),
  });

describe("the rule (pure): a known denial is a cached can_edit false of a resource the command needs to write", () => {
  const cache = (r: CacheRow[]) => new Map(r.map((row) => [row.id, row]));
  test("a denied required resource, and only that, is a known denial; absence is not", () => {
    const targets = correction().targets;
    expect(knownDenial(targets, cache(rows()))).toBe(false);
    expect(knownDenial(targets, cache(rows({ occurrence: false })))).toBe(true);
    // The progress streams it raises are side effects: their permission is not mine to need.
    expect(
      knownDenial(
        targets,
        cache(
          rows().map((r) => (r.id === PROG ? { ...r, can_edit: false } : r)),
        ),
      ),
    ).toBe(false);
    expect(knownDenial(targets, new Map())).toBe(false);
    expect(knownDenial(revision().targets, cache(rows({ task: false })))).toBe(
      true,
    );
    expect(
      knownDenial(revision().targets, cache(rows({ execution: false }))),
    ).toBe(true);
    expect(
      knownDenial(
        archive({ taskId: TASK, archived: true }).targets,
        cache(rows({ task: false })),
      ),
    ).toBe(true);
    // A target that does not say it needs write access is never refused for one.
    const plain: EnqueueRequest = {
      ...correction(),
      targets: correction().targets.map(({ requiresEdit: _r, ...t }) => t),
    };
    expect(knownDenial(plain.targets, cache(rows({ occurrence: false })))).toBe(
      false,
    );
  });

  test("planEnqueue refuses `denied` before anything is built", () => {
    let built = 0;
    const request: EnqueueRequest = {
      ...correction(),
      build: (bases) => {
        built += 1;
        return correction().build(bases);
      },
    };
    const sync = {
      draft_seq: 0,
      draft_fence: null,
    } as unknown as Parameters<typeof planEnqueue>[1]["sync"];
    const planned = planEnqueue(request, {
      sync,
      cache: cache(rows({ occurrence: false })),
      versions: new Map(),
      related: [],
      existing: undefined,
      localId: "x",
      accountId: "a",
      now: "2026-10-21T00:00:00Z",
    });
    expect(planned).toEqual({ kind: "refused", reason: "denied" });
    expect(built).toBe(0);
  });
});

describe("W2: an ordinary save under a denial committed before its transaction (S2, S4, DA-A2)", () => {
  test("control: an editor's correction is queued once, with its exact time", async () => {
    const w = await world();
    const out = await w.outbox.enqueue(correction());
    expect(out.kind).toBe("queued");
    expect(w.drafts()).toHaveLength(1);
    expect(
      (
        w.commandOf(w.drafts()[0]?.local_id as string) as {
          command: Record<string, unknown>;
        }
      ).command.time,
    ).toBe("07:30:45");
  });

  test("the occurrence denied after the screen offered the save: refused `denied`, nothing written", async () => {
    const w = await world();
    const before = durable(w);
    denyNow(w, OCC);
    expect(await w.outbox.enqueue(correction())).toEqual({
      kind: "refused",
      reason: "denied",
    });
    expect(durable(w)).toBe(before);
  });

  for (const lost of ["task", "execution"] as const)
    test(`a revision with the ${lost} denied after the screen offered it: refused \`denied\`, nothing written`, async () => {
      const w = await world();
      const before = durable(w);
      denyNow(w, lost === "task" ? TASK : EXEC);
      expect(await w.outbox.enqueue(revision())).toEqual({
        kind: "refused",
        reason: "denied",
      });
      expect(durable(w)).toBe(before);
    });

  test("control: a revision by an editor of both is queued", async () => {
    const w = await world();
    expect((await w.outbox.enqueue(revision())).kind).toBe("queued");
  });

  test("an archive with the task denied: refused `denied` (DA-A3); control queued", async () => {
    const denied = await world({ task: false });
    expect(
      await denied.outbox.enqueue(archive({ taskId: TASK, archived: true })),
    ).toEqual({ kind: "refused", reason: "denied" });
    expect(denied.drafts()).toEqual([]);
    const allowed = await world();
    expect(
      (await allowed.outbox.enqueue(archive({ taskId: TASK, archived: true })))
        .kind,
    ).toBe("queued");
  });

  test("a denial committed AFTER the save was written does not erase it (invariant 2)", async () => {
    const w = await world();
    expect((await w.outbox.enqueue(correction())).kind).toBe("queued");
    const saved = durable(w);
    denyNow(w, OCC);
    await w.settle();
    expect(durable(w)).toBe(saved);
  });
});

describe("W3: an edit of a queued revision under a denial committed before its transaction (S5)", () => {
  async function queued() {
    const w = await world();
    const out = await w.outbox.enqueue(revision("First"));
    if (out.kind !== "queued") throw new Error("setup");
    return { w, localId: out.localId };
  }

  test("control: the queued revision is edited in place", async () => {
    const { w, localId } = await queued();
    expect(await w.outbox.editQueued(localId, revision("Second"))).toEqual({
      kind: "edited",
      localId,
    });
    expect(
      (w.commandOf(localId) as { command: Record<string, unknown> }).command
        .title,
    ).toBe("Second");
  });

  for (const lost of ["task", "execution"] as const)
    test(`the ${lost} denied in between: refused \`denied\`, the queued body unchanged`, async () => {
      const { w, localId } = await queued();
      const before = durable(w);
      denyNow(w, lost === "task" ? TASK : EXEC);
      expect(await w.outbox.editQueued(localId, revision("Second"))).toEqual({
        kind: "refused",
        reason: "denied",
      });
      expect(durable(w)).toBe(before);
    });
});

describe("W4: a replacement of a conflicted correction under a denial (S7, S8)", () => {
  async function conflicted() {
    const w = await world({}, true);
    w.script.push(w.error(409, "conflict"));
    const out = await w.outbox.enqueue(correction());
    if (out.kind !== "queued") throw new Error("setup");
    await w.settle();
    const old = w.drafts().find((d) => d.local_id === out.localId);
    if (old?.status !== "version_conflict")
      throw new Error("setup: no conflict");
    return { w, old };
  }
  const replacement = (old: { local_id: string; command_digest: string }) => {
    const request = correction();
    return {
      ...request,
      targets: request.targets.map((t) =>
        t.resourceId === OCC ? { ...t, reviewedBase: 2 } : t,
      ),
      expectDraft: (now: { local_id: string; command_digest: string }) =>
        now.local_id === old.local_id &&
        now.command_digest === old.command_digest,
    };
  };

  test("control: an editor's replacement supersedes the conflicted correction once", async () => {
    const { w, old } = await conflicted();
    const out = await w.outbox.supersede(old.local_id, replacement(old));
    expect(out.kind).toBe("superseded");
    expect(w.drafts().map((d) => d.local_id)).not.toContain(old.local_id);
  });

  test("the occurrence denied before the replacement's transaction: refused `denied`; the conflicted correction, its body and status stay", async () => {
    const { w, old } = await conflicted();
    const before = durable(w);
    denyNow(w, OCC);
    expect(await w.outbox.supersede(old.local_id, replacement(old))).toEqual({
      kind: "refused",
      reason: "denied",
    });
    expect(durable(w)).toBe(before);
    expect(w.drafts().find((d) => d.local_id === old.local_id)?.status).toBe(
      "version_conflict",
    );
  });
});

describe("the generic rebuild of a revision or an archive under a reviewed denial (DA-A1, DA-A3, S9)", () => {
  const specs = taskCommandSpecs();
  const draftOf = (request: EnqueueRequest, targets: string[]) =>
    ({
      local_id: "x",
      kind: "k",
      status: "version_conflict",
      command_digest: "d",
      command: request.build({ [TASK]: 4, [EXEC]: 1 }).command,
      target_resource_ids: targets,
      side_effect_bases: {},
      defaults_revision: null,
      defaults_context: null,
    }) as unknown as DraftWithCommand;
  const task = (can_edit: boolean) =>
    cacheRow({
      id: TASK,
      kind: "task",
      version: 9,
      policy_version: 2,
      can_edit,
    });
  const details = (can_edit: boolean) =>
    cacheRow({ id: EXEC, kind: "execution", version: 2, can_edit });

  test("control: a revision with both editable in the reviewed read is rebuilt", () => {
    expect(
      specs.revise_task?.rebuild?.(
        draftOf(revision(), [TASK, EXEC]),
        task(true),
        [details(true)],
      ),
    ).not.toBeNull();
  });

  test("the reviewed task denied: no revision is rebuilt", () => {
    expect(
      specs.revise_task?.rebuild?.(
        draftOf(revision(), [TASK, EXEC]),
        task(false),
        [details(true)],
      ),
    ).toBeNull();
  });

  test("the reviewed details denied: no revision is rebuilt", () => {
    expect(
      specs.revise_task?.rebuild?.(
        draftOf(revision(), [TASK, EXEC]),
        task(true),
        [details(false)],
      ),
    ).toBeNull();
  });

  test("details the read did not return are no denial (the server decides)", () => {
    expect(
      specs.revise_task?.rebuild?.(
        draftOf(revision(), [TASK, EXEC]),
        task(true),
        [],
      ),
    ).not.toBeNull();
  });

  test("an archive: rebuilt for an editor, not under a reviewed denial", () => {
    const original = archive({ taskId: TASK, archived: true });
    expect(
      specs.archive?.rebuild?.(draftOf(original, [TASK]), task(true)),
    ).not.toBeNull();
    expect(
      specs.archive?.rebuild?.(draftOf(original, [TASK]), task(false)),
    ).toBeNull();
  });

  test("occurrence corrections and closures still have no generic rebuild", () => {
    expect(specs.revise_occurrence?.rebuild).toBeUndefined();
    expect(specs.resolve?.rebuild).toBeUndefined();
  });

  test("the task's authorised read keeps its details beside the reviewed task, and the registry hands them to the rebuild", async () => {
    const registry = createCommandRegistry();
    registerTaskCommands(registry);
    const projection = (id: string, kind: string, can_edit: boolean) => ({
      id,
      kind,
      parent_id: kind === "task" ? null : TASK,
      label: kind === "task" ? "Task" : "Task details",
      value: kind === "task" ? null : (definition as unknown as object),
      version: kind === "task" ? 9 : 2,
      can_edit,
      ...(kind === "task" ? { policy_version: 2, archived: false } : {}),
    });
    const io: CurrentReadIo = {
      signal: new AbortController().signal,
      get: async () =>
        new Response(
          JSON.stringify({
            task: projection(TASK, "task", true),
            execution: projection(EXEC, "execution", false),
            materialisation: null,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    };
    const draft = draftOf(revision(), [TASK, EXEC]);
    const read = await registry.readCurrent(
      { ...draft, kind: "revise_task" },
      io,
    );
    if (read.kind !== "loaded") throw new Error(`read: ${read.kind}`);
    expect(read.value.id).toBe(TASK);
    expect(read.related?.map((r) => [r.id, r.can_edit])).toEqual([
      [EXEC, false],
    ]);
    expect(
      registry.rebuild(
        { ...draft, kind: "revise_task" },
        read.value,
        read.related,
      ),
    ).toBeNull();
    expect(
      registry.rebuild({ ...draft, kind: "revise_task" }, read.value, [
        { ...(read.related?.[0] as CacheRow), can_edit: true },
      ]),
    ).not.toBeNull();
  });
});
