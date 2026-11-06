import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { Button } from "../../src/components/ui/button";
import {
  firstControl,
  openingFocus,
  RECOVERY_SURFACE,
} from "../../src/lib/form-recovery/focus";
import type {
  ModelView,
  RecoveryControls,
} from "../../src/lib/form-recovery/model";
import type { RecoverySnapshot } from "../../src/lib/form-recovery/port";
import { RecoveryBanner } from "../../src/lib/form-recovery/RecoveryBanner";
import { RecoveryNotice } from "../../src/lib/form-recovery/RecoveryNotice";
import { noteNavigation } from "../../src/lib/pwa/navigation";
import { UiProviders } from "../helpers/providers";

/**
 * WEB-14a revision 57 (Review 57, F-R57-1; design assessment of 6 November 2026, C-F2, Q-F6, I-F1/I-F3): the library refuses a restored,
 * chosen or returned focus target that is inside a recovery surface (the restored banner, the other saved copies, the check again), and
 * `firstControl`/`openingFocus` never answer one, so an editor whose resolver's scope also holds its notice cannot put focus on an action
 * that discards or replaces the restored input. A refused target is "no target yet": nothing is focused for it. Development and test builds
 * report each refusal (`tests/setup.ts` fails the test); here the reporter is replaced for each case so the refusal itself is asserted.
 *
 * The editor is a dialog-shaped body with the PRODUCTION `RecoveryNotice` first and an order list after it, as the turn order dialog was
 * before the correction (`body`: the first enabled button of the whole body, Rota.tsx at 141ca6f) and as it is now (`scoped`). Only the
 * model's controls are a double (the model's own tests cover them).
 */
type Reporter = (kind: string, element: Element) => void;
const hook = globalThis as { __atlasRecoverySurfaceRefused?: Reporter };
let refused: Array<{ kind: string; text: string }> = [];
let previous: Reporter | undefined;
beforeEach(() => {
  refused = [];
  previous = hook.__atlasRecoverySurfaceRefused;
  hook.__atlasRecoverySurfaceRefused = (kind, element) =>
    refused.push({ kind, text: (element.textContent ?? "").trim() });
});
afterEach(() => {
  cleanup();
  (document.activeElement as HTMLElement | null)?.blur?.();
  // A navigation ends any restored arrival a case left behind (the arbiter's grant is page memory).
  noteNavigation();
  hook.__atlasRecoverySurfaceRefused = previous;
});

const copy = (id: string): RecoverySnapshot => ({
  formContext: "r57:editor",
  tabInstanceId: id,
  values: {},
  savedAt: "2026-11-06T10:00:00.000Z",
});
type Mode = "body" | "scoped";

function Editor({
  mode,
  withAlternative,
}: {
  mode: Mode;
  withAlternative: boolean;
}) {
  const body = useRef<HTMLDivElement>(null);
  const order = useRef<HTMLOListElement>(null);
  const [view, setView] = useState<ModelView>({
    restored: copy("restored"),
    alternatives: withAlternative ? [copy("other")] : [],
    unavailable: false,
    ready: true,
  });
  const recovery: RecoveryControls = {
    view,
    locked: false,
    discard: async () => {
      setView((v) => ({ ...v, restored: null }));
      return "discarded";
    },
    retry: async () => true,
    checkAgain: async () => true,
    restoreAlternative: async (chosen) => {
      setView((v) => ({
        ...v,
        alternatives: v.alternatives.filter((a) => a !== chosen),
      }));
      return "restored";
    },
    discardAlternative: async () => "discarded",
  };
  const firstField = () =>
    mode === "body"
      ? body.current?.querySelector<HTMLElement>("button:not([disabled])")
      : firstControl(order.current);
  return (
    <div ref={body} role="dialog" aria-label="Turn order">
      <RecoveryNotice recovery={recovery} firstFieldRef={firstField} />
      <ol ref={order}>
        <li>
          <Button disabled reason="It is first">
            Move up
          </Button>
          <Button variant="quiet">Move down</Button>
          <Button variant="quiet">Remove</Button>
        </li>
      </ol>
    </div>
  );
}
const mount = (mode: Mode, withAlternative: boolean) =>
  render(
    <UiProviders>
      <Editor mode={mode} withAlternative={withAlternative} />
    </UiProviders>,
  );
const active = () => document.activeElement as HTMLElement | null;
const onSurface = () => !!active()?.closest(RECOVERY_SURFACE);
const kinds = () => [...new Set(refused.map((r) => r.kind))].sort();
/** A button used from the keyboard: focused when pressed (jsdom does not focus on click). */
function press(button: HTMLElement): void {
  button.focus();
  expect(button).toHaveFocus();
  fireEvent.click(button);
}

describe("revision 57 (C-F2): a restore's target inside a recovery surface is refused", () => {
  test("Q-F6 restored: a resolver answering the banner's own Discard instead is refused and reported; nothing is focused for it", async () => {
    mount("body", false);
    await act(async () => undefined);
    expect(onSurface(), "focus is not on a recovery action").toBe(false);
    expect(active()).toBe(document.body);
    expect(kinds()).toEqual(["restored"]);
    expect(refused[0]?.text).toBe("Discard instead");
  });

  test("Q-F6 control: the same editor with its resolver scoped to the order focuses Move down, and nothing is refused", async () => {
    mount("scoped", false);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Move down" })).toHaveFocus(),
    );
    expect(refused).toEqual([]);
  });

  test("Q-F6 chosen: a copy chosen while the restored banner stays, with the body-wide resolver, is refused; focus is never put on the banner", async () => {
    mount("body", true);
    await act(async () => undefined);
    const choose = screen.getByRole("button", {
      name: /^Restore the copy saved/,
    });
    press(choose);
    await act(async () => undefined);
    await act(async () => undefined);
    expect(kinds()).toContain("chosen");
    expect(onSurface(), "focus is not on a recovery action").toBe(false);
  });

  test("Q-F6 returned: a keyboard Discard instead with another copy still offered, body-wide resolver: the other copy's Restore is refused, never focused", async () => {
    mount("body", true);
    await act(async () => undefined);
    press(screen.getByRole("button", { name: "Discard instead" }));
    await act(async () => undefined);
    await act(async () => undefined);
    expect(kinds()).toContain("returned");
    // At the gesture the used button itself is still there (and refused when read); once the reset is committed, the other copy's Restore.
    expect(
      refused.some(
        (r) => r.kind === "returned" && /^Restore the copy saved/.test(r.text),
      ),
    ).toBe(true);
    expect(onSurface(), "focus is not on the other copy's Restore").toBe(false);
  });

  test("Q-F6 returned, scoped control: the keyboard discard with another copy offered returns to Move down; nothing is refused", async () => {
    mount("scoped", true);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Move down" })).toHaveFocus(),
    );
    press(screen.getByRole("button", { name: "Discard instead" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Move down" })).toHaveFocus(),
    );
    expect(refused).toEqual([]);
  });

  test("Q-F6 the banner's own fallback (no owner-held return): a keyboard Discard instead naming a recovery action is refused too", async () => {
    // Its own container only: a request left behind must never name a later case's banner.
    const own = document.body.appendChild(document.createElement("div"));
    render(
      <UiProviders>
        <RecoveryBanner
          state={{ kind: "restored", onDiscard: () => {} }}
          firstFieldRef={() =>
            own.querySelector<HTMLElement>("[data-recovery-state] button")
          }
        />
      </UiProviders>,
      { container: own },
    );
    await act(async () => undefined);
    refused = [];
    press(screen.getByRole("button", { name: "Discard instead" }));
    expect(kinds()).toEqual(["returned"]);
  });
});

describe("revision 57 (C-F2): firstControl and openingFocus never answer a recovery surface's action", () => {
  test("Q-F6 with the restored banner AND another copy offered, the dialog's first control is the order's Move down (before: the other copy's Restore)", async () => {
    mount("scoped", true);
    await act(async () => undefined);
    const dialog = screen.getByRole("dialog");
    expect(firstControl(dialog)?.textContent).toBe("Move down");
    expect(openingFocus(dialog.querySelector("ol"))?.textContent).toBe(
      "Move down",
    );
  });

  test("Q-F6 the constant names the three surfaces", () => {
    expect(RECOVERY_SURFACE.split(",").sort()).toEqual([
      "[data-recovery-alternatives]",
      "[data-recovery-check]",
      "[data-recovery-state]",
    ]);
  });
});
