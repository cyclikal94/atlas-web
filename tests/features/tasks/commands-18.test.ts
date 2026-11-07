// @vitest-environment node
import { describe, expect, test } from "vitest";
import type { EnqueueRequest } from "../../../src/data";
import * as commands from "../../../src/features/tasks/model/commands";
import { resolveWallTime } from "../../../src/features/tasks/model/time";
import { outboxWorld } from "../../support/data/outbox-world";
import { cacheRow } from "../../support/data/rows";

/**
 * WEB-18 (plan §3.2, D-18-7): `set_dependencies` built on the version of the graph read it came from (`reviewedBase`), through the
 * PRODUCTION enqueue plan, and the set of queued kinds that version-check the occurrence, confirmed against the builders themselves.
 */
const OCC = "70000000-0000-4000-8000-000000000181";
const PRE = "70000000-0000-4000-8000-000000000182";

describe("set_dependencies on a reviewed base", () => {
  test("sent on the graph's version, not the cache's, and the local record raised from it", async () => {
    const w = await outboxWorld();
    w.put("cache", [cacheRow({ id: OCC, kind: "occurrence", version: 3 })]);
    const out = await w.outbox.enqueue(
      commands.setDependencies({
        occurrenceId: OCC,
        prerequisites: [PRE],
        strict: false,
        reviewedBase: 5,
      }),
    );
    expect(out.kind).toBe("queued");
    const draft = w.drafts()[0];
    expect(draft?.expected_version).toBe(5);
    const body = (
      w.rows("draft_commands") as Array<{
        local_id: string;
        command: { command: Record<string, unknown> };
      }>
    ).find((r) => r.local_id === draft?.local_id)?.command.command;
    expect(body).toMatchObject({ expected_version: 5, prerequisites: [PRE] });
    expect(
      w.versions().find((v) => v.resource_id === OCC)?.locally_assumed_version,
    ).toBe(6);
  });

  test("without a reviewed base it is the cache's version, as before", () => {
    const request = commands.setDependencies({
      occurrenceId: OCC,
      prerequisites: [],
      strict: false,
    });
    expect(request.targets[0]).not.toHaveProperty("reviewedBase");
  });
});

describe("OCCURRENCE_VERSIONED_KINDS", () => {
  const definition = {
    schedule: {
      start_date: "2026-09-08",
      time: null,
      timezone: "Europe/London",
      repeat: null,
    },
    goal: { kind: "checkbox" as const },
    carry: "close_incomplete" as const,
    participation: "personal" as const,
    open_days_before: 0,
    close_days_after: 1,
    allow_streak_exclusions: false,
  };
  const SESSION = "70000000-0000-4000-8000-000000000183";
  const ENTRY = "70000000-0000-4000-8000-000000000184";
  const ME = "70000000-0000-4000-8000-000000000185";
  const TASK = "70000000-0000-4000-8000-000000000186";
  /** One request of every queued kind that acts on the day `OCC` (the task-level kinds name no existing occurrence). */
  const builders: Record<string, () => EnqueueRequest> = {
    record: () =>
      commands.record({
        occurrenceId: OCC,
        progressId: PRE,
        me: ME,
        entryId: ENTRY,
        evidence: { kind: "checkbox", complete: true },
        happenedAt: 1,
        replaces: null,
        firstAnyoneStream: false,
        defaults: null,
      }),
    exclude: () =>
      commands.exclude({ occurrenceId: OCC, progressId: PRE, excluded: true }),
    resolve: () => commands.resolve({ occurrenceId: OCC, resolved: true }),
    revise_occurrence: () =>
      commands.reviseOccurrence(
        {
          occurrenceId: OCC,
          current: {
            task_id: TASK,
            definition,
            slot: {
              key: "once",
              date: "2026-09-08",
              intended_time: null,
              timezone: "Europe/London",
              instant: null,
            },
            opens_at: 0,
            closes_at: 1,
            participants: [ME],
            covered_by: null,
            resolved: false,
          },
          definition,
          date: "2026-09-09",
          time: null,
          progressIds: [PRE],
        },
        resolveWallTime,
      ),
    set_dependencies: () =>
      commands.setDependencies({
        occurrenceId: OCC,
        prerequisites: [],
        strict: false,
      }),
    complete_dependencies: () =>
      commands.completeDependencies({
        occurrenceId: OCC,
        previewToken: "c".repeat(64),
        mode: "complete_prerequisites",
        happenedAt: 1,
        rootEvidence: null,
        rootStream: { id: PRE, known: true },
        prerequisites: [],
        defaults: null,
      }),
    start_timer: () =>
      commands.startTimer({
        occurrenceId: OCC,
        sessionId: SESSION,
        progressId: PRE,
        startedAt: 1,
        firstAnyoneStream: false,
        defaults: null,
      }),
    stop_timer: () =>
      commands.stopTimer({
        occurrenceId: OCC,
        sessionId: SESSION,
        progressId: PRE,
        streamKnown: true,
        knownVersion: null,
        stoppedAt: 2,
      }),
    cancel_timer: () =>
      commands.cancelTimer({
        occurrenceId: OCC,
        sessionId: SESSION,
        progressId: PRE,
        streamKnown: true,
        knownVersion: null,
      }),
  };
  const TASK_LEVEL = ["create_task", "revise_task", "archive"];

  test("exactly the kinds whose builder raises the day's version (version-checked or a side effect on it)", () => {
    // Every queued kind is accounted for: built here, or task-level.
    expect([...Object.keys(builders), ...TASK_LEVEL].sort()).toEqual(
      [...commands.QUEUED_KINDS].sort(),
    );
    for (const [kind, build] of Object.entries(builders)) {
      const target = build().targets.find((t) => t.resourceId === OCC);
      const raises =
        target !== undefined &&
        (target.versionChecked || target.role === "side_effect");
      expect(commands.OCCURRENCE_VERSIONED_KINDS.has(kind), kind).toBe(raises);
    }
    for (const kind of TASK_LEVEL)
      expect(commands.OCCURRENCE_VERSIONED_KINDS.has(kind)).toBe(false);
  });
});
