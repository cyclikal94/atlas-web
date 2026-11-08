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
import type { Invitation } from "../../../src/features/sharing/api";
import * as base from "../../../src/features/sharing/copy";
import { DirectoryLookup } from "../../../src/features/sharing/DirectoryLookup";
import * as copy from "../../../src/features/sharing/households/copy";
import { forgetHouseholdsMemory } from "../../../src/features/sharing/households/memory";
import type { SentInvitation } from "../../../src/features/sharing/households/model";
import { installMatchMedia } from "../../helpers/match-media";
import { ME, SAM } from "../../support/data/sharing";
import { fakeSharingApi } from "../../support/sharing/fake-api";
import {
  fakeHouseholdApi,
  held,
  ok,
  sentRow,
} from "../../support/sharing/fake-households";
import {
  FLAT_ID,
  HOME_ID,
  homeOf,
  JAMIE_ID,
  mountHouseholds,
  PRIYA_ID,
} from "../../support/sharing/households";
import { mountSharing } from "../../support/sharing/mount";
import { must, present } from "../../support/sharing/present";

/**
 * WEB-12b S-HH10, S-HH11 and S-HH17 (plan §8.2): WF-SHARING-02's For you, Invite and Sent by you (Q16), and WF-SHARING-05's browse mode
 * (PPL-4), in the application's own router over the doubles (jsdom). FIXTURE evidence.
 */
installMatchMedia({ width: 1440 });
afterEach(() => {
  cleanup();
  forgetHouseholdsMemory();
});

const NOW = Date.UTC(2026, 10, 6, 10);
const invitationFor = (over: Partial<Invitation> = {}): Invitation => ({
  id: PRIYA_ID,
  household_id: FLAT_ID,
  household_name: "Flat",
  sender_id: SAM,
  status: "pending",
  expires_at: "2026-11-11T10:00:00Z",
  version: 6,
  ...over,
});
const row = (n: number, over: Partial<SentInvitation> = {}) =>
  sentRow({
    id: `eeeeeeee-0000-4000-8000-${n.toString(16).padStart(12, "0")}`,
    recipient_username: `person${n}`,
    ...over,
  });
const dialogNamed = (name: string) =>
  present(() => screen.queryByRole("dialog", { name }));
const section = (which: string) =>
  document.querySelector(`[data-invitations="${which}"]`) as HTMLElement;

describe("S-HH10: For you", () => {
  test("lists pending invitations with days left; Accept and Decline carry the invitation's version (MU-6222)", async () => {
    const api = fakeHouseholdApi();
    api.defaults.invitations = ok([invitationFor()]);
    const t = mountHouseholds("/sharing/invitations", {
      api,
      sharing: { now: () => NOW },
    });
    const dialog = await dialogNamed(copy.INVITATIONS_TITLE);
    expect(
      await present(() =>
        within(dialog).queryByText(copy.INVITED_YOU("Flat", 5)),
      ),
    ).toBeInTheDocument();
    fireEvent.click(
      must(
        within(dialog).queryByRole("button", { name: `${copy.DECLINE}: Flat` }),
      ),
    );
    await waitFor(() => expect(t.api.sentCommands).toHaveLength(1));
    expect(t.api.sentCommands[0]?.commands).toEqual([
      {
        kind: "respond_to_household_invitation",
        id: PRIYA_ID,
        expected_version: 6,
        accept: false,
      },
    ]);
    expect((await axe(document.body)).violations).toEqual([]);
  });

  test("a stale row (gone, conflict, not_found) says so with its request id and the list is read again; it is never a lasting 'expired' row", async () => {
    const api = fakeHouseholdApi();
    api.next.invitations.push(ok([invitationFor()]));
    api.next.command.push({ ok: false, kind: "not_found", requestId: "r-404" });
    api.defaults.invitations = ok([]);
    mountHouseholds("/sharing/invitations", { api });
    const dialog = await dialogNamed(copy.INVITATIONS_TITLE);
    fireEvent.click(
      await present(() =>
        within(dialog).queryByRole("button", {
          name: `${copy.ACCEPT}: Flat`,
        }),
      ),
    );
    // Once the list is read again the row is gone, and what its answer said is shown at the section's top.
    await waitFor(() =>
      expect(
        must(within(dialog).queryByText(copy.FOR_YOU_NONE)),
      ).toBeInTheDocument(),
    );
    expect(
      must(within(dialog).queryByText(copy.NOT_FOUND)),
    ).toBeInTheDocument();
    expect(must(within(dialog).queryByText(/r-404/))).toBeInTheDocument();
    expect(api.count("invitations")).toBeGreaterThanOrEqual(2);
    expect(within(dialog).queryByText(copy.STATUS.expired)).toBeNull();
  });

  test("at 32 households Accept is unavailable with the reason", async () => {
    const api = fakeHouseholdApi();
    api.defaults.households = ok(
      Array.from({ length: 32 }, (_, n) =>
        homeOf({
          id: `aaaaaaaa-aaaa-4aaa-8aaa-${n.toString(16).padStart(12, "0")}`,
        }),
      ),
    );
    api.defaults.invitations = ok([invitationFor()]);
    mountHouseholds("/sharing/invitations", { api });
    const dialog = await dialogNamed(copy.INVITATIONS_TITLE);
    await waitFor(() =>
      expect(must(screen.queryByText(copy.CAPACITY(32)))).toBeInTheDocument(),
    );
    const accept = must(
      within(dialog).queryByRole("button", { name: copy.ACCEPT }),
    );
    expect(accept).toBeDisabled();
  });
});

describe("S-HH11: Sent by you (Q16, sender-keyed)", () => {
  test("MU-6209/MU-6210: every status is shown verbatim, never relabelled; Revoke is offered only on waiting rows, with the invitation's version (MU-6212)", async () => {
    const api = fakeHouseholdApi();
    api.defaults.households = ok([homeOf()]);
    const statuses = [
      "pending",
      "accepted",
      "declined",
      "revoked",
      "expired",
    ] as const;
    api.defaults.sent = () =>
      ok({
        items: statuses.map((status, n) =>
          row(n, { status, household_id: HOME_ID, version: n + 1 }),
        ),
        next_after: null,
      });
    const t = mountHouseholds(`/sharing/households/${HOME_ID}/invitations`, {
      api,
      sharing: { now: () => NOW },
    });
    const dialog = await dialogNamed(copy.INVITATIONS_TITLE_FOR("Home"));
    await waitFor(() =>
      expect(dialog.querySelectorAll("[data-sent]")).toHaveLength(5),
    );
    const shown = [...dialog.querySelectorAll("[data-sent]")].map(
      (r) => r.textContent,
    );
    expect(shown).toEqual([
      `person0${copy.STATUS.pending(7)}${copy.REVOKE}`,
      `person1${copy.STATUS.accepted}`,
      `person2${copy.STATUS.declined}`,
      `person3${copy.STATUS.revoked}`,
      `person4${copy.STATUS.expired}`,
    ]);
    expect(section("sent")).toHaveTextContent(copy.SENT_NOTE);
    fireEvent.click(
      must(
        within(dialog).queryByRole("button", {
          name: `${copy.REVOKE}: person0`,
        }),
      ),
    );
    await waitFor(() => expect(t.api.sentCommands).toHaveLength(1));
    expect(t.api.sentCommands[0]?.commands).toEqual([
      {
        kind: "revoke_household_invitation",
        id: row(0).id,
        expected_version: 1,
      },
    ]);
  });

  test("MU-6211: the walk follows the cursor to its end, through an EMPTY page that still has a cursor", async () => {
    const api = fakeHouseholdApi();
    api.defaults.households = ok([homeOf()]);
    api.next.sent.push(ok({ items: [row(1)], next_after: row(1).id }));
    api.next.sent.push(ok({ items: [], next_after: row(2).id }));
    api.next.sent.push(ok({ items: [row(3)], next_after: null }));
    mountHouseholds("/sharing/invitations", { api });
    const dialog = await dialogNamed(copy.INVITATIONS_TITLE);
    await waitFor(() =>
      expect(dialog.querySelectorAll("[data-sent]")).toHaveLength(2),
    );
    expect(
      api.calls.filter((c) => c.op === "sent").map((c) => c.args[0]),
    ).toEqual([undefined, row(1).id, row(2).id]);
  });

  test("a 422 (invalid cursor) restarts the walk once; the walk stops at 10 pages and says older ones aren't shown", async () => {
    const api = fakeHouseholdApi();
    api.next.sent.push(ok({ items: [row(1)], next_after: row(1).id }));
    api.next.sent.push({ ok: false, kind: "invalid", requestId: "r-422" });
    let n = 10;
    api.defaults.sent = () => {
      n += 1;
      return ok({ items: [row(n)], next_after: row(n).id });
    };
    mountHouseholds("/sharing/invitations", { api });
    const dialog = await dialogNamed(copy.INVITATIONS_TITLE);
    expect(
      await present(() => within(dialog).queryByText(copy.SENT_TRUNCATED)),
    ).toBeInTheDocument();
    // One page, the refused page, then a fresh walk of ten pages.
    expect(api.count("sent")).toBe(12);
    expect(dialog.querySelectorAll("[data-sent]")).toHaveLength(10);
  });

  test("the header-level dialog groups by household, including a household you have left; Revoke only where you manage it", async () => {
    const api = fakeHouseholdApi();
    api.defaults.households = ok([homeOf()]);
    api.defaults.sent = () =>
      ok({
        items: [
          row(1, { household_id: HOME_ID, household_name: "Home" }),
          row(2, { household_id: FLAT_ID, household_name: "Old flat" }),
        ],
        next_after: null,
      });
    mountHouseholds("/sharing/invitations", { api });
    const dialog = await dialogNamed(copy.INVITATIONS_TITLE);
    await waitFor(() =>
      expect(dialog.querySelectorAll("[data-sent-group]")).toHaveLength(2),
    );
    const left = dialog.querySelector(
      `[data-sent-group="${FLAT_ID}"]`,
    ) as HTMLElement;
    expect(left).toHaveTextContent("Old flat");
    expect(within(left).queryByRole("button", { name: /Revoke/ })).toBeNull();
    const managed = dialog.querySelector(
      `[data-sent-group="${HOME_ID}"]`,
    ) as HTMLElement;
    expect(
      must(
        within(managed).queryByRole("button", {
          name: `${copy.REVOKE}: person1`,
        }),
      ),
    ).toBeInTheDocument();
  });
});

describe("D-12b-14: inviting", () => {
  test("MU-6224: a conflict is explained from a read made after it: already invited by you", async () => {
    const api = fakeHouseholdApi();
    api.defaults.households = ok([homeOf()]);
    api.defaults.lookup = (username) =>
      ok(username === "jamie" ? [{ id: JAMIE_ID, username: "jamie" }] : []);
    api.next.command.push({ ok: false, kind: "conflict", requestId: "r-c" });
    let invited = false;
    api.defaults.sent = () =>
      ok({
        items: invited
          ? [row(1, { recipient_id: JAMIE_ID, recipient_username: "jamie" })]
          : [],
        next_after: null,
      });
    mountHouseholds(`/sharing/households/${HOME_ID}/invitations`, { api });
    const dialog = await dialogNamed(copy.INVITATIONS_TITLE_FOR("Home"));
    fireEvent.change(
      must(within(dialog).queryByLabelText(copy.USERNAME_LABEL)),
      {
        target: { value: "jamie" },
      },
    );
    invited = true;
    fireEvent.click(
      must(within(dialog).queryByRole("button", { name: copy.INVITE })),
    );
    expect(
      await present(() =>
        within(dialog).queryByText(copy.INVITE_CONFLICT.invited("jamie")),
      ),
    ).toBeInTheDocument();
  });

  test("a conflict for someone already in the household says so", async () => {
    const api = fakeHouseholdApi();
    api.defaults.households = ok([homeOf()]);
    api.defaults.lookup = () => ok([{ id: SAM, username: "sam" }]);
    api.next.command.push({ ok: false, kind: "conflict" });
    mountHouseholds(`/sharing/households/${HOME_ID}/invitations`, { api });
    const dialog = await dialogNamed(copy.INVITATIONS_TITLE_FOR("Home"));
    fireEvent.change(
      must(within(dialog).queryByLabelText(copy.USERNAME_LABEL)),
      {
        target: { value: "sam" },
      },
    );
    fireEvent.click(
      must(within(dialog).queryByRole("button", { name: copy.INVITE })),
    );
    expect(
      await present(() =>
        within(dialog).queryByText(copy.INVITE_CONFLICT.member("sam")),
      ),
    ).toBeInTheDocument();
  });

  test("your own username is not invited", async () => {
    const api = fakeHouseholdApi();
    api.defaults.households = ok([homeOf()]);
    api.defaults.lookup = () => ok([{ id: ME, username: "me" }]);
    const t = mountHouseholds(`/sharing/households/${HOME_ID}/invitations`, {
      api,
    });
    const dialog = await dialogNamed(copy.INVITATIONS_TITLE_FOR("Home"));
    fireEvent.change(
      must(within(dialog).queryByLabelText(copy.USERNAME_LABEL)),
      {
        target: { value: "me" },
      },
    );
    fireEvent.click(
      must(within(dialog).queryByRole("button", { name: copy.INVITE })),
    );
    expect(
      await present(() => within(dialog).queryByText(copy.INVITE_SELF)),
    ).toBeInTheDocument();
    expect(t.api.sentCommands).toEqual([]);
  });

  test("a member's household dialog has no Invite, only the reason", async () => {
    const api = fakeHouseholdApi();
    api.defaults.households = ok([homeOf({ role: "member" })]);
    mountHouseholds(`/sharing/households/${HOME_ID}/invitations`, { api });
    const dialog = await dialogNamed(copy.INVITATIONS_TITLE_FOR("Home"));
    expect(
      await present(() =>
        within(dialog).queryByText(copy.INVITE_MANAGERS_ONLY),
      ),
    ).toBeInTheDocument();
    expect(within(dialog).queryByLabelText(copy.USERNAME_LABEL)).toBeNull();
  });
});

describe("S-HH17: the directory lookup's browse mode (PPL-4)", () => {
  test("MU-6217: Find an account browses without a query, filters here (case-insensitive substring), excludes your own account, notes the first 100, and the choice fills the username", async () => {
    const api = fakeHouseholdApi();
    api.defaults.households = ok([homeOf()]);
    api.defaults.browse = ok([
      { id: ME, username: "me" },
      { id: JAMIE_ID, username: "Jamie" },
      { id: PRIYA_ID, username: "priya" },
      ...Array.from({ length: 97 }, (_, n) => ({
        id: `dddddddd-0000-4000-8000-${n.toString(16).padStart(12, "0")}`,
        username: `user${n}`,
      })),
    ]);
    mountHouseholds(`/sharing/households/${HOME_ID}/invitations`, { api });
    const dialog = await dialogNamed(copy.INVITATIONS_TITLE_FOR("Home"));
    fireEvent.click(
      must(within(dialog).queryByRole("button", { name: copy.FIND_ACCOUNT })),
    );
    fireEvent.change(
      await present(() =>
        within(dialog).queryByLabelText(base.LOOKUP_SEARCH_LABEL),
      ),
      {
        // "m" matches "me" (your own account) and "Jamie": only Jamie is offered (MU-6217).
        target: { value: "m" },
      },
    );
    fireEvent.click(
      must(
        within(dialog).queryByRole("button", {
          name: base.LOOKUP_SEARCH_BUTTON,
        }),
      ),
    );
    const jamie = await present(() =>
      within(dialog).queryByRole("button", {
        name: `${base.LOOKUP_CHOOSE}: Jamie`,
      }),
    );
    expect(
      within(dialog).queryByRole("button", {
        name: `${base.LOOKUP_CHOOSE}: me`,
      }),
    ).toBeNull();
    expect(within(dialog).queryByText(base.LOOKUP_FIRST_100)).not.toBeNull();
    fireEvent.click(jamie);
    expect(api.calls.filter((c) => c.op === "browse")).toHaveLength(1);
    expect(api.count("lookup")).toBe(0);
    expect(
      (
        must(
          within(dialog).queryByLabelText(copy.USERNAME_LABEL),
        ) as HTMLInputElement
      ).value,
    ).toBe("Jamie");
  });

  test("MU-6216/MU-6217: a 403 (directory disabled) is remembered for the page: one browse read, the exact section still works; your own account is never offered", async () => {
    const api = fakeHouseholdApi();
    api.defaults.households = ok([homeOf()]);
    api.next.browse.push({ ok: false, kind: "forbidden", requestId: "r-403" });
    const sharingApi = fakeSharingApi();
    sharingApi.defaults.lookup = (u) =>
      ok(
        u === "me"
          ? [{ id: ME, username: "me" }]
          : [{ id: JAMIE_ID, username: u }],
      );
    const t = mountHouseholds(`/sharing/households/${HOME_ID}/invitations`, {
      api,
      sharingApi,
    });
    let dialog = await dialogNamed(copy.INVITATIONS_TITLE_FOR("Home"));
    fireEvent.click(
      must(within(dialog).queryByRole("button", { name: copy.FIND_ACCOUNT })),
    );
    fireEvent.change(
      await present(() =>
        within(dialog).queryByLabelText(base.LOOKUP_SEARCH_LABEL),
      ),
      {
        target: { value: "jam" },
      },
    );
    fireEvent.change(
      must(within(dialog).queryByLabelText(base.LOOKUP_EXACT_LABEL)),
      {
        target: { value: "jamie" },
      },
    );
    fireEvent.click(
      must(
        within(dialog).queryByRole("button", {
          name: base.LOOKUP_SEARCH_BUTTON,
        }),
      ),
    );
    await waitFor(() => expect(api.count("browse")).toBe(1));
    // The 403 remounts the protected tree: the route reopens the dialog, the lookup view and its typed input from page memory.
    t.remount();
    dialog = await dialogNamed(copy.INVITATIONS_TITLE_FOR("Home"));
    expect(
      await present(() => within(dialog).queryByText(base.LOOKUP_EXACT_ONLY)),
    ).toBeInTheDocument();
    expect(
      (
        must(
          within(dialog).queryByLabelText(base.LOOKUP_EXACT_LABEL),
        ) as HTMLInputElement
      ).value,
    ).toBe("jamie");
    await act(async () => {});
    expect(api.count("browse")).toBe(1);
    fireEvent.click(
      must(
        within(dialog).queryByRole("button", {
          name: base.LOOKUP_EXACT_BUTTON,
        }),
      ),
    );
    expect(
      await present(() =>
        within(dialog).queryByRole("button", {
          name: `${base.LOOKUP_CHOOSE}: jamie`,
        }),
      ),
    ).toBeInTheDocument();
    fireEvent.change(
      must(within(dialog).queryByLabelText(base.LOOKUP_EXACT_LABEL)),
      {
        target: { value: "me" },
      },
    );
    fireEvent.click(
      must(
        within(dialog).queryByRole("button", {
          name: base.LOOKUP_EXACT_BUTTON,
        }),
      ),
    );
    expect(
      await present(() => within(dialog).queryByText(base.LOOKUP_NONE)),
    ).toBeInTheDocument();
    expect(api.count("browse")).toBe(1);
  });

  test("MU-6225: without `browse` (every existing consumer) Search asks the exact lookup with the query, as before", async () => {
    const api = fakeSharingApi();
    mountSharing(
      <DirectoryLookup
        purpose="Add account grant"
        onChoose={() => undefined}
        onBack={() => undefined}
      />,
      { api },
    );
    fireEvent.change(must(screen.queryByLabelText(base.LOOKUP_SEARCH_LABEL)), {
      target: { value: "sa" },
    });
    fireEvent.click(
      must(screen.queryByRole("button", { name: base.LOOKUP_SEARCH_BUTTON })),
    );
    await waitFor(() =>
      expect(api.calls.filter((c) => c.op === "lookup")).toEqual([
        { op: "lookup", args: ["sa"] },
      ]),
    );
    expect(screen.queryByText(base.LOOKUP_EXACT_ONLY)).toBeNull();
  });
});

describe("D-12b-12: the header Invitations count", () => {
  test("counts pending invitations for you from GET /invitations", async () => {
    const api = fakeHouseholdApi();
    const answer = held<Invitation[]>();
    api.next.invitations.push(answer.answer);
    mountHouseholds("/sharing", { api });
    expect(
      await present(() =>
        screen.queryByRole("link", { name: copy.INVITATIONS_ACTION(null) }),
      ),
    ).toBeInTheDocument();
    await act(async () => {
      answer.release(ok([invitationFor(), invitationFor({ id: SAM })]));
    });
    expect(
      await present(() =>
        screen.queryByRole("link", { name: copy.INVITATIONS_ACTION(2) }),
      ),
    ).toBeInTheDocument();
  });
});

/** A read that fails with an Atlas request id (`uncertain`: a 5xx with the server's body). */
const FAILED_READ = {
  ok: false,
  kind: "uncertain",
  requestId: "abcd1234-0000-4000-8000-000000000000",
} as const;
const readFailed = (within: HTMLElement, kind: string) =>
  within.querySelector(
    `[data-households-read-failed="${kind}"]`,
  ) as HTMLElement | null;

describe("Review 1 F-R1-1: a failed read in the invitations dialog is a failure with Try again, never 'Loading' or a missing section", () => {
  test("MU-6231: opened for a household while the list read has failed, the dialog says so with its request id and Try again (no silent missing Invite); Try again reads the list and the Invite section appears", async () => {
    const api = fakeHouseholdApi();
    api.defaults.households = FAILED_READ as never;
    mountHouseholds(`/sharing/households/${HOME_ID}/invitations`, { api });
    const dialog = await present(() => screen.queryByRole("dialog"));
    const failed = await present(() => readFailed(dialog, "households"));
    expect(within(failed).queryByText(copy.FAILED)).not.toBeNull();
    expect(within(failed).queryByText(/abcd1234/)).not.toBeNull();
    expect(within(dialog).queryByText(copy.LOADING)).toBeNull();
    expect(section("invite")).toBeNull();
    const before = api.count("households");
    api.defaults.households = ok([homeOf()]);
    fireEvent.click(
      must(within(failed).queryByRole("button", { name: base.TRY_AGAIN })),
    );
    expect(
      await present(() =>
        within(dialog).queryByText(copy.INVITE_HEADING("Home")),
      ),
    ).toBeInTheDocument();
    expect(api.count("households")).toBeGreaterThan(before);
    expect(readFailed(dialog, "households")).toBeNull();
  });

  test("opened for a household the complete list does not have, it says you're no longer in it (no failure, no Try again)", async () => {
    const api = fakeHouseholdApi();
    api.defaults.households = ok([homeOf()]);
    mountHouseholds(`/sharing/households/${FLAT_ID}/invitations`, { api });
    const dialog = await present(() => screen.queryByRole("dialog"));
    expect(
      await present(() => within(dialog).queryByText(copy.NOT_IN_IT)),
    ).toBeInTheDocument();
    expect(readFailed(dialog, "households")).toBeNull();
  });

  test("For you and Sent by you: each failed read says what failed, with its request id and its own Try again", async () => {
    const api = fakeHouseholdApi();
    api.defaults.households = ok([homeOf()]);
    api.next.invitations.push(FAILED_READ);
    api.next.sent.push(FAILED_READ);
    mountHouseholds("/sharing/invitations", { api });
    const dialog = await dialogNamed(copy.INVITATIONS_TITLE);
    const forYou = await present(() => readFailed(dialog, "invitations"));
    // The invitations read is not the household list: it is never said as "Couldn't load your households".
    expect(within(forYou).queryByText(copy.FOR_YOU_FAILED)).not.toBeNull();
    expect(within(forYou).queryByText(/abcd1234/)).not.toBeNull();
    const sent = await present(() => readFailed(dialog, "sent"));
    expect(within(sent).queryByText(copy.SENT_FAILED)).not.toBeNull();
    expect(within(sent).queryByText(/abcd1234/)).not.toBeNull();
    fireEvent.click(
      must(within(forYou).queryByRole("button", { name: base.TRY_AGAIN })),
    );
    expect(
      await present(() => within(dialog).queryByText(copy.FOR_YOU_NONE)),
    ).toBeInTheDocument();
    fireEvent.click(
      must(within(sent).queryByRole("button", { name: base.TRY_AGAIN })),
    );
    expect(
      await present(() => within(dialog).queryByText(copy.SENT_NONE)),
    ).toBeInTheDocument();
  });
});

describe("Review 1 F-R1-2: a successful Try again completes the invite as a first try does", () => {
  test("MU-6232: an invite whose answer was lost, then a Try again that is answered: the username field is cleared (as after a first-try success), and the same key and body were sent", async () => {
    const api = fakeHouseholdApi();
    api.defaults.households = ok([homeOf()]);
    api.defaults.lookup = (username) =>
      ok(username === "jamie" ? [{ id: JAMIE_ID, username: "jamie" }] : []);
    api.next.command.push({ ok: false, kind: "uncertain" });
    mountHouseholds(`/sharing/households/${HOME_ID}/invitations`, { api });
    const dialog = await dialogNamed(copy.INVITATIONS_TITLE_FOR("Home"));
    const field = () =>
      must(within(dialog).queryByLabelText(copy.USERNAME_LABEL));
    fireEvent.change(field(), { target: { value: "jamie" } });
    fireEvent.click(
      must(within(dialog).queryByRole("button", { name: copy.INVITE })),
    );
    const retry = await present(() =>
      within(dialog).queryByRole("button", { name: base.TRY_AGAIN }),
    );
    // Premise: the uncertain first try keeps what was typed.
    expect(field()).toHaveValue("jamie");
    fireEvent.click(retry);
    await waitFor(() => expect(api.sentCommands).toHaveLength(2));
    expect(api.sentCommands[1]).toEqual(api.sentCommands[0]);
    await waitFor(() => expect(field()).toHaveValue(""));
    expect(
      within(dialog).queryByRole("button", { name: base.TRY_AGAIN }),
    ).toBeNull();
  });

  test("control: a first-try success clears the username field", async () => {
    const api = fakeHouseholdApi();
    api.defaults.households = ok([homeOf()]);
    api.defaults.lookup = () => ok([{ id: JAMIE_ID, username: "jamie" }]);
    mountHouseholds(`/sharing/households/${HOME_ID}/invitations`, { api });
    const dialog = await dialogNamed(copy.INVITATIONS_TITLE_FOR("Home"));
    const field = () =>
      must(within(dialog).queryByLabelText(copy.USERNAME_LABEL));
    fireEvent.change(field(), { target: { value: "jamie" } });
    fireEvent.click(
      must(within(dialog).queryByRole("button", { name: copy.INVITE })),
    );
    await waitFor(() => expect(api.sentCommands).toHaveLength(1));
    await waitFor(() => expect(field()).toHaveValue(""));
  });
});

describe("Review 1 F-R1-3: an invitation refused for the recipient's cap is worded by its cause", () => {
  test("MU-6234: invite_to_household answered 503 slice_capacity (the RECIPIENT has 200 pending invitations) says so, never 'you're already in 32 households'", async () => {
    const api = fakeHouseholdApi();
    api.defaults.households = ok([homeOf()]);
    api.defaults.lookup = () => ok([{ id: JAMIE_ID, username: "jamie" }]);
    api.next.command.push({ ok: false, kind: "capacity", requestId: "r-cap" });
    mountHouseholds(`/sharing/households/${HOME_ID}/invitations`, { api });
    const dialog = await dialogNamed(copy.INVITATIONS_TITLE_FOR("Home"));
    fireEvent.change(
      must(within(dialog).queryByLabelText(copy.USERNAME_LABEL)),
      { target: { value: "jamie" } },
    );
    fireEvent.click(
      must(within(dialog).queryByRole("button", { name: copy.INVITE })),
    );
    expect(
      await present(() =>
        within(dialog).queryByText(copy.INVITE_CAPACITY_REFUSED),
      ),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText(copy.CAPACITY_REFUSED)).toBeNull();
    expect(must(within(dialog).queryByText(/r-cap/))).toBeInTheDocument();
  });
});
