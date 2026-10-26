/**
 * WEB-10a revision 6 (R16 `task-journal-correction-request-ownership`, incomplete_fix; design assessment items 1–2, schedules Q1–Q3, Q15):
 * what was typed for a fix belongs to its DRAFT, not to the editor showing it. Closing the full history (Back to recent entries, or a
 * refusal) parks a draft holding unsaved input — typed in this editor or restored into it — and opening the entry's fix again moves it back,
 * however many times, until Cancel discards it, a save of exactly that revision acknowledges it, or the view ends. A save's answer settles
 * only the draft and revision it submitted, wherever that draft is now; one save at a time per draft, whichever editor shows it. Composed
 * through the production task detail over the IndexedDB double (`tests/support/tasks/journal.tsx`). Review 6's witness
 * (`.agtx/evidence/web10a-review-6/restored-input.test.tsx`) is kept unchanged beside these cases.
 */
import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import * as copy from "../../../src/features/tasks/copy";
import { forgetAllCorrections } from "../../../src/features/tasks/detail/CorrectionDialog";
import { HISTORY_COPY } from "../../../src/features/tasks/detail/EntryHistory";
import { forgetTaskMemory } from "../../../src/features/tasks/memory";
import { installMatchMedia } from "../../helpers/match-media";
import {
  cancel,
  click,
  entry,
  entryId,
  FORBIDDEN,
  fix,
  fixButton,
  forms,
  type Journaled,
  journalOf,
  mountWith,
  REFUSED,
  records,
  row,
  SLOW,
  save,
  saveGate,
  saveReason,
  type,
  valueInput,
} from "../../support/tasks/journal";
import { OTHER, tasksEnv } from "../../support/tasks/world";

installMatchMedia({ width: 1440 });
afterEach(() => {
  cleanup();
  forgetTaskMemory();
  forgetAllCorrections();
});

type Closure = "back" | "not_found" | "forbidden";
/** Ends the full history's authority: Back to recent entries, or a refusal of a Refresh. Asserts that the fix closed and nothing was saved. */
async function close(j: Journaled, how: Closure) {
  const before = records(j.t).length;
  if (how === "back") await click(j.t, HISTORY_COPY.recent);
  else {
    j.answer(() => (how === "not_found" ? REFUSED : FORBIDDEN));
    await click(j.t, HISTORY_COPY.refresh);
    j.answer(null);
  }
  expect(forms(), "the full-only fix closed with its authority").toHaveLength(
    0,
  );
  expect(records(j.t)).toHaveLength(before);
}
/** Begins a new authority explicitly and opens entry `n`'s fix under it. */
async function reopen(j: Journaled, n: number) {
  await click(j.t, HISTORY_COPY.full);
  await fix(j.t, n);
  expect(forms()).toHaveLength(1);
}
/** A 20-entry quantity journal (one page, to its end); entry 20 is the stream's recent tail; entry 5 is known only from the full history. */
const mounted = () => mountWith(() => journalOf(20), [entry(20)]);

describe("Q1: restored input survives every later closure until it is discarded or saved", () => {
  for (const how of ["back", "not_found", "forbidden"] as const)
    for (const cycles of [1, 2, 3])
      test(
        `${how}, ${cycles} closure(s) and reopenings with no typing after the first: 987 is still there`,
        SLOW,
        async () => {
          const j = await mounted();
          await reopen(j, 5);
          await type(j.t, "987");
          for (let i = 0; i < cycles; i += 1) {
            await close(j, how);
            await reopen(j, 5);
            expect(valueInput()?.value, `after closure ${i + 1}`).toBe("987");
          }
          expect(records(j.t)).toHaveLength(0);
        },
      );

  test(
    "mixed: Back, then a refusal, then Back: 987 survives each",
    SLOW,
    async () => {
      const j = await mounted();
      await reopen(j, 5);
      await type(j.t, "987");
      for (const how of ["back", "not_found", "back"] as const) {
        await close(j, how);
        await reopen(j, 5);
        expect(valueInput()?.value).toBe("987");
      }
      expect(records(j.t)).toHaveLength(0);
    },
  );

  test(
    "control: an untouched fix is not kept (reopened, it shows the entry's own value)",
    SLOW,
    async () => {
      const j = await mounted();
      await reopen(j, 5);
      await close(j, "back");
      await reopen(j, 5);
      expect(valueInput()?.value).toBe("5");
    },
  );

  test(
    "an untouched fix of another entry, closed, does not displace the parked draft",
    SLOW,
    async () => {
      const j = await mounted();
      await reopen(j, 5);
      await type(j.t, "987");
      await close(j, "back");
      await reopen(j, 6);
      expect(valueInput()?.value).toBe("6");
      await close(j, "back");
      await reopen(j, 5);
      expect(valueInput()?.value).toBe("987");
    },
  );

  test(
    "Cancel of the restored fix discards its draft: reopened, the entry's own value",
    SLOW,
    async () => {
      const j = await mounted();
      await reopen(j, 5);
      await type(j.t, "987");
      await close(j, "back");
      await reopen(j, 5);
      expect(valueInput()?.value).toBe("987");
      await cancel(j.t);
      await close(j, "back");
      await reopen(j, 5);
      expect(valueInput()?.value).toBe("5");
      expect(records(j.t)).toHaveLength(0);
    },
  );

  test(
    "restored twice, then saved: one record of 987 replacing entry 5, and the fix closes",
    SLOW,
    async () => {
      const j = await mounted();
      await reopen(j, 5);
      await type(j.t, "987");
      for (let i = 0; i < 2; i += 1) {
        await close(j, "back");
        await reopen(j, 5);
      }
      await save(j.t);
      expect(records(j.t)).toHaveLength(1);
      expect(records(j.t)[0]?.command.command.replaces).toBe(entryId(5));
      expect(records(j.t)[0]?.command.command.evidence).toEqual({
        kind: "quantity",
        amount: "987",
      });
      expect(forms()).toHaveLength(0);
    },
  );
});

describe("Q2: the exact raw input is what is kept", () => {
  for (const value of ["", "abc", "12"])
    test(
      `restored, then "${value}" typed, closed and reopened twice: "${value}"`,
      SLOW,
      async () => {
        const j = await mounted();
        await reopen(j, 5);
        await type(j.t, "987");
        await close(j, "back");
        await reopen(j, 5);
        await type(j.t, value);
        for (let i = 0; i < 2; i += 1) {
          await close(j, "not_found");
          await reopen(j, 5);
        }
        expect(valueInput()?.value).toBe(value);
        expect(records(j.t)).toHaveLength(0);
      },
    );

  test(
    "a failed save keeps the input through later closures",
    SLOW,
    async () => {
      const j = await mounted();
      const gate = saveGate(j.t);
      await reopen(j, 5);
      await type(j.t, "987");
      gate.hold();
      await save(j.t);
      await gate.answer(false);
      expect(valueInput()?.value).toBe("987");
      expect(records(j.t)).toHaveLength(0);
      for (let i = 0; i < 2; i += 1) {
        await close(j, "back");
        await reopen(j, 5);
        expect(valueInput()?.value).toBe("987");
      }
      gate.restore();
    },
  );
});

describe("Q3: a save's answer settles only the draft and revision it submitted", () => {
  test(
    "parked while saving, reopened: Save waits ('Saving…', no second save); the success keeps the reopened editor and the value",
    SLOW,
    async () => {
      const j = await mounted();
      const gate = saveGate(j.t);
      await reopen(j, 5);
      await type(j.t, "987");
      gate.hold();
      await save(j.t);
      expect(gate.held()).toBe(1);
      await close(j, "back");
      await reopen(j, 5);
      expect(valueInput()?.value).toBe("987");
      expect(saveReason()).toBe(copy.SAVING);
      await save(j.t);
      expect(gate.calls()).toBe(1);
      await gate.answer(true);
      expect(records(j.t)).toHaveLength(1);
      // The reopened editor is a newer session: an older save never closes it, nor erases its value.
      expect(forms()).toHaveLength(1);
      expect(valueInput()?.value).toBe("987");
      gate.restore();
    },
  );

  test(
    "parked while saving and the save fails: reopened, the value is there and Save is offered again",
    SLOW,
    async () => {
      const j = await mounted();
      const gate = saveGate(j.t);
      await reopen(j, 5);
      await type(j.t, "987");
      gate.hold();
      await save(j.t);
      await close(j, "back");
      await gate.answer(false);
      await reopen(j, 5);
      expect(valueInput()?.value).toBe("987");
      expect(saveReason()).toBeNull();
      gate.restore();
      await save(j.t);
      expect(records(j.t)).toHaveLength(1);
    },
  );

  test(
    "parked while saving and the save succeeds: the acknowledged draft is retired (with the queued fix discarded, Fix opens on the entry's own value)",
    SLOW,
    async () => {
      const j = await mounted();
      const gate = saveGate(j.t);
      await reopen(j, 5);
      await type(j.t, "987");
      gate.hold();
      await save(j.t);
      await close(j, "back");
      await gate.answer(true);
      expect(records(j.t)).toHaveLength(1);
      gate.restore();
      const localId = records(j.t)[0]?.local_id as string;
      await act(async () => {
        await j.t.data.outbox()?.discard(localId);
      });
      await j.t.settle();
      expect(records(j.t)).toHaveLength(0);
      await reopen(j, 5);
      expect(valueInput()?.value).toBe("5");
    },
  );

  test(
    "edited while saving: the success keeps the newer value; parked, it survives (and is restored once the queued fix is discarded)",
    SLOW,
    async () => {
      const j = await mounted();
      const gate = saveGate(j.t);
      await reopen(j, 5);
      await type(j.t, "987");
      gate.hold();
      await save(j.t);
      await type(j.t, "988");
      await gate.answer(true);
      expect(records(j.t)).toHaveLength(1);
      expect(valueInput()?.value).toBe("988");
      await close(j, "back");
      gate.restore();
      const localId = records(j.t)[0]?.local_id as string;
      await act(async () => {
        await j.t.data.outbox()?.discard(localId);
      });
      await j.t.settle();
      await reopen(j, 5);
      expect(valueInput()?.value).toBe("988");
    },
  );

  test(
    "edited while saving, then parked before the answer: the success leaves the newer input parked (restored once the queued fix is discarded)",
    SLOW,
    async () => {
      const j = await mounted();
      const gate = saveGate(j.t);
      await reopen(j, 5);
      await type(j.t, "987");
      gate.hold();
      await save(j.t);
      await type(j.t, "988");
      await close(j, "back");
      await gate.answer(true);
      expect(records(j.t)).toHaveLength(1);
      gate.restore();
      const localId = records(j.t)[0]?.local_id as string;
      await act(async () => {
        await j.t.data.outbox()?.discard(localId);
      });
      await j.t.settle();
      await reopen(j, 5);
      expect(valueInput()?.value).toBe("988");
    },
  );

  test(
    "Cancel while saving: the success resurrects nothing (with the queued fix discarded, Fix opens on the entry's own value)",
    SLOW,
    async () => {
      const j = await mounted();
      const gate = saveGate(j.t);
      await reopen(j, 5);
      await type(j.t, "987");
      gate.hold();
      await save(j.t);
      await cancel(j.t);
      await gate.answer(true);
      expect(forms()).toHaveLength(0);
      gate.restore();
      const localId = records(j.t)[0]?.local_id as string;
      await act(async () => {
        await j.t.data.outbox()?.discard(localId);
      });
      await j.t.settle();
      // Cancel closed only the fix: the full history is still open.
      await fix(j.t, 5);
      expect(valueInput()?.value).toBe("5");
    },
  );

  test(
    "control: a success with nothing typed since closes the open fix (R3)",
    SLOW,
    async () => {
      const j = await mounted();
      const gate = saveGate(j.t);
      await reopen(j, 5);
      await type(j.t, "987");
      gate.hold();
      await save(j.t);
      await gate.answer(true);
      expect(forms()).toHaveLength(0);
      expect(records(j.t)).toHaveLength(1);
      // The queued fix marks the entry corrected (pending): no Fix is offered for it.
      expect(row(5)?.textContent).toContain(HISTORY_COPY.corrected);
      expect(fixButton(5)).toBeNull();
      gate.restore();
    },
  );
});

describe("Q15: a draft belongs to its owner", () => {
  test(
    "another identity opening the same entry's fix never sees the parked value",
    SLOW,
    async () => {
      const j = await mounted();
      await reopen(j, 5);
      await type(j.t, "987");
      await close(j, "back");
      j.t.rerender(tasksEnv(j.api, { identity: `${OTHER}:1` }));
      await j.t.settle();
      await reopen(j, 5);
      expect(valueInput()?.value).toBe("5");
    },
  );
});
