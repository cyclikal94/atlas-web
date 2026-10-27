import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import {
  ADD_CONTEXT,
  AddSourceDialog,
} from "../../src/features/calendars/AddSourceDialog";
import * as sharingCopy from "../../src/features/sharing/copy";
import { DefaultsEditor } from "../../src/features/sharing/DefaultsEditor";
import { HouseholdsMinimal } from "../../src/features/sharing/HouseholdsMinimal";
import { emptyPolicy } from "../../src/features/sharing/model/policy-draft";
import { encodePolicyDraft } from "../../src/features/sharing/model/recovery-fields";
import { ResourcePolicyEditor } from "../../src/features/sharing/ResourcePolicyEditor";
import { forgetAllRetained } from "../../src/features/sharing/retained";
import type { TaskActions } from "../../src/features/tasks/actions";
import {
  CORRECTION_COPY,
  CorrectionDialog,
} from "../../src/features/tasks/detail/CorrectionDialog";
import {
  RECORD_COPY,
  RecordCard,
} from "../../src/features/tasks/detail/RecordCard";
import { UNAVAILABLE_WHILE_RELOADING } from "../../src/lib/form-recovery/RecoveryBanner";
import { NOT_REMOVED } from "../../src/lib/form-recovery/RecoveryNotice";
import {
  flushDirty,
  pageFormRegistry,
} from "../../src/lib/form-recovery/registry";
import { installMatchMedia } from "../helpers/match-media";
import {
  HOME,
  household,
  PRIYA,
  record,
  SAM,
  ME as SHARING_ME,
  snapshot,
} from "../support/data/sharing";
import { stubEnv } from "../support/data/ui-env";
import {
  contextsOf,
  forgetRecoveryWorld,
  freeze,
  holdDiscards,
  installRecoveryLocks,
  left,
  protectedTree,
  rowFor,
  store,
  texts,
  withRecovery,
} from "../support/recovery-editors";
import { fakeSharingApi, ok } from "../support/sharing/fake-api";
import { merged, mountSharing, RESOURCE } from "../support/sharing/mount";
import { ME } from "../support/tasks/world";

/**
 * WEB-14a revision 38 (review of revision 37, R40-A, family `production-form-update-recovery-registration`; design assessment C2, I5, Q2,
 * schedule S1): "Discard instead" in every product editor that offered it after an await. For each actual caller: a copy is restored, the
 * person discards it, the store's removal is HELD (entered/released, never a timer), the person types newer input, the removal completes.
 * The newer input must survive on screen AND in the editor's recoverable model (the update's save writes it); the ordinary discard with no
 * newer input still clears the restored input and its copy; a removal that fails leaves the newer input too, and says so; while an update
 * reload is prepared "Discard instead" is unavailable and nothing changes. Calendar Link/Manage and the entry-history fix, whose dialogs a
 * screen host opens, are covered over the production port in `recovery-owner-hosts.test.tsx`.
 */
installMatchMedia({ width: 1440 });
beforeAll(installRecoveryLocks);
afterEach(() => {
  forgetRecoveryWorld();
  forgetAllRetained();
});

const discardButton = (within_: HTMLElement = document.body) =>
  within(within_).getByRole("button", { name: "Discard instead" });

/**
 * The S1 schedule for one caller: the copy restored (`shown` reads it), Discard instead clicked with its removal held, `edit` makes the
 * newer input, the removal released. Returns once it has settled.
 */
async function lateDiscard(steps: {
  scope?: () => HTMLElement;
  shown(): string;
  restored: string;
  edit(): void;
  newer: string;
}): Promise<void> {
  await waitFor(() => expect(steps.shown()).toBe(steps.restored));
  const held = holdDiscards();
  fireEvent.click(discardButton(steps.scope?.()));
  await waitFor(() => expect(held.entered()).toBe(true));
  steps.edit();
  expect(steps.shown()).toBe(steps.newer);
  await act(async () => {
    await held.release();
  });
  await waitFor(() => expect(store().discard).toHaveBeenCalled());
}

/** The editor's recoverable model holds what it shows: the update's save writes the newer input as the copy of `context`. */
async function savedAs(context: string): Promise<unknown[]> {
  expect(await flushDirty(pageFormRegistry)).not.toContain("failed");
  return (await texts(context)).map((text) => JSON.parse(text));
}

describe("calendar Add source (AddSourceDialog.tsx)", () => {
  const label = () =>
    screen.getByRole("textbox", { name: "Label" }) as HTMLInputElement;
  const restoredCopy = JSON.stringify({
    v: 1,
    label: "Old restored label",
    timezone: "Europe/London",
  });
  const mount = () =>
    render(
      protectedTree(
        <AddSourceDialog
          online
          identity={`${ME}:1`}
          onClose={() => undefined}
        />,
      ),
    );

  test("S1: newer input survives a late removal, on screen and in the model", async () => {
    await left(ADD_CONTEXT, restoredCopy);
    mount();
    await lateDiscard({
      shown: () => label().value,
      restored: "Old restored label",
      edit: () =>
        fireEvent.change(label(), { target: { value: "Newer label" } }),
      newer: "Newer label",
    });
    expect(label().value).toBe("Newer label");
    expect(await savedAs(ADD_CONTEXT)).toContainEqual(
      expect.objectContaining({ label: "Newer label" }),
    );
  });

  test("S1: input typed back to the restored text after the discard is newer input too", async () => {
    await left(ADD_CONTEXT, restoredCopy);
    mount();
    await lateDiscard({
      shown: () => label().value,
      restored: "Old restored label",
      edit: () =>
        fireEvent.change(label(), { target: { value: "Old restored label" } }),
      newer: "Old restored label",
    });
    expect(label().value).toBe("Old restored label");
    expect(contextsOf(pageFormRegistry.dirty())).toEqual([ADD_CONTEXT]);
  });

  test("S1: a removal that FAILS leaves the newer input as it is and says the copy was not removed", async () => {
    await left(ADD_CONTEXT, restoredCopy);
    mount();
    await waitFor(() => expect(label().value).toBe("Old restored label"));
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    vi.spyOn(store(), "discard").mockImplementation(async () => {
      await gate;
      return "failed";
    });
    fireEvent.click(discardButton());
    fireEvent.change(label(), { target: { value: "Newer label" } });
    await act(async () => {
      open();
      await gate;
    });
    // Shown in the notice (and announced: the announcer repeats it).
    expect(
      await screen.findByText(NOT_REMOVED, {
        selector: "p[data-recovery-outcome]",
      }),
    ).toBeInTheDocument();
    expect(label().value).toBe("Newer label");
  });

  test("CONTROL: with no newer input the discard clears the restored input and removes its copy", async () => {
    await left(ADD_CONTEXT, restoredCopy);
    mount();
    await waitFor(() => expect(label().value).toBe("Old restored label"));
    fireEvent.click(discardButton());
    // At the gesture, not when the removal lands.
    expect(label().value).toBe("");
    await waitFor(async () => expect(await texts(ADD_CONTEXT)).toEqual([]));
    expect(pageFormRegistry.dirty()).toHaveLength(0);
  });

  test("while an update reload is prepared Discard instead is unavailable and nothing changes", async () => {
    await left(ADD_CONTEXT, restoredCopy);
    mount();
    await waitFor(() => expect(label().value).toBe("Old restored label"));
    act(freeze);
    const button = discardButton();
    expect(button).toBeDisabled();
    expect(
      document.getElementById(button.getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toBe(UNAVAILABLE_WHILE_RELOADING);
    fireEvent.click(button);
    expect(label().value).toBe("Old restored label");
    expect(await texts(ADD_CONTEXT)).toHaveLength(1);
  });
});

describe("households: create and invite (HouseholdsMinimal.tsx)", () => {
  const home = household({
    id: HOME,
    members: [
      { account_id: SHARING_ME, username: "me", role: "manager" },
      { account_id: SAM, username: "sam", role: "member" },
    ],
  });
  const textCopy = (text: string) => JSON.stringify({ v: 1, text });
  const mount = () => {
    const api = fakeSharingApi();
    api.defaults.households = ok([home]);
    return mountSharing(<HouseholdsMinimal />, {
      env: withRecovery(stubEnv()),
      api,
    });
  };
  const createForm = () =>
    screen
      .getByLabelText(sharingCopy.CREATE_NAME)
      .closest("form") as HTMLElement;
  const createName = () =>
    screen.getByLabelText(sharingCopy.CREATE_NAME) as HTMLInputElement;
  const inviteForm = () =>
    screen
      .getByLabelText(sharingCopy.INVITE_LABEL("Home"))
      .closest("form") as HTMLElement;
  const invitee = () =>
    screen.getByLabelText(sharingCopy.INVITE_LABEL("Home")) as HTMLInputElement;

  test("S1 create: newer input survives a late removal, on screen and in the model", async () => {
    await left("household-create", textCopy("Restored flat"));
    mount();
    await screen.findByText("Home");
    await lateDiscard({
      scope: createForm,
      shown: () => createName().value,
      restored: "Restored flat",
      edit: () =>
        fireEvent.change(createName(), { target: { value: "Newer flat" } }),
      newer: "Newer flat",
    });
    expect(createName().value).toBe("Newer flat");
    expect(await savedAs("household-create")).toContainEqual({
      v: 1,
      text: "Newer flat",
    });
  });

  test("S1 invite: newer input survives a late removal; the create form is untouched", async () => {
    await left(`household-invite:${HOME}`, textCopy("restored-user"));
    mount();
    await screen.findByText("Home");
    await lateDiscard({
      scope: inviteForm,
      shown: () => invitee().value,
      restored: "restored-user",
      edit: () =>
        fireEvent.change(invitee(), { target: { value: "newer-user" } }),
      newer: "newer-user",
    });
    expect(invitee().value).toBe("newer-user");
    expect(createName().value).toBe("");
    expect(await savedAs(`household-invite:${HOME}`)).toContainEqual({
      v: 1,
      text: "newer-user",
    });
  });

  test("CONTROL create: with no newer input the discard clears the name and removes its copy", async () => {
    await left("household-create", textCopy("Restored flat"));
    mount();
    await waitFor(() => expect(createName().value).toBe("Restored flat"));
    fireEvent.click(discardButton(createForm()));
    expect(createName().value).toBe("");
    await waitFor(async () =>
      expect(await texts("household-create")).toEqual([]),
    );
  });

  test("I7: a create answered after newer input was typed keeps that input (a send never clears what it did not send)", async () => {
    const api = fakeSharingApi();
    api.defaults.households = ok([home]);
    let answer!: () => void;
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    // The create's answer is held until the newer input has been typed.
    api.next.management.push(async () => {
      await answered;
      return ok({ revision: 1 });
    });
    mountSharing(<HouseholdsMinimal />, {
      env: withRecovery(stubEnv()),
      api,
    });
    await screen.findByText("Home");
    fireEvent.change(createName(), { target: { value: "Flat 2" } });
    fireEvent.click(
      screen.getByRole("button", { name: sharingCopy.CREATE_BUTTON }),
    );
    await waitFor(() => expect(api.sent).toHaveLength(1));
    fireEvent.change(createName(), { target: { value: "Flat 3" } });
    await act(async () => {
      answer();
      await answered;
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(createName().value).toBe("Flat 3");
    expect(contextsOf(pageFormRegistry.dirty())).toContain("household-create");
  });

  test("CONTROL I7: a create answered with nothing typed since clears the name", async () => {
    const api = fakeSharingApi();
    api.defaults.households = ok([home]);
    const t = mountSharing(<HouseholdsMinimal />, {
      env: withRecovery(stubEnv()),
      api,
    });
    await screen.findByText("Home");
    fireEvent.change(createName(), { target: { value: "Flat 2" } });
    fireEvent.click(
      screen.getByRole("button", { name: sharingCopy.CREATE_BUTTON }),
    );
    await waitFor(() => expect(t.api.sent).toHaveLength(1));
    await waitFor(() => expect(createName().value).toBe(""));
  });
});

describe("sharing defaults, one layer (DefaultsEditor.tsx)", () => {
  const PERSONAL = "sharing-defaults:personal:personal:field";
  const mount = () => {
    const env = withRecovery(stubEnv());
    const snap = snapshot({
      primary: HOME,
      households: [
        household({
          id: HOME,
          role: "manager",
          members: [
            { account_id: SHARING_ME, username: "me", role: "manager" },
            { account_id: SAM, username: "sam", role: "member" },
          ],
        }),
      ],
    });
    env.setDefaults(
      record(snap, { fetched_at: Date.now(), issued_at: Date.now() }),
    );
    const api = fakeSharingApi();
    api.defaults.households = ok(snap.households);
    return mountSharing(
      <DefaultsEditor
        kind="field"
        onKindChange={() => undefined}
        onClose={() => undefined}
      />,
      { env, api },
    );
  };
  const personal = () =>
    document.querySelector<HTMLElement>(
      '[data-layer-form="personal"]',
    ) as HTMLElement;
  const checked = () =>
    within(personal())
      .getAllByRole("radio")
      .find((radio) => radio.getAttribute("aria-checked") === "true")
      ?.textContent ?? "";
  const layerCopy = (choice: string) =>
    JSON.stringify({
      v: 1,
      choice,
      policy: emptyPolicy(),
      learnt: [],
      base: 0,
    });

  test("S1: a choice made after the discard survives a late removal, on screen and in the model", async () => {
    await left(PERSONAL, layerCopy("private"));
    mount();
    await waitFor(() => expect(personal()).not.toBeNull());
    await lateDiscard({
      scope: personal,
      shown: () => checked(),
      restored: sharingCopy.CHOICE_PRIVATE,
      edit: () =>
        fireEvent.click(
          within(personal()).getByRole("radio", {
            name: sharingCopy.CHOICE_PRIMARY_READ,
          }),
        ),
      newer: sharingCopy.CHOICE_PRIMARY_READ,
    });
    expect(checked()).toBe(sharingCopy.CHOICE_PRIMARY_READ);
    expect(await savedAs(PERSONAL)).toContainEqual(
      expect.objectContaining({ choice: "read" }),
    );
  });

  test("CONTROL: with no newer choice the discard shows the layer as recorded and removes its copy", async () => {
    await left(PERSONAL, layerCopy("private"));
    mount();
    await waitFor(() =>
      expect(personal() && checked()).toBe(sharingCopy.CHOICE_PRIVATE),
    );
    fireEvent.click(discardButton(personal()));
    expect(checked()).not.toBe(sharingCopy.CHOICE_PRIVATE);
    await waitFor(async () => expect(await texts(PERSONAL)).toEqual([]));
  });
});

describe("a resource's sharing policy (ResourcePolicyEditor.tsx)", () => {
  const home = household({
    id: HOME,
    members: [
      { account_id: SHARING_ME, username: "me", role: "manager" },
      { account_id: SAM, username: "sam", role: "member" },
      { account_id: PRIYA, username: "priya", role: "member" },
    ],
  });
  const CONTEXT = `sharing-policy:${RESOURCE}`;
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
    api.defaults.households = ok([home]);
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
    screen.getByRole("radiogroup", {
      name: `Home: ${sharingCopy.READ} or ${sharingCopy.EDIT}`,
    });
  const access = () =>
    within(grant())
      .getAllByRole("radio")
      .find((radio) => radio.getAttribute("aria-checked") === "true")
      ?.textContent ?? "";
  const restoredCopy = encodePolicyDraft({
    policy: {
      grants: [{ kind: "household", id: HOME, edit: true }],
      exclude_accounts: [PRIYA],
    },
    base: 2,
  });

  test("S1: an edit made after the discard survives a late removal, on screen and in the model", async () => {
    await left(CONTEXT, restoredCopy);
    mount();
    await screen.findByText(sharingCopy.EFFECTIVE_HEADING);
    await lateDiscard({
      shown: access,
      restored: sharingCopy.EDIT,
      edit: () =>
        fireEvent.click(
          within(grant()).getByRole("radio", { name: sharingCopy.EDIT }),
        ),
      newer: sharingCopy.EDIT,
    });
    expect(access()).toBe(sharingCopy.EDIT);
    expect(await savedAs(CONTEXT)).toContainEqual(
      expect.objectContaining({
        policy: expect.objectContaining({
          grants: [{ kind: "household", id: HOME, edit: true }],
        }),
      }),
    );
  });

  test("CONTROL: with no newer edit the discard shows the policy as read and removes its copy", async () => {
    await left(CONTEXT, restoredCopy);
    mount();
    await waitFor(() => expect(access()).toBe(sharingCopy.EDIT));
    fireEvent.click(discardButton());
    expect(access()).toBe(sharingCopy.READ);
    await waitFor(async () => expect(await texts(CONTEXT)).toEqual([]));
  });
});

describe("CONTROLS with a synchronous discard before revision 38: Record progress and the correction", () => {
  test("Record progress (kept-input): newer input survives a late removal", async () => {
    const row = await rowFor();
    const context = `record:${row.progressId}`;
    await left(context, JSON.stringify({ v: 1, mode: "amount", amount: "7" }));
    render(
      protectedTree(
        <RecordCard
          row={row}
          actions={{ record: vi.fn<TaskActions["record"]>() }}
          now={Date.now()}
          zone="UTC"
          writable
        />,
      ),
    );
    const amount = () =>
      screen.getByLabelText(`${RECORD_COPY.amount} (cups)`) as HTMLInputElement;
    await lateDiscard({
      shown: () => amount().value,
      restored: "7",
      edit: () => fireEvent.change(amount(), { target: { value: "9" } }),
      newer: "9",
    });
    expect(amount().value).toBe("9");
    expect(await savedAs(context)).toContainEqual(
      expect.objectContaining({ amount: "9" }),
    );
  });

  test("the occurrence correction (correction-owner): newer input survives a late removal", async () => {
    const row = await rowFor();
    const context = `occurrence-correction:${row.id}`;
    await left(
      context,
      JSON.stringify({
        v: 1,
        state: {
          minimum: "14",
          maximum: "",
          unit: "cups",
          date: row.data.slot.date ?? "",
          time: "",
          openDaysBefore: "0",
          closeDaysAfter: "0",
          labels: {},
          keptTime: null,
          timeUnconfirmed: false,
        },
      }),
    );
    render(
      protectedTree(
        <CorrectionDialog
          row={row}
          identity={`${ME}:1`}
          open
          onClose={() => undefined}
          actions={{ enqueue: vi.fn<TaskActions["enqueue"]>() }}
          progressIds={[row.progressId]}
          writable
        />,
      ),
    );
    const minimum = () =>
      within(screen.getByRole("dialog")).getByLabelText(
        CORRECTION_COPY.minimum,
      ) as HTMLInputElement;
    await lateDiscard({
      shown: () => minimum().value,
      restored: "14",
      edit: () => fireEvent.change(minimum(), { target: { value: "16" } }),
      newer: "16",
    });
    expect(minimum().value).toBe("16");
  });
});
