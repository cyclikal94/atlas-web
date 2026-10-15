/**
 * WEB-10a revision 6 (R17 `task-journal-snapshot-freshness`, incomplete_fix; design assessment items 3–5, schedules Q4–Q6, Q9–Q11): ONE
 * save decision serves the Save shown and the save admitted, taken from what is current when Save is pressed. An entry known only from the
 * full history can be saved only while that history is a current answer — online, read without failure at the stream's committed version,
 * the detail's local read current — and only with evidence that no later correction of THIS entry exists (a check at the current version,
 * or a window that reaches the end and holds it). A recent entry keeps its own authority (offline and while the history is read again).
 * While a save waits, the input is kept and nothing is queued. Every "direct" case calls the Save handler taken while Save was enabled (a
 * stale callback or programmatic activation that a disabled control cannot stop). Review 6's witness
 * (`.agtx/evidence/web10a-review-6/save-authority.test.tsx`) is kept unchanged beside these cases.
 */
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { CacheRow } from "../../../src/data";
import * as copy from "../../../src/features/tasks/copy";
import { forgetAllCorrections } from "../../../src/features/tasks/detail/CorrectionDialog";
import { HISTORY_COPY } from "../../../src/features/tasks/detail/EntryHistory";
import { forgetTaskMemory } from "../../../src/features/tasks/memory";
import type { JournalEntry } from "../../../src/features/tasks/model/contract";
import { installMatchMedia } from "../../helpers/match-media";
import {
  button,
  call,
  click,
  commitStream,
  detailReadGate,
  entry,
  entryId,
  fix,
  fixButton,
  forms,
  type Journaled,
  journalOf,
  mountWith,
  PAGE,
  records,
  release,
  SLOW,
  save,
  saveReason,
  takeSaveHandler,
  type,
  valueInput,
} from "../../support/tasks/journal";
import { tasksEnv } from "../../support/tasks/world";

installMatchMedia({ width: 1440 });
afterEach(() => {
  cleanup();
  forgetTaskMemory();
  forgetAllCorrections();
});

const goOffline = async (j: Journaled) => {
  j.t.rerender(tasksEnv(j.api, { online: false }));
  await j.t.settle();
};
const goOnline = async (j: Journaled) => {
  j.t.rerender(tasksEnv(j.api, { online: true }));
  await j.t.settle();
};
/** Opens entry `n`'s fix in the full history and types 987. */
async function editing(j: Journaled, n: number) {
  await click(j.t, HISTORY_COPY.full);
  await fix(j.t, n);
  await type(j.t, "987");
  expect(saveReason(), "Save is offered before anything changes").toBeNull();
}
const recheckButton = () =>
  forms()[0] === undefined
    ? null
    : within(forms()[0] as HTMLElement).queryByRole("button", {
        name: HISTORY_COPY.recheck,
      });
/** A 20-entry quantity journal (one page, to its end); entry 20 is the stream's recent tail; entry 5 is known only from the full history. */
const twenty = () => mountWith(() => journalOf(20), [entry(20)]);

describe("Q4: offline, an entry known only from the full history cannot be saved; a recent one can", () => {
  for (const target of [5, 20])
    for (const online of [true, false])
      test(
        `target=${target === 5 ? "full-only" : "recent"}, ${online ? "online (control)" : "offline"}: ${!online && target === 5 ? "Save waits, a direct call queues nothing, 987 kept" : "one record"}`,
        SLOW,
        async () => {
          const j = await twenty();
          await editing(j, target);
          const handler = takeSaveHandler();
          if (!online) await goOffline(j);
          const refused = !online && target === 5;
          expect(saveReason()).toBe(refused ? HISTORY_COPY.fixOffline : null);
          await call(j.t, handler);
          expect(records(j.t)).toHaveLength(refused ? 0 : 1);
          if (refused) expect(valueInput()?.value).toBe("987");
          else
            expect(records(j.t)[0]?.command.command.replaces).toBe(
              entryId(target),
            );
        },
      );

  test(
    "back online with the history still current: nothing is sent by itself; Save is offered and queues one",
    SLOW,
    async () => {
      const j = await twenty();
      await editing(j, 5);
      await goOffline(j);
      await goOnline(j);
      expect(records(j.t)).toHaveLength(0);
      expect(saveReason()).toBeNull();
      await save(j.t);
      expect(records(j.t)).toHaveLength(1);
    },
  );

  test(
    "back online after a newer version was seen offline, and its re-read fails: Save stays waiting; nothing is queued",
    SLOW,
    async () => {
      const j = await twenty();
      await editing(j, 5);
      await goOffline(j);
      await commitStream(j.t, j.task, 2, journalOf(20));
      j.answer(() => ({ ok: false, kind: "uncertain" }));
      await goOnline(j);
      expect(saveReason()).toBe(HISTORY_COPY.fixWaits);
      expect(records(j.t)).toHaveLength(0);
      expect(valueInput()?.value).toBe("987");
    },
  );
});

describe("Q5: a newer committed version makes Save wait for the history read at it", () => {
  for (const outcome of ["unchanged", "failed", "corrected"] as const)
    test(
      `the re-read is held (Save waits, a direct call queues nothing), then answered ${outcome}`,
      SLOW,
      async () => {
        let journal: JournalEntry[] = journalOf(20);
        const j = await mountWith(() => journal, [entry(20)]);
        await editing(j, 5);
        const handler = takeSaveHandler();
        if (outcome === "corrected")
          journal = [...journalOf(20), entry(21, { replaces: entryId(5) })];
        if (outcome === "failed")
          j.answer(() => ({ ok: false, kind: "uncertain" }));
        j.hold((after) => after === 0 && j.holds.length === 0);
        await commitStream(j.t, j.task, 2, journal);
        await j.t.until(() => j.holds.length === 1);
        expect(saveReason()).toBe(HISTORY_COPY.fixWaits);
        await call(j.t, handler);
        expect(records(j.t)).toHaveLength(0);
        await release(j.t, j.holds[0]);
        expect(valueInput()?.value).toBe("987");
        if (outcome === "unchanged") {
          expect(saveReason()).toBeNull();
          await save(j.t);
          expect(records(j.t)).toHaveLength(1);
          return;
        }
        expect(saveReason()).toBe(
          outcome === "failed"
            ? HISTORY_COPY.fixWaits
            : HISTORY_COPY.correctedSince,
        );
        await call(j.t, handler);
        expect(records(j.t)).toHaveLength(0);
        if (outcome === "failed") {
          // Try again reads the history at the current version: Save is offered again.
          j.answer(null);
          await click(j.t, copy.TRY_AGAIN);
          expect(saveReason()).toBeNull();
        }
      },
    );

  test(
    "control: a recent entry's fix can be saved while the re-read is held",
    SLOW,
    async () => {
      const j = await twenty();
      await editing(j, 20);
      j.hold((after) => after === 0 && j.holds.length === 0);
      await commitStream(j.t, j.task, 2, journalOf(20));
      await j.t.until(() => j.holds.length === 1);
      expect(saveReason()).toBeNull();
      await save(j.t);
      expect(records(j.t)).toHaveLength(1);
      await release(j.t, j.holds[0]);
    },
  );
});

describe("Q6: a detached fix needs evidence about ITS entry, not about the window shown", () => {
  /** 810 entries: five pages; entry 5 is on the first; after three Load more the window is pages 2-4 (not to the end). */
  async function detached(j: Journaled) {
    await click(j.t, HISTORY_COPY.full);
    await fix(j.t, 5);
    await type(j.t, "987");
    for (let i = 0; i < 3; i += 1) await click(j.t, HISTORY_COPY.loadMore);
    expect(row(5)).toBeNull();
    expect(
      document.querySelector(`[data-fix-detached="${entryId(5)}"]`),
    ).not.toBeNull();
  }
  const row = (n: number) =>
    document.querySelector(`[data-entry="${entryId(n)}"]`);

  test(
    "control: the check made when it opened (at this version) still answers: Save is offered",
    SLOW,
    async () => {
      const j = await mountWith(
        () => journalOf(PAGE * 4 + 10),
        [entry(PAGE * 4 + 10)],
      );
      await detached(j);
      expect(saveReason()).toBeNull();
      await save(j.t);
      expect(records(j.t)).toHaveLength(1);
    },
  );

  for (const corrected of [false, true])
    test(
      `a newer version: the current window is no evidence for an entry outside it; Check again ${corrected ? "finds the correction (blocked for good)" : "finds none (Save offered)"}`,
      SLOW,
      async () => {
        let journal: JournalEntry[] = journalOf(PAGE * 4 + 10);
        const j = await mountWith(() => journal, [entry(PAGE * 4 + 10)]);
        await detached(j);
        const handler = takeSaveHandler();
        journal = [
          ...journalOf(PAGE * 4 + 10),
          entry(PAGE * 4 + 11, corrected ? { replaces: entryId(5) } : {}),
        ];
        await commitStream(j.t, j.task, 2, journal);
        await j.t.until(
          () => j.inFlight() === 0 && saveReason() !== HISTORY_COPY.fixWaits,
        );
        expect(saveReason()).toBe(HISTORY_COPY.fixUnchecked);
        await call(j.t, handler);
        expect(records(j.t)).toHaveLength(0);
        // Check again is held: Save says it is checking, and Check again is not offered twice.
        j.hold(() => true);
        const asked = j.asked.length;
        await act(async () => {
          fireEvent.click(recheckButton() as HTMLElement);
        });
        await j.t.settle();
        expect(j.asked[asked]).toBe(5);
        expect(saveReason()).toBe(HISTORY_COPY.checking);
        expect(recheckButton()).toBeNull();
        j.hold(null);
        while (j.holds.length > 0) await release(j.t, j.holds.shift());
        await j.t.until(() => j.inFlight() === 0);
        expect(valueInput()?.value).toBe("987");
        expect(saveReason()).toBe(
          corrected ? HISTORY_COPY.correctedSince : null,
        );
        if (!corrected) {
          await save(j.t);
          expect(records(j.t)).toHaveLength(1);
        } else expect(records(j.t)).toHaveLength(0);
      },
    );

  test(
    "a window that reached the end answers for its entry after the window moves (same version)",
    SLOW,
    async () => {
      const j = await mountWith(() => journalOf(PAGE * 4), [entry(PAGE * 4)]);
      await click(j.t, HISTORY_COPY.full);
      for (let i = 0; i < 3; i += 1) await click(j.t, HISTORY_COPY.loadMore);
      expect(button(HISTORY_COPY.loadMore)).toBeNull();
      await fix(j.t, 700);
      await type(j.t, "987");
      await click(j.t, HISTORY_COPY.earlier);
      expect(
        document.querySelector(`[data-fix-detached="${entryId(700)}"]`),
      ).not.toBeNull();
      expect(saveReason()).toBeNull();
      await save(j.t);
      expect(records(j.t)).toHaveLength(1);
    },
  );
});

describe("Q9: a check answered after the connection went opens nothing", () => {
  for (const online of [true, false])
    test(
      online
        ? "control: online, the held check's answer opens the fix"
        : "offline when the held check answers: no fix opens, nothing is queued",
      SLOW,
      async () => {
        const j = await mountWith(
          () => journalOf(PAGE + 10),
          [entry(PAGE + 10)],
        );
        await click(j.t, HISTORY_COPY.full);
        j.hold((after) => after === PAGE && j.holds.length === 0);
        await fix(j.t, 5);
        expect(j.holds).toHaveLength(1);
        if (!online) await goOffline(j);
        await release(j.t, j.holds[0]);
        expect(forms()).toHaveLength(online ? 1 : 0);
        expect(records(j.t)).toHaveLength(0);
      },
    );
});

describe("Q10: a queued correction is pending, not committed history", () => {
  test(
    "saved, then the queued fix discarded: the entry can be fixed and saved again; queue changes read no journal",
    SLOW,
    async () => {
      const j = await twenty();
      await editing(j, 5);
      await save(j.t);
      expect(records(j.t)).toHaveLength(1);
      expect(fixButton(5)).toBeNull();
      const asked = j.asked.length;
      const localId = records(j.t)[0]?.local_id as string;
      await act(async () => {
        await j.t.data.outbox()?.discard(localId);
      });
      await j.t.settle();
      expect(records(j.t)).toHaveLength(0);
      await fix(j.t, 5);
      expect(saveReason()).toBeNull();
      await save(j.t);
      expect(records(j.t)).toHaveLength(1);
      expect(j.asked).toHaveLength(asked);
    },
  );
});

describe("Q11: a local change not yet read in leaves the detail a retained display", () => {
  for (const target of [5, 20])
    for (const ending of ["read", "failed"] as const)
      test(
        `target=${target === 5 ? "full-only" : "recent (control)"}: an unrelated commit's detail read is held${target === 5 ? " (Save waits, a direct call queues nothing)" : " (Save stays)"}, then ${ending}`,
        SLOW,
        async () => {
          const j = await twenty();
          await editing(j, target);
          const handler = takeSaveHandler();
          const gate = detailReadGate(j.t, j.task.progressId);
          gate.arm();
          const asked = j.asked.length;
          await j.t.commitSync([
            { ...(j.task.rows[0] as CacheRow), label: "Renamed", version: 2 },
          ]);
          await j.t.until(() => gate.held() === 1);
          expect(saveReason()).toBe(
            target === 5 ? HISTORY_COPY.fixWaits : null,
          );
          if (target === 5) {
            await call(j.t, handler);
            expect(records(j.t)).toHaveLength(0);
          }
          await gate.release(ending === "failed");
          if (ending === "failed") {
            expect(saveReason()).toBe(
              target === 5 ? HISTORY_COPY.fixWaits : null,
            );
            gate.restore();
            const stale = document.querySelector("[data-detail-row-stale]");
            expect(stale).not.toBeNull();
            await act(async () => {
              fireEvent.click(
                within(stale as HTMLElement).getByRole("button", {
                  name: copy.TRY_AGAIN,
                }),
              );
            });
            await j.t.settle();
          } else gate.restore();
          expect(saveReason()).toBeNull();
          // The progress version did not move: no journal read was made.
          expect(j.asked).toHaveLength(asked);
          expect(valueInput()?.value).toBe("987");
          await save(j.t);
          expect(records(j.t)).toHaveLength(1);
        },
      );
});
