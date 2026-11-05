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

/**
 * WEB-14a revision 51 (F-R51-1, family `restored-form-focus-exposure-order`; design assessment Q2/Q3/Q8): "Discard instead" used from the
 * keyboard (focused when pressed: jsdom does not focus on click, so the control focuses it first). Returns once the banner has gone.
 */
async function keyboardDiscard(scope?: () => HTMLElement): Promise<void> {
  const button = discardButton(scope?.());
  button.focus();
  expect(button, "the control: Discard instead has focus").toHaveFocus();
  fireEvent.click(button);
  await waitFor(() =>
    expect(
      (scope?.() ?? document.body).querySelector(
        '[data-recovery-state="restored"]',
      ),
    ).toBeNull(),
  );
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

  test("revision 51 POSITIVE CONTROL (a caller that always named its field): restore focuses Label; a keyboard discard leaves it there", async () => {
    await left(ADD_CONTEXT, restoredCopy);
    mount();
    await waitFor(() => expect(label().value).toBe("Old restored label"));
    await waitFor(() => expect(label()).toHaveFocus());
    await keyboardDiscard();
    expect(label().value).toBe("");
    expect(label()).toHaveFocus();
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

  /**
   * Revision 52 (Review52 F-R52-2; design assessment Q8): the production household screen renders one invitation form per managed
   * household, so three restored owners on one screen are an existing composition. Each household's recovery read is held, then released
   * C, B, A (reverse document order): every value is restored, and focus ends on the first in the page, A, with no gesture before any
   * focus assertion and nothing sent.
   */
  const threeHouseholds = () =>
    [0, 1, 2].map((n) =>
      household({
        id: `66666666-6666-4666-8666-66666666666${n}`,
        name: `House ${n}`,
        members: [
          { account_id: SHARING_ME, username: "me", role: "manager" },
          { account_id: SAM, username: "sam", role: "member" },
        ],
      }),
    );
  async function threeRestoredInvites(
    tabs: string[],
    together = false,
  ): Promise<void> {
    const houses = threeHouseholds();
    const contexts = houses.map((h) => `household-invite:${h.id}`);
    for (const [n, context] of contexts.entries())
      await left(context, textCopy(`restored-${n}`), { tab: tabs[n] });
    const release = new Map<string, () => void>();
    const entered = new Set<string>();
    const gates = new Map(
      contexts.map((c) => [
        c,
        new Promise<void>((resolve) => release.set(c, resolve)),
      ]),
    );
    const original = store().list.bind(store());
    vi.spyOn(store(), "list").mockImplementation(async (c) => {
      const gate = gates.get(c);
      if (gate) {
        entered.add(c);
        await gate;
      }
      return original(c);
    });
    const api = fakeSharingApi();
    api.defaults.households = ok(houses);
    mountSharing(<HouseholdsMinimal />, { env: withRecovery(stubEnv()), api });
    await waitFor(() => expect(entered.size).toBe(3));
    const fields = houses.map(
      (h) =>
        screen.getByLabelText(
          sharingCopy.INVITE_LABEL(h.name),
        ) as HTMLInputElement,
    );
    if (together) {
      // Every read answers at once: the three looks observe the same closed owner concurrently.
      await act(async () => {
        for (const n of [2, 1, 0]) release.get(contexts[n] as string)?.();
      });
      for (const [n, field] of fields.entries())
        await waitFor(() =>
          expect(field.value, `invitation ${n} restored`).toBe(`restored-${n}`),
        );
      expect(fields[0], "the first in the page has focus").toHaveFocus();
    }
    for (const n of together ? [] : [2, 1, 0]) {
      await act(async () => {
        release.get(contexts[n] as string)?.();
      });
      await waitFor(() => expect(fields[n]?.value).toBe(`restored-${n}`));
      expect(
        fields[n],
        n === 0
          ? "the first in the page takes focus from the current restored holder"
          : "this restored form, first in the page so far, takes focus",
      ).toHaveFocus();
    }
    for (const [n, field] of fields.entries())
      expect(field.value).toBe(`restored-${n}`);
    expect(
      api.calls.filter((call) => !call.op.startsWith("read")),
      "nothing is sent (no invitation, lookup or management command)",
    ).toEqual([]);
  }

  test("revision 52 (F-R52-2): three restored invitations released C, B, A end with focus on A (distinct closed tabs)", async () => {
    await threeRestoredInvites(["gone-0", "gone-1", "gone-2"]);
  });

  test("revision 52 (F-R52-2): the same three invitations left by ONE closed tab, reads released C, B, A one at a time, end with focus on A", async () => {
    await threeRestoredInvites(["gone-tab", "gone-tab", "gone-tab"]);
  });

  test("revision 52 (F-R52-1): the three invitations left by ONE closed tab, read at once, are all restored; focus on A", async () => {
    await threeRestoredInvites(["gone-tab", "gone-tab", "gone-tab"], true);
  });

  test("CONTROL (F-R52-1): three invitations left by three closed tabs, read at once, are all restored; focus on A", async () => {
    await threeRestoredInvites(["gone-0", "gone-1", "gone-2"], true);
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

  const focusedChoice = (scope: HTMLElement) =>
    within(scope)
      .getAllByRole("radio")
      .find((radio) => radio === document.activeElement)?.textContent ?? null;

  test("revision 51 (F-R51-1): restore focuses the layer's CHOSEN option; a keyboard discard focuses the option its reset chose, choosing nothing", async () => {
    await left(PERSONAL, layerCopy("private"));
    mount();
    await waitFor(() =>
      expect(personal() && checked()).toBe(sharingCopy.CHOICE_PRIVATE),
    );
    await waitFor(() =>
      expect(focusedChoice(personal())).toBe(sharingCopy.CHOICE_PRIVATE),
    );
    expect(checked(), "focusing chose nothing").toBe(
      sharingCopy.CHOICE_PRIVATE,
    );
    await keyboardDiscard(personal);
    const reset = checked();
    expect(reset).not.toBe(sharingCopy.CHOICE_PRIVATE);
    await waitFor(() => expect(focusedChoice(personal())).toBe(reset));
    expect(checked(), "focusing chose nothing").toBe(reset);
  });

  test("revision 51, decision D2 (Kieran, 3 November 2026): both layers restored at once: the first in the page takes focus, the other never takes it later", async () => {
    const HOUSEHOLD = `sharing-defaults:household:${HOME}:field`;
    await left(HOUSEHOLD, layerCopy("read"), { tab: "gone-tab-2" });
    await left(PERSONAL, layerCopy("private"));
    mount();
    const householdForm = () =>
      document.querySelector<HTMLElement>(
        '[data-layer-form="household"]',
      ) as HTMLElement;
    await waitFor(() =>
      expect(
        householdForm()?.querySelector('[data-recovery-state="restored"]'),
      ).not.toBeNull(),
    );
    await waitFor(() =>
      expect(
        personal()?.querySelector('[data-recovery-state="restored"]'),
      ).not.toBeNull(),
    );
    const order = householdForm().compareDocumentPosition(personal());
    expect(
      order & Node.DOCUMENT_POSITION_FOLLOWING,
      "the household layer comes first in the page",
    ).toBeTruthy();
    await waitFor(() =>
      expect(focusedChoice(householdForm())).toBe(
        sharingCopy.CHOICE_HOUSEHOLD_READ,
      ),
    );
    // No oscillation: a later change to the document (the personal layer's own re-render) does not move focus to the other layer.
    document.body.appendChild(document.createElement("p"));
    await act(async () => undefined);
    expect(focusedChoice(householdForm())).toBe(
      sharingCopy.CHOICE_HOUSEHOLD_READ,
    );
    expect(focusedChoice(personal())).toBeNull();
    // Discarding one layer touches only that layer: the other stays restored.
    await keyboardDiscard(householdForm);
    expect(
      personal().querySelector('[data-recovery-state="restored"]'),
    ).not.toBeNull();
    expect(checked()).toBe(sharingCopy.CHOICE_PRIVATE);
    await waitFor(() => expect(focusedChoice(householdForm())).not.toBeNull());
  });

  test("revision 52 (F-R52-1): both layers left by ONE closed tab (one recovery id) are both restored; the first in the page takes focus", async () => {
    // Review52's witness: the same two-layer composition, with both copies saved by the same page (every form of a page saves under its one
    // identifier). The D2 case above keeps distinct ids as its isolation control.
    const HOUSEHOLD = `sharing-defaults:household:${HOME}:field`;
    await left(HOUSEHOLD, layerCopy("read"), { tab: "gone-tab" });
    await left(PERSONAL, layerCopy("private"), { tab: "gone-tab" });
    mount();
    const householdForm = () =>
      document.querySelector<HTMLElement>(
        '[data-layer-form="household"]',
      ) as HTMLElement;
    await waitFor(() =>
      expect(
        householdForm()?.querySelector('[data-recovery-state="restored"]'),
        "the household layer is restored",
      ).not.toBeNull(),
    );
    await waitFor(() =>
      expect(
        personal()?.querySelector('[data-recovery-state="restored"]'),
        "the personal layer, left by the same closed tab, is restored too",
      ).not.toBeNull(),
    );
    expect(checked()).toBe(sharingCopy.CHOICE_PRIVATE);
    await waitFor(() =>
      expect(focusedChoice(householdForm())).toBe(
        sharingCopy.CHOICE_HOUSEHOLD_READ,
      ),
    );
    // Restoring removed neither copy (only this page's own saves or the person's discard may).
    expect(await texts(HOUSEHOLD)).toHaveLength(1);
    expect(await texts(PERSONAL)).toHaveLength(1);
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

  test("revision 51 (F-R51-1): restore focuses the first grant (its chosen access); a keyboard discard focuses that grant as read again, choosing nothing", async () => {
    await left(CONTEXT, restoredCopy);
    mount();
    await waitFor(() => expect(access()).toBe(sharingCopy.EDIT));
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe(sharingCopy.EDIT),
    );
    expect(grant().contains(document.activeElement)).toBe(true);
    await keyboardDiscard();
    expect(access()).toBe(sharingCopy.READ);
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe(sharingCopy.READ),
    );
    expect(grant().contains(document.activeElement)).toBe(true);
    expect(access(), "focusing chose nothing").toBe(sharingCopy.READ);
  });

  test("revision 51 (Q3): a restored policy with NO grants focuses Add account grant; the discard's reset inserts the grant read, which is focused", async () => {
    await left(
      CONTEXT,
      encodePolicyDraft({
        policy: { grants: [], exclude_accounts: [PRIYA] },
        base: 2,
      }),
    );
    mount();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: sharingCopy.ADD_ACCOUNT }),
      ).toHaveFocus(),
    );
    expect(
      screen.queryByRole("radiogroup", {
        name: `Home: ${sharingCopy.READ} or ${sharingCopy.EDIT}`,
      }),
    ).toBeNull();
    await keyboardDiscard();
    await waitFor(() => expect(access()).toBe(sharingCopy.READ));
    await waitFor(() =>
      expect(grant().contains(document.activeElement)).toBe(true),
    );
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

describe("Record progress restored in its observe mode (RecordCard.tsx; design assessment DA-N1, WEB-14a revision 51)", () => {
  test("restore focuses the chosen mode, Just checked on it (no amount field); a keyboard discard focuses the amount field its reset brings back", async () => {
    const row = await rowFor();
    const context = `record:${row.progressId}`;
    await left(context, JSON.stringify({ v: 1, mode: "observe", amount: "" }));
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
    const observe = () =>
      screen.getByRole("radio", { name: RECORD_COPY.checkedOn });
    await waitFor(() => expect(observe()).toBeChecked());
    expect(screen.queryByLabelText(`${RECORD_COPY.amount} (cups)`)).toBeNull();
    await waitFor(() => expect(observe()).toHaveFocus());
    await keyboardDiscard();
    const amount = await screen.findByLabelText(`${RECORD_COPY.amount} (cups)`);
    expect(
      screen.getByRole("radio", { name: RECORD_COPY.logAmount }),
    ).toBeChecked();
    await waitFor(() => expect(amount).toHaveFocus());
    expect((amount as HTMLInputElement).value).toBe("");
  });
});
