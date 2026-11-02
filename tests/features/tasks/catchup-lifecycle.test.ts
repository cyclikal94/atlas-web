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

describe("REVISION16 the page's lifecycle (production module)", () => {
  /**
   * ADAPTATION (revision 16, labelled; review 17's R36-J, design assessment C1/Q2, Kieran's D1 decision): revision 15's case asserted
   * that a `beforeunload` tore the marks taken before it (`tornSince`) and that a mark taken after it was live. Review 17 showed a
   * navigation answered with 204, a download or one cancelled leaves the page running after its `beforeunload`, with no `pagehide` and no
   * `pageshow`, so that assertion was the defect. Its intent (a hidden tab is not a departure; a `pagehide` is one until the next
   * `pageshow`; a mark taken after it is not covered; one lifecycle per page; subscribers told of a restore only) is kept; a `beforeunload`
   * is no departure at all, and a judgement made WHILE a `pagehide` is dispatched (before this module's listener runs, as Chromium delivers
   * its cancellation) is one.
   */
  test("a hidden tab is no departure; a beforeunload alone is none; a pagehide is a departure from its dispatch until the next pageshow; a mark taken after it is not covered; subscribers are told of a restore", () => {
    const life = pageLifecycle();
    let told = 0;
    const stop = life.subscribe(() => {
      told += 1;
    });
    try {
      const before = life.mark();
      expect(life.departedSince(before)).toBe(false);
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "hidden",
      });
      // As browsers fire it: at the document, bubbling (to `window`).
      document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
      expect(
        life.departedSince(before),
        "a hidden tab is not a closed one",
      ).toBe(false);
      window.dispatchEvent(new Event("beforeunload"));
      expect(
        life.departedSince(before),
        "a beforeunload (an abandoned navigation: 204, download, cancelled) is no departure",
      ).toBe(false);
      // Judged DURING a pagehide's dispatch, before this module's listener ran: the page's `window.event` is that pagehide. (Dispatched
      // at the document, so it does not reach the module's listener on `window`.)
      let during: boolean | null = null;
      const judge = () => {
        during = life.departedSince(before);
      };
      document.addEventListener("pagehide", judge);
      document.dispatchEvent(new Event("pagehide"));
      document.removeEventListener("pagehide", judge);
      expect(during, "judged while a pagehide is dispatched").toBe(true);
      expect(
        life.departedSince(before),
        "that dispatch over, with no pagehide of the page's own",
      ).toBe(false);
      pagehide();
      expect(life.departedSince(before), "the page's pagehide").toBe(true);
      const after = life.mark();
      expect(
        life.departedSince(after),
        "a call issued after the pagehide",
      ).toBe(false);
      expect(
        pageLifecycle().departedSince(before),
        "one lifecycle per page",
      ).toBe(true);
      expect(told).toBe(0);
      pageshow();
      expect(life.departedSince(before)).toBe(false);
      expect(told, "told of the restore").toBe(1);
      pageshow();
      expect(told, "a pageshow with no pagehide before it is no restore").toBe(
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
   * Revision 16 (review 17's R36-J; design assessment Q2; Kieran's D1 decision): the order of the page's events around the discovery's
   * transport failure. `live`: none. `departed`: a `pagehide` before the failure is delivered (Firefox's close). `abandoned`: a
   * `beforeunload` only (a navigation answered with 204, a download, one cancelled: the page goes on). `left-in-write`: a `beforeunload`,
   * the failure, then the page's `pagehide` while its first outcome write is on its way, in the same task (a failure the page observed
   * before its departure began, however soon it leaves after it: protected). `left-next-task`: the failure, and the page's `pagehide` in
   * the next task (queued as the failure is delivered): the runner judges the failure in the task it is delivered in, so it is protected.
   */
  type Order =
    | "live"
    | "departed"
    | "abandoned"
    | "left-in-write"
    | "left-next-task";
  /**
   * The discovery read of a task answered by a transport failure (in `order`), its outcome write failing; the observer facade's view of
   * the discovery's fence once that write failed (the page's next task run, before the first repair wait ends), then after a pageshow.
   */
  const run = async (order: Order) => {
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
            if (failedAt === 1 && order === "left-in-write") pagehide();
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
          if (order === "departed") pagehide();
          else if (order === "left-next-task") setTimeout(pagehide, 0);
          else if (order !== "live")
            window.dispatchEvent(new Event("beforeunload"));
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
    // The page's next tasks (its departure judged; no repair wait of 250 ms has ended).
    for (let k = 0; k < 3; k += 1) await new Promise((r) => setTimeout(r, 0));
    expect(failedAt, "no repair written yet").toBe(1);
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
    expect(await run("live")).toEqual({
      atFailure: "marked",
      afterShow: "marked",
    });
  });

  test("a pagehide first (the call cancelled by the page's teardown): nothing is published; a pageshow (a back-forward restore) publishes it", async () => {
    expect(await run("departed")).toEqual({
      atFailure: "unmarked",
      afterShow: "marked",
    });
  });

  test("REVISION16 R36-J: a beforeunload alone (an abandoned navigation): the page goes on, so the failure it observed is fenced and stays so", async () => {
    expect(await run("abandoned")).toEqual({
      atFailure: "marked",
      afterShow: "marked",
    });
  });

  test("REVISION16 R36-J (D1): a beforeunload, the failure, then the page's pagehide while its first write is on its way: observed before the departure began, so fenced; the later pagehide withdraws nothing", async () => {
    expect(await run("left-in-write")).toEqual({
      atFailure: "marked",
      afterShow: "marked",
    });
  });

  test("REVISION16 R36-J (D1): the failure, and the page's pagehide in the NEXT task: judged in the task the failure is delivered in, so fenced (no task between delivery and judgement)", async () => {
    expect(await run("left-next-task")).toEqual({
      atFailure: "marked",
      afterShow: "marked",
    });
  });
});
