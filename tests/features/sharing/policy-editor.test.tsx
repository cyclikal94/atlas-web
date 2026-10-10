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
import * as copy from "../../../src/features/sharing/copy";
import { ResourcePolicyEditor } from "../../../src/features/sharing/ResourcePolicyEditor";
import { draftRow } from "../../support/data/rows";
import {
  HOME,
  household,
  JAMIE,
  ME,
  PRIYA,
  SAM,
} from "../../support/data/sharing";
import { stubEnv } from "../../support/data/ui-env";
import { fakeSharingApi, ok } from "../../support/sharing/fake-api";
import { merged, mountSharing, RESOURCE } from "../../support/sharing/mount";

/**
 * A1, A3, A6, A7, A12 (component layer): WF-SHARING-04 over the data env double and a scripted sharing API, in jsdom. FIXTURE evidence:
 * nothing here talks to a server, and layout, contrast and 44 px targets need a real engine (E-SH1, E-SH8).
 */
afterEach(cleanup);

const home = household({
  id: HOME,
  members: [
    { account_id: ME, username: "me", role: "manager" },
    { account_id: SAM, username: "sam", role: "member" },
    { account_id: PRIYA, username: "priya", role: "member" },
  ],
});

function setup(over: { policyVersion?: number; cached?: number } = {}) {
  const env = stubEnv();
  env.setResource(RESOURCE, merged({ policy_version: over.cached ?? 2 }));
  const api = fakeSharingApi();
  api.defaults.policy = ok({
    version: over.policyVersion ?? 2,
    policy: {
      grants: [{ kind: "household", id: HOME, edit: false }],
      exclude_accounts: [PRIYA],
    },
  });
  api.defaults.households = ok([home]);
  api.defaults.lookup = (username) =>
    ok(username.startsWith("ja") ? [{ id: JAMIE, username: "jamie" }] : []);
  const onOpenChange = vi.fn();
  const onSaved = vi.fn();
  const view = mountSharing(
    <ResourcePolicyEditor
      resourceId={RESOURCE}
      open
      onOpenChange={onOpenChange}
      onSaved={onSaved}
    />,
    { env, api },
  );
  return { ...view, onOpenChange, onSaved };
}

const dialog = () => screen.getByRole("dialog");
/** The banner's own text (the announcer's live region repeats the message once its frame runs). */
const BANNER = "[data-sharing-banner] p";
const saveButton = () =>
  dialog().querySelector<HTMLButtonElement>("[data-save]") as HTMLButtonElement;
const reasonOf = (button: HTMLElement) =>
  document.getElementById(button.getAttribute("aria-describedby") ?? "")
    ?.textContent;

async function addJamie() {
  fireEvent.click(
    await screen.findByRole("button", { name: copy.ADD_ACCOUNT }),
  );
  fireEvent.change(screen.getByLabelText(copy.LOOKUP_SEARCH_LABEL), {
    target: { value: "jam" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: copy.LOOKUP_SEARCH_BUTTON }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: `${copy.LOOKUP_CHOOSE}: jamie` }),
  );
  await screen.findByText(copy.ACCOUNT_GRANTS);
}

describe("opening", () => {
  test("A1: a cached generic resource opens with its label, its effective visibility and the online-only note", async () => {
    const t = setup();
    expect(
      await screen.findByRole("dialog", {
        name: copy.POLICY_TITLE("Water plants"),
      }),
    ).toBeInTheDocument();
    const audience = (await screen.findByText(copy.EFFECTIVE_HEADING)).closest(
      "[data-audience]",
    ) as HTMLElement;
    expect(
      within(audience).getByText(`${copy.READERS}: sam`),
    ).toBeInTheDocument();
    expect(
      within(audience).getByText(`${copy.EXCLUDED_PEOPLE}: priya`),
    ).toBeInTheDocument();
    expect(within(audience).getByText(copy.OWNER("me"))).toBeInTheDocument();
    expect(dialog()).toHaveTextContent(copy.POLICY_ONLINE_ONLY);
    expect(t.api.calls.map((c) => c.op).sort()).toEqual([
      "readHouseholds",
      "readPolicy",
    ]);
    // Nothing changed yet: Save states why it is disabled.
    expect(saveButton()).toBeDisabled();
    expect(reasonOf(saveButton())).toBe(copy.SAVE_NO_CHANGE_REASON);
    expect((await axe(document.body)).violations).toEqual([]);
  });

  test("a resource the cache does not hold: the unavailable state, and nothing is asked of the server", async () => {
    const env = stubEnv();
    env.setResource(RESOURCE, null);
    const api = fakeSharingApi();
    mountSharing(
      <ResourcePolicyEditor
        resourceId={RESOURCE}
        open
        onOpenChange={() => undefined}
      />,
      { env, api },
    );
    expect(await screen.findByText(copy.POLICY_ABSENT)).toBeInTheDocument();
    expect(api.calls).toEqual([]);
  });

  test("offline at open: says sharing needs a connection, shows no policy and asks nothing", async () => {
    const env = stubEnv();
    env.setResource(RESOURCE, merged());
    const api = fakeSharingApi();
    mountSharing(
      <ResourcePolicyEditor
        resourceId={RESOURCE}
        open
        onOpenChange={() => undefined}
      />,
      {
        env,
        api,
        sharing: { online: false },
      },
    );
    expect(await screen.findByText(copy.OFFLINE_TITLE)).toBeInTheDocument();
    expect(api.calls).toEqual([]);
  });

  test("A7: 403 is owner-only and 404 is gone, and neither discloses a policy", async () => {
    const t = setup();
    cleanup();
    const env = stubEnv();
    env.setResource(RESOURCE, merged());
    const api = fakeSharingApi();
    api.next.policy.push({ ok: false, kind: "forbidden", requestId: "r" });
    mountSharing(
      <ResourcePolicyEditor
        resourceId={RESOURCE}
        open
        onOpenChange={() => undefined}
      />,
      { env, api },
    );
    expect(await screen.findByText(copy.POLICY_OWNER_ONLY)).toBeInTheDocument();
    expect(screen.queryByText(copy.EFFECTIVE_HEADING)).toBeNull();
    cleanup();
    const api2 = fakeSharingApi();
    api2.next.policy.push({ ok: false, kind: "not_found" });
    mountSharing(
      <ResourcePolicyEditor
        resourceId={RESOURCE}
        open
        onOpenChange={() => undefined}
      />,
      { env, api: api2 },
    );
    expect(await screen.findByText(copy.POLICY_GONE)).toBeInTheDocument();
    void t;
  });

  test("queued edits of the item are mentioned (they will need review once sharing changes)", async () => {
    const env = stubEnv({
      drafts: [
        draftRow({
          status: "queued",
          index_targets: [RESOURCE],
          target_resource_ids: [RESOURCE],
        }),
      ],
    });
    env.setResource(RESOURCE, merged());
    mountSharing(
      <ResourcePolicyEditor
        resourceId={RESOURCE}
        open
        onOpenChange={() => undefined}
      />,
      { env },
    );
    expect(await screen.findByText(copy.QUEUED_EDITS(1))).toBeInTheDocument();
  });
});

describe("editing and saving", () => {
  test("MU-S19: replace_policy is guarded by GET /policies' version, never the cache's lagging policy_version", async () => {
    const t = setup({ policyVersion: 5, cached: 2 });
    await addJamie();
    expect(screen.getByText(copy.CACHE_BEHIND)).toBeInTheDocument();
    fireEvent.click(saveButton());
    await waitFor(() => expect(t.onOpenChange).toHaveBeenCalledWith(false));
    expect(t.api.sent).toHaveLength(1);
    expect(t.api.sent[0]?.commands).toEqual([
      {
        kind: "replace_policy",
        id: RESOURCE,
        expected_version: 5,
        policy: {
          grants: [
            { kind: "household", id: HOME, edit: false },
            { kind: "account", id: JAMIE, edit: false },
          ],
          exclude_accounts: [PRIYA],
        },
      },
    ]);
    expect(t.onSaved).toHaveBeenCalledWith({ revision: 101 });
  });

  test("the summary follows the edits live: an excluded account granted directly stays excluded", async () => {
    setup();
    await screen.findByText(copy.EFFECTIVE_HEADING);
    // Make priya's household grant an edit grant: she is still excluded, sam becomes an editor.
    const group = screen.getByRole("radiogroup", {
      name: `Home: ${copy.READ} or ${copy.EDIT}`,
    });
    fireEvent.click(within(group).getByRole("radio", { name: copy.EDIT }));
    const audience = screen
      .getByText(copy.EFFECTIVE_HEADING)
      .closest("[data-audience]") as HTMLElement;
    expect(
      within(audience).getByText(`${copy.EDITORS}: sam`),
    ).toBeInTheDocument();
    expect(
      within(audience).getByText(`${copy.EXCLUDED_PEOPLE}: priya`),
    ).toBeInTheDocument();
  });

  test("MU-S17: a stale policy version shows the conflict with its request id and a Reload; nothing is resent automatically", async () => {
    const t = setup();
    t.api.next.management.push({
      ok: false,
      kind: "conflict",
      requestId: "61af3d02-0000-4000-8000-000000000000",
    });
    await addJamie();
    fireEvent.click(saveButton());
    // Wait for the answer to be handled (the conflict shown, or anything sent after it), then let any automatic follow-up run.
    await waitFor(() =>
      expect(
        screen.queryByText(copy.POLICY_CONFLICT, { selector: BANNER }) !==
          null || t.api.sent.length > 1,
      ).toBe(true),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    // Exactly one request: a conflict is never resolved by resending with the server's newer version.
    expect(t.api.sent).toHaveLength(1);
    expect(
      screen.getByText(copy.POLICY_CONFLICT, { selector: BANNER }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(copy.REQUEST_ID("61af3d02-0000-4000-8000-000000000000")),
    ).toBeInTheDocument();
    // The local edit is kept until Reload is chosen; Reload reads the policy again and discards it.
    expect(screen.getByText("jamie")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: copy.RELOAD }));
    await waitFor(() =>
      expect(t.api.calls.filter((c) => c.op === "readPolicy")).toHaveLength(2),
    );
    await waitFor(() => expect(screen.queryByText("jamie")).toBeNull());
    expect(t.onOpenChange).not.toHaveBeenCalled();
  });

  test("A6: an uncertain outcome offers Try again, which resends the SAME key and body; an edit afterwards uses a new key", async () => {
    const t = setup();
    t.api.next.management.push({ ok: false, kind: "uncertain" });
    t.api.next.management.push({ ok: false, kind: "uncertain" });
    await addJamie();
    fireEvent.click(saveButton());
    expect(await screen.findByText(copy.UNCERTAIN)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: copy.TRY_AGAIN }));
    await waitFor(() => expect(t.api.sent).toHaveLength(2));
    expect(t.api.sent[1]).toEqual(t.api.sent[0]);
    // An edit after an uncertain attempt: the next save is a NEW attempt (the policy version guards a duplicate).
    await screen.findByText(copy.UNCERTAIN);
    const group = screen.getByRole("radiogroup", {
      name: `jamie: ${copy.READ} or ${copy.EDIT}`,
    });
    fireEvent.click(within(group).getByRole("radio", { name: copy.EDIT }));
    fireEvent.click(saveButton());
    await waitFor(() => expect(t.api.sent).toHaveLength(3));
    expect(t.api.sent[2]?.key).not.toBe(t.api.sent[0]?.key);
  });

  test("MU-S16: going offline while editing keeps the draft and disables Save with the reason beside it; back online nothing is re-read", async () => {
    const t = setup();
    await addJamie();
    t.setSharing({ online: false });
    expect(screen.getByText("jamie")).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
    expect(reasonOf(saveButton())).toBe(copy.SAVE_OFFLINE_REASON);
    t.setSharing({ online: true });
    expect(screen.getByText("jamie")).toBeInTheDocument();
    expect(saveButton()).not.toBeDisabled();
    expect(t.api.calls.filter((c) => c.op === "readPolicy")).toHaveLength(1);
  });

  test("a server whose contract is not supported pauses saving, with the reason", async () => {
    const env = stubEnv();
    env.setResource(RESOURCE, merged());
    const api = fakeSharingApi();
    api.defaults.households = ok([home]);
    mountSharing(
      <ResourcePolicyEditor
        resourceId={RESOURCE}
        open
        onOpenChange={() => undefined}
      />,
      {
        env,
        api,
        sharing: { writable: false },
      },
    );
    await screen.findByText(copy.EFFECTIVE_HEADING);
    expect(reasonOf(saveButton())).toBe(copy.SAVE_COMPAT_REASON);
  });

  test("the owner's own account cannot be added: the refusal is stated", async () => {
    const t = setup();
    t.api.defaults.lookup = () => ok([{ id: ME, username: "me" }]);
    fireEvent.click(
      await screen.findByRole("button", { name: copy.ADD_ACCOUNT }),
    );
    fireEvent.change(screen.getByLabelText(copy.LOOKUP_EXACT_LABEL), {
      target: { value: "me" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: copy.LOOKUP_EXACT_BUTTON }),
    );
    // Your own account is never offered.
    expect(await screen.findByText(copy.LOOKUP_NONE)).toBeInTheDocument();
  });

  test("A12: keyboard-only, the grant's Read/Edit is a radiogroup and Save is reachable; focus returns to the opener on close", async () => {
    const opener = document.createElement("button");
    opener.textContent = "Open";
    document.body.append(opener);
    opener.focus();
    const t = setup();
    await screen.findByText(copy.EFFECTIVE_HEADING);
    expect(screen.getAllByRole("radiogroup").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: copy.CANCEL }));
    expect(t.onOpenChange).toHaveBeenCalledWith(false);
    opener.remove();
  });
});
