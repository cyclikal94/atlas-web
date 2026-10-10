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
import { MESSAGE_TEXT } from "../../../src/features/authentication/outcome-copy";
import { SignInSurface } from "../../../src/features/authentication/SignInSurface";
import { signInRequest } from "../../../src/features/authentication/sign-in-request";
import { type AttemptOutcome, SessionProvider } from "../../../src/session";
import { attemptsDouble, sessionDouble } from "../../helpers/session-double";

const setOnline = (value: boolean) =>
  Object.defineProperty(navigator, "onLine", { value, configurable: true });

beforeEach(() => {
  setOnline(true);
  authFeedback.clearOnBegin();
  signInRequest.clear();
});
afterEach(() => {
  cleanup();
  setOnline(true);
  authFeedback.clearOnBegin();
  signInRequest.clear();
});

const refusal = (code: string, stage: "exchange" | "activation" = "exchange") =>
  ({
    kind: "refused",
    definitive: true,
    stage,
    error: { code, message: "SERVER TEXT", request_id: "req-9" },
  }) satisfies AttemptOutcome;

function mount(
  over: Parameters<typeof attemptsDouble>[0] = {},
  props: Partial<Parameters<typeof SignInSurface>[0]> = {},
) {
  const attempts = attemptsDouble(over);
  const navigate = vi.fn();
  const session = sessionDouble({}, { attempts });
  const view = render(
    <SessionProvider session={session}>
      <SignInSurface mode="signed_out" navigate={navigate} {...props} />
    </SessionProvider>,
  );
  return { attempts, navigate, ...view };
}

const fill = (username: string, password: string) => {
  fireEvent.change(screen.getByLabelText("Username"), {
    target: { value: username },
  });
  fireEvent.change(screen.getByLabelText("Password"), {
    target: { value: password },
  });
};
const submit = () =>
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

/** C-SIGNIN: the production sign-in surface. */
describe("the sign-in surface", () => {
  // Review R1: between the exchange and the activation the neutral gate has the form unmounted, so a refusal that arrives
  // afterwards is carried in page memory and shown by the form that mounts next.
  test("a refusal carried across the gate is shown by the form that mounts, once, and taken", async () => {
    authFeedback.carryFailure({ id: "device_capacity", requestId: "req-gate" });
    const { unmount } = mount();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(MESSAGE_TEXT.device_capacity);
    expect(alert).toHaveTextContent("Request ID: req-gate");
    expect(authFeedback.carriedFailure()).toBeNull();
    expect(screen.getByLabelText("Password")).toHaveValue("");
    unmount();
    // A later form does not show it again.
    mount();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("a carried wrong password is the password field's own message, with focus", async () => {
    authFeedback.carryFailure({ id: "bad_credentials" });
    mount();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(MESSAGE_TEXT.bad_credentials);
    const password = screen.getByLabelText("Password");
    expect(password).toHaveAttribute("aria-invalid", "true");
    expect(password.getAttribute("aria-describedby")).toBe(alert.id);
  });

  test("a refusal produced while the form is mounted is shown once (the carried copy and the result are one)", async () => {
    mount({
      signInWithPassword: vi.fn(async () => refusal("unauthenticated")),
    });
    fill("kieran", "wrong-password");
    submit();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      MESSAGE_TEXT.bad_credentials,
    );
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(authFeedback.carriedFailure()).toBeNull();
  });

  test("a labelled form with the right autocomplete tokens, 44 px controls and no account data", async () => {
    const { container } = mount();
    expect(
      screen.getByRole("heading", { level: 1, name: "Sign in to Atlas" }),
    ).toHaveFocus();
    const username = screen.getByLabelText("Username");
    const password = screen.getByLabelText("Password");
    expect(username).toHaveAttribute("autocomplete", "username");
    expect(username).toHaveAttribute("maxlength", "100");
    expect(username).toHaveAttribute("autocapitalize", "none");
    expect(password).toHaveAttribute("type", "password");
    expect(password).toHaveAttribute("autocomplete", "current-password");
    for (const control of [
      username,
      password,
      screen.getByRole("button", { name: "Sign in" }),
      screen.getByRole("button", { name: "Use single sign-on instead" }),
    ])
      expect(control.className).toMatch(/min-h-11/);
    expect(container.querySelector("form")).not.toBeNull();
    // Nothing about any account: only the heading, the two fields and the two buttons.
    expect(container.textContent).toBe(
      "AtlasSign in to AtlasUsernamePasswordSign inUse single sign-on instead",
    );
    expect((await axe(container)).violations).toEqual([]);
  });

  test("reauthenticate mode: its own heading and a Back control", () => {
    const onBack = vi.fn();
    mount({}, { mode: "reauthenticate", onBack });
    expect(
      screen.getByRole("heading", { level: 1, name: "Sign in again" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  test("the standalone page has no Back", () => {
    mount();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  });

  test("a prefilled username comes from the sign-in request; a password never does", () => {
    signInRequest.request("newbie");
    mount();
    expect(screen.getByLabelText("Username")).toHaveValue("newbie");
    expect(screen.getByLabelText("Password")).toHaveValue("");
  });

  test("offline: the form is greyed and the submit is disabled with its reason; nothing is sent", () => {
    setOnline(false);
    const { attempts } = mount();
    expect(screen.getByLabelText("Username")).toBeDisabled();
    expect(screen.getByLabelText("Password")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeDisabled();
    expect(
      screen.getByText("Signing in needs a connection."),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Use single sign-on instead" }),
    ).toBeNull();
    fireEvent.submit(
      screen.getByLabelText("Username").closest("form") as Element,
    );
    expect(attempts.begin).not.toHaveBeenCalled();
  });

  test("the browser going offline and online again is followed", () => {
    mount();
    act(() => {
      setOnline(false);
      window.dispatchEvent(new Event("offline"));
    });
    expect(
      screen.getByText("Signing in needs a connection."),
    ).toBeInTheDocument();
    act(() => {
      setOnline(true);
      window.dispatchEvent(new Event("online"));
    });
    expect(screen.queryByText("Signing in needs a connection.")).toBeNull();
  });

  test("an empty or oversized field is refused before anything is sent, with the message beside the field", () => {
    const { attempts } = mount();
    submit();
    const username = screen.getByLabelText("Username");
    expect(username).toHaveAttribute("aria-invalid", "true");
    expect(username).toHaveFocus();
    expect(screen.getByRole("alert")).toHaveTextContent("Enter your username.");
    fill("kieran", "");
    submit();
    expect(screen.getByLabelText("Password")).toHaveFocus();
    expect(screen.getByRole("alert")).toHaveTextContent("Enter your password.");
    fill("kieran", "x".repeat(1025));
    submit();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "That password is too long.",
    );
    expect(attempts.begin).not.toHaveBeenCalled();
  });

  test("a valid submit trims the username, never the password, and clears the password afterwards", async () => {
    const { attempts } = mount({
      signInWithPassword: vi.fn(async () => refusal("unauthenticated")),
    });
    fill("  kieran  ", "  pw  ");
    submit();
    await waitFor(() =>
      expect(attempts.signInWithPassword).toHaveBeenCalledWith(
        expect.objectContaining({ method: "password" }),
        { username: "kieran", password: "  pw  " },
      ),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Password")).toHaveValue(""),
    );
  });

  test("a wrong password: the message is under the password field, which is invalid, described and focused; announced once", async () => {
    mount({
      signInWithPassword: vi.fn(async () => refusal("unauthenticated")),
    });
    fill("kieran", "WRONG-password");
    submit();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      `${MESSAGE_TEXT.bad_credentials} Request ID: req-9`,
    );
    const password = screen.getByLabelText("Password");
    expect(password).toHaveAttribute("aria-invalid", "true");
    expect(password.getAttribute("aria-describedby")).toBe(alert.id);
    expect(password).toHaveFocus();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    // The server's own words never reach the page.
    expect(document.body.textContent).not.toContain("SERVER TEXT");
  });

  test("a failed exchange and an activation refusal are different messages", async () => {
    const { unmount } = mount({
      signInWithPassword: vi.fn(async () => ({
        kind: "exchange_failed" as const,
        status: null,
      })),
    });
    fill("kieran", "pw");
    submit();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      MESSAGE_TEXT.unreachable,
    );
    unmount();
    mount({
      signInWithPassword: vi.fn(async () =>
        refusal("unauthenticated", "activation"),
      ),
    });
    fill("kieran", "pw");
    submit();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Your details were right, but this browser couldn't finish signing in.",
    );
    expect(
      screen.queryByText(MESSAGE_TEXT.bad_credentials, { exact: false }),
    ).toBeNull();
  });

  test("E-27: while a sign-in is in flight the submit is disabled with a reason and a second submit is ignored", async () => {
    let release: (outcome: AttemptOutcome) => void = () => undefined;
    const { attempts } = mount({
      signInWithPassword: vi.fn(
        () =>
          new Promise<AttemptOutcome>((resolve) => {
            release = resolve;
          }),
      ),
    });
    fill("kieran", "pw");
    submit();
    await screen.findByText("Signing in…");
    expect(screen.getByRole("button", { name: "Sign in" })).toBeDisabled();
    fireEvent.submit(
      screen.getByLabelText("Username").closest("form") as Element,
    );
    expect(attempts.signInWithPassword).toHaveBeenCalledTimes(1);
    await act(async () => release({ kind: "gating" }));
  });

  test("a superseded result shows the accepted banner above the form, dismissible", async () => {
    mount({
      signInWithPassword: vi.fn(async () => ({ kind: "superseded" as const })),
    });
    fill("kieran", "pw");
    submit();
    const banner = await screen.findByText(
      NEUTRAL_COPY["1c.superseded"].message,
    );
    expect(banner.closest("[data-feedback]")).toHaveAttribute(
      "data-feedback",
      "superseded",
    );
    expect(
      screen.getByText(`${NEUTRAL_COPY["1c.superseded"].heading}.`),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(
      screen.queryByText(NEUTRAL_COPY["1c.superseded"].message),
    ).toBeNull();
  });

  test("a busy lock shows the accepted 'another tab' wording", async () => {
    mount({ begin: vi.fn(async () => ({ kind: "lock_timeout" as const })) });
    fill("kieran", "pw");
    submit();
    expect(
      await screen.findByText(NEUTRAL_COPY["1c.lock_wait"].message),
    ).toBeInTheDocument();
    expect(
      screen.getByText(`${NEUTRAL_COPY["1c.lock_wait"].heading}.`),
    ).toBeInTheDocument();
  });

  test("a gating attempt leaves the form with nothing to say", async () => {
    mount({
      signInWithPassword: vi.fn(async () => ({ kind: "gating" as const })),
    });
    fill("kieran", "pw");
    submit();
    await waitFor(() =>
      expect(screen.getByLabelText("Password")).toHaveValue(""),
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("single sign-on navigates to the provider only after the module says so", async () => {
    const { navigate, attempts } = mount();
    fireEvent.click(
      screen.getByRole("button", { name: "Use single sign-on instead" }),
    );
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledExactlyOnceWith(
        "https://idp.example.test/authorize",
      ),
    );
    expect(attempts.begin).toHaveBeenCalledWith("oidc");
  });

  test("single sign-on that is not set up is answered plainly and does not break the page", async () => {
    const { navigate } = mount({
      startOidc: vi.fn(async () => ({
        kind: "refused" as const,
        status: 404,
        error: { code: "not_found", message: "x", request_id: "r" },
      })),
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Use single sign-on instead" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      MESSAGE_TEXT.sso_not_set_up,
    );
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Username")).toBeEnabled();
  });

  test("a failure banner from a landing is shown, in the closed wording", () => {
    authFeedback.add({
      kind: "message",
      tone: "problem",
      message: { id: "sso_landing_failed" },
    });
    mount();
    expect(
      screen.getByText(MESSAGE_TEXT.sso_landing_failed),
    ).toBeInTheDocument();
  });

  test("a surface leaving does not overwrite a title the protected tree has already set", () => {
    const { unmount } = mount();
    expect(document.title).toBe("Sign in · Atlas");
    document.title = "Today · Atlas"; // the tree mounted as the surface went
    unmount();
    expect(document.title).toBe("Today · Atlas");
  });

  test("the tab title is generic and goes back to plain Atlas", () => {
    const { unmount } = mount();
    expect(document.title).toBe("Sign in · Atlas");
    unmount();
    expect(document.title).toBe("Atlas");
  });
});
