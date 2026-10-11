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
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DataEnvProvider, type RetainedListing } from "../../../src/data";
import { authFeedback } from "../../../src/features/authentication/feedback";
import { OFFLINE_REASON } from "../../../src/features/authentication/SignInForm";
import { SwitchHost } from "../../../src/features/switch/entry";
import SwitchFlow, {
  SwitchPicker,
  SwitchSignIn,
} from "../../../src/features/switch/SwitchFlow";
import { switchFlow } from "../../../src/features/switch/state";
import { SWITCH_COPY } from "../../../src/features/switch/switch-copy";
import {
  type AttemptHandle,
  type BeginResult,
  type Session,
  SessionProvider,
} from "../../../src/session";
import { UiProviders } from "../../helpers/providers";
import {
  attemptsDouble,
  sessionDouble,
  store,
} from "../../helpers/session-double";
import { draftRow } from "../../support/data/rows";
import { type StubEnv, stubEnv } from "../../support/data/ui-env";

/**
 * WEB-08c §2.2: WF-SWITCH-01 (the local account picker) and WF-SWITCH-02 ("Sign in as …"), over doubles of the session and the data
 * environment. These prove what the screens do with each input; the switch protocol itself (row 7) is the kernel's and is shown by the
 * fake-world and real-engine lifecycle suites.
 */
// The browser listing reads real IndexedDB; the host's flow uses this stand-in (the picker's own tests pass the listing explicitly).
vi.mock("../../../src/data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/data")>()),
  listRetainedAccounts: async () => ({ kind: "ok", accounts: [] }),
}));

const OWNER = "acct";
const BOB = "22222222-2222-4222-8222-222222222222";
const CAROL = "33333333-3333-4333-8333-333333333333";

let online = true;
beforeEach(() => {
  online = true;
  vi.spyOn(navigator, "onLine", "get").mockImplementation(() => online);
  switchFlow.close();
  authFeedback.clearOnBegin();
});
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  switchFlow.close();
  await new Promise((resolve) => setTimeout(resolve, 0));
});

function mount(
  node: React.ReactNode,
  options: { session?: Session; env?: StubEnv } = {},
) {
  const session = options.session ?? sessionDouble();
  const env = options.env ?? stubEnv();
  const view = render(
    <SessionProvider session={session}>
      <UiProviders>
        <DataEnvProvider env={env}>{node}</DataEnvProvider>
      </UiProviders>
    </SessionProvider>,
  );
  return { session, env, ...view };
}

const listing =
  (result: RetainedListing | Promise<RetainedListing>) => async () =>
    result;

describe("WF-SWITCH-01, the account picker", () => {
  test("loading: skeleton rows under the title and the model note; nothing is listed yet", async () => {
    let release: (value: RetainedListing) => void = () => {};
    mount(
      <SwitchPicker
        owner={OWNER}
        onClose={() => {}}
        list={() =>
          new Promise<RetainedListing>((resolve) => {
            release = resolve;
          })
        }
      />,
    );
    const dialog = await screen.findByRole("dialog", {
      name: SWITCH_COPY.title,
    });
    expect(within(dialog).getByText(SWITCH_COPY.note)).toBeInTheDocument();
    expect(dialog.querySelector("[data-switch-loading]")).not.toBeNull();
    expect(within(dialog).getByText(SWITCH_COPY.loading)).toBeInTheDocument();
    expect(within(dialog).queryByRole("listbox")).toBeNull();
    await act(async () => release({ kind: "ok", accounts: [] }));
    expect(within(dialog).getByRole("listbox")).toBeInTheDocument();
  });

  test("populated: the current account (verified label, Signed in now, N waiting), each retained account as 'Used on this computer before', then 'Use a different account'", async () => {
    const env = stubEnv({
      drafts: [
        draftRow({ status: "queued" }),
        draftRow({ status: "in_flight" }),
      ],
    });
    env.setLabel("kieran");
    const { container } = mount(
      <SwitchPicker
        owner={OWNER}
        onClose={() => {}}
        list={listing({
          kind: "ok",
          accounts: [
            { account_id: BOB, lastVerifiedName: "sam", waiting: 3 },
            { account_id: CAROL, lastVerifiedName: null, waiting: 0 },
          ],
        })}
      />,
      { env },
    );
    const list = await screen.findByRole("listbox", {
      name: SWITCH_COPY.title,
    });
    const options = within(list).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      `Kkieran${SWITCH_COPY.signedInNow}2 waiting`,
      `Ssam${SWITCH_COPY.usedBefore}3 waiting`,
      SWITCH_COPY.unnamedRetained + SWITCH_COPY.usedBefore,
      `+${SWITCH_COPY.differentAccount}`,
    ]);
    // The current row is never a target.
    expect(options[0]).toHaveAttribute("aria-disabled", "true");
    expect(list).toHaveAttribute("aria-activedescendant", options[0]?.id);
    expect((await axe(container)).violations).toEqual([]);
  });

  test("MU-8C-03 (UI): no name is guessed: an unverified current label is 'This account', a retained account without a record is unnamed", async () => {
    mount(
      <SwitchPicker
        owner={OWNER}
        onClose={() => {}}
        list={listing({
          kind: "ok",
          accounts: [{ account_id: BOB, lastVerifiedName: null, waiting: 0 }],
        })}
      />,
    );
    const list = await screen.findByRole("listbox");
    expect(list.textContent).toContain(SWITCH_COPY.thisAccount);
    expect(list.textContent).toContain(SWITCH_COPY.unnamedRetained);
    expect(list.textContent).not.toContain(OWNER);
    expect(list.textContent).not.toContain(BOB);
  });

  test("empty (states.md E): only one account is linked; the action reads 'Add another account'", async () => {
    mount(
      <SwitchPicker
        owner={OWNER}
        onClose={() => {}}
        list={listing({ kind: "ok", accounts: [] })}
      />,
    );
    expect(await screen.findByText(SWITCH_COPY.onlyOne)).toBeInTheDocument();
    const options = within(screen.getByRole("listbox")).getAllByRole("option");
    expect(options).toHaveLength(2);
    expect(options[1]?.textContent).toContain(SWITCH_COPY.addAnother);
  });

  test("MU-8C-01 (UI): an unknown listing never says there are no other accounts; it offers the current account and another sign-in", async () => {
    mount(
      <SwitchPicker
        owner={OWNER}
        onClose={() => {}}
        list={listing({ kind: "unknown" })}
      />,
    );
    expect(
      await screen.findByText(SWITCH_COPY.unknownListing),
    ).toBeInTheDocument();
    expect(screen.queryByText(SWITCH_COPY.onlyOne)).toBeNull();
    const options = within(screen.getByRole("listbox")).getAllByRole("option");
    expect(options).toHaveLength(2);
    expect(options[1]?.textContent).toContain(SWITCH_COPY.differentAccount);
  });

  test("a listing that rejects is shown as unknown", async () => {
    mount(
      <SwitchPicker
        owner={OWNER}
        onClose={() => {}}
        list={() => Promise.reject(new Error("boom"))}
      />,
    );
    expect(
      await screen.findByText(SWITCH_COPY.unknownListing),
    ).toBeInTheDocument();
  });

  test("the listing excludes the account the picker was opened for", async () => {
    const list = vi.fn(async () => ({ kind: "ok" as const, accounts: [] }));
    mount(<SwitchPicker owner={OWNER} onClose={() => {}} list={list} />);
    await screen.findByRole("listbox");
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ exclude: OWNER }),
    );
  });

  test("keyboard: the listbox takes focus; Up/Down move the active option (wrapping); Enter opens WF-SWITCH-02 for that row; the current row opens nothing", async () => {
    switchFlow.open(OWNER, null);
    mount(
      <SwitchPicker
        owner={OWNER}
        onClose={() => {}}
        list={listing({
          kind: "ok",
          accounts: [{ account_id: BOB, lastVerifiedName: "sam", waiting: 0 }],
        })}
      />,
    );
    const list = await screen.findByRole("listbox");
    await waitFor(() => expect(list).toHaveFocus());
    const options = within(list).getAllByRole("option");
    fireEvent.keyDown(list, { key: "Enter" });
    expect(switchFlow.get().stage).toBe("picker");
    fireEvent.keyDown(list, { key: "ArrowUp" });
    expect(list).toHaveAttribute("aria-activedescendant", options[2]?.id);
    expect(options[2]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(list, { key: "ArrowDown" });
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(list).toHaveAttribute("aria-activedescendant", options[1]?.id);
    fireEvent.keyDown(list, { key: "Enter" });
    expect(switchFlow.get()).toEqual({
      stage: "sign-in",
      owner: OWNER,
      target: { kind: "retained", account_id: BOB, name: "sam" },
      failure: null,
    });
  });

  test("Escape closes the picker without starting a sign-in", async () => {
    const onClose = vi.fn();
    const session = sessionDouble({}, { attempts: attemptsDouble() });
    mount(
      <SwitchPicker
        owner={OWNER}
        onClose={onClose}
        list={listing({ kind: "ok", accounts: [] })}
      />,
      { session },
    );
    const list = await screen.findByRole("listbox");
    fireEvent.keyDown(list, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
    expect(session.attempts.begin).not.toHaveBeenCalled();
  });

  test("clicking 'Use a different account' opens WF-SWITCH-02 with no name", async () => {
    switchFlow.open(OWNER, null);
    mount(
      <SwitchPicker
        owner={OWNER}
        onClose={() => {}}
        list={listing({ kind: "ok", accounts: [] })}
      />,
    );
    fireEvent.click(await screen.findByText(SWITCH_COPY.addAnother));
    expect(switchFlow.get()).toMatchObject({
      stage: "sign-in",
      target: { kind: "other" },
    });
  });
});

describe("WF-SWITCH-02, Sign in as …", () => {
  const sam = { kind: "retained" as const, account_id: BOB, name: "sam" };

  test("heading and primary control name the target; the username is prefilled and editable; there is no sync control", async () => {
    const env = stubEnv();
    env.setLabel("kieran");
    const { container } = mount(
      <SwitchSignIn
        owner={OWNER}
        target={sam}
        failure={null}
        onClose={() => {}}
      />,
      { env },
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Sign in as sam",
    });
    const username = within(dialog).getByRole("textbox", { name: "Username" });
    expect(username).toHaveValue("sam");
    expect(username).not.toHaveAttribute("readonly");
    expect(
      within(dialog).getByRole("button", { name: "Sign in as sam" }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "Cancel — stay as kieran" }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", {
        name: "Use single sign-on instead",
      }),
    ).toBeInTheDocument();
    expect(dialog.querySelector("[data-sync-chip]")).toBeNull();
    expect(within(dialog).queryByText(/Up to date/)).toBeNull();
    expect((await axe(container)).violations).toEqual([]);
  });

  test("MU-8C-06: the queued caution names the CURRENT account and its live count, precedes the form, and is absent at zero", async () => {
    const env = stubEnv({
      drafts: [
        draftRow({ status: "queued" }),
        draftRow({ status: "version_conflict" }),
      ],
    });
    env.setLabel("kieran");
    mount(
      <SwitchSignIn
        owner={OWNER}
        target={sam}
        failure={null}
        onClose={() => {}}
      />,
      { env },
    );
    const dialog = await screen.findByRole("dialog");
    const note = within(dialog).getByRole("note");
    expect(note.textContent).toBe(
      "Before you switch" +
        "kieran has 2 items still waiting to send. They stay saved, but they can't send until kieran signs in on this computer again.",
    );
    const form = dialog.querySelector("form") as HTMLFormElement;
    expect(
      note.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    act(() => env.setDrafts([]));
    expect(within(dialog).queryByRole("note")).toBeNull();
  });

  test("offline: the form is disabled with 'Signing in needs a connection.' and nothing is sent", async () => {
    online = false;
    const session = sessionDouble({}, { attempts: attemptsDouble() });
    mount(
      <SwitchSignIn
        owner={OWNER}
        target={sam}
        failure={null}
        onClose={() => {}}
      />,
      { session },
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(OFFLINE_REASON)).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "Sign in as sam" }),
    ).toBeDisabled();
    expect(
      within(dialog).getByRole("textbox", { name: "Username" }),
    ).toBeDisabled();
    expect(session.attempts.begin).not.toHaveBeenCalled();
  });

  test("Cancel returns to the picker; nothing is sent", async () => {
    switchFlow.open(OWNER, null);
    switchFlow.choose(OWNER, sam);
    const session = sessionDouble({}, { attempts: attemptsDouble() });
    mount(
      <SwitchSignIn
        owner={OWNER}
        target={sam}
        failure={null}
        onClose={() => {}}
      />,
      { session },
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /^Cancel — stay as / }),
    );
    expect(switchFlow.get().stage).toBe("picker");
    expect(session.attempts.begin).not.toHaveBeenCalled();
  });

  test("single sign-on starts an ordinary OIDC attempt and navigates only after it is durably redirected", async () => {
    // SETUP ADAPTED (R1 of the review of 11 October 2026): the credential step is now an owned journey of the page-memory flow, and a
    // step that is not the flow's current one starts nothing; the flow is opened at this step as `SwitchFlow` would render it.
    switchFlow.open(OWNER, null);
    switchFlow.choose(OWNER, sam);
    const session = sessionDouble({}, { attempts: attemptsDouble() });
    const navigate = vi.fn();
    mount(
      <SwitchSignIn
        owner={OWNER}
        target={sam}
        failure={null}
        onClose={() => {}}
        navigate={navigate}
      />,
      { session },
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Use single sign-on instead" }),
    );
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith(
        "https://idp.example.test/authorize",
      ),
    );
    expect(session.attempts.begin).toHaveBeenCalledWith("oidc");
  });
});

describe("the switch is an ordinary sign-in, and its outcome belongs to the flow (D-8c-02)", () => {
  const sam = { kind: "retained" as const, account_id: BOB, name: "sam" };

  async function submit(
    outcome: Awaited<ReturnType<Session["attempts"]["signInWithPassword"]>>,
  ) {
    switchFlow.open(OWNER, null);
    switchFlow.choose(OWNER, sam);
    const attempts = attemptsDouble({
      signInWithPassword: vi.fn(async () => outcome),
    });
    const session = sessionDouble({}, { attempts });
    mount(<SwitchFlow owner={OWNER} />, { session });
    const dialog = await screen.findByRole("dialog", {
      name: "Sign in as sam",
    });
    fireEvent.change(within(dialog).getByLabelText("Password"), {
      target: { value: "correct-horse-battery-9271" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Sign in as sam" }),
    );
    await waitFor(() => expect(attempts.signInWithPassword).toHaveBeenCalled());
    return { attempts, session };
  }

  test("MU-8C-12: it begins a PASSWORD attempt with what was typed; no account id is passed anywhere", async () => {
    const { attempts } = await submit({
      kind: "settled",
      account_id: BOB,
      epoch: 2,
      method: "password",
    });
    expect(attempts.begin).toHaveBeenCalledWith("password");
    expect(attempts.signInWithPassword).toHaveBeenCalledWith(
      expect.anything(),
      { username: "sam", password: "correct-horse-battery-9271" },
    );
    expect(
      JSON.stringify(vi.mocked(attempts.signInWithPassword).mock.calls),
    ).not.toContain(BOB);
  });

  test("settled: the flow is over", async () => {
    await submit({
      kind: "settled",
      account_id: BOB,
      epoch: 2,
      method: "password",
    });
    await waitFor(() => expect(switchFlow.get().stage).toBe("closed"));
  });

  test("gating and superseded: the flow is over (the gate or a newer attempt owns the screen; superseded publishes its banner)", async () => {
    await submit({ kind: "gating" });
    await waitFor(() => expect(switchFlow.get().stage).toBe("closed"));
    cleanup();
    authFeedback.clearOnBegin();
    await submit({ kind: "superseded" });
    await waitFor(() => expect(switchFlow.get().stage).toBe("closed"));
    expect(authFeedback.get().map((item) => item.kind)).toEqual(["superseded"]);
  });

  test("a refusal keeps the dialog with the outgoing account untouched, shows the message once, and is not left for a neutral form", async () => {
    await submit({
      kind: "refused",
      error: {
        code: "unauthenticated",
        message: "x",
        request_id: "req-1",
      } as never,
      definitive: true,
      stage: "exchange",
    });
    expect(
      await screen.findByText("That username or password isn't right."),
    ).toBeInTheDocument();
    expect(switchFlow.get()).toMatchObject({ stage: "sign-in", failure: null });
    expect(authFeedback.carriedFailure()).toBeNull();
  });

  test("an activation refusal that arrives after the tree unmounted is shown when the outgoing account's tree renders again", async () => {
    switchFlow.open(OWNER, null);
    switchFlow.choose(OWNER, sam);
    switchFlow.fail(OWNER, { id: "device_capacity" });
    mount(<SwitchFlow owner={OWNER} />);
    expect(
      await screen.findByText(/This device has too many active sign-ins/),
    ).toBeInTheDocument();
  });

  test("lock_timeout: the banner is published and the form stays to try again", async () => {
    await submit({ kind: "not_started", reason: "lock_timeout" });
    await waitFor(() =>
      expect(authFeedback.get().map((item) => item.kind)).toEqual([
        "lock_wait",
      ]),
    );
    expect(switchFlow.get().stage).toBe("sign-in");
  });
});

describe("R1 of the review of 11 October 2026: leaving the credential step cancels the sign-in in flight (no change made)", () => {
  const sam = { kind: "retained" as const, account_id: BOB, name: "sam" };
  type Outcome = Awaited<ReturnType<Session["attempts"]["signInWithPassword"]>>;
  const refused: Outcome = {
    kind: "refused",
    error: { code: "unauthenticated", message: "x" } as never,
    definitive: true,
    stage: "exchange",
  };

  /** The switch's sign-in is submitted and its exchange is outstanding (or, with `holdBegin`, its `begin` has not returned). */
  async function inFlight(options: { holdBegin?: boolean } = {}) {
    switchFlow.open(OWNER, null);
    switchFlow.choose(OWNER, sam);
    let answer: (outcome: Outcome) => void = () => undefined;
    let started: () => void = () => undefined;
    const handle: AttemptHandle = {
      epoch: 7,
      method: "password",
      challenge: "c".repeat(43),
    };
    const attempts = attemptsDouble({
      begin: vi.fn(
        () =>
          new Promise<BeginResult>((resolve) => {
            started = () => resolve({ kind: "started", handle });
            if (!options.holdBegin) started();
          }),
      ),
      signInWithPassword: vi.fn(
        () =>
          new Promise<Outcome>((resolve) => {
            answer = resolve;
          }),
      ),
    });
    const session = sessionDouble({}, { attempts });
    mount(<SwitchFlow owner={OWNER} />, { session });
    const dialog = await screen.findByRole("dialog", {
      name: "Sign in as sam",
    });
    fireEvent.change(within(dialog).getByLabelText("Password"), {
      target: { value: "correct-horse-battery-9271" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Sign in as sam" }),
    );
    if (options.holdBegin)
      await waitFor(() => expect(attempts.begin).toHaveBeenCalled());
    else
      await waitFor(() =>
        expect(attempts.signInWithPassword).toHaveBeenCalled(),
      );
    return {
      attempts,
      handle,
      dialog,
      answer: (outcome: Outcome) => answer(outcome),
      start: () => started(),
    };
  }

  test("control: the same submission, not cancelled, keeps its refusal for the form", async () => {
    const { answer, attempts } = await inFlight();
    answer(refused);
    expect(
      await screen.findByText("That username or password isn't right."),
    ).toBeInTheDocument();
    expect(attempts.cancel).not.toHaveBeenCalled();
  });

  test("'Cancel — stay as …' while the exchange is outstanding cancels THAT attempt; what arrives afterwards is dropped, with no banner", async () => {
    const { answer, attempts, handle, dialog } = await inFlight();
    fireEvent.click(
      within(dialog).getByRole("button", { name: /^Cancel — stay as / }),
    );
    expect(switchFlow.get().stage).toBe("picker");
    expect(attempts.cancel).toHaveBeenCalledWith(handle);
    // The session discards a cancelled attempt's late result as superseded.
    answer({ kind: "superseded" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(switchFlow.get().stage).toBe("picker");
    expect(authFeedback.get()).toEqual([]);
    expect(authFeedback.carriedFailure()).toBeNull();
  });

  test("Escape while the exchange is outstanding closes the flow and cancels the attempt; a late refusal is neither shown nor carried", async () => {
    const { answer, attempts, handle, dialog } = await inFlight();
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(switchFlow.get().stage).toBe("closed"));
    expect(attempts.cancel).toHaveBeenCalledWith(handle);
    answer(refused);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(switchFlow.get().stage).toBe("closed");
    expect(authFeedback.carriedFailure()).toBeNull();
    expect(authFeedback.get()).toEqual([]);
  });

  test("Close while the exchange is outstanding cancels the attempt", async () => {
    const { attempts, handle, dialog } = await inFlight();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(switchFlow.get().stage).toBe("closed"));
    expect(attempts.cancel).toHaveBeenCalledWith(handle);
  });

  test("cancelled BEFORE `begin` returned: the attempt is cancelled as soon as it exists and nothing is sent", async () => {
    const { attempts, handle, dialog, start } = await inFlight({
      holdBegin: true,
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: /^Cancel — stay as / }),
    );
    start();
    await waitFor(() => expect(attempts.cancel).toHaveBeenCalledWith(handle));
    expect(attempts.signInWithPassword).not.toHaveBeenCalled();
    expect(switchFlow.get().stage).toBe("picker");
  });

  test("another account displaying, or signing out, cancels it too (the flow is no longer anyone's)", async () => {
    const first = await inFlight();
    switchFlow.dropUnless(BOB);
    expect(first.attempts.cancel).toHaveBeenCalledWith(first.handle);
    cleanup();
    const second = await inFlight();
    switchFlow.close();
    expect(second.attempts.cancel).toHaveBeenCalledWith(second.handle);
  });

  test("a left journey's late refusal is never applied to the next one", async () => {
    const { answer, dialog } = await inFlight();
    fireEvent.click(
      within(dialog).getByRole("button", { name: /^Cancel — stay as / }),
    );
    switchFlow.choose(OWNER, sam);
    const again = await screen.findByRole("dialog", { name: "Sign in as sam" });
    answer(refused);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(switchFlow.get()).toMatchObject({ stage: "sign-in", failure: null });
    expect(
      within(again).queryByText("That username or password isn't right."),
    ).toBeNull();
  });
});

describe("SwitchHost: the flow belongs to the account it was opened for", () => {
  test("it is shown only while that account displays, and a different account's display drops it", async () => {
    switchFlow.open(OWNER, null);
    const other = sessionDouble(
      {},
      {
        view: store({
          kind: "displaying" as const,
          account_id: BOB,
          epoch: 4,
        }),
      },
    );
    mount(<SwitchHost />, { session: other });
    await waitFor(() => expect(switchFlow.get().stage).toBe("closed"));
    expect(screen.queryByRole("dialog")).toBeNull();
    cleanup();
    switchFlow.open(OWNER, null);
    mount(<SwitchHost />);
    expect(
      await screen.findByRole("dialog", { name: SWITCH_COPY.title }),
    ).toBeInTheDocument();
  });
});
