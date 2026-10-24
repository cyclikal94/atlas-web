import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  CHANGES_READ_FAILED,
  EDITOR_CHANGES_UNREAD,
  EMPTY,
  EMPTY_ARCHIVED,
  OUTSTANDING_CAPPED,
} from "../../../src/features/people/copy";
import { forgetAllPeopleMemory } from "../../../src/features/people/memory";
import { statusOf } from "../../../src/features/people/reads";
import { forgetRefusedPolicies } from "../../../src/features/sharing/api";
import { installMatchMedia } from "../../helpers/match-media";
import { draftRow } from "../../support/data/rows";
import { record } from "../../support/people/records";
import {
  type PeopleWorld,
  peopleWorld,
  person,
} from "../../support/people/world";

/**
 * Review 7, finding 2 (`people-detail-read-failure-as-empty`, the list's consumer): the People list shows the cache AND this device's
 * unsent changes, so it claims nobody (or nobody matching) only when both were read to their end. Loading shows loading; a failed read of
 * the unsent changes says so with Try again (a fresh read, with the store repaired WITHOUT a notification first, so only the new watch
 * can show the row); a capped one says there are more; readable rows stay shown. Each failure has its genuinely-empty and present
 * controls. Fixture evidence (jsdom).
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

const ADA = "55555555-5555-4555-8555-555555555555";
const BOB = "77777777-7777-4777-8777-777777777777";
const OUTSTANDING = "data.readOutstandingCreates";
const list = () => document.querySelector("[data-people-list]") as HTMLElement;
const state = (name: string) =>
  list().querySelector(`[data-people-state="${name}"]`);
/** Text the list itself shows (the announcer's live region repeats a banner's words; it is not counted). */
const shown = (value: string) =>
  within(list())
    .queryAllByText(value)
    .find((node) => node.closest("[aria-live], .sr-only") === null) ?? null;
const createOf = (seq: number, id: string, name: string) =>
  draftRow({
    local_id: `c${seq}`,
    created_seq: seq,
    command: { commands: [{ kind: "create_person", id, name }] },
  });
const renameOf = (seq: number, id: string, label: string) =>
  draftRow({
    local_id: `r${seq}`,
    created_seq: seq,
    command: { commands: [{ kind: "edit", id, label }] },
  });
const archiveOf = (seq: number, id: string) =>
  draftRow({
    local_id: `a${seq}`,
    created_seq: seq,
    command: {
      command: { kind: "archive", id, expected_version: 1, archived: true },
    },
  });
const tryAgain = () =>
  fireEvent.click(within(list()).getByRole("button", { name: "Try again" }));
const filter = (name: string) =>
  fireEvent.click(within(list()).getByRole("button", { name }));
const search = (value: string) =>
  fireEvent.change(within(list()).getByRole("searchbox"), {
    target: { value },
  });

function world(): PeopleWorld {
  const w = peopleWorld();
  w.env.setDefaults(record());
  return w;
}

describe("review 7, finding 2: the list claims nobody only from complete inventories", () => {
  for (const mode of ["empty", "present", "failed", "loading"] as const)
    test(`All, nothing synced but a queued new person may exist: ${mode === "empty" ? "control, both read and empty: 'No one here yet'" : mode === "present" ? "control, the queued person is shown" : mode === "failed" ? "the unsent changes unreadable: no Empty, the failure is said, Try again shows the person" : "the unsent changes still read: loading, never Empty"}`, async () => {
      const w = world();
      w.setCache([]);
      if (mode !== "empty") w.setDrafts([createOf(1, ADA, "Queued Ada")]);
      if (mode === "failed") w.failRead(OUTSTANDING);
      if (mode === "loading") w.holdReads(OUTSTANDING);
      await w.mount("/people");
      if (mode === "empty") {
        await waitFor(() => expect(state("empty")).not.toBeNull());
        expect(shown(EMPTY)).not.toBeNull();
        return;
      }
      if (mode === "present") {
        await waitFor(() =>
          expect(screen.queryByText("Queued Ada")).not.toBeNull(),
        );
        expect(state("empty")).toBeNull();
        return;
      }
      if (mode === "loading") {
        await waitFor(() => expect(w.gated.length).toBeGreaterThan(0));
        expect(state("loading")).not.toBeNull();
        expect(state("empty")).toBeNull();
        await act(async () => w.releaseReads());
        await waitFor(() =>
          expect(screen.queryByText("Queued Ada")).not.toBeNull(),
        );
        expect(state("empty")).toBeNull();
        return;
      }
      await waitFor(() => expect(state("changes-failed")).not.toBeNull());
      expect(state("empty")).toBeNull();
      expect(state("no-match")).toBeNull();
      expect(shown(CHANGES_READ_FAILED)).not.toBeNull();
      // Repaired without a notification: only a NEW read can show the person (the failed watch has ended).
      w.restoreReads();
      expect(screen.queryByText("Queued Ada")).toBeNull();
      tryAgain();
      await waitFor(() =>
        expect(screen.queryByText("Queued Ada")).not.toBeNull(),
      );
      expect(state("changes-failed")).toBeNull();
    });

  test("the unsent changes unreadable beside readable cached people: the people stay listed, with the failure", async () => {
    const w = world();
    w.setCache([person({ id: BOB, label: "Bob" })]);
    w.setDrafts([createOf(1, ADA, "Queued Ada")]);
    w.failRead(OUTSTANDING);
    await w.mount("/people");
    await waitFor(() => expect(state("changes-failed")).not.toBeNull());
    expect(within(list()).getByText("Bob")).toBeInTheDocument();
  });

  for (const known of [true, false])
    test(`Archived with nobody archived in the cache: ${known ? "control, every unsent change read: 'Nobody is archived.'" : "a queued archive may exist but the unsent changes are unreadable: not claimed"}`, async () => {
      const w = world();
      w.setCache([person({ id: BOB, label: "Bob" })]);
      w.setDrafts([archiveOf(1, BOB)]);
      if (!known) w.failRead(OUTSTANDING);
      await w.mount("/people");
      await waitFor(() => expect(list()).not.toBeNull());
      filter("Archived");
      if (known) {
        // The queued archive is folded: Bob is shown as archived (not "Nobody is archived").
        await waitFor(() =>
          expect(within(list()).getByText("Bob")).toBeVisible(),
        );
        expect(shown(EMPTY_ARCHIVED)).toBeNull();
        return;
      }
      await waitFor(() => expect(state("changes-failed")).not.toBeNull());
      expect(shown(EMPTY_ARCHIVED)).toBeNull();
      expect(state("no-match")).toBeNull();
    });

  for (const known of [true, false])
    test(`a search that only a queued new person matches: ${known ? "control, every unsent change read: the person is found" : "the unsent changes unreadable: no 'No one matches'"}`, async () => {
      const w = world();
      w.setCache([person({ id: BOB, label: "Bob" })]);
      w.setDrafts([createOf(1, ADA, "Queued Ada")]);
      if (!known) w.failRead(OUTSTANDING);
      await w.mount("/people");
      await waitFor(() =>
        expect(within(list()).getByText("Bob")).toBeVisible(),
      );
      search("Ada");
      if (known) {
        await waitFor(() =>
          expect(screen.queryByText("Queued Ada")).not.toBeNull(),
        );
        return;
      }
      await waitFor(() => expect(within(list()).queryByText("Bob")).toBeNull());
      expect(state("no-match")).toBeNull();
      expect(state("changes-failed")).not.toBeNull();
    });

  test("a LATER window of the unsent changes fails: the first window's people are shown, the failure is said, and nobody is claimed absent", async () => {
    const w = world();
    w.setCache([]);
    const drafts = Array.from({ length: 150 }, (_, i) =>
      archiveOf(
        i + 1,
        `99999999-9999-4999-8999-${String(i).padStart(12, "0")}`,
      ),
    );
    // The queued new person is in the SECOND window (created after 150 other changes).
    drafts.push(createOf(151, ADA, "Queued Ada"));
    w.setDrafts(drafts);
    w.failRead(
      OUTSTANDING,
      (input) => input.after !== null && input.after !== undefined,
    );
    await w.mount("/people");
    await waitFor(() => expect(state("changes-failed")).not.toBeNull());
    expect(screen.queryByText("Queued Ada")).toBeNull();
    expect(state("empty")).toBeNull();
    w.restoreReads();
    tryAgain();
    await waitFor(() =>
      expect(screen.queryByText("Queued Ada")).not.toBeNull(),
    );
  });

  test("more unsent changes than the list reads (the cap): said, and nobody is claimed absent", async () => {
    const w = world();
    w.setCache([]);
    w.setDrafts(
      Array.from({ length: 1001 }, (_, i) =>
        archiveOf(
          i + 1,
          `99999999-9999-4999-8999-${String(i).padStart(12, "0")}`,
        ),
      ),
    );
    await w.mount("/people");
    await waitFor(() => expect(state("outstanding-capped")).not.toBeNull());
    expect(shown(OUTSTANDING_CAPPED)).not.toBeNull();
    expect(state("empty")).toBeNull();
    expect(state("no-match")).toBeNull();
  });

  test("the cache read fails on a later page of a search: no 'No one matches', the failure with Try again", async () => {
    const w = world();
    w.setCache(
      Array.from({ length: 150 }, (_, i) =>
        person({
          id: `88888888-8888-4888-8888-${String(i).padStart(12, "0")}`,
          label: i === 140 ? "Zed" : `Person ${i}`,
        }),
      ),
    );
    w.failRead(
      "data.readResourceList",
      (input) =>
        input.kind === "person" &&
        input.after !== null &&
        input.after !== undefined,
    );
    await w.mount("/people");
    await waitFor(() =>
      expect(within(list()).getByText("Person 0")).toBeVisible(),
    );
    search("Zed");
    await waitFor(() =>
      expect(
        within(list()).getAllByRole("button", { name: "Try again" }),
      ).not.toHaveLength(0),
    );
    expect(state("no-match")).toBeNull();
    w.restoreReads();
    tryAgain();
    await waitFor(() => expect(screen.queryByText("Zed")).not.toBeNull());
  });
});

describe("review 7, finding 2: the server's scopes and the unsent changes", () => {
  for (const known of [true, false])
    test(`Not linked, searching the name a queued rename gives: ${known ? "control, every unsent change read: found by the name shown" : "the unsent changes unreadable: the failure is said, and 'No one matches' is not claimed"}`, async () => {
      const w = world();
      w.setCache([person({ id: BOB, label: "Bob" })]);
      w.setDrafts([renameOf(1, BOB, "Robert")]);
      if (!known) w.failRead(OUTSTANDING);
      await w.mount("/people");
      await waitFor(() => expect(list()).not.toBeNull());
      filter("Not linked");
      search("Robert");
      if (known) {
        await waitFor(() =>
          expect(within(list()).queryByText("Robert")).not.toBeNull(),
        );
        return;
      }
      await waitFor(() => expect(state("changes-failed")).not.toBeNull());
      expect(state("no-match")).toBeNull();
    });

  test("control: searching the name a queued rename replaced finds nobody by that name (the search is over the names shown)", async () => {
    const w = world();
    w.setCache([person({ id: BOB, label: "Bob" })]);
    w.setDrafts([renameOf(1, BOB, "Robert")]);
    await w.mount("/people");
    filter("Not linked");
    search("Bob");
    await waitFor(() => expect(state("no-match")).not.toBeNull());
    expect(within(list()).queryByText("Robert")).toBeNull();
  });
});

describe("review 7's design assessment (C15): the field editor needs every unsent change read", () => {
  test("the unsent changes unreadable: the editor does not open on a guessed base; Try again (after repair) opens it", async () => {
    const w = world();
    w.setCache([person({ id: ADA, label: "Ada" })]);
    w.failRead(OUTSTANDING);
    await w.mount(`/people/${ADA}/fields/new`);
    const d = await screen.findByRole("dialog", { name: "Add a field" });
    expect(within(d).queryByText(EDITOR_CHANGES_UNREAD)).not.toBeNull();
    expect(within(d).queryByRole("textbox", { name: "Name" })).toBeNull();
    w.restoreReads();
    fireEvent.click(within(d).getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(
        within(screen.getByRole("dialog", { name: "Add a field" })).getByRole(
          "textbox",
          { name: "Name" },
        ),
      ).toBeInTheDocument(),
    );
  });
});

describe("review 7's design assessment: a closed database is not an absent one", () => {
  test("statusOf: absent only for a database known not to exist; closed and error are failures", () => {
    expect(statusOf({ status: "unavailable", reason: "absent" })).toBe(
      "absent",
    );
    expect(statusOf({ status: "unavailable", reason: "closed" })).toBe(
      "failed",
    );
    expect(statusOf({ status: "unavailable", reason: "error" })).toBe("failed");
    expect(statusOf({ status: "loading" })).toBe("loading");
    expect(statusOf({ status: "ready", value: 1 })).toBe("ready");
  });
});
