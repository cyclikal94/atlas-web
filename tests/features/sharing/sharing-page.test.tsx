import {
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
import { fakeSharingApi, ok } from "../../support/sharing/fake-api";
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
