import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { createRef, type RefObject } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { NeutralLiveRegion } from "../../src/components/ui/announcer";
import { Dialog } from "../../src/components/ui/dialog";
import { RecoveryBanner } from "../../src/lib/form-recovery/RecoveryBanner";
import { pageFormRegistry } from "../../src/lib/form-recovery/registry";
import { noteNavigation } from "../../src/lib/pwa/navigation";
import {
  type AppUpdatesActions,
  appUpdates,
  type UpdateState,
} from "../../src/lib/pwa/store";
import {
  AppUpdateBanner,
  NeutralUpdateBanner,
} from "../../src/lib/pwa/UpdateBanner";
import { UpdateReady } from "../../src/lib/pwa/UpdateReady";
import { UiProviders } from "../helpers/providers";

/**
 * WEB-14a revision 19, R26 (form-recovery-reload.html "Focus order"; design assessment C1/C2, I1/I2/I6/I7, Q1/Q4/Q13, S1/S2/S10-S16):
 * Q4 state 1 focuses "Save and reload" when the prompt appears and state 2 its recovery action when a failure appears, ONCE per
 * presentation, on either surface; a plain notice never takes focus; a choice keeps focus at the banner while its button goes, and
 * "Not now" returns it. DA-F1 (Kieran, 15 October 2026): a restored form's first field wins over a state-1 prompt of the same arrival.
 * The coordinator is a small double that publishes what the real one would for each choice (the coordinator's own tests cover it);
 * focus and the person's input are what is asserted, with the actions it was asked for. jsdom does not compute `inert`: the gate's
 * ownership is the real-engine specs'.
 */
type Calls = Record<keyof AppUpdatesActions, number>;
let calls: Calls;
let onAct: Partial<Record<keyof AppUpdatesActions, () => void>> = {};
const actions: AppUpdatesActions = {
  accept: () => record("accept"),
  retrySave: () => record("retrySave"),
  discardAndReload: () => record("discardAndReload"),
  reloadAnyway: () => record("reloadAnyway"),
  notNow: () => record("notNow"),
};
function record(name: keyof AppUpdatesActions) {
  calls[name] += 1;
  onAct[name]?.();
}
const set = (state: UpdateState) => act(() => appUpdates.set(state, actions));
const none = (): Calls => ({
  accept: 0,
  retrySave: 0,
  discardAndReload: 0,
  reloadAnyway: 0,
  notNow: 0,
});

let offForm: (() => void) | null = null;
const openForm = () => {
  offForm = pageFormRegistry.register({
    formContext: "SENTINEL-CONTEXT",
    isDirty: () => true,
    flush: async () => "saved",
  });
};

beforeEach(() => {
  calls = none();
  onAct = {};
  document.body.innerHTML =
    '<div id="neutral-root"></div><div id="protected-root"></div>';
});
afterEach(() => {
  cleanup();
  offForm?.();
  offForm = null;
  act(() => appUpdates.set({ kind: "none" }));
  // A navigation ends any restored arrival a case left behind (DA-F1 is page memory).
  noteNavigation();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

const protectedRoot = () =>
  document.getElementById("protected-root") as HTMLElement;

/** The shell as the page draws it: the page heading, the banner, a form with its first field. */
function Shell({ field }: { field?: RefObject<HTMLInputElement | null> }) {
  return (
    <UiProviders>
      <main id="main">
        <h1 data-page-heading="" tabIndex={-1}>
          Today
        </h1>
        <AppUpdateBanner />
        <form aria-label="Note">
          <input ref={field} aria-label="Title" defaultValue="Unfinished" />
        </form>
      </main>
    </UiProviders>
  );
}
/** Each mount gets its own container in the protected root (a remount of the shell is a new React root, as the page's is). */
const inProtected = () =>
  protectedRoot().appendChild(document.createElement("div"));
const shell = () => render(<Shell />, { container: inProtected() });
/** A restored form's banner (state 3) for `field`, in its own container in the protected root. */
const restore = (field: RefObject<HTMLInputElement | null>) =>
  render(
    <UiProviders>
      <RecoveryBanner
        state={{ kind: "restored", onDiscard: () => {} }}
        firstFieldRef={field}
      />
    </UiProviders>,
    { container: inProtected() },
  );
const title = () => screen.getByRole("textbox", { name: "Title" });
const button = (name: string) => screen.getByRole("button", { name });
const update = () => screen.getByRole("region", { name: "Update" });

describe("R26, Q4 state 1: the prompt focuses its primary action when it appears", () => {
  test("a form is open and Title has focus: 'Save and reload' takes focus; nothing is chosen and the input is untouched", () => {
    openForm();
    shell();
    title().focus();
    set({ kind: "available", dismissed: false });
    expect(
      button("Save and reload"),
      "Approved Q4 state 1 primary action focus",
    ).toHaveFocus();
    expect(calls).toEqual(none());
    expect(title()).toHaveValue("Unfinished");
  });

  test("control: a plain notice (no form open) never takes focus", () => {
    shell();
    title().focus();
    set({ kind: "available", dismissed: false });
    expect(button("Reload")).toBeInTheDocument();
    expect(title()).toHaveFocus();
    set({ kind: "updated_elsewhere", dismissed: false });
    set({ kind: "data_superseded" });
    expect(title()).toHaveFocus();
  });

  test("one presentation: a re-render, a remount of the shell and an equal publication do not take focus again; a new presentation does", () => {
    openForm();
    const view = shell();
    set({ kind: "available", dismissed: false });
    expect(button("Save and reload")).toHaveFocus();
    title().focus();
    view.rerender(<Shell />);
    set({ kind: "available", dismissed: false });
    expect(title()).toHaveFocus();
    view.unmount();
    shell();
    title().focus();
    set({ kind: "available", dismissed: false });
    expect(title()).toHaveFocus();
    // Dismissed, then brought back (a navigation or a return to the page): it appears again, and takes focus again.
    set({ kind: "available", dismissed: true });
    set({ kind: "available", dismissed: false });
    expect(button("Save and reload")).toHaveFocus();
  });

  test("a target that could not take focus is not counted: the next mount of the same presentation focuses it", () => {
    openForm();
    const refuse = vi
      .spyOn(HTMLButtonElement.prototype, "focus")
      .mockImplementationOnce(() => {});
    const view = shell();
    title().focus();
    set({ kind: "available", dismissed: false });
    expect(refuse).toHaveBeenCalledTimes(1);
    expect(title()).toHaveFocus();
    view.unmount();
    shell();
    expect(button("Save and reload")).toHaveFocus();
  });

  test("'Not now' returns focus to the field the prompt took it from, and asks only to dismiss", () => {
    openForm();
    shell();
    title().focus();
    onAct.notNow = () => appUpdates.set({ kind: "available", dismissed: true });
    set({ kind: "available", dismissed: false });
    act(() => button("Not now").click());
    expect(calls).toEqual({ ...none(), notNow: 1 });
    expect(screen.queryByRole("region", { name: "Update" })).toBeNull();
    expect(title()).toHaveFocus();
    expect(title()).toHaveValue("Unfinished");
  });

  test("'Not now' when that field has gone: focus goes to the surface's page heading, never to the body", () => {
    openForm();
    shell();
    title().focus();
    onAct.notNow = () => appUpdates.set({ kind: "available", dismissed: true });
    set({ kind: "available", dismissed: false });
    title().remove();
    act(() => button("Not now").click());
    expect(
      screen.getByRole("heading", { level: 1, name: "Today" }),
    ).toHaveFocus();
  });

  test("the close button of a plain notice, used from the keyboard: focus goes to the page heading, not the body", () => {
    shell();
    onAct.notNow = () => appUpdates.set({ kind: "available", dismissed: true });
    set({ kind: "available", dismissed: false });
    button("Not now").focus();
    act(() => button("Not now").click());
    expect(
      screen.getByRole("heading", { level: 1, name: "Today" }),
    ).toHaveFocus();
  });

  test("a pointer that leaves focus elsewhere (Safari does not focus a clicked button): 'Not now' leaves it there", () => {
    openForm();
    shell();
    onAct.notNow = () => appUpdates.set({ kind: "available", dismissed: true });
    set({ kind: "available", dismissed: false });
    title().focus();
    act(() => button("Not now").click());
    expect(title()).toHaveFocus();
  });
});

describe("R26, Q4 state 2: a failure focuses its recovery action; a choice keeps focus at the banner", () => {
  test("Save and reload → saving (focus kept at the banner) → failed (Retry save) → retry fails again (Retry save again)", () => {
    openForm();
    shell();
    onAct.accept = () => appUpdates.set({ kind: "saving" });
    onAct.retrySave = () => appUpdates.set({ kind: "saving" });
    set({ kind: "available", dismissed: false });
    act(() => button("Save and reload").click());
    expect(calls).toEqual({ ...none(), accept: 1 });
    expect(update()).toHaveFocus();
    set({ kind: "save_failed", refused: false });
    expect(
      button("Retry save"),
      "Approved Q4 state 2 recovery-action focus after a failed accepted save",
    ).toHaveFocus();
    expect(title()).toHaveValue("Unfinished");
    act(() => button("Retry save").click());
    expect(calls).toEqual({ ...none(), accept: 1, retrySave: 1 });
    expect(update()).toHaveFocus();
    set({ kind: "save_failed", refused: false });
    expect(button("Retry save")).toHaveFocus();
  });

  test("a refused save offers only a destructive choice: the banner itself is focused, and nothing is chosen", () => {
    openForm();
    shell();
    title().focus();
    set({ kind: "save_failed", refused: true });
    expect(update()).toHaveFocus();
    expect(button("Discard and reload anyway")).not.toHaveFocus();
    expect(calls).toEqual(none());
  });

  test("a discard that failed focuses 'Try again'; 'Reload anyway' keeps focus at the banner while the page reloads", () => {
    shell();
    onAct.discardAndReload = () => appUpdates.set({ kind: "reloading" });
    onAct.reloadAnyway = () => appUpdates.set({ kind: "reloading" });
    set({ kind: "save_failed", refused: false });
    act(() => button("Discard and reload anyway").focus());
    act(() => button("Discard and reload anyway").click());
    expect(update()).toHaveFocus();
    set({ kind: "discard_failed" });
    expect(button("Try again")).toHaveFocus();
    act(() => button("Reload anyway").focus());
    act(() => button("Reload anyway").click());
    expect(calls).toEqual({ ...none(), discardAndReload: 1, reloadAnyway: 1 });
    expect(update()).toHaveFocus();
  });

  test("the failure moves to the neutral root (a gate unmounted the shell): the same presentation does not take focus again there; a new one does", () => {
    openForm();
    const view = shell();
    set({ kind: "save_failed", refused: false });
    expect(button("Retry save")).toHaveFocus();
    view.unmount();
    const outside = document.body.appendChild(document.createElement("button"));
    outside.focus();
    render(
      <>
        <NeutralLiveRegion />
        <NeutralUpdateBanner />
      </>,
      { container: document.getElementById("neutral-root") as HTMLElement },
    );
    expect(outside).toHaveFocus();
    set({ kind: "discard_failed" });
    expect(button("Try again")).toHaveFocus();
  });

  test("S12: 'Reload to update' on the compatibility screen fails to save: the neutral root's banner focuses 'Retry save'", () => {
    const neutral = document.getElementById("neutral-root") as HTMLElement;
    onAct.accept = () => appUpdates.set({ kind: "saving" });
    set({ kind: "available", dismissed: false });
    render(
      <>
        <NeutralLiveRegion />
        <UpdateReady />
        <NeutralUpdateBanner />
      </>,
      { container: neutral },
    );
    const reload = button("Reload to update");
    reload.focus();
    act(() => reload.click());
    expect(calls).toEqual({ ...none(), accept: 1 });
    set({ kind: "save_failed", refused: false });
    expect(button("Retry save")).toHaveFocus();
    expect(calls).toEqual({ ...none(), accept: 1 });
  });

  test("control: on the neutral root, 'Saving…' and the other plain notices never take focus", () => {
    const outside = document.body.appendChild(document.createElement("button"));
    outside.focus();
    render(
      <>
        <NeutralLiveRegion />
        <NeutralUpdateBanner />
      </>,
      { container: document.getElementById("neutral-root") as HTMLElement },
    );
    for (const state of [
      { kind: "available", dismissed: false },
      { kind: "updated_elsewhere", dismissed: false },
      { kind: "saving" },
      { kind: "reloading" },
      { kind: "data_superseded" },
    ] as const) {
      set(state);
      expect(outside).toHaveFocus();
    }
  });
});

describe("DA-F1 (Kieran, 15 October 2026): the restored field wins over a state-1 prompt of the same arrival", () => {
  test("restored first, then the prompt appears: the field keeps focus; after a navigation the prompt's next presentation takes it", () => {
    openForm();
    const field = createRef<HTMLInputElement>();
    render(<Shell field={field} />, { container: inProtected() });
    restore(field);
    expect(title()).toHaveFocus();
    set({ kind: "available", dismissed: false });
    expect(button("Save and reload")).toBeInTheDocument();
    expect(title()).toHaveFocus();
    act(() => noteNavigation());
    set({ kind: "available", dismissed: true });
    set({ kind: "available", dismissed: false });
    expect(button("Save and reload")).toHaveFocus();
  });

  test("the prompt first, then the restore: the restored form's first field takes focus", () => {
    openForm();
    const field = createRef<HTMLInputElement>();
    const view = render(<Shell field={field} />, { container: inProtected() });
    set({ kind: "available", dismissed: false });
    expect(button("Save and reload")).toHaveFocus();
    view.rerender(<Shell field={field} />);
    render(
      <UiProviders>
        <RecoveryBanner
          state={{ kind: "restored", onDiscard: () => {} }}
          firstFieldRef={field}
        />
      </UiProviders>,
      { container: inProtected() },
    );
    expect(title()).toHaveFocus();
  });

  test("control: a restore that could not focus its field (none rendered) does not hold the prompt back", () => {
    openForm();
    shell();
    restore(createRef<HTMLInputElement>());
    expect(title()).not.toHaveFocus();
    set({ kind: "available", dismissed: false });
    expect(button("Save and reload")).toHaveFocus();
  });
});

/**
 * WEB-14a revision 20, R26/R27 (review of 15-16 October 2026; design assessment RC1/RC3, I1-I5/I7/I12, S3-S6/S8-S10/S12/S16-S18/S21, Q2):
 * a request the browser refused behind the session gate, the gate dialog, an app dialog or a form's hold stays pending and is fulfilled
 * when the SAME tree becomes eligible, with no render, remount or publication. The gate is its attributes here (jsdom computes neither
 * `inert` nor the top layer; `focus.ts` checks both, and the real-engine specs prove the browser's refusal). Order and identity only.
 */
describe("revision 20: a request refused while the surface was not eligible is fulfilled when it becomes eligible", () => {
  const gate = () => {
    protectedRoot().setAttribute("inert", "");
    protectedRoot().setAttribute("aria-hidden", "true");
  };
  /** The adapter's lift: attributes go in one synchronous step; the request is attempted at the next microtask checkpoint. */
  const lift = () =>
    act(async () => {
      protectedRoot().removeAttribute("inert");
      protectedRoot().removeAttribute("aria-hidden");
    });
  const outside = () => {
    const button = document.body.appendChild(document.createElement("button"));
    button.textContent = "Outside";
    button.focus();
    return button;
  };

  test("S4: the prompt published while the existing shell is gated focuses 'Save and reload' when that same shell lifts", async () => {
    openForm();
    shell();
    const field = title();
    field.focus();
    gate();
    const away = outside();
    set({ kind: "available", dismissed: false });
    expect(away, "the gate keeps focus while it is closed").toHaveFocus();
    await act(async () => {});
    expect(away).toHaveFocus();
    await lift();
    expect(
      button("Save and reload"),
      "Q4 state 1 after the same-tree lift",
    ).toHaveFocus();
    expect(title(), "the same tree: no remount").toBe(field);
    expect(calls).toEqual(none());
    expect(title()).toHaveValue("Unfinished");
  });

  test("S3: a prompt already published when the shell mounts behind the gate focuses its action once the gate lifts", async () => {
    openForm();
    set({ kind: "available", dismissed: false });
    gate();
    const away = outside();
    shell();
    expect(away).toHaveFocus();
    await lift();
    expect(button("Save and reload")).toHaveFocus();
    expect(calls).toEqual(none());
  });

  test("S6: a restored banner mounted behind the gate focuses the form's first field once the gate lifts", async () => {
    const field = createRef<HTMLInputElement>();
    gate();
    const away = outside();
    render(<Shell field={field} />, { container: inProtected() });
    restore(field);
    expect(away).toHaveFocus();
    await lift();
    expect(title(), "Q4 state 3 after the lift").toHaveFocus();
    expect(title()).toHaveValue("Unfinished");
  });

  for (const [state, target] of [
    [{ kind: "save_failed", refused: false }, "Retry save"],
    [{ kind: "save_failed", refused: true }, null],
    [{ kind: "discard_failed" }, "Try again"],
  ] as const)
    test(`S9: ${JSON.stringify(state)} presented while the shell is gated takes its focus at the lift, choosing nothing`, async () => {
      openForm();
      shell();
      gate();
      const away = outside();
      set(state);
      expect(away).toHaveFocus();
      await lift();
      expect(target ? button(target) : update()).toHaveFocus();
      expect(calls).toEqual(none());
      expect(title()).toHaveValue("Unfinished");
    });

  test("S10: a neutral-root failure behind the open modal gate dialog (no `inert` on the neutral root) takes focus when the dialog closes", async () => {
    const dialog = document.body.appendChild(document.createElement("dialog"));
    // jsdom has no showModal: the dialog says it is modal while open (the real-engine specs use the browser's own top layer).
    dialog.setAttribute("open", "");
    const matches = dialog.matches.bind(dialog);
    vi.spyOn(dialog, "matches").mockImplementation((selector) =>
      selector === ":modal" ? dialog.hasAttribute("open") : matches(selector),
    );
    const heading = dialog.appendChild(document.createElement("h1"));
    heading.tabIndex = -1;
    heading.focus();
    render(
      <>
        <NeutralLiveRegion />
        <NeutralUpdateBanner />
      </>,
      { container: document.getElementById("neutral-root") as HTMLElement },
    );
    set({ kind: "save_failed", refused: false });
    expect(heading).toHaveFocus();
    await act(async () => dialog.removeAttribute("open"));
    expect(button("Retry save")).toHaveFocus();
    expect(calls).toEqual(none());
  });

  test("S15: an app dialog's inert background holds a failure back; it is focused when the dialog's background is released", async () => {
    openForm();
    shell();
    const host = protectedRoot().firstElementChild as HTMLElement;
    host.setAttribute("inert", "");
    const away = outside();
    set({ kind: "save_failed", refused: false });
    expect(away).toHaveFocus();
    await act(async () => host.removeAttribute("inert"));
    expect(button("Retry save")).toHaveFocus();
  });

  test("S14: a restored field held by its form's hold is focused when the hold is released", async () => {
    const field = createRef<HTMLInputElement>();
    render(<Shell field={field} />, { container: inProtected() });
    const form = screen.getByRole("form", { name: "Note" });
    form.setAttribute("inert", "");
    const away = outside();
    restore(field);
    expect(away).toHaveFocus();
    await act(async () => form.removeAttribute("inert"));
    expect(title()).toHaveFocus();
  });

  test("S14, DA-F1: a state-1 prompt waits while a restored field in the page is held; the field takes focus at the release and the prompt never does", async () => {
    openForm();
    const field = createRef<HTMLInputElement>();
    render(<Shell field={field} />, { container: inProtected() });
    const form = screen.getByRole("form", { name: "Note" });
    form.setAttribute("inert", "");
    const away = outside();
    restore(field);
    set({ kind: "available", dismissed: false });
    expect(button("Save and reload")).toBeInTheDocument();
    expect(away, "the prompt waits for the held restored field").toHaveFocus();
    await act(async () => form.removeAttribute("inert"));
    expect(title()).toHaveFocus();
    await act(async () => {
      document.body.appendChild(document.createElement("p"));
    });
    expect(title()).toHaveFocus();
  });

  test("S11: a failure pending on both surfaces (shell gated, neutral root behind the gate dialog) is focused once, in the shell, when both lift", async () => {
    openForm();
    const shellView = shell();
    gate();
    const dialog = document.body.appendChild(document.createElement("dialog"));
    dialog.setAttribute("open", "");
    const matches = dialog.matches.bind(dialog);
    vi.spyOn(dialog, "matches").mockImplementation((selector) =>
      selector === ":modal" ? dialog.hasAttribute("open") : matches(selector),
    );
    const away = outside();
    const neutral = render(
      <>
        <NeutralLiveRegion />
        <NeutralUpdateBanner />
      </>,
      { container: document.getElementById("neutral-root") as HTMLElement },
    );
    set({ kind: "save_failed", refused: false });
    expect(away).toHaveFocus();
    await act(async () => {
      protectedRoot().removeAttribute("inert");
      protectedRoot().removeAttribute("aria-hidden");
      dialog.removeAttribute("open");
    });
    const [inShell] = within(protectedRoot()).getAllByRole("button", {
      name: "Retry save",
    });
    expect(inShell, "the shell's banner, not the neutral root's").toHaveFocus();
    // The neutral root's request for the same presentation is spent: a later change of the document does not move focus there.
    await act(async () => {
      document.body.appendChild(document.createElement("p"));
    });
    expect(inShell).toHaveFocus();
    neutral.unmount();
    expect(inShell).toHaveFocus();
    shellView.unmount();
  });

  test("S16: a restored field rendered after its banner is focused when it is inserted (read afresh, never a kept node)", async () => {
    const field = createRef<HTMLInputElement>();
    const away = outside();
    restore(field);
    expect(away).toHaveFocus();
    render(<Shell field={field} />, { container: inProtected() });
    await act(async () => {});
    expect(title()).toHaveFocus();
  });

  test("S8, DA-F1 behind the gate, either order: the restored field wins at the lift and the prompt does not take focus afterwards", async () => {
    for (const order of ["prompt first", "restored first"] as const) {
      openForm();
      const field = createRef<HTMLInputElement>();
      gate();
      const away = outside();
      const view = render(<Shell field={field} />, {
        container: inProtected(),
      });
      if (order === "prompt first")
        set({ kind: "available", dismissed: false });
      const banner = restore(field);
      if (order === "restored first")
        set({ kind: "available", dismissed: false });
      expect(away).toHaveFocus();
      await lift();
      expect(title(), order).toHaveFocus();
      // A later change of the document does not let the superseded prompt take focus.
      await act(async () => {
        document.body.appendChild(document.createElement("p"));
      });
      expect(title(), order).toHaveFocus();
      banner.unmount();
      view.unmount();
      offForm?.();
      away.remove();
      act(() => appUpdates.set({ kind: "none" }));
      act(() => noteNavigation());
    }
  });

  test("S30, DA-F2 (Kieran, 16 October 2026): a save failure after a restored field still pending cancels it; at the lift 'Retry save' has focus and keeps it", async () => {
    openForm();
    const field = createRef<HTMLInputElement>();
    gate();
    const away = outside();
    render(<Shell field={field} />, { container: inProtected() });
    restore(field);
    set({ kind: "save_failed", refused: false });
    expect(away).toHaveFocus();
    await lift();
    expect(
      button("Retry save"),
      "DA-F2: the later failure's recovery action wins",
    ).toHaveFocus();
    await act(async () => {
      document.body.appendChild(document.createElement("p"));
    });
    expect(button("Retry save")).toHaveFocus();
    expect(calls).toEqual(none());
    expect(title()).toHaveValue("Unfinished");
  });

  test("S17: the gate closes again in the same step that lifted it: nothing is focused; the request waits for the next lift", async () => {
    openForm();
    shell();
    gate();
    const away = outside();
    set({ kind: "available", dismissed: false });
    await act(async () => {
      protectedRoot().removeAttribute("inert");
      protectedRoot().setAttribute("inert", "");
    });
    expect(away).toHaveFocus();
    await lift();
    expect(button("Save and reload")).toHaveFocus();
  });

  test("S18/S21: an owner unmounted while its request waits withdraws it: nothing focuses the old tree's target, and the watch stops", async () => {
    const disconnect = vi.spyOn(MutationObserver.prototype, "disconnect");
    openForm();
    const view = shell();
    gate();
    const away = outside();
    set({ kind: "available", dismissed: false });
    view.unmount();
    expect(disconnect).toHaveBeenCalled();
    await lift();
    expect(away).toHaveFocus();
  });

  test("S12/S5: a presentation already focused does not take focus again at a later gate and lift; the person's place is kept", async () => {
    openForm();
    shell();
    set({ kind: "available", dismissed: false });
    expect(button("Save and reload")).toHaveFocus();
    title().focus();
    gate();
    await act(async () => {});
    await lift();
    expect(title()).toHaveFocus();
  });
});

describe("revision 20, S15: an app dialog over a pending failure", () => {
  /** The shell with an app dialog (the real `Dialog`: its background is inert while it is open, and it returns focus when it closes). */
  function WithDialog({ open }: { open: boolean }) {
    return (
      <UiProviders>
        <main id="main">
          <h1 data-page-heading="" tabIndex={-1}>
            Today
          </h1>
          <button type="button">Opener</button>
          <AppUpdateBanner />
          <form aria-label="Note">
            <input aria-label="Title" defaultValue="Unfinished" />
          </form>
        </main>
        <Dialog open={open} onClose={() => {}} title="Edit thing">
          <input aria-label="Name" />
        </Dialog>
      </UiProviders>
    );
  }
  const settle = () =>
    act(() => new Promise((resolve) => setTimeout(resolve, 20)));

  test("the dialog keeps focus while open; when it closes the failure's 'Retry save' takes focus and the dialog's return to its opener does not take it back", async () => {
    openForm();
    const container = inProtected();
    const view = render(<WithDialog open={false} />, { container });
    button("Opener").focus();
    view.rerender(<WithDialog open />);
    const dialog = await screen.findByRole("dialog");
    await waitFor(() =>
      expect(dialog.contains(document.activeElement)).toBe(true),
    );
    set({ kind: "save_failed", refused: false });
    await settle();
    expect(dialog.contains(document.activeElement)).toBe(true);
    view.rerender(<WithDialog open={false} />);
    await settle();
    expect(button("Retry save")).toHaveFocus();
    expect(calls).toEqual(none());
  });

  test("control: with nothing pending, the dialog returns focus to its opener", async () => {
    const container = inProtected();
    const view = render(<WithDialog open={false} />, { container });
    button("Opener").focus();
    view.rerender(<WithDialog open />);
    const dialog = await screen.findByRole("dialog");
    await waitFor(() =>
      expect(dialog.contains(document.activeElement)).toBe(true),
    );
    view.rerender(<WithDialog open={false} />);
    await settle();
    expect(button("Opener")).toHaveFocus();
  });
});

test("I5: a banner loaded after the state was published counts that state as one presentation (an equal publication is not new)", async () => {
  vi.resetModules();
  const store = await import("../../src/lib/pwa/store");
  store.appUpdates.set({ kind: "save_failed", refused: false }, actions);
  const fresh = await import("../../src/lib/pwa/UpdateBanner");
  const providers = await import("../helpers/providers");
  render(
    <providers.UiProviders>
      <fresh.AppUpdateBanner />
      <input aria-label="Other" />
    </providers.UiProviders>,
    { container: inProtected() },
  );
  expect(button("Retry save")).toHaveFocus();
  const other = screen.getByRole("textbox", { name: "Other" });
  other.focus();
  act(() =>
    store.appUpdates.set({ kind: "save_failed", refused: false }, actions),
  );
  expect(other).toHaveFocus();
  act(() => store.appUpdates.set({ kind: "none" }));
});
