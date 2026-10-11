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
import { HouseholdsMinimal } from "../../../src/features/sharing/HouseholdsMinimal";
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
import {
  type FakeSharingApi,
  fakeSharingApi,
  ok,
} from "../../support/sharing/fake-api";
import { mountSharing } from "../../support/sharing/mount";

/**
 * A8, A9 (component layer): WEB-12a's household demonstration subset and the directory lookup (WF-SHARING-05), in jsdom. FIXTURE evidence.
 */
afterEach(cleanup);

const home = household({
  id: HOME,
  version: 4,
  members: [
    { account_id: ME, username: "me", role: "manager" },
    { account_id: SAM, username: "sam", role: "member" },
  ],
});

describe("the households subset (A8)", () => {
  test("lists your households with role and members; creates a household; invites by exact username with the household's version", async () => {
    const api = fakeSharingApi();
    api.defaults.households = ok([home]);
    api.defaults.lookup = (username) =>
      ok(username === "jamie" ? [{ id: FLAT, username: "jamie" }] : []);
    const t = mountSharing(<HouseholdsMinimal />, { api });
    const row = (await screen.findByText("Home")).closest(
      "[data-household]",
    ) as HTMLElement;
    expect(row).toHaveTextContent(copy.HOUSEHOLD_ROLE("manager"));
    expect(row).toHaveTextContent("me, sam");
    fireEvent.change(within(row).getByLabelText(copy.INVITE_LABEL("Home")), {
      target: { value: "jamie" },
    });
    fireEvent.click(
      within(row).getByRole("button", { name: copy.INVITE_BUTTON }),
    );
    await waitFor(() => expect(t.api.sent).toHaveLength(1));
    expect(t.api.sent[0]?.commands).toEqual([
      {
        kind: "invite_to_household",
        id: expect.any(String),
        household_id: HOME,
        recipient_id: FLAT,
        expected_version: 4,
      },
    ]);
    fireEvent.change(screen.getByLabelText(copy.CREATE_NAME), {
      target: { value: "Flat 2" },
    });
    fireEvent.click(screen.getByRole("button", { name: copy.CREATE_BUTTON }));
    await waitFor(() => expect(t.api.sent).toHaveLength(2));
    expect(t.api.sent[1]?.commands).toEqual([
      { kind: "create_household", id: expect.any(String), name: "Flat 2" },
    ]);
    // After each success the households and the sharing defaults are read again (membership moves the revision).
    expect(
      t.env.calls.filter((c) => c.action === "refreshDefaults").length,
    ).toBeGreaterThanOrEqual(2);
    expect((await axe(document.body)).violations).toEqual([]);
  });

  test("an invite for a username with no exact match is not sent", async () => {
    const api = fakeSharingApi();
    api.defaults.households = ok([home]);
    const t = mountSharing(<HouseholdsMinimal />, { api });
    const row = (await screen.findByText("Home")).closest(
      "[data-household]",
    ) as HTMLElement;
    fireEvent.change(within(row).getByLabelText(copy.INVITE_LABEL("Home")), {
      target: { value: "nobody" },
    });
    fireEvent.click(
      within(row).getByRole("button", { name: copy.INVITE_BUTTON }),
    );
    expect(await screen.findByText(copy.INVITE_NOT_FOUND)).toBeInTheDocument();
    expect(t.api.sent).toEqual([]);
  });

  test("Invitations for you: accept sends respond_to_household_invitation with its version; an expired one says so", async () => {
    const api = fakeSharingApi();
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
    api.next.management.push({ ok: false, kind: "gone", requestId: "r-1" });
    const t = mountSharing(<HouseholdsMinimal />, { api });
    fireEvent.click(
      await screen.findByRole("button", { name: `${copy.ACCEPT}: Flat` }),
    );
    expect(
      await screen.findByText(copy.INVITATION_EXPIRED),
    ).toBeInTheDocument();
    expect(t.api.sent[0]?.commands).toEqual([
      {
        kind: "respond_to_household_invitation",
        id: SAM,
        expected_version: 2,
        accept: true,
      },
    ]);
  });

  test("an uncertain create is retried as the SAME attempt (same id, key and body), and nothing new is sent meanwhile", async () => {
    const api = fakeSharingApi();
    api.next.management.push({ ok: false, kind: "uncertain" });
    const t = mountSharing(<HouseholdsMinimal />, { api });
    fireEvent.change(await screen.findByLabelText(copy.CREATE_NAME), {
      target: { value: "Flat 2" },
    });
    fireEvent.click(screen.getByRole("button", { name: copy.CREATE_BUTTON }));
    expect(await screen.findByText(copy.UNCERTAIN)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: copy.CREATE_BUTTON }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: copy.TRY_AGAIN }));
    await waitFor(() => expect(t.api.sent).toHaveLength(2));
    expect(t.api.sent[1]).toEqual(t.api.sent[0]);
  });

  test("offline: the last snapshot's households with their time; actions disabled; nothing asked", async () => {
    const env = stubEnv();
    env.setDefaults(record(snapshot({ households: [home] })));
    const api = fakeSharingApi();
    mountSharing(<HouseholdsMinimal />, {
      env,
      api,
      sharing: { online: false },
    });
    expect(await screen.findByText("Home")).toBeInTheDocument();
    expect(screen.getByText(/As of/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: copy.CREATE_BUTTON }),
    ).toBeDisabled();
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
    const api = fakeSharingApi();
    api.defaults.households = ok([home]);
    const t = mountSharing(<HouseholdsMinimal />, { api });
    await screen.findByText("Home");
    const before = t.env.calls.length;
    fireEvent.change(screen.getByLabelText(copy.CREATE_NAME), {
      target: { value: "Flat 2" },
    });
    fireEvent.click(screen.getByRole("button", { name: copy.CREATE_BUTTON }));
    await waitFor(() => expect(t.api.sent).toHaveLength(1));
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
  const createButton = () =>
    screen.getByRole("button", { name: copy.CREATE_BUTTON });
  const reasonOf = (button: HTMLElement) =>
    document.getElementById(button.getAttribute("aria-describedby") ?? "")
      ?.textContent;
  /** Every adapter invocation of the management command (an `offline` answer of the adapter is an invocation, never a request). */
  const invocations = (api: FakeSharingApi) =>
    api.calls.filter((c) => c.op === "management").length;
  /** A create of "Flat 2" whose outcome is uncertain; returns the command that was sent. */
  async function uncertainCreate(
    api: FakeSharingApi,
    sharing: Parameters<typeof mountSharing>[1] = {},
  ) {
    api.next.management.push({ ok: false, kind: "uncertain" });
    const t = mountSharing(<HouseholdsMinimal />, { api, ...sharing });
    fireEvent.change(await screen.findByLabelText(copy.CREATE_NAME), {
      target: { value: "Flat 2" },
    });
    fireEvent.click(createButton());
    expect(await screen.findByText(copy.UNCERTAIN)).toBeInTheDocument();
    expect(invocations(api)).toBe(1);
    return { t, first: structuredClone(api.sent[0]) };
  }

  test("MU-S55: a Try again that is not sent (the adapter answers offline) keeps the uncertain create: nothing new is admitted, and the next Try again resends the same id, key and body", async () => {
    const api = fakeSharingApi();
    const { first } = await uncertainCreate(api);
    api.next.management.push({ ok: false, kind: "offline" });
    fireEvent.click(screen.getByRole("button", { name: copy.TRY_AGAIN }));
    await waitFor(() => expect(invocations(api)).toBe(2));
    await act(async () => {});
    // The earlier request may have committed: it is still the one to try again, and nothing new can be sent.
    expect(
      screen.queryByRole("button", { name: copy.TRY_AGAIN }),
    ).not.toBeNull();
    expect(screen.queryByText(copy.UNCERTAIN)).not.toBeNull();
    expect(createButton()).toBeDisabled();
    expect(reasonOf(createButton())).toBe(copy.UNCERTAIN_PENDING);
    fireEvent.submit(createButton().closest("form") as HTMLFormElement);
    expect(invocations(api)).toBe(2);
    fireEvent.click(screen.getByRole("button", { name: copy.TRY_AGAIN }));
    await waitFor(() => expect(invocations(api)).toBe(3));
    expect(api.sent[2]).toEqual(first);
    // The receipt ends it: a new create is admitted again.
    await waitFor(() => expect(createButton()).not.toBeDisabled());
  });

  test("MU-S56: offline with an uncertain create, Try again is disabled with the connection reason and sends nothing; back online, Create stays blocked and Try again resends the same command", async () => {
    const api = fakeSharingApi();
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
    expect(api.sent[1]).toEqual(first);
  });

  test("control: a Try again answered not_sent keeps the attempt that may have committed, and a server refusal of it ends it", async () => {
    const api = fakeSharingApi();
    const { first } = await uncertainCreate(api);
    api.next.management.push({ ok: false, kind: "not_sent" });
    for (let n = 0; n < 6; n += 1)
      api.next.management.push({ ok: false, kind: "not_sent" });
    fireEvent.click(screen.getByRole("button", { name: copy.TRY_AGAIN }));
    await waitFor(() => expect(invocations(api)).toBe(8), { timeout: 5_000 });
    await waitFor(() =>
      expect(screen.queryByText(copy.NOT_SENT)).not.toBeNull(),
    );
    expect(createButton()).toBeDisabled();
    api.next.management.push({
      ok: false,
      kind: "invalid",
      requestId: "r-9",
      message: "no",
    });
    fireEvent.click(screen.getByRole("button", { name: copy.TRY_AGAIN }));
    await waitFor(() => expect(invocations(api)).toBe(9));
    expect(api.sent[8]).toEqual(first);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: copy.TRY_AGAIN })).toBeNull(),
    );
    expect(createButton()).not.toBeDisabled();
  });

  test("MU-S57: Reload shows the lists again but does not end the unresolved create (a list read is not proof it cannot still commit)", async () => {
    const api = fakeSharingApi();
    const { first } = await uncertainCreate(api);
    const reads = api.calls.filter((c) => c.op === "readHouseholds").length;
    fireEvent.click(screen.getByRole("button", { name: copy.RELOAD }));
    await waitFor(() =>
      expect(
        api.calls.filter((c) => c.op === "readHouseholds").length,
      ).toBeGreaterThan(reads),
    );
    await act(async () => {});
    expect(createButton()).toBeDisabled();
    expect(reasonOf(createButton())).toBe(copy.UNCERTAIN_PENDING);
    expect(
      screen.queryByRole("button", { name: copy.TRY_AGAIN }),
    ).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: copy.TRY_AGAIN }));
    await waitFor(() => expect(invocations(api)).toBe(2));
    expect(api.sent[1]).toEqual(first);
  });

  /** A manager of Home with an invitation lookup held until `answer` is called. */
  async function heldLookup() {
    const api = fakeSharingApi();
    api.defaults.households = ok([home]);
    let answer: () => void = () => undefined;
    api.next.lookup.push(
      () =>
        new Promise((resolve) => {
          answer = () => resolve(ok([{ id: FLAT, username: "jamie" }]));
        }),
    );
    const t = mountSharing(<HouseholdsMinimal />, { api });
    const row = (await screen.findByText("Home")).closest(
      "[data-household]",
    ) as HTMLElement;
    fireEvent.change(within(row).getByLabelText(copy.INVITE_LABEL("Home")), {
      target: { value: "jamie" },
    });
    fireEvent.change(screen.getByLabelText(copy.CREATE_NAME), {
      target: { value: "Flat 2" },
    });
    fireEvent.click(
      within(row).getByRole("button", { name: copy.INVITE_BUTTON }),
    );
    await waitFor(() =>
      expect(api.calls.filter((c) => c.op === "lookup")).toHaveLength(1),
    );
    return { t, api, answer: () => answer() };
  }

  test("MU-S58 (DA-H1): an invitation's lookup owns the page: while it is awaited nothing else can be sent, and the invite is sent once when it answers", async () => {
    const { api, answer } = await heldLookup();
    expect(createButton()).toBeDisabled();
    expect(reasonOf(createButton())).toBe(copy.SAVE_BUSY_REASON);
    fireEvent.submit(createButton().closest("form") as HTMLFormElement);
    await act(async () => {});
    // Asserted before the lookup answers: a create sent now could be left unresolved under the invite.
    expect(invocations(api)).toBe(0);
    await act(async () => {
      answer();
    });
    await waitFor(() => expect(invocations(api)).toBe(1));
    expect(api.sent[0]?.commands).toEqual([
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
    expect(createButton()).not.toBeDisabled();
  });

  test("MU-S60: two submissions in one turn admit one command (admission is synchronous, not the rendered state)", async () => {
    const api = fakeSharingApi();
    api.next.management.push(
      () => new Promise(() => undefined), // never answers: the first stays in flight
    );
    mountSharing(<HouseholdsMinimal />, { api });
    fireEvent.change(await screen.findByLabelText(copy.CREATE_NAME), {
      target: { value: "Flat 2" },
    });
    const form = createButton().closest("form") as HTMLFormElement;
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
