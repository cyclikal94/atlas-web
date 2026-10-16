import { act, cleanup, render, screen, within } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  liveRegions,
  NeutralLiveRegion,
  neutralLiveRegion,
} from "../../src/components/ui/announcer";
import {
  DISCARD_FAILED_TEXT,
  SAVE_FAILED_TEXT,
  SAVE_REFUSED_TEXT,
} from "../../src/lib/form-recovery/RecoveryBanner";
import { pageFormRegistry } from "../../src/lib/form-recovery/registry";
import {
  type AppUpdatesActions,
  appUpdates,
  type UpdateState,
} from "../../src/lib/pwa/store";
import {
  AppUpdateBanner,
  AVAILABLE_TEXT,
  ELSEWHERE_TEXT,
  NEUTRAL_DISCARD_FAILED_TEXT,
  NEUTRAL_SAVE_FAILED_TEXT,
  NEUTRAL_SAVE_REFUSED_TEXT,
  NeutralUpdateBanner,
  noticeOf,
  RELOADING_TEXT,
  SAVING_TEXT,
  SUPERSEDED_TEXT,
} from "../../src/lib/pwa/UpdateBanner";
import { UiProviders } from "../helpers/providers";

/**
 * WEB-14a revision 12, R19 (design assessment C1-C3, I1-I3/I8, Q1/Q3, S1/S15): EVERY update state has its notice and choices on BOTH
 * surfaces, the shell (`AppUpdateBanner`, in the protected tree's providers) and the neutral root (`NeutralUpdateBanner`, no provider).
 * The table below is written out here, independently of `noticeOf`: each choice's button, the one coordinator action it asks for (once,
 * only when clicked), and the same choices on both surfaces. The neutral wording names no form, field or account and never says the form
 * is still on screen. Announcements: the neutral region says the current state, once, and never revives what the session gate cleared.
 */
type Act = keyof AppUpdatesActions;
const ROWS: ReadonlyArray<
  [
    string,
    UpdateState,
    { protected: string; neutral: string } | null,
    ReadonlyArray<[string, Act]>,
  ]
> = [
  ["none", { kind: "none" }, null, []],
  ["available, dismissed", { kind: "available", dismissed: true }, null, []],
  [
    "updated elsewhere, dismissed",
    { kind: "updated_elsewhere", dismissed: true },
    null,
    [],
  ],
  [
    "available",
    { kind: "available", dismissed: false },
    { protected: AVAILABLE_TEXT, neutral: AVAILABLE_TEXT },
    [
      ["Reload", "accept"],
      ["Not now", "notNow"],
    ],
  ],
  [
    "updated elsewhere",
    { kind: "updated_elsewhere", dismissed: false },
    { protected: ELSEWHERE_TEXT, neutral: ELSEWHERE_TEXT },
    [
      ["Reload here", "accept"],
      ["Not now", "notNow"],
    ],
  ],
  [
    "saving",
    { kind: "saving" },
    { protected: SAVING_TEXT, neutral: SAVING_TEXT },
    [],
  ],
  [
    "reloading",
    { kind: "reloading" },
    { protected: RELOADING_TEXT, neutral: RELOADING_TEXT },
    [],
  ],
  [
    "data superseded",
    { kind: "data_superseded" },
    { protected: SUPERSEDED_TEXT, neutral: SUPERSEDED_TEXT },
    [["Reload here", "accept"]],
  ],
  [
    "save failed",
    { kind: "save_failed", refused: false },
    { protected: SAVE_FAILED_TEXT, neutral: NEUTRAL_SAVE_FAILED_TEXT },
    [
      ["Retry save", "retrySave"],
      ["Discard and reload anyway", "discardAndReload"],
    ],
  ],
  [
    "save refused",
    { kind: "save_failed", refused: true },
    { protected: SAVE_REFUSED_TEXT, neutral: NEUTRAL_SAVE_REFUSED_TEXT },
    [["Discard and reload anyway", "discardAndReload"]],
  ],
  [
    "discard failed",
    { kind: "discard_failed" },
    { protected: DISCARD_FAILED_TEXT, neutral: NEUTRAL_DISCARD_FAILED_TEXT },
    [
      ["Try again", "discardAndReload"],
      ["Reload anyway", "reloadAnyway"],
    ],
  ],
];
/** What the neutral wording must still tell the person, whatever its final copy (I3: the refusal, the retry, the discard's warning). */
const MUST_SAY: Readonly<Record<string, RegExp>> = {
  "save failed": /retry saving/,
  "save refused": /sign-out/,
  "discard failed": /may be restored/,
};
const ACTS: readonly Act[] = [
  "accept",
  "retrySave",
  "discardAndReload",
  "reloadAnyway",
  "notNow",
];

const spies = (): AppUpdatesActions => ({
  accept: vi.fn(),
  retrySave: vi.fn(),
  discardAndReload: vi.fn(),
  reloadAnyway: vi.fn(),
  notNow: vi.fn(),
});
const calls = (actions: AppUpdatesActions) =>
  Object.fromEntries(
    ACTS.map((name) => [name, vi.mocked(actions[name]).mock.calls.length]),
  );
const frame = () =>
  act(() => new Promise((resolve) => requestAnimationFrame(() => resolve(0))));

afterEach(() => {
  cleanup();
  act(() => appUpdates.set({ kind: "none" }));
  neutralLiveRegion.clear();
  vi.restoreAllMocks();
});

const surface = (which: "protected" | "neutral") =>
  which === "protected" ? (
    <UiProviders>
      <AppUpdateBanner />
    </UiProviders>
  ) : (
    <>
      <NeutralLiveRegion />
      <NeutralUpdateBanner />
    </>
  );

describe("R19 (S1): every update state, on both surfaces", () => {
  for (const [name, state, text, expected] of ROWS)
    for (const which of ["protected", "neutral"] as const)
      test(`${name} on the ${which === "protected" ? "shell" : "neutral root"}: ${expected.length === 0 ? "no choices" : expected.map(([label, act]) => `'${label}' asks ${act}`).join(", ")}`, () => {
        // A recoverable form of an account is open in the page (in the protected tree, or kept while a gate hides it).
        const off = pageFormRegistry.register({
          formContext: "SENTINEL-CONTEXT",
          isDirty: () => true,
          flush: async () => "failed",
        });
        try {
          const actions = spies();
          // `available` with a form open is Q4 state 1 on the shell (its own test); here the form is registered only for the others.
          if (which === "protected" && state.kind === "available") off();
          act(() => appUpdates.set(state, actions));
          const { container } = render(surface(which));
          // Mounting, rendering and announcing choose nothing.
          expect(calls(actions)).toEqual(calls(spies()));
          const banner = screen.queryByRole("region", { name: "Update" });
          if (!text) {
            expect(banner).toBeNull();
            expect(noticeOf(state, which)).toBeNull();
            return;
          }
          expect(banner).not.toBeNull();
          const region = within(banner as HTMLElement);
          expect(region.queryByText(text[which])).not.toBeNull();
          const buttons = region.queryAllByRole("button");
          expect(
            buttons.map(
              (button) =>
                button.getAttribute("aria-label") ?? button.textContent,
            ),
          ).toEqual(expected.map(([label]) => label));
          // The policy names the same choices on both surfaces.
          expect(
            noticeOf(state, which)?.choices.map((c) => [c.label, c.act]),
          ).toEqual(expected);
          // Each button asks exactly its own action, once.
          expected.forEach(([, wanted], index) => {
            const before = calls(actions);
            act(() => buttons[index]?.click());
            const after = calls(actions);
            for (const name of ACTS)
              expect((after[name] ?? 0) - (before[name] ?? 0)).toBe(
                name === wanted ? 1 : 0,
              );
          });
          if (which === "neutral") {
            const words = container.textContent ?? "";
            expect(words).not.toContain("SENTINEL-CONTEXT");
            expect(words).not.toMatch(
              /still here|your form is|Nothing was lost/,
            );
            const must = MUST_SAY[name];
            if (must) expect(region.queryByText(must)).not.toBeNull();
          }
        } finally {
          off();
        }
      });

  test("the shell's failures are the form's recovery banner (Q4 state 2); the neutral root's are its own, with the same choices", () => {
    for (const state of [
      { kind: "save_failed", refused: false },
      { kind: "save_failed", refused: true },
      { kind: "discard_failed" },
    ] as const) {
      act(() => appUpdates.set(state, spies()));
      const shell = render(surface("protected"));
      expect(
        shell.container.querySelector("[data-recovery-state]"),
      ).not.toBeNull();
      shell.unmount();
      const neutral = render(surface("neutral"));
      expect(
        neutral.container.querySelector("[data-recovery-state]"),
      ).toBeNull();
      expect(
        neutral.container.querySelector(`[data-app-update="${state.kind}"]`),
      ).not.toBeNull();
      neutral.unmount();
    }
  });

  test.each(["light", "dark"])(
    "neutral failures are axe clean (%s)",
    async (theme) => {
      document.documentElement.dataset.theme = theme;
      for (const state of [
        { kind: "save_failed", refused: false },
        { kind: "save_failed", refused: true },
        { kind: "discard_failed" },
      ] as const) {
        act(() => appUpdates.set(state, spies()));
        const { container, unmount } = render(surface("neutral"));
        expect((await axe(container)).violations).toEqual([]);
        unmount();
      }
      delete document.documentElement.dataset.theme;
    },
  );
});

describe("R19 (S15): the neutral root's announcements follow the state", () => {
  /**
   * Revision 19 (R26) adaptation, labelled: this test asserted "focus is not moved" for the failure too. Its intent (a message is announced
   * through the live region, not by moving focus) is kept for the plain "Saving…" notice; a failure of the person's own act now focuses its
   * recovery action (form-recovery-reload.html, state 2: "focus moves to Retry save"), once per presentation, and only there.
   */
  test("'Saving…' is announced without moving focus; the failure replacing it is announced once (a re-render or an equal publication repeats nothing) and focuses its recovery action once", async () => {
    const announce = vi.spyOn(neutralLiveRegion, "announce");
    const { rerender } = render(surface("neutral"));
    const region = screen.getByRole("status");
    const focused = document.activeElement;
    act(() => appUpdates.set({ kind: "saving" }, spies()));
    await frame();
    expect(region).toHaveTextContent(SAVING_TEXT);
    expect(document.activeElement).toBe(focused);
    act(() => appUpdates.set({ kind: "save_failed", refused: false }));
    await frame();
    expect(region).toHaveTextContent(NEUTRAL_SAVE_FAILED_TEXT);
    expect(screen.getByRole("button", { name: "Retry save" })).toHaveFocus();
    // The person moves on; nothing below takes focus back for the same failure.
    const elsewhere = document.body.appendChild(
      document.createElement("button"),
    );
    elsewhere.focus();
    const count = announce.mock.calls.length;
    rerender(surface("neutral"));
    // The coordinator publishes an equal state again (a new object): nothing new to say, and focus stays where the person put it.
    act(() => appUpdates.set({ kind: "save_failed", refused: false }));
    await frame();
    expect(announce.mock.calls.length).toBe(count);
    expect(region).toHaveTextContent(NEUTRAL_SAVE_FAILED_TEXT);
    expect(elsewhere).toHaveFocus();
    // The discard then fails: that is announced in its place, and is a new presentation, whose first choice takes focus.
    act(() => appUpdates.set({ kind: "discard_failed" }));
    await frame();
    expect(region).toHaveTextContent(NEUTRAL_DISCARD_FAILED_TEXT);
    expect(screen.getByRole("button", { name: "Try again" })).toHaveFocus();
    elsewhere.remove();
  });

  test("a failure already there when the neutral banner loads (the gate came after it) is announced as it arrives", async () => {
    const { rerender } = render(<NeutralLiveRegion />);
    const region = screen.getByRole("status");
    act(() => appUpdates.set({ kind: "save_failed", refused: true }, spies()));
    rerender(surface("neutral"));
    await frame();
    expect(region).toHaveTextContent(NEUTRAL_SAVE_REFUSED_TEXT);
  });

  test("when there is nothing left to say (dismissed), the region is emptied: no earlier message stays in it", async () => {
    render(surface("neutral"));
    const region = screen.getByRole("status");
    act(() => appUpdates.set({ kind: "available", dismissed: false }, spies()));
    await frame();
    expect(region).toHaveTextContent(AVAILABLE_TEXT);
    act(() => appUpdates.set({ kind: "available", dismissed: true }));
    expect(region).toHaveTextContent("");
    await frame();
    expect(region).toHaveTextContent("");
  });

  test("the session gate's clearing is authoritative: a failure announced but not yet written is not written back by its frame", async () => {
    render(surface("neutral"));
    const region = screen.getByRole("status");
    act(() => appUpdates.set({ kind: "save_failed", refused: false }, spies()));
    act(() => liveRegions.clearAll());
    await frame();
    expect(region).toHaveTextContent("");
    // The banner itself stays, with its choices.
    expect(
      screen.getByRole("button", { name: "Retry save" }),
    ).toBeInTheDocument();
    // A later change is announced again.
    act(() => appUpdates.set({ kind: "discard_failed" }));
    await frame();
    expect(region).toHaveTextContent(NEUTRAL_DISCARD_FAILED_TEXT);
  });
});
