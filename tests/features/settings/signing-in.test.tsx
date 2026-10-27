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
import { axe } from "jest-axe";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ProtectedProviders } from "../../../src/app/providers";
import { createAppRouter } from "../../../src/app/router";
import { ShellEnvProvider } from "../../../src/app/shell/env";
import { MESSAGE_TEXT } from "../../../src/features/authentication/outcome-copy";
import {
  NO_PASSWORD_BODY,
  PASSWORD_CONSEQUENCE,
  PASSWORD_HINT,
  PASSWORD_OFFLINE_REASON,
  WRONG_CURRENT_WARNING,
} from "../../../src/features/settings/signing-in/ChangePasswordForm";
import {
  issuerLabel,
  LINK_LABEL,
  LINK_OFFLINE_REASON,
  LinkedIdentities,
  NO_PASSWORD_REASON,
  REMOVE_CONSEQUENCE,
  REMOVE_OFFLINE_REASON,
  REMOVE_RULE,
  STALE_REASON,
} from "../../../src/features/settings/signing-in/LinkedIdentities";
import { leavesOutcomeUnknown } from "../../../src/features/settings/signing-in/outcome";
import { CHECK_OFFLINE_REASON } from "../../../src/features/settings/signing-in/Unconfirmed";
import {
  type AccountSummary,
  type Operations,
  type Result,
  SessionProvider,
} from "../../../src/session";
import { installMatchMedia } from "../../helpers/match-media";
import {
  attemptsDouble,
  sessionDouble,
  sessionRow,
  WITHDRAW,
} from "../../helpers/session-double";

installMatchMedia({ width: 1440 });
const setOnline = (value: boolean) =>
  Object.defineProperty(navigator, "onLine", { value, configurable: true });
afterEach(async () => {
  cleanup();
  // In this order: restoring mocks after the real timers are back would put a spied fake `setTimeout` back, and the wait below
  // would never end.
  vi.restoreAllMocks();
  vi.useRealTimers();
  setOnline(true);
  await new Promise((resolve) => setTimeout(resolve, 0));
});
/** The browser loses (or regains) its connection while the screen is open: the property changes, then the event. */
const goOffline = () =>
  act(async () => {
    setOnline(false);
    window.dispatchEvent(new Event("offline"));
  });
const goOnline = () =>
  act(async () => {
    setOnline(true);
    window.dispatchEvent(new Event("online"));
  });

const IDP = "https://idp.example.test";
const accountOf = (over: Partial<AccountSummary> = {}): AccountSummary => ({
  id: "acct-1",
  username: "kieran",
  has_password: true,
  oidc_issuers: [],
  ...over,
});
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const freshSessions = () =>
  vi.fn(async () => ({
    ok: true as const,
    value: { sessions: [sessionRow({ created_at: ago(60_000) })] },
  }));

async function open(
  operations: Partial<Operations> = {},
  attempts = attemptsDouble(),
) {
  const session = sessionDouble(
    {
      readAccount: vi.fn(async () => ({
        ok: true as const,
        value: accountOf(),
      })),
      listSessions: freshSessions(),
      ...operations,
    },
    { attempts },
  );
  const router = createAppRouter({ initialPath: "/settings/signing-in" });
  const view = render(
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
  return { session, attempts, router, dialog, ...view };
}

const fillPasswords = (dialog: HTMLElement, current: string, next: string) => {
  fireEvent.change(within(dialog).getByLabelText("Current password"), {
    target: { value: current },
  });
  fireEvent.change(within(dialog).getByLabelText("New password"), {
    target: { value: next },
  });
};
const submitPassword = (dialog: HTMLElement) =>
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Change password" }),
  );

/** C-SET: WF-SETTINGS-03, "Signing in". */
describe("Signing in: change your password", () => {
  test("labels, autocomplete tokens, the byte hint, both consequences, and no account data", async () => {
    const { dialog } = await open();
    await within(dialog).findByLabelText("Current password");
    expect(within(dialog).getByLabelText("Current password")).toHaveAttribute(
      "autocomplete",
      "current-password",
    );
    const next = within(dialog).getByLabelText("New password");
    expect(next).toHaveAttribute("autocomplete", "new-password");
    expect(next).toHaveAccessibleDescription(
      new RegExp(`${PASSWORD_HINT}.*${PASSWORD_CONSEQUENCE.slice(0, 20)}`),
    );
    expect(within(dialog).getByText(PASSWORD_CONSEQUENCE)).toBeInTheDocument();
    expect(within(dialog).getByText(WRONG_CURRENT_WARNING)).toBeInTheDocument();
    expect(PASSWORD_CONSEQUENCE).toBe(
      "This signs you out everywhere, including here. You'll sign back in with the new password. Anything you've recorded but not yet sent stays saved on this device.",
    );
    expect(dialog.textContent).not.toMatch(/kieran/);
  });

  test.each([
    [
      "no current password",
      "",
      "a-long-enough-new-one",
      "Enter your password.",
    ],
    [
      "an 11-byte new password",
      "old",
      "x".repeat(11),
      "Use at least 12 characters.",
    ],
    [
      "a new password over 1,024 bytes",
      "old",
      "x".repeat(1025),
      "That password is too long.",
    ],
  ])(
    "%s is refused before anything is sent",
    async (_n, current, next, message) => {
      const { dialog, session } = await open();
      await within(dialog).findByLabelText("Current password");
      fillPasswords(dialog, current, next);
      submitPassword(dialog);
      expect(await within(dialog).findByText(message)).toBeInTheDocument();
      expect(session.operations.changePassword).not.toHaveBeenCalled();
    },
  );

  test("E-16: the new password is measured in BYTES (three emoji are 12 bytes)", async () => {
    const { dialog, session } = await open();
    await within(dialog).findByLabelText("Current password");
    fillPasswords(dialog, "old-password", "😀😀😀");
    submitPassword(dialog);
    await waitFor(() =>
      expect(session.operations.changePassword).toHaveBeenCalledWith(
        {
          current: "old-password",
          next: "😀😀😀",
        },
        WITHDRAW,
      ),
    );
  });

  test("a success draws nothing (the tree unmounts into 'Reconnect') and clears both passwords", async () => {
    const { dialog } = await open();
    await within(dialog).findByLabelText("Current password");
    fillPasswords(dialog, "old-password", "brand-new-password");
    submitPassword(dialog);
    await waitFor(() =>
      expect(within(dialog).getByLabelText("Current password")).toHaveValue(""),
    );
    expect(within(dialog).getByLabelText("New password")).toHaveValue("");
    expect(within(dialog).queryByText(/couldn't confirm/i)).toBeNull();
    expect(dialog.querySelector("[data-error]")).toBeNull();
  });

  test.each(["auth_state", "closed"] as const)(
    "a `%s` answer (the session ended: a success, or a wrong current password, gap G-16) shows nothing: the neutral state takes over",
    async (error) => {
      const { dialog } = await open({
        changePassword: vi.fn(async () => ({ ok: false as const, error })),
      });
      await within(dialog).findByLabelText("Current password");
      fillPasswords(dialog, "WRONG", "brand-new-password");
      submitPassword(dialog);
      await waitFor(() =>
        expect(within(dialog).getByLabelText("Current password")).toHaveValue(
          "",
        ),
      );
      expect(dialog.querySelector("[data-error]")).toBeNull();
    },
  );

  // A 4xx proves the backend did not commit, so it is a refusal and says so. A 5xx proves nothing (review R6, below).
  test.each([
    [400, MESSAGE_TEXT.check_details],
    [403, MESSAGE_TEXT.wrong_origin],
    [422, MESSAGE_TEXT.check_details],
    [429, MESSAGE_TEXT.rate_limited],
    [418, MESSAGE_TEXT.generic],
  ])("a refusal with status %i says %j", async (status, text) => {
    const { dialog } = await open({
      changePassword: vi.fn(async () => ({
        ok: false as const,
        error: "http" as const,
        status,
      })),
    });
    await within(dialog).findByLabelText("Current password");
    fillPasswords(dialog, "old-password", "brand-new-password");
    submitPassword(dialog);
    expect(await within(dialog).findByText(text)).toBeInTheDocument();
    expect(within(dialog).queryByText(MESSAGE_TEXT.unconfirmed)).toBeNull();
    expect(
      within(dialog).queryByRole("button", { name: "Check now" }),
    ).toBeNull();
  });

  test("an unknown outcome is shown as UNCONFIRMED and is not retried; a working session does NOT prove the change failed (review R3)", async () => {
    // The original request may still be queued at a gateway or executing at the backend: a successful `GET /me` shows the session
    // works NOW, not that the earlier request cannot commit afterwards. The first check finds the session working, the second finds
    // it revoked (the change committed in between); neither may say "nothing changed", and nothing is sent again.
    // The dialog loads the account when it opens; the checks come after "Check now" is pressed.
    let checks = 0;
    let checking = false;
    const readAccount = vi.fn(async () => {
      if (!checking) return { ok: true as const, value: accountOf() };
      checks += 1;
      return checks === 1
        ? { ok: true as const, value: accountOf() }
        : { ok: false as const, error: "auth_state" as const };
    });
    const changePassword = vi.fn(async () => ({
      ok: false as const,
      error: "offline" as const,
    }));
    const { dialog } = await open({ readAccount, changePassword });
    await within(dialog).findByLabelText("Current password");
    fillPasswords(dialog, "old-password", "brand-new-password");
    submitPassword(dialog);
    expect(
      await within(dialog).findByText(MESSAGE_TEXT.unconfirmed),
    ).toBeInTheDocument();
    expect(changePassword).toHaveBeenCalledTimes(1);
    const before = readAccount.mock.calls.length;
    checking = true;
    fireEvent.click(within(dialog).getByRole("button", { name: "Check now" }));
    expect(
      (await within(dialog).findAllByText(MESSAGE_TEXT.still_unconfirmed))
        .length,
    ).toBeGreaterThan(0);
    expect(readAccount.mock.calls.length).toBe(before + 1);
    // Still unconfirmed, and honest about it.
    expect(within(dialog).getByText(MESSAGE_TEXT.unconfirmed)).toBeVisible();
    expect(dialog.textContent).not.toMatch(
      /nothing changed|didn't go through/i,
    );
    expect(
      within(dialog).getByRole("button", { name: "Check now" }),
    ).toBeEnabled();
    // The change committed behind the check: the session is gone, so the claim is withdrawn rather than left on screen.
    fireEvent.click(within(dialog).getByRole("button", { name: "Check now" }));
    await waitFor(() => expect(readAccount.mock.calls.length).toBe(before + 2));
    await waitFor(() =>
      expect(
        within(dialog).queryByText(MESSAGE_TEXT.still_unconfirmed),
      ).toBeNull(),
    );
    expect(changePassword).toHaveBeenCalledTimes(1);
  });

  test("a check that cannot reach the server is also not a conclusion", async () => {
    let checking = false;
    const readAccount = vi.fn(async () =>
      checking
        ? { ok: false as const, error: "offline" as const }
        : { ok: true as const, value: accountOf() },
    );
    const { dialog } = await open({
      readAccount,
      changePassword: vi.fn(async () => ({
        ok: false as const,
        error: "offline" as const,
      })),
    });
    await within(dialog).findByLabelText("Current password");
    fillPasswords(dialog, "old-password", "brand-new-password");
    submitPassword(dialog);
    await within(dialog).findByText(MESSAGE_TEXT.unconfirmed);
    checking = true;
    fireEvent.click(within(dialog).getByRole("button", { name: "Check now" }));
    expect(
      await within(dialog).findByText(/We couldn't check either/),
    ).toBeInTheDocument();
    expect(dialog.textContent).not.toMatch(/nothing changed/i);
  });

  test("an account with no password gets the plain note instead of a form (E-30)", async () => {
    const { dialog } = await open({
      readAccount: vi.fn(async () => ({
        ok: true as const,
        value: accountOf({ has_password: false }),
      })),
    });
    expect(
      await within(dialog).findByRole("heading", {
        name: "No password at all?",
      }),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(NO_PASSWORD_BODY)).toBeInTheDocument();
    expect(within(dialog).queryByLabelText("Current password")).toBeNull();
  });

  test("a failed load has its own banner; a closed one draws nothing", async () => {
    const { dialog } = await open({
      readAccount: vi.fn(async () => ({
        ok: false as const,
        error: "http" as const,
        status: 500,
      })),
    });
    expect(
      await within(dialog).findByText(/Couldn't load how you sign in/),
    ).toBeInTheDocument();
    cleanup();
    const closed = await open({
      readAccount: vi.fn(async () => ({
        ok: false as const,
        error: "closed" as const,
      })),
    });
    await waitFor(() =>
      expect(
        within(closed.dialog).queryByText(/Loading how you sign in/),
      ).toBeNull(),
    );
    expect(
      within(closed.dialog).queryByLabelText("Current password"),
    ).toBeNull();
  });

  test("no axe violations in the dialog", async () => {
    const { dialog } = await open({
      readAccount: vi.fn(async () => ({
        ok: true as const,
        value: accountOf({ oidc_issuers: [IDP] }),
      })),
    });
    await within(dialog).findByLabelText("Current password");
    expect((await axe(document.body)).violations).toEqual([]);
  });
});

function identities(
  account: AccountSummary,
  options: {
    startedAt?: string | null;
    operations?: Partial<Operations>;
    attempts?: ReturnType<typeof attemptsDouble>;
    navigate?: (url: string) => void;
  } = {},
) {
  const attempts = options.attempts ?? attemptsDouble();
  const navigate = options.navigate ?? vi.fn();
  const session = sessionDouble(options.operations ?? {}, { attempts });
  const tree = (startedAt: string | null) => (
    <SessionProvider session={session}>
      <ProtectedProviders>
        <LinkedIdentities
          account={account}
          currentSessionStartedAt={startedAt}
          navigate={navigate}
        />
      </ProtectedProviders>
    </SessionProvider>
  );
  const view = render(
    tree(options.startedAt === undefined ? ago(60_000) : options.startedAt),
  );
  /** The same screen, given another start time for the current session (the list that carries it can arrive after the account). */
  const startedAt = (next: string | null) => view.rerender(tree(next));
  return { session, attempts, navigate, startedAt, ...view };
}

describe("Signing in: linked accounts", () => {
  test("issuers are TEXT: the host for a URL, the clipped string otherwise; never a link, an image or markup (E-33)", () => {
    const hostile = [
      "javascript:alert(1)",
      '<img src=x onerror="alert(1)">',
      "x".repeat(200),
      IDP,
    ];
    const { container } = identities(accountOf({ oidc_issuers: hostile }));
    const rows = [...container.querySelectorAll("[data-issuer]")].map(
      (el) => el.textContent,
    );
    expect(rows[0]).toBe("javascript:alert(1)");
    expect(rows[1]).toBe('<img src=x onerror="alert(1)">');
    expect(rows[2]).toBe(`${"x".repeat(79)}…`);
    expect(rows[3]).toBe("idp.example.test");
    expect(container.querySelector("a, img, script")).toBeNull();
    expect(issuerLabel("https://a.example.org:8443/path")).toBe(
      "a.example.org:8443",
    );
  });

  test("a row says what removing does, and the five-minute rule as the reason it exists; there is no link date or provider name", () => {
    const { container } = identities(accountOf({ oidc_issuers: [IDP] }));
    expect(screen.getByText(REMOVE_CONSEQUENCE)).toBeInTheDocument();
    expect(screen.getByText(REMOVE_RULE)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/linked \d|corp-sso/i);
  });

  test("Remove sends the issuer string VERBATIM and nothing else", async () => {
    const unlinkOidc = vi.fn(async () => ({
      ok: true as const,
      value: "unlinked" as const,
    }));
    identities(accountOf({ oidc_issuers: [IDP] }), {
      operations: { unlinkOidc },
    });
    fireEvent.click(
      screen.getByRole("button", { name: `Remove idp.example.test` }),
    );
    await waitFor(() =>
      expect(unlinkOidc).toHaveBeenCalledExactlyOnceWith(IDP, WITHDRAW),
    );
  });

  test("Remove is disabled with its reason when there is no password, or the session is older than five minutes (E-31)", () => {
    const { unmount } = identities(
      accountOf({ oidc_issuers: [IDP], has_password: false }),
    );
    expect(screen.getByRole("button", { name: "Remove" })).toBeDisabled();
    expect(screen.getByText(NO_PASSWORD_REASON)).toBeInTheDocument();
    unmount();
    identities(accountOf({ oidc_issuers: [IDP] }), {
      startedAt: ago(10 * 60_000),
    });
    expect(screen.getByRole("button", { name: "Remove" })).toBeDisabled();
    expect(screen.getAllByText(STALE_REASON).length).toBeGreaterThan(0);
  });

  test("a session whose start is unknown does not block: the server decides", () => {
    identities(accountOf({ oidc_issuers: [IDP] }), { startedAt: null });
    expect(
      screen.getByRole("button", { name: `Remove idp.example.test` }),
    ).toBeEnabled();
  });

  test("a refusal shows the wireframe's 'can't remove' paragraph under that row", async () => {
    identities(accountOf({ oidc_issuers: [IDP] }), {
      operations: {
        unlinkOidc: vi.fn(async () => ({
          ok: false as const,
          error: "http" as const,
          status: 409,
        })),
      },
    });
    fireEvent.click(
      screen.getByRole("button", { name: `Remove idp.example.test` }),
    );
    expect(
      await screen.findByText(MESSAGE_TEXT.unlink_refused),
    ).toBeInTheDocument();
    expect(MESSAGE_TEXT.unlink_refused).toMatch(
      /^Can't remove this identity: .* requires a session created within the last five minutes and a local password/,
    );
  });

  test("a lost response is UNCONFIRMED, never retried", async () => {
    const unlinkOidc = vi.fn(async () => ({
      ok: false as const,
      error: "offline" as const,
    }));
    identities(accountOf({ oidc_issuers: [IDP] }), {
      operations: { unlinkOidc },
    });
    fireEvent.click(
      screen.getByRole("button", { name: `Remove idp.example.test` }),
    );
    expect(
      await screen.findByText(MESSAGE_TEXT.unconfirmed),
    ).toBeInTheDocument();
    expect(unlinkOidc).toHaveBeenCalledTimes(1);
  });

  test("a lost unlink stays UNCONFIRMED after a check finds the session working: that is not proof it failed (review R3)", async () => {
    const unlinkOidc = vi.fn(async () => ({
      ok: false as const,
      error: "offline" as const,
    }));
    const readAccount = vi.fn(async () => ({
      ok: true as const,
      value: accountOf({ oidc_issuers: [IDP] }),
    }));
    identities(accountOf({ oidc_issuers: [IDP] }), {
      operations: { unlinkOidc, readAccount },
    });
    fireEvent.click(
      screen.getByRole("button", { name: `Remove idp.example.test` }),
    );
    await screen.findByText(MESSAGE_TEXT.unconfirmed);
    fireEvent.click(screen.getByRole("button", { name: "Check now" }));
    expect(
      await screen.findAllByText(MESSAGE_TEXT.still_unconfirmed),
    ).not.toHaveLength(0);
    expect(screen.getByText(MESSAGE_TEXT.unconfirmed)).toBeVisible();
    expect(document.body.textContent).not.toMatch(
      /nothing changed|didn't go through/i,
    );
    expect(readAccount).toHaveBeenCalledTimes(1);
    expect(unlinkOidc).toHaveBeenCalledTimes(1);
  });

  // WF-SETTINGS-03 states.md "Removed": the consequence is disclosed BEFORE Remove, "associated with the button via
  // aria-describedby", on mobile as well as desktop. axe does not check that the association exists (review R4).
  test.each([
    ["desktop", 1280],
    ["mobile", 320],
  ])(
    "Remove is DESCRIBED by the sign-out consequence on %s (review R4)",
    (_name, width) => {
      installMatchMedia({ width });
      identities(
        accountOf({ oidc_issuers: [IDP, "https://other.example.org"] }),
      );
      const consequence = document.querySelector("[data-remove-consequence]");
      expect(consequence).not.toBeNull();
      expect(consequence).toHaveTextContent(REMOVE_CONSEQUENCE);
      for (const name of [
        "Remove idp.example.test",
        "Remove other.example.org",
      ]) {
        const button = screen.getByRole("button", { name });
        expect(button).toBeEnabled();
        expect(button).toHaveAccessibleDescription(REMOVE_CONSEQUENCE);
        expect(button.getAttribute("aria-describedby")?.split(" ")).toContain(
          consequence?.id,
        );
      }
    },
  );

  test("a disabled Remove keeps its reason AND is described by the consequence (review R4)", () => {
    identities(accountOf({ oidc_issuers: [IDP], has_password: false }));
    const button = screen.getByRole("button", { name: "Remove" });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(
      `${NO_PASSWORD_REASON} ${REMOVE_CONSEQUENCE}`,
    );
  });

  test("with nothing linked there is no Remove and no dangling description", () => {
    identities(accountOf());
    expect(screen.queryByRole("button", { name: /^Remove/ })).toBeNull();
    expect(document.querySelector("[data-remove-consequence]")).toBeNull();
  });

  test("Link single sign-on begins an `oidc_link` attempt and navigates only after the module returns the redirect", async () => {
    const { attempts, navigate } = identities(accountOf());
    fireEvent.click(
      screen.getByRole("button", { name: "Link single sign-on" }),
    );
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledExactlyOnceWith(
        "https://idp.example.test/authorize",
      ),
    );
    expect(attempts.begin).toHaveBeenCalledWith("oidc_link");
  });

  test("Link is disabled with its reason when the session is older than five minutes", () => {
    const { attempts } = identities(accountOf(), {
      startedAt: ago(10 * 60_000),
    });
    expect(
      screen.getByRole("button", { name: "Link single sign-on" }),
    ).toBeDisabled();
    expect(attempts.begin).not.toHaveBeenCalled();
  });

  test("Link where single sign-on is not set up: a plain message, no navigation", async () => {
    const { navigate } = identities(accountOf(), {
      attempts: attemptsDouble({
        startOidc: vi.fn(async () => ({
          kind: "refused" as const,
          status: 404,
          error: { code: "not_found", message: "x", request_id: "r" },
        })),
      }),
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Link single sign-on" }),
    );
    expect(
      await screen.findByText(MESSAGE_TEXT.sso_not_set_up, { exact: false }),
    ).toHaveTextContent(`${MESSAGE_TEXT.sso_not_set_up} Request ID: r`);
    expect(navigate).not.toHaveBeenCalled();
  });

  test("an account with nothing linked says so and offers Link", () => {
    identities(accountOf());
    expect(
      screen.getByText("No single sign-on is linked to this account."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Remove/ })).toBeNull();
  });
});

describe("Signing in: acts on nothing it did not load", () => {
  test("act wrapper sanity: the dialog route is reachable through the registry", async () => {
    const { router } = await open();
    await act(async () => undefined);
    expect(router.state.location.pathname).toBe("/settings/signing-in");
  });
});

/**
 * Review R6. A gateway can answer 502 or 504 AFTER the backend committed a credential change and revoked the session, and a
 * server can fail while it commits: no 5xx shows that the change was not made. Only a 4xx does (the kernel's own rule for the
 * sign-in exchange, `classifyActivation`). The first group of tests below is the pure rule; the others run the real forms.
 */
describe("Signing in: an answer that cannot show the change was not made is UNCONFIRMED (review R6)", () => {
  const http = (status: number | undefined): Result<unknown> => ({
    ok: false,
    error: "http",
    ...(status === undefined ? {} : { status }),
  });
  test.each<[string, Result<unknown>, boolean]>([
    ["a success", { ok: true, value: "changed" }, false],
    ["no answer (offline)", { ok: false, error: "offline" }, true],
    ["a session that ended", { ok: false, error: "auth_state" }, false],
    ["an identity that moved on", { ok: false, error: "closed" }, false],
    ["a request that was not sent", { ok: false, error: "not_sent" }, false],
    ...[400, 401, 403, 404, 409, 422, 429, 499].map(
      (status): [string, Result<unknown>, boolean] => [
        `a ${status} refusal`,
        http(status),
        false,
      ],
    ),
    ...[500, 502, 503, 504, 520, 599].map(
      (status): [string, Result<unknown>, boolean] => [
        `a ${status}`,
        http(status),
        true,
      ],
    ),
    ["a status below 400", http(304), true],
    ["an http failure with no status", http(undefined), true],
  ])("%s: unknown = %s", (_name, result, unknown) => {
    expect(leavesOutcomeUnknown(result)).toBe(unknown);
  });

  test.each([500, 502, 503, 504])(
    "a password change answered %i is UNCONFIRMED, not 'try again shortly': both passwords are cleared, nothing is sent again",
    async (status) => {
      const changePassword = vi.fn(async () => ({
        ok: false as const,
        error: "http" as const,
        status,
      }));
      const { dialog } = await open({ changePassword });
      await within(dialog).findByLabelText("Current password");
      fillPasswords(dialog, "old-password", "brand-new-password");
      submitPassword(dialog);
      expect(
        await within(dialog).findByText(MESSAGE_TEXT.unconfirmed),
      ).toBeInTheDocument();
      for (const text of [
        MESSAGE_TEXT.temporarily_unavailable,
        MESSAGE_TEXT.generic,
      ])
        expect(within(dialog).queryByText(text)).toBeNull();
      expect(dialog.querySelector("[data-error]")).toBeNull();
      expect(within(dialog).getByLabelText("Current password")).toHaveValue("");
      expect(within(dialog).getByLabelText("New password")).toHaveValue("");
      expect(
        within(dialog).getByRole("button", { name: "Check now" }),
      ).toBeEnabled();
      expect(changePassword).toHaveBeenCalledTimes(1);
    },
  );

  test("a password change that COMMITTED and was answered 502: 'Check now' finds the session gone; no claim, no retry", async () => {
    let committed = false;
    const changePassword = vi.fn(async () => {
      committed = true;
      return { ok: false as const, error: "http" as const, status: 502 };
    });
    const readAccount = vi.fn(async () =>
      committed
        ? { ok: false as const, error: "auth_state" as const }
        : { ok: true as const, value: accountOf() },
    );
    const { dialog } = await open({ changePassword, readAccount });
    await within(dialog).findByLabelText("Current password");
    fillPasswords(dialog, "old-password", "brand-new-password");
    submitPassword(dialog);
    await within(dialog).findByText(MESSAGE_TEXT.unconfirmed);
    const before = readAccount.mock.calls.length;
    fireEvent.click(within(dialog).getByRole("button", { name: "Check now" }));
    await waitFor(() => expect(readAccount.mock.calls.length).toBe(before + 1));
    await waitFor(() =>
      expect(
        within(dialog).getByRole("button", { name: "Check now" }),
      ).toBeEnabled(),
    );
    expect(
      within(dialog).queryByText(MESSAGE_TEXT.still_unconfirmed),
    ).toBeNull();
    expect(dialog.textContent).not.toMatch(
      /nothing changed|didn't go through|try again shortly/i,
    );
    expect(changePassword).toHaveBeenCalledTimes(1);
  });

  test("a 502 followed by a SUCCESSFUL account read is still unconfirmed: a working session is not proof (review R3 holds for this entry path)", async () => {
    const changePassword = vi.fn(async () => ({
      ok: false as const,
      error: "http" as const,
      status: 502,
    }));
    const { dialog } = await open({ changePassword });
    await within(dialog).findByLabelText("Current password");
    fillPasswords(dialog, "old-password", "brand-new-password");
    submitPassword(dialog);
    await within(dialog).findByText(MESSAGE_TEXT.unconfirmed);
    fireEvent.click(within(dialog).getByRole("button", { name: "Check now" }));
    expect(
      (await within(dialog).findAllByText(MESSAGE_TEXT.still_unconfirmed))
        .length,
    ).toBeGreaterThan(0);
    expect(within(dialog).getByText(MESSAGE_TEXT.unconfirmed)).toBeVisible();
    expect(dialog.textContent).not.toMatch(
      /nothing changed|didn't go through|try again shortly/i,
    );
    expect(changePassword).toHaveBeenCalledTimes(1);
  });

  test.each([500, 502, 503, 504])(
    "an unlink answered %i is UNCONFIRMED, not 'Can't remove this identity'; it is never retried",
    async (status) => {
      const unlinkOidc = vi.fn(async () => ({
        ok: false as const,
        error: "http" as const,
        status,
      }));
      identities(accountOf({ oidc_issuers: [IDP] }), {
        operations: { unlinkOidc },
      });
      fireEvent.click(
        screen.getByRole("button", { name: "Remove idp.example.test" }),
      );
      expect(
        await screen.findByText(MESSAGE_TEXT.unconfirmed),
      ).toBeInTheDocument();
      expect(screen.queryByText(MESSAGE_TEXT.unlink_refused)).toBeNull();
      expect(document.querySelector("[data-error]")).toBeNull();
      expect(screen.getByRole("button", { name: "Check now" })).toBeEnabled();
      expect(unlinkOidc).toHaveBeenCalledTimes(1);
    },
  );

  test("an unlink that COMMITTED and was answered 502: 'Check now' finds the session gone; no claim, no retry", async () => {
    let committed = false;
    const unlinkOidc = vi.fn(async () => {
      committed = true;
      return { ok: false as const, error: "http" as const, status: 502 };
    });
    const readAccount = vi.fn(async () =>
      committed
        ? { ok: false as const, error: "auth_state" as const }
        : { ok: true as const, value: accountOf({ oidc_issuers: [IDP] }) },
    );
    identities(accountOf({ oidc_issuers: [IDP] }), {
      operations: { unlinkOidc, readAccount },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Remove idp.example.test" }),
    );
    await screen.findByText(MESSAGE_TEXT.unconfirmed);
    fireEvent.click(screen.getByRole("button", { name: "Check now" }));
    await waitFor(() => expect(readAccount).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Check now" })).toBeEnabled(),
    );
    expect(screen.queryByText(MESSAGE_TEXT.still_unconfirmed)).toBeNull();
    expect(document.body.textContent).not.toMatch(
      /nothing changed|didn't go through|can't remove this identity/i,
    );
    expect(unlinkOidc).toHaveBeenCalledTimes(1);
  });

  test.each([400, 403, 404, 409, 422, 429])(
    "an unlink refused with %i is a REFUSAL (a 4xx shows it was not made): the wireframe's paragraph, no unconfirmed state",
    async (status) => {
      identities(accountOf({ oidc_issuers: [IDP] }), {
        operations: {
          unlinkOidc: vi.fn(async () => ({
            ok: false as const,
            error: "http" as const,
            status,
          })),
        },
      });
      fireEvent.click(
        screen.getByRole("button", { name: "Remove idp.example.test" }),
      );
      expect(
        await screen.findByText(MESSAGE_TEXT.unlink_refused),
      ).toBeInTheDocument();
      expect(screen.queryByText(MESSAGE_TEXT.unconfirmed)).toBeNull();
      expect(screen.queryByRole("button", { name: "Check now" })).toBeNull();
    },
  );
});

/**
 * Review R7. Credential operations are online-only: while the browser reports no connection the controls are disabled with a
 * reason beside them instead of failing on press (WF-SETTINGS-03; ia.md, "Unavailable online-only actions are visibly
 * disabled"). The report is a hint: a request that starts online is judged by its answer, and the handlers refuse to send on the
 * browser's own word even in the moment before the `offline` event has been handled.
 */
describe("Signing in: connection-required controls are disabled while offline (review R7)", () => {
  const changeButton = (dialog: HTMLElement) =>
    within(dialog).getByRole("button", { name: "Change password" });

  test("Change password: the dialog is already open and the connection is lost: disabled with its reason, what was typed is kept, nothing is sent, and it works again on return", async () => {
    const { dialog, session } = await open();
    await within(dialog).findByLabelText("Current password");
    fillPasswords(dialog, "old-password", "brand-new-password");
    expect(changeButton(dialog)).toBeEnabled();
    await goOffline();
    expect(changeButton(dialog)).toBeDisabled();
    expect(changeButton(dialog)).toHaveAccessibleDescription(
      PASSWORD_OFFLINE_REASON,
    );
    expect(within(dialog).getByText(PASSWORD_OFFLINE_REASON)).toBeVisible();
    // Activation by any route sends nothing and loses nothing: the button, and the form's own submit event.
    fireEvent.click(changeButton(dialog));
    const form = dialog.querySelector("form") as HTMLFormElement;
    fireEvent.submit(form);
    expect(session.operations.changePassword).not.toHaveBeenCalled();
    expect(within(dialog).getByLabelText("Current password")).toHaveValue(
      "old-password",
    );
    expect(within(dialog).getByLabelText("New password")).toHaveValue(
      "brand-new-password",
    );
    expect(dialog.querySelector("[data-error]")).toBeNull();
    await goOnline();
    expect(changeButton(dialog)).toBeEnabled();
    expect(
      within(dialog).queryByText(PASSWORD_OFFLINE_REASON),
    ).not.toBeInTheDocument();
    submitPassword(dialog);
    await waitFor(() =>
      expect(session.operations.changePassword).toHaveBeenCalledExactlyOnceWith(
        { current: "old-password", next: "brand-new-password" },
        WITHDRAW,
      ),
    );
  });

  test("Change password: a dialog that opens while offline is disabled from its first paint", async () => {
    setOnline(false);
    const { dialog, session } = await open();
    await within(dialog).findByLabelText("Current password");
    expect(changeButton(dialog)).toBeDisabled();
    expect(within(dialog).getByText(PASSWORD_OFFLINE_REASON)).toBeVisible();
    fillPasswords(dialog, "old-password", "brand-new-password");
    fireEvent.submit(dialog.querySelector("form") as HTMLFormElement);
    expect(session.operations.changePassword).not.toHaveBeenCalled();
  });

  test("Change password: the handler asks the browser too, so an activation before the offline event is handled sends nothing", async () => {
    const { dialog, session } = await open();
    await within(dialog).findByLabelText("Current password");
    fillPasswords(dialog, "old-password", "brand-new-password");
    // The connection has gone but the page has not been told yet: the control still looks enabled.
    setOnline(false);
    expect(changeButton(dialog)).toBeEnabled();
    submitPassword(dialog);
    expect(session.operations.changePassword).not.toHaveBeenCalled();
    expect(within(dialog).getByLabelText("New password")).toHaveValue(
      "brand-new-password",
    );
    expect(dialog.querySelector("[data-error]")).toBeNull();
  });

  test("Change password: a request that started online is judged by its ANSWER when the connection drops: the busy reason stays, a real refusal is shown", async () => {
    let answer: (result: Result<"changed">) => void = () => undefined;
    const changePassword = vi.fn(
      () =>
        new Promise<Result<"changed">>((resolve) => {
          answer = resolve;
        }),
    );
    const { dialog } = await open({ changePassword });
    await within(dialog).findByLabelText("Current password");
    fillPasswords(dialog, "old-password", "brand-new-password");
    submitPassword(dialog);
    expect(
      await within(dialog).findByText("Changing your password…"),
    ).toBeVisible();
    await goOffline();
    // The request is on the wire: that is what the screen says, not that a connection is needed.
    expect(within(dialog).getByText("Changing your password…")).toBeVisible();
    expect(
      within(dialog).queryByText(PASSWORD_OFFLINE_REASON),
    ).not.toBeInTheDocument();
    await act(async () => {
      answer({ ok: false, error: "http", status: 422 });
    });
    expect(
      await within(dialog).findByText(MESSAGE_TEXT.check_details),
    ).toBeInTheDocument();
    // Settled, and still offline: now the connection is the reason.
    expect(within(dialog).getByText(PASSWORD_OFFLINE_REASON)).toBeVisible();
    expect(changeButton(dialog)).toBeDisabled();
    await goOnline();
    expect(changeButton(dialog)).toBeEnabled();
  });

  test("Change password: a request that started online and lost its answer is UNCONFIRMED, and 'Check now' waits for the connection", async () => {
    let answer: (result: Result<"changed">) => void = () => undefined;
    const changePassword = vi.fn(
      () =>
        new Promise<Result<"changed">>((resolve) => {
          answer = resolve;
        }),
    );
    const readAccount = vi.fn(async () => ({
      ok: true as const,
      value: accountOf(),
    }));
    const { dialog } = await open({ changePassword, readAccount });
    await within(dialog).findByLabelText("Current password");
    fillPasswords(dialog, "old-password", "brand-new-password");
    submitPassword(dialog);
    await within(dialog).findByText("Changing your password…");
    await goOffline();
    await act(async () => {
      answer({ ok: false, error: "offline" });
    });
    expect(
      await within(dialog).findByText(MESSAGE_TEXT.unconfirmed),
    ).toBeInTheDocument();
    const loads = readAccount.mock.calls.length;
    const check = () =>
      within(dialog).getByRole("button", { name: "Check now" });
    expect(check()).toBeDisabled();
    expect(check()).toHaveAccessibleDescription(CHECK_OFFLINE_REASON);
    expect(within(dialog).getByText(CHECK_OFFLINE_REASON)).toBeVisible();
    fireEvent.click(check());
    expect(readAccount.mock.calls.length).toBe(loads);
    await goOnline();
    expect(check()).toBeEnabled();
    fireEvent.click(check());
    await waitFor(() => expect(readAccount.mock.calls.length).toBe(loads + 1));
    expect(changePassword).toHaveBeenCalledTimes(1);
  });

  test("'Check now' asks the browser too: a press before the offline event is handled asks nothing", async () => {
    const readAccount = vi.fn(async () => ({
      ok: true as const,
      value: accountOf(),
    }));
    const { dialog } = await open({
      readAccount,
      changePassword: vi.fn(async () => ({
        ok: false as const,
        error: "offline" as const,
      })),
    });
    await within(dialog).findByLabelText("Current password");
    fillPasswords(dialog, "old-password", "brand-new-password");
    submitPassword(dialog);
    await within(dialog).findByText(MESSAGE_TEXT.unconfirmed);
    const loads = readAccount.mock.calls.length;
    // The connection has gone but the page has not been told yet: the button still looks enabled.
    setOnline(false);
    const check = within(dialog).getByRole("button", { name: "Check now" });
    expect(check).toBeEnabled();
    fireEvent.click(check);
    expect(readAccount.mock.calls.length).toBe(loads);
    expect(within(dialog).queryByText(/We couldn't check either/)).toBeNull();
    expect(within(dialog).queryByText("Checking…")).toBeNull();
  });

  test("Remove and Link single sign-on: disabled with their reasons, Remove still described by its consequence; they come back with the connection", async () => {
    const unlinkOidc = vi.fn(async () => ({
      ok: true as const,
      value: "unlinked" as const,
    }));
    const { attempts } = identities(accountOf({ oidc_issuers: [IDP] }), {
      operations: { unlinkOidc },
    });
    expect(
      screen.getByRole("button", { name: "Remove idp.example.test" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Link single sign-on" }),
    ).toBeEnabled();
    await goOffline();
    const remove = screen.getByRole("button", { name: "Remove" });
    expect(remove).toBeDisabled();
    expect(remove).toHaveAccessibleDescription(
      `${REMOVE_OFFLINE_REASON} ${REMOVE_CONSEQUENCE}`,
    );
    expect(screen.getByText(REMOVE_OFFLINE_REASON)).toBeVisible();
    const link = screen.getByRole("button", { name: "Link single sign-on" });
    expect(link).toBeDisabled();
    expect(link).toHaveAccessibleDescription(LINK_OFFLINE_REASON);
    expect(screen.getByText(LINK_OFFLINE_REASON)).toBeVisible();
    fireEvent.click(remove);
    fireEvent.click(link);
    expect(unlinkOidc).not.toHaveBeenCalled();
    expect(attempts.begin).not.toHaveBeenCalled();
    await goOnline();
    expect(
      screen.getByRole("button", { name: "Remove idp.example.test" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Link single sign-on" }),
    ).toBeEnabled();
    expect(screen.queryByText(REMOVE_OFFLINE_REASON)).toBeNull();
    expect(screen.queryByText(LINK_OFFLINE_REASON)).toBeNull();
  });

  test("Remove and Link: the handlers ask the browser too, so an activation before the offline event is handled sends nothing", async () => {
    const unlinkOidc = vi.fn(async () => ({
      ok: true as const,
      value: "unlinked" as const,
    }));
    const { attempts, navigate } = identities(
      accountOf({ oidc_issuers: [IDP] }),
      { operations: { unlinkOidc } },
    );
    setOnline(false);
    const remove = screen.getByRole("button", {
      name: "Remove idp.example.test",
    });
    const link = screen.getByRole("button", { name: "Link single sign-on" });
    expect(remove).toBeEnabled();
    expect(link).toBeEnabled();
    fireEvent.click(remove);
    fireEvent.click(link);
    expect(unlinkOidc).not.toHaveBeenCalled();
    expect(attempts.begin).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    // Nothing started, so nothing is shown as under way.
    expect(screen.queryByText("Removing…")).toBeNull();
    expect(screen.queryByText("Opening your provider…")).toBeNull();
    setOnline(true);
    fireEvent.click(remove);
    await waitFor(() =>
      expect(unlinkOidc).toHaveBeenCalledExactlyOnceWith(IDP, WITHDRAW),
    );
  });

  test("a removal that started online is judged by its answer when the connection drops", async () => {
    let answer: (result: Result<"unlinked">) => void = () => undefined;
    const unlinkOidc = vi.fn(
      () =>
        new Promise<Result<"unlinked">>((resolve) => {
          answer = resolve;
        }),
    );
    identities(accountOf({ oidc_issuers: [IDP] }), {
      operations: { unlinkOidc },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Remove idp.example.test" }),
    );
    expect(await screen.findByText("Removing…")).toBeVisible();
    await goOffline();
    expect(screen.getByText("Removing…")).toBeVisible();
    await act(async () => {
      answer({ ok: false, error: "http", status: 409 });
    });
    expect(
      await screen.findByText(MESSAGE_TEXT.unlink_refused),
    ).toBeInTheDocument();
    expect(screen.getByText(REMOVE_OFFLINE_REASON)).toBeVisible();
  });

  test("offline, the connection is the reason shown; the other reason is there when it returns (no password; an old session)", async () => {
    const { unmount } = identities(
      accountOf({ oidc_issuers: [IDP], has_password: false }),
    );
    await goOffline();
    expect(screen.getByText(REMOVE_OFFLINE_REASON)).toBeVisible();
    expect(screen.queryByText(NO_PASSWORD_REASON)).toBeNull();
    await goOnline();
    expect(screen.getByText(NO_PASSWORD_REASON)).toBeVisible();
    unmount();
    identities(accountOf({ oidc_issuers: [IDP] }), {
      startedAt: ago(10 * 60_000),
    });
    await goOffline();
    expect(screen.getByText(REMOVE_OFFLINE_REASON)).toBeVisible();
    expect(screen.getByText(LINK_OFFLINE_REASON)).toBeVisible();
    expect(screen.queryByText(STALE_REASON)).toBeNull();
    await goOnline();
    expect(screen.getAllByText(STALE_REASON)).toHaveLength(2);
  });

  test("no axe violations while offline (the reasons are real descriptions)", async () => {
    const { dialog } = await open({
      readAccount: vi.fn(async () => ({
        ok: true as const,
        value: accountOf({ oidc_issuers: [IDP] }),
      })),
    });
    await within(dialog).findByLabelText("Current password");
    await goOffline();
    expect((await axe(document.body)).violations).toEqual([]);
  });
});

/**
 * Review R8. The five-minute window is a property of the clock, not of the render that first read it: a screen that is opened
 * soon after signing in and left open must stop offering Remove and Link when the window ends, and a handler must not rely on
 * that having happened. `ago(60_000)` is a session one minute old, so it is fresh for another 3 min 30 s (5 min less the 30 s
 * margin). Fake timers move the clock and the timers together; `vi.setSystemTime` moves ONLY the clock (the pending timer keeps
 * its distance), which is how a late or suspended timer is reproduced.
 */
describe("Signing in: the five-minute window ends while the screen stays open (review R8)", () => {
  const OPEN_FOR_MS = 210_000;
  const removeRow = () =>
    screen.getByRole("button", { name: "Remove idp.example.test" });
  const link = () => screen.getByRole("button", { name: LINK_LABEL });
  const advance = (ms: number) =>
    act(async () => {
      vi.advanceTimersByTime(ms);
    });

  test("both controls are enabled while the window is open and disable themselves, with the visible reason and without a remount, the moment it ends", async () => {
    vi.useFakeTimers();
    const { container } = identities(accountOf({ oidc_issuers: [IDP] }));
    const section = container.querySelector("[data-linked]");
    expect(section).not.toBeNull();
    expect(removeRow()).toBeEnabled();
    expect(link()).toBeEnabled();
    expect(screen.queryByText(STALE_REASON)).toBeNull();

    await advance(OPEN_FOR_MS - 1);
    expect(removeRow()).toBeEnabled();
    expect(link()).toBeEnabled();
    expect(screen.queryByText(STALE_REASON)).toBeNull();

    await advance(1);
    // The section is the one that was open: nothing was remounted, typed or pressed.
    expect(container.querySelector("[data-linked]")).toBe(section);
    const remove = screen.getByRole("button", { name: "Remove" });
    expect(remove).toBeDisabled();
    expect(link()).toBeDisabled();
    expect(screen.getAllByText(STALE_REASON)).toHaveLength(2);
    expect(remove).toHaveAccessibleDescription(
      `${STALE_REASON} ${REMOVE_CONSEQUENCE}`,
    );
    expect(link()).toHaveAccessibleDescription(STALE_REASON);
  });

  test("an expired window is not a connection problem: the connection's reason still comes first, and the expiry shows when it returns", async () => {
    vi.useFakeTimers();
    identities(accountOf({ oidc_issuers: [IDP] }));
    await goOffline();
    await advance(OPEN_FOR_MS);
    expect(screen.getByText(REMOVE_OFFLINE_REASON)).toBeVisible();
    expect(screen.getByText(LINK_OFFLINE_REASON)).toBeVisible();
    expect(screen.queryByText(STALE_REASON)).toBeNull();
    await goOnline();
    expect(screen.getAllByText(STALE_REASON)).toHaveLength(2);
    expect(link()).toBeDisabled();
  });

  test("Remove: an activation after the window ended, before any timer has run, starts nothing and shows why", async () => {
    vi.useFakeTimers();
    const unlinkOidc = vi.fn(async () => ({
      ok: true as const,
      value: "unlinked" as const,
    }));
    identities(accountOf({ oidc_issuers: [IDP] }), {
      operations: { unlinkOidc },
    });
    const remove = removeRow();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    // The clock passes the deadline; the timer is late (a suspended device, a hidden tab) and has not run.
    vi.setSystemTime(Date.now() + OPEN_FOR_MS + 1_000);
    expect(remove).toBeEnabled();
    fireEvent.click(remove);
    expect(unlinkOidc).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Remove" })).toBeDisabled();
    expect(screen.getAllByText(STALE_REASON)).toHaveLength(2);
    expect(document.querySelector("[data-error]")).toBeNull();
    expect(document.querySelector("[data-unconfirmed]")).toBeNull();
  });

  test("Link: an activation after the window ended, before any timer has run, starts nothing and shows why", async () => {
    vi.useFakeTimers();
    const { attempts, navigate } = identities(accountOf());
    const linkButton = link();
    vi.setSystemTime(Date.now() + OPEN_FOR_MS + 1_000);
    expect(linkButton).toBeEnabled();
    fireEvent.click(linkButton);
    expect(attempts.begin).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(link()).toBeDisabled();
    expect(screen.getByText(STALE_REASON)).toBeVisible();
  });

  test("an activation the instant before the deadline is still allowed: the server decides from there", async () => {
    vi.useFakeTimers();
    const unlinkOidc = vi.fn(async () => ({
      ok: true as const,
      value: "unlinked" as const,
    }));
    identities(accountOf({ oidc_issuers: [IDP] }), {
      operations: { unlinkOidc },
    });
    vi.setSystemTime(Date.now() + OPEN_FOR_MS - 1);
    fireEvent.click(removeRow());
    await act(async () => undefined);
    expect(unlinkOidc).toHaveBeenCalledExactlyOnceWith(IDP, WITHDRAW);
  });

  test("a timer that runs before the clock says the window has ended is not trusted: it waits for what remains", async () => {
    vi.useFakeTimers();
    identities(accountOf({ oidc_issuers: [IDP] }));
    // The clock is set back two minutes; the timer keeps its distance, so it runs while the window is still open.
    vi.setSystemTime(Date.now() - 120_000);
    await advance(OPEN_FOR_MS);
    expect(removeRow()).toBeEnabled();
    expect(screen.queryByText(STALE_REASON)).toBeNull();
    await advance(120_000 - 1);
    expect(removeRow()).toBeEnabled();
    await advance(1);
    expect(screen.getByRole("button", { name: "Remove" })).toBeDisabled();
    expect(link()).toBeDisabled();
  });

  test("a session start that could not be read never expires: the server decides, and no timer is held", async () => {
    vi.useFakeTimers();
    identities(accountOf({ oidc_issuers: [IDP] }), { startedAt: null });
    expect(vi.getTimerCount()).toBe(0);
    await advance(60 * 60_000);
    expect(removeRow()).toBeEnabled();
    expect(link()).toBeEnabled();
    expect(screen.queryByText(STALE_REASON)).toBeNull();
  });

  test("a start time that arrives after the screen is open (the sessions list can be slower than the account) is scheduled when it does", async () => {
    vi.useFakeTimers();
    const { startedAt } = identities(accountOf({ oidc_issuers: [IDP] }), {
      startedAt: null,
    });
    await advance(60_000);
    expect(removeRow()).toBeEnabled();
    expect(vi.getTimerCount()).toBe(0);
    act(() => startedAt(ago(60_000)));
    expect(vi.getTimerCount()).toBe(1);
    await advance(OPEN_FOR_MS - 1);
    expect(removeRow()).toBeEnabled();
    await advance(1);
    expect(screen.getByRole("button", { name: "Remove" })).toBeDisabled();
    expect(link()).toBeDisabled();
    // And one that is already over when it arrives disables at once, with nothing left to wait for.
    act(() => startedAt(null));
    expect(removeRow()).toBeEnabled();
    act(() => startedAt(ago(10 * 60_000)));
    expect(screen.getByRole("button", { name: "Remove" })).toBeDisabled();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("a window that had already ended when the screen opened holds no timer and stays disabled", async () => {
    vi.useFakeTimers();
    identities(accountOf({ oidc_issuers: [IDP] }), {
      startedAt: ago(10 * 60_000),
    });
    expect(vi.getTimerCount()).toBe(0);
    expect(screen.getByRole("button", { name: "Remove" })).toBeDisabled();
    expect(link()).toBeDisabled();
    await advance(60 * 60_000);
    expect(screen.getAllByText(STALE_REASON)).toHaveLength(2);
  });

  test("a session start far in the future (a clock set back) is waited for in steps a timer can honour, not fired at once", async () => {
    vi.useFakeTimers();
    const delays: number[] = [];
    const armed = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      handler: () => void,
      delay?: number,
    ) => {
      delays.push(delay ?? 0);
      return armed(handler, delay);
    }) as typeof setTimeout);
    const forty = 40 * 24 * 3_600_000;
    identities(accountOf({ oidc_issuers: [IDP] }), {
      startedAt: new Date(Date.now() + forty).toISOString(),
    });
    expect(Math.max(...delays)).toBe(2 ** 31 - 1);
    await advance(1_000);
    expect(removeRow()).toBeEnabled();
    expect(vi.getTimerCount()).toBe(1);
    await advance(forty + 270_000 - 1_000 - 1);
    expect(removeRow()).toBeEnabled();
    await advance(1);
    expect(screen.getByRole("button", { name: "Remove" })).toBeDisabled();
  });

  test("leaving the screen drops the timer", () => {
    vi.useFakeTimers();
    const { unmount } = identities(accountOf({ oidc_issuers: [IDP] }));
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("in the real dialog, opened fresh and left open, Remove and Link disable at the deadline; the dialog stays, and nothing is sent", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { dialog, session } = await open({
      readAccount: vi.fn(async () => ({
        ok: true as const,
        value: accountOf({ oidc_issuers: [IDP] }),
      })),
    });
    await within(dialog).findByText("idp.example.test");
    expect(
      within(dialog).getByRole("button", { name: "Remove idp.example.test" }),
    ).toBeEnabled();
    expect(
      within(dialog).getByRole("button", { name: LINK_LABEL }),
    ).toBeEnabled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4 * 60_000);
    });
    expect(screen.getByRole("dialog", { name: "Signing in" })).toBe(dialog);
    expect(
      within(dialog).getByRole("button", { name: "Remove" }),
    ).toBeDisabled();
    expect(
      within(dialog).getByRole("button", { name: LINK_LABEL }),
    ).toBeDisabled();
    expect(within(dialog).getAllByText(STALE_REASON)).toHaveLength(2);
    expect(session.operations.unlinkOidc).not.toHaveBeenCalled();
    expect((await axe(document.body)).violations).toEqual([]);
  });
});
