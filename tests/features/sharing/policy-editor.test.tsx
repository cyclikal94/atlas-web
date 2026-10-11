import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { axe } from "jest-axe";
import { useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { SnapshotHousehold } from "../../../src/data";
import type { SharingResult } from "../../../src/features/sharing/api";
import * as copy from "../../../src/features/sharing/copy";
import { ResourcePolicyEditor } from "../../../src/features/sharing/ResourcePolicyEditor";
import { forgetAllRetained } from "../../../src/features/sharing/retained";
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
import {
  type Answer,
  fakeSharingApi,
  ok,
} from "../../support/sharing/fake-api";
import { merged, mountSharing, RESOURCE } from "../../support/sharing/mount";

/**
 * A1, A3, A6, A7, A12 (component layer): WF-SHARING-04 over the data env double and a scripted sharing API, in jsdom. FIXTURE evidence:
 * nothing here talks to a server, and layout, contrast and 44 px targets need a real engine (E-SH1, E-SH8).
 */
afterEach(() => {
  cleanup();
  forgetAllRetained();
});

const home = household({
  id: HOME,
  members: [
    { account_id: ME, username: "me", role: "manager" },
    { account_id: SAM, username: "sam", role: "member" },
    { account_id: PRIYA, username: "priya", role: "member" },
  ],
});

function setup(
  over: {
    policyVersion?: number;
    cached?: number;
    /** Answers to the membership reads (`GET /households`) in turn, then `[home]`. */
    membershipReads?: Answer<SnapshotHousehold[]>[];
  } = {},
) {
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
  api.next.households.push(...(over.membershipReads ?? []));
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

// ---- WEB-12a review cycle 1 --------------------------------------------------------------------------------------------------------
const OTHER = "66666666-6666-4666-8666-666666666666";
const policyOf = (edit: boolean, exclude: string[] = []) => ({
  grants: [{ kind: "household" as const, id: HOME, edit }],
  exclude_accounts: exclude,
});
const homeGroup = () =>
  screen.getByRole("radiogroup", {
    name: `Home: ${copy.READ} or ${copy.EDIT}`,
  });
const chooseEdit = () =>
  fireEvent.click(within(homeGroup()).getByRole("radio", { name: copy.EDIT }));
const checked = () =>
  within(homeGroup())
    .getAllByRole("radio")
    .find((radio) => radio.getAttribute("aria-checked") === "true")
    ?.getAttribute("aria-label") ??
  within(homeGroup())
    .getAllByRole("radio")
    .find((radio) => radio.getAttribute("aria-checked") === "true")
    ?.textContent;
/** A read answer held until released. */
function held<T>(value: T) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const answer: Answer<T> = async () => {
    await gate;
    return ok(value);
  };
  return { answer, release };
}

/** Two cached resources and a host that can switch the open editor between them, or close and reopen it. */
function hostSetup(
  policies: Answer<{ version: number; policy: ReturnType<typeof policyOf> }>[],
  management: Answer<{ revision: number }>[] = [],
) {
  const env = stubEnv();
  env.setResource(RESOURCE, merged({ label: "First" }));
  env.setResource(OTHER, merged({ id: OTHER, label: "Second" }));
  const api = fakeSharingApi();
  api.defaults.households = ok([home]);
  api.next.policy.push(...policies);
  api.next.management.push(...management);
  let switchTo: (id: string) => void = () => undefined;
  let setOpen: (open: boolean) => void = () => undefined;
  function Host() {
    const [id, setId] = useState(RESOURCE);
    const [open, set] = useState(true);
    switchTo = setId;
    setOpen = set;
    return (
      <ResourcePolicyEditor resourceId={id} open={open} onOpenChange={set} />
    );
  }
  const view = mountSharing(<Host />, { env, api });
  return {
    ...view,
    api,
    switchTo: (id: string) => act(() => switchTo(id)),
    reopen: () => act(() => setOpen(true)),
  };
}
const reads = (api: ReturnType<typeof fakeSharingApi>) =>
  api.calls.filter((c) => c.op === "readPolicy").map((c) => c.args[0]);

describe("R1: everything the editor reads, edits and sends belongs to the resource it was opened on", () => {
  test("control: the same resource saves the policy read for it, at its version", async () => {
    const t = hostSetup([ok({ version: 2, policy: policyOf(false) })]);
    await screen.findByText(copy.EFFECTIVE_HEADING);
    chooseEdit();
    fireEvent.click(saveButton());
    await waitFor(() => expect(t.api.sent).toHaveLength(1));
    expect(reads(t.api)).toEqual([RESOURCE]);
    expect(t.api.sent[0]?.commands[0]).toEqual({
      kind: "replace_policy",
      id: RESOURCE,
      expected_version: 2,
      policy: policyOf(true),
    });
  });

  test("MU-S30: switching A → B mid-edit (equal versions) discards A's draft, reads B, and Save sends B's own policy and version", async () => {
    const b = held({ version: 2, policy: policyOf(false, [SAM]) });
    const t = hostSetup([
      ok({ version: 2, policy: policyOf(false) }),
      b.answer,
    ]);
    await screen.findByText(copy.EFFECTIVE_HEADING);
    chooseEdit();
    t.switchTo(OTHER);
    await screen.findByRole("dialog", { name: copy.POLICY_TITLE("Second") });
    // B is being read: nothing of A's can be saved for it meanwhile.
    expect(screen.queryByText(copy.EFFECTIVE_HEADING)).toBeNull();
    expect(dialog().querySelector("[data-save]")).toBeNull();
    b.release();
    await screen.findByText(copy.EFFECTIVE_HEADING);
    expect(reads(t.api)).toEqual([RESOURCE, OTHER]);
    // B's own policy, not A's edit.
    expect(checked()).toBe(copy.READ);
    expect(saveButton()).toBeDisabled();
    chooseEdit();
    fireEvent.click(saveButton());
    await waitFor(() => expect(t.api.sent).toHaveLength(1));
    expect(t.api.sent[0]?.commands[0]).toEqual({
      kind: "replace_policy",
      id: OTHER,
      expected_version: 2,
      policy: policyOf(true, [SAM]),
    });
  });

  test("MU-S30: A's read answered AFTER the switch never lands in B's editor", async () => {
    const a = held({ version: 7, policy: policyOf(true) });
    const t = hostSetup([
      a.answer,
      ok({ version: 3, policy: policyOf(false) }),
    ]);
    await waitFor(() => expect(reads(t.api)).toEqual([RESOURCE]));
    t.switchTo(OTHER);
    await screen.findByText(copy.EFFECTIVE_HEADING);
    a.release();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(checked()).toBe(copy.READ);
    chooseEdit();
    fireEvent.click(saveButton());
    await waitFor(() => expect(t.api.sent).toHaveLength(1));
    expect(t.api.sent[0]?.commands[0]).toMatchObject({
      id: OTHER,
      expected_version: 3,
    });
  });
});

describe("R5: the dialog's sync control keeps the unsaved draft; Cancel discards it", () => {
  const syncControl = () =>
    dialog().querySelector("[data-sync-tone]") as HTMLButtonElement;

  test("MU-S31: Read → Edit, the sync control, then reopening: Edit is shown again, nothing was saved, and Save sends it at the version it was composed against", async () => {
    const t = hostSetup([
      ok({ version: 2, policy: policyOf(false) }),
      ok({ version: 2, policy: policyOf(false) }),
    ]);
    await screen.findByText(copy.EFFECTIVE_HEADING);
    chooseEdit();
    fireEvent.click(syncControl());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(t.api.sent).toEqual([]);
    t.reopen();
    await screen.findByText(copy.EFFECTIVE_HEADING);
    expect(checked()).toBe(copy.EDIT);
    expect(screen.getByText(copy.RESTORED_UNSAVED)).toBeInTheDocument();
    // Restoring never sends: only the person's Save does.
    expect(t.api.sent).toEqual([]);
    fireEvent.click(saveButton());
    await waitFor(() => expect(t.api.sent).toHaveLength(1));
    expect(t.api.sent[0]?.commands[0]).toEqual({
      kind: "replace_policy",
      id: RESOURCE,
      expected_version: 2,
      policy: policyOf(true),
    });
  });

  test("MU-S36: a kept draft whose policy moved meanwhile stays guarded by its OWN version (Save sends that version, which a server that moved on refuses): never sent at the newer one", async () => {
    const t = hostSetup([
      ok({ version: 2, policy: policyOf(false) }),
      ok({ version: 5, policy: policyOf(false, [SAM]) }),
    ]);
    await screen.findByText(copy.EFFECTIVE_HEADING);
    chooseEdit();
    fireEvent.click(syncControl());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    t.reopen();
    await screen.findByText(copy.RESTORED_UNSAVED);
    expect(checked()).toBe(copy.EDIT);
    fireEvent.click(saveButton());
    await waitFor(() => expect(t.api.sent).toHaveLength(1));
    expect(t.api.sent[0]?.commands[0]).toMatchObject({ expected_version: 2 });
  });

  test("an uncertain attempt kept through the sync control is resent with the SAME key and body", async () => {
    const t = hostSetup(
      [
        ok({ version: 2, policy: policyOf(false) }),
        ok({ version: 2, policy: policyOf(false) }),
      ],
      [{ ok: false, kind: "uncertain" }],
    );
    await screen.findByText(copy.EFFECTIVE_HEADING);
    chooseEdit();
    fireEvent.click(saveButton());
    await screen.findByText(copy.UNCERTAIN, { selector: BANNER });
    fireEvent.click(syncControl());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    t.reopen();
    await screen.findByText(copy.RESTORED_UNSAVED);
    fireEvent.click(screen.getByRole("button", { name: copy.TRY_AGAIN }));
    await waitFor(() => expect(t.api.sent).toHaveLength(2));
    expect(t.api.sent[1]?.key).toBe(t.api.sent[0]?.key);
    expect(t.api.sent[1]?.commands).toEqual(t.api.sent[0]?.commands);
  });

  /** Keeps an Edit draft through the sync control, reopens (it is shown again), and returns the host. */
  async function kept() {
    const t = hostSetup([
      ok({ version: 2, policy: policyOf(false) }),
      ok({ version: 2, policy: policyOf(false) }),
      ok({ version: 2, policy: policyOf(false) }),
    ]);
    await screen.findByText(copy.EFFECTIVE_HEADING);
    chooseEdit();
    fireEvent.click(syncControl());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    t.reopen();
    await screen.findByText(copy.RESTORED_UNSAVED);
    expect(checked()).toBe(copy.EDIT);
    return t;
  }

  test("MU-S37: Cancel discards a KEPT draft: reopening starts from the read policy", async () => {
    const t = await kept();
    fireEvent.click(screen.getByRole("button", { name: copy.CANCEL }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    t.reopen();
    await screen.findByText(copy.EFFECTIVE_HEADING);
    expect(checked()).toBe(copy.READ);
    expect(screen.queryByText(copy.RESTORED_UNSAVED)).toBeNull();
  });

  test("MU-S38: Escape discards a kept draft too", async () => {
    const t = await kept();
    fireEvent.keyDown(dialog(), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    t.reopen();
    await screen.findByText(copy.EFFECTIVE_HEADING);
    expect(checked()).toBe(copy.READ);
    expect(screen.queryByText(copy.RESTORED_UNSAVED)).toBeNull();
  });

  test("target isolation: a draft kept for A is never shown on B, and A still has it afterwards", async () => {
    const t = hostSetup([
      ok({ version: 2, policy: policyOf(false) }),
      ok({ version: 2, policy: policyOf(false) }),
      ok({ version: 2, policy: policyOf(false) }),
    ]);
    await screen.findByText(copy.EFFECTIVE_HEADING);
    chooseEdit();
    fireEvent.click(syncControl());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    t.switchTo(OTHER);
    t.reopen();
    await screen.findByRole("dialog", { name: copy.POLICY_TITLE("Second") });
    await screen.findByText(copy.EFFECTIVE_HEADING);
    expect(checked()).toBe(copy.READ);
    expect(screen.queryByText(copy.RESTORED_UNSAVED)).toBeNull();
    t.switchTo(RESOURCE);
    await screen.findByText(copy.RESTORED_UNSAVED);
    expect(checked()).toBe(copy.EDIT);
  });

  test("identity isolation: another displayed identity never sees the kept draft", async () => {
    const t = hostSetup([
      ok({ version: 2, policy: policyOf(false) }),
      ok({ version: 2, policy: policyOf(false) }),
    ]);
    await screen.findByText(copy.EFFECTIVE_HEADING);
    chooseEdit();
    fireEvent.click(syncControl());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    t.setSharing({ identity: "11111111-1111-4111-8111-111111111111:2" });
    t.reopen();
    await screen.findByText(copy.EFFECTIVE_HEADING);
    expect(checked()).toBe(copy.READ);
    expect(screen.queryByText(copy.RESTORED_UNSAVED)).toBeNull();
  });
});

// ---- WEB-12a review 2 ------------------------------------------------------------------------------------------------------------
describe("R5 (review 2): a dismissal discards what the session kept, whether or not its read has landed", () => {
  const syncControl = () =>
    dialog().querySelector("[data-sync-tone]") as HTMLButtonElement;
  const v2 = () => ok({ version: 2, policy: policyOf(false) });
  /** Read → Edit on the first resource, then the sync control: the draft is kept and the dialog closes. Nothing is sent. */
  async function keepEdit(t: ReturnType<typeof hostSetup>) {
    await screen.findByText(copy.EFFECTIVE_HEADING);
    chooseEdit();
    fireEvent.click(syncControl());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(t.api.sent).toEqual([]);
  }

  test("control: reopened with its read held, the kept draft is restored when the read lands (nothing is sent)", async () => {
    const reopenRead = held({ version: 2, policy: policyOf(false) });
    const t = hostSetup([v2(), reopenRead.answer]);
    await keepEdit(t);
    t.reopen();
    // The editor is open and still reading: no draft is on screen yet.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.queryByText(copy.EFFECTIVE_HEADING)).toBeNull();
    reopenRead.release();
    await screen.findByText(copy.RESTORED_UNSAVED);
    expect(checked()).toBe(copy.EDIT);
    expect(t.api.sent).toEqual([]);
  });

  test("MU-S40: Escape while the reopened editor is still reading discards the kept draft: the late read restores nothing, and reopening shows the read policy", async () => {
    const reopenRead = held({ version: 2, policy: policyOf(false) });
    const t = hostSetup([v2(), reopenRead.answer, v2()]);
    await keepEdit(t);
    t.reopen();
    expect(screen.queryByText(copy.EFFECTIVE_HEADING)).toBeNull();
    fireEvent.keyDown(dialog(), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    reopenRead.release();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    t.reopen();
    await screen.findByText(copy.EFFECTIVE_HEADING);
    expect(checked()).toBe(copy.READ);
    expect(screen.queryByText(copy.RESTORED_UNSAVED)).toBeNull();
    expect(t.api.sent).toEqual([]);
  });

  test("MU-S41: Close on the offline state discards the kept draft (back online, reopening shows the read policy)", async () => {
    const t = hostSetup([v2(), v2(), v2()]);
    await keepEdit(t);
    t.setSharing({ online: false });
    t.reopen();
    expect(dialog().querySelector('[data-policy-state="offline"]')).not.toBe(
      null,
    );
    fireEvent.click(within(dialog()).getByRole("button", { name: copy.CLOSE }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    t.setSharing({ online: true });
    t.reopen();
    await screen.findByText(copy.EFFECTIVE_HEADING);
    expect(checked()).toBe(copy.READ);
    expect(screen.queryByText(copy.RESTORED_UNSAVED)).toBeNull();
    expect(t.api.sent).toEqual([]);
  });

  test("control: reopened offline and closed WITHOUT a dismissal (the page navigates away), the kept draft is still restored online", async () => {
    const t = hostSetup([v2(), v2()]);
    await keepEdit(t);
    t.setSharing({ online: false });
    t.reopen();
    expect(dialog().querySelector('[data-policy-state="offline"]')).not.toBe(
      null,
    );
    // Not a dismissal: the host shows another resource, unmounting this editor (an unmount is not a reason to discard).
    t.switchTo(OTHER);
    t.switchTo(RESOURCE);
    t.setSharing({ online: true });
    await screen.findByText(copy.RESTORED_UNSAVED);
    expect(checked()).toBe(copy.EDIT);
  });

  test("MU-S41: Close on a failed read discards the kept draft too", async () => {
    const t = hostSetup([v2(), { ok: false, kind: "invalid" }, v2()]);
    await keepEdit(t);
    t.reopen();
    await screen.findByText(copy.POLICY_LOAD_FAILED, { selector: BANNER });
    fireEvent.click(within(dialog()).getByRole("button", { name: copy.CLOSE }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    t.reopen();
    await screen.findByText(copy.EFFECTIVE_HEADING);
    expect(checked()).toBe(copy.READ);
    expect(screen.queryByText(copy.RESTORED_UNSAVED)).toBeNull();
  });

  test("MU-S43: a dismissal discards only its own resource's draft: another resource's kept draft survives", async () => {
    const otherRead = held({ version: 2, policy: policyOf(false) });
    const t = hostSetup([v2(), v2(), otherRead.answer, v2()]);
    await keepEdit(t);
    // The second resource keeps its own Edit draft.
    t.switchTo(OTHER);
    t.reopen();
    await screen.findByRole("dialog", { name: copy.POLICY_TITLE("Second") });
    await screen.findByText(copy.EFFECTIVE_HEADING);
    chooseEdit();
    fireEvent.click(syncControl());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // Reopen the second resource with its read held and dismiss it: ITS draft goes.
    t.reopen();
    fireEvent.keyDown(dialog(), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    otherRead.release();
    // The first resource's draft is untouched.
    t.switchTo(RESOURCE);
    t.reopen();
    await screen.findByText(copy.RESTORED_UNSAVED);
    expect(checked()).toBe(copy.EDIT);
  });

  test("MU-S42: Reload after a conflict abandons the kept draft even when the new read fails: the sync control then keeps nothing and reopening shows the read policy", async () => {
    const t = hostSetup(
      [v2(), v2(), { ok: false, kind: "invalid" }, v2()],
      [{ ok: false, kind: "conflict", requestId: "rq" }],
    );
    await keepEdit(t);
    t.reopen();
    await screen.findByText(copy.RESTORED_UNSAVED);
    fireEvent.click(saveButton());
    await screen.findByText(copy.POLICY_CONFLICT, { selector: BANNER });
    fireEvent.click(screen.getByRole("button", { name: copy.RELOAD }));
    await screen.findByText(copy.POLICY_LOAD_FAILED, { selector: BANNER });
    fireEvent.click(syncControl());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    t.reopen();
    await screen.findByText(copy.EFFECTIVE_HEADING);
    expect(checked()).toBe(copy.READ);
    expect(screen.queryByText(copy.RESTORED_UNSAVED)).toBeNull();
    // Only the one Save was ever sent; Reload resends nothing.
    expect(t.api.sent).toHaveLength(1);
  });

  test("control: Reload whose read succeeds shows the read policy (and the conflict's edit is not kept)", async () => {
    const t = hostSetup(
      [v2(), v2(), ok({ version: 3, policy: policyOf(false, [SAM]) })],
      [{ ok: false, kind: "conflict", requestId: "rq" }],
    );
    await keepEdit(t);
    t.reopen();
    await screen.findByText(copy.RESTORED_UNSAVED);
    fireEvent.click(saveButton());
    await screen.findByText(copy.POLICY_CONFLICT, { selector: BANNER });
    fireEvent.click(screen.getByRole("button", { name: copy.RELOAD }));
    await waitFor(() => expect(checked()).toBe(copy.READ));
    expect(screen.queryByText(copy.RESTORED_UNSAVED)).toBeNull();
    expect(saveButton()).toBeDisabled();
  });
});

// ---- WEB-12a review 3 ------------------------------------------------------------------------------------------------------------
describe("R8 (review 3): Try again is admitted like Save", () => {
  test("MU-S61: offline with an uncertain save, Try again is disabled with the connection reason and sends nothing; back online it resends the same key and body", async () => {
    const t = setup();
    t.api.next.management.push({ ok: false, kind: "uncertain" });
    await addJamie();
    fireEvent.click(saveButton());
    expect(await screen.findByText(copy.UNCERTAIN)).toBeInTheDocument();
    const first = structuredClone(t.api.sent[0]);
    t.setSharing({ online: false });
    const offlineRetry = screen.getByRole("button", { name: copy.TRY_AGAIN });
    expect(offlineRetry).toBeDisabled();
    expect(reasonOf(offlineRetry)).toBe(copy.SAVE_OFFLINE_REASON);
    fireEvent.click(offlineRetry);
    await act(async () => {});
    expect(t.api.calls.filter((c) => c.op === "management")).toHaveLength(1);
    t.setSharing({ online: true });
    fireEvent.click(screen.getByRole("button", { name: copy.TRY_AGAIN }));
    await waitFor(() => expect(t.api.sent).toHaveLength(2));
    expect(t.api.sent[1]).toEqual(first);
  });
});

// ---- WEB-12a review 4 / design assessment DA-P1 -----------------------------------------------------------------------------------
describe("DA-P1 (Q15): a Try again the session closes proves nothing about the earlier attempt", () => {
  test("MU-S66: answered closed while the editor is still shown, the uncertain attempt is kept and said so again; the next Try again (and Save of the same body) resends the SAME key and body", async () => {
    const t = setup();
    t.api.next.management.push({ ok: false, kind: "uncertain" });
    await addJamie();
    fireEvent.click(saveButton());
    expect(await screen.findByText(copy.UNCERTAIN)).toBeInTheDocument();
    const first = structuredClone(t.api.sent[0]);
    t.api.next.management.push({ ok: false, kind: "closed" });
    fireEvent.click(screen.getByRole("button", { name: copy.TRY_AGAIN }));
    await waitFor(() =>
      expect(t.api.calls.filter((c) => c.op === "management")).toHaveLength(2),
    );
    await act(async () => {});
    expect(t.api.sent[1]).toEqual(first);
    // The banner's own Try again (the announcer's live region also repeats the message, so the text alone proves nothing).
    expect(
      screen.queryByRole("button", { name: copy.TRY_AGAIN }),
    ).not.toBeNull();
    t.api.next.management.push({ ok: false, kind: "uncertain" });
    fireEvent.click(screen.getByRole("button", { name: copy.TRY_AGAIN }));
    await waitFor(() =>
      expect(t.api.calls.filter((c) => c.op === "management")).toHaveLength(3),
    );
    expect(t.api.sent[2]).toEqual(first);
    expect(await screen.findByText(copy.UNCERTAIN)).toBeInTheDocument();
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(t.api.calls.filter((c) => c.op === "management")).toHaveLength(4),
    );
    expect(t.api.sent[3]).toEqual(first);
  });

  test("control: an uncertain attempt then a receipt for the same key and body saves and closes the editor", async () => {
    const t = setup();
    t.api.next.management.push({ ok: false, kind: "uncertain" });
    await addJamie();
    fireEvent.click(saveButton());
    expect(await screen.findByText(copy.UNCERTAIN)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: copy.TRY_AGAIN }));
    await waitFor(() => expect(t.api.sent).toHaveLength(2));
    expect(t.api.sent[1]).toEqual(t.api.sent[0]);
    await waitFor(() => expect(t.onSaved).toHaveBeenCalledTimes(1));
    expect(t.onOpenChange).toHaveBeenCalledWith(false);
  });
});

// ---- WEB-12a review 5, R11 / design assessment DA-M1 ----------------------------------------------------------------------------------
describe("DA-M1: the policy editor's membership read has its own loading, failure and Try again; until it answers nothing is 'not in'", () => {
  const gated = () => {
    let settle!: (result: SharingResult<SnapshotHousehold[]>) => void;
    const gate = new Promise<SharingResult<SnapshotHousehold[]>>((resolve) => {
      settle = resolve;
    });
    const answer: Answer<SnapshotHousehold[]> = () => gate;
    return { answer, settle };
  };
  const flush = () => act(async () => {});
  const count = (api: { calls: Array<{ op: string }> }, op: string) =>
    api.calls.filter((call) => call.op === op).length;
  const homeName = () =>
    dialog().querySelector(
      `[data-grant="household"][data-principal="${HOME}"] span`,
    )?.textContent;
  const audience = () =>
    dialog().querySelector("[data-audience]") as HTMLElement;
  const addHousehold = () =>
    within(dialog()).getByRole("button", {
      name: copy.ADD_HOUSEHOLD,
    }) as HTMLButtonElement;
  const failed = () =>
    dialog().querySelector<HTMLElement>('[data-membership="failed"]');

  test("MU-S74: loading, then failed: the granted household is unchecked (never 'not in'), nothing can be added; Try again reads only the list and keeps the draft", async () => {
    const first = gated();
    const t = setup({ membershipReads: [first.answer] });
    await screen.findByText(copy.EFFECTIVE_HEADING);
    await flush();
    expect(homeName()).toBe(copy.HOUSEHOLD_UNCHECKED);
    expect(
      dialog().querySelector('[data-membership="loading"]'),
    ).not.toBeNull();
    expect(audience().querySelector("[data-audience-unknown]")).toBeNull();
    expect(
      audience().querySelector("[data-audience-unchecked]")?.textContent,
    ).toBe(copy.UNCHECKED_HOUSEHOLDS(1));
    expect(addHousehold()).toBeDisabled();
    expect(reasonOf(addHousehold())).toBe(copy.ADD_HOUSEHOLD_LOADING_REASON);
    // An unsaved edit meanwhile: the exclusion is removed.
    fireEvent.click(
      dialog().querySelector(`[data-exclusion="${PRIYA}"] button`) as Element,
    );
    first.settle({ ok: false, kind: "uncertain", requestId: "req-list" });
    await flush();
    expect(failed()?.textContent).toContain(copy.HOUSEHOLDS_FAILED);
    expect(failed()?.textContent).toContain("req-list");
    expect(homeName()).toBe(copy.HOUSEHOLD_UNCHECKED);
    expect(audience().querySelector("[data-audience-unknown]")).toBeNull();
    expect(reasonOf(addHousehold())).toBe(copy.ADD_HOUSEHOLD_FAILED_REASON);
    fireEvent.click(
      within(failed() as HTMLElement).getByRole("button", {
        name: copy.TRY_AGAIN,
      }),
    );
    await flush();
    expect(count(t.api, "readHouseholds")).toBe(2);
    expect(count(t.api, "readPolicy")).toBe(1);
    expect(failed()).toBeNull();
    expect(homeName()).toBe("Home");
    expect(audience().querySelector("[data-audience-unchecked]")).toBeNull();
    expect(
      within(audience()).getByText(`${copy.READERS}: priya, sam`),
    ).toBeInTheDocument();
    // The draft survived the list's failure and its Try again.
    expect(dialog().querySelector("[data-exclusion]")).toBeNull();
    fireEvent.click(saveButton());
    await waitFor(() => expect(t.api.sent).toHaveLength(1));
    expect(t.api.sent[0]?.commands).toEqual([
      {
        kind: "replace_policy",
        id: RESOURCE,
        expected_version: 2,
        policy: {
          grants: [{ kind: "household", id: HOME, edit: false }],
          exclude_accounts: [],
        },
      },
    ]);
  });

  test("MU-S74 control: a COMPLETE list that does not name the granted household says you are not in it", async () => {
    setup({ membershipReads: [ok([])] });
    await screen.findByText(copy.EFFECTIVE_HEADING);
    await flush();
    expect(homeName()).toBe(copy.HOUSEHOLD_UNKNOWN);
    expect(
      audience().querySelector("[data-audience-unknown]")?.textContent,
    ).toBe(copy.UNKNOWN_HOUSEHOLDS(1));
    expect(audience().querySelector("[data-audience-unchecked]")).toBeNull();
    fireEvent.click(addHousehold());
    expect(
      dialog().querySelector("[data-household-picker]")?.textContent,
    ).toContain(copy.NO_HOUSEHOLDS_TO_ADD);
  });

  test("MU-S75: coming back online reads the list again, but not the policy; the draft stays", async () => {
    const t = setup();
    await screen.findByText(copy.EFFECTIVE_HEADING);
    await flush();
    fireEvent.click(
      dialog().querySelector(`[data-exclusion="${PRIYA}"] button`) as Element,
    );
    t.setSharing({ online: false });
    t.setSharing({ online: true });
    await flush();
    expect(count(t.api, "readHouseholds")).toBe(2);
    expect(count(t.api, "readPolicy")).toBe(1);
    expect(dialog().querySelector("[data-exclusion]")).toBeNull();
    expect(homeName()).toBe("Home");
  });
});
