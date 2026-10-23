// @vitest-environment node
import { describe, expect, test } from "vitest";
import type {
  CacheRow,
  DraftRow,
  DraftWithCommand,
  EnqueueRequest,
} from "../../../src/data";
import {
  knownDenial,
  OutboxRequestError,
  snapshotRequest,
  validateRequest,
} from "../../../src/data/model/outbox";
import { reviewedOf } from "../../../src/data/model/review-confirmation";
import { createCommandRegistry } from "../../../src/data/outbox/registries";
import {
  archive,
  exclude,
  record,
  resolve,
  reviseOccurrence,
  reviseTask,
} from "../../../src/features/tasks/model/commands";
import type {
  Evidence,
  TaskDefinition,
} from "../../../src/features/tasks/model/contract";
import {
  registerTaskCommands,
  taskCommandSpecs,
} from "../../../src/features/tasks/register";
import { outboxWorld } from "../../support/data/outbox-world";
import { cacheRow } from "../../support/data/rows";
import { record as defaultsRecord, snapshot } from "../../support/data/sharing";

/**
 * DA17-N1 and DA17-N2 (WEB-10a revision 17, families `occurrence-closure-permission-admission` and
 * `anyone-first-record-permission-admission`, both `new`, from the design assessment of 22 October 2026). Closing or reopening a day
 * (`resolve`) needs write access to the occurrence; a record writes my stream, and the record that CREATES my stream on an Anyone
 * occurrence (its first) needs the occurrence's edit access too, while an existing participant records without it; an exclusion writes
 * my stream, never the occurrence. Each is decided in the transaction that would write the command (W2 save, W3 edit, W4 replacement),
 * from what that transaction reads: a denial another tab committed after the screen offered the act is honoured, and whether my
 * participation is known is read there too (the cache's row of my stream, another unsettled draft that writes it, or a replacement
 * based on an authorised read of it), not taken from what the screen thought. The defaults review's confirmation rebuilds a stored
 * first record and states its needs again (`CommandRegistry.admission`). Through the PRODUCTION facade, dispatcher and plans over the
 * IndexedDB double: FIXTURE evidence (the server still decides when the command is sent).
 */
const OCC = "70000000-0000-4000-8000-000000000201";
const PROG = "70000000-0000-4000-8000-000000000202";
const TASK = "70000000-0000-4000-8000-000000000203";
const EXEC = "70000000-0000-4000-8000-000000000204";
const ME = "11111111-1111-4111-8111-111111111111";
const REVISION = "a".repeat(64);

type Facts = {
  /** The occurrence's `can_edit` as cached. */
  occurrence?: boolean;
  /** My stream: absent (not cached), or cached with this `can_edit`. */
  stream?: boolean | "absent";
};
const occurrenceRow = (can_edit: boolean): CacheRow =>
  cacheRow({ id: OCC, kind: "occurrence", version: 1, can_edit });
const streamRow = (can_edit: boolean): CacheRow =>
  cacheRow({
    id: PROG,
    kind: "progress",
    parent_id: OCC,
    version: 3,
    can_edit,
  });
const rowsOf = (f: Facts = {}): CacheRow[] => [
  occurrenceRow(f.occurrence ?? true),
  ...(f.stream === "absent" ? [] : [streamRow(f.stream ?? true)]),
];

const definition: TaskDefinition = {
  schedule: {
    start_date: "2026-10-21",
    time: null,
    timezone: "UTC",
    repeat: null,
  },
  goal: { kind: "checkbox" },
  carry: "close_incomplete",
  participation: "anyone",
  open_days_before: 0,
  close_days_after: 1,
  allow_streak_exclusions: false,
};
const tick: Evidence = { kind: "checkbox", complete: true };
const amount: Evidence = { kind: "quantity", amount: "2" };
const recordOf = (
  /** `fetched`: the progress defaults were known at the act (nothing to review, so it is sent); else it is held for the review. */
  over: { first?: boolean; evidence?: Evidence; fetched?: boolean } = {},
) =>
  record({
    occurrenceId: OCC,
    progressId: PROG,
    me: ME,
    entryId: crypto.randomUUID(),
    evidence: over.evidence ?? tick,
    happenedAt: 1_792_567_845,
    replaces: null,
    firstAnyoneStream: over.first ?? true,
    defaults: over.fetched ? defaultsRecord(snapshot()) : null,
  });
const close = (resolved = true) => resolve({ occurrenceId: OCC, resolved });
const excludeOf = () =>
  exclude({ occurrenceId: OCC, progressId: PROG, excluded: true });

async function world(f: Facts = {}, start = false) {
  const w = await outboxWorld();
  w.put("cache", rowsOf(f));
  if (start) w.start();
  await w.settle();
  return w;
}
type World = Awaited<ReturnType<typeof world>>;
/** Another tab commits a denial of the occurrence: the cache row changes and nothing tells this page (only a transaction sees it). */
const denyOccurrence = (w: World) => w.put("cache", [occurrenceRow(false)]);
const durable = (w: World) =>
  JSON.stringify({
    drafts: w.drafts(),
    versions: w.versions(),
    bodies: w.drafts().map((d) => w.commandOf(d.local_id)),
  });
const withCommand = (w: World, draft: DraftRow): DraftWithCommand =>
  ({ ...draft, command: w.commandOf(draft.local_id) }) as DraftWithCommand;

describe("the rule (pure): what each act needs, and when my participation is known", () => {
  const cache = (rows: CacheRow[]) => new Map(rows.map((r) => [r.id, r]));
  const other = (status: DraftRow["status"], targets = [PROG, OCC]) =>
    ({ local_id: "o", status, index_targets: targets }) as DraftRow;

  test("a closure needs the occurrence: denied refuses, editable and absent do not", () => {
    expect(knownDenial(close().targets, cache(rowsOf()))).toBe(false);
    expect(
      knownDenial(close().targets, cache(rowsOf({ occurrence: false }))),
    ).toBe(true);
    expect(knownDenial(close(false).targets, new Map())).toBe(false);
  });

  test("a first record with no known participation needs the occurrence; an absent occurrence row is no denial", () => {
    const targets = recordOf().targets;
    expect(
      knownDenial(
        targets,
        cache(rowsOf({ occurrence: false, stream: "absent" })),
      ),
    ).toBe(true);
    expect(knownDenial(targets, cache(rowsOf({ stream: "absent" })))).toBe(
      false,
    );
    expect(knownDenial(targets, new Map())).toBe(false);
  });

  test("my participation known from the cache, an unsettled draft or a reviewed read: the occurrence is not needed (S10, S11)", () => {
    const denied = cache(rowsOf({ occurrence: false, stream: "absent" }));
    const targets = recordOf().targets;
    // My stream cached (writable).
    expect(
      knownDenial(targets, cache(rowsOf({ occurrence: false, stream: true }))),
    ).toBe(false);
    // An admitted first record, any unsettled status.
    for (const status of [
      "queued",
      "in_flight",
      "version_conflict",
      "operation_conflict",
      "blocked",
    ] as const)
      expect(knownDenial(targets, denied, [other(status)])).toBe(false);
    // A replacement based on an authorised read of my stream.
    expect(
      knownDenial(
        targets.map((t) =>
          t.resourceId === PROG ? { ...t, reviewedBase: 4 } : t,
        ),
        denied,
      ),
    ).toBe(false);
  });

  test("a settled draft, or one that does not write my stream, is no participation", () => {
    const denied = cache(rowsOf({ occurrence: false, stream: "absent" }));
    const targets = recordOf().targets;
    for (const status of ["acknowledged", "rejected", "superseded"] as const)
      expect(knownDenial(targets, denied, [other(status)])).toBe(true);
    expect(knownDenial(targets, denied, [other("queued", [OCC])])).toBe(true);
  });

  test("a record and an exclusion write my stream: its known denial refuses them, the occurrence's does not", () => {
    for (const request of [recordOf({ first: false }), excludeOf()]) {
      expect(
        knownDenial(request.targets, cache(rowsOf({ stream: false }))),
      ).toBe(true);
      expect(
        knownDenial(
          request.targets,
          cache(rowsOf({ occurrence: false, stream: true })),
        ),
      ).toBe(false);
    }
  });

  test("a participation's requirement names another target of the request; the snapshot keeps it", () => {
    const request = recordOf();
    expect(() => validateRequest(request)).not.toThrow();
    const naming = (resource: string): EnqueueRequest => ({
      ...request,
      targets: request.targets.map((t) =>
        t.resourceId === PROG ? { ...t, joinRequiresEdit: resource } : t,
      ),
    });
    for (const wrong of [PROG, "not-a-target"])
      expect(() => validateRequest(naming(wrong))).toThrow(
        new OutboxRequestError("join_requires_edit"),
      );
    expect(
      snapshotRequest(request).targets.find((t) => t.resourceId === PROG),
    ).toMatchObject({ requiresEdit: true, joinRequiresEdit: OCC });
    expect(
      snapshotRequest(close()).targets.find((t) => t.resourceId === OCC)
        ?.requiresEdit,
    ).toBe(true);
  });
});

describe("W2: a closure under a denial committed before its transaction (DA17-N1, S8)", () => {
  for (const resolved of [true, false])
    test(`control: ${resolved ? "close" : "reopen"} by an editor is queued once`, async () => {
      const w = await world();
      expect((await w.outbox.enqueue(close(resolved))).kind).toBe("queued");
      expect(w.drafts().map((d) => d.kind)).toEqual(["resolve"]);
    });

  for (const resolved of [true, false])
    test(`${resolved ? "close" : "reopen"} with the occurrence denied after the screen offered it: refused \`denied\`, nothing written`, async () => {
      const w = await world();
      const before = durable(w);
      denyOccurrence(w);
      expect(await w.outbox.enqueue(close(resolved))).toEqual({
        kind: "refused",
        reason: "denied",
      });
      expect(durable(w)).toBe(before);
    });

  test("a denial committed AFTER the closure was written does not erase it (S3)", async () => {
    const w = await world();
    expect((await w.outbox.enqueue(close())).kind).toBe("queued");
    const saved = durable(w);
    denyOccurrence(w);
    await w.settle();
    expect(durable(w)).toBe(saved);
    // A new closure is checked again.
    expect(await w.outbox.enqueue(close(false))).toEqual({
      kind: "refused",
      reason: "denied",
    });
    expect(durable(w)).toBe(saved);
  });
});

describe("W2: the first record of an Anyone occurrence (DA17-N2, S9-S11)", () => {
  test("control: with the occurrence editable, it is queued once and seeds my stream", async () => {
    const w = await world({ stream: "absent" });
    expect((await w.outbox.enqueue(recordOf())).kind).toBe("queued");
    expect(w.drafts().map((d) => d.kind)).toEqual(["record"]);
    expect(w.versions().find((v) => v.resource_id === PROG)).toBeDefined();
  });

  for (const evidence of [tick, amount])
    test(`the occurrence denied before its transaction (${evidence.kind}): refused \`denied\`, no draft, no seeded stream`, async () => {
      const w = await world({ stream: "absent" });
      const before = durable(w);
      denyOccurrence(w);
      expect(await w.outbox.enqueue(recordOf({ evidence }))).toEqual({
        kind: "refused",
        reason: "denied",
      });
      expect(durable(w)).toBe(before);
      expect(w.versions().find((v) => v.resource_id === PROG)).toBeUndefined();
    });

  test("an existing participant (my stream cached) records without the occurrence's edit access (S10)", async () => {
    const w = await world({ occurrence: false, stream: true });
    expect((await w.outbox.enqueue(recordOf({ first: false }))).kind).toBe(
      "queued",
    );
  });

  test("my stream itself denied: a record is refused `denied`", async () => {
    const w = await world({ stream: false });
    expect(await w.outbox.enqueue(recordOf({ first: false }))).toEqual({
      kind: "refused",
      reason: "denied",
    });
    expect(w.drafts()).toEqual([]);
  });

  test("an admitted first record makes me a participant for the next act although the screen still says first (S11)", async () => {
    const w = await world({ stream: "absent" });
    expect((await w.outbox.enqueue(recordOf())).kind).toBe("queued");
    denyOccurrence(w);
    // Captured as a first record from a render that had not heard of the first: the transaction knows better.
    expect((await w.outbox.enqueue(recordOf({ evidence: amount }))).kind).toBe(
      "queued",
    );
    expect(w.drafts()).toHaveLength(2);
  });

  test("a rejected first record is no participation: the next first record under a denial is refused", async () => {
    const w = await world({ stream: "absent" }, true);
    w.script.push(w.error(403, "forbidden"));
    const first = await w.outbox.enqueue(recordOf({ fetched: true }));
    if (first.kind !== "queued") throw new Error("setup");
    await w.settle();
    expect(w.drafts().find((d) => d.local_id === first.localId)?.status).toBe(
      "rejected",
    );
    denyOccurrence(w);
    const before = durable(w);
    expect(await w.outbox.enqueue(recordOf())).toEqual({
      kind: "refused",
      reason: "denied",
    });
    expect(durable(w)).toBe(before);
  });
});

describe("W2: an exclusion writes my stream, not the occurrence (S10)", () => {
  test("the occurrence denied, my stream writable: queued", async () => {
    const w = await world({ occurrence: false, stream: true });
    expect((await w.outbox.enqueue(excludeOf())).kind).toBe("queued");
  });

  test("my stream denied: refused `denied`, nothing written", async () => {
    const w = await world({ stream: false });
    expect(await w.outbox.enqueue(excludeOf())).toEqual({
      kind: "refused",
      reason: "denied",
    });
    expect(w.drafts()).toEqual([]);
  });
});

describe("the defaults review's confirmation of a first record (S12: W3 for a held draft)", () => {
  const registry = createCommandRegistry();
  registerTaskCommands(registry);
  const admission = (d: DraftWithCommand) => registry.admission(d);

  async function held() {
    const w = await world({ stream: "absent" });
    const out = await w.outbox.enqueue(recordOf());
    if (out.kind !== "queued") throw new Error("setup");
    const draft = w.drafts().find((d) => d.local_id === out.localId);
    if (draft?.review_block === null || draft === undefined)
      throw new Error("setup: no review block");
    return { w, draft };
  }
  const confirmation = (draft: DraftRow) => ({
    reviewed: reviewedOf(draft),
    defaultsRevision: REVISION,
    defaultsContext: { progress: { households: [], accounts: [] } },
  });

  test("control: with the occurrence editable, the confirmation edits the held first record in place", async () => {
    const { w, draft } = await held();
    expect(
      await w.outbox.confirmDefaultsReview(
        draft.local_id,
        confirmation(draft),
        admission,
      ),
    ).toMatchObject({ kind: "confirmed", how: "edited" });
    expect(w.drafts()[0]?.review_block).toBeNull();
  });

  test("the occurrence denied before the confirmation: refused `denied`, the held draft and its body unchanged", async () => {
    const { w, draft } = await held();
    denyOccurrence(w);
    const before = durable(w);
    expect(
      await w.outbox.confirmDefaultsReview(
        draft.local_id,
        confirmation(draft),
        admission,
      ),
    ).toEqual({ kind: "refused", reason: "denied" });
    expect(durable(w)).toBe(before);
  });

  test("a second held record behind an unsettled first one: my participation is known in the edit's transaction, so it is confirmed (S11)", async () => {
    const { w, draft: first } = await held();
    // Captured as a first record too (the screen had not heard of the first), and held for the same review.
    const out = await w.outbox.enqueue(recordOf({ evidence: amount }));
    if (out.kind !== "queued") throw new Error("setup");
    const second = w.drafts().find((d) => d.local_id === out.localId);
    if (second?.review_block === null || second === undefined)
      throw new Error("setup: the second record is not held");
    denyOccurrence(w);
    expect(
      await w.outbox.confirmDefaultsReview(
        second.local_id,
        confirmation(second),
        admission,
      ),
    ).toMatchObject({ kind: "confirmed", how: "edited" });
    // The first, which creates my stream, is checked again on its own confirmation.
    expect(
      await w.outbox.confirmDefaultsReview(
        first.local_id,
        confirmation(first),
        admission,
      ),
    ).toEqual({ kind: "refused", reason: "denied" });
  });

  test("the registry states, for each stored task command, what its builder states", async () => {
    const w = await world();
    const requests: Array<[string, EnqueueRequest]> = [
      ["record", recordOf({ first: false })],
      ["record (amount)", recordOf({ first: false, evidence: amount })],
      ["exclude", excludeOf()],
      ["resolve", close()],
      [
        "revise_task",
        reviseTask({
          taskId: TASK,
          executionId: EXEC,
          title: "T",
          definition: definition,
          policyVersion: 1,
        }),
      ],
      ["archive", archive({ taskId: TASK, archived: true })],
    ];
    w.put("cache", [
      cacheRow({ id: TASK, kind: "task", version: 1, policy_version: 1 }),
      cacheRow({ id: EXEC, kind: "execution", parent_id: TASK, version: 1 }),
    ]);
    for (const [label, request] of requests) {
      const out = await w.outbox.enqueue(request);
      if (out.kind !== "queued") throw new Error(`setup ${label}: ${out.kind}`);
      const draft = w.drafts().find((d) => d.local_id === out.localId);
      const stated = Object.fromEntries(
        request.targets
          .filter((t) => t.requiresEdit || t.joinRequiresEdit !== undefined)
          .map((t) => [
            t.resourceId,
            {
              ...(t.requiresEdit ? { requiresEdit: true } : {}),
              ...(t.joinRequiresEdit === undefined
                ? {}
                : { joinRequiresEdit: t.joinRequiresEdit }),
            },
          ]),
      );
      expect(Object.keys(stated).length, label).toBeGreaterThan(0);
      expect(
        registry.admission(withCommand(w, draft as DraftRow)),
        label,
      ).toEqual(stated);
    }
    // A correction too (its progress streams are side effects that need nothing).
    const correction = reviseOccurrence(
      {
        occurrenceId: OCC,
        current: {
          task_id: TASK,
          definition,
          slot: {
            key: "k",
            date: "2026-10-21",
            intended_time: null,
            timezone: "UTC",
            instant: null,
          },
          opens_at: null,
          closes_at: null,
          participants: [],
          covered_by: null,
          resolved: false,
        },
        definition: definition,
        date: "2026-10-21",
        time: null,
        progressIds: [PROG],
      },
      () => 0,
    );
    const out = await w.outbox.enqueue(correction);
    if (out.kind !== "queued") throw new Error(`setup correction: ${out.kind}`);
    const draft = w.drafts().find((d) => d.local_id === out.localId);
    expect(registry.admission(withCommand(w, draft as DraftRow))).toEqual({
      [OCC]: { requiresEdit: true },
    });
  });
});

describe("W4: a replacement of a conflicted first record under a denial (S12)", () => {
  async function conflicted() {
    const w = await world({ stream: "absent" }, true);
    w.script.push(w.error(409, "conflict"));
    const out = await w.outbox.enqueue(
      recordOf({ evidence: amount, fetched: true }),
    );
    if (out.kind !== "queued") throw new Error("setup");
    await w.settle();
    const old = w.drafts().find((d) => d.local_id === out.localId);
    if (old?.status !== "version_conflict")
      throw new Error(`setup: ${old?.status}`);
    return { w, old };
  }
  const rebuilt = (w: World, old: DraftRow) => {
    const request = taskCommandSpecs().record?.rebuild?.(
      withCommand(w, old),
      null,
    );
    if (!request) throw new Error("setup: not rebuilt");
    return request;
  };

  test("control: with the occurrence editable, the rebuilt first record supersedes it once", async () => {
    const { w, old } = await conflicted();
    expect((await w.outbox.supersede(old.local_id, rebuilt(w, old))).kind).toBe(
      "superseded",
    );
  });

  test("the occurrence denied before the replacement's transaction: refused `denied`; the conflicted record stays", async () => {
    const { w, old } = await conflicted();
    denyOccurrence(w);
    const before = durable(w);
    expect(await w.outbox.supersede(old.local_id, rebuilt(w, old))).toEqual({
      kind: "refused",
      reason: "denied",
    });
    expect(durable(w)).toBe(before);
  });
});
