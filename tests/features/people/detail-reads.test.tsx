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
  FIELDS_READ_FAILED,
  NO_FIELDS,
  NOT_ON_DEVICE,
  PERSON_READ_FAILED,
  PERSON_UNCONFIRMED,
} from "../../../src/features/people/copy";
import { forgetAllPeopleMemory } from "../../../src/features/people/memory";
import { forgetRefusedPolicies } from "../../../src/features/sharing/api";
import { installMatchMedia } from "../../helpers/match-media";
import { draftRow } from "../../support/data/rows";
import { fieldRow, peopleWorld, person } from "../../support/people/world";

/**
 * Review 6, finding 2 (`people-detail-read-failure-as-empty`): the person detail says "No fields yet." or "This person isn't on this
 * device" only after the read that would show them COMPLETED (and every unsent change of this device was read); a failed read says
 * so with a working "Try again" (a new read: a failed live query never answers again), and a read still on its way claims nothing.
 * Each case seeds data that exists and fails (or holds) only the read in question; each has a control in which the absence is real.
 * The reviewer's qualified probe pairs are these cases' first two schedules. Fixture evidence (jsdom, the People world's public reads).
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
const F = "77777777-7777-4777-8777-777777777777";
const fieldId = (n: number) =>
  `77777777-7777-4777-8777-${String(n).padStart(12, "0")}`;
const detail = () => document.querySelector(`[data-person-detail="${P}"]`);
/**
 * Text shown by the DETAIL (the announcer's live region repeats a banner's words, and since review 7 the list beside the detail says
 * for itself that the unsent changes could not be read: neither is counted).
 */
const text = (value: string) =>
  screen
    .queryAllByText(value)
    .find(
      (node) =>
        node.closest("[aria-live], .sr-only, [data-people-list]") === null,
    ) ?? null;
/** The DETAIL's Try again (the list beside it says, with its own Try again, that the same unsent changes could not be read: review 7). */
const tryAgain = () => {
  const buttons = screen
    .getAllByRole("button", { name: "Try again" })
    .filter((button) => button.closest("[data-people-list]") === null);
  expect(buttons).toHaveLength(1);
  fireEvent.click(buttons[0] as HTMLElement);
};
/** A queued `create_person` of this device. */
const createOf = (seq: number) =>
  draftRow({
    local_id: `c${seq}`,
    created_seq: seq,
    command: { commands: [{ kind: "create_person", id: P, name: "Ada" }] },
  });

describe("review 6, finding 2: the fields of a person", () => {
  for (const failed of [false, true])
    test(`the field read ${failed ? "FAILS: never 'No fields yet.'; the failure is said, and Try again reads afresh" : "completes with none (control): 'No fields yet.'"}`, async () => {
      const w = peopleWorld();
      w.setCache([
        person({ id: P, label: "Ada" }),
        ...(failed
          ? [fieldRow({ id: F, parent_id: P, label: "Stored medical note" })]
          : []),
      ]);
      if (failed)
        w.failRead(
          "data.readResourceList",
          (input) => input.kind === "field" && input.parentId === P,
        );
      await w.mount(`/people/${P}`);
      await waitFor(() => expect(detail()).not.toBeNull());
      if (!failed) {
        await waitFor(() => expect(text(NO_FIELDS)).not.toBeNull());
        expect(text(FIELDS_READ_FAILED)).toBeNull();
        return;
      }
      await waitFor(() => expect(text(FIELDS_READ_FAILED)).not.toBeNull());
      expect(text(NO_FIELDS)).toBeNull();
      // The storage is repaired without telling anyone: only Try again reads it again.
      w.restoreReads();
      expect(text("Stored medical note")).toBeNull();
      tryAgain();
      await waitFor(() => expect(text("Stored medical note")).not.toBeNull());
      expect(text(FIELDS_READ_FAILED)).toBeNull();
      expect(text(NO_FIELDS)).toBeNull();
    });

  for (const failed of [false, true])
    test(`a later step's read ${failed ? "FAILS: the step says so, never 'No fields yet.', and Previous fields stays" : "completes (control): the 101st field"}`, async () => {
      const w = peopleWorld();
      w.setCache([
        person({ id: P, label: "Ada" }),
        ...Array.from({ length: 101 }, (_, n) =>
          fieldRow({
            id: fieldId(n + 1),
            parent_id: P,
            label: `Field ${n + 1}`,
          }),
        ),
      ]);
      await w.mount(`/people/${P}`);
      await waitFor(() => expect(text("Field 100")).not.toBeNull());
      if (failed)
        w.failRead(
          "data.readResourceList",
          (input) =>
            input.kind === "field" &&
            input.parentId === P &&
            input.after !== null &&
            input.after !== undefined,
        );
      fireEvent.click(screen.getByRole("button", { name: "Next fields" }));
      if (!failed) {
        await waitFor(() => expect(text("Field 101")).not.toBeNull());
        return;
      }
      await waitFor(() => expect(text(FIELDS_READ_FAILED)).not.toBeNull());
      expect(text(NO_FIELDS)).toBeNull();
      expect(
        screen.getByRole("button", { name: "Previous fields" }),
      ).toBeEnabled();
      w.restoreReads();
      tryAgain();
      await waitFor(() => expect(text("Field 101")).not.toBeNull());
    });

  for (const failed of [false, true])
    test(`this device's unsent changes ${failed ? "cannot be read: a field only a queued create shows may be missing, so no 'No fields yet.'; the failure is said and Try again reads afresh" : "are read (control, none): 'No fields yet.'"}`, async () => {
      const w = peopleWorld();
      w.setCache([person({ id: P, label: "Ada" })]);
      if (failed)
        w.setDrafts([
          draftRow({
            local_id: "f1",
            created_seq: 1,
            endpoint: "/task-commands",
            command: {
              command: {
                kind: "put_field",
                id: F,
                parent_id: P,
                label: "Queued note",
                value: { kind: "text", text: "kept" },
              },
            },
          }),
        ]);
      if (failed) w.failRead("data.readOutstandingCreates");
      await w.mount(`/people/${P}`);
      await waitFor(() => expect(detail()).not.toBeNull());
      if (!failed) {
        await waitFor(() => expect(text(NO_FIELDS)).not.toBeNull());
        expect(text(CHANGES_READ_FAILED)).toBeNull();
        return;
      }
      await waitFor(() => expect(text(CHANGES_READ_FAILED)).not.toBeNull());
      expect(text(NO_FIELDS)).toBeNull();
      w.restoreReads();
      tryAgain();
      await waitFor(() => expect(text("Queued note")).not.toBeNull());
      expect(text(CHANGES_READ_FAILED)).toBeNull();
    });
});

describe("review 6, finding 2: the person", () => {
  for (const failed of [false, true])
    test(`the person read ${failed ? "FAILS: never 'not on this device'; the failure is said, and Try again reads afresh" : "completes without them (control): 'not on this device'"}`, async () => {
      const w = peopleWorld();
      w.setCache(failed ? [person({ id: P, label: "Ada" })] : []);
      if (failed) w.failRead("data.readMerged", (input) => input.id === P);
      await w.mount(`/people/${P}`);
      if (!failed) {
        await waitFor(() => expect(text(NOT_ON_DEVICE)).not.toBeNull());
        expect(text(PERSON_READ_FAILED)).toBeNull();
        return;
      }
      await waitFor(() => expect(text(PERSON_READ_FAILED)).not.toBeNull());
      expect(text(NOT_ON_DEVICE)).toBeNull();
      w.restoreReads();
      expect(detail()).toBeNull();
      tryAgain();
      await waitFor(() => expect(detail()).not.toBeNull());
      expect(text(PERSON_READ_FAILED)).toBeNull();
    });

  for (const failed of [false, true])
    test(`a person only a queued create shows, with the unsent changes ${failed ? "unreadable: not 'not on this device'; Try again shows them" : "read (control): shown"}`, async () => {
      const w = peopleWorld();
      w.setCache([]);
      w.setDrafts([createOf(1)]);
      if (failed) w.failRead("data.readOutstandingCreates");
      await w.mount(`/people/${P}`);
      if (!failed) {
        await waitFor(() => expect(detail()).not.toBeNull());
        return;
      }
      await waitFor(() => expect(text(PERSON_READ_FAILED)).not.toBeNull());
      expect(text(NOT_ON_DEVICE)).toBeNull();
      w.restoreReads();
      tryAgain();
      await waitFor(() => expect(detail()).not.toBeNull());
    });

  for (const released of [false, true])
    test(`the unsent changes' LATER window still on its way: ${released ? "once it answers (control), the person its create shows" : "nothing is claimed (no 'not on this device')"}`, async () => {
      const w = peopleWorld();
      w.setCache([]);
      // 100 unrelated unsent changes fill the first window; the person's create is in the second.
      w.setDrafts([
        ...Array.from({ length: 100 }, (_, n) =>
          draftRow({
            local_id: `e${n}`,
            created_seq: n + 1,
            command: {
              commands: [
                {
                  kind: "edit",
                  id: fieldId(500 + n),
                  label: `x${n}`,
                  value: "",
                },
              ],
            },
          }),
        ),
        createOf(200),
      ]);
      w.holdReads(
        "data.readOutstandingCreates",
        (input) => typeof input.after === "number" && input.after > 0,
      );
      await w.mount(`/people/${P}`);
      await waitFor(() => expect(w.gated.length).toBeGreaterThan(0));
      expect(text(NOT_ON_DEVICE)).toBeNull();
      expect(detail()).toBeNull();
      if (!released) {
        expect(
          document.querySelector('[data-people-state="loading"]'),
        ).not.toBeNull();
        return;
      }
      act(() => w.releaseReads());
      await waitFor(() => expect(detail()).not.toBeNull());
      expect(within(detail() as HTMLElement).getByText("Ada")).toBeDefined();
    });

  test("more unsent changes than the chain reads (its cap) and the person among none of them: not 'not on this device'", async () => {
    const w = peopleWorld();
    w.setCache([]);
    // Ten windows of 100 unrelated unsent changes: the chain stops at its cap; the person's create lies beyond it.
    w.setDrafts([
      ...Array.from({ length: 1000 }, (_, n) =>
        draftRow({
          local_id: `e${n}`,
          created_seq: n + 1,
          command: {
            commands: [
              {
                kind: "edit",
                id: fieldId(5000 + n),
                label: `x${n}`,
                value: "",
              },
            ],
          },
        }),
      ),
      createOf(2000),
    ]);
    await w.mount(`/people/${P}`);
    await waitFor(() => expect(text(PERSON_UNCONFIRMED)).not.toBeNull());
    expect(text(NOT_ON_DEVICE)).toBeNull();
    expect(detail()).toBeNull();
  });
});
