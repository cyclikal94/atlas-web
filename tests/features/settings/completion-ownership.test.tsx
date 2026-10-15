import { RouterProvider } from "@tanstack/react-router";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ProtectedProviders } from "../../../src/app/providers";
import { createAppRouter } from "../../../src/app/router";
import { ShellEnvProvider } from "../../../src/app/shell/env";
import { MESSAGE_TEXT } from "../../../src/features/authentication/outcome-copy";
import { FIELD_MESSAGE } from "../../../src/features/authentication/validation";
import { NOT_SENT_DELAYS_MS } from "../../../src/features/settings/sessions-devices/until-sent";
import { LinkedIdentities } from "../../../src/features/settings/signing-in/LinkedIdentities";
import {
  type Identity,
  type OidcStartOutcome,
  type Operations,
  type Result,
  type Session,
  SessionProvider,
  type Store,
} from "../../../src/session";
import { installMatchMedia } from "../../helpers/match-media";
import {
  attemptsDouble,
  sessionDouble,
  sessionRow,
} from "../../helpers/session-double";
import { eventuallyShown } from "../../helpers/shown";

/**
 * WEB-08d review R4 (revision 3) and the design assessment's A4 and A5: an answer belongs to the interaction that asked for it. A
 * password form, a "Check now" or a linked-identity action that was dismissed, left, replaced or whose identity moved on shows
 * nothing for its answer: no message, no announcement in either live region (the announcer outlives the form), no focus. Every
 * case has a control in which the same answer reaches a form that is still current and is shown. The live regions are read after
 * two animation frames: the announcer clears a region at once and writes it on the next frame. A `not_sent` answer is synthetic
 * here (the kernel's own admission boundary is `tests/session/operations-withdraw.test.ts`).
 */
installMatchMedia({ width: 1440 });

afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  await new Promise((resolve) => setTimeout(resolve, 0));
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-30T12:00:00.000Z"));
  localStorage.clear();
  document.head.innerHTML = '<meta name="theme-color" content="#08090A">';
});

const ok = <T,>(value: T) => ({ ok: true as const, value });
const NOT_SENT = { ok: false as const, error: "not_sent" as const };
const ACCOUNT = {
  id: "acct-1",
  username: "kieran",
  has_password: true,
  oidc_issuers: [] as string[],
};
const A: Identity = { account_id: "acct", epoch: 1, session_id: "sess-1" };

/** An answer the test releases, inside `act` (`release`) or in the caller's own turn (`resolve`). */
function later<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return {
    promise,
    resolve: (value: T) => resolve(value),
    release: (value: T) => act(async () => resolve(value)),
  };
}

function identityStore(initial: Identity) {
  let value: Identity | null = initial;
  const listeners = new Set<() => void>();
  const store: Store<Identity | null> & { set(next: Identity | null): void } = {
    get: () => value,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set: (next) => {
      value = next;
      for (const listener of listeners) listener();
    },
  };
  return store;
}

const polite = () =>
  document.querySelector("[aria-live=polite]")?.textContent ?? "";
const assertive = () =>
  document.querySelector("[aria-live=assertive]")?.textContent ?? "";
/** Two animation frames: the announcer's queued write has run (or would have). */
const frames = () =>
  act(
    async () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
/** Longer than the first `not_sent` retry delay, in real time: a retry that was going to be made has been made. */
const pastFirstRetry = () =>
  act(
    async () =>
      new Promise((resolve) =>
        setTimeout(resolve, (NOT_SENT_DELAYS_MS[0] ?? 0) * 4),
      ),
  );
const clickIn = (dialog: HTMLElement, name: string) =>
  fireEvent.click(within(dialog).getByRole("button", { name }));

/** The composed Signing in route (real router and providers) over a double of the public session interface. */
async function signingIn(
  operations: Partial<Operations>,
  overrides: Partial<Session> = {},
) {
  const session = sessionDouble(
    {
      readAccount: vi.fn(async () => ok(ACCOUNT)),
      listSessions: vi.fn(async () =>
        ok({
          sessions: [
            sessionRow({
              created_at: new Date(Date.now() - 60_000).toISOString(),
            }),
          ],
        }),
      ),
      ...operations,
    },
    overrides,
  );
  const router = createAppRouter({ initialPath: "/settings/signing-in" });
  render(
    <SessionProvider session={session}>
      <ProtectedProviders>
        <ShellEnvProvider
          value={{
            syncModel: { phase: "synced", pendingCount: 0, conflictCount: 0 },
            onOpenSync: () => {},
          }}
        >
          <RouterProvider router={router} />
        </ShellEnvProvider>
      </ProtectedProviders>
    </SessionProvider>,
  );
  const dialog = await screen.findByRole("dialog", { name: "Signing in" });
  await within(dialog).findByLabelText("Current password");
  return { dialog, router };
}

function typePasswords(dialog: HTMLElement, current: string, next: string) {
  fireEvent.change(within(dialog).getByLabelText("Current password"), {
    target: { value: current },
  });
  fireEvent.change(within(dialog).getByLabelText("New password"), {
    target: { value: next },
  });
}

async function submitPassword(dialog: HTMLElement) {
  typePasswords(dialog, "old-password", "brand-new-password");
  clickIn(dialog, "Change password");
}

/** changePassword whose FIRST answer the test releases; later calls answer `then`. */
function heldPassword(then: Result<"changed"> = ok("changed")) {
  const first = later<Result<"changed">>();
  const changePassword = vi
    .fn<Operations["changePassword"]>()
    .mockImplementationOnce(() => first.promise)
    .mockImplementation(async () => then);
  return { first, changePassword };
}

const REFUSED = { ok: false as const, error: "http" as const, status: 422 };

/** The three ways to dismiss Signing in. */
const DISMISS: Array<[string, (dialog: HTMLElement) => void]> = [
  ["Close", (dialog) => clickIn(dialog, "Close")],
  ["Escape", (dialog) => fireEvent.keyDown(dialog, { key: "Escape" })],
];

/** Every class of answer a dismissed password form can receive. */
const OUTCOMES: Array<[string, () => Promise<Result<"changed">>]> = [
  ["not_sent", async () => NOT_SENT],
  ["a refusal (422)", async () => REFUSED],
  ["rate limited (429)", async () => ({ ...REFUSED, status: 429 })],
  ["offline (unknown)", async () => ({ ok: false, error: "offline" })],
  ["a 503 (unknown)", async () => ({ ...REFUSED, status: 503 })],
  ["success", async () => ok("changed")],
  ["auth_state", async () => ({ ok: false, error: "auth_state" })],
  ["a throw", () => Promise.reject(new Error("boom"))],
];

describe("R4: a dismissed password form says nothing about its answer", () => {
  for (const [how, dismiss] of DISMISS)
    test.each(OUTCOMES)(
      `${how}, then %s: no announcement, no retry`,
      async (_name, answer) => {
        const held = later<() => Promise<Result<"changed">>>();
        const changePassword = vi
          .fn<Operations["changePassword"]>()
          .mockImplementationOnce(() => held.promise.then((answer) => answer()))
          .mockResolvedValue(REFUSED);
        const { dialog } = await signingIn({ changePassword });
        await submitPassword(dialog);
        await waitFor(() => expect(changePassword).toHaveBeenCalledTimes(1));
        dismiss(dialog);
        await waitFor(() =>
          expect(screen.queryAllByRole("dialog")).toEqual([]),
        );
        await held.release(answer);
        await pastFirstRetry();
        await frames();
        expect(changePassword).toHaveBeenCalledTimes(1);
        expect(assertive()).toBe("");
        expect(polite()).toBe("");
        expect(screen.queryAllByRole("dialog")).toEqual([]);
      },
    );

  test("control: left open, a not_sent answer is tried again and the refusal that follows is shown and announced", async () => {
    const { first, changePassword } = heldPassword(REFUSED);
    const { dialog } = await signingIn({ changePassword });
    await submitPassword(dialog);
    await waitFor(() => expect(changePassword).toHaveBeenCalledTimes(1));
    await first.release(NOT_SENT);
    await waitFor(() => expect(changePassword).toHaveBeenCalledTimes(2));
    await frames();
    expect(assertive()).toBe(MESSAGE_TEXT.check_details);
    expect(
      within(dialog)
        .queryAllByText(MESSAGE_TEXT.check_details)
        .map((node) => node.hasAttribute("data-error")),
    ).toEqual([true]);
    expect(document.activeElement).toBe(
      within(dialog).getByLabelText("Current password"),
    );
    expect(within(dialog).getByLabelText("Current password")).toHaveValue("");
    expect(within(dialog).getByLabelText("New password")).toHaveValue("");
  });

  test("control: left open, a refusal is shown and announced at once", async () => {
    const { first, changePassword } = heldPassword();
    const { dialog } = await signingIn({ changePassword });
    await submitPassword(dialog);
    await waitFor(() => expect(changePassword).toHaveBeenCalledTimes(1));
    await first.release({ ...REFUSED, status: 429 });
    await frames();
    expect(assertive()).toBe(MESSAGE_TEXT.rate_limited);
    expect(changePassword).toHaveBeenCalledTimes(1);
  });

  test("an answer that arrives after Close is pressed, before the route has changed, is not shown (synchronous dismissal)", async () => {
    const { first, changePassword } = heldPassword(REFUSED);
    const { dialog } = await signingIn({ changePassword });
    await submitPassword(dialog);
    await waitFor(() => expect(changePassword).toHaveBeenCalledTimes(1));
    // The answer lands in the same turn as the dismissal: the form has not unmounted yet.
    await act(async () => {
      clickIn(dialog, "Close");
      first.resolve(REFUSED);
    });
    await waitFor(() => expect(screen.queryAllByRole("dialog")).toEqual([]));
    await pastFirstRetry();
    await frames();
    expect(assertive()).toBe("");
    expect(changePassword).toHaveBeenCalledTimes(1);
  });

  test("control (same turn): a not_sent answer in the turn Close is pressed starts no retry", async () => {
    const { first, changePassword } = heldPassword(REFUSED);
    const { dialog } = await signingIn({ changePassword });
    await submitPassword(dialog);
    await waitFor(() => expect(changePassword).toHaveBeenCalledTimes(1));
    await act(async () => {
      clickIn(dialog, "Close");
      first.resolve(NOT_SENT);
    });
    await waitFor(() => expect(screen.queryAllByRole("dialog")).toEqual([]));
    await pastFirstRetry();
    await frames();
    expect(changePassword).toHaveBeenCalledTimes(1);
    expect(assertive()).toBe("");
  });
});

describe("R4: an old password answer leaves a reopened form alone", () => {
  test.each([
    ["a refusal", REFUSED],
    ["not_sent", NOT_SENT],
    ["offline", { ok: false as const, error: "offline" as const }],
  ])(
    "%s for the old form: the new form keeps its values, its message, its announcement and focus",
    async (_name, answer) => {
      const { first, changePassword } = heldPassword(REFUSED);
      const { dialog } = await signingIn({ changePassword });
      await submitPassword(dialog);
      await waitFor(() => expect(changePassword).toHaveBeenCalledTimes(1));
      clickIn(dialog, "Close");
      await waitFor(() => expect(screen.queryAllByRole("dialog")).toEqual([]));
      // Opened again from the Settings page, as a person would.
      fireEvent.click(await screen.findByRole("link", { name: "Signing in" }));
      const reopened = await screen.findByRole("dialog", {
        name: "Signing in",
      });
      expect(reopened).not.toBe(dialog);
      await within(reopened).findByLabelText("Current password");
      // A new message of the new form: a new password that is too short.
      typePasswords(reopened, "typed-again", "short");
      clickIn(reopened, "Change password");
      await frames();
      const message = FIELD_MESSAGE.password_short;
      expect(assertive()).toBe(message);
      const newField = within(reopened).getByLabelText("New password");
      expect(document.activeElement).toBe(newField);

      await first.release(answer);
      await pastFirstRetry();
      await frames();
      expect(changePassword).toHaveBeenCalledTimes(1);
      expect(assertive()).toBe(message);
      expect(polite()).toBe("");
      expect(screen.queryAllByRole("dialog")).toEqual([reopened]);
      expect(within(reopened).getByLabelText("Current password")).toHaveValue(
        "typed-again",
      );
      expect(newField).toHaveValue("short");
      expect(document.activeElement).toBe(newField);
      expect(
        [...reopened.querySelectorAll("[data-error]")].map(
          (node) => node.textContent,
        ),
      ).toEqual([message]);
      expect(reopened.querySelector("[data-unconfirmed]")).toBeNull();
    },
  );
});

describe("R4: a password answer for an identity that moved on is not shown", () => {
  test.each([
    ["another account", { ...A, account_id: "other" }, false],
    ["a new sign-in of the same account (epoch)", { ...A, epoch: 2 }, false],
    ["control: the same identity", { ...A }, true],
  ])("%s", async (_name, next, shown) => {
    const identity = identityStore(A);
    const { first, changePassword } = heldPassword(REFUSED);
    const { dialog } = await signingIn({ changePassword }, { identity });
    await submitPassword(dialog);
    await waitFor(() => expect(changePassword).toHaveBeenCalledTimes(1));
    act(() => identity.set(next));
    await first.release(REFUSED);
    await frames();
    expect(assertive()).toBe(shown ? MESSAGE_TEXT.check_details : "");
    expect(
      [...dialog.querySelectorAll("[data-error]")].map(
        (node) => node.textContent,
      ),
    ).toEqual(shown ? [MESSAGE_TEXT.check_details] : []);
    // Either way the form is not left busy: its own operation has ended.
    expect(
      within(dialog).getByRole("button", { name: "Change password" }),
    ).toBeEnabled();
    expect(changePassword).toHaveBeenCalledTimes(1);
  });
});

describe("A4: a Check now answer belongs to the screen that asked", () => {
  /** A password change whose outcome is unknown, then a Check now read the test holds. */
  async function uncertain(overrides: Partial<Session> = {}) {
    const check = later<Result<typeof ACCOUNT>>();
    // Only the read the press makes is held: other readers of the account (the Settings page behind) are answered at once.
    let hold = false;
    const readAccount = vi.fn<Operations["readAccount"]>(async () => {
      if (!hold) return ok(ACCOUNT);
      hold = false;
      return check.promise;
    });
    const changePassword = vi.fn<Operations["changePassword"]>(async () => ({
      ok: false,
      error: "offline",
    }));
    const opened = await signingIn({ readAccount, changePassword }, overrides);
    await submitPassword(opened.dialog);
    const button = await eventuallyShown(
      () => within(opened.dialog).queryByRole("button", { name: "Check now" }),
      "Check now",
    );
    const before = readAccount.mock.calls.length;
    hold = true;
    fireEvent.click(button);
    expect(hold).toBe(false);
    return { ...opened, check, readAccount, checks: before + 1 };
  }

  test.each(DISMISS)(
    "dismissed (%s) while checking, a working session: nothing is said",
    async (_how, dismiss) => {
      const { dialog, check, readAccount, checks } = await uncertain();
      dismiss(dialog);
      await waitFor(() => expect(screen.queryAllByRole("dialog")).toEqual([]));
      const after = readAccount.mock.calls.length;
      await check.release(ok(ACCOUNT));
      await frames();
      expect(polite()).toBe("");
      expect(assertive()).toBe("");
      // The check itself is not asked again (the Settings page behind reads the account for itself when it is shown).
      expect(after).toBeGreaterThanOrEqual(checks);
      expect(readAccount).toHaveBeenCalledTimes(after);
    },
  );

  test("dismissed in the same turn as the answer: nothing is said", async () => {
    const { dialog, check } = await uncertain();
    await act(async () => {
      clickIn(dialog, "Close");
      check.resolve(ok(ACCOUNT));
    });
    await waitFor(() => expect(screen.queryAllByRole("dialog")).toEqual([]));
    await frames();
    expect(polite()).toBe("");
  });

  test.each([
    ["another account", { ...A, account_id: "other" }, false],
    ["a new sign-in of the same account (epoch)", { ...A, epoch: 2 }, false],
    ["control: the same identity", { ...A }, true],
  ])("the identity moved on while checking: %s", async (_name, next, shown) => {
    const identity = identityStore(A);
    const { dialog, check } = await uncertain({ identity });
    act(() => identity.set(next));
    await check.release(ok(ACCOUNT));
    await frames();
    expect(polite()).toBe(shown ? MESSAGE_TEXT.still_unconfirmed : "");
    expect(dialog.querySelectorAll("[data-still-unconfirmed]")).toHaveLength(
      shown ? 1 : 0,
    );
    // Not left "Checking…" either way.
    expect(
      within(dialog).getByRole("button", { name: "Check now" }),
    ).toBeEnabled();
  });

  test("control: left open, a working session leaves the change unconfirmed and says so", async () => {
    const { dialog, check } = await uncertain();
    await check.release(ok(ACCOUNT));
    await frames();
    expect(polite()).toBe(MESSAGE_TEXT.still_unconfirmed);
    expect(dialog.querySelectorAll("[data-still-unconfirmed]")).toHaveLength(1);
    expect(dialog.querySelectorAll("[data-unconfirmed]")).toHaveLength(1);
  });

  test("a double press of Check now, before Checking… renders, asks once", async () => {
    const readAccount = vi.fn<Operations["readAccount"]>(async () =>
      ok(ACCOUNT),
    );
    const changePassword = vi.fn<Operations["changePassword"]>(async () => ({
      ok: false,
      error: "offline",
    }));
    const { dialog } = await signingIn({ readAccount, changePassword });
    await submitPassword(dialog);
    const button = await eventuallyShown(
      () => within(dialog).queryByRole("button", { name: "Check now" }),
      "Check now",
    );
    const before = readAccount.mock.calls.length;
    act(() => {
      button.click();
      button.click();
    });
    expect(readAccount).toHaveBeenCalledTimes(before + 1);
  });
});

describe("A5: each linked-identity action owns its own progress and failure", () => {
  const X = "https://a.example.test";
  const Y = "https://b.example.test";
  const UNLINK_REFUSED = {
    ok: false as const,
    error: "http" as const,
    status: 403,
  };

  function linked(overrides: Partial<Session> = {}) {
    const answers = new Map<
      string,
      ReturnType<typeof later<Result<"unlinked">>>
    >();
    const unlinkOidc = vi.fn((issuer: string) => {
      const answer = later<Result<"unlinked">>();
      answers.set(issuer, answer);
      return answer.promise;
    });
    const sso = later<OidcStartOutcome>();
    const attempts = attemptsDouble({ startOidc: vi.fn(() => sso.promise) });
    const session = sessionDouble({ unlinkOidc }, { attempts, ...overrides });
    const view = render(
      <SessionProvider session={session}>
        <ProtectedProviders>
          <LinkedIdentities
            account={{ ...ACCOUNT, oidc_issuers: [X, Y] }}
            currentSessionStartedAt={new Date(
              Date.now() - 60_000,
            ).toISOString()}
            navigate={vi.fn()}
          />
        </ProtectedProviders>
      </SessionProvider>,
    );
    return { view, unlinkOidc, answers, attempts, sso };
  }
  const rowOf = (issuer: string) =>
    [...document.querySelectorAll<HTMLElement>("[data-issuer-row]")].find(
      (row) => row.textContent?.includes(new URL(issuer).host),
    ) as HTMLElement;
  const removing = (issuer: string) =>
    within(rowOf(issuer)).queryAllByText("Removing…").length;
  const errorOf = (issuer: string) =>
    [...rowOf(issuer).querySelectorAll("[data-error]")].map(
      (node) => node.textContent,
    );
  const press = (issuer: string) =>
    fireEvent.click(
      screen.getByRole("button", { name: `Remove ${new URL(issuer).host}` }),
    );

  test.each([
    ["X first", [X, Y]],
    ["Y first", [Y, X]],
  ])(
    "two removals in progress, %s answered: the other stays in progress and keeps its own outcome",
    async (_name, order) => {
      const { unlinkOidc, answers } = linked();
      press(X);
      press(Y);
      await waitFor(() => expect(unlinkOidc).toHaveBeenCalledTimes(2));
      expect([removing(X), removing(Y)]).toEqual([1, 1]);
      const [early, late] = order as [string, string];
      await answers.get(early)?.release(UNLINK_REFUSED);
      expect(removing(early)).toBe(0);
      expect(removing(late)).toBe(1);
      expect(errorOf(early)).toEqual([MESSAGE_TEXT.unlink_refused]);
      expect(errorOf(late)).toEqual([]);
      // Still in progress: its Remove cannot be pressed again.
      expect(
        screen.queryAllByRole("button", {
          name: `Remove ${new URL(late).host}`,
        }),
      ).toHaveLength(0);
      await answers.get(late)?.release(NOT_SENT);
      await waitFor(() => expect(unlinkOidc).toHaveBeenCalledTimes(3));
      await answers.get(late)?.release(UNLINK_REFUSED);
      expect(errorOf(early)).toEqual([MESSAGE_TEXT.unlink_refused]);
      expect(errorOf(late)).toEqual([MESSAGE_TEXT.unlink_refused]);
      expect([removing(X), removing(Y)]).toEqual([0, 0]);
    },
  );

  test("starting a removal clears only its own earlier failure", async () => {
    const { unlinkOidc, answers } = linked();
    press(X);
    await waitFor(() => expect(unlinkOidc).toHaveBeenCalledTimes(1));
    await answers.get(X)?.release(UNLINK_REFUSED);
    expect(errorOf(X)).toEqual([MESSAGE_TEXT.unlink_refused]);
    press(Y);
    await waitFor(() => expect(unlinkOidc).toHaveBeenCalledTimes(2));
    expect(errorOf(X)).toEqual([MESSAGE_TEXT.unlink_refused]);
    // Pressing X again starts X afresh: its own failure goes.
    press(X);
    await waitFor(() => expect(unlinkOidc).toHaveBeenCalledTimes(3));
    expect(errorOf(X)).toEqual([]);
  });

  test("a double press of one Remove sends one request", async () => {
    const { unlinkOidc } = linked();
    const button = screen.getByRole("button", {
      name: `Remove ${new URL(X).host}`,
    });
    act(() => {
      button.click();
      button.click();
    });
    await act(async () => undefined);
    expect(unlinkOidc).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["the removal answered first", "remove"],
    ["the link answered first", "link"],
  ])(
    "a removal and a link in progress, %s: neither releases nor replaces the other",
    async (_name, first) => {
      const { unlinkOidc, answers, attempts, sso } = linked();
      press(X);
      fireEvent.click(
        screen.getByRole("button", { name: "Link single sign-on" }),
      );
      await waitFor(() => expect(attempts.startOidc).toHaveBeenCalledTimes(1));
      expect(unlinkOidc).toHaveBeenCalledTimes(1);
      const linking = () =>
        screen.queryAllByText("Opening your provider…").length;
      const linkError = () =>
        [
          ...document.querySelectorAll(
            "[data-linked] > div:last-child [data-error]",
          ),
        ].map((node) => node.textContent);
      if (first === "remove") {
        await answers.get(X)?.release(UNLINK_REFUSED);
        expect(errorOf(X)).toEqual([MESSAGE_TEXT.unlink_refused]);
        expect(linking()).toBe(1);
        expect(linkError()).toEqual([]);
        await sso.release({ kind: "exchange_failed", status: null });
      } else {
        await sso.release({ kind: "exchange_failed", status: null });
        expect(linkError()).toEqual([MESSAGE_TEXT.unreachable]);
        expect(removing(X)).toBe(1);
        expect(errorOf(X)).toEqual([]);
        await answers.get(X)?.release(UNLINK_REFUSED);
      }
      expect(linking()).toBe(0);
      expect(removing(X)).toBe(0);
      expect(errorOf(X)).toEqual([MESSAGE_TEXT.unlink_refused]);
      expect(linkError()).toEqual([MESSAGE_TEXT.unreachable]);
    },
  );

  test.each([
    ["another account", { ...A, account_id: "other" }, false],
    ["a new sign-in of the same account (epoch)", { ...A, epoch: 2 }, false],
    ["control: the same identity", { ...A }, true],
  ])(
    "the identity moved on during a removal: %s",
    async (_name, next, shown) => {
      const identity = identityStore(A);
      const { unlinkOidc, answers } = linked({ identity });
      press(X);
      await waitFor(() => expect(unlinkOidc).toHaveBeenCalledTimes(1));
      act(() => identity.set(next));
      await answers.get(X)?.release(UNLINK_REFUSED);
      expect(errorOf(X)).toEqual(shown ? [MESSAGE_TEXT.unlink_refused] : []);
      expect(removing(X)).toBe(0);
    },
  );

  test.each([
    ["another account", { ...A, account_id: "other" }, false],
    ["control: the same identity", { ...A }, true],
  ])("the identity moved on during a link: %s", async (_name, next, shown) => {
    const identity = identityStore(A);
    const { attempts, sso } = linked({ identity });
    fireEvent.click(
      screen.getByRole("button", { name: "Link single sign-on" }),
    );
    await waitFor(() => expect(attempts.startOidc).toHaveBeenCalledTimes(1));
    act(() => identity.set(next));
    await sso.release({ kind: "exchange_failed", status: null });
    expect(
      [
        ...document.querySelectorAll(
          "[data-linked] > div:last-child [data-error]",
        ),
      ].map((node) => node.textContent),
    ).toEqual(shown ? [MESSAGE_TEXT.unreachable] : []);
    expect(screen.queryAllByText("Opening your provider…")).toHaveLength(0);
  });

  test.each([
    ["another account", { ...A, account_id: "other" }, false],
    ["control: the same identity", { ...A }, true],
  ])(
    "the identity moved on during a removal whose outcome is unknown: %s",
    async (_name, next, shown) => {
      const identity = identityStore(A);
      const { unlinkOidc, answers } = linked({ identity });
      press(X);
      await waitFor(() => expect(unlinkOidc).toHaveBeenCalledTimes(1));
      act(() => identity.set(next));
      await answers.get(X)?.release({ ok: false, error: "offline" });
      expect(document.querySelectorAll("[data-unconfirmed]")).toHaveLength(
        shown ? 1 : 0,
      );
    },
  );
});
