import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import * as calendarCopy from "../../src/features/calendars/copy";
import { LINK_CONTEXT } from "../../src/features/calendars/LinkCalendarDialog";
import {
  encodeManage,
  manageContext,
} from "../../src/features/calendars/recovery";
import { forgetKeptFixes } from "../../src/features/tasks/detail/EntryHistory";
import { forgetTaskMemory } from "../../src/features/tasks/memory";
import { forgetRecoverableEditors } from "../../src/lib/form-recovery/editor";
import type { FormRecoveryPort } from "../../src/lib/form-recovery/port";
import { RESTORED_TEXT } from "../../src/lib/form-recovery/RecoveryBanner";
import { RESTORE_COPY } from "../../src/lib/form-recovery/RecoveryNotice";
import {
  flushDirty,
  pageFormRegistry,
} from "../../src/lib/form-recovery/registry";
import { installMatchMedia } from "../helpers/match-media";
import { calendarWorld, sourceRow } from "../support/calendars";
import {
  forgetRecoveryWorld,
  holdPinnedDiscards,
  installRecoveryLocks,
} from "../support/recovery-editors";
import {
  entry,
  entryId,
  fix,
  forms,
  journalOf,
  mountWith,
  records,
  SLOW,
  type,
  valueInput,
} from "../support/tasks/journal";

/**
 * WEB-14a revision 38 (review of revision 37, R40-A/R40-B; design assessment C2-C3, I3-I5, I11, Q2/Q3/Q5): the editors a SCREEN opens on a
 * copy left by the page before an update (a dialog is not open after a reload), over the PRODUCTION data env and form-recovery port
 * (`data/ports/form-recovery.ts` over the IndexedDB double), the page's real registry and a Web Locks double:
 *
 *  - the calendar screen's hosts open Manage and Link on the copy; "Discard instead" whose removal is held while the person types newer
 *    input keeps that input (S1), the ordinary discard clears the copy, and a connection's secret is never part of a copy;
 *  - the task detail's entry history parks a restored fix and opens it on its entry; "Discard instead" with its removal held while the
 *    person opens another fix and types keeps that fix (S1); and the person may choose the other saved copy after the automatic restore
 *    (S3), which replaces the fix the history held, never sent.
 */
installMatchMedia({ width: 1440 });
beforeAll(installRecoveryLocks);
afterEach(async () => {
  forgetRecoveryWorld();
  forgetTaskMemory();
  await new Promise((resolve) => setTimeout(resolve, 0));
});

/** A copy a tab that has gone left, written through the production port (as another page of this account wrote it). */
async function leftThrough(
  port: FormRecoveryPort,
  formContext: string,
  text: string,
  tab = "gone-tab",
  savedAt = new Date().toISOString(),
): Promise<void> {
  expect(
    await port.save({
      formContext,
      tabInstanceId: tab,
      values: { model: text },
      savedAt,
      capture: `${tab}-capture`,
    }),
  ).toBe("saved");
}
async function copiesOf(
  port: FormRecoveryPort,
  context: string,
): Promise<string[]> {
  return (await port.list(context)).map((copy) => copy.values.model ?? "");
}

describe("calendar Manage, opened by its row's host (ManageSourceDialog.tsx, SourceRow.tsx)", () => {
  const SOURCE = "00000000-0000-4000-8000-0000000000a1";
  const CONTEXT = manageContext(SOURCE);
  async function restored() {
    const w = await calendarWorld({ cache: [sourceRow({ id: SOURCE })] });
    await leftThrough(
      w.env.formRecovery,
      CONTEXT,
      encodeManage({ timezone: "Asia/Tokyo", enabled: null }),
    );
    // The next page: no editor model yet; the row's host looks and opens Manage on the copy.
    forgetRecoverableEditors();
    await w.remount();
    const timezone = () =>
      within(screen.getByRole("dialog")).getByRole("combobox", {
        name: calendarCopy.TIMEZONE,
      }) as HTMLInputElement;
    await waitFor(() => expect(timezone().value).toBe("Asia/Tokyo"));
    expect(
      screen.queryByText(RESTORED_TEXT, { selector: "p" }),
      "Manage shows the restored copy",
    ).not.toBeNull();
    return { w, timezone };
  }

  test(
    "S1: a timezone typed after Discard instead survives the late removal, on screen and in the model",
    SLOW,
    async () => {
      const { w, timezone } = await restored();
      const held = holdPinnedDiscards(w.env.formRecovery);
      fireEvent.click(screen.getByRole("button", { name: "Discard instead" }));
      await waitFor(() => expect(held.entered()).toBe(true));
      fireEvent.change(timezone(), { target: { value: "Europe/Paris" } });
      await act(async () => {
        await held.release();
      });
      await w.settle();
      expect(timezone().value).toBe("Europe/Paris");
      expect(await flushDirty(pageFormRegistry)).not.toContain("failed");
      expect(
        (await copiesOf(w.env.formRecovery, CONTEXT)).map((t) => JSON.parse(t)),
      ).toContainEqual({ v: 1, timezone: "Europe/Paris", enabled: null });
    },
  );

  test(
    "CONTROL: with no newer input the discard shows the source's timezone and removes the copy",
    SLOW,
    async () => {
      const { w, timezone } = await restored();
      fireEvent.click(screen.getByRole("button", { name: "Discard instead" }));
      expect(timezone().value).toBe("Europe/Vienna");
      await w.settle();
      expect(await copiesOf(w.env.formRecovery, CONTEXT)).toEqual([]);
    },
  );
});

describe("calendar Link, opened by the screen's host (LinkCalendarDialog.tsx, CalendarSources.tsx)", () => {
  async function restored() {
    const w = await calendarWorld();
    await leftThrough(
      w.env.formRecovery,
      LINK_CONTEXT,
      JSON.stringify({ v: 1, label: "Club fixtures", timezone: "UTC" }),
    );
    forgetRecoverableEditors();
    await w.remount();
    const label = () =>
      within(screen.getByRole("dialog")).getByRole("textbox", {
        name: calendarCopy.LABEL,
      }) as HTMLInputElement;
    const url = () =>
      within(screen.getByRole("dialog")).getByLabelText(
        calendarCopy.URL_LABEL,
      ) as HTMLInputElement;
    await waitFor(() => expect(label().value).toBe("Club fixtures"));
    expect(
      screen.queryByText(RESTORED_TEXT, { selector: "p" }),
      "Link shows the restored copy",
    ).not.toBeNull();
    return { w, label, url };
  }

  test(
    "S1: a label typed after Discard instead survives the late removal; the feed URL typed is kept and never in a copy",
    SLOW,
    async () => {
      const { w, label, url } = await restored();
      fireEvent.change(url(), {
        target: { value: "https://secret.example/feed.ics?token=SENTINEL" },
      });
      const held = holdPinnedDiscards(w.env.formRecovery);
      fireEvent.click(screen.getByRole("button", { name: "Discard instead" }));
      await waitFor(() => expect(held.entered()).toBe(true));
      fireEvent.change(label(), { target: { value: "Newer label" } });
      await act(async () => {
        await held.release();
      });
      await w.settle();
      expect(label().value).toBe("Newer label");
      expect(url().value).toBe(
        "https://secret.example/feed.ics?token=SENTINEL",
      );
      expect(await flushDirty(pageFormRegistry)).not.toContain("failed");
      const copies = await copiesOf(w.env.formRecovery, LINK_CONTEXT);
      expect(copies.map((t) => JSON.parse(t))).toContainEqual({
        v: 1,
        label: "Newer label",
        timezone: expect.any(String),
      });
      expect(copies.join("")).not.toContain("SENTINEL");
    },
  );

  test(
    "CONTROL: with no newer input the discard clears the label and removes the copy; nothing is linked",
    SLOW,
    async () => {
      const { w, label } = await restored();
      fireEvent.click(screen.getByRole("button", { name: "Discard instead" }));
      expect(label().value).toBe("");
      await w.settle();
      expect(await copiesOf(w.env.formRecovery, LINK_CONTEXT)).toEqual([]);
      expect(w.calls.filter((call) => call.method === "POST")).toEqual([]);
    },
  );
});

describe("a fix of an entry, parked and opened by the entry history (EntryHistory.tsx)", () => {
  /** A 20-entry journal, entry 20 recent (fixable now): its history restores a fix copy left for its stream. */
  async function restored(copies: Array<[string, string, string]>) {
    const j = await mountWith(() => journalOf(20), [entry(20)]);
    const context = `entry-fix:${j.task.progressId}`;
    for (const [tab, amount, savedAt] of copies)
      await leftThrough(
        j.t.data.formRecovery,
        context,
        JSON.stringify({ v: 1, entry: entryId(20), amount }),
        tab,
        savedAt,
      );
    // The next page: no fix model yet; the history looks for what was left to its stream.
    forgetKeptFixes();
    j.t.remount();
    await j.t.until(() => valueInput() !== null);
    expect(valueInput(), "the history opened the restored fix").not.toBeNull();
    return { ...j, context };
  }

  test(
    "S1: a fix opened and typed after Discard instead survives the late removal",
    SLOW,
    async () => {
      const j = await restored([["gone-tab", "777", new Date().toISOString()]]);
      expect(valueInput()?.value).toBe("777");
      const held = holdPinnedDiscards(j.t.data.formRecovery);
      fireEvent.click(screen.getByRole("button", { name: "Discard instead" }));
      await waitFor(() => expect(held.entered()).toBe(true));
      // The discard took the restored fix at the gesture; the person opens a fix again and types.
      expect(forms()).toHaveLength(0);
      await fix(j.t, 20);
      await type(j.t, "888");
      await act(async () => {
        await held.release();
      });
      await j.t.settle();
      expect(forms()).toHaveLength(1);
      expect(valueInput()?.value).toBe("888");
      expect(records(j.t)).toHaveLength(0);
    },
  );

  test(
    "CONTROL: with no newer input the discard closes the restored fix and removes its copy; nothing is recorded",
    SLOW,
    async () => {
      const j = await restored([["gone-tab", "777", new Date().toISOString()]]);
      fireEvent.click(screen.getByRole("button", { name: "Discard instead" }));
      expect(forms()).toHaveLength(0);
      await j.t.settle();
      expect(await copiesOf(j.t.data.formRecovery, j.context)).toEqual([]);
      expect(records(j.t)).toHaveLength(0);
    },
  );

  /** WEB-14a revision 51 (F-R51-1): "Discard instead" used from the keyboard (focused when pressed; jsdom does not focus on click). */
  function keyboardDiscard(): void {
    const button = screen.getByRole("button", { name: "Discard instead" });
    button.focus();
    expect(button, "the control: Discard instead has focus").toHaveFocus();
    fireEvent.click(button);
  }
  const history = () =>
    document.querySelector("[data-entry-history]") as HTMLElement;
  const fixButtonOf = (n: number) =>
    within(
      history().querySelector(`[data-entry="${entryId(n)}"]`) as HTMLElement,
    ).getByRole("button", { name: "Fix this entry" });

  test(
    "revision 51 (F-R51-1, decision D1): the opened restored fix focuses its new value; a keyboard discard closes it and focus goes to that entry's Fix this entry",
    SLOW,
    async () => {
      const j = await restored([["gone-tab", "777", new Date().toISOString()]]);
      expect(valueInput()?.value).toBe("777");
      await waitFor(() => expect(valueInput()).toHaveFocus());
      keyboardDiscard();
      await j.t.settle();
      expect(forms()).toHaveLength(0);
      expect(fixButtonOf(20), "the entry's surviving control").toHaveFocus();
      expect(records(j.t)).toHaveLength(0);
    },
  );

  test(
    "revision 51, decision D1: a restored fix PARKED (its entry cannot be fixed by me now) opens nothing; focus goes to the history's heading, and stays there after a keyboard discard",
    SLOW,
    async () => {
      const other = "99999999-9999-4999-8999-999999999999";
      const mine = (n: number) => entry(n, { recorded_by: other });
      const j = await mountWith(
        () => journalOf(19).concat(mine(20)),
        [mine(20)],
      );
      const context = `entry-fix:${j.task.progressId}`;
      await leftThrough(
        j.t.data.formRecovery,
        context,
        JSON.stringify({ v: 1, entry: entryId(20), amount: "777" }),
      );
      forgetKeptFixes();
      j.t.remount();
      await j.t.until(
        () => !!history()?.querySelector('[data-recovery-state="restored"]'),
      );
      expect(forms(), "a parked fix opens no editor").toHaveLength(0);
      const heading = within(history()).getByRole("heading");
      await waitFor(() => expect(heading).toHaveFocus());
      keyboardDiscard();
      await j.t.settle();
      expect(
        history().querySelector('[data-recovery-state="restored"]'),
      ).toBeNull();
      expect(within(history()).getByRole("heading")).toHaveFocus();
      expect(forms()).toHaveLength(0);
      expect(records(j.t)).toHaveLength(0);
    },
  );

  test(
    "S3: after the automatic restore, the other saved copy chosen replaces the fix the history holds; nothing is recorded",
    SLOW,
    async () => {
      const j = await restored([
        ["older-tab", "111", "2026-10-25T10:00:00.000Z"],
        ["newer-tab", "222", "2026-10-25T11:00:00.000Z"],
      ]);
      expect(valueInput()?.value).toBe("222");
      fireEvent.click(
        screen.getByRole("button", {
          name: RESTORE_COPY("2026-10-25T10:00:00.000Z"),
        }),
      );
      await j.t.settle();
      expect(valueInput()?.value).toBe("111");
      expect(forms()).toHaveLength(1);
      expect(records(j.t)).toHaveLength(0);
    },
  );
});
