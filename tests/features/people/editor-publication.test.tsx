import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { DraftWithCommand } from "../../../src/data";
import {
  AUDIENCE_LOAD_FAILED,
  CONFLICT_NEEDS_AUDIENCE,
  CREATE_CHANGED,
  CREATE_SENDING,
  LATER_EDITS_KEPT,
  PUBLISHED_AUDIENCE_OWNER_ONLY,
  PUBLISHED_AUDIENCE_UNKNOWN,
  PUBLISHED_NOT_SAVED,
  PUBLISHED_REVIEW_FIRST,
  PUBLISHED_TITLE,
  RESTORED_DRAFT,
  STALE_NOT_SAVED,
  WAIT_FOR_SYNC_FIELD,
} from "../../../src/features/people/copy";
import { forgetAllPeopleMemory } from "../../../src/features/people/memory";
import { forgetRefusedPolicies } from "../../../src/features/sharing/api";
import { installMatchMedia } from "../../helpers/match-media";
import { draftRow } from "../../support/data/rows";
import { HOME, record } from "../../support/people/records";
import {
  fieldRow,
  type PeopleWorld,
  peopleWorld,
  person,
} from "../../support/people/world";
import { ok } from "../../support/sharing/fake-api";

/**
 * Review 10, finding 1 (`people-editor-create-publication-binding`): an edit that began on a field's unsent CREATE has no binding to the
 * published field. Once the create is published the editor keeps the input and shows the field and who can see it as they are NOW
 * ("This field has finished syncing"); Save waits for that review, and only "Save mine on the current version" binds the edit, after
 * the current audience was read at the field's policy version (unknown is never unchanged). The save is then an UPDATE of the same field
 * (`expected_version`, `expected_policy_version`, no `initial_policy`), never another create, and nothing binds or saves because the
 * create was published. Every case has its control; each asserts the exact stored command. Review 10's design assessment, DA10-01 to
 * DA10-09. Fixture evidence (jsdom, the people world's outbox and read doubles); the native counterpart is E-P37.
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
const MERGED = "data.readMerged";
const OUTSTANDING = "data.readOutstandingCreates";
const PRIVATE = { grants: [], exclude_accounts: [] };
const HOME_VIEW = {
  grants: [{ kind: "household" as const, id: HOME, edit: false }],
  exclude_accounts: [],
};

function world(options: { online?: boolean } = {}) {
  const w = peopleWorld(options);
  w.setCache([person({ id: P, label: "Ada" })]);
  w.env.setDefaults(record());
  return w;
}

/** The dialog named `name`, once shown (its absence is an assertion failure, never a query error). */
async function dialogNamed(name: string | RegExp): Promise<HTMLElement> {
  return waitFor(() => {
    const found = screen.queryByRole("dialog", { name });
    expect(found, `the dialog ${String(name)} is shown`).not.toBeNull();
    return found as HTMLElement;
  });
}
const dialogs = () => screen.queryAllByRole("dialog");
const closed = () => waitFor(() => expect(dialogs()).toHaveLength(0));
function value(d: HTMLElement): HTMLElement {
  const box = within(d).queryByRole("textbox", { name: "Value" });
  expect(box, "the editor's Value input is shown").not.toBeNull();
  return box as HTMLElement;
}
const button = (d: HTMLElement, name: string) => {
  const found = within(d).queryByRole("button", { name });
  expect(found, `the ${name} button is shown`).not.toBeNull();
  return found as HTMLButtonElement;
};
/** The text a disabled button is described by (its reason). */
const reasonOf = (b: HTMLElement) =>
  (b.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ");
const review = (d: HTMLElement) =>
  d.querySelector("[data-review-published]")?.textContent ?? null;
const audienceOf = (d: HTMLElement) =>
  d.querySelector("[data-review-audience]")?.textContent ?? null;
const commandOf = (w: PeopleWorld, at: number) =>
  ((w.built[at]?.command ?? {}) as { command: Record<string, unknown> })
    .command;
const policyReads = (w: PeopleWorld) =>
  w.sharing.calls.filter((call) => call.op === "readPolicy").length;

/** Adds a field through the editor (Only you): it is queued, so its editor edits an unsent create (projected). */
async function queuedField(w: PeopleWorld) {
  await w.mount(`/people/${P}/fields/new`);
  const d = await dialogNamed("Add a field");
  fireEvent.change(within(d).getByRole("textbox", { name: "Name" }), {
    target: { value: "Queued" },
  });
  fireEvent.change(value(d), { target: { value: "Queued value" } });
  fireEvent.click(within(d).getByRole("radio", { name: "Only you" }));
  fireEvent.click(within(d).getByRole("button", { name: "Save" }));
  await closed();
  const id = w.built[0]?.request.targets[0]?.resourceId;
  if (id === undefined) throw new Error("no create queued");
  cleanup();
  return id;
}
/** The field as the create published it (version 1, policy version 1 unless said). */
const published = (id: string, over: Parameters<typeof fieldRow>[0] = {}) =>
  fieldRow({
    id,
    parent_id: P,
    label: "Queued",
    value: { kind: "text", text: "Queued value" },
    version: 1,
    policy_version: 1,
    ...over,
  });
/** Opens the queued field's editor and types the second value over the create. */
async function typed(w: PeopleWorld, id: string, text = "Second value") {
  const mounted = await w.mount(`/people/${P}/fields/${id}`);
  const d = await dialogNamed("Edit Queued");
  // The positive witness that the edit began on the unsent create: the projected editor has no Archive and no audience choice.
  expect(within(d).queryByRole("button", { name: "Archive" })).toBeNull();
  fireEvent.change(value(d), { target: { value: text } });
  return { d, ...mounted };
}
/** The review of the published field is shown in the editor named `name`, with the input kept. */
async function reviewing(text = "Second value", name = "Edit Queued") {
  const d = await dialogNamed(name);
  await waitFor(() => expect(review(d)).toBe(PUBLISHED_NOT_SAVED));
  expect(
    within(d).getByRole("heading", { name: PUBLISHED_TITLE }),
  ).toBeTruthy();
  expect(value(d)).toHaveValue(text);
  // A published field: Archive is offered (the positive publication witness); Save waits for the review.
  expect(within(d).queryByRole("button", { name: "Archive" })).not.toBeNull();
  const save = button(d, "Save");
  expect(save).toBeDisabled();
  expect(reasonOf(save)).toContain(PUBLISHED_REVIEW_FIRST);
  return d;
}
/** "Save mine on the current version", once enabled (the current audience was read). */
async function saveMine(d: HTMLElement) {
  const mine = await waitFor(() => {
    const b = button(d, "Save mine on the current version");
    expect(b).toBeEnabled();
    return b;
  });
  fireEvent.click(mine);
}
/** The update the bound save wrote: the same field, under its person, on the reviewed versions, never a create. */
function expectUpdate(
  w: PeopleWorld,
  at: number,
  id: string,
  expected: {
    version?: number;
    policyVersion?: number;
    text?: string;
    parent?: string;
    label?: string;
  } = {},
) {
  expect(w.built[at]?.op).toBe("enqueue");
  expect(w.built[at]?.request.targets.map((t) => t.resourceId)).toEqual([id]);
  const command = commandOf(w, at);
  expect(command).toEqual({
    kind: "put_field",
    id,
    parent_id: expected.parent ?? P,
    expected_version: expected.version ?? 1,
    expected_policy_version: expected.policyVersion ?? 1,
    label: expected.label ?? "Queued",
    value: { kind: "text", text: expected.text ?? "Second value" },
  });
  expect(command).not.toHaveProperty("initial_policy");
}

describe("DA10-01: the create published while its edit is open, kept or away", () => {
  for (const timing of [
    "while-open",
    "retained-remount",
    "while-away",
  ] as const)
    test(`${timing}: the input is reviewed on the published field and saved as its update, once`, async () => {
      const w = world();
      const id = await queuedField(w);
      await typed(w, id);
      if (timing === "while-away") cleanup();
      await act(async () => {
        w.handOff([published(id)], []);
      });
      if (timing !== "while-open") {
        cleanup();
        await w.mount(`/people/${P}/fields/${id}`);
      }
      const d = await reviewing();
      if (timing !== "while-open")
        expect(within(d).queryByText(RESTORED_DRAFT)).not.toBeNull();
      // Nothing binds or saves because the create was published: the audience is read, and still only the create was written.
      await waitFor(() => expect(policyReads(w)).toBeGreaterThan(0));
      await waitFor(() => expect(audienceOf(d)).toContain("Only you"));
      await act(async () => undefined);
      expect(w.built).toHaveLength(1);
      await saveMine(d);
      await waitFor(() => expect(w.built).toHaveLength(2));
      expectUpdate(w, 1, id);
      await closed();
      expect(w.built).toHaveLength(2);
    });

  test("control: published before the editor opened: an ordinary bound edit, no review", async () => {
    const w = world();
    const id = await queuedField(w);
    w.handOff([published(id)], []);
    await w.mount(`/people/${P}/fields/${id}`);
    const d = await dialogNamed("Edit Queued");
    expect(review(d)).toBeNull();
    fireEvent.change(value(d), { target: { value: "Second value" } });
    const save = button(d, "Save");
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(w.built).toHaveLength(2));
    expectUpdate(w, 1, id);
    await closed();
  });

  test("control: still unsent: Save edits the create in place (its own body), no update", async () => {
    const w = world();
    const id = await queuedField(w);
    const { d } = await typed(w, id);
    expect(review(d)).toBeNull();
    fireEvent.click(button(d, "Save"));
    await waitFor(() => expect(w.built).toHaveLength(2));
    expect(w.built[1]).toMatchObject({
      op: "edit",
      target: w.drafts[0]?.local_id,
    });
    await closed();
  });

  test("Discard mine ends the session and its input; nothing is written", async () => {
    const w = world();
    const id = await queuedField(w);
    await typed(w, id);
    await act(async () => {
      w.handOff([published(id)], []);
    });
    const d = await reviewing();
    fireEvent.click(button(d, "Discard mine"));
    await closed();
    await w.mount(`/people/${P}/fields/${id}`);
    const again = await dialogNamed("Edit Queued");
    expect(within(again).queryByText(RESTORED_DRAFT)).toBeNull();
    expect(value(again)).toHaveValue("Queued value");
    expect(w.built).toHaveLength(1);
  });
});

describe("DA10-02: one commit delivered queue-first or cache-first, and the cache before the create leaves the queue", () => {
  for (const first of ["queue", "cache"] as const)
    test(`${first} first: never reinitialised, never bound by itself; reviewed and saved once`, async () => {
      const w = world();
      const id = await queuedField(w);
      await typed(w, id);
      w.freezeReads(first === "queue" ? MERGED : OUTSTANDING);
      await act(async () => {
        w.handOff([published(id)], []);
      });
      await act(async () => undefined);
      expect(w.built).toHaveLength(1);
      w.thawReads();
      const d = await reviewing();
      await saveMine(d);
      await waitFor(() => expect(w.built).toHaveLength(2));
      expectUpdate(w, 1, id);
    });

  test("the field is cached while its acknowledged create is still outstanding: reviewed and updated on the cached version", async () => {
    const w = world();
    const id = await queuedField(w);
    await typed(w, id);
    await act(async () => {
      w.putCache(published(id));
      w.setDrafts(
        w.drafts.map((d) => ({ ...d, status: "acknowledged" as const })),
      );
    });
    const d = await reviewing();
    await saveMine(d);
    await waitFor(() => expect(w.built).toHaveLength(2));
    expectUpdate(w, 1, id);
    expect(w.drafts.map((d) => d.kind)).toEqual(["put_field", "put_field"]);
  });
});

describe("DA10-03: who can see it must be read at the published field's policy version", () => {
  async function publishedReview(
    w: PeopleWorld,
    over: Parameters<typeof fieldRow>[0] = {},
  ) {
    const id = await queuedField(w);
    await typed(w, id);
    await act(async () => {
      w.handOff([published(id, over)], []);
    });
    return { id, d: await reviewing() };
  }
  const withheld = async (d: HTMLElement, reason: string) => {
    await waitFor(() =>
      expect(reasonOf(button(d, "Save mine on the current version"))).toContain(
        reason,
      ),
    );
    expect(button(d, "Save mine on the current version")).toBeDisabled();
    expect(audienceOf(d)).toBe(PUBLISHED_AUDIENCE_UNKNOWN);
  };

  test("the audience read fails: withheld, said, nothing written", async () => {
    const w = world();
    w.sharing.next.policy.push({ ok: false, kind: "not_found" });
    const { d } = await publishedReview(w);
    await withheld(d, AUDIENCE_LOAD_FAILED);
    expect(w.built).toHaveLength(1);
    expect(value(d)).toHaveValue("Second value");
  });

  test("the audience is the owner's to read: withheld, said, nothing written", async () => {
    const w = world();
    w.sharing.next.policy.push({ ok: false, kind: "forbidden" });
    const { d } = await publishedReview(w);
    await withheld(d, PUBLISHED_AUDIENCE_OWNER_ONLY);
    expect(w.built).toHaveLength(1);
  });

  test("offline: withheld until online, then the audience read binds it", async () => {
    const w = world({ online: false });
    const { id, d } = await publishedReview(w);
    await withheld(d, CONFLICT_NEEDS_AUDIENCE);
    expect(policyReads(w)).toBe(0);
    expect(w.built).toHaveLength(1);
    await act(async () => {
      w.setOnline(true);
    });
    const again = await reviewing();
    await waitFor(() => expect(audienceOf(again)).toContain("Only you"));
    await saveMine(again);
    await waitFor(() => expect(w.built).toHaveLength(2));
    expectUpdate(w, 1, id);
  });

  test("the audience read is NEWER than the cached field: withheld until the field syncs, then bound to the newer version", async () => {
    const w = world();
    w.sharing.next.policy.push(ok({ version: 2, policy: HOME_VIEW }));
    const { id, d } = await publishedReview(w);
    await withheld(d, WAIT_FOR_SYNC_FIELD);
    await act(async () => {
      w.putCache(published(id, { policy_version: 2 }));
    });
    await waitFor(() => expect(audienceOf(d)).toContain("Home"));
    await saveMine(d);
    await waitFor(() => expect(w.built).toHaveLength(2));
    expectUpdate(w, 1, id, { policyVersion: 2 });
  });

  test("shared since it was created: the audience now is shown, and the save is bound to it", async () => {
    const w = world();
    w.sharing.next.policy.push(ok({ version: 3, policy: HOME_VIEW }));
    const { id, d } = await publishedReview(w, {
      version: 2,
      policy_version: 3,
    });
    await waitFor(() => expect(audienceOf(d)).toContain("Home · can view"));
    await saveMine(d);
    await waitFor(() => expect(w.built).toHaveLength(2));
    expectUpdate(w, 1, id, { version: 2, policyVersion: 3 });
  });

  test("control: an edit bound at opening saves its content offline under its captured policy version", async () => {
    const w = world({ online: false });
    const id = await queuedField(w);
    w.handOff([published(id, { policy_version: 4 })], []);
    await w.mount(`/people/${P}/fields/${id}`);
    const d = await dialogNamed("Edit Queued");
    fireEvent.change(value(d), { target: { value: "Second value" } });
    fireEvent.click(button(d, "Save"));
    await waitFor(() => expect(w.built).toHaveLength(2));
    expectUpdate(w, 1, id, { policyVersion: 4 });
    expect(policyReads(w)).toBe(0);
  });
});

describe("DA10-04: the create changed, claimed or replaced before the edit acted", () => {
  test("another page edited the create's body: nothing overwritten, no new create; after publication it is reviewed and updated", async () => {
    const w = world();
    const id = await queuedField(w);
    const { d } = await typed(w, id);
    await act(async () => {
      w.setDrafts(w.drafts.map((x) => ({ ...x, command_digest: "peer" })));
    });
    fireEvent.click(button(d, "Save"));
    await waitFor(() =>
      expect(within(d).queryByText(CREATE_CHANGED)).not.toBeNull(),
    );
    expect(w.built).toHaveLength(1);
    expect(value(d)).toHaveValue("Second value");
    await act(async () => {
      w.handOff(
        [published(id, { value: { kind: "text", text: "Peer value" } })],
        [],
      );
    });
    const again = await reviewing();
    expect(again.querySelector("[data-review-current]")?.textContent).toContain(
      "Peer value",
    );
    await saveMine(again);
    await waitFor(() => expect(w.built).toHaveLength(2));
    expectUpdate(w, 1, id);
  });

  test("the create is being sent: said, nothing written, the input kept; after publication it is reviewed and updated", async () => {
    const w = world();
    const id = await queuedField(w);
    const { d } = await typed(w, id);
    await act(async () => {
      w.setDrafts(
        w.drafts.map((x) => ({ ...x, status: "in_flight" as const })),
      );
    });
    fireEvent.click(button(d, "Save"));
    await waitFor(() =>
      expect(within(d).queryByText(CREATE_SENDING)).not.toBeNull(),
    );
    expect(w.built).toHaveLength(1);
    expect(value(d)).toHaveValue("Second value");
    await act(async () => {
      w.handOff([published(id)], []);
    });
    const again = await reviewing();
    await saveMine(again);
    await waitFor(() => expect(w.built).toHaveLength(2));
    expectUpdate(w, 1, id);
  });

  test("a later create of the same field replaced the one the edit began on: nothing overwritten", async () => {
    const w = world();
    const id = await queuedField(w);
    const { d } = await typed(w, id);
    await act(async () => {
      w.setDrafts(w.drafts.map((x) => ({ ...x, local_id: "replacement" })));
    });
    fireEvent.click(button(d, "Save"));
    await waitFor(() =>
      expect(within(d).queryByText(CREATE_CHANGED)).not.toBeNull(),
    );
    expect(w.built).toHaveLength(1);
  });
});

describe("DA10-05: the field moves after the review is shown", () => {
  test("published content advances before the click: the review shows it, and the save is bound to what it showed", async () => {
    const w = world();
    const id = await queuedField(w);
    await typed(w, id);
    await act(async () => {
      w.handOff([published(id)], []);
    });
    const d = await reviewing();
    await act(async () => {
      w.putCache(
        published(id, {
          version: 2,
          value: { kind: "text", text: "Peer value" },
        }),
      );
    });
    await waitFor(() =>
      expect(d.querySelector("[data-review-current]")?.textContent).toContain(
        "Peer value",
      ),
    );
    await saveMine(d);
    await waitFor(() => expect(w.built).toHaveLength(2));
    expectUpdate(w, 1, id, { version: 2 });
  });

  test("another save of the field is queued between the review and the write: nothing is written, it is reviewed again", async () => {
    const w = world();
    const id = await queuedField(w);
    await typed(w, id);
    await act(async () => {
      w.handOff([published(id)], []);
    });
    const d = await reviewing();
    await waitFor(() => expect(audienceOf(d)).toContain("Only you"));
    // Another page's update raised the field's base; this page's chain read has not delivered it yet.
    w.freezeReads(OUTSTANDING);
    const peer = draftRow({
      local_id: "peer",
      created_seq: 500,
      endpoint: "/task-commands",
      kind: "put_field",
      target_resource_ids: [id],
      index_targets: [id],
      bumped: [id],
      bases: { [id]: 1 },
      command: {
        command: {
          kind: "put_field",
          id,
          parent_id: P,
          expected_version: 1,
          expected_policy_version: 1,
          label: "Queued",
          value: { kind: "text", text: "Peer value" },
        },
      },
    }) as DraftWithCommand;
    w.versions.set(id, 2);
    await act(async () => {
      w.setDrafts([peer]);
    });
    await saveMine(d);
    await waitFor(() =>
      expect(d.querySelector("[data-review-refused]")?.textContent).toBe(
        STALE_NOT_SAVED,
      ),
    );
    expect(w.built).toHaveLength(1);
    expect(value(d)).toHaveValue("Second value");
    w.thawReads();
    // The second explicit review, now of the field with the other save: the edit takes that save's place (its body, D-11a-15).
    await waitFor(() =>
      expect(d.querySelector("[data-review-current]")?.textContent).toContain(
        "Peer value",
      ),
    );
    await saveMine(d);
    await waitFor(() => expect(w.built).toHaveLength(2));
    expect(w.built[1]).toMatchObject({ op: "edit", target: "peer" });
    expect(commandOf(w, 1)).toMatchObject({
      id,
      expected_policy_version: 1,
      value: { kind: "text", text: "Second value" },
    });
  });
});

describe("DA10-06: a first note created with its person, and a field under a queued person", () => {
  test("the first note's edit (its batch cannot be edited in place) is reviewed after publication and updates that note only", async () => {
    const w = peopleWorld();
    w.setCache([]);
    w.env.setDefaults(record());
    await w.mount("/people");
    fireEvent.click(
      (
        await screen.findAllByRole("button", { name: "New person" })
      )[0] as HTMLElement,
    );
    const n = await dialogNamed("New person");
    fireEvent.change(within(n).getByRole("textbox", { name: "Name" }), {
      target: { value: "Bo" },
    });
    fireEvent.click(
      within(n).getByRole("button", { name: "Add a first note" }),
    );
    fireEvent.change(within(n).getByRole("textbox", { name: "First note" }), {
      target: { value: "Nuts" },
    });
    fireEvent.click(within(n).getByRole("radio", { name: "Only you" }));
    fireEvent.click(within(n).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(w.built).toHaveLength(1));
    const batch = w.built[0]?.command as {
      commands: Array<Record<string, unknown>>;
    };
    const personId = batch.commands[0]?.id as string;
    const noteId = batch.commands[1]?.id as string;
    cleanup();
    await w.mount(`/people/${personId}/fields/${noteId}`);
    const d = await dialogNamed("Edit Note");
    fireEvent.change(value(d), { target: { value: "Peanuts" } });
    fireEvent.click(button(d, "Save"));
    await waitFor(() =>
      expect(within(d).queryByText(WAIT_FOR_SYNC_FIELD)).not.toBeNull(),
    );
    expect(w.built).toHaveLength(1);
    await act(async () => {
      w.handOff(
        [
          person({ id: personId, label: "Bo" }),
          fieldRow({
            id: noteId,
            parent_id: personId,
            label: "Note",
            value: { kind: "text", text: "Nuts" },
            version: 1,
            policy_version: 1,
          }),
        ],
        [],
      );
    });
    const again = await reviewing("Peanuts", "Edit Note");
    await saveMine(again);
    await waitFor(() => expect(w.built).toHaveLength(2));
    expectUpdate(w, 1, noteId, {
      parent: personId,
      label: "Note",
      text: "Peanuts",
    });
    expect(
      w.built.filter((b) =>
        JSON.stringify(b.command).includes("create_person"),
      ),
    ).toHaveLength(1);
  });

  test("a field added under a queued person: after both are published the edit is reviewed and updates the field under that person", async () => {
    const w = world();
    const Q = "57575757-5757-4575-8575-575757575757";
    w.setDrafts([
      draftRow({
        local_id: "person-create",
        created_seq: 1,
        endpoint: "/commands",
        kind: "create_person",
        target_resource_ids: [Q],
        index_targets: [Q],
        command: {
          commands: [
            {
              kind: "create_person",
              id: Q,
              name: "Cy",
              initial_policy: PRIVATE,
            },
          ],
        },
      }) as DraftWithCommand,
    ]);
    await w.mount(`/people/${Q}/fields/new`);
    const n = await dialogNamed("Add a field");
    fireEvent.change(within(n).getByRole("textbox", { name: "Name" }), {
      target: { value: "Queued" },
    });
    fireEvent.change(value(n), { target: { value: "Queued value" } });
    fireEvent.click(within(n).getByRole("radio", { name: "Only you" }));
    fireEvent.click(within(n).getByRole("button", { name: "Save" }));
    await closed();
    expect(w.built[0]?.request.dependsOnExtra ?? []).toEqual(["person-create"]);
    const id = w.built[0]?.request.targets[0]?.resourceId as string;
    cleanup();
    await w.mount(`/people/${Q}/fields/${id}`);
    const d = await dialogNamed("Edit Queued");
    fireEvent.change(value(d), { target: { value: "Second value" } });
    await act(async () => {
      w.handOff(
        [
          person({ id: Q, label: "Cy" }),
          fieldRow({
            id,
            parent_id: Q,
            label: "Queued",
            value: { kind: "text", text: "Queued value" },
            version: 1,
            policy_version: 1,
          }),
        ],
        [],
      );
    });
    const again = await reviewing();
    await saveMine(again);
    await waitFor(() => expect(w.built).toHaveLength(2));
    expectUpdate(w, 1, id, { parent: Q });
  });
});

describe("DA10-07: published while the editor's reads failed; Try again", () => {
  test("Try again reads afresh and the kept input is reviewed and saved once", async () => {
    const w = world();
    const id = await queuedField(w);
    const { d } = await typed(w, id);
    expect(d).toBeTruthy();
    w.failRead(MERGED, (input) => input.id === id);
    await act(async () => {
      w.handOff([published(id)], []);
    });
    const failed = await dialogNamed("Edit field");
    await waitFor(() =>
      expect(
        failed
          .querySelector("[data-people-state]")
          ?.getAttribute("data-people-state"),
      ).toBe("editor-read-failed"),
    );
    expect(w.built).toHaveLength(1);
    w.restoreReads({ notify: false });
    fireEvent.click(button(failed, "Try again"));
    const again = await reviewing();
    await saveMine(again);
    await waitFor(() => expect(w.built).toHaveLength(2));
    expectUpdate(w, 1, id);
  });
});

describe("DA10-08: the bound save's completion belongs to its session and revision", () => {
  test("typed again while the bound save is written: the save ends nothing, the later input stays and saves in place of it", async () => {
    const w = world();
    const id = await queuedField(w);
    await typed(w, id);
    await act(async () => {
      w.handOff([published(id)], []);
    });
    const d = await reviewing();
    let open!: () => void;
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    const entered = { count: 0 };
    const outbox = w.env.outbox();
    if (outbox === null) throw new Error("no outbox");
    const original = outbox.enqueue.bind(outbox);
    outbox.enqueue = async (...args: Parameters<typeof original>) => {
      entered.count += 1;
      await opened;
      return original(...args);
    };
    await saveMine(d);
    await waitFor(() => expect(entered.count).toBe(1));
    fireEvent.change(value(d), { target: { value: "Third value" } });
    await act(async () => {
      open();
      await opened;
    });
    await waitFor(() => expect(w.built).toHaveLength(2));
    expectUpdate(w, 1, id);
    await waitFor(() =>
      expect(within(d).queryByText(LATER_EDITS_KEPT)).not.toBeNull(),
    );
    expect(value(d)).toHaveValue("Third value");
    // Bound now (no publication review). As for every bound edit, the update just queued moved the field's base: the later input is
    // refused into the ordinary review, and "Save mine" saves it in place of that update (D-11a-15).
    expect(review(d)).toBeNull();
    fireEvent.click(button(d, "Save"));
    await waitFor(() =>
      expect(d.querySelector("[data-review-refused]")?.textContent).toBe(
        STALE_NOT_SAVED,
      ),
    );
    expect(w.built).toHaveLength(2);
    await saveMine(d);
    await waitFor(() => expect(w.built).toHaveLength(3));
    expect(w.built[2]).toMatchObject({
      op: "edit",
      target: w.drafts[0]?.local_id,
    });
    expect(commandOf(w, 2)).toMatchObject({
      id,
      expected_policy_version: 1,
      value: { kind: "text", text: "Third value" },
    });
    await closed();
  });

  test("an old view's 'Save mine' after the view was replaced binds and writes nothing", async () => {
    const w = world();
    const id = await queuedField(w);
    await typed(w, id);
    await act(async () => {
      w.handOff([published(id)], []);
    });
    const d = await reviewing();
    await waitFor(() => expect(audienceOf(d)).toContain("Only you"));
    const stale = button(d, "Save mine on the current version");
    const props = (stale as unknown as Record<string, { onClick(): void }>)[
      Object.keys(stale).find((k) => k.startsWith("__reactProps$")) as string
    ];
    cleanup();
    await w.mount(`/people/${P}/fields/${id}`);
    const replacement = await reviewing();
    await act(async () => {
      props?.onClick();
    });
    await act(async () => undefined);
    expect(w.built).toHaveLength(1);
    expect(review(replacement)).toBe(PUBLISHED_NOT_SAVED);
  });
});

describe("DA10-09: a conflicted save of the field and the publication review", () => {
  test("the conflict is shown first; once it is resolved the kept input is reviewed and saved, never the conflicted body", async () => {
    const w = world();
    const id = await queuedField(w);
    await typed(w, id);
    const conflicted = {
      command: {
        kind: "put_field",
        id,
        parent_id: P,
        expected_version: 1,
        expected_policy_version: 1,
        label: "Queued",
        value: { kind: "text", text: "Conflicted value" },
      },
    };
    await act(async () => {
      w.handOff([published(id, { version: 2 })], []);
      w.env.setDrafts([
        draftRow({
          local_id: "c",
          kind: "put_field",
          status: "version_conflict",
          index_targets: [id],
          target_resource_ids: [id],
          command: conflicted,
        }),
      ]);
      w.putBody("c", conflicted);
    });
    const d = await dialogNamed("Edit Queued");
    await waitFor(() =>
      expect(
        within(d).queryByRole("heading", {
          name: "Someone else changed this field",
        }),
      ).not.toBeNull(),
    );
    expect(review(d)).toBeNull();
    expect(value(d)).toHaveValue("Second value");
    await act(async () => {
      w.env.setDrafts([]);
    });
    const again = await reviewing();
    await saveMine(again);
    await waitFor(() => expect(w.built).toHaveLength(2));
    expectUpdate(w, 1, id, { version: 2 });
  });
});
