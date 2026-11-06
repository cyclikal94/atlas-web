import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as copy from "../../../src/features/sharing/households/copy";
import { forgetHouseholdsMemory } from "../../../src/features/sharing/households/memory";
import type { AccountInvitationSummary } from "../../../src/features/sharing/households/model";
import { installMatchMedia } from "../../helpers/match-media";
import { ME, SAM } from "../../support/data/sharing";
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
} from "../../support/sharing/households";
import { must, present, presentAll } from "../../support/sharing/present";

/**
 * WEB-12b S-HH13..S-HH16 (plan §8.2): Q21 group 2, a household's signup invitations (issue, list, revoke), in the application's own router
 * over the doubles (jsdom). FIXTURE evidence.
 */
const media = installMatchMedia({ width: 1440 });
afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
  forgetHouseholdsMemory();
});

const TOKEN = "0123456789abcdef".repeat(4);
const id = (n: number) =>
  `eeeeeeee-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const active = (
  n: number,
  household: string | null = HOME_ID,
): AccountInvitationSummary => ({
  id: id(n),
  household_id: household,
  expires_at: "2026-11-13T10:00:00Z",
});
const reasonOf = (button: HTMLElement) =>
  document.getElementById(button.getAttribute("aria-describedby") ?? "")
    ?.textContent;
async function openSignup(api = fakeHouseholdApi(), households = [homeOf()]) {
  api.defaults.households = ok(households);
  const announced: string[] = [];
  const t = mountHouseholds(`/sharing/households/${HOME_ID}/signup`, { api });
  const dialog = await present(() =>
    screen.queryByRole("dialog", {
      name: copy.SIGNUP_TITLE("Home"),
    }),
  );
  return { t, api, dialog, announced };
}
const newButton = () =>
  must(screen.queryByRole("button", { name: copy.SIGNUP_NEW }));

describe("S-HH13: issue → a fragment link shown once", () => {
  test("MU-6207/MU-6208: New invitation shows /join#t=<token> (never ?t=), Copy writes it on the click, Done forgets it; nothing reaches storage, the URL or the announcer", async () => {
    const api = fakeHouseholdApi();
    api.defaults.signupIssue = () =>
      ok({ id: id(1), token: TOKEN, expires_at: "2026-11-13T10:00:00Z" });
    const writeText = vi.fn(async (_: string) => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const storage = vi.spyOn(Storage.prototype, "setItem");
    const { t, dialog } = await openSignup(api);
    await waitFor(() => expect(newButton()).not.toBeDisabled());
    fireEvent.click(newButton());
    const field = (await present(() =>
      within(dialog).queryByLabelText(copy.SIGNUP_LINK_LABEL),
    )) as HTMLInputElement;
    expect(field.value).toBe(`${window.location.origin}/join#t=${TOKEN}`);
    expect(field.value).not.toContain("?t=");
    expect(
      must(within(dialog).queryByText(copy.SIGNUP_ISSUED)),
    ).toBeInTheDocument();
    fireEvent.click(
      must(within(dialog).queryByRole("button", { name: copy.SIGNUP_COPY })),
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(field.value));
    expect(t.router().state.location.href).not.toContain(TOKEN);
    expect(storage.mock.calls.some((c) => String(c[1]).includes(TOKEN))).toBe(
      false,
    );
    // The announcer never carries the token: its region holds only fixed sentences.
    expect(
      [...document.querySelectorAll("[aria-live]")].some((r) =>
        r.textContent?.includes(TOKEN),
      ),
    ).toBe(false);
    // A remount (any 403) keeps it until Done.
    t.remount();
    const again = await present(() =>
      screen.queryByRole("dialog", {
        name: copy.SIGNUP_TITLE("Home"),
      }),
    );
    expect(
      (
        must(
          within(again).queryByLabelText(copy.SIGNUP_LINK_LABEL),
        ) as HTMLInputElement
      ).value,
    ).toContain(TOKEN);
    fireEvent.click(
      must(within(again).queryByRole("button", { name: copy.SIGNUP_DONE })),
    );
    expect(within(again).queryByLabelText(copy.SIGNUP_LINK_LABEL)).toBeNull();
    expect(document.body.innerHTML).not.toContain(TOKEN);
    expect((await axe(document.body)).violations).toEqual([]);
  });

  test("a refused or absent clipboard selects the link and says to copy it", async () => {
    const api = fakeHouseholdApi();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async () => Promise.reject(new Error("denied")) },
    });
    const { dialog } = await openSignup(api);
    await waitFor(() => expect(newButton()).not.toBeDisabled());
    fireEvent.click(newButton());
    fireEvent.click(
      await present(() =>
        within(dialog).queryByRole("button", { name: copy.SIGNUP_COPY }),
      ),
    );
    expect(
      await present(() =>
        within(dialog).queryByText(copy.SIGNUP_COPY_FALLBACK),
      ),
    ).toBeInTheDocument();
    expect(document.activeElement).toBe(
      must(within(dialog).queryByLabelText(copy.SIGNUP_LINK_LABEL)),
    );
  });

  test("the list shows only this household's active invitations, with expiry and Revoke", async () => {
    const api = fakeHouseholdApi();
    api.defaults.signupList = ok([
      active(1),
      active(2, FLAT_ID),
      active(3, null),
    ]);
    const { dialog } = await openSignup(api);
    await waitFor(() =>
      expect(dialog.querySelectorAll("[data-signup]")).toHaveLength(1),
    );
    expect(dialog.querySelector("[data-signup]")).toHaveTextContent(
      copy.SIGNUP_ID(id(1)),
    );
    fireEvent.click(
      must(
        within(dialog).queryByRole("button", {
          name: copy.SIGNUP_REVOKE(copy.SIGNUP_ID(id(1))),
        }),
      ),
    );
    await waitFor(() => expect(api.count("signupRevoke")).toBe(1));
    expect(api.calls.find((c) => c.op === "signupRevoke")?.args).toEqual([
      id(1),
    ]);
  });
});

describe("S-HH14: the cap (20 per issuer)", () => {
  test("MU-6205: a 429 rate_limited (classified `limit`) says why and holds New invitation until the list changes", async () => {
    const api = fakeHouseholdApi();
    api.defaults.signupList = ok([active(1)]);
    api.next.signupIssue.push({ ok: false, kind: "limit", requestId: "r-429" });
    const { dialog } = await openSignup(api);
    await waitFor(() => expect(newButton()).not.toBeDisabled());
    fireEvent.click(newButton());
    expect(
      await presentAll(() => within(dialog).queryAllByText(copy.SIGNUP_LIMIT)),
    ).not.toHaveLength(0);
    await waitFor(() => expect(newButton()).toBeDisabled());
    expect(reasonOf(newButton())).toBe(copy.SIGNUP_LIMIT);
    expect(api.count("signupIssue")).toBe(1);
    // A revoke changes the list: New invitation is offered again.
    api.defaults.signupList = ok([]);
    fireEvent.click(
      must(
        within(dialog).queryByRole("button", {
          name: copy.SIGNUP_REVOKE(copy.SIGNUP_ID(id(1))),
        }),
      ),
    );
    await waitFor(() => expect(newButton()).not.toBeDisabled());
  });
});

describe("S-HH15: a lost issuance is recovered by listing, never by retrying (SHARE-7)", () => {
  test("MU-6206: an uncertain issuance sends nothing again; the list is read again and an id that is new is flagged", async () => {
    const api = fakeHouseholdApi();
    api.next.signupList.push(ok([active(1)]));
    api.next.signupIssue.push({ ok: false, kind: "uncertain" });
    api.defaults.signupList = ok([active(1), active(2)]);
    const { dialog } = await openSignup(api);
    await waitFor(() => expect(newButton()).not.toBeDisabled());
    fireEvent.click(newButton());
    expect(
      await present(() => within(dialog).queryByText(copy.SIGNUP_UNCERTAIN)),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        dialog.querySelector(`[data-signup="${id(2)}"] [data-signup-flagged]`),
      ).not.toBeNull(),
    );
    expect(
      dialog.querySelector(`[data-signup="${id(1)}"] [data-signup-flagged]`),
    ).toBeNull();
    expect(api.count("signupIssue")).toBe(1);
    expect(within(dialog).queryByLabelText(copy.SIGNUP_LINK_LABEL)).toBeNull();
  });

  test("a revoke whose answer is lost may be tried again (its effect is idempotent)", async () => {
    const api = fakeHouseholdApi();
    api.defaults.signupList = ok([active(1)]);
    api.next.signupRevoke.push({ ok: false, kind: "uncertain" });
    const { dialog } = await openSignup(api);
    const revoke = () =>
      must(
        within(dialog).queryByRole("button", {
          name: copy.SIGNUP_REVOKE(copy.SIGNUP_ID(id(1))),
        }),
      );
    await waitFor(() => expect(revoke()).toBeInTheDocument());
    fireEvent.click(revoke());
    expect(
      await present(() =>
        within(dialog).queryByText(copy.SIGNUP_REVOKE_UNCERTAIN),
      ),
    ).toBeInTheDocument();
    await waitFor(() => expect(revoke()).not.toBeDisabled());
    api.defaults.signupList = ok([]);
    fireEvent.click(revoke());
    await waitFor(() => expect(api.count("signupRevoke")).toBe(2));
    expect(
      await present(() => within(dialog).queryByText(copy.SIGNUP_NONE)),
    ).toBeInTheDocument();
  });
});

describe("S-HH16: role loss and offline", () => {
  test("MU-6221: after a list read shows you a member (you managed it before), the screen is read-only and says the invitations were revoked", async () => {
    const api = fakeHouseholdApi();
    api.defaults.signupList = ok([active(1)]);
    const { t, dialog } = await openSignup(api);
    await waitFor(() => expect(newButton()).not.toBeDisabled());
    api.defaults.households = ok([
      homeOf({
        role: "member",
        members: [
          { account_id: SAM, username: "sam", role: "manager" },
          { account_id: ME, username: "me", role: "member" },
        ],
      }),
    ]);
    // A refused issuance (403) is how a stale manager screen learns it, and the list is read again.
    api.next.signupIssue.push({
      ok: false,
      kind: "forbidden",
      requestId: "r-403",
    });
    fireEvent.click(newButton());
    expect(
      await present(() => within(dialog).queryByText(copy.SIGNUP_ROLE_LOST)),
    ).toBeInTheDocument();
    expect(
      within(dialog).queryByRole("button", { name: copy.SIGNUP_NEW }),
    ).toBeNull();
    expect(within(dialog).queryByRole("button", { name: /Revoke/ })).toBeNull();
    t.unmount();
  });

  test("offline: New invitation is disabled with the connection reason and nothing is read", async () => {
    const api = fakeHouseholdApi();
    api.defaults.households = ok([homeOf()]);
    const t = mountHouseholds(`/sharing/households/${HOME_ID}`, { api });
    await present(() =>
      screen.queryByRole("heading", { level: 2, name: "Home" }),
    );
    t.setSharing({ online: false });
    await t.navigate(`/sharing/households/${HOME_ID}/signup`);
    const dialog = await present(() =>
      screen.queryByRole("dialog", {
        name: copy.SIGNUP_TITLE("Home"),
      }),
    );
    const button = must(
      within(dialog).queryByRole("button", {
        name: copy.SIGNUP_NEW,
      }),
    );
    expect(button).toBeDisabled();
    expect(api.count("signupList")).toBe(0);
    expect(
      must(within(dialog).queryByText(copy.NEEDS_CONNECTION)),
    ).toBeInTheDocument();
  });

  test("below 768 px each row is a stacked card with labelled fields (design-coverage §7)", async () => {
    media.set({ width: 390 });
    const api = fakeHouseholdApi();
    api.defaults.signupList = ok([active(1)]);
    const { dialog } = await openSignup(api);
    await waitFor(() =>
      expect(dialog.querySelector("[data-signup-stacked]")).not.toBeNull(),
    );
    expect(dialog.querySelector("[data-signup-grid]")).toBeNull();
    expect(dialog.querySelector("[data-signup-stacked]")).toHaveTextContent(
      `${copy.SIGNUP_COL_ID}: ${copy.SIGNUP_ID(id(1))}`,
    );
  });

  test("an issuance in flight owns the page (DA-H1): a second click sends nothing", async () => {
    const api = fakeHouseholdApi();
    const answer = held<never>();
    api.next.signupIssue.push(answer.answer as never);
    const { dialog } = await openSignup(api);
    await waitFor(() => expect(newButton()).not.toBeDisabled());
    act(() => {
      newButton().click();
      newButton().click();
    });
    await act(async () => {});
    expect(api.count("signupIssue")).toBe(1);
    expect(
      must(within(dialog).queryByRole("button", { name: copy.SIGNUP_NEW })),
    ).toBeDisabled();
  });
});
