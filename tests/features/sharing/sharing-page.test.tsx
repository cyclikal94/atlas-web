import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, describe, expect, test } from "vitest";
import * as copy from "../../../src/features/sharing/copy";
import { DirectoryLookup } from "../../../src/features/sharing/DirectoryLookup";
import * as hh from "../../../src/features/sharing/households/copy";
import { forgetHouseholdsMemory } from "../../../src/features/sharing/households/memory";
import { formatWhen } from "../../../src/features/sharing/parts";
import { installMatchMedia } from "../../helpers/match-media";
import {
  FLAT,
  HOME,
  household,
  ME,
  record,
  SAM,
  snapshot,
} from "../../support/data/sharing";
import { stubEnv } from "../../support/data/ui-env";
import { fakeSharingApi, ok } from "../../support/sharing/fake-api";
import {
  type FakeHouseholdApi,
  fakeHouseholdApi,
} from "../../support/sharing/fake-households";
import { mountHouseholds } from "../../support/sharing/households";
import { mountSharing } from "../../support/sharing/mount";

/**
 * A8, A9 (component layer): the household cases WEB-12a wrote against its demonstration subset (`HouseholdsMinimal`), RE-TARGETED by WEB-12b
 * to the full household screens that replace it (D-12b-1: the create is the route-addressed New household dialog, an invite is the
 * household's Invitations dialog). Every assertion is kept; what changed is how each screen is reached, stated at each case. The directory
 * lookup (WF-SHARING-05) cases are unchanged. FIXTURE evidence, in the application's own router and protected providers.
 */
installMatchMedia({ width: 1440 });
afterEach(() => {
  cleanup();
  forgetHouseholdsMemory();
});
/**
 * A banner's own text. The announcer also writes an error banner's message into its live region on the next frame (lint R6), so a
 * page-wide text query could match it twice depending on timing; the assertions are about the banner shown.
 */
const BANNER = { selector: "[data-sharing-banner] p" };

const home = household({
  id: HOME,
  version: 4,
  members: [
    { account_id: ME, username: "me", role: "manager" },
    { account_id: SAM, username: "sam", role: "member" },
  ],
});

const createButton = () => screen.getByRole("button", { name: hh.CREATE });
/** The New household form (its Create sits in the dialog's footer, associated with it). */
const createForm = () =>
  document.querySelector("[data-households-new]") as HTMLFormElement;
const nameField = () => screen.findByLabelText(hh.NAME_LABEL);
const reasonOf = (button: HTMLElement) =>
  document.getElementById(button.getAttribute("aria-describedby") ?? "")
    ?.textContent;

describe("the households subset (A8)", () => {
  test("lists your households with role and members; creates a household; invites by exact username with the household's version", async () => {
    const api = fakeHouseholdApi();
    api.defaults.households = ok([home]);
    api.defaults.lookup = (username) =>
      ok(username === "jamie" ? [{ id: FLAT, username: "jamie" }] : []);
    const t = mountHouseholds(`/sharing/households/${HOME}/invitations`, {
      api,
    });
    const row = (await screen.findAllByText("Home"))[0]?.closest(
      "[data-household]",
    ) as HTMLElement;
    // Re-targeted: the role is the pane row's "you manage it"; the members are the detail's rows.
    expect(row).toHaveTextContent(hh.YOU_MANAGE);
    const members = [
      ...document.querySelectorAll("[data-household-members] [data-member]"),
    ].map((m) => m.textContent);
    expect(members.join(" ")).toContain("me");
    expect(members.join(" ")).toContain("sam");
    const dialog = await screen.findByRole("dialog", {
      name: hh.INVITATIONS_TITLE_FOR("Home"),
    });
    fireEvent.change(within(dialog).getByLabelText(hh.USERNAME_LABEL), {
      target: { value: "jamie" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: hh.INVITE }));
    await waitFor(() => expect(t.api.sentCommands).toHaveLength(1));
    expect(t.api.sentCommands[0]?.commands).toEqual([
      {
        kind: "invite_to_household",
        id: expect.any(String),
        household_id: HOME,
        recipient_id: FLAT,
        expected_version: 4,
      },
    ]);
    await t.navigate("/sharing/new");
    fireEvent.change(await nameField(), { target: { value: "Flat 2" } });
    fireEvent.click(createButton());
    await waitFor(() => expect(t.api.sentCommands).toHaveLength(2));
    expect(t.api.sentCommands[1]?.commands).toEqual([
      { kind: "create_household", id: expect.any(String), name: "Flat 2" },
    ]);
    // After each success the households and the sharing defaults are read again (membership moves the revision).
    expect(
      t.env.calls.filter((c) => c.action === "refreshDefaults").length,
    ).toBeGreaterThanOrEqual(2);
    expect((await axe(document.body)).violations).toEqual([]);
  });

  test("an invite for a username with no exact match is not sent", async () => {
    const api = fakeHouseholdApi();
    api.defaults.households = ok([home]);
    const t = mountHouseholds(`/sharing/households/${HOME}/invitations`, {
      api,
    });
    const dialog = await screen.findByRole("dialog", {
      name: hh.INVITATIONS_TITLE_FOR("Home"),
    });
    fireEvent.change(within(dialog).getByLabelText(hh.USERNAME_LABEL), {
      target: { value: "nobody" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: hh.INVITE }));
    expect(
      await screen.findByText(copy.INVITE_NOT_FOUND, BANNER),
    ).toBeInTheDocument();
    expect(t.api.sentCommands).toEqual([]);
  });

  test("Invitations for you: accept sends respond_to_household_invitation with its version; an expired one says so", async () => {
    const api = fakeHouseholdApi();
    api.defaults.invitations = ok([
      {
        id: SAM,
        household_id: FLAT,
        household_name: "Flat",
        sender_id: ME,
        status: "pending",
        expires_at: "2026-10-17T10:00:00Z",
        version: 2,
      },
    ]);
    api.next.command.push({ ok: false, kind: "gone", requestId: "r-1" });
    const t = mountHouseholds("/sharing/invitations", { api });
    fireEvent.click(
      await screen.findByRole("button", { name: `${hh.ACCEPT}: Flat` }),
    );
    expect(
      await screen.findByText(copy.INVITATION_EXPIRED, BANNER),
    ).toBeInTheDocument();
    expect(t.api.sentCommands[0]?.commands).toEqual([
      {
        kind: "respond_to_household_invitation",
        id: SAM,
        expected_version: 2,
        accept: true,
      },
    ]);
  });

  test("an uncertain create is retried as the SAME attempt (same id, key and body), and nothing new is sent meanwhile", async () => {
    const api = fakeHouseholdApi();
    api.next.command.push({ ok: false, kind: "uncertain" });
    const t = mountHouseholds("/sharing/new", { api });
    fireEvent.change(await nameField(), { target: { value: "Flat 2" } });
    fireEvent.click(createButton());
    expect(await screen.findByText(copy.UNCERTAIN, BANNER)).toBeInTheDocument();
    expect(createButton()).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: copy.TRY_AGAIN }));
    await waitFor(() => expect(t.api.sentCommands).toHaveLength(2));
    expect(t.api.sentCommands[1]).toEqual(t.api.sentCommands[0]);
  });

  test("offline: the last snapshot's households with their time; actions disabled; nothing asked", async () => {
    const env = stubEnv();
    env.setDefaults(record(snapshot({ households: [home] })));
    const api = fakeHouseholdApi();
    mountHouseholds("/sharing/new", { env, api, sharing: { online: false } });
    expect((await screen.findAllByText("Home")).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/As of/).length).toBeGreaterThan(0);
    // Re-targeted: the create is the New household dialog's.
    expect(createButton()).toBeDisabled();
    expect(api.calls).toEqual([]);
  });
});

describe("the directory lookup (A9, WF-SHARING-05)", () => {
  test("two labelled sections in one reading order; the exact lookup answers when the search finds nothing; empty is not an error", async () => {
    const api = fakeSharingApi();
    api.defaults.lookup = (username) =>
      ok(username === "sam" ? [{ id: SAM, username: "sam" }] : []);
    const chosen: string[] = [];
    mountSharing(
      <DirectoryLookup
        purpose="Add account grant"
        onChoose={(e) => chosen.push(e.id)}
        onBack={() => undefined}
      />,
      { api },
    );
    const sections = [...document.querySelectorAll("[data-lookup]")].map((s) =>
      s.getAttribute("data-lookup"),
    );
    expect(sections).toEqual(["search", "exact"]);
    fireEvent.change(screen.getByLabelText(copy.LOOKUP_SEARCH_LABEL), {
      target: { value: "sa" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: copy.LOOKUP_SEARCH_BUTTON }),
    );
    expect(await screen.findByText(copy.LOOKUP_NONE)).toBeInTheDocument();
    expect(document.querySelector("[data-lookup-failed]")).toBeNull();
    fireEvent.change(screen.getByLabelText(copy.LOOKUP_EXACT_LABEL), {
      target: { value: "sam" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: copy.LOOKUP_EXACT_BUTTON }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: `${copy.LOOKUP_CHOOSE}: sam` }),
    );
    expect(chosen).toEqual([SAM]);
    expect((await axe(document.body)).violations).toEqual([]);
  });

  test("offline: both lookups are disabled with the reason, and nothing is asked", async () => {
    const api = fakeSharingApi();
    mountSharing(
      <DirectoryLookup
        purpose="Add exclusion"
        onChoose={() => undefined}
        onBack={() => undefined}
      />,
      { api, sharing: { online: false } },
    );
    expect(
      screen.getByRole("button", { name: copy.LOOKUP_SEARCH_BUTTON }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: copy.LOOKUP_EXACT_BUTTON }),
    ).toBeDisabled();
    expect(api.calls).toEqual([]);
  });

  test("a failed lookup says so with the request id (not the empty state)", async () => {
    const api = fakeSharingApi();
    api.next.lookup.push({
      ok: false,
      kind: "uncertain",
      requestId: "abcd1234-0000-4000-8000-000000000000",
    });
    mountSharing(
      <DirectoryLookup
        purpose="Add account grant"
        onChoose={() => undefined}
        onBack={() => undefined}
      />,
      { api },
    );
    fireEvent.change(screen.getByLabelText(copy.LOOKUP_EXACT_LABEL), {
      target: { value: "sam" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: copy.LOOKUP_EXACT_BUTTON }),
    );
    expect(await screen.findByText(/Couldn't look that up/)).toHaveTextContent(
      "abcd1234",
    );
  });
});

// ---- WEB-12a review 2 ------------------------------------------------------------------------------------------------------------
describe("R7: after a household change the snapshot is asked for AFTER it", () => {
  test("MU-S53: a successful create asks for a snapshot read issued after the success (an acquisition with a boundary), never a refresh that could share an older read", async () => {
    const api = fakeHouseholdApi();
    api.defaults.households = ok([home]);
    const t = mountHouseholds("/sharing/new", { api });
    fireEvent.change(await nameField(), { target: { value: "Flat 2" } });
    await waitFor(() => expect(createButton()).not.toBeDisabled());
    const before = t.env.calls.length;
    fireEvent.click(createButton());
    await waitFor(() => expect(t.api.sentCommands).toHaveLength(1));
    await waitFor(() =>
      expect(
        t.env.calls
          .slice(before)
          .filter((c) => c.action === "refreshDefaults" && c.args.length === 1),
      ).toHaveLength(1),
    );
    expect(
      t.env.calls
        .slice(before)
        .filter((c) => c.action === "refreshDefaults" && c.args.length === 0),
    ).toHaveLength(0);
  });
});

// ---- WEB-12a review 3 ------------------------------------------------------------------------------------------------------------
describe("R8 (review 3): an unresolved household attempt is kept until a receipt or the server's refusal ends it", () => {
  /** Every adapter invocation of the management command (an `offline` answer of the adapter is an invocation, never a request). */
  const invocations = (api: FakeHouseholdApi) => api.count("command");
  /** A create of "Flat 2" whose outcome is uncertain; returns the command that was sent. */
  async function uncertainCreate(
    api: FakeHouseholdApi,
    sharing: Parameters<typeof mountHouseholds>[1] = {},
  ) {
    api.next.command.push({ ok: false, kind: "uncertain" });
    const t = mountHouseholds("/sharing/new", { api, ...sharing });
    fireEvent.change(await nameField(), { target: { value: "Flat 2" } });
    fireEvent.click(createButton());
    expect(await screen.findByText(copy.UNCERTAIN, BANNER)).toBeInTheDocument();
    expect(invocations(api)).toBe(1);
    return { t, first: structuredClone(api.sentCommands[0]) };
  }

  test("MU-S55: a Try again that is not sent (the adapter answers offline) keeps the uncertain create: nothing new is admitted, and the next Try again resends the same id, key and body", async () => {
    const api = fakeHouseholdApi();
    const { first } = await uncertainCreate(api);
    api.next.command.push({ ok: false, kind: "offline" });
    fireEvent.click(screen.getByRole("button", { name: copy.TRY_AGAIN }));
    await waitFor(() => expect(invocations(api)).toBe(2));
    await act(async () => {});
    // The earlier request may have committed: it is still the one to try again, and nothing new can be sent.
    expect(
      screen.queryByRole("button", { name: copy.TRY_AGAIN }),
    ).not.toBeNull();
    expect(screen.queryByText(copy.UNCERTAIN, BANNER)).not.toBeNull();
    expect(createButton()).toBeDisabled();
    expect(reasonOf(createButton())).toBe(copy.UNCERTAIN_PENDING);
    fireEvent.submit(createForm());
    expect(invocations(api)).toBe(2);
    fireEvent.click(screen.getByRole("button", { name: copy.TRY_AGAIN }));
    await waitFor(() => expect(invocations(api)).toBe(3));
    expect(api.sentCommands[2]).toEqual(first);
    // The receipt ends it: a new create is admitted again (re-targeted: the receipt shows the household it made, so New household is
    // opened again to see it).
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: copy.TRY_AGAIN })).toBeNull(),
    );
  });

  test("MU-S56: offline with an uncertain create, Try again is disabled with the connection reason and sends nothing; back online, Create stays blocked and Try again resends the same command", async () => {
    const api = fakeHouseholdApi();
    const { t, first } = await uncertainCreate(api);
    t.setSharing({ online: false });
    const offlineRetry = screen.getByRole("button", { name: copy.TRY_AGAIN });
    expect(offlineRetry).toBeDisabled();
    expect(reasonOf(offlineRetry)).toBe(copy.SAVE_OFFLINE_REASON);
    fireEvent.click(offlineRetry);
    await act(async () => {});
    expect(invocations(api)).toBe(1);
    t.setSharing({ online: true });
    expect(createButton()).toBeDisabled();
    expect(reasonOf(createButton())).toBe(copy.UNCERTAIN_PENDING);
    const retry = screen.getByRole("button", { name: copy.TRY_AGAIN });
    expect(retry).not.toBeDisabled();
    fireEvent.click(retry);
    await waitFor(() => expect(invocations(api)).toBe(2));
    expect(api.sentCommands[1]).toEqual(first);
  });

  test("control: a Try again answered not_sent keeps the attempt that may have committed, and a server refusal of it ends it", async () => {
    const api = fakeHouseholdApi();
    const { first } = await uncertainCreate(api);
    api.next.command.push({ ok: false, kind: "not_sent" });
    for (let n = 0; n < 6; n += 1)
      api.next.command.push({ ok: false, kind: "not_sent" });
    fireEvent.click(screen.getByRole("button", { name: copy.TRY_AGAIN }));
    await waitFor(() => expect(invocations(api)).toBe(8), { timeout: 5_000 });
    await waitFor(() =>
      expect(screen.queryByText(copy.NOT_SENT, BANNER)).not.toBeNull(),
    );
    expect(createButton()).toBeDisabled();
    api.next.command.push({
      ok: false,
      kind: "invalid",
      requestId: "r-9",
      message: "no",
    });
    fireEvent.click(screen.getByRole("button", { name: copy.TRY_AGAIN }));
    await waitFor(() => expect(invocations(api)).toBe(9));
    expect(api.sentCommands[8]).toEqual(first);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: copy.TRY_AGAIN })).toBeNull(),
    );
    expect(createButton()).not.toBeDisabled();
  });

  test("MU-S57: Reload shows the lists again but does not end the unresolved create (a list read is not proof it cannot still commit)", async () => {
    const api = fakeHouseholdApi();
    const { first } = await uncertainCreate(api);
    const reads = api.count("households");
    fireEvent.click(screen.getByRole("button", { name: copy.RELOAD }));
    await waitFor(() => expect(api.count("households")).toBeGreaterThan(reads));
    await act(async () => {});
    expect(createButton()).toBeDisabled();
    expect(reasonOf(createButton())).toBe(copy.UNCERTAIN_PENDING);
    expect(
      screen.queryByRole("button", { name: copy.TRY_AGAIN }),
    ).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: copy.TRY_AGAIN }));
    await waitFor(() => expect(invocations(api)).toBe(2));
    expect(api.sentCommands[1]).toEqual(first);
  });

  /**
   * A manager of Home with an invitation lookup held until `answer` is called. Re-targeted: the invite is Home's Invitations dialog and the
   * create is the New household dialog, two routes; the page memory owns the operation across the in-app navigation between them.
   */
  async function heldLookup() {
    const api = fakeHouseholdApi();
    api.defaults.households = ok([home]);
    let answer: () => void = () => undefined;
    api.next.lookup.push(
      () =>
        new Promise((resolve) => {
          answer = () => resolve(ok([{ id: FLAT, username: "jamie" }]));
        }),
    );
    const t = mountHouseholds(`/sharing/households/${HOME}/invitations`, {
      api,
    });
    const dialog = await screen.findByRole("dialog", {
      name: hh.INVITATIONS_TITLE_FOR("Home"),
    });
    fireEvent.change(within(dialog).getByLabelText(hh.USERNAME_LABEL), {
      target: { value: "jamie" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: hh.INVITE }));
    await waitFor(() => expect(api.count("lookup")).toBe(1));
    await t.navigate("/sharing/new");
    fireEvent.change(await nameField(), { target: { value: "Flat 2" } });
    return { t, api, answer: () => answer() };
  }

  test("MU-S58 (DA-H1): an invitation's lookup owns the page: while it is awaited nothing else can be sent, and the invite is sent once when it answers", async () => {
    const { api, answer } = await heldLookup();
    expect(createButton()).toBeDisabled();
    expect(reasonOf(createButton())).toBe(copy.SAVE_BUSY_REASON);
    fireEvent.submit(createForm());
    await act(async () => {});
    // Asserted before the lookup answers: a create sent now could be left unresolved under the invite.
    expect(invocations(api)).toBe(0);
    await act(async () => {
      answer();
    });
    await waitFor(() => expect(invocations(api)).toBe(1));
    expect(api.sentCommands[0]?.commands).toEqual([
      {
        kind: "invite_to_household",
        id: expect.any(String),
        household_id: HOME,
        recipient_id: FLAT,
        expected_version: 4,
      },
    ]);
    await waitFor(() => expect(createButton()).not.toBeDisabled());
  });

  test("MU-S59 (DA-H1): a lookup answering after the connection is lost sends nothing and says why; back online the page is free again", async () => {
    const { t, api, answer } = await heldLookup();
    // Re-targeted: back on the invitations dialog, where the invite's problem is shown.
    await t.navigate(`/sharing/households/${HOME}/invitations`);
    t.setSharing({ online: false });
    await act(async () => {
      answer();
    });
    await act(async () => {});
    expect(invocations(api)).toBe(0);
    expect(document.querySelector("[data-sharing-banner] p")?.textContent).toBe(
      copy.SAVE_OFFLINE_REASON,
    );
    t.setSharing({ online: true });
    await t.navigate("/sharing/new");
    fireEvent.change(await nameField(), { target: { value: "Flat 2" } });
    expect(createButton()).not.toBeDisabled();
  });

  test("MU-S60: two submissions in one turn admit one command (admission is synchronous, not the rendered state)", async () => {
    const api = fakeHouseholdApi();
    api.next.command.push(
      () => new Promise(() => undefined), // never answers: the first stays in flight
    );
    mountHouseholds("/sharing/new", { api });
    fireEvent.change(await nameField(), { target: { value: "Flat 2" } });
    await waitFor(() => expect(createButton()).not.toBeDisabled());
    const form = createForm();
    act(() => {
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    await act(async () => {});
    expect(invocations(api)).toBe(1);
  });
});

describe("DA-M2 (design assessment, review 6): offline, B5's households are said to be only what the snapshot named, with their own time", () => {
  const T1 = Date.UTC(2026, 9, 9, 8, 15);
  const T2 = Date.UTC(2026, 9, 11, 9, 30);

  test("MU-S82: offline before the complete list was read, an EMPTY B5 subset is not 'You're not in a household'; a non-empty one is qualified", async () => {
    const env = stubEnv();
    env.setDefaults(
      record(snapshot({ primary: null, households: [] }), { fetched_at: T1 }),
    );
    const view = mountHouseholds("/sharing", {
      env,
      sharing: { online: false, now: () => T2 },
    });
    await waitFor(() =>
      expect(document.querySelector("[data-households-from]")).not.toBeNull(),
    );
    expect(screen.queryByText(hh.EMPTY)).toBeNull();
    expect(screen.queryByText(hh.SNAPSHOT_NONE)).not.toBeNull();
    expect(
      within(
        document.querySelector("[data-households-pane]") as HTMLElement,
      ).getByText(copy.AS_OF(formatWhen(T1, T2))),
    ).toBeInTheDocument();
    view.unmount();
    forgetHouseholdsMemory();
    const subset = stubEnv();
    subset.setDefaults(
      record(snapshot({ households: [home] }), { fetched_at: T1 }),
    );
    mountHouseholds("/sharing", {
      env: subset,
      sharing: { online: false, now: () => T2 },
    });
    expect((await screen.findAllByText("Home")).length).toBeGreaterThan(0);
    expect(
      document.querySelector('[data-households-from="snapshot"]')?.textContent,
    ).toBe(`${hh.FROM_SNAPSHOT} ${copy.AS_OF(formatWhen(T1, T2))}`);
  });

  test("control: a complete list read empty is 'You're not in a household'", async () => {
    const api = fakeHouseholdApi();
    api.defaults.households = ok([]);
    mountHouseholds("/sharing", { api });
    expect(await screen.findByText(hh.EMPTY)).toBeInTheDocument();
    expect(screen.queryByText(hh.SNAPSHOT_NONE)).toBeNull();
  });

  test("MU-S83: a complete list read on this page, then offline: it is shown with ITS read time, not the snapshot's", async () => {
    const env = stubEnv();
    env.setDefaults(
      record(snapshot({ primary: null, households: [] }), { fetched_at: T1 }),
    );
    const api = fakeHouseholdApi();
    api.defaults.households = ok([home]);
    const t = mountHouseholds("/sharing", {
      env,
      api,
      sharing: { now: () => T2 },
    });
    expect((await screen.findAllByText("Home")).length).toBeGreaterThan(0);
    t.setSharing({ online: false });
    expect(
      document.querySelector('[data-households-from="complete"]')?.textContent,
    ).toBe(hh.LAST_READ(formatWhen(T2, T2)));
    expect(
      within(
        document.querySelector("[data-households-pane]") as HTMLElement,
      ).queryByText(copy.AS_OF(formatWhen(T1, T2))),
    ).toBeNull();
    expect(screen.queryByText(hh.SNAPSHOT_NONE)).toBeNull();
  });
});
