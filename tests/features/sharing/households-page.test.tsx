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
import type { SnapshotHousehold } from "../../../src/data";
import * as base from "../../../src/features/sharing/copy";
import * as copy from "../../../src/features/sharing/households/copy";
import { forgetHouseholdsMemory } from "../../../src/features/sharing/households/memory";
import { installMatchMedia } from "../../helpers/match-media";
import { ME, record, SAM, snapshot } from "../../support/data/sharing";
import { stubEnv } from "../../support/data/ui-env";
import {
  fakeHouseholdApi,
  held,
  ok,
} from "../../support/sharing/fake-households";
import {
  FLAT_ID,
  HOME_ID,
  homeOf,
  mountHouseholds,
  PRIYA_ID,
} from "../../support/sharing/households";
import { must, present, presentAll } from "../../support/sharing/present";

/**
 * WEB-12b S-HH1..S-HH9 and S-HH12 (plan §8.2): the households page, its detail and the household commands, in the application's own router
 * and protected providers over the data env, sharing env and household api doubles (jsdom). FIXTURE evidence: the double answers, not the
 * server (the I-SH cases run against the released backend).
 */
const media = installMatchMedia({ width: 1440 });
afterEach(() => {
  cleanup();
  forgetHouseholdsMemory();
});
/**
 * A banner's own text. The announcer also writes an error banner's message into its live region on the next frame (lint R6), so a
 * page-wide text query could match it twice depending on timing; the assertions are about the banner shown.
 */
const BANNER = { selector: "[data-sharing-banner] p" };

const homeWithB5 = (primary: string | null = HOME_ID) => {
  const env = stubEnv();
  env.setDefaults(record(snapshot({ primary })));
  return env;
};
const reasonOf = (button: HTMLElement) =>
  document.getElementById(button.getAttribute("aria-describedby") ?? "")
    ?.textContent;
const detail = () =>
  document.querySelector("[data-household-detail]") as HTMLElement;
const member = (id: string) =>
  document.querySelector(`[data-member="${id}"]`) as HTMLElement;
const confirmDialog = () => present(() => screen.queryByRole("dialog"));
async function mountHome(
  households: SnapshotHousehold[] = [homeOf()],
  options: Parameters<typeof mountHouseholds>[1] & { path?: string } = {},
) {
  const api = options.api ?? fakeHouseholdApi();
  api.defaults.households = ok(households);
  const t = mountHouseholds(options.path ?? `/sharing/households/${HOME_ID}`, {
    env: options.env ?? homeWithB5(),
    api,
    ...(options.sharing ? { sharing: options.sharing } : {}),
  });
  await present(() =>
    screen.queryByRole("heading", {
      level: 2,
      name: households[0]?.name ?? "Home",
    }),
  );
  return t;
}

describe("S-HH1: rendering", () => {
  test("names and usernames are text (no markup), long names wrap, roles and 'you' are shown, the main household is badged", async () => {
    const hostile = "<b>bold</b> & co";
    const long = "A".repeat(120);
    await mountHome([
      homeOf({
        name: long,
        members: [
          { account_id: ME, username: "me", role: "manager" },
          { account_id: SAM, username: hostile, role: "member" },
        ],
      }),
    ]);
    expect(member(SAM)).toHaveTextContent(hostile);
    expect(member(SAM).querySelector("b")).toBeNull();
    expect(member(ME)).toHaveTextContent(`me (${copy.YOU})`);
    expect(member(ME)).toHaveTextContent(copy.ROLE.manager);
    expect(member(SAM)).toHaveTextContent(copy.ROLE.member);
    expect(detail().querySelector("h2")?.className).toContain("break-words");
    expect(detail()).toHaveTextContent(copy.MAIN_NOTE(long));
    expect(detail()).toHaveTextContent(copy.MAIN_BADGE);
    expect((await axe(document.body)).violations).toEqual([]);
  });

  test("the pane lists each household with its people count and your role; the capacity line counts the complete list", async () => {
    await mountHome([
      homeOf(),
      homeOf({ id: FLAT_ID, name: "Flat", role: "member" }),
    ]);
    const rows = [...document.querySelectorAll("[data-household]")].map(
      (r) => r.textContent,
    );
    expect(rows).toEqual([
      `Flat${copy.PEOPLE(2)} · ${copy.MEMBER}`,
      `Home${copy.MAIN_BADGE}${copy.PEOPLE(2)} · ${copy.YOU_MANAGE}`,
    ]);
    expect(must(screen.queryByText(copy.CAPACITY(2)))).toBeInTheDocument();
  });
});

describe("S-HH2: the E / L / Er / O states", () => {
  test("offline, never read and no snapshot: 'hasn't synced yet', never 'not in a household'; Invitations disabled with its reason", async () => {
    const env = stubEnv();
    const api = fakeHouseholdApi();
    mountHouseholds("/sharing", { env, api, sharing: { online: false } });
    expect(
      await present(() => screen.queryByText(copy.OFFLINE_NEVER)),
    ).toBeInTheDocument();
    expect(screen.queryByText(copy.EMPTY)).toBeNull();
    const invitations = must(
      screen.queryByRole("button", {
        name: copy.INVITATIONS_ACTION(null),
      }),
    );
    expect(invitations).toBeDisabled();
    expect(reasonOf(invitations)).toBe(copy.NEEDS_CONNECTION);
    expect(api.calls).toEqual([]);
  });

  test("zero households online: the checked empty state, and the header-level Invitations is reachable with the count", async () => {
    const api = fakeHouseholdApi();
    api.defaults.households = ok([]);
    api.defaults.invitations = ok([
      {
        id: PRIYA_ID,
        household_id: FLAT_ID,
        household_name: "Flat",
        sender_id: SAM,
        status: "pending",
        expires_at: "2026-11-13T10:00:00Z",
        version: 1,
      },
    ]);
    mountHouseholds("/sharing", { api });
    expect(
      await present(() => screen.queryByText(copy.EMPTY)),
    ).toBeInTheDocument();
    expect(
      await present(() =>
        screen.queryByRole("link", { name: copy.INVITATIONS_ACTION(1) }),
      ),
    ).toBeInTheDocument();
  });

  test("a failed read says so with its request id and its own Try again, which reads again", async () => {
    const api = fakeHouseholdApi();
    api.next.households.push({
      ok: false,
      kind: "uncertain",
      requestId: "abcd1234-0000-4000-8000-000000000000",
    });
    api.defaults.households = ok([homeOf()]);
    mountHouseholds("/sharing", { api });
    expect(
      await present(() => screen.queryByText(copy.FAILED, BANNER)),
    ).toBeInTheDocument();
    expect(must(screen.queryByText(/abcd1234/))).toBeInTheDocument();
    fireEvent.click(
      must(
        within(
          document.querySelector("[data-households-pane]") as HTMLElement,
        ).queryByRole("button", { name: base.TRY_AGAIN }),
      ),
    );
    expect(
      (await presentAll(() => screen.queryAllByText("Home"))).length,
    ).toBeGreaterThan(0);
  });
});

describe("S-HH3: a household you are not in", () => {
  test("a deep link to a household the complete list does not have says you're no longer in it, with a way back", async () => {
    const api = fakeHouseholdApi();
    api.defaults.households = ok([homeOf()]);
    mountHouseholds(`/sharing/households/${FLAT_ID}`, { api });
    expect(
      await present(() => screen.queryByText(copy.NOT_IN_IT)),
    ).toBeInTheDocument();
    expect(
      must(screen.queryByRole("link", { name: copy.NOT_IN_IT_LINK })),
    ).toBeInTheDocument();
  });
});

describe("S-HH4: the household commands, with their counters and rules", () => {
  test("Promote sends set_household_role with the household's version; Remove (confirmed) sends remove_household_member", async () => {
    const t = await mountHome();
    fireEvent.click(
      must(
        within(member(SAM)).queryByRole("button", {
          name: `${copy.PROMOTE}: sam`,
        }),
      ),
    );
    await waitFor(() => expect(t.api.sentCommands).toHaveLength(1));
    expect(t.api.sentCommands[0]?.commands).toEqual([
      {
        kind: "set_household_role",
        household_id: HOME_ID,
        account_id: SAM,
        expected_version: 4,
        manager: true,
      },
    ]);
    await waitFor(() =>
      expect(
        must(
          within(member(SAM)).queryByRole("button", {
            name: `${copy.REMOVE}: sam`,
          }),
        ),
      ).not.toBeDisabled(),
    );
    fireEvent.click(
      must(
        within(member(SAM)).queryByRole("button", {
          name: `${copy.REMOVE}: sam`,
        }),
      ),
    );
    const dialog = await confirmDialog();
    expect(dialog).toHaveTextContent(copy.REMOVE_CONFIRM("sam", "Home"));
    fireEvent.click(
      must(within(dialog).queryByRole("button", { name: copy.CONFIRM })),
    );
    await waitFor(() => expect(t.api.sentCommands).toHaveLength(2));
    expect(t.api.sentCommands[1]?.commands).toEqual([
      {
        kind: "remove_household_member",
        household_id: HOME_ID,
        account_id: SAM,
        expected_version: 4,
      },
    ]);
  });

  test("MU-6214: the last manager's Leave and own demotion are unavailable with the reason and fix, said once; a sole member is told they can't leave", async () => {
    const t = await mountHome();
    const leave = must(
      within(member(ME)).queryByRole("button", {
        name: `${copy.LEAVE}: Home`,
      }),
    );
    expect(leave).toBeDisabled();
    expect(reasonOf(leave)).toBe(copy.LAST_MANAGER("Home"));
    expect(screen.queryAllByText(copy.LAST_MANAGER("Home"))).toHaveLength(1);
    const demote = must(
      within(member(ME)).queryByRole("button", {
        name: `${copy.DEMOTE}: me`,
      }),
    );
    expect(demote).toBeDisabled();
    expect(reasonOf(demote)).toBe(copy.LAST_MANAGER_DEMOTE);
    t.unmount();
    forgetHouseholdsMemory();
    await mountHome([
      homeOf({
        members: [{ account_id: ME, username: "me", role: "manager" }],
      }),
    ]);
    const alone = must(
      within(member(ME)).queryByRole("button", {
        name: `${copy.LEAVE}: Home`,
      }),
    );
    expect(alone).toBeDisabled();
    expect(reasonOf(alone)).toBe(copy.SOLE_MEMBER("Home"));
  });

  test("MU-6213: a member sees no manager action (no Promote, Remove, Rename, Invitations or Signup links) and the one-line note; Leave is theirs", async () => {
    const t = await mountHome([
      homeOf({
        role: "member",
        members: [
          { account_id: SAM, username: "sam", role: "manager" },
          { account_id: ME, username: "me", role: "member" },
        ],
      }),
    ]);
    expect(
      within(detail()).queryByRole("button", { name: /Make manager|Remove/ }),
    ).toBeNull();
    for (const name of [copy.RENAME, copy.INVITE_PEOPLE, copy.SIGNUP_ENTRY])
      expect(within(detail()).queryByRole("link", { name })).toBeNull();
    expect(detail()).toHaveTextContent(copy.MEMBERS_CANT_MANAGE);
    fireEvent.click(
      must(
        within(member(ME)).queryByRole("button", {
          name: `${copy.LEAVE}: Home`,
        }),
      ),
    );
    const dialog = await confirmDialog();
    expect(dialog).toHaveTextContent(copy.LEAVE_CONFIRM("Home", true));
    fireEvent.click(
      must(within(dialog).queryByRole("button", { name: copy.CONFIRM })),
    );
    await waitFor(() => expect(t.api.sentCommands).toHaveLength(1));
    expect(t.api.sentCommands[0]?.commands).toEqual([
      {
        kind: "remove_household_member",
        household_id: HOME_ID,
        account_id: ME,
        expected_version: 4,
      },
    ]);
    await waitFor(() =>
      expect(t.router().state.location.pathname).toBe("/sharing"),
    );
  });

  test("a stale view: last_manager and conflict refusals are shown with the request id, and the list is read again", async () => {
    const api = fakeHouseholdApi();
    api.next.command.push({
      ok: false,
      kind: "last_manager",
      requestId: "r-last",
    });
    api.next.command.push({ ok: false, kind: "conflict", requestId: "r-c" });
    const t = await mountHome([homeOf()], { api });
    const reads = api.count("households");
    fireEvent.click(
      must(
        within(member(SAM)).queryByRole("button", {
          name: `${copy.PROMOTE}: sam`,
        }),
      ),
    );
    expect(
      await present(() =>
        screen.queryByText(copy.LAST_MANAGER_REFUSED, BANNER),
      ),
    ).toBeInTheDocument();
    expect(must(screen.queryByText(/r-last/))).toBeInTheDocument();
    await waitFor(() => expect(api.count("households")).toBeGreaterThan(reads));
    fireEvent.click(
      must(
        within(member(SAM)).queryByRole("button", {
          name: `${copy.PROMOTE}: sam`,
        }),
      ),
    );
    expect(
      await present(() => screen.queryByText(copy.CHANGED_ELSEWHERE, BANNER)),
    ).toBeInTheDocument();
    expect(t.api.sentCommands).toHaveLength(2);
  });

  test("the main household: Make this my main household sends set_primary_household with B5's preferences_version; Stop asks first; a conflict says it changed and reads B5 again", async () => {
    const api = fakeHouseholdApi();
    const env = homeWithB5(null);
    api.next.command.push({ ok: true, value: { revision: 1 } });
    const t = await mountHome([homeOf()], { api, env });
    fireEvent.click(
      must(screen.queryByRole("button", { name: copy.MAKE_MAIN })),
    );
    await waitFor(() => expect(t.api.sentCommands).toHaveLength(1));
    expect(t.api.sentCommands[0]?.commands).toEqual([
      {
        kind: "set_primary_household",
        household_id: HOME_ID,
        expected_version: 1,
      },
    ]);
    act(() => env.setDefaults(record(snapshot({ primary: HOME_ID }))));
    fireEvent.click(
      await present(() =>
        screen.queryByRole("button", { name: copy.STOP_MAIN }),
      ),
    );
    const dialog = await confirmDialog();
    expect(dialog).toHaveTextContent(copy.STOP_MAIN_CONFIRM("Home"));
    api.next.command.push({ ok: false, kind: "conflict", requestId: "r-p" });
    const before = t.env.calls.length;
    fireEvent.click(
      must(within(dialog).queryByRole("button", { name: copy.CONFIRM })),
    );
    await waitFor(() => expect(t.api.sentCommands).toHaveLength(2));
    expect(t.api.sentCommands[1]?.commands).toEqual([
      {
        kind: "set_primary_household",
        household_id: null,
        expected_version: 1,
      },
    ]);
    expect(
      await present(() => screen.queryByText(copy.MAIN_CHANGED, BANNER)),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        t.env.calls
          .slice(before)
          .filter((c) => c.action === "refreshDefaults" && c.args.length === 1),
      ).toHaveLength(1),
    );
  });

  test("with no B5 record the main household action waits", async () => {
    await mountHome([homeOf()], { env: stubEnv() });
    const make = must(screen.queryByRole("button", { name: copy.MAKE_MAIN }));
    expect(make).toBeDisabled();
    expect(reasonOf(make)).toBe(copy.MAIN_WAIT);
  });
});

describe("S-HH5: an uncertain household command (R8)", () => {
  test("an uncertain promotion is kept: every other action waits, Try again resends the SAME key and body, Reload does not end it", async () => {
    const api = fakeHouseholdApi();
    api.next.command.push({ ok: false, kind: "uncertain" });
    const t = await mountHome([homeOf()], { api });
    fireEvent.click(
      must(
        within(member(SAM)).queryByRole("button", {
          name: `${copy.PROMOTE}: sam`,
        }),
      ),
    );
    expect(
      await present(() => screen.queryByText(base.UNCERTAIN, BANNER)),
    ).toBeInTheDocument();
    const remove = must(
      within(member(SAM)).queryByRole("button", {
        name: `${copy.REMOVE}: sam`,
      }),
    );
    expect(remove).toBeDisabled();
    expect(reasonOf(remove)).toBe(base.UNCERTAIN_PENDING);
    fireEvent.click(must(screen.queryByRole("button", { name: base.RELOAD })));
    await act(async () => {});
    expect(screen.queryByText(base.UNCERTAIN, BANNER)).not.toBeNull();
    fireEvent.click(
      must(screen.queryByRole("button", { name: base.TRY_AGAIN })),
    );
    await waitFor(() => expect(t.api.sentCommands).toHaveLength(2));
    expect(t.api.sentCommands[1]).toEqual(t.api.sentCommands[0]);
    await waitFor(() =>
      expect(screen.queryByText(base.UNCERTAIN, BANNER)).toBeNull(),
    );
  });
});

describe("S-HH6: capacity (32 households)", () => {
  const many = Array.from({ length: 32 }, (_, n) =>
    homeOf({
      id: `aaaaaaaa-aaaa-4aaa-8aaa-${n.toString(16).padStart(12, "0")}`,
      name: `H${n.toString().padStart(2, "0")}`,
    }),
  );

  test("MU-6219: the count and the cap come from the COMPLETE list, never B5's subset: New household's Create is disabled with the reason", async () => {
    const api = fakeHouseholdApi();
    api.defaults.households = ok(many);
    // B5 names one household only.
    const t = mountHouseholds("/sharing/new", { api, env: homeWithB5() });
    expect(
      await present(() => screen.queryByText(copy.CAPACITY(32))),
    ).toBeInTheDocument();
    fireEvent.change(
      await present(() => screen.queryByLabelText(copy.NAME_LABEL)),
      {
        target: { value: "Another" },
      },
    );
    const create = must(screen.queryByRole("button", { name: copy.CREATE }));
    expect(create).toBeDisabled();
    expect(reasonOf(create)).toBe(copy.AT_CAPACITY);
    expect(t.api.sentCommands).toEqual([]);
  });

  test("the server's capacity refusal (503 slice_capacity, classified `capacity`) is explained, not left uncertain", async () => {
    const api = fakeHouseholdApi();
    api.next.command.push({ ok: false, kind: "capacity", requestId: "r-cap" });
    mountHouseholds("/sharing/new", { api });
    fireEvent.change(
      await present(() => screen.queryByLabelText(copy.NAME_LABEL)),
      {
        target: { value: "Another" },
      },
    );
    await waitFor(() =>
      expect(
        must(screen.queryByRole("button", { name: copy.CREATE })),
      ).not.toBeDisabled(),
    );
    fireEvent.click(must(screen.queryByRole("button", { name: copy.CREATE })));
    expect(
      await present(() => screen.queryByText(copy.CAPACITY_REFUSED, BANNER)),
    ).toBeInTheDocument();
    expect(screen.queryByText(base.UNCERTAIN, BANNER)).toBeNull();
    expect(screen.queryByRole("button", { name: base.TRY_AGAIN })).toBeNull();
  });
});

describe("S-HH7: a manager command refused 403 (role lost) survives the remount", () => {
  test("the tree is remounted while the refusal is on its way: the remounted detail shows the problem from page memory, the list is read again, the surfaces become read-only, and exactly one command was sent", async () => {
    const api = fakeHouseholdApi();
    const answer = held<{ revision: number }>();
    api.next.command.push(answer.answer);
    const t = await mountHome([homeOf()], { api });
    fireEvent.click(
      must(
        within(member(SAM)).queryByRole("button", {
          name: `${copy.PROMOTE}: sam`,
        }),
      ),
    );
    await waitFor(() => expect(answer.asked()).toBe(true));
    // The session's 403 handling: the protected tree is unmounted before the answer is seen, then mounted again.
    t.remount();
    api.defaults.households = ok([
      homeOf({
        role: "member",
        members: [
          { account_id: SAM, username: "sam", role: "manager" },
          { account_id: ME, username: "me", role: "member" },
        ],
      }),
    ]);
    const reads = api.count("households");
    await act(async () => {
      answer.release({ ok: false, kind: "forbidden", requestId: "r-403" });
    });
    expect(
      await present(() => screen.queryByText(copy.FORBIDDEN, BANNER)),
    ).toBeInTheDocument();
    expect(must(screen.queryByText(/r-403/))).toBeInTheDocument();
    await waitFor(() => expect(api.count("households")).toBeGreaterThan(reads));
    expect(
      await present(() => screen.queryByText(copy.LOST_MANAGER)),
    ).toBeInTheDocument();
    expect(
      within(detail()).queryByRole("button", { name: /Make manager/ }),
    ).toBeNull();
    expect(api.count("command")).toBe(1);
  });

  test("a route-addressed dialog reopens after the remount with its typed name and its problem", async () => {
    const api = fakeHouseholdApi();
    const answer = held<{ revision: number }>();
    api.next.command.push(answer.answer);
    const t = await mountHome([homeOf()], {
      api,
      path: `/sharing/households/${HOME_ID}/rename`,
    });
    const dialog = await present(() =>
      screen.queryByRole("dialog", {
        name: copy.RENAME_TITLE("Home"),
      }),
    );
    fireEvent.change(must(within(dialog).queryByLabelText(copy.NAME_LABEL)), {
      target: { value: "Our place" },
    });
    fireEvent.click(
      must(within(dialog).queryByRole("button", { name: copy.SAVE_NAME })),
    );
    await waitFor(() => expect(answer.asked()).toBe(true));
    t.remount();
    await act(async () => {
      answer.release({ ok: false, kind: "forbidden", requestId: "r-403" });
    });
    const reopened = await present(() =>
      screen.queryByRole("dialog", {
        name: copy.RENAME_TITLE("Home"),
      }),
    );
    expect(
      await present(() => within(reopened).queryByText(copy.FORBIDDEN)),
    ).toBeInTheDocument();
    expect(
      (
        must(
          within(reopened).queryByLabelText(copy.NAME_LABEL),
        ) as HTMLInputElement
      ).value,
    ).toBe("Our place");
    expect(api.count("command")).toBe(1);
  });
});

describe("S-HH8: B5 is read again after every change (R7)", () => {
  test("MU-6218: a successful role change asks for a snapshot read issued AFTER it (an acquisition with a boundary)", async () => {
    const t = await mountHome();
    const before = t.env.calls.length;
    fireEvent.click(
      must(
        within(member(SAM)).queryByRole("button", {
          name: `${copy.PROMOTE}: sam`,
        }),
      ),
    );
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

describe("S-HH9: identity isolation", () => {
  const OTHER = "99999999-9999-4999-8999-999999999999";
  test("MU-6215: another identity sees none of the first identity's lists, drafts or unresolved attempt; a late answer for the first lands nowhere", async () => {
    const api = fakeHouseholdApi();
    api.next.command.push({ ok: false, kind: "uncertain" });
    const t = mountHouseholds("/sharing/new", { api });
    fireEvent.change(
      await present(() => screen.queryByLabelText(copy.NAME_LABEL)),
      {
        target: { value: "Secret name" },
      },
    );
    await waitFor(() =>
      expect(
        must(screen.queryByRole("button", { name: copy.CREATE })),
      ).not.toBeDisabled(),
    );
    fireEvent.click(must(screen.queryByRole("button", { name: copy.CREATE })));
    expect(
      await present(() => screen.queryByText(base.UNCERTAIN, BANNER)),
    ).toBeInTheDocument();
    const late = held<SnapshotHousehold[]>();
    api.next.households.push(late.answer);
    fireEvent.click(must(screen.queryByRole("button", { name: base.RELOAD })));
    await waitFor(() => expect(late.asked()).toBe(true));
    t.setSharing({ accountId: OTHER, identity: `${OTHER}:1` });
    await act(async () => {});
    expect(screen.queryByText(base.UNCERTAIN, BANNER)).toBeNull();
    expect(
      (must(screen.queryByLabelText(copy.NAME_LABEL)) as HTMLInputElement)
        .value,
    ).toBe("");
    await act(async () => {
      late.release(ok([homeOf({ name: "First identity's home" })]));
    });
    expect(screen.queryByText("First identity's home")).toBeNull();
  });
});

describe("S-HH12: Decision H, a same-named create asks first", () => {
  test("MU-6220: with a household of the same trimmed, case-folded name, Create asks; Create another sends it", async () => {
    const api = fakeHouseholdApi();
    api.defaults.households = ok([homeOf()]);
    const t = mountHouseholds("/sharing/new", { api });
    fireEvent.change(
      await present(() => screen.queryByLabelText(copy.NAME_LABEL)),
      {
        target: { value: "  home " },
      },
    );
    await waitFor(() =>
      expect(
        must(screen.queryByRole("button", { name: copy.CREATE })),
      ).not.toBeDisabled(),
    );
    fireEvent.click(must(screen.queryByRole("button", { name: copy.CREATE })));
    expect(
      await present(() => screen.queryByText(copy.SAME_NAME("Home"))),
    ).toBeInTheDocument();
    expect(t.api.sentCommands).toEqual([]);
    fireEvent.click(
      must(screen.queryByRole("button", { name: copy.CREATE_ANOTHER })),
    );
    await waitFor(() => expect(t.api.sentCommands).toHaveLength(1));
    expect(t.api.sentCommands[0]?.commands[0]).toMatchObject({
      kind: "create_household",
      name: "home",
    });
  });

  test("control: a different name is created at once", async () => {
    const api = fakeHouseholdApi();
    api.defaults.households = ok([homeOf()]);
    const t = mountHouseholds("/sharing/new", { api });
    fireEvent.change(
      await present(() => screen.queryByLabelText(copy.NAME_LABEL)),
      {
        target: { value: "Flat" },
      },
    );
    await waitFor(() =>
      expect(
        must(screen.queryByRole("button", { name: copy.CREATE })),
      ).not.toBeDisabled(),
    );
    fireEvent.click(must(screen.queryByRole("button", { name: copy.CREATE })));
    await waitFor(() => expect(t.api.sentCommands).toHaveLength(1));
    await waitFor(() =>
      expect(t.router().state.location.pathname).toMatch(
        /^\/sharing\/households\//,
      ),
    );
  });
});

describe("D-12b-1: the responsive layout", () => {
  test("below 1280 px the list alone; a household's route shows its detail alone with '‹ Households'", async () => {
    media.set({ width: 834 });
    const api = fakeHouseholdApi();
    api.defaults.households = ok([homeOf()]);
    const t = mountHouseholds("/sharing", { api, env: homeWithB5() });
    await present(() => screen.queryByText(copy.CAPACITY(1)));
    expect(document.querySelector("[data-household-detail]")).toBeNull();
    await t.navigate(`/sharing/households/${HOME_ID}`);
    expect(
      await present(() =>
        screen.queryByRole("link", { name: copy.BACK_TO_HOUSEHOLDS }),
      ),
    ).toBeInTheDocument();
    expect(document.querySelector("[data-households-pane]")).toBeNull();
    expect(detail()).not.toBeNull();
  });
});
