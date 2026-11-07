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
import * as householdsCopy from "../../src/features/sharing/households/copy";
import type { TaskActions } from "../../src/features/tasks/actions";
import {
  CORRECTION_COPY,
  CorrectionDialog,
} from "../../src/features/tasks/detail/CorrectionDialog";
import {
  RECORD_COPY,
  RecordCard,
} from "../../src/features/tasks/detail/RecordCard";
import { RESTORE_COPY } from "../../src/lib/form-recovery/RecoveryNotice";
import { installMatchMedia } from "../helpers/match-media";
import { ME as SHARING_ME } from "../support/data/sharing";
import { stubEnv } from "../support/data/ui-env";
import {
  forgetRecoveryWorld,
  holdDiscards,
  installRecoveryLocks,
  left,
  protectedTree,
  rowFor,
  store,
  withRecovery,
} from "../support/recovery-editors";
import { ok } from "../support/sharing/fake-api";
import { fakeHouseholdApi } from "../support/sharing/fake-households";
import {
  HOME_ID,
  homeOf,
  mountHouseholds,
} from "../support/sharing/households";
import { ME } from "../support/tasks/world";

/**
 * WEB-14a revision 38 (review of revision 37, 26 October 2026: R40-A and R40-B, family `production-form-update-recovery-registration`;
 * design assessment Q1). The review's two caller witnesses and their healthy controls, promoted unchanged in their expected values from
 * `.agtx/evidence/review-r37-20261026/editor-probes-final/editor-probes.test.tsx` into a maintained test of the actual production editors:
 *
 *  - R40-A: a discard whose storage completes after a newer edit must not clear that edit (the AddSource dialog).
 *  - R40-B: after the automatic restore, a deliberate choice of the other saved copy must replace it (the Record progress card).
 */
installMatchMedia({ width: 1440 });
beforeAll(installRecoveryLocks);
afterEach(forgetRecoveryWorld);

const label = () =>
  screen.getByRole("textbox", { name: "Label" }) as HTMLInputElement;
const addDialog = () => (
  <AddSourceDialog online identity={`${ME}:1`} onClose={() => undefined} />
);

describe("Q1 R40-A: a discard completing after newer input (AddSourceDialog)", () => {
  test("a calendar discard finishing after another edit does not clear that later edit", async () => {
    await left(
      ADD_CONTEXT,
      JSON.stringify({
        v: 1,
        label: "Old restored label",
        timezone: "Europe/London",
      }),
    );
    render(protectedTree(addDialog()));
    await waitFor(() => expect(label().value).toBe("Old restored label"));
    const held = holdDiscards();
    fireEvent.click(screen.getByRole("button", { name: "Discard instead" }));
    await waitFor(() => expect(held.entered()).toBe(true));
    fireEvent.change(label(), { target: { value: "Newer deliberate label" } });
    expect(label().value).toBe("Newer deliberate label");
    await act(async () => {
      await held.release();
    });
    await waitFor(() => expect(store().discard).toHaveBeenCalled());
    expect(label().value).toBe("Newer deliberate label");
  });

  test("CONTROL: a calendar discard with no later edit clears the restored input and its copy", async () => {
    await left(
      ADD_CONTEXT,
      JSON.stringify({
        v: 1,
        label: "Old restored label",
        timezone: "Europe/London",
      }),
    );
    render(protectedTree(addDialog()));
    await waitFor(() => expect(label().value).toBe("Old restored label"));
    fireEvent.click(screen.getByRole("button", { name: "Discard instead" }));
    await waitFor(() => expect(label().value).toBe(""));
    expect(await store().list(ADD_CONTEXT)).toHaveLength(0);
  });
});

describe("Q1 R40-B: choosing another saved copy after the automatic restore", () => {
  test("explicit restore of the other saved record amount replaces the automatically restored amount", async () => {
    const row = await rowFor();
    for (const [id, amount, time] of [
      ["older-tab", "12", "2026-10-25T10:00:00Z"],
      ["newer-tab", "7", "2026-10-25T11:00:00Z"],
    ] as const)
      expect(
        await store().save({
          formContext: `record:${row.progressId}`,
          tabInstanceId: id,
          values: { model: JSON.stringify({ v: 1, mode: "amount", amount }) },
          savedAt: time,
          capture: id,
        }),
      ).toBe("saved");
    const record = vi.fn<TaskActions["record"]>();
    render(
      protectedTree(
        <RecordCard
          row={row}
          actions={{ record }}
          now={Date.now()}
          zone="UTC"
          writable
        />,
      ),
    );
    const amount = () =>
      screen.getByLabelText(`${RECORD_COPY.amount} (cups)`) as HTMLInputElement;
    await waitFor(() => expect(amount().value).toBe("7"));
    const restore = screen.getByRole("button", {
      name: /Restore the copy saved/,
    });
    expect(restore).toBeEnabled();
    fireEvent.click(restore);
    await waitFor(() => expect(amount().value).toBe("12"));
    expect(record).not.toHaveBeenCalled();
  });

  test("CONTROL: calendar explicit choice works between the same two gone-tab copies", async () => {
    for (const [id, text, time] of [
      ["older-tab", "Older choice", "2026-10-25T10:00:00Z"],
      ["newer-tab", "Newer choice", "2026-10-25T11:00:00Z"],
    ] as const)
      expect(
        await store().save({
          formContext: ADD_CONTEXT,
          tabInstanceId: id,
          values: {
            model: JSON.stringify({
              v: 1,
              label: text,
              timezone: "Europe/London",
            }),
          },
          savedAt: time,
          capture: id,
        }),
      ).toBe("saved");
    render(protectedTree(addDialog()));
    await waitFor(() => expect(label().value).toBe("Newer choice"));
    fireEvent.click(
      screen.getByRole("button", { name: /Restore the copy saved/ }),
    );
    await waitFor(() => expect(label().value).toBe("Older choice"));
  });
});

describe("Q3: the other saved copy chosen after the automatic restore, in the remaining owner classes", () => {
  test("the occurrence correction (correction-owner): the older copy chosen replaces the restored state; nothing is saved", async () => {
    const row = await rowFor();
    const state = (minimum: string) =>
      JSON.stringify({
        v: 1,
        state: {
          minimum,
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
      });
    await left(`occurrence-correction:${row.id}`, state("11"), {
      tab: "older-tab",
      savedAt: "2026-10-25T10:00:00.000Z",
    });
    await left(`occurrence-correction:${row.id}`, state("22"), {
      tab: "newer-tab",
      savedAt: "2026-10-25T11:00:00.000Z",
    });
    const enqueue = vi.fn<TaskActions["enqueue"]>();
    render(
      protectedTree(
        <CorrectionDialog
          row={row}
          identity={`${ME}:1`}
          open
          onClose={() => undefined}
          actions={{ enqueue }}
          progressIds={[row.progressId]}
          writable
        />,
      ),
    );
    const minimum = () =>
      within(screen.getByRole("dialog")).getByLabelText(
        CORRECTION_COPY.minimum,
      ) as HTMLInputElement;
    await waitFor(() => expect(minimum().value).toBe("22"));
    fireEvent.click(
      screen.getByRole("button", {
        name: RESTORE_COPY("2026-10-25T10:00:00.000Z"),
      }),
    );
    await waitFor(() => expect(minimum().value).toBe("11"));
    expect(enqueue).not.toHaveBeenCalled();
  });

  test("a household invite (WEB-12b's Invitations dialog; M-1, page-memory owner): the older copy chosen after the person typed replaces it; nothing is sent", async () => {
    const api = fakeHouseholdApi();
    api.defaults.households = ok([
      homeOf({
        members: [{ account_id: SHARING_ME, username: "me", role: "manager" }],
      }),
    ]);
    for (const [tab, text, savedAt] of [
      ["older-tab", "older-user", "2026-10-25T10:00:00.000Z"],
      ["newer-tab", "newer-user", "2026-10-25T11:00:00.000Z"],
    ] as const)
      await left(
        `household-invite:${HOME_ID}`,
        JSON.stringify({ v: 1, text }),
        {
          tab,
          savedAt,
        },
      );
    mountHouseholds(`/sharing/households/${HOME_ID}/invitations`, {
      env: withRecovery(stubEnv()),
      api,
    });
    const invitee = () =>
      screen.getByLabelText(householdsCopy.USERNAME_LABEL) as HTMLInputElement;
    await waitFor(() => expect(invitee().value).toBe("newer-user"));
    // The person types, then chooses the older copy: the choice is the later act (it needs no untouched input).
    fireEvent.change(invitee(), { target: { value: "typed-user" } });
    fireEvent.click(
      screen.getByRole("button", {
        name: RESTORE_COPY("2026-10-25T10:00:00.000Z"),
      }),
    );
    await waitFor(() => expect(invitee().value).toBe("older-user"));
    expect(api.sentCommands).toEqual([]);
    expect(api.count("lookup")).toBe(0);
  });
});
