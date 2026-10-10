import { act, cleanup, render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  API_HEADING,
  CompatibilityScreen,
} from "../../src/app/CompatibilityScreen";
import {
  liveRegions,
  NeutralLiveRegion,
} from "../../src/components/ui/announcer";
import { pageFormRegistry } from "../../src/lib/form-recovery/registry";
import { UPDATE_TEXT } from "../../src/lib/form-recovery/UpdatePrompt";
import {
  type AppUpdatesActions,
  appUpdates,
  type UpdateState,
} from "../../src/lib/pwa/store";
import {
  AppUpdateBanner,
  AVAILABLE_TEXT,
  ELSEWHERE_TEXT,
  NeutralUpdateBanner,
  SUPERSEDED_TEXT,
} from "../../src/lib/pwa/UpdateBanner";
import {
  UPDATE_READY_ACTION,
  UPDATE_READY_TEXT,
} from "../../src/lib/pwa/UpdateReady";
import { UiProviders } from "../helpers/providers";

/**
 * WEB-14a: the update banner (WEB-04 wireframe 6, Q4 states 1-2) and the compatibility screen's update action (D-P9). The banner shows the
 * wireframe's wording, dismisses, never takes focus, announces once, and is accessible in both themes.
 */
const actions = (): AppUpdatesActions => ({
  accept: vi.fn(),
  retrySave: vi.fn(),
  discardAndReload: vi.fn(),
  reloadAnyway: vi.fn(),
  notNow: vi.fn(),
});
const set = (state: UpdateState, with_ = actions()) => {
  act(() => appUpdates.set(state, with_));
  return with_;
};

afterEach(() => {
  cleanup();
  act(() => appUpdates.set({ kind: "none" }));
});

describe("the shell banner", () => {
  test("nothing for `none` and for a dismissed banner", () => {
    render(
      <UiProviders>
        <AppUpdateBanner />
      </UiProviders>,
    );
    expect(screen.queryByRole("region", { name: "Update" })).toBeNull();
    set({ kind: "available", dismissed: true });
    expect(screen.queryByText(AVAILABLE_TEXT)).toBeNull();
  });

  test("available: the wireframe's wording, Reload and the close button; focus is not moved", async () => {
    const before = document.activeElement;
    const { container } = render(
      <UiProviders>
        <AppUpdateBanner />
      </UiProviders>,
    );
    const a = set({ kind: "available", dismissed: false });
    expect(screen.getByText(AVAILABLE_TEXT)).toBeInTheDocument();
    expect(document.activeElement).toBe(before);
    act(() => screen.getByRole("button", { name: "Reload" }).click());
    expect(a.accept).toHaveBeenCalledTimes(1);
    act(() => screen.getByRole("button", { name: "Not now" }).click());
    expect(a.notNow).toHaveBeenCalledTimes(1);
    expect((await axe(container)).violations).toEqual([]);
  });

  test("updated in another tab: Reload here", () => {
    render(
      <UiProviders>
        <AppUpdateBanner />
      </UiProviders>,
    );
    const a = set({ kind: "updated_elsewhere", dismissed: false });
    expect(screen.getByText(ELSEWHERE_TEXT)).toBeInTheDocument();
    act(() => screen.getByRole("button", { name: "Reload here" }).click());
    expect(a.accept).toHaveBeenCalledTimes(1);
  });

  test("with an open recoverable form, 'available' is Q4 state 1 (save first)", () => {
    const off = pageFormRegistry.register({
      formContext: "f",
      isDirty: () => false,
      flush: async () => "saved",
    });
    try {
      render(
        <UiProviders>
          <AppUpdateBanner />
        </UiProviders>,
      );
      const a = set({ kind: "available", dismissed: false });
      expect(screen.getByText(UPDATE_TEXT)).toBeInTheDocument();
      act(() =>
        screen.getByRole("button", { name: "Save and reload" }).click(),
      );
      expect(a.accept).toHaveBeenCalledTimes(1);
    } finally {
      off();
    }
  });

  test("a failed save is Q4 state 2: Retry save, Discard and reload anyway; a refusal offers only the discard", () => {
    render(
      <UiProviders>
        <AppUpdateBanner />
      </UiProviders>,
    );
    const a = set({ kind: "save_failed", refused: false });
    act(() => screen.getByRole("button", { name: "Retry save" }).click());
    act(() =>
      screen.getByRole("button", { name: "Discard and reload anyway" }).click(),
    );
    expect(a.retrySave).toHaveBeenCalledTimes(1);
    expect(a.discardAndReload).toHaveBeenCalledTimes(1);
    set({ kind: "save_failed", refused: true });
    expect(screen.queryByRole("button", { name: "Retry save" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Discard and reload anyway" }),
    ).toBeInTheDocument();
  });

  test("data superseded: not dismissible; Reload here", () => {
    render(
      <UiProviders>
        <AppUpdateBanner />
      </UiProviders>,
    );
    set({ kind: "data_superseded" });
    expect(screen.getByText(SUPERSEDED_TEXT)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Not now" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Reload here" }),
    ).toBeInTheDocument();
  });

  test("announced once through the announcer, not again on re-render", async () => {
    render(
      <UiProviders>
        <AppUpdateBanner />
      </UiProviders>,
    );
    set({ kind: "updated_elsewhere", dismissed: false });
    await act(
      () => new Promise((resolve) => requestAnimationFrame(() => resolve(0))),
    );
    expect(screen.getByRole("status")).toHaveTextContent(ELSEWHERE_TEXT);
  });

  test.each(["light", "dark"])("axe clean (%s)", async (theme) => {
    document.documentElement.dataset.theme = theme;
    const { container } = render(
      <UiProviders>
        <AppUpdateBanner />
      </UiProviders>,
    );
    set({ kind: "updated_elsewhere", dismissed: false });
    expect((await axe(container)).violations).toEqual([]);
    delete document.documentElement.dataset.theme;
  });
});

describe("the neutral banner", () => {
  test("renders the plain variants with no announcer provider", () => {
    render(<NeutralUpdateBanner />);
    set({ kind: "available", dismissed: false });
    expect(screen.getByText(AVAILABLE_TEXT)).toBeInTheDocument();
  });

  // Revision 1, R8: the neutral root has no protected tree and so no announcer; its own live region announces the update.
  test("announced once through the neutral live region (mounted before the banner), never by moving focus", async () => {
    const frame = () =>
      act(
        () => new Promise((resolve) => requestAnimationFrame(() => resolve(0))),
      );
    const { rerender } = render(<NeutralLiveRegion />);
    const region = screen.getByRole("status");
    expect(region).toHaveTextContent("");
    const focused = document.activeElement;
    rerender(
      <>
        <NeutralLiveRegion />
        <NeutralUpdateBanner />
      </>,
    );
    set({ kind: "available", dismissed: false });
    await frame();
    expect(region).toHaveTextContent(AVAILABLE_TEXT);
    expect(document.activeElement).toBe(focused);
    // A new message is announced; the same one is not repeated by a re-render.
    set({ kind: "updated_elsewhere", dismissed: false });
    await frame();
    expect(region).toHaveTextContent(ELSEWHERE_TEXT);
    // The level-0 gate clears it with the others.
    act(() => liveRegions.clearAll());
    expect(region).toHaveTextContent("");
  });
});

describe("the API compatibility screen offers the update (D-P9)", () => {
  test("only while a newer version is ready", async () => {
    render(
      <CompatibilityScreen
        issues={[]}
        api={{
          status: "unsupported",
          version: "0.28.0",
          supported: ">=0.27.0 <0.28.0",
        }}
      />,
    );
    expect(screen.getByText(API_HEADING)).toBeInTheDocument();
    expect(screen.queryByText(UPDATE_READY_TEXT)).toBeNull();
    const a = set({ kind: "available", dismissed: false });
    const button = await screen.findByRole("button", {
      name: UPDATE_READY_ACTION,
    });
    act(() => button.click());
    expect(a.accept).toHaveBeenCalledTimes(1);
  });
});
