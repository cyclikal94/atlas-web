import { createMemoryHistory } from "@tanstack/react-router";
import { afterEach, describe, expect, test } from "vitest";
import {
  adoptCorrection,
  correctionEntry,
  correctionKey,
  editCorrection,
  forgetCorrectionSessions,
  openCorrection,
  releaseCorrection,
} from "../../../src/features/tasks/detail/correction-owner";
import {
  adoptKept,
  editKept,
  forgetKept,
  keptEntry,
  keptKey,
  openKept,
  releaseKept,
} from "../../../src/features/tasks/kept-input";
import type { CorrectionState } from "../../../src/features/tasks/model/correction";
import {
  forgetTaskVisits,
  observeTaskRoutes,
  visitHere,
} from "../../../src/features/tasks/visit";
import { createHistoryRouteChanges } from "../../../src/lib/route-changes";

/**
 * Revision 24 (R36): an editor React never removed is at its address again after the person left it, and the visit going on there takes
 * over the session it still holds (`adoptKept`, `adoptCorrection`), so that visit keeps its input as it would a newly opened editor's.
 * Only that exact session, and only while an editor holds it: a session no editor holds is the visit's it was left on (an ended visit's
 * input is never taken over), and another session of the same key (a replacement) or another key (another identity or day) is untouched.
 */
const ME = "me:1";
const CORRECTION_STATE: CorrectionState = {
  minimum: "10",
  maximum: "",
  unit: "cups",
  labels: {},
  date: "2026-10-24",
  time: "",
  keptTime: null,
  timeUnconfirmed: false,
  openDaysBefore: "0",
  closeDaysAfter: "0",
};
afterEach(() => {
  forgetKept();
  forgetCorrectionSessions();
  forgetTaskVisits();
});

/** The person at /tasks/a, then the task list (the visit ends) and back: a new visit of the same address. */
function awayAndBack() {
  const history = createMemoryHistory({ initialEntries: ["/tasks/a"] });
  observeTaskRoutes(createHistoryRouteChanges(history));
  const first = visitHere(ME);
  return {
    first,
    back: () => {
      history.push("/tasks");
      history.push("/tasks/a");
      return visitHere(ME);
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("adoptKept", () => {
  test("the held session moves to the new visit: released there with input, it is kept for that visit", async () => {
    const { first, back } = awayAndBack();
    const key = keptKey(ME, "form");
    const entry = openKept(key, ME, () => "", first);
    editKept(key, entry.session, "typed");
    const next = back();
    expect(first.ended()).toBe(true);
    adoptKept(key, entry.session, next);
    releaseKept(key, entry.session);
    await tick();
    expect(keptEntry<string>(key)?.value).toBe("typed");
    expect(keptEntry<string>(key)?.session).toBe(entry.session);
  });

  test("control: not adopted, the ended visit's input is dropped when its editor lets go", async () => {
    const { first, back } = awayAndBack();
    const key = keptKey(ME, "form");
    const entry = openKept(key, ME, () => "", first);
    editKept(key, entry.session, "typed");
    back();
    releaseKept(key, entry.session);
    await tick();
    expect(keptEntry<string>(key)).toBeNull();
  });

  test("another session of the key, or a session no editor holds, is not taken over", async () => {
    const { first, back } = awayAndBack();
    const key = keptKey(ME, "form");
    const entry = openKept(key, ME, () => "", first);
    editKept(key, entry.session, "typed");
    const next = back();
    adoptKept(key, entry.session + 1, next);
    releaseKept(key, entry.session);
    adoptKept(key, entry.session, next);
    await tick();
    expect(keptEntry<string>(key), "an ended visit's input").toBeNull();
  });

  test("another key (another identity's or editor's) is untouched", async () => {
    const { first, back } = awayAndBack();
    const mine = keptKey(ME, "form");
    const other = keptKey(ME, "amount");
    const a = openKept(mine, ME, () => "", first);
    const b = openKept(other, ME, () => "", first);
    editKept(other, b.session, "7");
    const next = back();
    adoptKept(mine, a.session, next);
    adoptKept(mine, b.session, next);
    releaseKept(other, b.session);
    await tick();
    expect(keptEntry<string>(other)).toBeNull();
  });
});

describe("adoptCorrection", () => {
  const key = correctionKey(ME, "occurrence-a");

  test("the held session moves to the new visit: released there with input, it is kept for that visit", () => {
    const { first, back } = awayAndBack();
    const opened = openCorrection(key, ME, () => CORRECTION_STATE, first);
    editCorrection(key, opened.session, { ...CORRECTION_STATE, minimum: "12" });
    const next = back();
    adoptCorrection(key, opened.session, next);
    releaseCorrection(key, opened.session);
    expect(correctionEntry(key)?.retained).toBe(true);
    expect(correctionEntry(key)?.state.minimum).toBe("12");
    const again = openCorrection(key, ME, () => CORRECTION_STATE, next);
    expect(again.session, "the next dialog resumes it").toBe(opened.session);
  });

  test("control: not adopted, the ended visit's input is dropped when its dialog lets go", async () => {
    const { first, back } = awayAndBack();
    const opened = openCorrection(key, ME, () => CORRECTION_STATE, first);
    editCorrection(key, opened.session, { ...CORRECTION_STATE, minimum: "12" });
    back();
    releaseCorrection(key, opened.session);
    await tick();
    expect(correctionEntry(key)).toBeNull();
  });

  test("another session of the key, or a session no dialog holds, is not taken over", async () => {
    const { first, back } = awayAndBack();
    const opened = openCorrection(key, ME, () => CORRECTION_STATE, first);
    editCorrection(key, opened.session, { ...CORRECTION_STATE, minimum: "12" });
    const next = back();
    adoptCorrection(key, opened.session + 1, next);
    releaseCorrection(key, opened.session);
    adoptCorrection(key, opened.session, next);
    await tick();
    expect(correctionEntry(key), "an ended visit's input").toBeNull();
  });
});
