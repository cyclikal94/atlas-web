import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { forgetAllPeopleMemory } from "../../../src/features/people/memory";
import { forgetRefusedPolicies } from "../../../src/features/sharing/api";
import { installMatchMedia } from "../../helpers/match-media";
import { draftRow } from "../../support/data/rows";
import { HOME, ME, MO, record } from "../../support/people/records";
import { fieldRow, peopleWorld, person } from "../../support/people/world";

/**
 * WF-PEOPLE-02 with the Q21 additions (A2, A9, A10, A12, A14): the linkage line only from a person read, rename routed by linkage
 * (rename_profile online / the content edit queued), unlink online with its confirmation and one attempt per body, archive and restore
 * queued, the fields table for every kind, PPL-5, the defaults panel. jsdom and axe; fixture evidence.
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
const F = (n: number) =>
  `66666666-6666-4666-8666-${String(n).padStart(12, "0")}`;
const header = () =>
  document.querySelector("[data-identity-header]") as HTMLElement;

describe("linkage and rename (D-11a-2, D-11a-5)", () => {
  test("known self: 'This is you', Rename sends rename_profile online with the person's version; Unlink enabled", async () => {
    const w = peopleWorld();
    w.setCache([person({ id: P, label: "Kieran", version: 4 })]);
    w.api.linked.set(P, ME);
    await w.mount(`/people/${P}`);
    expect(
      await within(header()).findByText(
        "This is you — you control this profile",
      ),
    ).toBeInTheDocument();
    expect(
      within(header()).getByRole("button", { name: "Unlink account" }),
    ).toBeEnabled();
    fireEvent.click(within(header()).getByRole("button", { name: "Rename" }));
    const name = within(header()).getByRole("textbox", { name: "Name" });
    fireEvent.change(name, { target: { value: "Kieran L." } });
    fireEvent.click(within(header()).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(
        w.api.calls.find((c) => c.op === "peopleCommand")?.args[1],
      ).toEqual({
        command: {
          kind: "rename_profile",
          person_id: P,
          expected_version: 4,
          name: "Kieran L.",
        },
      }),
    );
    expect(w.built).toEqual([]);
    expect((await axe(document.body)).violations).toEqual([]);
  });

  test("a conflict keeps the typed name and says so; an uncertain answer is retried with the SAME key and body", async () => {
    const w = peopleWorld();
    w.setCache([person({ id: P, label: "Kieran", version: 4 })]);
    w.api.linked.set(P, ME);
    w.api.next.people.push(
      { ok: false, kind: "uncertain" },
      {
        ok: false,
        kind: "conflict",
        requestId: "99999999-9999-4999-8999-999999999999",
      },
    );
    await w.mount(`/people/${P}`);
    await within(header()).findByText("This is you — you control this profile");
    fireEvent.click(within(header()).getByRole("button", { name: "Rename" }));
    fireEvent.change(within(header()).getByRole("textbox", { name: "Name" }), {
      target: { value: "K" },
    });
    fireEvent.click(within(header()).getByRole("button", { name: "Save" }));
    expect(
      await within(header()).findByText(/couldn't confirm this was saved/i),
    ).toBeInTheDocument();
    fireEvent.click(within(header()).getByRole("button", { name: "Save" }));
    expect(
      await within(header()).findByText(
        "Someone else already changed this — reload and try again.",
      ),
    ).toBeInTheDocument();
    const sent = w.api.calls.filter((c) => c.op === "peopleCommand");
    expect(sent).toHaveLength(2);
    expect(sent[0]?.args[0]).toBe(sent[1]?.args[0]);
    expect(sent[0]?.args[1]).toEqual(sent[1]?.args[1]);
    expect(within(header()).getByRole("textbox", { name: "Name" })).toHaveValue(
      "K",
    );
  });

  test("known other: Rename and Unlink are disabled with the drawn reasons (even though the row is editable)", async () => {
    const w = peopleWorld();
    w.setCache([person({ id: P, label: "Mo", can_edit: true })]);
    w.api.linked.set(P, MO);
    await w.mount(`/people/${P}`);
    expect(
      await within(header()).findByText(
        "Linked to their own account — Mo controls this name, not you",
      ),
    ).toBeInTheDocument();
    expect(
      within(header()).getByRole("button", { name: "Rename" }),
    ).toBeDisabled();
    expect(within(header()).getByText("Mo owns this name")).toBeInTheDocument();
    expect(
      within(header()).getByRole("button", { name: "Unlink account" }),
    ).toBeDisabled();
    expect(
      within(header()).getByText(
        "Only Mo (the linked account) can unlink this profile",
      ),
    ).toBeInTheDocument();
  });

  test("known unlinked: Rename queues the content edit with both versions; no Unlink", async () => {
    const w = peopleWorld();
    w.setCache([
      person({ id: P, label: "Ada", version: 5, policy_version: 3 }),
    ]);
    await w.mount(`/people/${P}`);
    expect(
      await within(header()).findByText("Not linked to an account"),
    ).toBeInTheDocument();
    expect(
      within(header()).queryByRole("button", { name: "Unlink account" }),
    ).toBeNull();
    fireEvent.click(within(header()).getByRole("button", { name: "Rename" }));
    fireEvent.change(within(header()).getByRole("textbox", { name: "Name" }), {
      target: { value: "Ada L." },
    });
    fireEvent.click(within(header()).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(w.built).toHaveLength(1));
    expect(w.built[0]?.command).toEqual({
      commands: [
        {
          kind: "edit",
          id: P,
          expected_version: 5,
          expected_policy_version: 3,
          label: "Ada L.",
          value: "",
        },
      ],
    });
    // The queued name is shown, marked as not sent.
    await waitFor(() => expect(header()).toHaveTextContent("Ada L."));
    expect(header().querySelector("[data-pending]")).toHaveTextContent(
      "Not sent yet",
    );
    // Renaming again while that draft is unsent edits it in place (D-11a-15).
    fireEvent.click(within(header()).getByRole("button", { name: "Rename" }));
    fireEvent.change(within(header()).getByRole("textbox", { name: "Name" }), {
      target: { value: "Ada Lovelace" },
    });
    fireEvent.click(within(header()).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(w.built).toHaveLength(2));
    expect(w.built[1]?.op).toBe("edit");
  });

  test("offline with the linkage never read: unknown, Rename disabled ('Needs a connection to check…'); nothing inferred from can_edit", async () => {
    const w = peopleWorld({ online: false });
    w.setCache([person({ id: P, label: "Ada", can_edit: true })]);
    await w.mount(`/people/${P}`);
    expect(
      await within(header()).findByText(/isn't known on this device/),
    ).toBeInTheDocument();
    expect(
      within(header()).getByRole("button", { name: "Rename" }),
    ).toBeDisabled();
    expect(
      within(header()).getByText(
        "Needs a connection to check who controls this name",
      ),
    ).toBeInTheDocument();
    expect(w.api.calls).toEqual([]);
  });

  test("an unlinked person seen online can still be renamed after the connection drops (a queued content edit)", async () => {
    const w = peopleWorld();
    w.setCache([person({ id: P, label: "Ada" })]);
    await w.mount(`/people/${P}`);
    await within(header()).findByText("Not linked to an account");
    w.setOnline(false);
    expect(
      within(header()).getByRole("button", { name: "Rename" }),
    ).toBeEnabled();
  });

  test("a linked self offline: Save is disabled with 'Needs a connection'", async () => {
    const w = peopleWorld();
    w.setCache([person({ id: P, label: "Kieran" })]);
    w.api.linked.set(P, ME);
    await w.mount(`/people/${P}`);
    await within(header()).findByText("This is you — you control this profile");
    fireEvent.click(within(header()).getByRole("button", { name: "Rename" }));
    w.setOnline(false);
    const save = within(header()).getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    expect(save).toHaveAccessibleDescription("Needs a connection");
  });
});

describe("unlink (D-11a-6)", () => {
  test("a confirmation names what stays; confirming sends unlink with the version once", async () => {
    const w = peopleWorld();
    w.setCache([person({ id: P, label: "Kieran", version: 7 })]);
    w.api.linked.set(P, ME);
    await w.mount(`/people/${P}`);
    fireEvent.click(
      await within(header()).findByRole("button", { name: "Unlink account" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Unlink your account from this profile?",
    });
    expect(dialog).toHaveTextContent(
      /past contributions and who can see them stay exactly as they are/,
    );
    w.api.linked.set(P, null);
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Unlink account" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(
      w.api.calls.filter((c) => c.op === "peopleCommand").map((c) => c.args[1]),
    ).toEqual([
      { command: { kind: "unlink", person_id: P, expected_version: 7 } },
    ]);
    // The linkage is read again afterwards.
    expect(
      await within(header()).findByText("Not linked to an account"),
    ).toBeInTheDocument();
  });
});

describe("archive and restore (D-11a-10)", () => {
  test("Archive queues archive with the base; the person shows archived; Restore queues the reverse", async () => {
    const w = peopleWorld();
    w.setCache([person({ id: P, label: "Ada", version: 2 })]);
    await w.mount(`/people/${P}`);
    fireEvent.click(
      await within(header()).findByRole("button", { name: "Archive" }),
    );
    await waitFor(() => expect(w.built).toHaveLength(1));
    expect(w.built[0]?.command).toEqual({
      command: { kind: "archive", id: P, expected_version: 2, archived: true },
    });
    expect(
      await screen.findByText(/Archived. Its history and fields stay./),
    ).toBeInTheDocument();
    w.setDrafts([]);
    w.putCache(person({ id: P, label: "Ada", version: 3, archived: true }));
    fireEvent.click(
      await within(header()).findByRole("button", { name: "Restore" }),
    );
    await waitFor(() => expect(w.built).toHaveLength(2));
    expect(w.built[1]?.command).toEqual({
      command: { kind: "archive", id: P, expected_version: 3, archived: false },
    });
  });

  test("a refused save is never shown as saved", async () => {
    const w = peopleWorld();
    w.setCache([person({ id: P, label: "Ada" })]);
    w.outcomes.push({ kind: "refused", reason: "quota" });
    await w.mount(`/people/${P}`);
    fireEvent.click(
      await within(header()).findByRole("button", { name: "Archive" }),
    );
    expect(
      await screen.findByText(
        "There isn't enough storage space on this device to save this.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Archived. Its history/)).toBeNull();
  });
});

describe("the fields table", () => {
  test("every kind is shown as drawn; an unreadable value is never guessed; archived fields are in their disclosure", async () => {
    const w = peopleWorld();
    w.setCache([
      person({ id: P, label: "Ada" }),
      fieldRow({
        id: F(1),
        parent_id: P,
        label: "Note",
        value: { kind: "text", text: "Nuts" },
      }),
      fieldRow({
        id: F(2),
        parent_id: P,
        label: "Weight",
        value: { kind: "quantity", amount: "21.5", unit: "kg" },
      }),
      fieldRow({
        id: F(3),
        parent_id: P,
        label: "Birthday",
        value: { kind: "date", month: 3, day: 3 },
      }),
      fieldRow({
        id: F(4),
        parent_id: P,
        label: "School",
        value: { kind: "url", url: "https://school.example" },
      }),
      fieldRow({
        id: F(5),
        parent_id: P,
        label: "Swims",
        value: { kind: "boolean", value: true },
      }),
      fieldRow({
        id: F(6),
        parent_id: P,
        label: "Size",
        value: { kind: "choices", options: ["S", "M"], selected: ["M"] },
      }),
      fieldRow({
        id: F(7),
        parent_id: P,
        label: "Kit",
        value: {
          kind: "checklist",
          items: [{ id: F(70), label: "Boots" }],
          checked: [F(70)],
        },
      }),
      fieldRow({
        id: F(8),
        parent_id: P,
        label: "Odd",
        value: { kind: "colour", value: "red" },
      }),
      fieldRow({ id: F(9), parent_id: P, label: "Old", archived: true }),
      // PPL-5: a field of ANOTHER person is never shown here.
      fieldRow({
        id: F(10),
        parent_id: "77777777-7777-4777-8777-777777777777",
        label: "Elsewhere",
      }),
    ]);
    await w.mount(`/people/${P}`);
    const row = async (n: number) =>
      (await waitFor(() => {
        const found = document.querySelector(`[data-field-row="${F(n)}"]`);
        if (!found) throw new Error("not yet");
        return found;
      })) as HTMLElement;
    expect(await row(1)).toHaveTextContent("Nuts");
    expect(await row(2)).toHaveTextContent("21.5 kg");
    expect(await row(3)).toHaveTextContent("3 March");
    expect(
      within(await row(4)).getByRole("link", {
        name: /school\.example.*opens in a new tab/,
      }),
    ).toHaveAttribute("rel", "noopener noreferrer");
    expect(await row(5)).toHaveTextContent("Yes");
    expect(await row(6)).toHaveTextContent("M of 2");
    expect(await row(7)).toHaveTextContent("1 of 1 done");
    expect(await row(8)).toHaveTextContent(
      "This value can't be shown on this device",
    );
    expect(document.querySelector(`[data-field-row="${F(9)}"]`)).toBeNull();
    expect(screen.queryByText("Elsewhere")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Archived fields (1)" }),
    );
    expect(screen.getByText("Old")).toBeInTheDocument();
    // The audience comes from the viewer-safe field audiences (finding 8), never from an owner-only policy read (D-11a-13).
    expect(
      within(await row(1)).getByRole("button", { name: "Only you" }),
    ).toBeInTheDocument();
    expect(await row(1)).toHaveTextContent("Nobody else can see it.");
    expect(w.sharing.calls.filter((c) => c.op === "readPolicy")).toEqual([]);
    expect((await axe(document.body)).violations).toEqual([]);
  });

  test("a field the person cannot edit: Edit disabled with the reason", async () => {
    const w = peopleWorld();
    w.setCache([
      person({ id: P, label: "Ada" }),
      fieldRow({ id: F(1), parent_id: P, can_edit: false }),
    ]);
    await w.mount(`/people/${P}`);
    await screen.findByText("You can't edit this field");
    expect(
      within(
        document.querySelector(`[data-field-row="${F(1)}"]`) as HTMLElement,
      ).getByRole("button", { name: "Edit" }),
    ).toBeDisabled();
  });

  test("a queued field create under the person is shown, marked; its own note in a new-person batch too", async () => {
    const w = peopleWorld();
    w.setCache([person({ id: P, label: "Ada" })]);
    w.setDrafts([
      draftRow({
        local_id: "f1",
        created_seq: 1,
        endpoint: "/task-commands",
        command: {
          command: {
            kind: "put_field",
            id: F(1),
            parent_id: P,
            label: "Phone",
            value: { kind: "text", text: "0770" },
          },
        },
      }),
    ]);
    await w.mount(`/people/${P}`);
    const row = await waitFor(() => {
      const found = document.querySelector(`[data-field-row="${F(1)}"]`);
      if (!found) throw new Error("not yet");
      return found as HTMLElement;
    });
    expect(row).toHaveTextContent("0770");
    expect(row).toHaveTextContent("Not sent yet");
  });

  test("a version conflict of a field is shown in its row, with the way to it", async () => {
    const w = peopleWorld();
    w.setCache([
      person({ id: P, label: "Ada" }),
      fieldRow({ id: F(1), parent_id: P }),
    ]);
    w.env.setDrafts([
      draftRow({
        local_id: "c",
        kind: "put_field",
        status: "version_conflict",
        index_targets: [F(1)],
        target_resource_ids: [F(1)],
      }),
    ]);
    await w.mount(`/people/${P}`);
    const row = await waitFor(() => {
      const found = document.querySelector(`[data-field-row="${F(1)}"]`);
      if (!found) throw new Error("not yet");
      return found as HTMLElement;
    });
    expect(row).toHaveTextContent(
      "Someone else changed this field. Open it to see the current value.",
    );
  });
});

describe("not on this device (PPL-5)", () => {
  test("a person the cache does not hold shows nothing of theirs", async () => {
    const w = peopleWorld();
    w.setCache([fieldRow({ id: F(1), parent_id: P, label: "Secret" })]);
    await w.mount(`/people/${P}`);
    expect(
      await screen.findByText(/This person isn't on this device/),
    ).toBeInTheDocument();
    expect(screen.queryByText("Secret")).toBeNull();
  });

  test("a person removed while displayed disappears with every field", async () => {
    const w = peopleWorld();
    w.setCache([
      person({ id: P, label: "Ada" }),
      fieldRow({ id: F(1), parent_id: P, label: "Secret" }),
    ]);
    await w.mount(`/people/${P}`);
    expect(await screen.findByText("Secret")).toBeInTheDocument();
    w.setCache([fieldRow({ id: F(1), parent_id: P, label: "Secret" })]);
    expect(
      await screen.findByText(/This person isn't on this device/),
    ).toBeInTheDocument();
    expect(screen.queryByText("Secret")).toBeNull();
  });
});

describe("New fields start as (B5)", () => {
  test("the resolved field template, and 'isn't known yet' while there is no record (never 'Only you' by assumption)", async () => {
    const w = peopleWorld();
    w.setCache([person({ id: P, label: "Ada" })]);
    w.env.setDefaults(null, false);
    await w.mount(`/people/${P}`);
    const panel = await waitFor(() => {
      const found = document.querySelector("[data-defaults-panel]");
      if (!found) throw new Error("not yet");
      return found as HTMLElement;
    });
    expect(panel).toHaveTextContent("Isn't known yet");
    w.env.setDefaults(
      record({ field: { kind: "primary_household", edit: false } }),
    );
    await waitFor(() => expect(panel).toHaveTextContent("Home · can view"));
    expect(panel).toHaveTextContent(
      "That's what your Home template currently sets.",
    );
    void HOME;
  });
});
