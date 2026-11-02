import { afterEach, describe, expect, test } from "vitest";
import type { DataEnv } from "../../../src/data";
import type { AccountService } from "../../../src/data/engine/account-service";
import { createWriteFailureMarkers } from "../../../src/data/engine/write-failure-marker";
import {
  createPageDataHost,
  resetPageDataHost,
} from "../../../src/data/leader/page-host";
import type { TasksApi, TasksResult } from "../../../src/features/tasks/api";
import { pageLifecycle } from "../../../src/features/tasks/catchup/lifecycle";
import { fenceOf } from "../../../src/features/tasks/catchup/runner";
import {
  forgetCatchUp,
  runnerOf,
} from "../../../src/features/tasks/catchup/useCatchUp";
import type { TasksEnv } from "../../../src/features/tasks/env";
import type { TaskDetail } from "../../../src/features/tasks/model/contract";
import { ACCOUNT, defaultsWorld } from "../../support/data/defaults-world";
import { FakeMarkerStorage } from "../../support/data/marker-storage";
import { cacheRow } from "../../support/data/rows";

/**
 * Revision 15 (review 16's R36-H/I; design assessment C1/Q2): the page's lifecycle as the PRODUCTION composition gives it to the catch-up
 * runner (`pageLifecycle` on `window`, wired by `runnerOf`). jsdom dispatches the events; the order browsers give them at teardown is the
 * native lifecycle probe's evidence, not this file's.
 */
const TASK = "aaaaaaaa-0000-4000-8000-0000000000b1";
const NOW = Date.UTC(2026, 9, 25, 12);
const TRANSPORT = {
  ok: false,
  kind: "uncertain",
  retry: { cause: "transport" },
} as const;
const detail = (last: string, pending: boolean): TasksResult<TaskDetail> => ({
  ok: true,
  value: {
    task: cacheRow({ id: TASK, kind: "task", label: "Water the plants" }),
    execution: cacheRow({
      id: `${TASK.slice(0, -2)}e0`,
      kind: "execution",
      parent_id: TASK,
      label: "Task details",
      value: {
        schedule: {
          start_date: "2026-01-01",
          time: null,
          timezone: "UTC",
          repeat: { frequency: "daily", interval: 1 },
        },
        goal: { kind: "checkbox" },
        carry: "close_incomplete",
        participation: "personal",
        open_days_before: 0,
        close_days_after: 1,
        allow_streak_exclusions: false,
      } as never,
    }),
    materialisation: { last_date: last, pending },
  },
});
const pagehide = () => window.dispatchEvent(new Event("pagehide"));
const pageshow = () => window.dispatchEvent(new Event("pageshow"));

afterEach(() => {
  pageshow();
  forgetCatchUp();
  resetPageDataHost();
});

describe("REVISION15 the page's lifecycle (production module)", () => {
  test("a call's mark is torn by a later beforeunload or pagehide until the next pageshow; a hidden tab (visibilitychange) is not torn; a mark taken after a teardown is not; subscribers are told of a restore", () => {
    const life = pageLifecycle();
    let told = 0;
    const stop = life.subscribe(() => {
      told += 1;
    });
    try {
      const before = life.mark();
      expect(life.tornSince(before)).toBe(false);
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "hidden",
      });
      // As browsers fire it: at the document, bubbling (to `window`).
      document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
      expect(life.tornSince(before), "a hidden tab is not a closed one").toBe(
        false,
      );
      window.dispatchEvent(new Event("beforeunload"));
      expect(life.tornSince(before), "torn by a beforeunload").toBe(true);
      // A call issued after it (a navigation abandoned after its beforeunload) is live.
      const after = life.mark();
      expect(life.tornSince(after)).toBe(false);
      pagehide();
      expect(life.tornSince(after), "torn by a pagehide").toBe(true);
      expect(pageLifecycle().tornSince(before), "one lifecycle per page").toBe(
        true,
      );
      expect(told).toBe(0);
      pageshow();
      expect(life.tornSince(before)).toBe(false);
      expect(life.tornSince(after)).toBe(false);
      expect(told, "told of the restore").toBe(1);
      pageshow();
      expect(told, "a pageshow with no teardown before it is no restore").toBe(
        1,
      );
    } finally {
      stop();
      Reflect.deleteProperty(document, "visibilityState");
    }
  });
});

describe("REVISION15 runnerOf gives the runner the page's lifecycle", () => {
  /**
   * The discovery read of a task answered by a transport failure (after a `pagehide` when `torn`), its outcome write failing; the
   * observer facade's view of the discovery's fence once that write failed (before the first repair wait ends), then after a pageshow.
   */
  const run = async (torn: boolean) => {
    const storage = new FakeMarkerStorage();
    resetPageDataHost(
      createPageDataHost(
        createWriteFailureMarkers(storage, undefined, { locks: null }),
      ),
    );
    const t = await defaultsWorld({ online: false, noReader: true });
    await t.settle();
    const real = t.env.service() as AccountService;
    let failedAt = 0;
    const service = new Proxy(real, {
      get(target, key, receiver) {
        if (key !== "commit") return Reflect.get(target, key, receiver);
        return async (plan: { name: string }, input: { next?: unknown }) => {
          const s = (
            input.next as { schedule?: { issued?: number | null } } | null
          )?.schedule;
          if (
            plan.name === "data.writeMaterialiseDiscovery" &&
            s != null &&
            s.issued === null
          ) {
            failedAt += 1;
            return { kind: "failed" };
          }
          return target.commit(plan as never, input as never);
        };
      },
    }) as AccountService;
    let reads = 0;
    const env: TasksEnv = {
      api: {
        readTask: async () => {
          reads += 1;
          if (reads > 1) return detail("2026-10-25", false);
          if (torn) pagehide();
          return TRANSPORT;
        },
      } as unknown as TasksApi,
      accountId: ACCOUNT,
      identity: `${ACCOUNT}:1`,
      online: true,
      writable: true,
      now: () => NOW,
      newId: () => crypto.randomUUID(),
      dailyPageSize: 200,
    };
    const data = {
      service: () => service,
      serviceStore: { get: () => service, subscribe: () => () => undefined },
      quota: null,
    } as unknown as DataEnv;
    const runner = runnerOf(env, data);
    runner.ensure(TASK, "daily");
    for (let k = 0; k < 200 && failedAt === 0; k += 1) {
      await t.settle();
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(failedAt, "precondition: the outcome write failed").toBe(1);
    const probe = () =>
      createWriteFailureMarkers(storage, undefined, { locks: null }).probe(
        { account: ACCOUNT, incarnationId: real.incarnationId },
        fenceOf(TASK),
      );
    const atFailure = probe();
    pageshow();
    return { atFailure, afterShow: probe() };
  };

  test("a live page: the transport failure is fenced from its receipt (R36-H)", async () => {
    expect(await run(false)).toEqual({
      atFailure: "marked",
      afterShow: "marked",
    });
  });

  test("a pagehide first (the call cancelled by the page's teardown): nothing is published; a pageshow (a back-forward restore) publishes it", async () => {
    expect(await run(true)).toEqual({
      atFailure: "unmarked",
      afterShow: "marked",
    });
  });
});
