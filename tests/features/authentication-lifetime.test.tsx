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
import { SessionRoot } from "../../src/app/SessionRoot";
import { authFeedback } from "../../src/features/authentication/feedback";
import { invitationMemory } from "../../src/features/authentication/handoff";
import {
  EARLIER_HEADING,
  LOST_RESPONSE,
} from "../../src/features/authentication/JoinSurface";
import { SignInForm } from "../../src/features/authentication/SignInForm";
import { signInRequest } from "../../src/features/authentication/sign-in-request";
import {
  dismissalsDecided,
  endPreAccountInput,
  settlePreAccountInput,
} from "../../src/lib/form-recovery/editor";
import { handoffHandles } from "../../src/lib/form-recovery/handoff";
import { pageFormRegistry } from "../../src/lib/form-recovery/registry";
import { FLUSH_START_GRACE_MS } from "../../src/lib/pwa/coordinator";
import {
  type AttemptOutcome,
  SessionProvider,
  type SessionView,
} from "../../src/session";
import { installMatchMedia } from "../helpers/match-media";
import { attemptsDouble, sessionDouble } from "../helpers/session-double";
import { FakeOrigin, type Tab } from "../pwa/coordinator-world";
import {
  forgetRecoveryWorld,
  installRecoveryLocks,
} from "../support/recovery-editors";

/**
 * WEB-14a revision 40: the review of revision 39 (R40-GATE, `production-form-update-recovery-registration`) and its design assessment
 * (token ae2a506e…, C1/C2, I1-I4, Q1). The REAL `SessionRoot`, its public sign-in and join surfaces, the authentication controller, the
 * page's form registry and the app-update coordinator (`startAppUpdates` over the deterministic worker/channel world); only the session's
 * public view and attempt outcomes are doubles, each held and released by the test. The review's independent witness
 * (`.agtx/evidence/review-r39-20261027/auth-lifetime.test.tsx`) is promoted here, its 5 ms sleep replaced by the editor's explicit
 * acknowledgement that every scheduled dismissal has been decided (`dismissalsDecided`). This is composition evidence over doubles, not a
 * native-browser or released-backend execution.
 */
installMatchMedia({ width: 1440 });
beforeAll(installRecoveryLocks);
beforeEach(() => {
  invitationMemory.clear();
  authFeedback.clearOnBegin();
  signInRequest.clear();
});
const tabs: Tab[] = [];
afterEach(() => {
  for (const t of tabs.splice(0)) t.coordinator?.dispose();
  forgetRecoveryWorld();
  invitationMemory.clear();
  authFeedback.clearOnBegin();
  signInRequest.clear();
  window.sessionStorage.clear();
});

const PASSWORD = "NeverPersistTheSecret1!";
const TOKEN = "b".repeat(64);
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
  let calls = 0;
  const answer = new Promise<T>((yes) => {
    resolve = yes;
  });
  const call = vi.fn(() => {
    calls += 1;
    return answer;
  });
  return { call, entered: () => calls, resolve };
}

/** The session's public view, set by the test. */
function liveView(initial: SessionView) {
  let current = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(next: SessionView) {
      current = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

async function world() {
  const origin = new FakeOrigin();
  const tab = origin.tab();
  Object.assign(tab, { forms: pageFormRegistry });
  await tab.start();
  tabs.push(tab);
  const waiting = await origin.installNew(2);
  return { origin, tab, waiting };
}
async function accept(origin: FakeOrigin, tab: Tab): Promise<void> {
  await act(async () => {
    tab.actions?.accept();
    await origin.clock.advance(FLUSH_START_GRACE_MS);
  });
}

const SIGNED_OUT: SessionView = { kind: "signed_out", state: null };
const FINISHING: SessionView = { kind: "neutral", state: "1c.finishing" };
const refusal = (code = "device_capacity"): AttemptOutcome => ({
  kind: "refused",
  definitive: true,
  stage: "activation",
  error: { code, message: "refused", request_id: "r40" },
});
const settled: AttemptOutcome = {
  kind: "settled",
  account_id: "acct",
  epoch: 1,
  method: "password",
};

/** The page holds input that no reload brings back (an unrestorable, dirty participant of the registry). */
const stranded = () =>
  handoffHandles(pageFormRegistry).some(
    (h) => h.restorable?.() === false && h.isDirty(),
  );

function root(
  signIn: ReturnType<typeof held<AttemptOutcome>>,
  view = liveView(SIGNED_OUT),
  pathname = "/",
  over: Partial<Parameters<typeof attemptsDouble>[0]> = {},
) {
  const attempts = attemptsDouble({
    signInWithPassword: signIn.call,
    registerWithInvitation: signIn.call,
    ...over,
  });
  const session = sessionDouble({}, { view, attempts } as never);
  render(
    <SessionProvider session={session}>
      <SessionRoot pathname={pathname} />
    </SessionProvider>,
  );
  return { view, attempts };
}

/** The gate removes the form; every dismissal the editor scheduled is decided before anything else happens. */
async function gate(view: ReturnType<typeof liveView>) {
  act(() => view.set(FINISHING));
  expect(screen.queryByRole("textbox", { name: "Username" })).toBeNull();
  await act(async () => dismissalsDecided());
}

describe("R40-GATE (Q1): the public sign-in through a gate, both delivery orders, with the review's controls", () => {
  for (const order of [
    "CONTROL no gate",
    "view first",
    "outcome first",
    "CONTROL settled",
  ] as const)
    test(`${order}: ${order === "CONTROL settled" ? "a durable success consumed the username: the update reloads" : "a refusal keeps the exact username; no reload; kept_input; one send"}`, async () => {
      const { origin, tab, waiting } = await world();
      const signIn = held<AttemptOutcome>();
      const { view, attempts } = root(signIn);
      typeCredentials("alice");
      await act(async () => fireEvent.submit(formOf()));
      expect(signIn.entered()).toBe(1);
      expect(pageFormRegistry.pending()).toBe(1);
      if (order !== "CONTROL no gate") await gate(view);
      await accept(origin, tab);
      await act(async () => origin.activate(waiting));
      expect(tab.reloads).toBe(0);
      expect(pageFormRegistry.pending()).toBe(1);
      if (order === "view first") act(() => view.set(SIGNED_OUT));
      await act(async () => {
        signIn.resolve(order === "CONTROL settled" ? settled : refusal());
        await origin.clock.advance(FLUSH_START_GRACE_MS);
      });
      if (order === "CONTROL settled") {
        expect(tab.reloads).toBe(1);
        return;
      }
      if (order === "outcome first") act(() => view.set(SIGNED_OUT));
      expect(pageFormRegistry.pending()).toBe(0);
      expect(tab.reloads).toBe(0);
      expect(username().value).toBe("alice");
      expect(tab.state).toEqual({ kind: "kept_input" });
      expect(attempts.signInWithPassword).toHaveBeenCalledTimes(1);
      // The password is never part of what comes back.
      expect(
        (screen.getByLabelText("Password") as HTMLInputElement).value,
      ).toBe("");
    });

  test("the gate unresolved: the form comes back before the outcome, with the exact username; the send is still outstanding work", async () => {
    const { origin, tab, waiting } = await world();
    const signIn = held<AttemptOutcome>();
    const { view } = root(signIn);
    typeCredentials("alice");
    await act(async () => fireEvent.submit(formOf()));
    await gate(view);
    act(() => view.set(SIGNED_OUT));
    expect(username().value).toBe("alice");
    expect(pageFormRegistry.pending()).toBe(1);
    await accept(origin, tab);
    await act(async () => origin.activate(waiting));
    expect(tab.reloads).toBe(0);
    await act(async () => {
      signIn.resolve(refusal());
      await origin.clock.advance(FLUSH_START_GRACE_MS);
    });
    expect(tab.reloads).toBe(0);
    expect(tab.state).toEqual({ kind: "kept_input" });
    expect(username().value).toBe("alice");
  });

  test("no view comes back: the refusal ends the send, and the username no form shows still stops the reload", async () => {
    const { origin, tab, waiting } = await world();
    const signIn = held<AttemptOutcome>();
    const { view } = root(signIn);
    typeCredentials("alice");
    await act(async () => fireEvent.submit(formOf()));
    await gate(view);
    await accept(origin, tab);
    await act(async () => origin.activate(waiting));
    await act(async () => {
      signIn.resolve(refusal());
      await origin.clock.advance(FLUSH_START_GRACE_MS);
    });
    expect(screen.queryByRole("textbox", { name: "Username" })).toBeNull();
    expect(pageFormRegistry.pending()).toBe(0);
    expect(stranded()).toBe(true);
    expect(tab.reloads).toBe(0);
    expect(tab.state).toEqual({ kind: "kept_input" });
    // When it does come back, the username is there.
    act(() => view.set(SIGNED_OUT));
    expect(username().value).toBe("alice");
  });

  test("newer input after the return: a late success of the earlier send never covers it, and a late refusal never resets it", async () => {
    for (const late of [settled, refusal()]) {
      const signIn = held<AttemptOutcome>();
      const { view } = root(signIn);
      typeCredentials("alice");
      await act(async () => fireEvent.submit(formOf()));
      await gate(view);
      act(() => view.set(SIGNED_OUT));
      fireEvent.change(username(), { target: { value: "alice2" } });
      await act(async () => signIn.resolve(late));
      expect(username().value).toBe("alice2");
      // Still the person's unfinished input.
      expect(stranded()).toBe(true);
      forgetRecoveryWorld();
    }
  });

  test("an account displays (identity settled): what was typed to sign in is over; an editor still shown is left alone", async () => {
    const signIn = held<AttemptOutcome>();
    const { view } = root(signIn);
    typeCredentials("alice");
    await gate(view);
    expect(stranded()).toBe(true);
    act(() => view.set({ kind: "displaying", account_id: "acct", epoch: 1 }));
    expect(stranded()).toBe(false);
    // CONTROL: a sweep never ends input an editor shows now.
    act(() => view.set(SIGNED_OUT));
    fireEvent.change(username(), { target: { value: "bob" } });
    settlePreAccountInput(() => true);
    expect(username().value).toBe("bob");
    expect(stranded()).toBe(true);
  });
});

describe("R40-GATE (Q1): the neutral sign-in (`sign-in:again`) and its Back", () => {
  test("a gate keeps its username for its own return; Back is the person's cancellation and ends it; the public form never inherits it", async () => {
    const { origin, tab, waiting } = await world();
    const signIn = held<AttemptOutcome>();
    const view = liveView({ kind: "neutral", state: "1b" });
    root(signIn, view);
    act(() => signInRequest.request());
    typeCredentials("carol");
    // A gate clears the request (the card returns later); the username stays the neutral journey's.
    await gate(view);
    act(() => view.set({ kind: "neutral", state: "1b" }));
    expect(stranded()).toBe(true);
    act(() => signInRequest.request());
    expect(username().value).toBe("carol");
    // The public page's own form is another journey: it starts empty.
    act(() => {
      signInRequest.clear();
      view.set(SIGNED_OUT);
    });
    expect(username().value).toBe("");
    act(() => {
      view.set({ kind: "neutral", state: "1b" });
      signInRequest.request();
    });
    expect(username().value).toBe("carol");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await act(async () => dismissalsDecided());
    expect(stranded()).toBe(false);
    await accept(origin, tab);
    await act(async () => origin.activate(waiting));
    expect(tab.reloads).toBe(1);
  });
});

describe("R40-GATE (Q1, C2): joining through a gate", () => {
  test("an activation refusal after the gate: the guidance carries the username; the page holds it continuously through Sign in; no reload", async () => {
    const { origin, tab, waiting } = await world();
    invitationMemory.set(TOKEN);
    const register = held<AttemptOutcome>();
    const view = liveView(SIGNED_OUT);
    root(register, view, "/join");
    await screen.findByRole("textbox", { name: "Username" });
    typeCredentials("dana");
    await act(async () => fireEvent.submit(formOf()));
    expect(register.entered()).toBe(1);
    await gate(view);
    await accept(origin, tab);
    await act(async () => origin.activate(waiting));
    expect(tab.reloads).toBe(0);
    await act(async () => {
      register.resolve(refusal());
      await origin.clock.advance(FLUSH_START_GRACE_MS);
    });
    // The surface is still unmounted: the page memory holds the guidance (no component effect does).
    expect(stranded()).toBe(true);
    act(() => view.set(SIGNED_OUT));
    expect(screen.getByText(LOST_RESPONSE)).toBeTruthy();
    expect(tab.reloads).toBe(0);
    expect(tab.state).toEqual({ kind: "kept_input" });
    // The guidance hands the username to the sign-in request in the same step: never unheld.
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(stranded()).toBe(true);
    expect(username().value).toBe("dana");
    expect(register.call).toHaveBeenCalledTimes(1);
  });

  test("a newer link replaces the page: the earlier link's username ends, even before the newer link's form can show", async () => {
    invitationMemory.set(TOKEN);
    const register = held<AttemptOutcome>();
    const view = liveView(SIGNED_OUT);
    const newer = "c".repeat(64);
    const preview =
      held<
        Awaited<
          ReturnType<ReturnType<typeof attemptsDouble>["previewInvitation"]>
        >
      >();
    root(register, view, "/join", {
      previewInvitation: vi.fn(async (token: string) =>
        token === newer
          ? preview.call()
          : {
              kind: "ok" as const,
              household: null,
              expires_at: "2026-12-31T00:00:00Z",
            },
      ),
    });
    await screen.findByRole("textbox", { name: "Username" });
    typeCredentials("erin");
    expect(stranded()).toBe(true);
    act(() => invitationMemory.set(newer));
    // The newer link's preview is still loading: no form shows, and nothing of the earlier link's is left unfinished (it was never
    // submitted: no guidance either).
    expect(screen.queryByRole("textbox", { name: "Username" })).toBeNull();
    expect(stranded()).toBe(false);
    await act(async () =>
      preview.resolve({
        kind: "ok",
        household: null,
        expires_at: "2026-12-31T00:00:00Z",
      }),
    );
    await screen.findByRole("textbox", { name: "Username" });
    expect(username().value).toBe("");
    fireEvent.change(username(), { target: { value: "fred" } });
    expect(username().value).toBe("fred");
  });

  test("an earlier link's guidance beside a newer link's untouched form: the guidance alone holds the update until it is dismissed", async () => {
    const { origin, tab, waiting } = await world();
    invitationMemory.set(TOKEN);
    const register = held<AttemptOutcome>();
    const view = liveView(SIGNED_OUT);
    root(register, view, "/join");
    await screen.findByRole("textbox", { name: "Username" });
    typeCredentials("gina");
    await act(async () => fireEvent.submit(formOf()));
    await gate(view);
    await act(async () => register.resolve(refusal()));
    act(() => view.set(SIGNED_OUT));
    expect(screen.getByText(LOST_RESPONSE)).toBeTruthy();
    // A newer link: the earlier link's username ends; what its submission left is told beside the newer form, which is untouched.
    act(() => invitationMemory.set("c".repeat(64)));
    await screen.findByRole("textbox", { name: "Username" });
    expect(username().value).toBe("");
    expect(screen.getByText(EARLIER_HEADING, { exact: false })).toBeTruthy();
    await accept(origin, tab);
    await act(async () => origin.activate(waiting));
    expect(tab.reloads).toBe(0);
    expect(tab.state).toEqual({ kind: "kept_input" });
    // Read and dismissed: nothing is left that no reload brings back.
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await act(async () => {
      tab.actions?.retrySave();
      await origin.clock.advance(FLUSH_START_GRACE_MS);
    });
    await act(async () => origin.activate(waiting));
    expect(tab.reloads).toBe(1);
  });
});

describe("R40-GATE (C1): journeys of one host, and a host's explicit close", () => {
  const form = (journey: string) => (
    <SignInForm
      online
      initialUsername=""
      onSubmit={vi.fn()}
      onSso={vi.fn()}
      recoveryContext="sign-in:switch"
      journey={journey}
    />
  );
  test("the same journey's username comes back after an unmount; another journey's never does, and ends it", async () => {
    const first = render(form("kieran:other"));
    fireEvent.change(username(), { target: { value: "sam" } });
    first.unmount();
    await act(async () => dismissalsDecided());
    expect(stranded()).toBe(true);
    const again = render(form("kieran:other"));
    expect(username().value).toBe("sam");
    again.unmount();
    render(form("kieran:retained-1"));
    expect(username().value).toBe("");
    expect(stranded()).toBe(false);
  });

  test("the host's close (Escape, Close) ends that journey's username only", async () => {
    const view = render(form("kieran:other"));
    fireEvent.change(username(), { target: { value: "sam" } });
    act(() => endPreAccountInput("sign-in:switch", "kieran:retained-1"));
    expect(stranded()).toBe(true);
    act(() => endPreAccountInput("sign-in:switch", "kieran:other"));
    view.unmount();
    await act(async () => dismissalsDecided());
    expect(stranded()).toBe(false);
  });

  test("CONTROL: a read-only confirmation username (its baseline) is never an unfinished obligation after a gate", async () => {
    const view = render(
      <SignInForm
        online
        initialUsername="kieran"
        usernameReadOnly
        onSubmit={vi.fn()}
        onSso={vi.fn()}
        recoveryContext="sign-in:confirm"
        journey="acct:1"
      />,
    );
    view.unmount();
    await act(async () => dismissalsDecided());
    expect(stranded()).toBe(false);
  });
});
