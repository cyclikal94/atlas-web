import { afterEach, describe, expect, test } from "vitest";
import { EMPTY_ANCHOR } from "../../../src/features/calendars/model/anchor";
import {
  forgetKeptPanels,
  keptPanelKey,
  openPanel,
  retainPanel,
} from "../../../src/features/tasks/detail/anchor-kept";
import {
  forgetTaskVisits,
  type TaskVisit,
  visitHere,
} from "../../../src/features/tasks/visit";

/**
 * WEB-13b revision 3 (review 3 R3c; design assessment invariant 1): the task detail's anchor sessions are owned by the visit going on when a
 * panel opens. The registry alone (no section, no router): a visit that has ended owns nothing, so no panel opens on it and nothing is kept
 * for it; the visit going on keeps what its sync control kept. The section's own choice of that visit is tested over the production router
 * in `anchor-section.test.tsx` ("revision 3").
 */
const IDENTITY = "11111111-1111-4111-8111-111111111111:1";
const ADDRESS = "/tasks/00000000-0000-4000-8000-0000000000t1";
const KEY = keptPanelKey(IDENTITY, "00000000-0000-4000-8000-0000000000t1");
const fresh = () => ({ draft: EMPTY_ANCHOR, names: {}, context: null });
const same = (c: null) => c;

afterEach(() => {
  forgetKeptPanels();
  forgetTaskVisits();
});

/** A visit of the task's screen, then its end (as an ordinary departure ends it). */
function endedVisit(): TaskVisit {
  const visit = visitHere(IDENTITY, ADDRESS);
  forgetTaskVisits();
  expect(visit.ended()).toBe(true);
  return visit;
}

describe("the anchor sessions' owner (revision 3)", () => {
  test("no panel opens on a visit that has ended, and nothing is kept for it", () => {
    const ended = endedVisit();
    expect(openPanel(KEY, ended, fresh, same)).toBeNull();
    // The visit going on at the same address starts afresh: nothing the ended one was asked to open is there.
    const going = visitHere(IDENTITY, ADDRESS);
    expect(going).not.toBe(ended);
    const editor = openPanel(KEY, going, fresh, same);
    expect(editor).not.toBeNull();
    expect(editor?.state().revision).toBe(0);
  });

  test("control: the visit going on keeps the session its sync control kept, and shows the same one again", () => {
    const going = visitHere(IDENTITY, ADDRESS);
    const editor = openPanel(KEY, going, fresh, same);
    if (editor === null) throw new Error("no session");
    editor.edit({ titleContains: "kept" });
    retainPanel(KEY, editor as never);
    expect(editor.retained()).toBe(true);
    const again = openPanel(KEY, going, fresh, same);
    expect(again).toBe(editor);
    expect(again?.state().draft.titleContains).toBe("kept");
  });

  test("a session kept on a visit that then ends is not shown by the next visit's panel", () => {
    const first = visitHere(IDENTITY, ADDRESS);
    const editor = openPanel(KEY, first, fresh, same);
    if (editor === null) throw new Error("no session");
    editor.edit({ titleContains: "kept" });
    retainPanel(KEY, editor as never);
    forgetTaskVisits();
    expect(editor.ended()).toBe(true);
    const next = openPanel(KEY, visitHere(IDENTITY, ADDRESS), fresh, same);
    expect(next).not.toBe(editor);
    expect(next?.state().revision).toBe(0);
  });

  test("outside any router (no visit) a panel opens with its own session, never kept", () => {
    const editor = openPanel(KEY, null, fresh, same);
    if (editor === null) throw new Error("no session");
    editor.edit({ titleContains: "mine" });
    retainPanel(KEY, editor as never);
    expect(editor.retained()).toBe(false);
  });
});
