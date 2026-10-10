import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { NEUTRAL_COPY } from "../../../src/components/ui/neutral-state";
import { authFeedback } from "../../../src/features/authentication/feedback";
import { invitationMemory } from "../../../src/features/authentication/handoff";
import {
  JOIN_FOOTNOTE,
  JOIN_OFFLINE_REASON,
} from "../../../src/features/authentication/JoinForm";
import {
  EARLIER_HEADING,
  EARLIER_MESSAGE,
  JoinSurface,
  LINK_INVALID,
  LOST_RESPONSE,
} from "../../../src/features/authentication/JoinSurface";
import { MESSAGE_TEXT } from "../../../src/features/authentication/outcome-copy";
import { signInRequest } from "../../../src/features/authentication/sign-in-request";
import { type AttemptOutcome, SessionProvider } from "../../../src/session";
import { attemptsDouble, sessionDouble } from "../../helpers/session-double";

const TOKEN = "b".repeat(64);
const PASSWORD = "correct-horse-9271";
const setOnline = (value: boolean) =>
  Object.defineProperty(navigator, "onLine", { value, configurable: true });

beforeEach(() => {
  setOnline(true);
  invitationMemory.clear();
  authFeedback.clearOnBegin();
  signInRequest.clear();
});
afterEach(() => {
  cleanup();
  setOnline(true);
  invitationMemory.clear();
  authFeedback.clearOnBegin();
  signInRequest.clear();
});

const refusal = (code: string, stage: "exchange" | "activation" = "exchange") =>
  ({
    kind: "refused",
    definitive: true,
    stage,
    error: { code, message: "SERVER TEXT", request_id: "req-7" },
  }) satisfies AttemptOutcome;

function mount(
  over: Parameters<typeof attemptsDouble>[0] = {},
  token: string | null = TOKEN,
) {
  if (token) invitationMemory.set(token);
  const attempts = attemptsDouble(over);
  const session = sessionDouble({}, { attempts });
  const view = render(
    <SessionProvider session={session}>
      <JoinSurface />
    </SessionProvider>,
  );
  return { attempts, ...view };
}

const household = (name: string | null) => ({
  previewInvitation: vi.fn(async () => ({
    kind: "ok" as const,
    household: name ? { id: "h1", name } : null,
    expires_at: "2026-09-29T17:00:00.000Z",
  })),
});
const fill = (username: string, password: string) => {
  fireEvent.change(screen.getByLabelText("Username"), {
    target: { value: username },
  });
  fireEvent.change(screen.getByLabelText("Password"), {
    target: { value: password },
  });
};

/** C-JOIN: every state of /join. */
describe("the join surface", () => {
  test("E-2: with no token in memory (a reload after the strip) the link is no longer valid, and no preview is requested", () => {
    const { attempts } = mount({}, null);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      LINK_INVALID,
    );
    expect(attempts.previewInvitation).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Username")).toBeNull();
  });

  test("an invalid link is the same state", () => {
    invitationMemory.markInvalid();
    render(
      <SessionProvider
        session={sessionDouble({}, { attempts: attemptsDouble() })}
      >
        <JoinSurface />
      </SessionProvider>,
    );
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      LINK_INVALID,
    );
  });

  test("loading: a skeleton in the card with the form's place held; the token goes in the preview call", async () => {
    let release: (value: unknown) => void = () => undefined;
    const { attempts, container } = mount({
      previewInvitation: vi.fn(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }) as never,
      ),
    });
    expect(container.querySelector("[aria-busy='true']")).not.toBeNull();
    expect(screen.getByText("Loading your invitation…")).toBeInTheDocument();
    expect(attempts.previewInvitation).toHaveBeenCalledWith(
      TOKEN,
      expect.any(AbortSignal),
    );
    await act(async () =>
      release({
        kind: "ok",
        household: null,
        expires_at: "2026-09-29T17:00:00.000Z",
      }),
    );
    expect(await screen.findByLabelText("Username")).toBeInTheDocument();
  });

  test("a household invitation: the heading, the expiry line, the fields and the submit are the wireframe's", async () => {
    const { container } = mount(household("Hartley"));
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "You're invited to join Hartley",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /This invitation joins the Hartley household\. It expires \d{4}-\d{2}-\d{2} \d{2}:\d{2}\./,
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Username")).toHaveAttribute(
      "placeholder",
      "Choose a username",
    );
    expect(screen.getByLabelText("Username")).toHaveAttribute(
      "autocomplete",
      "username",
    );
    expect(screen.getByLabelText("Password")).toHaveAttribute(
      "placeholder",
      "At least 12 characters",
    );
    expect(screen.getByLabelText("Password")).toHaveAttribute(
      "autocomplete",
      "new-password",
    );
    expect(
      screen.getByRole("button", { name: "Create account and join Hartley" }),
    ).toBeInTheDocument();
    expect(screen.getByText(JOIN_FOOTNOTE)).toBeInTheDocument();
    expect((await axe(container)).violations).toEqual([]);
  });

  test("a standalone invitation: 'join Atlas', no household line, a plain submit", async () => {
    mount(household(null));
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "You're invited to join Atlas",
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/household/)).toBeNull();
    expect(
      screen.getByRole("button", { name: "Create account" }),
    ).toBeInTheDocument();
  });

  test("an expired or used invitation: the single honest state, no form, and no inviter is named", async () => {
    mount({
      previewInvitation: vi.fn(async () => ({ kind: "unavailable" as const })),
    });
    expect(
      await screen.findByText(MESSAGE_TEXT.invitation_unavailable),
    ).toBeInTheDocument();
    expect(MESSAGE_TEXT.invitation_unavailable).toBe(
      "This invitation has expired or was already used. Ask whoever invited you for a new one.",
    );
    expect(screen.queryByLabelText("Username")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(signInRequest.get()).toEqual({ requested: true, username: "" });
  });

  test("a preview that could not be loaded offers Try again, which asks again", async () => {
    const preview = vi
      .fn()
      .mockResolvedValueOnce({ kind: "network_failure" })
      .mockResolvedValueOnce({
        kind: "ok",
        household: null,
        expires_at: "2026-09-29T17:00:00.000Z",
      });
    mount({ previewInvitation: preview });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      MESSAGE_TEXT.unreachable,
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByLabelText("Username")).toBeInTheDocument();
    expect(preview).toHaveBeenCalledTimes(2);
  });

  test("a throttled preview says so", async () => {
    mount({
      previewInvitation: vi.fn(async () => ({
        kind: "refused" as const,
        status: 429,
        error: { code: "rate_limited", message: "x", request_id: "r1" },
      })),
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      `${MESSAGE_TEXT.rate_limited} Request ID: r1`,
    );
  });

  test("offline: submit disabled with the wireframe's reason; nothing is queued", async () => {
    setOnline(false);
    const { attempts } = mount(household(null));
    await screen.findByLabelText("Username");
    expect(
      screen.getByRole("button", { name: "Create account" }),
    ).toBeDisabled();
    expect(screen.getByText(JOIN_OFFLINE_REASON)).toBeInTheDocument();
    fireEvent.submit(
      screen.getByLabelText("Username").closest("form") as Element,
    );
    expect(attempts.begin).not.toHaveBeenCalled();
  });

  test.each([
    [
      "an upper-case username",
      "Newbie",
      PASSWORD,
      "Use lowercase letters, numbers, dots, dashes and underscores.",
    ],
    ["an empty username", "", PASSWORD, "Enter your username."],
    ["a short password", "newbie", "short", "Use at least 12 characters."],
  ])(
    "%s is refused before anything is sent",
    async (_name, username, password, message) => {
      const { attempts } = mount(household(null));
      await screen.findByLabelText("Username");
      fill(username, password);
      fireEvent.click(screen.getByRole("button", { name: "Create account" }));
      expect(screen.getByRole("alert")).toHaveTextContent(message);
      expect(attempts.begin).not.toHaveBeenCalled();
    },
  );

  test("E-16: six emoji are a long enough password (12 or more bytes)", async () => {
    const { attempts } = mount(household(null));
    await screen.findByLabelText("Username");
    fill("newbie", "😀".repeat(3));
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    await waitFor(() =>
      expect(attempts.registerWithInvitation).toHaveBeenCalled(),
    );
  });

  test("a valid submit sends the token, the TRIMMED username and the untouched password; the token leaves memory", async () => {
    const { attempts } = mount(household(null));
    await screen.findByLabelText("Username");
    fill("  newbie ", ` ${PASSWORD} `);
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    await waitFor(() =>
      expect(attempts.registerWithInvitation).toHaveBeenCalledWith(
        expect.objectContaining({ method: "registration" }),
        { token: TOKEN, username: "newbie", password: ` ${PASSWORD} ` },
      ),
    );
    expect(invitationMemory.peek()).toBeNull();
  });

  test("a taken username keeps the form and the token and points at the username field", async () => {
    mount({
      ...household(null),
      registerWithInvitation: vi.fn(async () => refusal("conflict")),
    });
    await screen.findByLabelText("Username");
    fill("kieran", PASSWORD);
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("That username is taken. Choose another.");
    const username = screen.getByLabelText("Username");
    expect(username).toHaveAttribute("aria-invalid", "true");
    expect(username.getAttribute("aria-describedby")).toBe(alert.id);
    expect(username).toHaveFocus();
    expect(invitationMemory.peek()).toBe(TOKEN);
    expect(screen.getByLabelText("Password")).toHaveValue("");
    expect(
      screen.getByRole("button", { name: "Create account" }),
    ).toBeEnabled();
  });

  test("a 401 on submit: the unavailable state PLUS the lost-response sentence, no form", async () => {
    mount({
      ...household(null),
      registerWithInvitation: vi.fn(async () => refusal("unauthenticated")),
    });
    await screen.findByLabelText("Username");
    fill("newbie", PASSWORD);
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(
      await screen.findByText(MESSAGE_TEXT.invitation_unavailable),
    ).toBeInTheDocument();
    expect(screen.getByText(LOST_RESPONSE)).toBeInTheDocument();
    expect(screen.queryByLabelText("Username")).toBeNull();
  });

  test("an unknown outcome: the lost-response state, no form, NO resubmit; Sign in carries the username, never the password", async () => {
    const { attempts } = mount({
      ...household(null),
      registerWithInvitation: vi.fn(async () => ({
        kind: "exchange_failed" as const,
        status: null,
      })),
    });
    await screen.findByLabelText("Username");
    fill("newbie", PASSWORD);
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByText(LOST_RESPONSE)).toBeInTheDocument();
    expect(LOST_RESPONSE).toBe(
      "If you already submitted this and lost the confirmation, don't try again — sign in with the details you chose.",
    );
    expect(screen.queryByRole("button", { name: /Create account/ })).toBeNull();
    expect(invitationMemory.peek()).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(signInRequest.get()).toEqual({
      requested: true,
      username: "newbie",
    });
    expect(JSON.stringify(signInRequest.get())).not.toContain(PASSWORD);
    expect(attempts.registerWithInvitation).toHaveBeenCalledTimes(1);
  });

  // Review R2: the redemption was sent and committed, so the LIVE form must never offer the consumed invitation again.
  test.each([
    [
      "a superseded result (a newer attempt in another window failed)",
      { kind: "superseded" } as const,
    ],
    [
      "a hidden page after the redemption (the activation never started)",
      { kind: "not_started", reason: "hidden" } as const,
    ],
    [
      "an activation refused after the redemption",
      refusal("device_capacity", "activation"),
    ],
  ])(
    "%s: the form is retired and the sign-in recovery replaces it",
    async (_name, outcome) => {
      const { attempts } = mount({
        ...household(null),
        registerWithInvitation: vi.fn(async () => outcome),
      });
      await screen.findByLabelText("Username");
      fill("newbie", PASSWORD);
      fireEvent.click(screen.getByRole("button", { name: "Create account" }));
      expect(await screen.findByText(LOST_RESPONSE)).toBeInTheDocument();
      expect(
        screen.getByRole("heading", {
          level: 1,
          name: "Check whether your account was created",
        }),
      ).toBeInTheDocument();
      // No submission capability remains: no form, no fields, no button, and the token is gone from the page's memory.
      expect(
        screen.queryByRole("button", { name: /Create account/ }),
      ).toBeNull();
      expect(screen.queryByLabelText("Username")).toBeNull();
      expect(screen.queryByLabelText("Password")).toBeNull();
      expect(invitationMemory.peek()).toBeNull();
      expect(screen.queryByText(LINK_INVALID)).toBeNull();
      // The way out is to sign in with what was chosen.
      fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
      expect(signInRequest.get()).toEqual({
        requested: true,
        username: "newbie",
      });
      expect(attempts.registerWithInvitation).toHaveBeenCalledTimes(1);
    },
  );

  test("a superseded registration still says why this window is not showing the new account", async () => {
    mount({
      ...household(null),
      registerWithInvitation: vi.fn(async () => ({
        kind: "superseded" as const,
      })),
    });
    await screen.findByLabelText("Username");
    fill("newbie", PASSWORD);
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    await screen.findByText(LOST_RESPONSE);
    expect(
      screen.getByText(NEUTRAL_COPY["1c.superseded"].message),
    ).toBeInTheDocument();
  });

  test("a surface that mounts AFTER the redemption (the neutral gate unmounted the first) finds the recovery, not 'no longer valid'", () => {
    invitationMemory.take(TOKEN).spend("newbie");
    const { attempts } = mount({}, null);
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Check whether your account was created",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(LOST_RESPONSE)).toBeInTheDocument();
    expect(screen.queryByText(LINK_INVALID)).toBeNull();
    // No preview is asked for and nothing can be submitted.
    expect(attempts.previewInvitation).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Username")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(signInRequest.get().username).toBe("newbie");
  });

  test("a NEW invitation link after a spent one is a fresh page", async () => {
    invitationMemory.take(TOKEN).spend("newbie");
    mount({ ...household(null) }, null);
    expect(screen.getByText(LOST_RESPONSE)).toBeInTheDocument();
    act(() => invitationMemory.set(TOKEN));
    expect(invitationMemory.get()).toEqual({ kind: "token", token: TOKEN });
  });

  test("an earlier submission is told beside the invitation now on screen: a fixed status with its own sign-in, no username in the text, and no accessibility violation", async () => {
    invitationMemory.set("c".repeat(64));
    invitationMemory.take("c".repeat(64)).spend("firstperson");
    // Mounting with a link replaces the spent recovery: a newer link now holds the page and the earlier submission is told beside it.
    const { container } = mount(household("Hartley"));
    await screen.findByLabelText("Username");
    const note = screen.getByText(EARLIER_MESSAGE);
    expect(note).toHaveAttribute("role", "status");
    expect(note).toHaveTextContent(EARLIER_HEADING);
    expect(note).not.toHaveTextContent("firstperson");
    expect(screen.queryByText(LOST_RESPONSE)).toBeNull();
    expect(
      screen.getByRole("button", { name: "Create account and join Hartley" }),
    ).toBeInTheDocument();
    expect((await axe(container)).violations).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(signInRequest.get()).toEqual({
      requested: true,
      username: "firstperson",
    });
  });

  test("a preview aborted because the tab was hidden is asked for again when it is visible (E-5: no skeleton that nothing will ever fill)", async () => {
    const results: Array<(value: unknown) => void> = [];
    const preview = vi.fn(
      (_token: string, signal?: AbortSignal) =>
        new Promise((resolve) => {
          results.push(resolve);
          signal?.addEventListener("abort", () =>
            resolve({ kind: "network_failure" }),
          );
        }),
    );
    mount({ previewInvitation: preview as never });
    expect(preview).toHaveBeenCalledTimes(1);
    const visibility = (state: "hidden" | "visible") => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => state,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    };
    act(() => visibility("hidden"));
    const firstSignal = preview.mock.calls[0]?.[1];
    expect(firstSignal?.aborted).toBe(true);
    // Still hidden: nothing is shown as a failure and nothing is re-requested yet.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(preview).toHaveBeenCalledTimes(1);
    act(() => visibility("visible"));
    await waitFor(() => expect(preview).toHaveBeenCalledTimes(2));
    await act(async () =>
      results[1]?.({
        kind: "ok",
        household: null,
        expires_at: "2026-09-29T17:00:00.000Z",
      }),
    );
    expect(await screen.findByLabelText("Username")).toBeInTheDocument();
    Reflect.deleteProperty(document, "visibilityState");
  });

  test("the tab title is generic", async () => {
    mount(household(null));
    expect(document.title).toBe("Join · Atlas");
    await screen.findByLabelText("Username");
  });

  test("the invitation token is nowhere in the page", async () => {
    const { container } = mount(household("Hartley"));
    await screen.findByLabelText("Username");
    expect(container.innerHTML).not.toContain(TOKEN);
    expect(document.title).not.toContain(TOKEN);
    expect(location.href).not.toContain(TOKEN);
  });
});
