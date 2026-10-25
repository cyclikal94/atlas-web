// @vitest-environment node
import { afterEach, describe, expect, test, vi } from "vitest";
import type { DataEnv } from "../../../src/data";
import type { MaterialiseSequenceRow } from "../../../src/data/model/types";
import { createConflictHandlerRegistry } from "../../../src/data/outbox/registries";
import type {
  MaterialiseCommand,
  TasksApi,
  TasksResult,
} from "../../../src/features/tasks/api";
import {
  forgetCatchUp,
  registerCatchUpConflicts,
  runnerOf,
} from "../../../src/features/tasks/catchup/useCatchUp";
import type { TasksEnv } from "../../../src/features/tasks/env";
import * as commands from "../../../src/features/tasks/model/commands";
import type { TaskDetail } from "../../../src/features/tasks/model/contract";
import { todayIn } from "../../../src/features/tasks/model/time";
import { outboxWorld } from "../../support/data/outbox-world";
import { NAME } from "../../support/data/page-world";
import { cacheRow, draftRow } from "../../support/data/rows";

/**
 * The command path of catch-up (CM-432, A7; fixture-only: the released backend raises `materialisation_required` on no command). Revision 1
 * (review R8): the handler asks the page's catch-up SERVICE (held by every task screen) for what the blocked command needs, as WEB-04 §5.8
 * derives it: the task a command names, through the day it names; or a day's own task through that day's date (from the cache). The command
 * is retried with its own key under the dispatcher's back-off, and once the catch-up has completed the SAME key is applied. Another slice's
 * draft, another code, or a page holding no service keeps the generic rule (MU-10C-34).
 *
 * Adaptation (revision 1): the first version of this file asserted that an occurrence-level `record` keeps the generic rule; that was
 * review R8's defect (no catch-up is asked for a command on a day, contrary to §5.8's derivation). Its intent, "a draft this handler cannot
 * derive a need from is left alone", is kept below for a command naming neither, and for the generic rule's other conditions.
 */
const TASK = "aaaaaaaa-0000-4000-8000-0000000000c1";
const OCC = "aaaaaaaa-0000-4000-8000-0000000000c3";
const PROGRESS = "aaaaaaaa-0000-4000-8000-0000000000c4";
const ZONE = "UTC";
const DEFINITION = {
  schedule: {
    start_date: "2026-01-01",
    time: null,
    timezone: ZONE,
    repeat: { frequency: "daily", interval: 1 },
  },
  goal: { kind: "checkbox" },
  carry: "close_incomplete",
  participation: "personal",
  open_days_before: 0,
  close_days_after: 1,
  allow_streak_exclusions: false,
} as const;
const TODAY = todayIn(ZONE, Date.now());
const occurrenceRow = (date: string) =>
  cacheRow({
    id: OCC,
    kind: "occurrence",
    parent_id: TASK,
    label: "Day",
    value: {
      task_id: TASK,
      definition: DEFINITION,
      slot: {
        key: `${date}Tdate`,
        date,
        intended_time: null,
        timezone: ZONE,
        instant: null,
      },
      opens_at: null,
      closes_at: null,
      participants: [],
      covered_by: null,
      resolved: false,
    } as never,
  });
const detail = (last: string, pending: boolean): TasksResult<TaskDetail> => ({
  ok: true,
  value: {
    task: cacheRow({ id: TASK, kind: "task", label: "Water the plants" }),
    execution: cacheRow({
      id: "aaaaaaaa-0000-4000-8000-0000000000c2",
      kind: "execution",
      parent_id: TASK,
      label: "Task details",
      value: DEFINITION as never,
    }),
    materialisation: { last_date: last, pending },
  },
});

/** The page's catch-up service over `service`, as a task screen holds it (`runnerOf`), with a scripted position read and `materialise`. */
function holdService(
  account: string,
  service: () => ReturnType<DataEnv["service"]>,
  positions: Array<TasksResult<TaskDetail>> = [],
) {
  const sent: Array<{ command: MaterialiseCommand; key: string }> = [];
  let reads = 0;
  const api = {
    readTask: async () => {
      reads += 1;
      return positions.shift() ?? detail(TODAY, false);
    },
    materialise: async (command: MaterialiseCommand, key: string) => {
      sent.push({ command, key });
      return { ok: true, value: { revision: 9 } } as const;
    },
  } as unknown as TasksApi;
  const env: TasksEnv = {
    api,
    accountId: account,
    identity: `${account}:1`,
    online: true,
    writable: true,
    now: () => Date.now(),
    newId: () => crypto.randomUUID(),
    dailyPageSize: 200,
  };
  const data = {
    service,
    serviceStore: { get: service, subscribe: () => () => undefined },
  } as unknown as DataEnv;
  const runner = runnerOf(env, data);
  return { runner, sent, reads: () => reads };
}

afterEach(() => {
  forgetCatchUp();
  vi.restoreAllMocks();
});

const decide = (
  registry: ReturnType<typeof createConflictHandlerRegistry>,
  command: Record<string, string | number | boolean>,
  kind?: string,
  account?: string,
) =>
  registry.decide({
    draft: draftRow({
      command: { command },
      ...(kind ? { kind } : {}),
      ...(account ? { account_id: account } : {}),
    }),
    status: 409,
    code: "materialisation_required",
  });

describe("the materialisation_required handler", () => {
  test("a task command is retried and its task asked for (through the day it names); a day's command is retried too; another slice's draft, another code or no service keeps the generic rule", async () => {
    const registry = createConflictHandlerRegistry();
    registerCatchUpConflicts(registry);
    registerCatchUpConflicts(registry);
    const account = draftRow({}).account_id;
    // No task screen holds a service for the account on this page: nothing can be asked, the generic rule applies.
    expect(
      decide(
        registry,
        { kind: "archive", id: TASK, expected_version: 1, archived: true },
        "archive",
      ),
    ).toEqual({ kind: "default" });
    const { runner } = holdService(account, () => null);
    const ensure = vi.spyOn(runner, "ensure");
    expect(
      decide(
        registry,
        { kind: "archive", id: TASK, expected_version: 1, archived: true },
        "archive",
      ),
    ).toEqual({ kind: "reclassify", as: "retry" });
    expect(ensure).toHaveBeenLastCalledWith(TASK, "draft", {});
    expect(
      decide(
        registry,
        { kind: "revise_task", id: TASK, through_date: "2026-10-30" },
        "revise_task",
      ),
    ).toEqual({ kind: "reclassify", as: "retry" });
    expect(ensure).toHaveBeenLastCalledWith(TASK, "draft", {
      throughDate: "2026-10-30",
    });
    // A command on one day is retried: its task and date come from the cache (below).
    expect(
      decide(registry, { kind: "record", occurrence_id: OCC }, "record"),
    ).toEqual({ kind: "reclassify", as: "retry" });
    // MU-10C-34: a non-task draft is never reclassified.
    expect(
      decide(
        registry,
        { kind: "configure_source", task_id: TASK },
        "configure_source",
      ),
    ).toEqual({ kind: "default" });
    // A task command naming neither a task nor a day: nothing can be derived.
    expect(decide(registry, { kind: "exclude" }, "exclude")).toEqual({
      kind: "default",
    });
    // Another account's draft: this page's service is not that account's.
    expect(
      decide(
        registry,
        { kind: "archive", id: TASK, expected_version: 1, archived: true },
        "archive",
        "99999999-0000-4000-8000-000000000099",
      ),
    ).toEqual({ kind: "default" });
    // Another code is not this handler's.
    expect(
      registry.decide({
        draft: draftRow({
          command: { command: { kind: "archive", id: TASK } },
          kind: "archive",
        }),
        status: 409,
        code: "conflict",
      }),
    ).toEqual({ kind: "default" });
  });

  test("a day's command asks for its task through THAT day's own date, read from the cache (WEB-04 §5.8)", async () => {
    const w = await outboxWorld();
    w.put("cache", [occurrenceRow("2026-11-03")]);
    const registry = createConflictHandlerRegistry();
    registerCatchUpConflicts(registry);
    const { runner } = holdService(w.service.account, () => w.service);
    const ensure = vi.spyOn(runner, "ensure").mockImplementation(() => {});
    expect(
      decide(
        registry,
        { kind: "record", occurrence_id: OCC },
        "record",
        w.service.account,
      ),
    ).toEqual({ kind: "reclassify", as: "retry" });
    for (let i = 0; i < 20 && ensure.mock.calls.length === 0; i += 1)
      await w.settle();
    expect(ensure).toHaveBeenCalledWith(TASK, "draft", {
      throughDate: "2026-11-03",
    });
  });
});

describe("A7: 409 materialisation_required → catch-up → the same key → applied (production dispatcher)", () => {
  test("a queued record of a day is refused, the day's task is caught up through that day, and the SAME key is sent again and applied once", async () => {
    const w = await outboxWorld();
    w.put("cache", [
      occurrenceRow(TODAY),
      cacheRow({ id: PROGRESS, kind: "progress", parent_id: OCC, version: 1 }),
    ]);
    registerCatchUpConflicts(w.conflicts);
    const { sent: caughtUp, reads } = holdService(
      w.service.account,
      () => w.service,
      [detail("2026-10-01", true), detail(TODAY, false)],
    );
    // The server: the first send of the command is refused until its task is caught up; any later one is applied.
    w.script.push(() => {
      expect(caughtUp, "nothing caught up before the refusal").toHaveLength(0);
      return w.error(409, "materialisation_required");
    });
    w.start();
    await w.settle();
    const queued = await w.outbox.enqueue(
      commands.record({
        occurrenceId: OCC,
        progressId: PROGRESS,
        me: w.service.account,
        entryId: crypto.randomUUID(),
        evidence: { kind: "checkbox", complete: true },
        happenedAt: Math.floor(Date.now() / 1000),
        replaces: null,
        firstAnyoneStream: false,
        defaults: null,
      }),
    );
    expect(queued, JSON.stringify(queued)).toMatchObject({ kind: "queued" });
    const key = queued.kind === "queued" ? queued.localId : "";
    for (let i = 0; i < 40 && reads() < 2; i += 1) {
      await w.settle();
      await new Promise((r) => setTimeout(r, 0));
    }
    // Refused once; the draft waits under the back-off (in flight, never in the conflict inbox).
    expect(w.sent.map((s) => s.key)).toEqual([key]);
    expect(w.drafts()[0]?.status).toBe("in_flight");
    // The catch-up ran through the day's own date: one call, its position read, the sequence complete (its record gone).
    expect(caughtUp).toHaveLength(1);
    expect(caughtUp[0]?.command).toMatchObject({
      kind: "materialise",
      task_id: TASK,
      through_date: TODAY,
    });
    expect(
      w.env.idb.peek(NAME, "materialise_sequences", [TASK, TODAY]) as
        | MaterialiseSequenceRow
        | undefined,
    ).toBeUndefined();
    // The dispatcher's own back-off (at most a minute) sends the SAME key, which is applied.
    await w.advance(60_000);
    expect(w.sent.map((s) => s.key)).toEqual([key, key]);
    expect(w.drafts()[0]?.status).toBe("acknowledged");
    expect(caughtUp, "no second catch-up").toHaveLength(1);
  });
});
