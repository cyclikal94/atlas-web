import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  forgetAllPeopleMemory,
  peopleMemory,
} from "../../../src/features/people/memory";
import { forgetRefusedPolicies } from "../../../src/features/sharing/api";
import { installMatchMedia } from "../../helpers/match-media";
import { draftRow } from "../../support/data/rows";
import { HOME, ME, MO, record } from "../../support/people/records";
import { fieldRow, peopleWorld, person } from "../../support/people/world";
import { ok } from "../../support/sharing/fake-api";

/**
 * WF-PEOPLE-03 (A3, A5, A6, A7, A15, A16, A20): the field editor's create paths (queued private/defaults, online shared), conditional
 * values, the Q1 update, the online audience change (policy first, then content on the CONFIRMED policy version), the offline choice and a
 * held change run on reconnect, the draft kept across a remount, the 403 memo, a version conflict and the PPL-6 note. Fixture evidence.
 */
installMatchMedia({ width: 1440 });
beforeEach(() => {
  forgetAllPeopleMemory();
  forgetRefusedPolicies();
});
afterEach(async () => {
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 0));
});

const P = "55555555-5555-4555-8555-555555555555";
const F = "66666666-6666-4666-8666-666666666666";
const PRIVATE = { grants: [], exclude_accounts: [] };
const HOME_VIEW = {
  grants: [{ kind: "household" as const, id: HOME, edit: false }],
  exclude_accounts: [],
};
const dialog = () => screen.findByRole("dialog");

async function openNew(w: ReturnType<typeof peopleWorld>) {
  await w.mount(`/people/${P}/fields/new`);
  return dialog();
}

describe("creating a field", () => {
  test("Only you: a queued put_field with an explicit private policy; the dialog closes and the row is shown, not sent yet", async () => {
    const w = peopleWorld();
    w.setCache([person({ id: P, label: "Ada" })]);
    w.env.setDefaults(record());
    const d = await openNew(w);
    expect((await axe(document.body)).violations).toEqual([]);
    fireEvent.change(within(d).getByRole("textbox", { name: "Name" }), {
      target: { value: "Medical note" },
    });
    fireEvent.change(within(d).getByRole("textbox", { name: "Value" }), {
      target: { value: "Penicillin" },
    });
    fireEvent.click(within(d).getByRole("radio", { name: "Only you" }));
    fireEvent.click(within(d).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(w.built[0]?.command).toEqual({
      command: {
        kind: "put_field",
        id: expect.any(String),
        parent_id: P,
        label: "Medical note",
        value: { kind: "text", text: "Penicillin" },
        initial_policy: PRIVATE,
      },
    });
    expect(await screen.findByText("Penicillin")).toBeInTheDocument();
  });

  test("Use my defaults with defaults never fetched: queued and held for the review", async () => {
    const w = peopleWorld();
    w.setCache([person({ id: P, label: "Ada" })]);
    w.env.setDefaults(null, true);
    const d = await openNew(w);
    fireEvent.change(within(d).getByRole("textbox", { name: "Name" }), {
      target: { value: "Phone" },
    });
    fireEvent.change(within(d).getByRole("textbox", { name: "Value" }), {
      target: { value: "0770" },
    });
    fireEvent.click(within(d).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(w.built).toHaveLength(1));
    expect(w.built[0]?.defaultsReview).toEqual(["field"]);
    expect(w.built[0]?.command).not.toHaveProperty("defaults_revision");
  });

  test("the type switch keeps every slot; only the ACTIVE type is sent, with no warning", async () => {
    const w = peopleWorld();
    w.setCache([person({ id: P, label: "Ada" })]);
    w.env.setDefaults(record());
    const d = await openNew(w);
    fireEvent.change(within(d).getByRole("textbox", { name: "Name" }), {
      target: { value: "Weight" },
    });
    fireEvent.change(within(d).getByRole("textbox", { name: "Value" }), {
      target: { value: "about 70" },
    });
    fireEvent.change(within(d).getByRole("combobox", { name: "Type" }), {
      target: { value: "quantity" },
    });
    fireEvent.change(within(d).getByRole("textbox", { name: "Amount" }), {
      target: { value: "70" },
    });
    fireEvent.change(within(d).getByRole("textbox", { name: "Unit" }), {
      target: { value: "kg" },
    });
    fireEvent.change(within(d).getByRole("combobox", { name: "Type" }), {
      target: { value: "text" },
    });
    expect(within(d).getByRole("textbox", { name: "Value" })).toHaveValue(
      "about 70",
    );
    fireEvent.change(within(d).getByRole("combobox", { name: "Type" }), {
      target: { value: "quantity" },
    });
    expect(within(d).getByRole("textbox", { name: "Amount" })).toHaveValue(
      "70",
    );
    fireEvent.click(within(d).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(w.built).toHaveLength(1));
    expect(
      ((w.built[0]?.command ?? {}) as { command: { value: unknown } }).command
        .value,
    ).toEqual({
      kind: "quantity",
      amount: "70",
      unit: "kg",
    });
  });

  test("a refused save keeps everything typed and says why", async () => {
    const w = peopleWorld();
    w.setCache([person({ id: P, label: "Ada" })]);
    w.env.setDefaults(record());
    w.outcomes.push({ kind: "refused", reason: "storage" });
    const d = await openNew(w);
    fireEvent.change(within(d).getByRole("textbox", { name: "Name" }), {
      target: { value: "Phone" },
    });
    fireEvent.change(within(d).getByRole("textbox", { name: "Value" }), {
      target: { value: "0770" },
    });
    fireEvent.click(within(d).getByRole("button", { name: "Save" }));
    expect(
      await within(d).findByText("Couldn't save on this device. Try again."),
    ).toBeInTheDocument();
    expect(within(d).getByRole("textbox", { name: "Name" })).toHaveValue(
      "Phone",
    );
    expect(within(d).getByRole("textbox", { name: "Value" })).toHaveValue(
      "0770",
    );
  });

  test("invalid values are refused at their input, with the contract's bounds", async () => {
    const w = peopleWorld();
    w.setCache([person({ id: P, label: "Ada" })]);
    w.env.setDefaults(record());
    const d = await openNew(w);
    fireEvent.change(within(d).getByRole("combobox", { name: "Type" }), {
      target: { value: "date" },
    });
    fireEvent.change(within(d).getByRole("textbox", { name: "Day" }), {
      target: { value: "29" },
    });
    fireEvent.change(within(d).getByRole("textbox", { name: "Month" }), {
      target: { value: "2" },
    });
    fireEvent.change(
      within(d).getByRole("textbox", { name: "Year (optional)" }),
      { target: { value: "2023" } },
    );
    fireEvent.click(within(d).getByRole("button", { name: "Save" }));
    expect(
      await within(d).findByText("Give the field a name."),
    ).toBeInTheDocument();
    expect(within(d).getByText("That date doesn't exist.")).toBeInTheDocument();
    expect(w.built).toEqual([]);
  });

  test("Home · can view is sent online to /task-access-commands (never queued); offline it is disabled with the reason", async () => {
    const w = peopleWorld();
    w.setCache([person({ id: P, label: "Ada" })]);
    w.env.setDefaults(record());
    const d = await openNew(w);
    fireEvent.change(within(d).getByRole("textbox", { name: "Name" }), {
      target: { value: "Phone" },
    });
    fireEvent.change(within(d).getByRole("textbox", { name: "Value" }), {
      target: { value: "0770" },
    });
    fireEvent.click(within(d).getByRole("radio", { name: "Home · can view" }));
    fireEvent.click(within(d).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(w.built).toEqual([]);
    expect(w.api.calls.find((c) => c.op === "putFieldShared")?.args[1]).toEqual(
      {
        command: {
          kind: "put_field",
          id: expect.any(String),
          parent_id: P,
          label: "Phone",
          value: { kind: "text", text: "0770" },
          initial_policy: HOME_VIEW,
        },
      },
    );
    cleanup();
    forgetAllPeopleMemory();
    const offline = peopleWorld({ online: false });
    offline.setCache([person({ id: P, label: "Ada" })]);
    offline.env.setDefaults(record());
    const d2 = await openNew(offline);
    expect(
      within(d2).getByRole("radio", { name: "Home · can view" }),
    ).toBeDisabled();
    expect(
      within(d2).getByText("Sharing a new field needs a connection"),
    ).toBeInTheDocument();
  });

  test("PPL-6: a person linked to another account gets the subject note under 'Use my defaults'", async () => {
    const w = peopleWorld();
    w.setCache([person({ id: P, label: "Mo" })]);
    w.api.linked.set(P, MO);
    w.env.setDefaults(record({ members: [ME, MO] }));
    const d = await openNew(w);
    expect(
      await within(d).findByText(
        "Mo won't see this field unless you share it with them.",
      ),
    ).toBeInTheDocument();
    fireEvent.click(within(d).getByRole("radio", { name: "Home · can view" }));
    expect(
      within(d).getByText("Mo is in Home and will be able to see it."),
    ).toBeInTheDocument();
  });
});

describe("updating a field", () => {
  test("an edit with the audience unchanged queues put_field with expected_version and expected_policy_version (Q1)", async () => {
    const w = peopleWorld();
    w.setCache([
      person({ id: P, label: "Ada" }),
      fieldRow({
        id: F,
        parent_id: P,
        label: "Phone",
        version: 4,
        policy_version: 6,
      }),
    ]);
    w.env.setDefaults(record());
    w.sharing.next.policy.push(ok({ version: 6, policy: HOME_VIEW }));
    await w.mount(`/people/${P}/fields/${F}`);
    const d = await dialog();
    await within(d).findByRole("radio", {
      name: "Home · can view",
      checked: true,
    });
    fireEvent.change(within(d).getByRole("textbox", { name: "Value" }), {
      target: { value: "0771" },
    });
    fireEvent.click(within(d).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(w.built).toHaveLength(1));
    expect(w.built[0]?.command).toEqual({
      command: {
        kind: "put_field",
        id: F,
        parent_id: P,
        expected_version: 4,
        expected_policy_version: 6,
        label: "Phone",
        value: { kind: "text", text: "0771" },
      },
    });
    expect(w.sharing.sent).toEqual([]);
  });

  test("online audience change: read, replace_policy, confirming read, THEN the content on the confirmed policy version", async () => {
    const w = peopleWorld();
    w.setCache([
      person({ id: P, label: "Ada" }),
      fieldRow({
        id: F,
        parent_id: P,
        label: "Phone",
        version: 4,
        policy_version: 6,
      }),
    ]);
    w.env.setDefaults(record());
    w.sharing.next.policy.push(
      ok({ version: 6, policy: HOME_VIEW }),
      ok({ version: 6, policy: HOME_VIEW }),
      ok({ version: 7, policy: PRIVATE }),
    );
    await w.mount(`/people/${P}/fields/${F}`);
    const d = await dialog();
    await within(d).findByRole("radio", {
      name: "Home · can view",
      checked: true,
    });
    fireEvent.change(within(d).getByRole("textbox", { name: "Value" }), {
      target: { value: "0771" },
    });
    fireEvent.click(within(d).getByRole("radio", { name: "Only you" }));
    fireEvent.click(within(d).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(w.built).toHaveLength(1));
    expect(w.sharing.calls.map((c) => c.op)).toEqual([
      "readPolicy",
      "readPolicy",
      "management",
      "readPolicy",
    ]);
    expect(w.sharing.sent[0]?.commands).toEqual([
      { kind: "replace_policy", id: F, expected_version: 6, policy: PRIVATE },
    ]);
    expect(
      ((w.built[0]?.command ?? {}) as { command: Record<string, unknown> })
        .command.expected_policy_version,
    ).toBe(7);
  });

  test("a policy moved since it was shown: nothing is sent and the draft stays, with the review copy", async () => {
    const w = peopleWorld();
    w.setCache([
      person({ id: P, label: "Ada" }),
      fieldRow({ id: F, parent_id: P, policy_version: 6 }),
    ]);
    w.env.setDefaults(record());
    w.sharing.next.policy.push(
      ok({ version: 6, policy: HOME_VIEW }),
      ok({ version: 8, policy: HOME_VIEW }),
    );
    await w.mount(`/people/${P}/fields/${F}`);
    const d = await dialog();
    await within(d).findByRole("radio", {
      name: "Home · can view",
      checked: true,
    });
    fireEvent.click(within(d).getByRole("radio", { name: "Only you" }));
    fireEvent.click(within(d).getByRole("button", { name: "Save" }));
    expect(
      await within(d).findByText(/The sharing changed since you opened this/),
    ).toBeInTheDocument();
    expect(w.sharing.sent).toEqual([]);
    expect(w.built).toEqual([]);
  });

  test("offline audience change: the export's choice; 'Hold as draft' keeps it, and on reconnect the policy goes first, then the content", async () => {
    const w = peopleWorld();
    w.setCache([
      person({ id: P, label: "Ada" }),
      fieldRow({
        id: F,
        parent_id: P,
        label: "Note",
        version: 4,
        policy_version: 6,
      }),
    ]);
    w.env.setDefaults(record());
    w.sharing.next.policy.push(ok({ version: 6, policy: HOME_VIEW }));
    await w.mount(`/people/${P}/fields/${F}`);
    const d = await dialog();
    await within(d).findByRole("radio", {
      name: "Home · can view",
      checked: true,
    });
    w.setOnline(false);
    fireEvent.change(within(d).getByRole("textbox", { name: "Value" }), {
      target: { value: "Inhaler" },
    });
    fireEvent.click(within(d).getByRole("radio", { name: "Only you" }));
    fireEvent.click(within(d).getByRole("button", { name: "Save" }));
    expect(
      await within(d).findByText(
        "You're offline, so the audience can't change yet",
      ),
    ).toBeInTheDocument();
    expect(
      within(d).getByText(
        /Save the Note now — Home · can view will still see it/,
      ),
    ).toBeInTheDocument();
    expect(
      within(d).getByText(
        /Atlas checks the sharing policy hasn't changed before sending/,
      ),
    ).toBeInTheDocument();
    fireEvent.click(within(d).getByRole("button", { name: "Hold as draft" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // The held row (the announcer's live region repeats its text, so the row is found by its own attribute).
    await waitFor(() =>
      expect(
        document.querySelector(`[data-held-field="${F}"]`),
      ).toHaveTextContent("Waiting to change who can see Note"),
    );
    expect(w.built).toEqual([]);
    w.sharing.next.policy.push(
      ok({ version: 6, policy: HOME_VIEW }),
      ok({ version: 7, policy: PRIVATE }),
    );
    w.setOnline(true);
    await waitFor(() => expect(w.built).toHaveLength(1));
    const order = w.sharing.calls.map((c) => c.op);
    expect(order.slice(-3)).toEqual(["readPolicy", "management", "readPolicy"]);
    expect(
      ((w.built[0]?.command ?? {}) as { command: Record<string, unknown> })
        .command,
    ).toMatchObject({
      expected_version: 4,
      expected_policy_version: 7,
      value: { kind: "text", text: "Inhaler" },
    });
    await waitFor(() =>
      expect(document.querySelector(`[data-held-field="${F}"]`)).toBeNull(),
    );
  });

  test("a held change whose confirming read shows another policy sends no content and keeps the draft with the reason", async () => {
    const w = peopleWorld();
    w.setCache([
      person({ id: P, label: "Ada" }),
      fieldRow({
        id: F,
        parent_id: P,
        label: "Note",
        version: 4,
        policy_version: 6,
      }),
    ]);
    w.env.setDefaults(record());
    w.putHeld({
      holdId: "hold-1",
      fieldId: F,
      personId: P,
      label: "Note",
      value: { kind: "text", text: "Inhaler" },
      sameKind: true,
      version: 4,
      expectedBase: 4,
      from: { version: 6, policy: HOME_VIEW },
      to: PRIVATE,
      attempt: null,
      status: { kind: "waiting" },
      heldAt: "2026-10-13T09:00:00.000Z",
      rev: 0,
      queued: false,
      seq: 0,
      retired: false,
      legacy: false,
    });
    // Held in this page (D1: it may run by itself).
    peopleMemory(w.people.identity).heldAuthority.add("hold-1");
    w.sharing.next.policy.push(
      ok({ version: 6, policy: HOME_VIEW }),
      ok({ version: 8, policy: HOME_VIEW }),
    );
    await w.mount(`/people/${P}`);
    await waitFor(() =>
      expect(
        document.querySelector(`[data-held-field="${F}"]`),
      ).toHaveTextContent(/The sharing changed since you opened this/),
    );
    expect(w.built).toEqual([]);
    expect(
      screen.getByRole("button", { name: "Try again" }),
    ).toBeInTheDocument();
  });

  test("the draft survives a remount of the tree (a 403 elsewhere) and is restored with a note; Cancel forgets it", async () => {
    const w = peopleWorld();
    w.setCache([person({ id: P, label: "Ada" })]);
    w.env.setDefaults(record());
    let d = await openNew(w);
    fireEvent.change(within(d).getByRole("textbox", { name: "Name" }), {
      target: { value: "Kept" },
    });
    cleanup();
    await w.mount(`/people/${P}/fields/new`);
    d = await dialog();
    expect(within(d).getByRole("textbox", { name: "Name" })).toHaveValue(
      "Kept",
    );
    expect(
      within(d).getByText("Your unsaved changes were kept."),
    ).toBeInTheDocument();
    fireEvent.click(within(d).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    cleanup();
    await w.mount(`/people/${P}/fields/new`);
    d = await dialog();
    expect(within(d).getByRole("textbox", { name: "Name" })).toHaveValue("");
  });

  test("a 403 on the field's policy is asked ONCE for the page: the audience says only the owner can change it", async () => {
    const w = peopleWorld();
    w.setCache([
      person({ id: P, label: "Ada" }),
      fieldRow({ id: F, parent_id: P }),
    ]);
    w.env.setDefaults(record());
    w.sharing.defaults.policy = { ok: false, kind: "forbidden" };
    await w.mount(`/people/${P}/fields/${F}`);
    let d = await dialog();
    expect(
      await within(d).findByText(
        "Only the owner can change who can see this field",
      ),
    ).toBeInTheDocument();
    cleanup();
    await w.mount(`/people/${P}/fields/${F}`);
    d = await dialog();
    expect(
      await within(d).findByText(
        "Only the owner can change who can see this field",
      ),
    ).toBeInTheDocument();
    expect(w.sharing.calls.filter((c) => c.op === "readPolicy")).toHaveLength(
      1,
    );
  });

  test("an unsent create is edited in place", async () => {
    const w = peopleWorld();
    w.setCache([person({ id: P, label: "Ada" })]);
    w.env.setDefaults(record());
    w.setDrafts([
      draftRow({
        local_id: "f1",
        created_seq: 1,
        endpoint: "/task-commands",
        target_resource_ids: [F],
        command: {
          command: {
            kind: "put_field",
            id: F,
            parent_id: P,
            label: "Phone",
            value: { kind: "text", text: "0770" },
          },
        },
      }),
    ]);
    await w.mount(`/people/${P}/fields/${F}`);
    const d = await dialog();
    fireEvent.change(within(d).getByRole("textbox", { name: "Value" }), {
      target: { value: "0771" },
    });
    fireEvent.click(within(d).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(w.built).toHaveLength(1));
    expect(w.built[0]?.op).toBe("edit");
    expect(w.built[0]?.target).toBe("f1");
  });

  test("a version conflict: 'Save mine on the current version' supersedes the CONFLICTED save's content on the current bases", async () => {
    const w = peopleWorld();
    w.setCache([
      person({ id: P, label: "Ada" }),
      fieldRow({ id: F, parent_id: P, version: 9, policy_version: 3 }),
    ]);
    w.env.setDefaults(record());
    const command = {
      command: {
        kind: "put_field",
        id: F,
        parent_id: P,
        expected_version: 8,
        expected_policy_version: 3,
        label: "Phone",
        value: { kind: "text", text: "07700 900999" },
      },
    };
    w.env.setDrafts([
      draftRow({
        local_id: "c",
        kind: "put_field",
        status: "version_conflict",
        index_targets: [F],
        target_resource_ids: [F],
        command,
      }),
    ]);
    w.putBody("c", command);
    await w.mount(`/people/${P}/fields/${F}`);
    const d = await dialog();
    fireEvent.click(
      await within(d).findByRole("button", {
        name: "Save mine on the current version",
      }),
    );
    await waitFor(() => expect(w.built).toHaveLength(1));
    expect(w.built[0]).toMatchObject({ op: "supersede", target: "c" });
    expect(
      ((w.built[0]?.command ?? {}) as { command: Record<string, unknown> })
        .command,
    ).toMatchObject({
      expected_version: 9,
      expected_policy_version: 3,
      value: { kind: "text", text: "07700 900999" },
    });
  });
});
