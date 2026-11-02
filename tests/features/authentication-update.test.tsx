import { act, fireEvent, render, screen } from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import type {
  RegisterResult,
  SignInResult,
  SsoResult,
} from "../../src/features/authentication/controller";
import { authFeedback } from "../../src/features/authentication/feedback";
import { invitationMemory } from "../../src/features/authentication/handoff";
import { JoinForm } from "../../src/features/authentication/JoinForm";
import {
  JoinSurface,
  LOST_RESPONSE,
} from "../../src/features/authentication/JoinSurface";
import { SignInForm } from "../../src/features/authentication/SignInForm";
import { SignInSurface } from "../../src/features/authentication/SignInSurface";
import { signInRequest } from "../../src/features/authentication/sign-in-request";
import { LinkedIdentities } from "../../src/features/settings/signing-in/LinkedIdentities";
import { dismissalsDecided } from "../../src/lib/form-recovery/editor";
import { pageFormRegistry } from "../../src/lib/form-recovery/registry";
import { FLUSH_START_GRACE_MS } from "../../src/lib/pwa/coordinator";
import { KEPT_INPUT_TEXT, noticeOf } from "../../src/lib/pwa/UpdateBanner";
import { type AccountSummary, SessionProvider } from "../../src/session";
import { installMatchMedia } from "../helpers/match-media";
import { attemptsDouble, sessionDouble } from "../helpers/session-double";
import { FakeOrigin, flush, type Tab } from "../pwa/coordinator-world";
import {
  contextsOf,
  forgetRecoveryWorld,
  freeze,
  installRecoveryLocks,
  protectedTree,
  store,
} from "../support/recovery-editors";

/**
 * WEB-14a revision 39: the review of revision 38 (R40-COMPOSITION, R40-FREEZE) and its design assessment (token 683bc0c7…, C1-C3, I1-I7,
 * DA-AUTH-HOSTS, DA-AUTH-LINK, Q1-Q4). The production authentication forms and surfaces with the page's REAL form registry and the REAL
 * app-update coordinator (`startAppUpdates`, over the deterministic worker/channel world of `tests/pwa/coordinator-world.ts`): what an
 * accepted update does with unfinished input that no reload brings back, and which authentication work it admits while it is prepared.
 * Every hold is an explicit entered/released promise; no timer stands for an outcome. Callbacks are doubles: this is admission and
 * composition evidence, not a backend outcome.
 */
installMatchMedia({ width: 1440 });
beforeAll(installRecoveryLocks);
beforeEach(() => {
  invitationMemory.clear();
  authFeedback.clearOnBegin();
  signInRequest.clear();
});
afterEach(() => {
  // A departure left by a case (single sign-on navigating) ends as on a return to the page.
  window.dispatchEvent(new Event("pageshow"));
  forgetRecoveryWorld();
  invitationMemory.clear();
  authFeedback.clearOnBegin();
  signInRequest.clear();
  window.sessionStorage.clear();
});

const PASSWORD = "NeverPersistTheSecret1!";
const TOKEN = "a".repeat(64);

const username = () =>
  screen.getByRole("textbox", { name: "Username" }) as HTMLInputElement;
const typeCredentials = (name: string) => {
  fireEvent.change(username(), { target: { value: name } });
  fireEvent.change(screen.getByLabelText("Password"), {
    target: { value: PASSWORD },
  });
};
const formOf = () => username().closest("form") as HTMLFormElement;

/** A held answer: `entered` once asked; resolved only by the test. */
function held<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  let calls = 0;
  const answer = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const call = vi.fn(() => {
    calls += 1;
    return answer;
  });
  return { call, entered: () => calls, resolve, reject };
}

/** This page's coordinator over the page's real form registry, with a newer version waiting. */
async function updating(): Promise<{
  origin: FakeOrigin;
  tab: Tab;
  waiting: Awaited<ReturnType<FakeOrigin["installNew"]>>;
}> {
  const origin = new FakeOrigin();
  const tab = origin.tab();
  Object.assign(tab, { forms: pageFormRegistry });
  await tab.start();
  const waiting = await origin.installNew(2);
  return { origin, tab, waiting };
}
/** Accept, and let the act go as far as it can on its own (the other tabs' grace; the activation follows when the test says). */
async function accept(origin: FakeOrigin, tab: Tab): Promise<void> {
  await act(async () => {
    tab.actions?.accept();
    await origin.clock.advance(FLUSH_START_GRACE_MS);
  });
}

afterEach(() => {
  for (const t of tabs.splice(0)) t.coordinator?.dispose();
});
const tabs: Tab[] = [];
async function world() {
  const made = await updating();
  tabs.push(made.tab);
  return made;
}

describe("Q1: the review's freeze witness, promoted (R40-FREEZE)", () => {
  // `.agtx/evidence/review-r38-20261027/freeze.test.tsx`, unchanged in substance: three frozen cases and their healthy controls.
  for (const kind of ["sign-in", "join", "sso"] as const)
    for (const frozen of [false, true])
      test(`${frozen ? "FROZEN" : "CONTROL"}: ${kind} starts only when update preparation permits a new submission`, async () => {
        const sent = vi.fn(async () => ({ kind: "cancelled" as const }));
        render(
          kind === "join" ? (
            <JoinForm online submitLabel="Create account" onSubmit={sent} />
          ) : (
            <SignInForm
              online
              initialUsername=""
              onSubmit={sent}
              onSso={sent}
            />
          ),
        );
        typeCredentials("reviewer");
        if (frozen) act(() => freeze());
        expect(pageFormRegistry.frozen()).toBe(frozen);
        await act(async () => {
          if (kind === "sso")
            fireEvent.click(
              screen.getByRole("button", {
                name: "Use single sign-on instead",
              }),
            );
          else fireEvent.submit(formOf());
        });
        expect(sent).toHaveBeenCalledTimes(frozen ? 0 : 1);
      });

  for (const kind of ["sign-in", "join"] as const)
    for (const frozen of [false, true])
      test(`${frozen ? "FROZEN" : "CONTROL"}: ${kind} by requestSubmit (Enter, a script) is admitted at the same boundary`, async () => {
        const sent = vi.fn(async () => ({ kind: "cancelled" as const }));
        render(
          kind === "join" ? (
            <JoinForm online submitLabel="Create account" onSubmit={sent} />
          ) : (
            <SignInForm
              online
              initialUsername=""
              onSubmit={sent}
              onSso={sent}
            />
          ),
        );
        typeCredentials("reviewer");
        if (frozen) act(() => freeze());
        await act(async () => formOf().requestSubmit());
        expect(sent).toHaveBeenCalledTimes(frozen ? 0 : 1);
        // Refused or not, the typed username is still the form's.
        expect(username().value).toBe("reviewer");
      });
});

describe("Q3: work admitted before the freeze is waited for, and settled by its own outcome (I3/I4)", () => {
  test("a sign-in held across the acceptance: no reload while it is outstanding; a refusal leaves the username unfinished, so the page stays", async () => {
    const { origin, tab, waiting } = await world();
    const signIn = held<SignInResult>();
    render(
      <SignInForm
        online
        initialUsername=""
        onSubmit={signIn.call}
        onSso={vi.fn()}
      />,
    );
    typeCredentials("alice");
    await act(async () => fireEvent.submit(formOf()));
    expect(signIn.entered()).toBe(1);
    expect(pageFormRegistry.pending()).toBe(1);
    await accept(origin, tab);
    expect(tab.state).toEqual({ kind: "saving" });
    await act(async () => origin.activate(waiting));
    expect(tab.reloads).toBe(0);
    await act(async () => {
      signIn.resolve({ kind: "failed", message: { id: "unreachable" } });
      await origin.clock.advance(1);
    });
    expect(pageFormRegistry.pending()).toBe(0);
    expect(tab.reloads).toBe(0);
    expect(tab.state).toEqual({ kind: "kept_input" });
    expect(username().value).toBe("alice");
    expect(pageFormRegistry.frozen()).toBe(false);
  });

  test("CONTROL: the same sign-in settled durably consumed what it sent: the act goes on and reloads", async () => {
    const { origin, tab, waiting } = await world();
    const signIn = held<SignInResult>();
    render(
      <SignInForm
        online
        initialUsername=""
        onSubmit={signIn.call}
        onSso={vi.fn()}
      />,
    );
    typeCredentials("alice");
    await act(async () => fireEvent.submit(formOf()));
    await accept(origin, tab);
    expect(tab.reloads).toBe(0);
    await act(async () => {
      signIn.resolve({ kind: "settled", method: "password" });
      await origin.clock.advance(FLUSH_START_GRACE_MS);
    });
    await act(async () => origin.activate(waiting));
    expect(tab.reloads).toBe(1);
  });

  test("the form unmounted by the gate is not a cancellation: the sign-in is waited for, and the unfinished username outlives the form", async () => {
    const { origin, tab, waiting } = await world();
    const signIn = held<SignInResult>();
    const view = render(
      <SignInForm
        online
        initialUsername=""
        onSubmit={signIn.call}
        onSso={vi.fn()}
      />,
    );
    typeCredentials("alice");
    await act(async () => fireEvent.submit(formOf()));
    view.unmount();
    // Revision 40 (R40-GATE; design assessment Q1): every dismissal the editor scheduled is decided (an acknowledgement, not a sleep).
    await act(async () => dismissalsDecided());
    expect(pageFormRegistry.pending()).toBe(1);
    await accept(origin, tab);
    await act(async () => origin.activate(waiting));
    expect(tab.reloads).toBe(0);
    expect(tab.state).toEqual({ kind: "saving" });
    await act(async () => {
      signIn.resolve({ kind: "gating" });
      await origin.clock.advance(FLUSH_START_GRACE_MS);
    });
    // Revision 40 adaptation (review of revision 39, R40-GATE harness finding; design assessment C2): was "nothing of it is on screen any
    // more, so the reload went on" (reloads 1); now the page stays (kept_input, no reload): `gating` is not a durable success, so the
    // username is still unfinished input, and the form that comes back for the journey shows it.
    expect(pageFormRegistry.pending()).toBe(0);
    expect(tab.reloads).toBe(0);
    expect(tab.state).toEqual({ kind: "kept_input" });
    render(
      <SignInForm
        online
        initialUsername=""
        onSubmit={signIn.call}
        onSso={vi.fn()}
      />,
    );
    expect(username().value).toBe("alice");
    expect(signIn.call).toHaveBeenCalledTimes(1);
  });

  test("single sign-on leaving for its provider stays outstanding: no reload over its navigation until the page is shown again", async () => {
    const { origin, tab, waiting } = await world();
    const sso = held<SsoResult>();
    render(
      <SignInForm
        online
        initialUsername=""
        onSubmit={vi.fn()}
        onSso={sso.call}
      />,
    );
    await act(async () =>
      fireEvent.click(
        screen.getByRole("button", { name: "Use single sign-on instead" }),
      ),
    );
    expect(sso.entered()).toBe(1);
    await accept(origin, tab);
    await act(async () => {
      sso.resolve({ kind: "navigating" });
      await origin.clock.advance(60_000);
    });
    await act(async () => origin.activate(waiting));
    expect(tab.reloads).toBe(0);
    expect(pageFormRegistry.pending()).toBe(1);
    // A return from the back-forward cache: the departure is over.
    await act(async () => {
      window.dispatchEvent(new Event("pageshow"));
      await origin.clock.advance(FLUSH_START_GRACE_MS);
    });
    expect(pageFormRegistry.pending()).toBe(0);
    expect(tab.reloads).toBe(1);
  });

  test.each([
    ["failed", { kind: "failed", message: { id: "unreachable" } }],
    ["cancelled", { kind: "cancelled" }],
    ["lock_timeout", { kind: "lock_timeout" }],
  ] as const)(
    "CONTROL: single sign-on that does not navigate (%s) ends its activity at once",
    async (_name, result) => {
      const { origin, tab, waiting } = await world();
      const sso = held<SsoResult>();
      render(
        <SignInForm
          online
          initialUsername=""
          onSubmit={vi.fn()}
          onSso={sso.call}
        />,
      );
      await act(async () =>
        fireEvent.click(
          screen.getByRole("button", { name: "Use single sign-on instead" }),
        ),
      );
      await accept(origin, tab);
      await act(async () => {
        sso.resolve(result as SsoResult);
        await origin.clock.advance(FLUSH_START_GRACE_MS);
      });
      expect(pageFormRegistry.pending()).toBe(0);
      await act(async () => origin.activate(waiting));
      expect(tab.reloads).toBe(1);
    },
  );

  test("single sign-on whose start throws ends its activity and keeps the form usable", async () => {
    const sso = held<SsoResult>();
    const errors: unknown[] = [];
    const onError = (event: PromiseRejectionEvent) => {
      errors.push(event.reason);
      event.preventDefault();
    };
    window.addEventListener("unhandledrejection", onError);
    const swallow = (reason: unknown) => errors.push(reason);
    process.on("unhandledRejection", swallow);
    try {
      render(
        <SignInForm
          online
          initialUsername=""
          onSubmit={vi.fn()}
          onSso={sso.call}
        />,
      );
      await act(async () =>
        fireEvent.click(
          screen.getByRole("button", { name: "Use single sign-on instead" }),
        ),
      );
      expect(pageFormRegistry.pending()).toBe(1);
      await act(async () => {
        sso.reject(new Error("navigation refused"));
        await flush();
      });
      expect(pageFormRegistry.pending()).toBe(0);
      expect(
        screen.getByRole("button", { name: "Use single sign-on instead" }),
      ).toBeEnabled();
    } finally {
      window.removeEventListener("unhandledrejection", onError);
      process.off("unhandledRejection", swallow);
    }
  });

  test("a registration held across the acceptance: waited for; a usable-invitation refusal leaves the username, so the page stays", async () => {
    const { origin, tab, waiting } = await world();
    const register = held<RegisterResult>();
    render(
      <JoinForm online submitLabel="Create account" onSubmit={register.call} />,
    );
    typeCredentials("new-person");
    await act(async () => fireEvent.submit(formOf()));
    expect(pageFormRegistry.pending()).toBe(1);
    await accept(origin, tab);
    await act(async () => origin.activate(waiting));
    expect(tab.reloads).toBe(0);
    await act(async () => {
      register.resolve({
        kind: "failed",
        message: { id: "username_taken" as never },
      });
      await origin.clock.advance(1);
    });
    expect(tab.reloads).toBe(0);
    expect(tab.state).toEqual({ kind: "kept_input" });
    expect(username().value).toBe("new-person");
  });
});

describe("Q2/Q4: unfinished input that no reload brings back stops the update (R40-COMPOSITION; C1, I1/I2)", () => {
  const preview = () =>
    attemptsDouble({
      previewInvitation: vi.fn(async () => ({
        kind: "ok" as const,
        household: null,
        expires_at: "2026-12-31T00:00:00.000Z",
      })),
    });

  function join(attempts = preview()) {
    invitationMemory.set(TOKEN);
    const session = sessionDouble({}, { attempts });
    render(
      <SessionProvider session={session}>
        <JoinSurface />
      </SessionProvider>,
    );
    return attempts;
  }

  test("Join: a typed username, an accepted update: no save, no reload; the form and its input stay, and the notice says why", async () => {
    const attempts = join();
    await screen.findByRole("heading", {
      name: "You're invited to join Atlas",
    });
    const { origin, tab, waiting } = await world();
    typeCredentials("reviewer-join");
    await accept(origin, tab);
    await act(async () => origin.activate(waiting));
    expect(tab.reloads).toBe(0);
    expect(tab.state).toEqual({ kind: "kept_input" });
    expect(noticeOf(tab.state, "neutral")?.text).toBe(KEPT_INPUT_TEXT);
    expect(
      noticeOf(tab.state, "neutral")?.choices.map((choice) => choice.label),
    ).toEqual(["Reload", "Discard and reload anyway"]);
    expect(username().value).toBe("reviewer-join");
    expect(screen.getByLabelText("Password")).toHaveValue(PASSWORD);
    // Nothing was sent, and nothing written anywhere: no invitation, no password, not even the username.
    expect(attempts.begin).not.toHaveBeenCalled();
    expect(Object.keys(window.sessionStorage)).toEqual([]);
    expect(Object.keys(window.localStorage)).toEqual([]);
    expect(await store().list("join")).toEqual([]);
    expect(pageFormRegistry.frozen()).toBe(false);
    // Still editable after the stop (the freeze was released).
    fireEvent.change(username(), { target: { value: "reviewer-join-2" } });
    expect(username().value).toBe("reviewer-join-2");
  });

  test('Join: "Reload" again re-checks: still unfinished, it stays; cleared, it reloads', async () => {
    join();
    await screen.findByRole("heading", {
      name: "You're invited to join Atlas",
    });
    const { origin, tab, waiting } = await world();
    fireEvent.change(username(), { target: { value: "reviewer-join" } });
    await accept(origin, tab);
    expect(tab.state).toEqual({ kind: "kept_input" });
    await act(async () => {
      tab.actions?.retrySave();
      await origin.clock.advance(FLUSH_START_GRACE_MS);
    });
    expect(tab.state).toEqual({ kind: "kept_input" });
    expect(tab.reloads).toBe(0);
    fireEvent.change(username(), { target: { value: "" } });
    await act(async () => {
      tab.actions?.retrySave();
      await origin.clock.advance(FLUSH_START_GRACE_MS);
    });
    await act(async () => origin.activate(waiting));
    expect(tab.reloads).toBe(1);
  });

  test('Join: "Discard and reload anyway" is the person\'s explicit choice: it reloads', async () => {
    join();
    await screen.findByRole("heading", {
      name: "You're invited to join Atlas",
    });
    const { origin, tab, waiting } = await world();
    fireEvent.change(username(), { target: { value: "reviewer-join" } });
    await accept(origin, tab);
    expect(tab.state).toEqual({ kind: "kept_input" });
    await act(async () => {
      tab.actions?.discardAndReload();
      await origin.clock.advance(FLUSH_START_GRACE_MS);
    });
    await act(async () => origin.activate(waiting));
    expect(tab.reloads).toBe(1);
  });

  test("CONTROL: Join untouched (nothing typed) reloads at once", async () => {
    join();
    await screen.findByRole("heading", {
      name: "You're invited to join Atlas",
    });
    const { origin, tab, waiting } = await world();
    await accept(origin, tab);
    await act(async () => origin.activate(waiting));
    expect(tab.reloads).toBe(1);
  });

  test("Join: after a submission whose result is unknown, the sign-in guidance (page memory) holds the update until it is acted on", async () => {
    join(
      attemptsDouble({
        previewInvitation: vi.fn(async () => ({
          kind: "ok" as const,
          household: null,
          expires_at: "2026-12-31T00:00:00.000Z",
        })),
        registerWithInvitation: vi.fn(async () => ({
          kind: "exchange_failed" as const,
          status: null,
        })),
      }),
    );
    await screen.findByRole("heading", {
      name: "You're invited to join Atlas",
    });
    typeCredentials("new-person");
    await act(async () => fireEvent.submit(formOf()));
    await screen.findByText(LOST_RESPONSE);
    const { origin, tab, waiting } = await world();
    await accept(origin, tab);
    await act(async () => origin.activate(waiting));
    expect(tab.state).toEqual({ kind: "kept_input" });
    expect(tab.reloads).toBe(0);
    expect(screen.getByText(LOST_RESPONSE)).toBeInTheDocument();
  });

  test("public sign-in: a typed username stops the update (labelled change from revision 38: no session-storage copy is made or restored)", async () => {
    const session = sessionDouble();
    render(
      <SessionProvider session={session}>
        <SignInSurface mode="signed_out" />
      </SessionProvider>,
    );
    const { origin, tab, waiting } = await world();
    typeCredentials("alice");
    await accept(origin, tab);
    await act(async () => origin.activate(waiting));
    expect(tab.reloads).toBe(0);
    expect(tab.state).toEqual({ kind: "kept_input" });
    expect(username().value).toBe("alice");
    expect(Object.keys(window.sessionStorage)).toEqual([]);
  });

  test("CONTROL: public sign-in untouched reloads", async () => {
    render(
      <SessionProvider session={sessionDouble()}>
        <SignInSurface mode="signed_out" />
      </SessionProvider>,
    );
    const { origin, tab, waiting } = await world();
    await accept(origin, tab);
    await act(async () => origin.activate(waiting));
    expect(tab.reloads).toBe(1);
  });

  test("sign-in requested from Join with the chosen username (page memory): the update waits; without one, it reloads", async () => {
    signInRequest.request("chosen-name");
    const view = render(
      <SessionProvider session={sessionDouble()}>
        <SignInSurface mode="signed_out" />
      </SessionProvider>,
    );
    expect(username().value).toBe("chosen-name");
    const { origin, tab, waiting } = await world();
    await accept(origin, tab);
    expect(tab.state).toEqual({ kind: "kept_input" });
    view.unmount();
    signInRequest.clear();
    render(
      <SessionProvider session={sessionDouble()}>
        <SignInSurface mode="signed_out" />
      </SessionProvider>,
    );
    await act(async () => {
      tab.actions?.retrySave();
      await origin.clock.advance(FLUSH_START_GRACE_MS);
    });
    await act(async () => origin.activate(waiting));
    expect(tab.reloads).toBe(1);
  });
});

describe("DA-AUTH-HOSTS: each sign-in host has its own unfinished username (I6)", () => {
  test("a switch's and a confirmation's forms never share the public page's model, nor each other's", () => {
    render(
      protectedTree(
        <>
          <SignInForm
            online
            initialUsername=""
            onSubmit={vi.fn()}
            onSso={vi.fn()}
            recoveryContext="sign-in:switch"
          />
          <SignInForm
            online
            initialUsername="kieran"
            usernameReadOnly
            onSubmit={vi.fn()}
            onSso={vi.fn()}
            recoveryContext="sign-in:confirm"
          />
        </>,
      ),
    );
    const [switching, confirming] = screen.getAllByRole("textbox", {
      name: "Username",
    }) as HTMLInputElement[];
    fireEvent.change(switching as HTMLInputElement, {
      target: { value: "sam" },
    });
    expect(contextsOf(pageFormRegistry.dirty())).toEqual(["sign-in:switch"]);
    expect(confirming?.value).toBe("kieran");
  });
});

describe("DA-AUTH-LINK: linking single sign-on from Settings is admitted at the gesture (C2, I3)", () => {
  const account = (): AccountSummary =>
    ({
      account_id: "acct-1",
      username: "kieran",
      has_password: true,
      oidc_issuers: [],
    }) as unknown as AccountSummary;

  for (const frozen of [false, true])
    test(`${frozen ? "FROZEN" : "CONTROL"}: Link single sign-on ${frozen ? "starts nothing" : "starts the link"}`, async () => {
      const attempts = attemptsDouble();
      const navigate = vi.fn();
      render(
        <SessionProvider session={sessionDouble({}, { attempts })}>
          <LinkedIdentities
            account={account()}
            currentSessionStartedAt={new Date().toISOString()}
            navigate={navigate}
          />
        </SessionProvider>,
      );
      if (frozen) act(() => freeze());
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: "Link single sign-on" }),
        );
        await flush();
      });
      expect(attempts.begin).toHaveBeenCalledTimes(frozen ? 0 : 1);
      expect(navigate).toHaveBeenCalledTimes(frozen ? 0 : 1);
      // Leaving for the provider stays outstanding work of the page (no update reload over it).
      expect(pageFormRegistry.pending()).toBe(frozen ? 0 : 1);
    });
});
