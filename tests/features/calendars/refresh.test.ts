// @vitest-environment node
import { describe, expect, test } from "vitest";
import { SUCCESSOR_UNCONFIRMED } from "../../../src/features/calendars/copy";
import {
  classifyRefresh,
  finishedSince,
  IN_PROGRESS_DELAYS_MS,
  type RefreshEffect,
  type RefreshEvent,
  type RefreshRun,
  refreshStep,
  SUCCESSOR_LIMIT_MS,
  SUCCESSOR_POLL_MS,
  startRefresh,
  TRANSIENT_DELAYS_MS,
} from "../../../src/features/calendars/model/refresh";
import type {
  CalendarResult,
  LiveSources,
} from "../../../src/features/calendars/model/result";
import { refreshMessage } from "../../../src/features/calendars/SourceRow";

/**
 * The manual refresh's decisions (WEB-13a, D-13a-6), table-driven. Every row of the plan's table, B8's six causes, the bounded retries
 * and their schedule, the live re-read of causes 4 and 5, and the rule that health is never evidence.
 */
type Answer = CalendarResult<{ revision: number }>;
const refused = (status: number, code: string, reason?: string): Answer => ({
  ok: false,
  kind: "refused",
  status,
  code,
  ...(reason === undefined ? {} : { reason }),
});
const ok: Answer = { ok: true, value: { revision: 7 } };
// Adapted in revision 3 (R9): a live source also carries `lastSuccess`; the earlier cases name none, so it is null for them.
const live = (
  entries: Record<
    string,
    { refreshInProgress: boolean; health: string | null; lastSuccess?: number }
  >,
  complete = true,
): CalendarResult<LiveSources> => ({
  ok: true,
  value: {
    sources: new Map(
      Object.entries(entries).map(([id, e]) => [
        id,
        { ...e, lastSuccess: e.lastSuccess ?? null },
      ]),
    ),
    complete,
  },
});

/** Runs a script of events through the reducer from a fresh press, collecting every effect. */
function play(events: RefreshEvent[]): {
  run: RefreshRun;
  effects: RefreshEffect[];
} {
  let { run, effect } = startRefresh("K");
  const effects: RefreshEffect[] = [effect];
  for (const event of events) {
    ({ run, effect } = refreshStep(run, event));
    effects.push(effect);
  }
  return { run, effects };
}
const answer = (a: Answer): RefreshEvent => ({ type: "answer", answer: a });
const liveEvent = (result: CalendarResult<LiveSources>): RefreshEvent => ({
  type: "live",
  id: "S",
  result,
});

describe("classifyRefresh: B8's six causes and the generic answers", () => {
  test.each<[string, Answer, string]>([
    ["200", ok, "succeeded"],
    [
      "200 with revision 0 is a receipt",
      { ok: true, value: { revision: 0 } },
      "succeeded",
    ],
    [
      "409 refresh_in_progress",
      refused(409, "refresh_in_progress"),
      "in_progress",
    ],
    [
      "cause 4: 409 stale_refresh generation_changed",
      refused(409, "stale_refresh", "generation_changed"),
      "superseded",
    ],
    [
      "cause 5: 409 stale_refresh lease_expired",
      refused(409, "stale_refresh", "lease_expired"),
      "lease_expired",
    ],
    [
      "a stale_refresh with no known reason is never retried blind",
      refused(409, "stale_refresh"),
      "superseded",
    ],
    ["cause 2: 502 fetch_failed", refused(502, "fetch_failed"), "fetch_failed"],
    [
      "cause 1: 422 connection_unavailable",
      refused(422, "connection_unavailable"),
      "connection_unavailable",
    ],
    [
      "cause 3: 503 integration_unconfigured",
      refused(503, "integration_unconfigured"),
      "unconfigured",
    ],
    [
      "cause 6a: 422 invalid_value (turned off)",
      refused(422, "invalid_value"),
      "turned_off",
    ],
    ["cause 6b: 404", refused(404, "not_found"), "unavailable"],
    ["cause 6b: 403", refused(403, "forbidden"), "unavailable"],
    [
      "CH3: 503 temporarily_unavailable is generic",
      refused(503, "temporarily_unavailable"),
      "transient",
    ],
    ["500", refused(500, "internal_error"), "transient"],
    ["429", refused(429, "rate_limited"), "transient"],
    [
      "409 operation_conflict",
      refused(409, "operation_conflict"),
      "unconfirmed",
    ],
    ["400", refused(400, "malformed_request"), "unconfirmed"],
    [
      "uncertain (network, a 4xx without an Atlas body)",
      { ok: false, kind: "uncertain", status: 404 },
      "transient",
    ],
    ["not_sent", { ok: false, kind: "not_sent" }, "not_sent"],
    ["offline", { ok: false, kind: "offline" }, "offline"],
    ["closed", { ok: false, kind: "closed" }, "closed"],
  ])("%s", (_name, input, kind) => {
    expect(classifyRefresh(input).kind).toBe(kind);
  });
  test.each([
    "invalid_ics",
    "unsupported_calendar_rule",
    "unsupported_calendar_timezone",
    "calendar_limit",
  ])("the parse refusal %s is the provider's feed, with its code", (code) => {
    expect(classifyRefresh(refused(422, code))).toEqual({
      kind: "feed_unreadable",
      code,
    });
  });
  test("7(c): refresh code has no capacity-specific branch", async () => {
    const { readFileSync } = await import("node:fs");
    for (const file of ["model/refresh.ts", "refresh-controller.ts"])
      expect(
        readFileSync(`src/features/calendars/${file}`, "utf8"),
      ).not.toMatch(/slice_capacity/);
  });
});

describe("refreshStep: the bounded retries, all under ONE key", () => {
  test("a press sends once; 200 ends it as succeeded (health is not consulted)", () => {
    const { run, effects } = play([answer(ok)]);
    expect(effects).toEqual([{ type: "send" }, { type: "stop" }]);
    expect(run.view).toEqual({ kind: "succeeded" });
    expect(run.key).toBe("K");
  });

  test("refresh_in_progress: same-key retries at 5, 10, 20 and 30 s (65 s), then 'still refreshing' with no further send", () => {
    const busy = answer(refused(409, "refresh_in_progress"));
    const { run, effects } = play([
      busy,
      answer({ ok: false, kind: "uncertain" }),
      busy,
      busy,
      busy,
      busy,
    ]);
    expect(IN_PROGRESS_DELAYS_MS).toEqual([5_000, 10_000, 20_000, 30_000]);
    expect(IN_PROGRESS_DELAYS_MS.reduce((a, b) => a + b, 0)).toBeGreaterThan(
      60_000,
    );
    expect(effects[1]).toEqual({ type: "wait", ms: 5_000, after: "send" });
    expect(run.view).toEqual({ kind: "still_refreshing" });
    expect(run.ended).toBe(true);
    expect(run.key).toBe("K");
    expect(effects.at(-1)).toEqual({ type: "stop" });
  });

  test("an uncertain attempt that the same key recovers ends as succeeded, never as failed (case 6(a))", () => {
    const { run, effects } = play([
      answer({ ok: false, kind: "uncertain" }),
      answer(refused(409, "refresh_in_progress")),
      answer(ok),
    ]);
    expect(effects.filter((e) => e.type === "wait")).toEqual([
      { type: "wait", ms: TRANSIENT_DELAYS_MS[0], after: "send" },
      { type: "wait", ms: IN_PROGRESS_DELAYS_MS[0], after: "send" },
    ]);
    expect(run.view).toEqual({ kind: "succeeded" });
  });

  test("cause 2 (502): retries at 10 and 30 s, then the cause 2 copy; a healthy health value changes nothing (7(b), 7(d))", () => {
    const fetchFailed = answer(refused(502, "fetch_failed"));
    const { run, effects } = play([fetchFailed, fetchFailed, fetchFailed]);
    expect(effects.filter((e) => e.type === "wait")).toEqual([
      { type: "wait", ms: 10_000, after: "send" },
      { type: "wait", ms: 30_000, after: "send" },
    ]);
    expect(run.view).toEqual({ kind: "failed", cause: "fetch_failed" });
  });

  test.each([
    [
      "cause 1",
      refused(422, "connection_unavailable"),
      "connection_unavailable",
    ],
    ["cause 3", refused(503, "integration_unconfigured"), "unconfigured"],
    ["cause 6a", refused(422, "invalid_value"), "turned_off"],
    ["cause 6b", refused(404, "not_found"), "unavailable"],
    ["operation_conflict", refused(409, "operation_conflict"), "unconfirmed"],
    ["not_sent", { ok: false, kind: "not_sent" } as Answer, "not_sent"],
  ])("%s is NOT retried automatically", (_name, input, cause) => {
    const { run, effects } = play([answer(input)]);
    expect(effects).toEqual([{ type: "send" }, { type: "stop" }]);
    expect(run.view).toEqual({ kind: "failed", cause });
  });

  test("a feed parse refusal is shown with its code and not retried", () => {
    const { run, effects } = play([answer(refused(422, "invalid_ics"))]);
    expect(effects).toHaveLength(2);
    expect(run.view).toEqual({
      kind: "failed",
      cause: "feed_unreadable",
      code: "invalid_ics",
    });
  });

  test("CH3 / 7(f): 503 temporarily_unavailable is the generic transient path", () => {
    const busy = answer(refused(503, "temporarily_unavailable"));
    const { run } = play([busy, busy, busy]);
    expect(run.view).toEqual({ kind: "failed", cause: "transient" });
  });
});

describe("causes 4 and 5: the live re-read of refresh_in_progress (B8 item 4)", () => {
  const generation = answer(
    refused(409, "stale_refresh", "generation_changed"),
  );
  const lease = answer(refused(409, "stale_refresh", "lease_expired"));

  test("cause 4 with nothing running: no retry, the cause 4 copy", () => {
    const { run, effects } = play([
      generation,
      liveEvent(live({ S: { refreshInProgress: false, health: "healthy" } })),
    ]);
    expect(effects).toEqual([
      { type: "send" },
      { type: "live" },
      { type: "stop" },
    ]);
    expect(run.view).toEqual({ kind: "failed", cause: "superseded" });
  });

  test("cause 4 with a newer refresh running: wait for IT (5 s polls), then show ITS result from the live read", () => {
    const { run, effects } = play([
      generation,
      liveEvent(live({ S: { refreshInProgress: true, health: "pending" } })),
      liveEvent(live({ S: { refreshInProgress: true, health: "pending" } })),
      liveEvent(
        live({ S: { refreshInProgress: false, health: "fetch_failed" } }),
      ),
    ]);
    expect(effects.filter((e) => e.type === "wait")).toEqual([
      { type: "wait", ms: SUCCESSOR_POLL_MS, after: "live" },
      { type: "wait", ms: SUCCESSOR_POLL_MS, after: "live" },
    ]);
    expect(effects.filter((e) => e.type === "send")).toHaveLength(1);
    expect(run.view).toEqual({
      kind: "successor_finished",
      health: "fetch_failed",
    });
  });

  test("a successor that outlasts the bound is 'still refreshing', with no send", () => {
    const busy = liveEvent(
      live({ S: { refreshInProgress: true, health: null } }),
    );
    const polls = SUCCESSOR_LIMIT_MS / SUCCESSOR_POLL_MS;
    const { run, effects } = play([generation, ...Array(polls + 1).fill(busy)]);
    expect(effects.filter((e) => e.type === "wait")).toHaveLength(polls);
    expect(effects.filter((e) => e.type === "send")).toHaveLength(1);
    expect(run.view).toEqual({ kind: "still_refreshing" });
  });

  test("cause 5 with nothing running: ONE same-key retry; a second lease_expired is the cause 5 failure", () => {
    const quiet = liveEvent(
      live({ S: { refreshInProgress: false, health: "healthy" } }),
    );
    const { run, effects } = play([lease, quiet, lease]);
    expect(effects).toEqual([
      { type: "send" },
      { type: "live" },
      { type: "send" },
      { type: "stop" },
    ]);
    expect(run.view).toEqual({ kind: "failed", cause: "lease_expired" });
    expect(run.key).toBe("K");
  });

  test("cause 5's single retry can succeed", () => {
    const quiet = liveEvent(
      live({ S: { refreshInProgress: false, health: null } }),
    );
    expect(play([lease, quiet, answer(ok)]).run.view).toEqual({
      kind: "succeeded",
    });
  });

  test("a live read that fails says nothing is known: no retry, the cause's copy", () => {
    const { run } = play([
      generation,
      liveEvent({ ok: false, kind: "uncertain" }),
    ]);
    expect(run.view).toEqual({ kind: "failed", cause: "superseded" });
    const second = play([lease, liveEvent({ ok: false, kind: "uncertain" })]);
    expect(second.run.view).toEqual({ kind: "failed", cause: "lease_expired" });
    expect(second.effects.filter((e) => e.type === "send")).toHaveLength(1);
  });
});

describe("R9: only a source the live read returned is evidence, and only a written result finishes a newer refresh", () => {
  const generation = answer(
    refused(409, "stale_refresh", "generation_changed"),
  );
  const lease = answer(refused(409, "stale_refresh", "lease_expired"));
  const sends = (effects: RefreshEffect[]) =>
    effects.filter((e) => e.type === "send").length;

  test.each([false, true])(
    "cause 5, the first read does not return the source (complete=%s): no retry, the cause 5 copy",
    (complete) => {
      const { run, effects } = play([
        lease,
        liveEvent(
          live(
            { other: { refreshInProgress: false, health: "healthy" } },
            complete,
          ),
        ),
      ]);
      expect(sends(effects)).toBe(1);
      expect(run.view).toEqual({ kind: "failed", cause: "lease_expired" });
      expect(run.ended).toBe(true);
    },
  );

  test("control: the source found in an INCOMPLETE read, not running, is evidence: ONE same-key retry", () => {
    const { run, effects } = play([
      lease,
      liveEvent(
        live({ S: { refreshInProgress: false, health: "healthy" } }, false),
      ),
    ]);
    expect(effects.at(-1)).toEqual({ type: "send" });
    expect(run.key).toBe("K");
    expect(run.leaseRetried).toBe(true);
  });

  test.each([false, true])(
    "cause 4, the first read does not return the source (complete=%s): the cause 4 copy, nothing waited for",
    (complete) => {
      const { run, effects } = play([
        generation,
        liveEvent(live({}, complete)),
      ]);
      expect(effects.filter((e) => e.type === "wait")).toEqual([]);
      expect(run.view).toEqual({ kind: "failed", cause: "superseded" });
    },
  );

  const busy = (health: string | null, lastSuccess?: number) =>
    liveEvent(
      live({
        S: {
          refreshInProgress: true,
          health,
          ...(lastSuccess === undefined ? {} : { lastSuccess }),
        },
      }),
    );
  const quiet = (health: string | null, lastSuccess?: number) =>
    liveEvent(
      live({
        S: {
          refreshInProgress: false,
          health,
          ...(lastSuccess === undefined ? {} : { lastSuccess }),
        },
      }),
    );

  test.each([
    ["cause 4", generation],
    ["cause 5", lease],
  ])(
    "%s: a newer refresh seen running, then the source missing from a later read (complete or not), is unconfirmed, not finished",
    (_name, first) => {
      for (const complete of [true, false]) {
        const { run, effects } = play([
          first,
          busy("pending"),
          liveEvent(live({}, complete)),
        ]);
        expect(run.view).toEqual({ kind: "successor_unconfirmed" });
        expect(sends(effects)).toBe(1);
        expect(effects.at(-1)).toEqual({ type: "stop" });
      }
    },
  );

  test.each([
    ["cause 4", generation],
    ["cause 5", lease],
  ])(
    "%s: the lease lapses with NO completing write (only the flag changes): unconfirmed, no retry",
    (_name, first) => {
      const { run, effects } = play([
        first,
        busy("healthy", 100),
        quiet("healthy", 100),
      ]);
      expect(run.view).toEqual({ kind: "successor_unconfirmed" });
      expect(sends(effects)).toBe(1);
    },
  );

  test("control: the same schedule WITH the completing write (last_success advanced) is the newer refresh's success", () => {
    const { run } = play([
      generation,
      busy("healthy", 100),
      quiet("healthy", 200),
    ]);
    expect(run.view).toEqual({ kind: "successor_finished", health: "healthy" });
  });

  test("a settings change that cleared the lease (health back to pending, nothing else) is unconfirmed", () => {
    const { run } = play([
      generation,
      busy("healthy", 100),
      quiet("pending", 100),
    ]);
    expect(run.view).toEqual({ kind: "successor_unconfirmed" });
  });

  test("control: a failure the newer refresh wrote (a new health) is ITS result; a first success after none is too", () => {
    expect(
      play([generation, busy("healthy", 100), quiet("fetch_failed", 100)]).run
        .view,
    ).toEqual({ kind: "successor_finished", health: "fetch_failed" });
    expect(
      play([lease, busy("pending"), quiet("healthy", 300)]).run.view,
    ).toEqual({ kind: "successor_finished", health: "healthy" });
  });

  test("the comparison is with the FIRST read that saw it running: a refresh that finished during the wait still counts", () => {
    const { run } = play([
      generation,
      busy("healthy", 100),
      busy("healthy", 200),
      quiet("healthy", 200),
    ]);
    expect(run.view).toEqual({ kind: "successor_finished", health: "healthy" });
    expect(run.seen).toEqual({ health: "healthy", lastSuccess: 100 });
  });

  test("the row says an unconfirmed newer refresh is unconfirmed, never that it finished", () => {
    expect(refreshMessage({ kind: "successor_unconfirmed" })).toBe(
      SUCCESSOR_UNCONFIRMED,
    );
    expect(refreshMessage({ kind: "successor_unconfirmed" })).not.toMatch(
      /finished:/,
    );
    expect(
      refreshMessage({ kind: "successor_finished", health: "healthy" }),
    ).toBe("The newer refresh finished: it succeeded.");
  });

  test("a new press starts with nothing seen", () => {
    expect(startRefresh("K").run.seen).toBeNull();
  });

  test.each<
    [
      string,
      { health: string | null; lastSuccess: number | null },
      { health: string | null; lastSuccess: number | null },
      boolean,
    ]
  >([
    [
      "unchanged",
      { health: "healthy", lastSuccess: 100 },
      { health: "healthy", lastSuccess: 100 },
      false,
    ],
    [
      "last_success advanced",
      { health: "healthy", lastSuccess: 100 },
      { health: "healthy", lastSuccess: 101 },
      true,
    ],
    [
      "last_success went back",
      { health: "healthy", lastSuccess: 100 },
      { health: "healthy", lastSuccess: 99 },
      false,
    ],
    [
      "a first last_success",
      { health: "pending", lastSuccess: null },
      { health: "healthy", lastSuccess: 5 },
      true,
    ],
    [
      "last_success lost",
      { health: "healthy", lastSuccess: 100 },
      { health: "healthy", lastSuccess: null },
      false,
    ],
    [
      "a new failure",
      { health: "healthy", lastSuccess: 100 },
      { health: "invalid_ics", lastSuccess: 100 },
      true,
    ],
    [
      "the same failure again",
      { health: "fetch_failed", lastSuccess: 100 },
      { health: "fetch_failed", lastSuccess: 100 },
      false,
    ],
    [
      "reset to pending",
      { health: "fetch_failed", lastSuccess: 100 },
      { health: "pending", lastSuccess: 100 },
      false,
    ],
    [
      "no health",
      { health: "healthy", lastSuccess: 100 },
      { health: null, lastSuccess: 100 },
      false,
    ],
  ])("finishedSince: %s", (_name, seen, now, finished) => {
    expect(finishedSince(seen, { ...now, refreshInProgress: false })).toBe(
      finished,
    );
  });
});

describe("offline and the end of a run", () => {
  test("offline mid-sequence stops everything: 'Needs a connection' and nothing more", () => {
    const { run, effects } = play([
      answer(refused(502, "fetch_failed")),
      { type: "offline" },
      answer(ok),
    ]);
    expect(run.view).toEqual({ kind: "needs_connection" });
    expect(effects.at(-1)).toEqual({ type: "stop" });
    expect(effects.at(-2)).toEqual({ type: "stop" });
  });
  test("a closed session shows nothing new", () => {
    expect(play([answer({ ok: false, kind: "closed" })]).run.view).toBeNull();
  });
});
