// @vitest-environment node
import { describe, expect, test } from "vitest";
import type {
  QuotaGuard,
  QuotaReservation,
} from "../../src/data/engine/quota-guard";
import {
  type EnqueueRequest,
  snapshotRequest,
  type TimerExpectation,
  type TimerSeen,
} from "../../src/data/model/outbox";
import { createOutbox } from "../../src/data/outbox/outbox";
import { enqueueDraft } from "../../src/data/plans/outbox";
import { timerAuthorityOf } from "../../src/data/plans/timer-copy";
import { outboxWorld } from "../support/data/outbox-world";
import { ACCOUNT } from "../support/data/page-world";
import { draftRow } from "../support/data/rows";

/**
 * WEB-10c revision 7 (review 7 R32): a timer end's precondition (`EnqueueRequest.expectTimer`) is decided by the WRITING transaction (W2),
 * against the timer evidence (W28) and the session's drafts as stored then. Through the PRODUCTION plan and facade over the IndexedDB
 * double. FIXTURE evidence: the real engines run the same plan in the e2e specs.
 */
const SESSION = "cccccccc-0000-4000-8000-0000000000e1";
const OCCURRENCE = "dddddddd-0000-4000-8000-0000000000e1";

/** A timer end as the task builders make one: the session (primary, version-checked) and its occurrence. */
function end(expectTimer?: TimerExpectation, localId?: string): EnqueueRequest {
  return {
    endpoint: "/task-commands",
    targets: [
      {
        resourceId: SESSION,
        role: "primary",
        basis: "timer_session",
        versionChecked: true,
        seedIfUntracked: 3,
      },
      {
        resourceId: OCCURRENCE,
        role: "primary",
        basis: "resource",
        versionChecked: false,
      },
    ],
    build: (bases) => ({
      command: {
        command: {
          kind: "stop_timer",
          occurrence_id: OCCURRENCE,
          session_id: SESSION,
          expected_version: bases[SESSION] as number,
          stopped_at: 1_800_000_000,
        },
      },
    }),
    ...(expectTimer ? { expectTimer } : {}),
    ...(localId ? { localId } : {}),
  };
}

/** An expectation that records what it was given and answers `answer`. */
function expecting(answer: (seen: TimerSeen) => boolean) {
  const seen: TimerSeen[] = [];
  const expectation: TimerExpectation = {
    session: SESSION,
    admit: (given) => {
      seen.push(given);
      return answer(given);
    },
  };
  return { expectation, seen };
}

/** What a refusal must leave as it was: every draft, body, version record and the singleton. */
const stored = (w: Awaited<ReturnType<typeof outboxWorld>>) =>
  JSON.stringify({
    drafts: w.rows("drafts"),
    commands: w.rows("draft_commands"),
    versions: w.rows("resource_versions"),
    sync: w.rows("sync_state"),
  });

describe("R32: the writing transaction decides a timer end", () => {
  test("admitted: the precondition is given the transaction's incarnation, the singleton as stored (decoded by the one decoder) and every draft of the session; the end is queued", async () => {
    const w = await outboxWorld();
    w.setSync({
      timer_order: 7,
      timer_ended: {
        lost: false,
        ids: [["eeeeeeee-0000-4000-8000-000000000001", 4]],
        through: 0,
      },
      timer_scope_floor: 2,
    } as never);
    const start = draftRow({
      kind: "start_timer",
      status: "queued",
      index_targets: [SESSION],
    });
    const unrelated = draftRow({
      index_targets: ["ffffffff-0000-4000-8000-000000000001"],
    });
    w.put("drafts", [start, unrelated]);
    const probe = expecting(() => true);
    const outcome = await w.outbox.enqueue(end(probe.expectation));
    expect(outcome.kind).toBe("queued");
    expect(probe.seen).toHaveLength(1);
    // The singleton as stored, decoded by the caller with the one decoder every screen uses.
    expect(timerAuthorityOf(probe.seen[0]?.sync)).toMatchObject({
      ended: ["eeeeeeee-0000-4000-8000-000000000001"],
      endedLost: false,
      floor: 2,
    });
    expect(probe.seen[0]?.incarnationId).toBe(w.service.incarnationId);
    expect(
      probe.seen[0]?.drafts.map((d) => [d.local_id, d.kind, d.status]),
    ).toEqual([[start.local_id, "start_timer", "queued"]]);
    expect(w.drafts().filter((d) => d.kind === "stop_timer")).toHaveLength(1);
  });

  test("refused: nothing is written (no draft, body, version record or singleton change) and the answer is `timer_ended`", async () => {
    const w = await outboxWorld();
    const before = stored(w);
    const probe = expecting(() => false);
    expect(await w.outbox.enqueue(end(probe.expectation))).toEqual({
      kind: "refused",
      reason: "timer_ended",
    });
    expect(probe.seen).toHaveLength(1);
    expect(stored(w)).toBe(before);
  });

  test("a save already made under the same local id is recognised FIRST: its retry is not refused by a retirement stored since, nor made twice", async () => {
    const w = await outboxWorld();
    const local = "aaaaaaaa-0000-4000-8000-0000000000e1";
    const admitted = expecting(() => true);
    const first = await w.outbox.enqueue(end(admitted.expectation, local));
    expect(first).toMatchObject({ kind: "queued", localId: local });
    // A retirement is stored after the save (its answer was lost); the retry under the same id is the same save.
    w.setSync({
      timer_ended: { lost: false, ids: [[SESSION, 1]], through: 0 },
    } as never);
    const retired = expecting(() => false);
    const again = await w.service.store.run(enqueueDraft, {
      incarnationId: w.service.incarnationId,
      request: snapshotRequest(end(retired.expectation, local)),
      localId: local,
      accountId: ACCOUNT,
      now: "2026-10-28T10:00:00.000Z",
    });
    expect(again).toMatchObject({
      kind: "queued",
      localId: local,
      duplicate: true,
    });
    expect(retired.seen).toHaveLength(0);
    expect(w.drafts().filter((d) => d.kind === "stop_timer")).toHaveLength(1);
  });

  test("every re-admission asks again: a retirement stored while the first hold lapsed refuses the end; control: none stored, written under the second hold", async () => {
    for (const retire of [true, false]) {
      const w = await outboxWorld();
      let made = 0;
      const settled: string[] = [];
      const quota = {
        check: async () => "ok",
        reserve: async (): Promise<QuotaReservation> => {
          made += 1;
          const mine = made;
          // Between the two rounds, another page stores the session finished.
          if (mine === 2 && retire)
            w.setSync({
              timer_ended: { lost: false, ids: [[SESSION, 1]], through: 0 },
            } as never);
          return {
            verdict: "ok",
            live: () => mine > 1,
            settle: (outcome) => {
              settled.push(`${mine}:${outcome}`);
            },
          } as QuotaReservation;
        },
        lastFree: () => null,
        invalidate: () => undefined,
      } as unknown as QuotaGuard;
      const outbox = createOutbox({
        service: w.service,
        quota,
        ids: { uuid: () => crypto.randomUUID() },
        clock: { now: () => 0, iso: () => new Date(0).toISOString() },
        fence: () => ({ hasPendingOperation: false, sessionStarted: true }),
      });
      const probe = expecting(
        ({ sync }) => !timerAuthorityOf(sync).ended.includes(SESSION),
      );
      const outcome = await outbox.enqueue(end(probe.expectation));
      expect(probe.seen, `retire=${retire}`).toHaveLength(2);
      if (retire) {
        expect(outcome).toEqual({ kind: "refused", reason: "timer_ended" });
        expect(settled).toEqual(["1:not_written", "2:not_written"]);
        expect(w.drafts()).toHaveLength(0);
      } else {
        expect(outcome.kind).toBe("queued");
        expect(settled).toEqual(["1:not_written", "2:written"]);
        expect(w.drafts()).toHaveLength(1);
      }
    }
  });
});

describe("R32: the precondition belongs to the request", () => {
  test("it is snapshotted with the request: a caller that changes its object while the save waits changes nothing", () => {
    const given: TimerExpectation = { session: SESSION, admit: () => true };
    const snap = snapshotRequest(end(given));
    (given as { session: string }).session = OCCURRENCE;
    expect(snap.expectTimer?.session).toBe(SESSION);
    expect(snap.expectTimer).not.toBe(given);
    // `admit` stays the caller's function (PURE), asked through the snapshot.
    expect(
      snap.expectTimer?.admit({
        incarnationId: "i",
        sync: {} as TimerSeen["sync"],
        drafts: [],
      }),
    ).toBe(true);
  });
});
