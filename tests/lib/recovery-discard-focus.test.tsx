import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { AnnouncerProvider } from "../../src/components/ui/announcer";
import type { FocusTarget } from "../../src/lib/form-recovery/focus";
import type { RecoveryControls } from "../../src/lib/form-recovery/model";
import type {
  DiscardResult,
  RecoverySnapshot,
} from "../../src/lib/form-recovery/port";
import { RecoveryNotice } from "../../src/lib/form-recovery/RecoveryNotice";
import { noteNavigation } from "../../src/lib/pwa/navigation";

/**
 * WEB-14a revision 51 (review of 3 November 2026, F-R51-1; families `restored-form-focus-exposure-order`, `update-recovery-action-focus`;
 * design assessment of 3 November 2026, C2-C4, invariants 1-6, schedules Q2-Q4): a focused "Discard instead" returns focus to the
 * restored editor although the banner goes with the copy. The request is held by the OWNER (`RecoveryNotice`, `useDiscardFocus`), not the
 * banner, and is resolved from the committed DOM after the owner's reset, never when the copy's removal completes. It never takes focus
 * placed elsewhere, does not outlive its owner or the arrival, and makes no false transition for a discard that was not admitted.
 *
 * The owner here is a minimal editor over `RecoveryNotice` with controlled recovery controls: its discard resets the owner's state at the
 * gesture (as every product owner does, `model.ts` terminal) and returns a removal the test holds. Product callers are covered by their
 * own tests (People, lists, sharing, Record progress, entry history, the preset picker).
 */
afterEach(() => {
  document.body.innerHTML = "";
});

const SNAPSHOT: RecoverySnapshot = {
  formContext: "probe",
  tabInstanceId: "tab-1",
  values: { model: "restored" },
  savedAt: "2026-11-03T10:00:00.000Z",
};

interface Held {
  resolve(result: DiscardResult): void;
}

/**
 * `variant`: "stable" keeps one field; "replaced" swaps the field for another element at the reset (a reset that changes the target,
 * Q3); "absent" renders no field until the test inserts one (`showField`). `admit` false: the discard is refused and nothing changes.
 */
function Owner({
  variant = "stable",
  admit = true,
  held,
  pointerTarget = false,
  externalId,
}: {
  variant?: "stable" | "replaced" | "absent";
  admit?: boolean;
  held: Held[];
  pointerTarget?: boolean;
  /** The target is resolved by id from the document (a resolver that could find an element outside the owner's tree). */
  externalId?: string;
}) {
  const [restored, setRestored] = useState(true);
  const [reset, setReset] = useState(false);
  const [showField, setShowField] = useState(variant !== "absent");
  const first = useRef<HTMLInputElement>(null);
  const second = useRef<HTMLInputElement>(null);
  const target: FocusTarget = externalId
    ? () => document.getElementById(externalId)
    : variant === "replaced"
      ? () => second.current ?? first.current
      : first;
  const recovery: RecoveryControls = {
    view: {
      restored: restored ? SNAPSHOT : null,
      alternatives: [],
      unavailable: false,
      ready: true,
    },
    locked: false,
    discard: () => {
      if (!admit) return Promise.resolve<DiscardResult>("failed");
      setRestored(false);
      setReset(true);
      return new Promise<DiscardResult>((resolve) => {
        held.push({ resolve });
      });
    },
    retry: async () => true,
    checkAgain: async () => false,
    restoreAlternative: async () => "restored",
    discardAlternative: async () => "discarded",
  };
  return (
    <form>
      <RecoveryNotice recovery={recovery} firstFieldRef={target} />
      {variant === "replaced" && reset ? (
        <input key="amount" ref={second} aria-label="Amount" />
      ) : showField && !(variant === "replaced" && reset) ? (
        <input key="name" ref={first} aria-label="Name" />
      ) : null}
      <input aria-label="Other" />
      {pointerTarget ? <button type="button">Elsewhere</button> : null}
      <button type="button" onClick={() => setShowField(true)}>
        Show field
      </button>
      <button type="button" onClick={() => setRestored(false)}>
        End restore
      </button>
    </form>
  );
}

const mount = (props: Parameters<typeof Owner>[0]) =>
  render(
    <AnnouncerProvider>
      <Owner {...props} />
    </AnnouncerProvider>,
  );
const discardButton = () =>
  screen.getByRole("button", { name: "Discard instead" });
const field = (name: string) => screen.getByRole("textbox", { name });
/** "Discard instead" from the keyboard: the button has focus when pressed (the control proves it). */
function keyboardDiscard(): HTMLElement {
  const button = discardButton();
  button.focus();
  expect(button, "the control: Discard instead has focus").toHaveFocus();
  fireEvent.click(button);
  return button;
}
const flush = () => act(async () => undefined);

describe("a focused Discard instead returns focus to the restored editor (revision 51, F-R51-1)", () => {
  test("Q2 stable field: the restored field takes focus at the restore, and again after the discard; the banner is gone", async () => {
    const held: Held[] = [];
    mount({ held });
    expect(
      field("Name"),
      "state 3: the restored form's first field",
    ).toHaveFocus();
    keyboardDiscard();
    await flush();
    expect(
      document.querySelector('[data-recovery-state="restored"]'),
    ).toBeNull();
    expect(field("Name")).toHaveFocus();
    // The removal completing later changes nothing.
    await act(async () => held[0]?.resolve("discarded"));
    expect(field("Name")).toHaveFocus();
  });

  test("Q3 the reset replaces the target: the element the committed reset renders is focused, never the removed one", async () => {
    const held: Held[] = [];
    mount({ held, variant: "replaced" });
    expect(field("Name")).toHaveFocus();
    keyboardDiscard();
    await flush();
    expect(screen.queryByRole("textbox", { name: "Name" })).toBeNull();
    // Keys make the reset a real replacement of the DOM node (revision 51 sensitivity run 2026-11-03T18-18-48.431Z-8f616548: without them
    // React reused one input and this case could not see a target resolved before the commit).
    expect(field("Amount")).toHaveFocus();
  });

  test("Q4 no target yet: the request waits while focus is nowhere, and the field the owner renders next takes it", async () => {
    const held: Held[] = [];
    mount({ held, variant: "absent" });
    keyboardDiscard();
    await flush();
    expect(document.activeElement).toBe(document.body);
    // The owner renders its field without anyone moving focus (a programmatic owner change, not a click: a click would focus a button).
    act(() => {
      (
        screen.getByRole("button", { name: "Show field" }) as HTMLElement
      ).click();
    });
    await flush();
    expect(field("Name")).toHaveFocus();
  });

  test("CONTROL pointer: a discard clicked without focusing the button (Safari) moves nothing; focus stays where it was", async () => {
    const held: Held[] = [];
    mount({ held, pointerTarget: true });
    const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
    elsewhere.focus();
    fireEvent.click(discardButton());
    await flush();
    expect(
      document.querySelector('[data-recovery-state="restored"]'),
    ).toBeNull();
    expect(elsewhere).toHaveFocus();
  });

  test("I3 a discard that was not admitted (refused) leaves focus on its button, and no later change moves it", async () => {
    const held: Held[] = [];
    mount({ held, admit: false });
    // The restore's own request (state 3) is done: the field took focus at the restore.
    expect(field("Name")).toHaveFocus();
    const button = keyboardDiscard();
    await flush();
    expect(
      document.querySelector('[data-recovery-state="restored"]'),
      "nothing was discarded",
    ).not.toBeNull();
    expect(button).toHaveFocus();
    // A later change to the document (any mutation re-attempts pending requests) does not move it.
    document.body.appendChild(document.createElement("p"));
    await flush();
    expect(button).toHaveFocus();
    expect(held).toHaveLength(0);
    // The restored banner going later for another reason (a save, the owner's own change) is not that refused discard succeeding: its
    // field is not focused for it (the request ended once the gesture's commit showed the banner still there).
    field("Other").blur();
    act(() => {
      (
        screen.getByRole("button", { name: "End restore" }) as HTMLElement
      ).click();
    });
    await flush();
    expect(
      document.querySelector('[data-recovery-state="restored"]'),
    ).toBeNull();
    expect(field("Name")).not.toHaveFocus();
  });

  test("I4 focus placed elsewhere before the target appears is kept: the late field and the late removal never take it", async () => {
    const held: Held[] = [];
    mount({ held, variant: "absent" });
    keyboardDiscard();
    await flush();
    field("Other").focus();
    act(() => {
      (
        screen.getByRole("button", { name: "Show field" }) as HTMLElement
      ).click();
    });
    await flush();
    await act(async () => held[0]?.resolve("failed"));
    expect(field("Other")).toHaveFocus();
  });

  test("I6 a navigation before the target appears ends the request: the new route's field is not focused by the old discard", async () => {
    const held: Held[] = [];
    mount({ held, variant: "absent" });
    keyboardDiscard();
    await flush();
    act(() => noteNavigation());
    act(() => {
      (
        screen.getByRole("button", { name: "Show field" }) as HTMLElement
      ).click();
    });
    await flush();
    expect(field("Name")).not.toHaveFocus();
  });

  test("I6 the owner unmounted before the target appears withdraws the request: nothing of the old tree is focused later", async () => {
    const held: Held[] = [];
    const { unmount } = mount({ held, variant: "absent", externalId: "late" });
    keyboardDiscard();
    await flush();
    expect(document.activeElement).toBe(document.body);
    unmount();
    const late = document.body.appendChild(document.createElement("input"));
    late.id = "late";
    await flush();
    expect(late).not.toHaveFocus();
    expect(document.activeElement).toBe(document.body);
  });
});

/**
 * Decision D2 (Kieran, 3 November 2026; design assessment D2/Q8): restored forms of one arrival compete for focus. The first in the page
 * holds it: one restored later takes focus from another only when it comes first in the page AND focus is still on that other form's field;
 * otherwise its request ends. Forms pending together are attempted in page order. Focus the person moved is never taken.
 */
function Two({ first, second }: { first: boolean; second: boolean }) {
  const a = useRef<HTMLInputElement>(null);
  const b = useRef<HTMLInputElement>(null);
  const restored = (ref: typeof a, on: boolean) =>
    on ? (
      <RecoveryNotice
        firstFieldRef={ref}
        recovery={{
          view: {
            restored: SNAPSHOT,
            alternatives: [],
            unavailable: false,
            ready: true,
          },
          locked: false,
          discard: async () => "discarded",
          retry: async () => true,
          checkAgain: async () => false,
          restoreAlternative: async () => "restored",
          discardAlternative: async () => "discarded",
        }}
      />
    ) : null;
  return (
    <>
      <section>
        {restored(a, first)}
        <input ref={a} aria-label="First form" />
      </section>
      <section>
        {restored(b, second)}
        <input ref={b} aria-label="Second form" />
      </section>
      <input aria-label="Elsewhere" />
    </>
  );
}
const two = (first: boolean, second: boolean) => (
  <AnnouncerProvider>
    <Two first={first} second={second} />
  </AnnouncerProvider>
);

describe("D2: restored forms of one arrival (revision 51)", () => {
  test("the form first in the page, restored after the other, takes focus from it while focus is still on that form's field", () => {
    const { rerender } = render(two(false, true));
    expect(field("Second form")).toHaveFocus();
    rerender(two(true, true));
    expect(field("First form")).toHaveFocus();
  });

  test("a form later in the page, restored after the first, never takes its focus", () => {
    const { rerender } = render(two(true, false));
    expect(field("First form")).toHaveFocus();
    rerender(two(true, true));
    expect(field("First form")).toHaveFocus();
    document.body.appendChild(document.createElement("p"));
    expect(field("First form")).toHaveFocus();
  });

  test("CONTROL no theft: once the person moved focus, a form restored later (even first in the page) does not take it", () => {
    const { rerender } = render(two(false, true));
    expect(field("Second form")).toHaveFocus();
    field("Elsewhere").focus();
    rerender(two(true, true));
    expect(field("Elsewhere")).toHaveFocus();
  });

  test("both pending together (behind an inert hold): at the release the first in the page takes focus, and keeps it", async () => {
    const hold = document.body.appendChild(document.createElement("div"));
    hold.setAttribute("inert", "");
    // The second form's request is made first, the first form's after it: page order, not arrival, decides at the release.
    const { rerender } = render(two(false, true), { container: hold });
    rerender(two(true, true));
    expect(field("First form")).not.toHaveFocus();
    expect(field("Second form")).not.toHaveFocus();
    hold.removeAttribute("inert");
    await act(async () => undefined);
    expect(field("First form")).toHaveFocus();
  });
});

/**
 * WEB-14a revision 52 (Review52 F-R52-2, an incomplete fix of the D2 correction; design assessment of 3 November 2026, C2, F1-F4,
 * schedules Q7/Q9/Q10): focus is arbitrated against the CURRENT grant (the restore that most recently took focus), never the first request
 * that once did. Any number of owners, restored in any order, settle on the first in the page; focus moved by anyone else is never taken,
 * including onto an earlier, superseded restored field; a grant whose field went leaves focus to nobody's theft.
 */
const LABELS = ["Owner A", "Owner B", "Owner C", "Owner D"];
function Many({
  shown,
  swapped = [],
}: {
  shown: boolean[];
  swapped?: boolean[];
}) {
  return (
    <>
      {shown.map((on, n) => (
        <ManyOwner
          key={LABELS[n]}
          label={LABELS[n] as string}
          on={on}
          swapped={!!swapped[n]}
        />
      ))}
      <input aria-label="Elsewhere" />
    </>
  );
}
function ManyOwner({
  label,
  on,
  swapped,
}: {
  label: string;
  on: boolean;
  swapped: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <section>
      {on && (
        <RecoveryNotice
          firstFieldRef={ref}
          recovery={{
            view: {
              restored: SNAPSHOT,
              alternatives: [],
              unavailable: false,
              ready: true,
            },
            locked: false,
            discard: async () => "discarded",
            retry: async () => true,
            checkAgain: async () => false,
            restoreAlternative: async () => "restored",
            discardAlternative: async () => "discarded",
          }}
        />
      )}
      {/* A reset that REPLACES the field: a new element under the same ref (keyed). */}
      <input key={swapped ? "new" : "old"} ref={ref} aria-label={label} />
    </section>
  );
}
const many = (shown: boolean[], swapped: boolean[] = []) => (
  <AnnouncerProvider>
    <Many shown={shown} swapped={swapped} />
  </AnnouncerProvider>
);
/** The owners restore one by one in `order` (indices); the focused label after each restore. */
function restoreInOrder(count: number, order: number[]): string[] {
  const shown = Array.from({ length: count }, () => false);
  const { rerender } = render(many(shown));
  const seen: string[] = [];
  for (const n of order) {
    shown[n] = true;
    rerender(many([...shown]));
    seen.push(document.activeElement?.getAttribute("aria-label") ?? "none");
  }
  return seen;
}
const permutations = (items: number[]): number[][] =>
  items.length <= 1
    ? [items]
    : items.flatMap((item, at) =>
        permutations(items.filter((_, other) => other !== at)).map((rest) => [
          item,
          ...rest,
        ]),
      );

describe("revision 52 (F-R52-2): the current grant, not the first completed request, arbitrates focus", () => {
  afterEach(() => {
    // Each case is its own arrival (as a new page is): a grant kept for a displaced focus never reaches the next case.
    noteNavigation();
  });

  test("Review52's witness: three owners restored C, B, A end with focus on A (C, then B, then A)", () => {
    expect(restoreInOrder(3, [2, 1, 0])).toEqual([
      "Owner C",
      "Owner B",
      "Owner A",
    ]);
  });

  test("all six orders of three owners: each restore takes focus only if first in the page so far; the end is always A", () => {
    for (const order of permutations([0, 1, 2])) {
      const expected: string[] = [];
      let best = Number.POSITIVE_INFINITY;
      for (const n of order) {
        best = Math.min(best, n);
        expected.push(LABELS[best] as string);
      }
      expect(
        restoreInOrder(3, order),
        `order ${order.map((n) => LABELS[n]).join(", ")}`,
      ).toEqual(expected);
      document.body.innerHTML = "";
      noteNavigation();
    }
  });

  test("a four-owner descending chain D, C, B, A moves focus at every step and ends on A", () => {
    expect(restoreInOrder(4, [3, 2, 1, 0])).toEqual([
      "Owner D",
      "Owner C",
      "Owner B",
      "Owner A",
    ]);
  });

  test("CONTROL A, B, C stays on A; a later document change never moves it", async () => {
    expect(restoreInOrder(3, [0, 1, 2])).toEqual([
      "Owner A",
      "Owner A",
      "Owner A",
    ]);
    document.body.appendChild(document.createElement("p"));
    await act(async () => undefined);
    expect(field("Owner A")).toHaveFocus();
  });

  test("Q9 no theft: after C then B, the person moves focus elsewhere; A restored later does not take it", () => {
    const { rerender } = render(many([false, false, true]));
    rerender(many([false, true, true]));
    expect(field("Owner B")).toHaveFocus();
    field("Elsewhere").focus();
    rerender(many([true, true, true]));
    expect(field("Elsewhere")).toHaveFocus();
  });

  test("Q9 no stale authority: after C then B, the person moves focus onto C's field; A restored later does not take it", () => {
    const { rerender } = render(many([false, false, true]));
    rerender(many([false, true, true]));
    field("Owner C").focus();
    rerender(many([true, true, true]));
    expect(
      field("Owner C"),
      "C's superseded grant gives A no licence",
    ).toHaveFocus();
  });

  test("Q9 the current holder's owner withdraws its restore (copy discarded) while focus is still on its field: A restored later takes focus", () => {
    const { rerender } = render(many([false, false, true]));
    rerender(many([false, true, true]));
    expect(field("Owner B")).toHaveFocus();
    rerender(many([false, false, true]));
    expect(field("Owner B")).toHaveFocus();
    rerender(many([true, false, true]));
    expect(field("Owner A")).toHaveFocus();
  });

  test("Q9 the current holder's owner withdraws after the person moved focus elsewhere: A restored later still does not take it", () => {
    const { rerender } = render(many([false, false, true]));
    rerender(many([false, true, true]));
    field("Elsewhere").focus();
    rerender(many([false, false, true]));
    rerender(many([true, false, true]));
    expect(field("Elsewhere")).toHaveFocus();
  });

  test("Q9 the granted field is REPLACED (focus left nowhere): A restored later takes focus, as nobody's focus is taken", () => {
    const { rerender } = render(many([false, false, true]));
    rerender(many([false, true, true]));
    expect(field("Owner B")).toHaveFocus();
    rerender(many([false, true, true], [false, true, false]));
    expect(document.activeElement).toBe(document.body);
    rerender(many([true, true, true], [false, true, false]));
    expect(field("Owner A")).toHaveFocus();
  });

  test("Q9 a navigation ends the grant: a restore of the new arrival takes focus wherever the old one left it", () => {
    const { rerender } = render(many([false, false, true]));
    expect(field("Owner C")).toHaveFocus();
    field("Elsewhere").focus();
    noteNavigation();
    rerender(many([false, true, true]));
    expect(field("Owner B")).toHaveFocus();
  });

  test("Q10: three restores pending behind an inert hold settle, at the release, on the first in the page", async () => {
    const hold = document.body.appendChild(document.createElement("div"));
    hold.setAttribute("inert", "");
    const { rerender } = render(many([false, false, true]), {
      container: hold,
    });
    rerender(many([false, true, true]));
    rerender(many([true, true, true]));
    expect(document.activeElement).toBe(document.body);
    hold.removeAttribute("inert");
    await act(async () => undefined);
    expect(field("Owner A")).toHaveFocus();
  });
});

/**
 * WEB-14a revision 53, decision D-R53-2 (Kieran, 3 November 2026: /Users/kieran/atlas/atlas-orchestrator/approval/
 * web14a-r53-decisions-20261103.json): another saved copy chosen while the restored banner stays mounted (no new `shown` transition)
 * issues a fresh request, once the choice is APPLIED, for that form's first eligible field (`useChoiceFocus`, the "chosen" request).
 * Mechanism cases over `RecoveryNotice` with held choices; the actual household and policy editors are in
 * `tests/features/recovery-check-again.test.tsx`.
 */
const ALT: RecoverySnapshot = {
  ...SNAPSHOT,
  tabInstanceId: "tab-2",
  savedAt: "2026-11-03T09:00:00.000Z",
};
const CHOOSE = /^Restore the copy saved/;
interface Choice {
  resolve(result: "restored" | "refused" | "gone"): void;
}
/** An owner showing a restored copy with one other copy offered; a choice is held until the test resolves it (applied: its row goes). */
function Chooser({
  label,
  choices,
  restored = true,
  keepRow = false,
}: {
  label: string;
  choices: Choice[];
  restored?: boolean;
  keepRow?: boolean;
}) {
  const [alternatives, setAlternatives] = useState<RecoverySnapshot[]>([ALT]);
  const ref = useRef<HTMLInputElement>(null);
  return (
    <section>
      <RecoveryNotice
        firstFieldRef={ref}
        recovery={{
          view: {
            restored: restored ? SNAPSHOT : null,
            alternatives,
            unavailable: false,
            ready: true,
          },
          locked: false,
          discard: async () => "discarded",
          retry: async () => true,
          checkAgain: async () => false,
          restoreAlternative: () =>
            new Promise((resolve) =>
              choices.push({
                resolve: (result) => {
                  if (result === "restored" && !keepRow) setAlternatives([]);
                  resolve(result);
                },
              }),
            ),
          discardAlternative: async () => "discarded",
        }}
      />
      <input ref={ref} aria-label={label} />
    </section>
  );
}
const choose = (label: string) =>
  within(
    screen
      .getByRole("textbox", { name: label })
      .closest("section") as HTMLElement,
  ).getByRole("button", { name: CHOOSE });

describe("revision 53 (D-R53-2): an explicit choice while the restored banner stays focuses the chosen form's first field", () => {
  afterEach(() => {
    noteNavigation();
  });
  const one = (
    choices: Choice[],
    props: Partial<Parameters<typeof Chooser>[0]> = {},
  ) =>
    render(
      <AnnouncerProvider>
        <Chooser label="Chosen" choices={choices} {...props} />
        <input aria-label="Elsewhere" />
      </AnnouncerProvider>,
    );

  test("applied: the first field takes focus once the chosen copy's row has gone, never before (never the removed button)", async () => {
    const choices: Choice[] = [];
    one(choices, { keepRow: true });
    noteNavigation();
    const button = choose("Chosen");
    button.focus();
    fireEvent.click(button);
    await act(async () => choices[0]?.resolve("restored"));
    expect(button.isConnected).toBe(true);
    expect(
      button,
      "the owner's change is not committed: nothing moves yet",
    ).toHaveFocus();
    button.remove();
    await flush();
    expect(field("Chosen")).toHaveFocus();
  });

  test("applied with the row removed at once: focus lands on the first field", async () => {
    const choices: Choice[] = [];
    one(choices);
    noteNavigation();
    const button = choose("Chosen");
    button.focus();
    fireEvent.click(button);
    await act(async () => choices[0]?.resolve("restored"));
    expect(button.isConnected).toBe(false);
    expect(field("Chosen")).toHaveFocus();
  });

  test("CONTROL: a choice refused or gone makes no request", async () => {
    for (const result of ["refused", "gone"] as const) {
      const choices: Choice[] = [];
      const { unmount } = one(choices, { keepRow: false });
      noteNavigation();
      const button = choose("Chosen");
      button.focus();
      fireEvent.click(button);
      await act(async () => choices[0]?.resolve(result));
      button.remove();
      await flush();
      expect(field("Chosen"), result).not.toHaveFocus();
      unmount();
    }
  });

  test("focus moved by the person before the choice is applied is never taken", async () => {
    const choices: Choice[] = [];
    one(choices);
    noteNavigation();
    const button = choose("Chosen");
    button.focus();
    fireEvent.click(button);
    field("Elsewhere").focus();
    await act(async () => choices[0]?.resolve("restored"));
    expect(field("Elsewhere")).toHaveFocus();
  });

  test("where focus was at the choice (a browser that does not focus a clicked button) is not focus moved since", async () => {
    const choices: Choice[] = [];
    one(choices);
    noteNavigation();
    field("Elsewhere").focus();
    fireEvent.click(choose("Chosen"));
    await act(async () => choices[0]?.resolve("restored"));
    expect(field("Chosen")).toHaveFocus();
  });

  test("a newer choice supersedes an older one still being read: the older one's late success requests nothing", async () => {
    const choices: Choice[] = [];
    one(choices, { keepRow: true });
    noteNavigation();
    const button = choose("Chosen");
    button.focus();
    fireEvent.click(button);
    fireEvent.click(button);
    await act(async () => choices[0]?.resolve("restored"));
    button.remove();
    await flush();
    expect(
      field("Chosen"),
      "the older choice requested nothing",
    ).not.toHaveFocus();
    await act(async () => choices[1]?.resolve("restored"));
    await flush();
    expect(field("Chosen")).toHaveFocus();
  });

  test("a navigation or the owner's unmount before the choice is applied ends it", async () => {
    const choices: Choice[] = [];
    const { unmount } = one(choices);
    noteNavigation();
    const button = choose("Chosen");
    button.focus();
    fireEvent.click(button);
    noteNavigation();
    await act(async () => choices[0]?.resolve("restored"));
    expect(field("Chosen"), "navigation").not.toHaveFocus();
    unmount();
    const again: Choice[] = [];
    const second = one(again);
    noteNavigation();
    const other = choose("Chosen");
    other.focus();
    fireEvent.click(other);
    const target = field("Chosen");
    second.unmount();
    document.body.append(target);
    await act(async () => again[0]?.resolve("restored"));
    expect(target, "unmount").not.toHaveFocus();
  });

  test("CONTROL: with no restored banner shown the choice makes no chosen request (the banner's own arrival focuses, D2)", async () => {
    const choices: Choice[] = [];
    one(choices, { restored: false });
    noteNavigation();
    const button = choose("Chosen");
    button.focus();
    fireEvent.click(button);
    await act(async () => choices[0]?.resolve("restored"));
    expect(field("Chosen"), "no request of its own").not.toHaveFocus();
  });

  test("the person's choice supersedes an automatic restore still waiting behind an inert hold: released later, it never takes focus", async () => {
    const choices: Choice[] = [];
    const hold = document.body.appendChild(document.createElement("div"));
    render(
      <AnnouncerProvider>
        <Chooser label="Chosen" choices={choices} />
      </AnnouncerProvider>,
    );
    noteNavigation();
    hold.setAttribute("inert", "");
    render(many([true]), { container: hold });
    expect(field("Owner A")).not.toHaveFocus();
    const button = choose("Chosen");
    button.focus();
    fireEvent.click(button);
    await act(async () => choices[0]?.resolve("restored"));
    expect(field("Chosen")).toHaveFocus();
    hold.removeAttribute("inert");
    await flush();
    expect(field("Chosen"), "the waiting restore was cancelled").toHaveFocus();
  });

  test("after a chosen form took focus, a later automatic restore earlier in the page does not take it (the current grant's rule)", async () => {
    const choices: Choice[] = [];
    noteNavigation();
    // Owner B restores automatically (the current grant), then the person chooses another copy in the chosen form.
    const autos = render(many([false, true]));
    expect(field("Owner B")).toHaveFocus();
    render(
      <AnnouncerProvider>
        <Chooser label="Chosen" choices={choices} />
      </AnnouncerProvider>,
    );
    const button = choose("Chosen");
    button.focus();
    fireEvent.click(button);
    await act(async () => choices[0]?.resolve("restored"));
    expect(field("Chosen")).toHaveFocus();
    autos.rerender(many([true, true]));
    await flush();
    expect(
      field("Chosen"),
      "Owner A does not take the chosen form's focus",
    ).toHaveFocus();
  });
});

/**
 * WEB-14a revision 55 (Review 54, F-R54-1; design assessment of 5 November 2026, RC-1, correction C-F1, invariants F-5 to F-8, schedules
 * T-F1 to T-F7): a LANDED choice is the person's placement. It becomes the arrival's current grant with its own kind ("chosen"), so no
 * automatic restore of the arrival takes it, whichever form held the automatic grant before (the chosen form itself, manifestation a, or
 * another form whose restore is later withdrawn, manifestation b). It ends only at a navigation, or when focus is nowhere (its field went);
 * another owner's withdrawal, or a newer choice still being read, never opens a window for an automatic restore. D1, D2 among automatic
 * restores, DA-F1/DA-F2 and the discard return are unchanged. Owner A precedes the other owners and the chosen form in the page throughout.
 */
const ALT2: RecoverySnapshot = {
  ...SNAPSHOT,
  tabInstanceId: "tab-3",
  savedAt: "2026-11-03T08:00:00.000Z",
};
interface HeldPick {
  id: string;
  resolve(result: "restored" | "refused"): void;
}
/** A restored owner offering two other copies; each choice is held until the test resolves it (applied: only its own row goes). */
function TwoChoices({ picks }: { picks: HeldPick[] }) {
  const [alternatives, setAlternatives] = useState<RecoverySnapshot[]>([
    ALT,
    ALT2,
  ]);
  const ref = useRef<HTMLInputElement>(null);
  return (
    <section>
      <RecoveryNotice
        firstFieldRef={ref}
        recovery={{
          view: {
            restored: SNAPSHOT,
            alternatives,
            unavailable: false,
            ready: true,
          },
          locked: false,
          discard: async () => "discarded",
          retry: async () => true,
          checkAgain: async () => false,
          restoreAlternative: (chosen) =>
            new Promise((resolve) =>
              picks.push({
                id: chosen.tabInstanceId,
                resolve: (result) => {
                  if (result === "restored")
                    setAlternatives((now) =>
                      now.filter((copy) => copy !== chosen),
                    );
                  resolve(result);
                },
              }),
            ),
          discardAlternative: async () => "discarded",
        }}
      />
      <input ref={ref} aria-label="Chosen" />
    </section>
  );
}

describe("revision 55 (F-R54-1): a landed choice is the person's placement, whichever form held the automatic grant", () => {
  afterEach(() => {
    noteNavigation();
  });
  /** The automatic owners (Owner A, Owner B, then Elsewhere) first in the page, then the chosen form. */
  const scene = (autos: boolean[], choices: Choice[]) => {
    noteNavigation();
    const owners = render(many(autos));
    const chosen = render(
      <AnnouncerProvider>
        <Chooser label="Chosen" choices={choices} />
      </AnnouncerProvider>,
    );
    return { owners, chosen };
  };
  /** The person chooses the other copy from the keyboard; it is applied and its row goes. */
  async function applyChoice(choices: Choice[]): Promise<void> {
    const button = choose("Chosen");
    button.focus();
    fireEvent.click(button);
    await act(async () => choices[0]?.resolve("restored"));
    expect(button.isConnected, "the chosen copy's row went").toBe(false);
    expect(field("Chosen"), "the choice landed").toHaveFocus();
  }

  test("T-F1 SAME GRANT (Review 54): the chosen form holds the automatic grant; an earlier form restored later never takes the applied choice", async () => {
    const choices: Choice[] = [];
    const { owners } = scene([false, false], choices);
    expect(field("Chosen"), "the only restore holds the grant").toHaveFocus();
    await applyChoice(choices);
    owners.rerender(many([true, false]));
    await flush();
    expect(
      field("Chosen"),
      "F-R54-1 (a): a later automatic restore earlier in the page does not take the person's applied choice",
    ).toHaveFocus();
  });

  test("T-F1 CONTROL (D2 unchanged): with no choice, the earlier form restored later takes focus from the automatic grant", async () => {
    const choices: Choice[] = [];
    const { owners } = scene([false, false], choices);
    expect(field("Chosen")).toHaveFocus();
    owners.rerender(many([true, false]));
    await flush();
    expect(field("Owner A"), "D2: first in the page").toHaveFocus();
  });

  test("T-F2 (manifestation b): another form held the grant; after the choice its copy is discarded, or it unmounts; an earlier form restored later never takes the choice", async () => {
    for (const gone of ["discarded", "unmounted"] as const) {
      const choices: Choice[] = [];
      const { owners, chosen } = scene([false, true], choices);
      expect(field("Owner B"), "Owner B holds the grant").toHaveFocus();
      await applyChoice(choices);
      owners.rerender(many(gone === "discarded" ? [false, false] : [false]));
      await flush();
      expect(field("Chosen"), `${gone}: the grant holder went`).toHaveFocus();
      owners.rerender(many(gone === "discarded" ? [true, false] : [true]));
      await flush();
      expect(
        field("Chosen"),
        `F-R54-1 (b), ${gone}: Owner A does not take the person's applied choice`,
      ).toHaveFocus();
      owners.unmount();
      chosen.unmount();
      noteNavigation();
    }
  });

  test("T-F2 CONTROLS: without a choice the documented withdrawal rule lets the earlier form take focus; focus the person put on the chosen form by hand is never taken", async () => {
    // The documented D2 withdrawal: Owner B's copy is discarded while focus is still on its field, then Owner A restores.
    noteNavigation();
    const owners = render(many([false, true]));
    expect(field("Owner B")).toHaveFocus();
    owners.rerender(many([false, false]));
    owners.rerender(many([true, false]));
    await flush();
    expect(field("Owner A"), "nobody's focus is taken").toHaveFocus();
    owners.unmount();
    // By hand: Owner B holds the grant, the person moves to the chosen form's field, Owner B's copy is discarded, Owner A restores.
    const choices: Choice[] = [];
    const again = scene([false, true], choices);
    expect(field("Owner B")).toHaveFocus();
    field("Chosen").focus();
    again.owners.rerender(many([false, false]));
    again.owners.rerender(many([true, false]));
    await flush();
    expect(field("Chosen"), "focus moved by hand is never taken").toHaveFocus();
  });

  test("T-F4: after a landed choice the person moves focus elsewhere; a later restore takes nothing", async () => {
    const choices: Choice[] = [];
    const { owners } = scene([false, false], choices);
    await applyChoice(choices);
    field("Elsewhere").focus();
    owners.rerender(many([true, false]));
    await flush();
    expect(field("Elsewhere")).toHaveFocus();
  });

  test("T-F5: a navigation ends the person's placement; a restore of the NEW arrival takes focus", async () => {
    const choices: Choice[] = [];
    const { owners } = scene([false, false], choices);
    await applyChoice(choices);
    act(() => noteNavigation());
    owners.rerender(many([true, false]));
    await flush();
    expect(field("Owner A"), "the new arrival's restore").toHaveFocus();
  });

  test("T-F6: the chosen owner unmounts with focus nowhere: a later restore takes nobody's focus; CONTROL: focus moved first is kept", async () => {
    for (const moved of [false, true]) {
      const choices: Choice[] = [];
      const { owners, chosen } = scene([false, false], choices);
      await applyChoice(choices);
      if (moved) field("Elsewhere").focus();
      chosen.unmount();
      if (!moved) expect(document.activeElement).toBe(document.body);
      owners.rerender(many([true, false]));
      await flush();
      if (moved)
        expect(
          field("Elsewhere"),
          "moved before the unmount: kept",
        ).toHaveFocus();
      else
        expect(
          field("Owner A"),
          "the chosen field went, focus nowhere: the restore takes nobody's focus",
        ).toHaveFocus();
      owners.unmount();
      noteNavigation();
    }
  });

  test("T-F7: a newer choice made by pointer while focus is on the chosen field, still being read, opens no window: a late automatic restore takes nothing; the newer choice then lands", async () => {
    noteNavigation();
    const owners = render(many([false, false]));
    const picks: HeldPick[] = [];
    render(
      <AnnouncerProvider>
        <TwoChoices picks={picks} />
      </AnnouncerProvider>,
    );
    expect(field("Chosen"), "the only restore holds the grant").toHaveFocus();
    const first = within(
      field("Chosen").closest("section") as HTMLElement,
    ).getAllByRole("button", { name: CHOOSE })[0] as HTMLElement;
    first.focus();
    fireEvent.click(first);
    await act(async () => picks[0]?.resolve("restored"));
    expect(field("Chosen"), "the first choice landed").toHaveFocus();
    // The newer choice by pointer: the browser leaves focus on the chosen field (no button focus).
    const second = within(
      field("Chosen").closest("section") as HTMLElement,
    ).getByRole("button", { name: CHOOSE });
    fireEvent.click(second);
    expect(field("Chosen")).toHaveFocus();
    owners.rerender(many([true, false]));
    await flush();
    expect(
      field("Chosen"),
      "the older choice's withdrawal by the newer one left no window for Owner A",
    ).toHaveFocus();
    await act(async () => picks[1]?.resolve("restored"));
    await flush();
    expect(second.isConnected).toBe(false);
    expect(field("Chosen"), "the newer choice lands").toHaveFocus();
  });
});
