import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { SessionRoot, SIGN_IN_STATES } from "../../src/app/SessionRoot";
import { NEUTRAL_COPY } from "../../src/components/ui/neutral-state";
import { authFeedback } from "../../src/features/authentication/feedback";
import { invitationMemory } from "../../src/features/authentication/handoff";
import {
  EARLIER_HEADING,
  EARLIER_MESSAGE,
  LINK_INVALID,
  LOST_RESPONSE,
} from "../../src/features/authentication/JoinSurface";
import { MESSAGE_TEXT } from "../../src/features/authentication/outcome-copy";
import { signInRequest } from "../../src/features/authentication/sign-in-request";
import type { AttemptOutcome } from "../../src/session";
import {
  type ApiCompatibility,
  type NeutralStateId,
  SessionProvider,
  type SessionView,
} from "../../src/session";
import {
  attemptsDouble,
  sessionDouble,
  store,
} from "../helpers/session-double";

beforeEach(() => {
  signInRequest.clear();
  invitationMemory.clear();
  authFeedback.clearOnBegin();
});
afterEach(() => {
  cleanup();
  signInRequest.clear();
  invitationMemory.clear();
  authFeedback.clearOnBegin();
});

const supported: ApiCompatibility = { status: "supported", version: "0.27.0" };
function root(
  view: SessionView,
  options: { api?: ApiCompatibility; pathname?: string } = {},
) {
  const session = sessionDouble(
    {},
    {
      view: store(view),
      compat: store(options.api ?? supported),
      attempts: attemptsDouble(),
    },
  );
  return (
    <SessionProvider session={session}>
      <SessionRoot pathname={options.pathname ?? "/"} />
    </SessionProvider>
  );
}
const h1 = () => screen.getByRole("heading", { level: 1 }).textContent;

/** C-ROOT: every view x sign-in request x API compatibility draws exactly one surface. */
describe("SessionRoot", () => {
  test("booting is the gate; displaying draws nothing", () => {
    const { container, rerender } = render(root({ kind: "booting" }));
    expect(h1()).toBe("Atlas");
    rerender(root({ kind: "displaying", account_id: "a", epoch: 1 }));
    expect(container.innerHTML).toBe("");
  });

  test.each([
    ["/", "Sign in to Atlas"],
    ["/tasks/42", "Sign in to Atlas"],
    ["/settings", "Sign in to Atlas"],
    ["/join", "This link is no longer valid — ask for a new invitation"],
    ["/join/", "This link is no longer valid — ask for a new invitation"],
  ])("signed out at %s draws %j", async (pathname, heading) => {
    render(root({ kind: "signed_out", state: null }, { pathname }));
    // `/join` is a lazily loaded chunk: the neutral gate stands in until it arrives.
    await screen.findByRole("heading", { level: 1, name: heading });
  });

  test("a NEW invitation link arriving while the join page is open restarts it for that link", async () => {
    invitationMemory.set("a".repeat(64));
    const attempts = attemptsDouble();
    const session = sessionDouble(
      {},
      {
        view: store({ kind: "signed_out", state: null }),
        compat: store(supported),
        attempts,
      },
    );
    render(
      <SessionProvider session={session}>
        <SessionRoot pathname="/join" />
      </SessionProvider>,
    );
    await screen.findByLabelText("Username");
    expect(attempts.previewInvitation).toHaveBeenLastCalledWith(
      "a".repeat(64),
      expect.any(AbortSignal),
    );
    act(() => invitationMemory.set("b".repeat(64)));
    await vi.waitFor(() =>
      expect(attempts.previewInvitation).toHaveBeenLastCalledWith(
        "b".repeat(64),
        expect.any(AbortSignal),
      ),
    );
    // Putting back a token after a refusal (`restore`) does NOT restart the page and lose what the person typed.
    const calls = vi.mocked(attempts.previewInvitation).mock.calls.length;
    act(() => invitationMemory.take("b".repeat(64)).restore());
    expect(vi.mocked(attempts.previewInvitation).mock.calls.length).toBe(calls);
  });

  test("an API refusal wins over the form", async () => {
    render(
      root(
        { kind: "signed_out", state: null },
        { api: { status: "missing" }, pathname: "/join" },
      ),
    );
    expect(h1()).toBe("Atlas can't work with this server yet");
    expect(screen.queryByLabelText("Username")).toBeNull();
  });

  test("the join page's own 'Sign in' leads to the sign-in form, with the username it carries", () => {
    signInRequest.request("newbie");
    render(root({ kind: "signed_out", state: null }, { pathname: "/join" }));
    expect(h1()).toBe("Sign in to Atlas");
    expect(screen.getByLabelText("Username")).toHaveValue("newbie");
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  });

  describe.each([...SIGN_IN_STATES])("state %s offers the form", (state) => {
    const views: [string, SessionView][] = [
      ["signed out", { kind: "signed_out", state }],
      ["neutral", { kind: "neutral", state }],
    ];
    test.each(views)(
      "%s: the card, then the form on request, then Back",
      (_n, view) => {
        render(root(view));
        expect(h1()).toBe(
          NEUTRAL_COPY[state as Exclude<NeutralStateId, "wipe.consent">]
            .heading,
        );
        act(() => signInRequest.request());
        expect(h1()).toBe("Sign in again");
        expect(
          screen.getByRole("button", { name: "Back" }),
        ).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Back" }));
        expect(signInRequest.get().requested).toBe(false);
        expect(h1()).toBe(
          NEUTRAL_COPY[state as Exclude<NeutralStateId, "wipe.consent">]
            .heading,
        );
      },
    );
  });

  const NEVER: NeutralStateId[] = [
    "1a.checking",
    "1a.device_changed",
    "1c.finishing",
    "1c.offline",
    "1c.lock_wait",
    "1c.superseded",
    "1c.resolving",
    "1e.checking",
    "1e.session_online",
    "1e.session_offline",
    "1e.read_failure",
    "1e.interrupted_online",
    "1e.interrupted_offline",
    "1e.waiting",
    "2",
    "3",
  ];
  test.each(NEVER)(
    "state %s NEVER shows a form, even when one was requested; the request is dropped",
    (state) => {
      signInRequest.request();
      render(root({ kind: "neutral", state }));
      expect(screen.queryByLabelText("Username")).toBeNull();
      expect(screen.queryByLabelText("Password")).toBeNull();
      expect(h1()).toBe(
        NEUTRAL_COPY[state as Exclude<NeutralStateId, "wipe.consent">].heading,
      );
      expect(signInRequest.get().requested).toBe(false);
    },
  );

  test("the consent prompt never shows a form", () => {
    signInRequest.request();
    render(
      root({
        kind: "neutral",
        state: "wipe.consent",
        consent: { count: 2, ticket: "t" as never },
      }),
    );
    expect(screen.queryByLabelText("Username")).toBeNull();
    expect(signInRequest.get().requested).toBe(false);
  });

  test("E-28: a request is dropped when the view becomes displaying, and again when the state leaves SIGN_IN_STATES", () => {
    signInRequest.request();
    const { rerender } = render(root({ kind: "neutral", state: "1b" }));
    expect(h1()).toBe("Sign in again");
    rerender(root({ kind: "neutral", state: "1c.finishing" }));
    expect(screen.queryByLabelText("Username")).toBeNull();
    expect(signInRequest.get().requested).toBe(false);
    signInRequest.request();
    rerender(root({ kind: "displaying", account_id: "a", epoch: 1 }));
    expect(signInRequest.get().requested).toBe(false);
  });

  test("notices go when the person signs out or a DIFFERENT account displays, and not on a transient flicker out of `displaying`", () => {
    const a = { kind: "displaying", account_id: "a", epoch: 1 } as const;
    const { rerender } = render(root(a));
    act(() => authFeedback.add({ kind: "superseded" }));
    // The resume verification closes the display for a moment (a neutral 1e state) and then reopens it: the notice stays.
    rerender(root({ kind: "neutral", state: "1e.checking" }));
    expect(authFeedback.get()).toHaveLength(1);
    rerender(root(a));
    expect(authFeedback.get()).toHaveLength(1);
    // A different account: gone.
    rerender(root({ kind: "displaying", account_id: "b", epoch: 2 }));
    expect(authFeedback.get()).toEqual([]);
    // A sign-out: gone.
    act(() => authFeedback.add({ kind: "superseded" }));
    rerender(root({ kind: "signed_out", state: null }));
    expect(authFeedback.get()).toEqual([]);
  });

  test("a notice raised BEFORE the first display survives it (the tab that discarded a stale result then shows the account)", () => {
    const { rerender } = render(
      root({ kind: "neutral", state: "1c.finishing" }),
    );
    act(() => authFeedback.add({ kind: "superseded" }));
    rerender(root({ kind: "displaying", account_id: "b", epoch: 2 }));
    expect(authFeedback.get()).toHaveLength(1);
  });

  test("a notice raised while signed out is kept for the sign-in page that shows it", () => {
    const { rerender } = render(root({ kind: "signed_out", state: null }));
    act(() => authFeedback.add({ kind: "superseded" }));
    rerender(root({ kind: "signed_out", state: null }));
    expect(authFeedback.get()).toHaveLength(1);
    expect(
      screen.getByText(NEUTRAL_COPY["1c.superseded"].message),
    ).toBeInTheDocument();
  });

  test("nothing in any surface is account data", () => {
    const { container } = render(root({ kind: "neutral", state: "1b" }));
    expect(container.textContent).not.toMatch(/acct|kieran|@/i);
  });
});

/**
 * Review R1/R2, through the REAL composition: a view that changes while the form is submitting, as it does in the product. A
 * mocked outcome delivered to a form that stays mounted (what the controller and form tests do) cannot show what the neutral gate
 * does to the surface that asked.
 */
describe("an outcome that arrives after the neutral gate (review R1)", () => {
  const TOKEN = "b".repeat(64);
  const PASSWORD = "correct-horse-9271";
  const GATE: SessionView = { kind: "neutral", state: "1c.finishing" };
  const SIGNED_OUT: SessionView = { kind: "signed_out", state: null };

  function liveView(initial: SessionView) {
    let value = initial;
    const listeners = new Set<() => void>();
    return {
      get: () => value,
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      set(next: SessionView) {
        value = next;
        for (const listener of [...listeners]) listener();
      },
    };
  }

  function held<T>() {
    let resolve: (value: T) => void = () => undefined;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  const refusedAt = (code: string): AttemptOutcome => ({
    kind: "refused",
    definitive: true,
    stage: "activation",
    error: { code, message: "SERVER TEXT", request_id: "req-gate" },
  });
  const refusedAtActivation = refusedAt;
  const refusedAtExchange = (code: string): AttemptOutcome => ({
    kind: "refused",
    definitive: true,
    stage: "exchange",
    error: { code, message: "SERVER TEXT", request_id: "req-exchange" },
  });

  function mountLive(
    pathname: string,
    attempts: ReturnType<typeof attemptsDouble>,
  ) {
    const view = liveView(SIGNED_OUT);
    const session = sessionDouble(
      {},
      { view, compat: store(supported), attempts },
    );
    render(
      <SessionProvider session={session}>
        <SessionRoot pathname={pathname} />
      </SessionProvider>,
    );
    return view;
  }

  const fill = (username: string, password: string) => {
    fireEvent.change(screen.getByLabelText("Username"), {
      target: { value: username },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: password },
    });
  };

  // The kernel changes the record (the view) and then returns its outcome; either can reach React first.
  test.each([
    ["the gate is lifted, then the refusal is returned", "view-first"],
    ["the refusal is returned, then the gate is lifted", "outcome-first"],
  ] as const)(
    "password sign-in: an activation refusal is shown on the form that returns (%s)",
    async (_name, order) => {
      const answer = held<AttemptOutcome>();
      const attempts = attemptsDouble({
        signInWithPassword: vi.fn(() => answer.promise),
      });
      const view = mountLive("/", attempts);
      fill("kieran", PASSWORD);
      fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
      await vi.waitFor(() =>
        expect(attempts.signInWithPassword).toHaveBeenCalledTimes(1),
      );
      // The activation is under way: the neutral gate has the screen and the form is gone.
      act(() => view.set(GATE));
      expect(h1()).toBe(NEUTRAL_COPY["1c.finishing"].heading);
      expect(screen.queryByLabelText("Username")).toBeNull();
      if (order === "view-first") {
        act(() => view.set(SIGNED_OUT));
        await act(async () => answer.resolve(refusedAt("device_capacity")));
      } else {
        await act(async () => answer.resolve(refusedAt("device_capacity")));
        act(() => view.set(SIGNED_OUT));
      }
      // The refusal is on the form that mounted, not lost with the one that asked.
      expect(await screen.findByRole("alert")).toHaveTextContent(
        MESSAGE_TEXT.device_capacity,
      );
      expect(h1()).toBe("Sign in to Atlas");
      expect(screen.getByLabelText("Password")).toHaveValue("");
      expect(screen.getAllByRole("alert")).toHaveLength(1);
    },
  );

  test("password sign-in: when an account displays instead, the refusal is not kept for the next person", async () => {
    const answer = held<AttemptOutcome>();
    const attempts = attemptsDouble({
      signInWithPassword: vi.fn(() => answer.promise),
    });
    const view = mountLive("/", attempts);
    fill("kieran", PASSWORD);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await vi.waitFor(() =>
      expect(attempts.signInWithPassword).toHaveBeenCalledTimes(1),
    );
    act(() => view.set(GATE));
    // Another window's sign-in wins; this window's stale attempt is refused and nothing here shows the refusal.
    await act(async () => answer.resolve(refusedAt("device_capacity")));
    expect(authFeedback.carriedFailure()).not.toBeNull();
    act(() => view.set({ kind: "displaying", account_id: "b", epoch: 2 }));
    expect(authFeedback.carriedFailure()).toBeNull();
    act(() => view.set(SIGNED_OUT));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test.each([
    ["the gate is lifted, then the refusal is returned", "view-first"],
    ["the refusal is returned, then the gate is lifted", "outcome-first"],
  ] as const)(
    "registration: an activation refusal after a good redemption is the sign-in recovery, not 'ask for a new invitation' (%s)",
    async (_name, order) => {
      invitationMemory.set(TOKEN);
      const answer = held<AttemptOutcome>();
      const attempts = attemptsDouble({
        registerWithInvitation: vi.fn(() => answer.promise),
      });
      const view = mountLive("/join", attempts);
      await screen.findByLabelText("Username");
      fill("newbie", PASSWORD);
      fireEvent.click(screen.getByRole("button", { name: "Create account" }));
      await vi.waitFor(() =>
        expect(attempts.registerWithInvitation).toHaveBeenCalledTimes(1),
      );
      act(() => view.set(GATE));
      expect(h1()).toBe(NEUTRAL_COPY["1c.finishing"].heading);
      if (order === "view-first") {
        act(() => view.set(SIGNED_OUT));
        await act(async () => answer.resolve(refusedAt("device_capacity")));
      } else {
        await act(async () => answer.resolve(refusedAt("device_capacity")));
        act(() => view.set(SIGNED_OUT));
      }
      expect(
        await screen.findByRole("heading", {
          level: 1,
          name: "Check whether your account was created",
        }),
      ).toBeInTheDocument();
      expect(screen.getByText(LOST_RESPONSE)).toBeInTheDocument();
      expect(screen.queryByText(LINK_INVALID)).toBeNull();
      expect(screen.queryByLabelText("Username")).toBeNull();
      expect(
        screen.queryByRole("button", { name: /Create account/ }),
      ).toBeNull();
      // The person signs in with the details they chose.
      fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
      expect(h1()).toBe("Sign in to Atlas");
      expect(screen.getByLabelText("Username")).toHaveValue("newbie");
      expect(attempts.registerWithInvitation).toHaveBeenCalledTimes(1);
    },
  );

  test("registration: an indeterminate activation (the gate resolves later) ends in the same recovery", async () => {
    invitationMemory.set(TOKEN);
    const answer = held<AttemptOutcome>();
    const attempts = attemptsDouble({
      registerWithInvitation: vi.fn(() => answer.promise),
    });
    const view = mountLive("/join", attempts);
    await screen.findByLabelText("Username");
    fill("newbie", PASSWORD);
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    await vi.waitFor(() =>
      expect(attempts.registerWithInvitation).toHaveBeenCalledTimes(1),
    );
    act(() => view.set(GATE));
    await act(async () => answer.resolve({ kind: "gating" }));
    // The gate keeps the screen until the kernel resolves the attempt.
    expect(h1()).toBe(NEUTRAL_COPY["1c.finishing"].heading);
    act(() => view.set(SIGNED_OUT));
    expect(await screen.findByText(LOST_RESPONSE)).toBeInTheDocument();
    expect(screen.queryByText(LINK_INVALID)).toBeNull();
  });

  test("registration: a result discarded because a newer attempt FAILED retires the live form and says why", async () => {
    invitationMemory.set(TOKEN);
    const answer = held<AttemptOutcome>();
    const attempts = attemptsDouble({
      registerWithInvitation: vi.fn(() => answer.promise),
    });
    mountLive("/join", attempts);
    await screen.findByLabelText("Username");
    fill("newbie", PASSWORD);
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    await vi.waitFor(() =>
      expect(attempts.registerWithInvitation).toHaveBeenCalledTimes(1),
    );
    // The view never leaves the form: the newer attempt failed, so no account displays.
    await act(async () => answer.resolve({ kind: "superseded" }));
    expect(await screen.findByText(LOST_RESPONSE)).toBeInTheDocument();
    expect(
      screen.getByText(NEUTRAL_COPY["1c.superseded"].message),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Create account/ })).toBeNull();
    expect(screen.queryByLabelText("Password")).toBeNull();
  });

  test("a spent invitation is forgotten once an account displays", () => {
    invitationMemory.take(TOKEN).spend("newbie");
    const view = mountLive("/join", attemptsDouble());
    expect(screen.getByText(LOST_RESPONSE)).toBeInTheDocument();
    act(() => view.set({ kind: "displaying", account_id: "b", epoch: 2 }));
    expect(invitationMemory.get()).toEqual({ kind: "unset" });
  });

  /**
   * Review R5. A DIFFERENT invitation is opened (a fragment-only navigation) while the first registration is outstanding. The
   * surface restarts for it; the first result, when it comes, belongs to the first invitation and must not retire the second
   * form, put the first token back, or replace what the person has typed. What the first submission may have created is told
   * beside the second, with its own way to sign in.
   */
  describe("a different invitation opened while a registration is outstanding (review R5)", () => {
    const FIRST = "b".repeat(64);
    const SECOND = "c".repeat(64);
    const SECOND_HEADING = "You're invited to join Second household";

    async function openSecondWhileFirstIsOutstanding() {
      invitationMemory.set(FIRST);
      const answer = held<AttemptOutcome>();
      const registerWithInvitation = vi
        .fn()
        .mockImplementationOnce(() => answer.promise)
        .mockImplementation(async () => ({
          kind: "settled" as const,
          account_id: "acct",
          epoch: 1,
          method: "registration" as const,
        }));
      const attempts = attemptsDouble({
        registerWithInvitation,
        previewInvitation: vi.fn(async (token: string) => ({
          kind: "ok" as const,
          household:
            token === SECOND ? { id: "h2", name: "Second household" } : null,
          expires_at: "2026-10-08T18:00:00.000Z",
        })),
      });
      const view = mountLive("/join", attempts);
      await screen.findByLabelText("Username");
      fill("firstperson", PASSWORD);
      fireEvent.click(screen.getByRole("button", { name: "Create account" }));
      await vi.waitFor(() =>
        expect(registerWithInvitation).toHaveBeenCalledTimes(1),
      );
      // The person pastes another link into the address bar of this open page.
      act(() => invitationMemory.set(SECOND));
      expect(
        await screen.findByRole("heading", { level: 1, name: SECOND_HEADING }),
      ).toBeInTheDocument();
      fill("secondperson", "second-password-9271");
      return { answer, attempts, registerWithInvitation, view };
    }

    const secondFormIsIntact = () => {
      expect(h1()).toBe(SECOND_HEADING);
      expect(screen.getByLabelText("Username")).toHaveValue("secondperson");
      expect(screen.getByLabelText("Password")).toHaveValue(
        "second-password-9271",
      );
      expect(
        screen.getByRole("button", {
          name: "Create account and join Second household",
        }),
      ).toBeEnabled();
      expect(screen.queryByText(LOST_RESPONSE)).toBeNull();
      expect(screen.queryByText(LINK_INVALID)).toBeNull();
    };

    test.each([
      ["a lost response", { kind: "exchange_failed", status: null }],
      [
        "a hidden page after the redemption",
        { kind: "not_started", reason: "hidden" },
      ],
      [
        "an activation refused after a good redemption",
        refusedAtActivation("device_capacity"),
      ],
    ] as const)(
      "%s: the second form stays, with what was typed, and the first submission is told beside it",
      async (_name, outcome) => {
        const { answer, registerWithInvitation } =
          await openSecondWhileFirstIsOutstanding();
        await act(async () => answer.resolve(outcome as AttemptOutcome));
        secondFormIsIntact();
        // Told beside it, never as it: a status with its own sign-in, carrying only the username the person chose.
        const note = screen.getByText(EARLIER_MESSAGE);
        expect(note).toHaveAttribute("role", "status");
        expect(note).toHaveTextContent(EARLIER_HEADING);
        expect(invitationMemory.earlier()).toBe("firstperson");
        expect(invitationMemory.get()).toEqual({
          kind: "token",
          token: SECOND,
        });
        expect(document.body.innerHTML).not.toContain(FIRST);
        // The second invitation is submittable, with ITS token and ITS details; the first is never sent again.
        fireEvent.click(
          screen.getByRole("button", {
            name: "Create account and join Second household",
          }),
        );
        await vi.waitFor(() =>
          expect(registerWithInvitation).toHaveBeenCalledTimes(2),
        );
        expect(registerWithInvitation.mock.calls[1]?.[1]).toMatchObject({
          token: SECOND,
          username: "secondperson",
        });
        expect(
          registerWithInvitation.mock.calls.filter(
            (call) => call[1].token === FIRST,
          ),
        ).toHaveLength(1);
      },
    );

    test("the note's own 'Sign in' leads to the sign-in form with the FIRST username, and the second link is still remembered", async () => {
      const { answer } = await openSecondWhileFirstIsOutstanding();
      await act(async () =>
        answer.resolve({ kind: "exchange_failed", status: null }),
      );
      const note = document.querySelector<HTMLElement>(
        "[data-earlier-registration]",
      );
      if (!note) throw new Error("the earlier-registration note is missing");
      fireEvent.click(within(note).getByRole("button", { name: "Sign in" }));
      expect(h1()).toBe("Sign in to Atlas");
      expect(screen.getByLabelText("Username")).toHaveValue("firstperson");
      expect(invitationMemory.peek()).toBe(SECOND);
    });

    test("a refusal that would put the first token back changes nothing: the second form stays and nothing is said about the first", async () => {
      const { answer } = await openSecondWhileFirstIsOutstanding();
      await act(async () => answer.resolve(refusedAtExchange("conflict")));
      secondFormIsIntact();
      expect(screen.queryByText(EARLIER_MESSAGE)).toBeNull();
      expect(screen.queryByText(MESSAGE_TEXT.username_taken)).toBeNull();
      expect(invitationMemory.earlier()).toBeNull();
      expect(invitationMemory.peek()).toBe(SECOND);
    });

    test("a refusal as unusable (401) for the first invitation does not retire the second", async () => {
      const { answer } = await openSecondWhileFirstIsOutstanding();
      await act(async () =>
        answer.resolve(refusedAtExchange("unauthenticated")),
      );
      secondFormIsIntact();
      expect(screen.queryByText(EARLIER_MESSAGE)).toBeNull();
      expect(
        screen.queryByRole("heading", {
          name: "This invitation can't be used",
        }),
      ).toBeNull();
    });

    test("a result discarded because a newer attempt FAILED keeps the second form, says why this window shows no account, and tells the first", async () => {
      const { answer } = await openSecondWhileFirstIsOutstanding();
      await act(async () => answer.resolve({ kind: "superseded" }));
      secondFormIsIntact();
      expect(
        screen.getByText(NEUTRAL_COPY["1c.superseded"].message),
      ).toBeInTheDocument();
      expect(screen.getByText(EARLIER_MESSAGE)).toBeInTheDocument();
    });

    test("an indeterminate activation: the gate takes the screen, and when it resolves the second form and the note are there", async () => {
      const { answer, view } = await openSecondWhileFirstIsOutstanding();
      act(() => view.set(GATE));
      await act(async () => answer.resolve({ kind: "gating" }));
      expect(h1()).toBe(NEUTRAL_COPY["1c.finishing"].heading);
      act(() => view.set(SIGNED_OUT));
      expect(
        await screen.findByRole("heading", { level: 1, name: SECOND_HEADING }),
      ).toBeInTheDocument();
      expect(screen.getByText(EARLIER_MESSAGE)).toBeInTheDocument();
      expect(screen.queryByText(LOST_RESPONSE)).toBeNull();
    });

    test("the note is dismissed without touching the form", async () => {
      const { answer } = await openSecondWhileFirstIsOutstanding();
      await act(async () =>
        answer.resolve({ kind: "exchange_failed", status: null }),
      );
      fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
      expect(screen.queryByText(EARLIER_MESSAGE)).toBeNull();
      expect(invitationMemory.earlier()).toBeNull();
      secondFormIsIntact();
    });

    test("when an account displays the note is forgotten and does not greet the next person, while the second link stays remembered", async () => {
      const { answer, view } = await openSecondWhileFirstIsOutstanding();
      await act(async () =>
        answer.resolve({ kind: "exchange_failed", status: null }),
      );
      expect(invitationMemory.earlier()).toBe("firstperson");
      act(() => view.set({ kind: "displaying", account_id: "b", epoch: 2 }));
      expect(invitationMemory.earlier()).toBeNull();
      expect(invitationMemory.peek()).toBe(SECOND);
      act(() => view.set(SIGNED_OUT));
      expect(screen.queryByText(EARLIER_MESSAGE)).toBeNull();
    });

    test("an INVALID link opened meanwhile is not replaced by the first submission's recovery", async () => {
      invitationMemory.set(FIRST);
      const answer = held<AttemptOutcome>();
      const attempts = attemptsDouble({
        registerWithInvitation: vi.fn(() => answer.promise),
      });
      mountLive("/join", attempts);
      await screen.findByLabelText("Username");
      fill("firstperson", PASSWORD);
      fireEvent.click(screen.getByRole("button", { name: "Create account" }));
      await vi.waitFor(() =>
        expect(attempts.registerWithInvitation).toHaveBeenCalledTimes(1),
      );
      act(() => invitationMemory.markInvalid());
      expect(h1()).toBe(LINK_INVALID);
      await act(async () =>
        answer.resolve({ kind: "exchange_failed", status: null }),
      );
      expect(h1()).toBe(LINK_INVALID);
      expect(screen.getByText(EARLIER_MESSAGE)).toBeInTheDocument();
      expect(screen.queryByText(LOST_RESPONSE)).toBeNull();
    });

    test("a recovery card that a newer link displaces becomes the note, so the first account is not forgotten", async () => {
      invitationMemory.take(FIRST).spend("firstperson");
      const attempts = attemptsDouble({
        previewInvitation: vi.fn(async () => ({
          kind: "ok" as const,
          household: { id: "h2", name: "Second household" },
          expires_at: "2026-10-08T18:00:00.000Z",
        })),
      });
      mountLive("/join", attempts);
      expect(h1()).toBe("Check whether your account was created");
      act(() => invitationMemory.set(SECOND));
      expect(
        await screen.findByRole("heading", { level: 1, name: SECOND_HEADING }),
      ).toBeInTheDocument();
      expect(screen.getByText(EARLIER_MESSAGE)).toBeInTheDocument();
      expect(screen.queryByText(LOST_RESPONSE)).toBeNull();
      expect(screen.getByLabelText("Username")).toBeEnabled();
    });
  });
});
