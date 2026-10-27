import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ProtectedProviders } from "../../../src/app/providers";
import { returnDestination } from "../../../src/app/return-destination";
import { authFeedback } from "../../../src/features/authentication/feedback";
import { CONFIRM_LABEL } from "../../../src/features/settings/signing-in/ConfirmItsYou";
import { confirmFlow } from "../../../src/features/settings/signing-in/confirm-state";
import {
  LinkedIdentities,
  STALE_REASON,
} from "../../../src/features/settings/signing-in/LinkedIdentities";
import {
  type AccountSummary,
  type AttemptOutcome,
  SessionProvider,
} from "../../../src/session";
import { installMatchMedia } from "../../helpers/match-media";
import {
  attemptsDouble,
  sessionDouble,
  store,
} from "../../helpers/session-double";

/**
 * WEB-08c §2.3 (gap G-23): in-place SAME-account re-authentication. The username is read-only (the account's own, from the fresh
 * `GET /me`), the confirmation is an ordinary password sign-in, and a return destination brings the person back to this screen at the
 * newer epoch. The session-world counterpart (a same-account re-settlement keeps the account's data) is `tests/session/web08c-reauth.test.ts`.
 */
installMatchMedia({ width: 1440 });
const setOnline = (value: boolean) =>
  Object.defineProperty(navigator, "onLine", { value, configurable: true });
beforeEach(() => {
  returnDestination.clear();
  authFeedback.clearOnBegin();
  confirmFlow.cancel();
});
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  setOnline(true);
  returnDestination.clear();
  confirmFlow.cancel();
  await new Promise((resolve) => setTimeout(resolve, 0));
});

const IDP = "https://idp.example.test";
const account: AccountSummary = {
  id: "acct-1",
  username: "kieran",
  has_password: true,
  oidc_issuers: [IDP],
} as AccountSummary;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function mount(
  startedAt: string | null,
  outcome: AttemptOutcome = {
    kind: "settled",
    account_id: "acct",
    epoch: 2,
    method: "password",
  } as AttemptOutcome,
) {
  const attempts = attemptsDouble({
    signInWithPassword: vi.fn(async () => outcome),
  });
  const session = sessionDouble(
    {},
    {
      attempts,
      identity: store({ account_id: "acct", epoch: 1, session_id: "s1" }),
    },
  );
  const view = render(
    <SessionProvider session={session}>
      <ProtectedProviders>
        <LinkedIdentities
          account={account}
          currentSessionStartedAt={startedAt}
        />
      </ProtectedProviders>
    </SessionProvider>,
  );
  return { attempts, session, ...view };
}

describe("Confirm it's you (G-23)", () => {
  test("it is offered only while the session is too old; a fresh or unknown start offers nothing", () => {
    const fresh = mount(ago(60_000));
    expect(screen.queryByRole("button", { name: CONFIRM_LABEL })).toBeNull();
    fresh.unmount();
    const unknown = mount(null);
    expect(screen.queryByRole("button", { name: CONFIRM_LABEL })).toBeNull();
    unknown.unmount();
    mount(ago(10 * 60_000));
    expect(screen.getByRole("button", { name: CONFIRM_LABEL })).toBeEnabled();
    // The existing disabled reasons stay.
    expect(screen.getAllByText(STALE_REASON).length).toBe(2);
  });

  test("offline, nothing is offered (the offline reason is what to fix first)", () => {
    setOnline(false);
    mount(ago(10 * 60_000));
    expect(screen.queryByRole("button", { name: CONFIRM_LABEL })).toBeNull();
  });

  test("the username is the account's own and READ-ONLY; Cancel puts the control back; no axe violations", async () => {
    const { container } = mount(ago(10 * 60_000));
    fireEvent.click(screen.getByRole("button", { name: CONFIRM_LABEL }));
    const region = screen.getByRole("region", { name: CONFIRM_LABEL });
    const username = within(region).getByRole("textbox", { name: "Username" });
    expect(username).toHaveValue("kieran");
    expect(username).toHaveAttribute("readonly");
    expect((await axe(container)).violations).toEqual([]);
    fireEvent.click(within(region).getByRole("button", { name: "Cancel" }));
    expect(
      screen.getByRole("button", { name: CONFIRM_LABEL }),
    ).toBeInTheDocument();
  });

  test("confirming signs in as THIS account (whatever the field holds) and records the return to this screen for a newer epoch", async () => {
    const { attempts } = mount(ago(10 * 60_000));
    fireEvent.click(screen.getByRole("button", { name: CONFIRM_LABEL }));
    const region = screen.getByRole("region", { name: CONFIRM_LABEL });
    // A read-only field cannot be typed into by a person; a script that changes it changes nothing that is sent.
    fireEvent.change(
      within(region).getByRole("textbox", { name: "Username" }),
      {
        target: { value: "mallory" },
      },
    );
    fireEvent.change(within(region).getByLabelText("Password"), {
      target: { value: "correct-horse-battery-9271" },
    });
    fireEvent.click(
      within(region).getByRole("button", { name: CONFIRM_LABEL }),
    );
    await waitFor(() => expect(attempts.signInWithPassword).toHaveBeenCalled());
    expect(attempts.begin).toHaveBeenCalledWith("password");
    expect(attempts.signInWithPassword).toHaveBeenCalledWith(
      expect.anything(),
      {
        username: "kieran",
        password: "correct-horse-battery-9271",
      },
    );
    expect(returnDestination.peek()).toMatchObject({
      account: "acct",
      epoch: 1,
      when: "newer",
      path: "/settings/signing-in",
      focusKey: "link-sso",
    });
  });

  test("an indeterminate activation keeps the destination until a later same-account settlement", async () => {
    const { attempts } = mount(ago(10 * 60_000), { kind: "gating" });
    fireEvent.click(screen.getByRole("button", { name: CONFIRM_LABEL }));
    const region = screen.getByRole("region", { name: CONFIRM_LABEL });
    fireEvent.change(within(region).getByLabelText("Password"), {
      target: { value: "correct-horse-battery-9271" },
    });
    fireEvent.click(
      within(region).getByRole("button", { name: CONFIRM_LABEL }),
    );
    await waitFor(() => expect(attempts.signInWithPassword).toHaveBeenCalled());
    await waitFor(() =>
      expect(within(region).getByLabelText("Password")).toHaveValue(""),
    );
    expect(returnDestination.take("acct", 1, Date.now())).toBeNull();
    expect(returnDestination.take("acct", 2, Date.now())).toMatchObject({
      path: "/settings/signing-in",
      focusKey: "link-sso",
    });
    expect(returnDestination.take("acct", 2, Date.now())).toBeNull();
  });

  test("a refusal is shown under the password and leaves no return destination", async () => {
    mount(ago(10 * 60_000), {
      kind: "refused",
      error: { code: "unauthenticated", message: "x" },
      definitive: true,
      stage: "exchange",
    } as AttemptOutcome);
    fireEvent.click(screen.getByRole("button", { name: CONFIRM_LABEL }));
    const region = screen.getByRole("region", { name: CONFIRM_LABEL });
    fireEvent.change(within(region).getByLabelText("Password"), {
      target: { value: "wrong-horse-battery-9271" },
    });
    fireEvent.click(
      within(region).getByRole("button", { name: CONFIRM_LABEL }),
    );
    expect(
      await within(region).findByText("That username or password isn't right."),
    ).toBeInTheDocument();
    expect(returnDestination.peek()).toBeNull();
    expect(authFeedback.carriedFailure()).toBeNull();
  });

  // WEB-08c R1/R2/R3 of the review of 11 October 2026.
  async function confirmHeld() {
    let answer: (outcome: AttemptOutcome) => void = () => undefined;
    const { attempts, session } = mount(ago(10 * 60_000));
    vi.mocked(attempts.signInWithPassword).mockImplementation(
      () =>
        new Promise<AttemptOutcome>((resolve) => {
          answer = resolve;
        }),
    );
    fireEvent.click(screen.getByRole("button", { name: CONFIRM_LABEL }));
    const region = screen.getByRole("region", { name: CONFIRM_LABEL });
    fireEvent.change(within(region).getByLabelText("Password"), {
      target: { value: "correct-horse-battery-9271" },
    });
    fireEvent.click(
      within(region).getByRole("button", { name: CONFIRM_LABEL }),
    );
    await waitFor(() => expect(attempts.signInWithPassword).toHaveBeenCalled());
    return {
      attempts,
      session,
      region,
      answer: (o: AttemptOutcome) => answer(o),
    };
  }

  test("R1: Cancel while the confirmation is in flight cancels its attempt; the section closes and its return destination goes when the cancelled result comes", async () => {
    const { attempts, region, answer } = await confirmHeld();
    const handle = (await vi.mocked(attempts.begin).mock.results[0]?.value)
      ?.handle;
    expect(returnDestination.peek()).not.toBeNull();
    fireEvent.click(within(region).getByRole("button", { name: "Cancel" }));
    expect(attempts.cancel).toHaveBeenCalledWith(handle);
    expect(
      screen.queryByRole("region", { name: CONFIRM_LABEL }),
    ).not.toBeInTheDocument();
    answer({ kind: "superseded" });
    await waitFor(() => expect(returnDestination.peek()).toBeNull());
    expect(authFeedback.get()).toEqual([]);
  });

  test("R2: an older request's terminal result drops only ITS destination, never a newer request's for the same account", async () => {
    const { answer } = await confirmHeld();
    // Another confirmation of the same account (a newer request) has set its own destination meanwhile.
    const newer = {
      account: "acct",
      epoch: 1,
      when: "newer" as const,
      path: "/settings/signing-in",
      focusKey: "link-sso",
      requestedAt: Date.now(),
    };
    returnDestination.set(newer);
    answer({
      kind: "refused",
      error: { code: "unauthenticated", message: "x" },
      definitive: true,
      stage: "exchange",
    } as AttemptOutcome);
    expect(
      await screen.findByText("That username or password isn't right."),
    ).toBeInTheDocument();
    expect(returnDestination.peek()).toBe(newer);
  });

  test("R3: a refusal that arrives after the activation's gate closed the tree is shown when the SAME session's tree renders again", async () => {
    const { answer, unmountTree } = await (async () => {
      const held = await confirmHeld();
      return { ...held, unmountTree: () => cleanup() };
    })();
    // The activating write closes the protected tree.
    unmountTree();
    answer({
      kind: "refused",
      error: { code: "device_capacity", message: "x" },
      definitive: true,
      stage: "activation",
    } as AttemptOutcome);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The same account and epoch display again: the section is open with the refusal under it.
    mount(ago(10 * 60_000));
    const region = screen.queryByRole("region", { name: CONFIRM_LABEL });
    expect(region).not.toBeNull();
    await waitFor(() =>
      expect(
        screen.queryByText(
          /This account has reached its limit of active sign-ins/ /* WEB-08d D-8d-13 copy, merged in revision 30 */,
        ),
      ).not.toBeNull(),
    );
    expect(returnDestination.peek()).toBeNull();
  });

  test("R3 control: a stage left by an earlier session is not shown to a newer one", async () => {
    confirmFlow.open({ account: "acct", epoch: 0 });
    mount(ago(10 * 60_000));
    expect(
      screen.queryByRole("region", { name: CONFIRM_LABEL }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: CONFIRM_LABEL })).toBeEnabled();
  });

  test("the link and remove controls carry the focus keys the return destination names", () => {
    mount(ago(60_000));
    expect(
      screen.getByRole("button", { name: "Link single sign-on" }),
    ).toHaveAttribute("data-return-focus", "link-sso");
    expect(
      screen.getByRole("button", { name: "Remove idp.example.test" }),
    ).toHaveAttribute("data-return-focus", `unlink-${IDP}`);
  });
});
