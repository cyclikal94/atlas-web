import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import * as sharingCopy from "../../src/features/sharing/copy";
import { HouseholdsMinimal } from "../../src/features/sharing/HouseholdsMinimal";
import { encodePolicyDraft } from "../../src/features/sharing/model/recovery-fields";
import { ResourcePolicyEditor } from "../../src/features/sharing/ResourcePolicyEditor";
import { forgetAllRetained } from "../../src/features/sharing/retained";
import { UNAVAILABLE_WHILE_RELOADING } from "../../src/lib/form-recovery/RecoveryBanner";
import {
  CHECK_AGAIN,
  CHECKED_FOUND,
  CHECKED_NONE,
  NOT_RESTORED,
  RESTORE_COPY,
  WITHHELD,
} from "../../src/lib/form-recovery/RecoveryNotice";
import { recoveryLockName } from "../../src/lib/form-recovery/tab-identity";
import { noteNavigation } from "../../src/lib/pwa/navigation";
import { installMatchMedia } from "../helpers/match-media";
import {
  HOME,
  household,
  PRIYA,
  SAM,
  ME as SHARING_ME,
} from "../support/data/sharing";
import { stubEnv } from "../support/data/ui-env";
import {
  forgetRecoveryWorld,
  freeze,
  installRecoveryLocks,
  left,
  recoveryLocks,
  store,
  unfreeze,
  withRecovery,
} from "../support/recovery-editors";
import { fakeSharingApi, ok } from "../support/sharing/fake-api";
import { merged, mountSharing, RESOURCE } from "../support/sharing/mount";

/**
 * WEB-14a revision 53 (Kieran, 3 November 2026: /Users/kieran/atlas/atlas-orchestrator/approval/web14a-r53-decisions-20261103.json and
 * delivery/handoffs/web14a-r53-decisions-20261103.md), over ACTUAL product editors (`RecoveryNotice` in the household screen and a
 * resource's sharing policy) in the page's real registry, recovery identity, models and sessions:
 *
 *  - D-R53-1 (family `recovery-owner-probe-self-contention`): a copy withheld because another page seemed to hold it (a live tab, or an
 *    older build's exclusive probe of the owner's lock) is said, with "Check saved copies again": on the person's request only, offered
 *    (never restored, submitted or removed); a genuine owner still withholds.
 *  - D-R53-2 (families `restored-form-focus-exposure-order`, `update-recovery-action-focus`): another saved copy chosen while the restored
 *    banner stays shown focuses that form's first eligible field once applied (D1's owner-control fallback where it has none), never the
 *    removed button; never focus the person moved after the choice; nothing for a choice not applied, a navigation or the owner's unmount.
 */
installMatchMedia({ width: 1440 });
beforeAll(installRecoveryLocks);
afterEach(() => {
  forgetRecoveryWorld();
  forgetAllRetained();
  for (const holder of ["OLD", "LIVE"]) recoveryLocks().leave(holder);
});

const home = household({
  id: HOME,
  members: [
    { account_id: SHARING_ME, username: "me", role: "manager" },
    { account_id: SAM, username: "sam", role: "member" },
  ],
});
const textCopy = (text: string) => JSON.stringify({ v: 1, text });
const CREATE = "household-create";
const INVITE = `household-invite:${HOME}`;
const OLDER = "2026-11-03T10:00:00.000Z";
const NEWER = "2026-11-03T11:00:00.000Z";

function mountHouseholds() {
  const api = fakeSharingApi();
  api.defaults.households = ok([home]);
  const view = mountSharing(<HouseholdsMinimal />, {
    env: withRecovery(stubEnv()),
    api,
  });
  return { api, view };
}
const createName = () =>
  screen.getByLabelText(sharingCopy.CREATE_NAME) as HTMLInputElement;
const createForm = () => createName().closest("form") as HTMLElement;
const invitee = () =>
  screen.getByLabelText(sharingCopy.INVITE_LABEL("Home")) as HTMLInputElement;
const inviteForm = () => invitee().closest("form") as HTMLElement;
const checkIn = (form: HTMLElement) =>
  within(form).queryByRole("button", { name: CHECK_AGAIN });
const restoreIn = (form: HTMLElement, savedAt: string) =>
  within(form).queryByRole("button", { name: RESTORE_COPY(savedAt) });
const restoredIn = (form: HTMLElement) =>
  form.querySelector('[data-recovery-state="restored"]');
const sent = (api: ReturnType<typeof fakeSharingApi>) =>
  api.calls.filter((call) => !call.op.startsWith("read"));

describe("D-R53-1: Check saved copies again (household screen)", () => {
  test("OMITTED-ALL under an older build's exclusive probe: both forms say a copy is withheld and restore nothing; after release each form's explicit check offers its copy, never restores it; nothing sent or removed", async () => {
    await left(CREATE, textCopy("Left flat"), { tab: "gone-tab" });
    await left(INVITE, "left-invitee", { tab: "gone-tab" });
    recoveryLocks().held.set(recoveryLockName("gone-tab"), "OLD");
    const { api } = mountHouseholds();
    await waitFor(() => expect(checkIn(createForm())).not.toBeNull());
    await waitFor(() => expect(checkIn(inviteForm())).not.toBeNull());
    for (const form of [createForm(), inviteForm()]) {
      expect(within(form).queryByText(WITHHELD)).not.toBeNull();
      expect(restoredIn(form), "nothing restored").toBeNull();
      expect(form.querySelector("[data-recovery-alternatives]")).toBeNull();
    }
    expect(createName().value).toBe("");
    expect(invitee().value).toBe("");
    // The old probe ends; nothing looks again by itself.
    recoveryLocks().leave("OLD");
    const lists = vi.spyOn(store(), "list");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(
      lists,
      "no read without the person's request",
    ).not.toHaveBeenCalled();
    const check = checkIn(createForm()) as HTMLElement;
    check.focus();
    fireEvent.click(check);
    await waitFor(() =>
      expect(
        within(createForm()).queryByText(CHECKED_FOUND),
        "the check says what it found",
      ).not.toBeNull(),
    );
    expect(
      createForm().querySelector("[data-recovery-alternatives]"),
      "the copy is offered",
    ).not.toBeNull();
    expect(createName().value, "offered, never restored by the check").toBe("");
    expect(restoredIn(createForm())).toBeNull();
    expect(checkIn(createForm()), "the action stays once used").toHaveFocus();
    expect(
      within(inviteForm()).queryByText(WITHHELD),
      "the invitation's look is its own: still withheld",
    ).not.toBeNull();
    fireEvent.click(checkIn(inviteForm()) as HTMLElement);
    await waitFor(() =>
      expect(within(inviteForm()).queryByText(CHECKED_FOUND)).not.toBeNull(),
    );
    expect(invitee().value).toBe("");
    expect(await store().list(CREATE)).toHaveLength(1);
    expect(await store().list(INVITE)).toHaveLength(1);
    expect(sent(api), "nothing is sent").toEqual([]);
  });

  test("OMITTED-ONE: the copy no probe holds is restored; the probed one is withheld; checked again it is offered beside the restored copy", async () => {
    await left(CREATE, textCopy("Older flat"), {
      tab: "gone-old",
      savedAt: OLDER,
    });
    await left(CREATE, textCopy("Newer flat"), {
      tab: "gone-new",
      savedAt: NEWER,
    });
    recoveryLocks().held.set(recoveryLockName("gone-old"), "OLD");
    mountHouseholds();
    await waitFor(() => expect(createName().value).toBe("Newer flat"));
    await waitFor(() => expect(checkIn(createForm())).not.toBeNull());
    expect(restoreIn(createForm(), OLDER)).toBeNull();
    recoveryLocks().leave("OLD");
    fireEvent.click(checkIn(createForm()) as HTMLElement);
    await waitFor(() => expect(restoreIn(createForm(), OLDER)).not.toBeNull());
    expect(createName().value, "the restored copy is unchanged").toBe(
      "Newer flat",
    );
    expect(restoredIn(createForm())).not.toBeNull();
  });

  test("GENUINE LIVE OWNER: checking again while its tab is open keeps the copy withheld and says so; after it closes the next check offers it", async () => {
    await left(CREATE, textCopy("Live flat"), { tab: "live-tab" });
    recoveryLocks().held.set(recoveryLockName("live-tab"), "LIVE");
    mountHouseholds();
    await waitFor(() => expect(checkIn(createForm())).not.toBeNull());
    fireEvent.click(checkIn(createForm()) as HTMLElement);
    await waitFor(() =>
      expect(within(createForm()).queryByText(WITHHELD)).not.toBeNull(),
    );
    // A second, repeated check is as safe: still withheld, nothing offered or restored.
    fireEvent.click(checkIn(createForm()) as HTMLElement);
    fireEvent.click(checkIn(createForm()) as HTMLElement);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(
      createForm().querySelector("[data-recovery-alternatives]"),
    ).toBeNull();
    expect(createName().value).toBe("");
    recoveryLocks().leave("LIVE");
    fireEvent.click(checkIn(createForm()) as HTMLElement);
    await waitFor(() =>
      expect(within(createForm()).queryByText(CHECKED_FOUND)).not.toBeNull(),
    );
    expect(createName().value).toBe("");
  });

  test("CONTROL: with nothing withheld no check is shown", async () => {
    mountHouseholds();
    await waitFor(() => expect(createName()).not.toBeNull());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(checkIn(createForm())).toBeNull();
    expect(checkIn(inviteForm())).toBeNull();
  });

  test("a check that finds nothing left (the live tab resolved its copy) says so, and stays to check again", async () => {
    await left(CREATE, textCopy("Live flat"), { tab: "live-tab" });
    recoveryLocks().held.set(recoveryLockName("live-tab"), "LIVE");
    mountHouseholds();
    await waitFor(() => expect(checkIn(createForm())).not.toBeNull());
    await store().discard(CREATE, "live-tab");
    recoveryLocks().leave("LIVE");
    fireEvent.click(checkIn(createForm()) as HTMLElement);
    await waitFor(() =>
      expect(within(createForm()).queryByText(CHECKED_NONE)).not.toBeNull(),
    );
    expect(checkIn(createForm())).not.toBeNull();
  });

  test("while an update reload is prepared the check is unavailable, with its reason, and reads nothing", async () => {
    await left(CREATE, textCopy("Live flat"), { tab: "live-tab" });
    recoveryLocks().held.set(recoveryLockName("live-tab"), "LIVE");
    mountHouseholds();
    await waitFor(() => expect(checkIn(createForm())).not.toBeNull());
    act(() => freeze());
    const check = checkIn(createForm()) as HTMLButtonElement;
    await waitFor(() => expect(check.disabled).toBe(true));
    expect(
      within(createForm()).queryByText(UNAVAILABLE_WHILE_RELOADING),
    ).not.toBeNull();
    act(() => unfreeze());
    await waitFor(() =>
      expect((checkIn(createForm()) as HTMLButtonElement).disabled).toBe(false),
    );
  });
});

describe("D-R53-2: choosing another saved copy while the restored banner stays shown", () => {
  async function twoCopies() {
    await left(CREATE, textCopy("Older flat"), {
      tab: "gone-old",
      savedAt: OLDER,
    });
    await left(CREATE, textCopy("Newer flat"), {
      tab: "gone-new",
      savedAt: NEWER,
    });
    const mounted = mountHouseholds();
    await waitFor(() => expect(createName().value).toBe("Newer flat"));
    await waitFor(() => expect(createName()).toHaveFocus());
    return mounted;
  }

  test("the chosen copy's form takes focus at its first field once applied (never the removed button); a repeated choice does the same; nothing sent", async () => {
    const { api } = await twoCopies();
    const older = restoreIn(createForm(), OLDER) as HTMLElement;
    older.focus();
    fireEvent.click(older);
    await waitFor(() => expect(createName().value).toBe("Older flat"));
    expect(restoredIn(createForm()), "the banner stays shown").not.toBeNull();
    expect(older.isConnected, "the chosen copy's button went").toBe(false);
    await waitFor(() => expect(createName()).toHaveFocus());
    const newer = restoreIn(createForm(), NEWER) as HTMLElement;
    newer.focus();
    fireEvent.click(newer);
    await waitFor(() => expect(createName().value).toBe("Newer flat"));
    await waitFor(() => expect(createName()).toHaveFocus());
    expect(sent(api)).toEqual([]);
  });

  test("a browser that does not focus a clicked button (focus stays where it was at the choice) still lands on the first field", async () => {
    await twoCopies();
    invitee().focus();
    fireEvent.click(restoreIn(createForm(), OLDER) as HTMLElement);
    await waitFor(() => expect(createName().value).toBe("Older flat"));
    await waitFor(() => expect(createName()).toHaveFocus());
  });

  /** The choice's re-read of the chosen copy held (entered/released, never a timer). */
  function holdChoiceRead() {
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let entered = false;
    const load = store().load.bind(store());
    vi.spyOn(store(), "load").mockImplementation(async (context, id) => {
      const answer = await load(context, id);
      entered = true;
      await gate;
      return answer;
    });
    return { open, entered: () => entered };
  }

  test("focus the person moves while the choice is read is never taken", async () => {
    await twoCopies();
    const read = holdChoiceRead();
    const older = restoreIn(createForm(), OLDER) as HTMLElement;
    older.focus();
    fireEvent.click(older);
    await waitFor(() => expect(read.entered()).toBe(true));
    invitee().focus();
    await act(async () => read.open());
    await waitFor(() => expect(createName().value).toBe("Older flat"));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(invitee(), "the person's new place keeps focus").toHaveFocus();
  });

  test("a navigation while the choice is read ends its request", async () => {
    await twoCopies();
    const read = holdChoiceRead();
    const older = restoreIn(createForm(), OLDER) as HTMLElement;
    older.focus();
    fireEvent.click(older);
    await waitFor(() => expect(read.entered()).toBe(true));
    act(() => noteNavigation());
    await act(async () => read.open());
    await waitFor(() => expect(createName().value).toBe("Older flat"));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(createName()).not.toHaveFocus();
  });

  test("the owner's unmount while the choice is read ends its request", async () => {
    const { view } = await twoCopies();
    const read = holdChoiceRead();
    const older = restoreIn(createForm(), OLDER) as HTMLElement;
    older.focus();
    fireEvent.click(older);
    await waitFor(() => expect(read.entered()).toBe(true));
    view.unmount();
    await act(async () => read.open());
    const outside = document.createElement("input");
    document.body.append(outside);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(
      document.activeElement === document.body ||
        !document.activeElement?.isConnected,
    ).toBe(true);
    outside.remove();
  });

  test("a choice NOT applied (the copy gone meanwhile) focuses nothing and says so", async () => {
    await twoCopies();
    await store().discard(CREATE, "gone-old");
    const older = restoreIn(createForm(), OLDER) as HTMLElement;
    older.focus();
    fireEvent.click(older);
    await waitFor(() =>
      expect(within(createForm()).queryByText(NOT_RESTORED)).not.toBeNull(),
    );
    expect(createName().value).toBe("Newer flat");
    expect(createName()).not.toHaveFocus();
  });

  test("CONTROL (D2 retained): a choice made with NO restored banner shown focuses the field through the banner's own arrival", async () => {
    await left(CREATE, textCopy("Live flat"), { tab: "live-tab" });
    recoveryLocks().held.set(recoveryLockName("live-tab"), "LIVE");
    mountHouseholds();
    await waitFor(() => expect(checkIn(createForm())).not.toBeNull());
    recoveryLocks().leave("LIVE");
    const check = checkIn(createForm()) as HTMLElement;
    check.focus();
    fireEvent.click(check);
    await waitFor(() =>
      expect(
        within(createForm()).queryByRole("button", {
          name: /^Restore the copy saved/,
        }),
        "the check offers the copy",
      ).not.toBeNull(),
    );
    const offered = within(createForm()).getByRole("button", {
      name: /^Restore the copy saved/,
    });
    offered.focus();
    fireEvent.click(offered);
    await waitFor(() => expect(createName().value).toBe("Live flat"));
    await waitFor(() => expect(createName()).toHaveFocus());
  });
});

describe("D-R53-2 with D1's fallback: a resource's sharing policy", () => {
  const CONTEXT = `sharing-policy:${RESOURCE}`;
  const policyHome = household({
    id: HOME,
    members: [
      { account_id: SHARING_ME, username: "me", role: "manager" },
      { account_id: SAM, username: "sam", role: "member" },
      { account_id: PRIYA, username: "priya", role: "member" },
    ],
  });
  const mount = () => {
    const env = withRecovery(stubEnv());
    env.setResource(RESOURCE, merged({ policy_version: 2 }));
    const api = fakeSharingApi();
    api.defaults.policy = ok({
      version: 2,
      policy: {
        grants: [{ kind: "household", id: HOME, edit: false }],
        exclude_accounts: [PRIYA],
      },
    });
    api.defaults.households = ok([policyHome]);
    return mountSharing(
      <ResourcePolicyEditor
        resourceId={RESOURCE}
        open
        onOpenChange={() => undefined}
        onSaved={() => undefined}
      />,
      { env, api },
    );
  };
  const grant = () =>
    screen.queryByRole("radiogroup", {
      name: `Home: ${sharingCopy.READ} or ${sharingCopy.EDIT}`,
    });

  test("choosing a copy with NO grants focuses Add account grant (the owner's control); choosing the granted copy back focuses its chosen access", async () => {
    await left(
      CONTEXT,
      encodePolicyDraft({
        policy: { grants: [], exclude_accounts: [PRIYA] },
        base: 2,
      }),
      { tab: "gone-old", savedAt: OLDER },
    );
    await left(
      CONTEXT,
      encodePolicyDraft({
        policy: {
          grants: [{ kind: "household", id: HOME, edit: true }],
          exclude_accounts: [PRIYA],
        },
        base: 2,
      }),
      { tab: "gone-new", savedAt: NEWER },
    );
    mount();
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe(sharingCopy.EDIT),
    );
    const older = screen.getByRole("button", { name: RESTORE_COPY(OLDER) });
    older.focus();
    fireEvent.click(older);
    await waitFor(() => expect(grant()).toBeNull());
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: sharingCopy.ADD_ACCOUNT }),
      ).toHaveFocus(),
    );
    const newer = screen.getByRole("button", { name: RESTORE_COPY(NEWER) });
    newer.focus();
    fireEvent.click(newer);
    await waitFor(() => expect(grant()).not.toBeNull());
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe(sharingCopy.EDIT),
    );
    expect(grant()?.contains(document.activeElement)).toBe(true);
  });
});
