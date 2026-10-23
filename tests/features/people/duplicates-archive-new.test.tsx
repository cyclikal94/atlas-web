import {
  act,
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
import { REVISION, record } from "../../support/people/records";
import { fieldRow, peopleWorld, person } from "../../support/people/world";

/**
 * WF-PEOPLE-04 (A13, PPL-3), the Settings "Archived items" ledger (A12, A14) and "New person" (A7, A8 at the client, A16). jsdom, axe;
 * fixture evidence.
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
const Q = "77777777-7777-4777-8777-777777777777";
const R = "88888888-8888-4888-8888-888888888888";
const C = "99999999-9999-4999-8999-999999999999";
const projection = (id: string, label: string) => ({
  id,
  kind: "person" as const,
  parent_id: null,
  label,
  value: null,
  version: 1,
  can_edit: true,
  archived: false,
});

describe("possible duplicates (PPL-3)", () => {
  test("an empty page with next_after never claims completeness; 'Check more' reads on; only next_after null says there are none", async () => {
    const w = peopleWorld();
    w.setCache([person({ id: P, label: "Mo" })]);
    w.api.next.duplicates.push(
      { ok: true, value: { items: [], next_after: C } },
      {
        ok: true,
        value: { items: [projection(Q, "Mohammed A.")], next_after: C },
      },
      { ok: true, value: { items: [], next_after: null } },
    );
    await w.mount(`/people/${P}/duplicates`);
    expect(
      await screen.findByText(
        "No similar names found so far. There are more people to check.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Nothing looks like a duplicate right now."),
    ).toBeNull();
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Possible duplicates of “Mo”",
      }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Check more" }));
    expect(await screen.findByText("Mohammed A.")).toBeInTheDocument();
    expect(
      w.api.calls
        .filter((c) => c.op === "readDuplicates")
        .map((c) => c.args[1]),
    ).toEqual([
      { after: null, limit: 50 },
      { after: C, limit: 50 },
    ]);
    // "Not the same" hides the pair for this page only; nothing is sent.
    fireEvent.click(screen.getByRole("button", { name: "Not the same" }));
    expect(screen.queryByText("Mohammed A.")).toBeNull();
    expect(
      w.api.calls.filter(
        (c) => c.op !== "readDuplicates" && c.op !== "readPerson",
      ),
    ).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Check more" }));
    expect(
      await screen.findByText("Nothing looks like a duplicate right now."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Check more" })).toBeNull();
    expect((await axe(document.body)).violations).toEqual([]);
  });

  test("offline: it needs a connection and nothing is read", async () => {
    const w = peopleWorld({ online: false });
    w.setCache([person({ id: P, label: "Mo" })]);
    await w.mount(`/people/${P}/duplicates`);
    expect(
      await screen.findByText("Checking for duplicates needs a connection.", {
        selector: '[data-duplicates-state="offline"]',
      }),
    ).toBeInTheDocument();
    expect(w.api.calls).toEqual([]);
  });

  test("the detail shows the first page's count ('2+' when more follow) and no count for an empty first page with a cursor", async () => {
    const w = peopleWorld();
    w.setCache([person({ id: P, label: "Mo" })]);
    w.api.next.duplicates.push({
      ok: true,
      value: {
        items: [projection(Q, "Mo A."), projection(R, "Mo B.")],
        next_after: C,
      },
    });
    await w.mount(`/people/${P}`);
    const link = await screen.findByRole("link", {
      name: /Possible duplicates/,
    });
    await waitFor(() =>
      expect(link.querySelector("[data-duplicates-count]")).toHaveTextContent(
        "2+",
      ),
    );
  });

  test("a person no longer available (404) says so", async () => {
    const w = peopleWorld();
    w.setCache([person({ id: P, label: "Mo" })]);
    w.api.next.duplicates.push({ ok: false, kind: "not_found" });
    await w.mount(`/people/${P}/duplicates`);
    expect(
      await screen.findByText("This person is no longer available", {
        selector: "[data-people-banner] p",
      }),
    ).toBeInTheDocument();
  });
});

describe("Settings → Archived items", () => {
  test("archived people and fields with Restore; a field is listed only under a person this device holds (PPL-5)", async () => {
    const w = peopleWorld();
    w.setCache([
      person({ id: P, label: "Mo" }),
      person({ id: Q, label: "Former lodger", archived: true, version: 4 }),
      fieldRow({
        id: R,
        parent_id: P,
        label: "Old emergency contact",
        archived: true,
      }),
      fieldRow({
        id: C,
        parent_id: "12121212-1212-4121-8121-121212121212",
        label: "Orphan",
        archived: true,
      }),
    ]);
    await w.mount("/settings/archived");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Archived items" }),
    ).toBeInTheDocument();
    const lodger = await waitFor(() => {
      const row = document.querySelector(`[data-archived-row="${Q}"]`);
      if (!row) throw new Error("not yet");
      return row as HTMLElement;
    });
    expect(lodger).toHaveTextContent("Person");
    expect(
      await screen.findByText("Old emergency contact · Mo"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Orphan/)).toBeNull();
    expect(screen.queryByText(/Nothing archived/)).toBeNull();
    fireEvent.click(within(lodger).getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(w.built).toHaveLength(1));
    expect(w.built[0]?.command).toEqual({
      command: { kind: "archive", id: Q, expected_version: 4, archived: false },
    });
    expect((await axe(document.body)).violations).toEqual([]);
  });

  test("nothing archived: the drawn empty state", async () => {
    const w = peopleWorld();
    w.setCache([person({ id: P, label: "Mo" })]);
    await w.mount("/settings/archived");
    expect(
      await screen.findByText(
        "Nothing archived. Archiving hides an item without deleting it — its history stays intact.",
      ),
    ).toBeInTheDocument();
  });
});

describe("review 4, finding 5: the ledger says 'Nothing archived' only after every read it needs succeeded (T15)", () => {
  const EMPTY = /Nothing archived/;
  const failedState = () =>
    document.querySelector('[data-archived-state="failed"]');
  const settleLedger = () => new Promise((resolve) => setTimeout(resolve, 0));
  async function opened(w: ReturnType<typeof peopleWorld>) {
    await w.mount("/settings/archived");
    await screen.findByRole("heading", { level: 1, name: "Archived items" });
    await waitFor(() =>
      expect(failedState() ?? screen.queryByText(EMPTY)).not.toBeNull(),
    );
  }

  for (const failed of [true, false])
    test(`the reviewer's case: ${failed ? "the archive read fails: never 'Nothing archived'; the failure is said, with Try again" : "control: a read that succeeds with nothing archived says so"}`, async () => {
      const w = peopleWorld();
      w.setCache(
        failed
          ? [person({ id: Q, label: "Archived Ada", archived: true })]
          : [person({ id: P, label: "Mo" })],
      );
      if (failed) w.failReads();
      await opened(w);
      if (failed) {
        expect(screen.queryByText(EMPTY)).toBeNull();
        expect(failedState()).toHaveTextContent(
          "Couldn't read every archived item on this device.",
        );
        expect(
          within(failedState() as HTMLElement).getByRole("button", {
            name: "Try again",
          }),
        ).toBeInTheDocument();
      } else {
        expect(screen.getByText(EMPTY)).toBeInTheDocument();
        expect(failedState()).toBeNull();
      }
    });

  test("Try again reads afresh: once the reads succeed the archived person is listed (the failure, and no false empty, before)", async () => {
    const w = peopleWorld();
    w.setCache([person({ id: Q, label: "Archived Ada", archived: true })]);
    w.failRead("data.readResourceList");
    await opened(w);
    expect(screen.queryByText(EMPTY)).toBeNull();
    // The failed reads have ended: restoring the store alone changes nothing on the page.
    w.restoreReads();
    await settleLedger();
    expect(failedState()).not.toBeNull();
    expect(document.querySelector(`[data-archived-row="${Q}"]`)).toBeNull();
    fireEvent.click(
      within(failedState() as HTMLElement).getByRole("button", {
        name: "Try again",
      }),
    );
    await waitFor(() =>
      expect(
        document.querySelector(`[data-archived-row="${Q}"]`),
      ).not.toBeNull(),
    );
    expect(failedState()).toBeNull();
    expect(screen.queryByText(EMPTY)).toBeNull();
  });

  test("one kind fails, the other is read: what was read is listed, and the inventory is said to be incomplete", async () => {
    const w = peopleWorld();
    w.setCache([person({ id: Q, label: "Former lodger", archived: true })]);
    w.failRead("data.readResourceList", (input) => input.kind === "field");
    await opened(w);
    await waitFor(() =>
      expect(
        document.querySelector(`[data-archived-row="${Q}"]`),
      ).not.toBeNull(),
    );
    expect(failedState()).not.toBeNull();
    expect(screen.queryByText(EMPTY)).toBeNull();
  });

  test("the outstanding drafts folded over the rows cannot be read: never 'Nothing archived'", async () => {
    const w = peopleWorld();
    w.setCache([person({ id: P, label: "Mo" })]);
    w.failRead("data.readOutstandingCreates");
    await opened(w);
    expect(screen.queryByText(EMPTY)).toBeNull();
    expect(failedState()).not.toBeNull();
  });

  for (const parent of ["failed", "absent"] as const)
    test(`an archived field whose person ${parent === "failed" ? "cannot be read is hidden, and the inventory is incomplete (never 'Nothing archived')" : "is not on this device is hidden (PPL-5): control, a complete empty ledger"}`, async () => {
      const w = peopleWorld();
      const parentId = "12121212-1212-4121-8121-121212121212";
      w.setCache([
        fieldRow({
          id: R,
          parent_id: parentId,
          label: "Old emergency contact",
          archived: true,
        }),
      ]);
      if (parent === "failed")
        w.failRead("data.readMerged", (input) => input.id === parentId);
      await opened(w);
      expect(screen.queryByText(/Old emergency contact/)).toBeNull();
      if (parent === "failed") {
        expect(screen.queryByText(EMPTY)).toBeNull();
        expect(failedState()).not.toBeNull();
      } else {
        expect(screen.getByText(EMPTY)).toBeInTheDocument();
        expect(failedState()).toBeNull();
      }
    });
});

describe("review 5, finding 2: a field's parent report belongs to its CURRENT read (C12, U1-U4, U6)", () => {
  const EMPTY = /Nothing archived/;
  const F = "66666666-6666-4666-8666-666666666666";
  const OLD = "12121212-1212-4121-8121-121212121212";
  const NEW = "13131313-1313-4131-8131-131313131313";
  const failedState = () =>
    document.querySelector('[data-archived-state="failed"]');
  const settle = () => act(() => new Promise((r) => setTimeout(r, 0)));
  const readOf = (id: string) => (input: Record<string, unknown>) =>
    input.id === id;
  /** The ledger with F archived under OLD, its parent read settled as `prior` (hidden: absent; shown: Mo; failed: the read fails). */
  async function settled(
    w: ReturnType<typeof peopleWorld>,
    prior: "hidden" | "shown" | "failed",
  ) {
    w.setCache([
      ...(prior === "shown" ? [person({ id: OLD, label: "Mo" })] : []),
      fieldRow({ id: F, parent_id: OLD, label: "Old phone", archived: true }),
    ]);
    if (prior === "failed") w.failRead("data.readMerged", readOf(OLD));
    await w.mount("/settings/archived");
    await screen.findByRole("heading", { level: 1, name: "Archived items" });
    if (prior === "hidden")
      await waitFor(() => expect(screen.queryByText(EMPTY)).not.toBeNull());
    if (prior === "shown")
      await waitFor(() =>
        expect(screen.queryByText("Old phone · Mo")).not.toBeNull(),
      );
    if (prior === "failed")
      await waitFor(() => expect(failedState()).not.toBeNull());
  }

  // U1/U2: every prior parent state, a new parent whose read is still on its way, then each way it can settle.
  for (const prior of ["hidden", "shown", "failed"] as const)
    for (const outcome of ["person", "absent", "failed"] as const)
      test(`U1/U2: after a ${prior} parent, a NEW parent still loading is never complete; settled ${outcome}, the ledger follows it`, async () => {
        const w = peopleWorld();
        await settled(w, prior);
        if (outcome === "person") w.putCache(person({ id: NEW, label: "Bea" }));
        if (outcome === "failed") w.failRead("data.readMerged", readOf(NEW));
        w.holdReads("data.readMerged", readOf(NEW));
        w.putCache(
          fieldRow({
            id: F,
            parent_id: NEW,
            label: "Old phone",
            archived: true,
            version: 3,
          }),
        );
        // The new parent's read exists and is still loading.
        await waitFor(() =>
          expect(w.gated.some((input) => input.id === NEW)).toBe(true),
        );
        await settle();
        expect(screen.queryByText(EMPTY)).toBeNull();
        expect(failedState()).toBeNull();
        expect(screen.queryByText(/Old phone/)).toBeNull();
        w.releaseReads();
        if (outcome === "person") {
          await waitFor(() =>
            expect(screen.queryByText("Old phone · Bea")).not.toBeNull(),
          );
          expect(screen.queryByText(EMPTY)).toBeNull();
          expect(failedState()).toBeNull();
        } else if (outcome === "absent") {
          await waitFor(() => expect(screen.queryByText(EMPTY)).not.toBeNull());
          expect(failedState()).toBeNull();
        } else {
          await waitFor(() => expect(failedState()).not.toBeNull());
          expect(screen.queryByText(EMPTY)).toBeNull();
        }
        expect(screen.queryByText(/Old phone · Mo/)).toBeNull();
      });

  test("U1 control: the same field and parent with no new read keeps its settled empty ledger", async () => {
    const w = peopleWorld();
    await settled(w, "hidden");
    w.holdReads("data.readMerged", readOf(NEW));
    w.putCache(
      fieldRow({
        id: F,
        parent_id: OLD,
        label: "Old phone",
        archived: true,
        version: 3,
      }),
    );
    await settle();
    expect(w.gated).toEqual([]);
    expect(screen.queryByText(EMPTY)).not.toBeNull();
  });

  for (const held of [true, false])
    test(`U2: the SAME parent read again by a new watch (another service binding) ${held ? "is loading: not complete until it answers" : "control: answering at once, the ledger stays empty"}`, async () => {
      const w = peopleWorld();
      await settled(w, "hidden");
      if (held) w.holdReads("data.readMerged", readOf(OLD));
      const store = w.env.serviceStore as unknown as {
        get(): object;
        set(v: unknown): void;
      };
      act(() => store.set({ ...store.get() }));
      if (held) {
        await waitFor(() =>
          expect(w.gated.some((input) => input.id === OLD)).toBe(true),
        );
        await settle();
        expect(screen.queryByText(EMPTY)).toBeNull();
        w.releaseReads();
      }
      await waitFor(() => expect(screen.queryByText(EMPTY)).not.toBeNull());
    });

  for (const held of [true, false])
    test(`U3: a field that leaves the list (a queued restore) and comes back ${held ? "reads its parent afresh: never complete on its earlier report" : "control: its fresh read answers, and the ledger is empty again"}`, async () => {
      const w = peopleWorld();
      await settled(w, "hidden");
      w.setDrafts([
        draftRow({
          local_id: "restore-f",
          created_seq: 1,
          command: {
            command: {
              kind: "archive",
              id: F,
              expected_version: 2,
              archived: false,
            },
          },
        }),
      ]);
      await settle();
      // Restored on this device: it is no longer archived, and nothing else is.
      expect(screen.queryByText(EMPTY)).not.toBeNull();
      if (held) w.holdReads("data.readMerged", readOf(OLD));
      w.setDrafts([]);
      if (held) {
        await waitFor(() =>
          expect(w.gated.some((input) => input.id === OLD)).toBe(true),
        );
        await settle();
        expect(screen.queryByText(EMPTY)).toBeNull();
        w.releaseReads();
      }
      await waitFor(() => expect(screen.queryByText(EMPTY)).not.toBeNull());
    });

  test("U3: a step back to an earlier page reads its parents afresh (no earlier failure reused); the step with more never says empty", async () => {
    const w = peopleWorld();
    const ids = Array.from(
      { length: 101 },
      (_, i) => `66666666-6666-4666-8666-${String(100000000000 + i)}`,
    );
    w.setCache(
      ids.map((id) =>
        fieldRow({ id, parent_id: OLD, label: "Old phone", archived: true }),
      ),
    );
    w.failRead("data.readMerged", readOf(OLD));
    await w.mount("/settings/archived");
    await waitFor(() => expect(failedState()).not.toBeNull());
    fireEvent.click(await screen.findByRole("button", { name: "Next items" }));
    await screen.findByRole("button", { name: "Previous items" });
    w.restoreReads();
    w.holdReads("data.readMerged", readOf(OLD));
    const before = w.gated.length;
    fireEvent.click(screen.getByRole("button", { name: "Previous items" }));
    await waitFor(() => expect(w.gated.length).toBeGreaterThan(before));
    await settle();
    expect(failedState()).toBeNull();
    expect(screen.queryByText(EMPTY)).toBeNull();
    w.releaseReads();
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Next items" }),
      ).not.toBeNull(),
    );
    await settle();
    expect(failedState()).toBeNull();
    expect(screen.queryByText(EMPTY)).toBeNull();
  });

  test("U6: Try again after a parent read failed makes a NEW parent read; until it answers nothing is complete, then the person is listed", async () => {
    const w = peopleWorld();
    await settled(w, "failed");
    w.putCache(person({ id: OLD, label: "Mo" }));
    // The failed watch has ended: the store answering again changes nothing on the page.
    w.restoreReads();
    await settle();
    expect(failedState()).not.toBeNull();
    w.holdReads("data.readMerged", readOf(OLD));
    const before = w.gated.length;
    fireEvent.click(
      within(failedState() as HTMLElement).getByRole("button", {
        name: "Try again",
      }),
    );
    await waitFor(() => expect(w.gated.length).toBeGreaterThan(before));
    await settle();
    expect(failedState()).toBeNull();
    expect(screen.queryByText(EMPTY)).toBeNull();
    w.releaseReads();
    await waitFor(() =>
      expect(screen.queryByText("Old phone · Mo")).not.toBeNull(),
    );
    expect(failedState()).toBeNull();
  });
});

describe("new person", () => {
  test("one /commands batch, person first then the shown note, capturing person and field defaults; it opens the new person", async () => {
    const w = peopleWorld();
    w.setCache([]);
    w.env.setDefaults(record());
    await w.mount("/people");
    fireEvent.click(
      (
        await screen.findAllByRole("button", { name: "New person" })
      )[0] as HTMLElement,
    );
    const d = await screen.findByRole("dialog", { name: "New person" });
    expect(
      within(d).getByRole("radio", {
        name: "Use my defaults — Home · can edit",
      }),
    ).toBeChecked();
    fireEvent.change(within(d).getByRole("textbox", { name: "Name" }), {
      target: { value: "Ada" },
    });
    fireEvent.click(
      within(d).getByRole("button", { name: "Add a first note" }),
    );
    fireEvent.change(within(d).getByRole("textbox", { name: "First note" }), {
      target: { value: "Nuts" },
    });
    expect((await axe(document.body)).violations).toEqual([]);
    fireEvent.click(within(d).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(w.built).toHaveLength(1));
    const body = w.built[0]?.command as {
      commands: Array<Record<string, unknown>>;
      defaults_revision: string;
    };
    expect(body.commands.map((c) => c.kind)).toEqual([
      "create_person",
      "create_field",
    ]);
    expect(body.commands[1]).toMatchObject({
      person_id: body.commands[0]?.id,
      label: "Note",
      value: "Nuts",
    });
    expect(body.defaults_revision).toBe(REVISION);
    expect(
      await screen.findByRole("heading", { name: "Ada" }),
    ).toBeInTheDocument();
  });

  test("a hidden note keeps its text and is not sent, with no warning", async () => {
    const w = peopleWorld();
    w.setCache([]);
    w.env.setDefaults(record());
    await w.mount("/people");
    fireEvent.click(
      (
        await screen.findAllByRole("button", { name: "New person" })
      )[0] as HTMLElement,
    );
    const d = await screen.findByRole("dialog", { name: "New person" });
    fireEvent.change(within(d).getByRole("textbox", { name: "Name" }), {
      target: { value: "Ada" },
    });
    fireEvent.click(
      within(d).getByRole("button", { name: "Add a first note" }),
    );
    fireEvent.change(within(d).getByRole("textbox", { name: "First note" }), {
      target: { value: "Nuts" },
    });
    fireEvent.click(
      within(d).getByRole("button", { name: "Don't add a note" }),
    );
    fireEvent.click(
      within(d).getByRole("button", { name: "Add a first note" }),
    );
    expect(within(d).getByRole("textbox", { name: "First note" })).toHaveValue(
      "Nuts",
    );
    fireEvent.click(
      within(d).getByRole("button", { name: "Don't add a note" }),
    );
    fireEvent.click(within(d).getByRole("radio", { name: "Only you" }));
    fireEvent.click(within(d).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(w.built).toHaveLength(1));
    expect(w.built[0]?.command).toEqual({
      commands: [
        {
          kind: "create_person",
          id: expect.any(String),
          name: "Ada",
          initial_policy: { grants: [], exclude_accounts: [] },
        },
      ],
    });
  });

  test("a refused save keeps everything; with no database bound yet it says so and saves nothing", async () => {
    const w = peopleWorld();
    w.setCache([]);
    w.env.setDefaults(record());
    w.noDatabase();
    await w.mount("/people");
    fireEvent.click(
      (
        await screen.findAllByRole("button", { name: "New person" })
      )[0] as HTMLElement,
    );
    const d = await screen.findByRole("dialog", { name: "New person" });
    fireEvent.change(within(d).getByRole("textbox", { name: "Name" }), {
      target: { value: "Ada" },
    });
    fireEvent.click(within(d).getByRole("button", { name: "Save" }));
    expect(
      await within(d).findByText(/This device isn't ready to save yet/),
    ).toBeInTheDocument();
    expect(within(d).getByRole("textbox", { name: "Name" })).toHaveValue("Ada");
    expect(w.built).toEqual([]);
  });

  test("a new person whose defaults are still loading cannot be saved under them yet", async () => {
    const w = peopleWorld();
    w.setCache([]);
    w.env.setDefaults(null, false);
    await w.mount("/people");
    fireEvent.click(
      (
        await screen.findAllByRole("button", { name: "New person" })
      )[0] as HTMLElement,
    );
    const d = await screen.findByRole("dialog", { name: "New person" });
    expect(within(d).getByRole("button", { name: "Save" })).toBeDisabled();
    expect(
      within(d).getByText("Loading your sharing defaults…"),
    ).toBeInTheDocument();
    fireEvent.click(within(d).getByRole("radio", { name: "Only you" }));
    expect(within(d).getByRole("button", { name: "Save" })).toBeEnabled();
  });

  test("a queued person's 'Add a field' waits for its defaults review", async () => {
    const w = peopleWorld();
    w.setCache([]);
    w.setDrafts([
      draftRow({
        local_id: "c1",
        created_seq: 1,
        review_block: { kind: "defaults", kinds: ["person"] },
        command: { commands: [{ kind: "create_person", id: P, name: "Ada" }] },
      }),
    ]);
    await w.mount(`/people/${P}`);
    expect(
      await screen.findByText(
        "Review who can see this person in the sync queue first",
      ),
    ).toBeInTheDocument();
  });
});
