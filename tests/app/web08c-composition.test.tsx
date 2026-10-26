import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AccountSlot } from "../../src/app/AccountSlot";
import { reviewDevice } from "../../src/app/lifecycle-wiring";
import {
  focusWhenPresent,
  RETURN_DESTINATION_TTL_MS,
  returnDestination,
} from "../../src/app/return-destination";
import { SessionNotices } from "../../src/app/SessionNotices";
import { SessionRoot } from "../../src/app/SessionRoot";
import { AnnouncerProvider } from "../../src/components/ui/announcer";
import { NEUTRAL_COPY } from "../../src/components/ui/neutral-state";
import { authFeedback } from "../../src/features/authentication/feedback";
import { ENDED_IN_TREE } from "../../src/features/authentication/outcome-copy";
import { signInRequest } from "../../src/features/authentication/sign-in-request";
import {
  sectionPath,
  settingsSections,
} from "../../src/features/settings/sections";
import { switchFlow } from "../../src/features/switch/state";
import { SessionProvider, type SessionView } from "../../src/session";
import {
  attemptsDouble,
  sessionDouble,
  store,
} from "../helpers/session-double";
import { sourceText } from "../support/source-text";

/**
 * WEB-08c: the composition-level pieces — the rail's verified-only account control (G-8/G-9), the `1c.ended` surfaces (D-8c-04), the
 * return destination (D-8c-03) and its two producers (G-23 is in confirm-its-you.test.tsx; G-10 here), and boot's wiring.
 */
beforeEach(() => {
  authFeedback.clearOnBegin();
  signInRequest.clear();
  returnDestination.clear();
  switchFlow.close();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  authFeedback.clearOnBegin();
  signInRequest.clear();
  returnDestination.clear();
  switchFlow.close();
});

describe("the rail's account control (G-8, G-9)", () => {
  test("it names the verified username and what it does, and opens the switcher for THAT account", () => {
    render(<AccountSlot label="kieran" account="acct-1" collapsed={false} />);
    const button = screen.getByRole("button", {
      name: "kieran, switch account",
    });
    expect(button).toHaveAttribute("aria-haspopup", "dialog");
    expect(button).toHaveTextContent("kieran");
    fireEvent.click(button);
    expect(switchFlow.get()).toEqual({ stage: "picker", owner: "acct-1" });
    expect(switchFlow.returnFocus()).toBe(button);
  });

  test("collapsed: one 44px control with the same accessible name; the initial is decoration", () => {
    render(<AccountSlot label="kieran" account="acct-1" collapsed />);
    const button = screen.getByRole("button", {
      name: "kieran, switch account",
    });
    expect(button.querySelector("[aria-hidden='true']")?.textContent).toBe("K");
  });

  test("MU-8C-05: the protected tree passes NO slot unless the label is verified for the current epoch (nothing from an id)", () => {
    const source = sourceText("src/app/protected-tree.tsx");
    expect(source).toMatch(/const label = useAccountLabel\(\);/);
    expect(source).toMatch(
      /\.\.\.\(label === null \|\| account === null\s*\? \{\}/,
    );
    expect(source).not.toMatch(/label=\{account/);
  });
});

function root(view: SessionView, pathname = "/") {
  const session = sessionDouble(
    {},
    { view: store(view), attempts: attemptsDouble() },
  );
  return {
    session,
    node: (
      <SessionProvider session={session}>
        <SessionRoot pathname={pathname} />
      </SessionProvider>
    ),
  };
}

describe("1c.ended surfaces (D-8c-04)", () => {
  test("signed out with the fact: the accepted 1c.ended card; 'Sign in again' leads to the form and the fact is no longer news", () => {
    authFeedback.add({ kind: "ended" });
    const { session, node } = root({ kind: "signed_out", state: null });
    session.actions.signIn = vi.fn(() => signInRequest.request());
    const { rerender } = render(node);
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: NEUTRAL_COPY["1c.ended"].heading,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(NEUTRAL_COPY["1c.ended"].message),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sign in again" }));
    rerender(node);
    expect(authFeedback.get()).toEqual([]);
    expect(screen.getByLabelText("Username")).toBeInTheDocument();
  });

  test("signed out without the fact: the plain sign-in page", () => {
    const { node } = root({ kind: "signed_out", state: null });
    render(node);
    expect(screen.queryByText(NEUTRAL_COPY["1c.ended"].heading)).toBeNull();
  });

  test("while an account displays again: a dismissible status line with the heading and message, without 'Sign in again'", () => {
    authFeedback.add({ kind: "ended" });
    render(
      <SessionProvider session={sessionDouble()}>
        <AnnouncerProvider>
          <SessionNotices />
        </AnnouncerProvider>
      </SessionProvider>,
    );
    const notice = document.querySelector('[data-notice="feedback-ended"]');
    expect(notice?.textContent).toContain(ENDED_IN_TREE.heading);
    expect(notice?.textContent).toContain(ENDED_IN_TREE.message);
    expect(notice?.textContent).not.toContain("Sign in again");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(authFeedback.get()).toEqual([]);
  });
});

describe("the return destination (D-8c-03)", () => {
  const base = {
    account: "acct-1",
    epoch: 3,
    path: "/settings/signing-in",
    focusKey: "link-sso",
    requestedAt: 1_000,
  };

  test("re-authentication: used once, only for the same account at a NEWER epoch; an older or equal mount keeps it", () => {
    returnDestination.set({ ...base, when: "newer" });
    expect(returnDestination.take("acct-1", 3, 1_500)).toBeNull();
    expect(returnDestination.peek()).not.toBeNull();
    expect(returnDestination.take("acct-1", 4, 1_600)).toMatchObject({
      path: "/settings/signing-in",
    });
    expect(returnDestination.take("acct-1", 5, 1_700)).toBeNull();
  });

  test("MU-8C-09: another account mounting drops it", () => {
    returnDestination.set({ ...base, when: "newer" });
    expect(returnDestination.take("acct-2", 4, 1_500)).toBeNull();
    expect(returnDestination.peek()).toBeNull();
    expect(returnDestination.take("acct-1", 4, 1_600)).toBeNull();
  });

  test("MU-8C-10: the epoch is honoured (a device review: that epoch or later; never an older one)", () => {
    returnDestination.set({ ...base, when: "same-or-newer" });
    expect(returnDestination.take("acct-1", 2, 1_500)).toBeNull();
    expect(returnDestination.take("acct-1", 3, 1_500)).not.toBeNull();
  });

  test("it expires 120 s after it was requested", () => {
    expect(RETURN_DESTINATION_TTL_MS).toBe(120_000);
    returnDestination.set({ ...base, when: "newer" });
    expect(returnDestination.take("acct-1", 4, 1_000 + 120_001)).toBeNull();
    expect(returnDestination.peek()).toBeNull();
  });

  test("focusWhenPresent waits for the control and focuses it once it exists, never inside an inert subtree", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const stop = focusWhenPresent("link-sso", { timeoutMs: 1_000 });
      const inert = document.createElement("div");
      inert.setAttribute("inert", "");
      const hidden = document.createElement("button");
      hidden.dataset.returnFocus = "link-sso";
      inert.append(hidden);
      document.body.append(inert);
      await act(async () => vi.advanceTimersByTime(100));
      expect(document.activeElement).not.toBe(hidden);
      inert.remove();
      const target = document.createElement("button");
      target.dataset.returnFocus = "link-sso";
      document.body.append(target);
      await act(async () => vi.advanceTimersByTime(100));
      expect(document.activeElement).toBe(target);
      stop();
      target.remove();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Review this device (G-10)", () => {
  test("it records the Sessions & devices screen, this device's row, for the account the notice concerned", () => {
    const session = sessionDouble();
    reviewDevice(session, () => 5_000);
    expect(returnDestination.peek()).toEqual({
      account: "acct",
      epoch: 1,
      when: "same-or-newer",
      path: "/settings/sessions",
      focusKey: "device-this",
      requestedAt: 5_000,
    });
  });

  test("with nobody settled it does nothing", () => {
    const session = sessionDouble({}, { identity: store(null) });
    reviewDevice(session);
    expect(returnDestination.peek()).toBeNull();
  });

  test("its path is the Settings registry's Sessions & devices section, named without importing the registry (revision 12)", () => {
    const sessions = settingsSections().find((s) => s.id === "sessions");
    expect(sessions && sectionPath(sessions)).toBe("/settings/sessions");
    reviewDevice(sessionDouble(), () => 1);
    expect(returnDestination.peek()?.path).toBe(
      sessions && sectionPath(sessions),
    );
    // The registry imports every section's route builder (the calendar section's lazy screen among them): from this lazy chunk it
    // split the fixture shell's entry into further initial files (.agtx/evidence/WEB-08c/revision-12/budget).
    expect(sourceText("src/app/lifecycle-wiring.ts")).not.toMatch(
      /from "\.\.\/features\/settings\/sections"/,
    );
  });

  test("MU-8C-11: boot passes onReviewDevice and starts the 1c.ended watcher before the session starts", () => {
    const boot = sourceText("src/app/boot.tsx");
    expect(boot).toMatch(
      /onReviewDevice: \(\) => lifecycle\.reviewDevice\(session\)/,
    );
    const watcher = boot.indexOf("lifecycle.startAttemptEndWatcher(session)");
    const start = boot.indexOf("await session.start(");
    expect(watcher).toBeGreaterThan(0);
    expect(watcher).toBeLessThan(start);
    // Loaded with the forms, not on the initial path.
    expect(boot).toMatch(/import\("\.\/lifecycle-wiring"\)/);
    expect(boot).not.toMatch(/from "\.\/lifecycle-wiring"/);
  });

  test("this device's Retire control carries the focus key", () => {
    expect(
      sourceText("src/features/settings/sessions-devices/DevicesSection.tsx"),
    ).toMatch(
      /data-return-focus=\{row\.current \? "device-this" : undefined\}/,
    );
  });
});
