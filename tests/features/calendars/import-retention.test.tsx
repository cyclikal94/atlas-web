import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { DraftRow } from "../../../src/data";
import { invalidateOperation } from "../../../src/data/model/retry";
import * as observations from "../../../src/data/ui/page-cache-observer";
import * as copy from "../../../src/features/calendars/copy";
import { SHOW_NEXT_CALENDARS } from "../../../src/features/calendars/copy-anchor";
import * as words from "../../../src/features/calendars/copy-import";
import { deviceToday } from "../../../src/features/calendars/ImportDialog";
import { subscribeImports } from "../../../src/features/calendars/import-kept";
import { IMPORT_ENDPOINT } from "../../../src/features/calendars/model/commands";
import { defaultWindow } from "../../../src/features/calendars/model/import";
import { installMatchMedia } from "../../helpers/match-media";
import { calendarWorld, sourceRow } from "../../support/calendars";
import { draftRow } from "../../support/data/rows";

/**
 * WEB-13b revision 6 (review 6 R7; design assessment I1-I13; ia.md §1.3.3, the J2 dialog rule): the import dialog's in-dialog sync
 * control RETAINS what the person chose (the file and its check, the source, the raw window, what the last save said, a read or a save
 * still under way), closes, and navigates to the sync screens; Back and opening Import events again show it. Cancel, Escape and the
 * close icon discard. Through the PRODUCTION router (`/sync`, `tab` queue or conflicts, as the protected tree navigates), controller,
 * plans and outbox facade over the double of IndexedDB. FIXTURE evidence (jsdom): the native counterpart is
 * `fixture.calendar-import.spec.ts` (E-IMP6).
 */
installMatchMedia({ width: 1440 });
const present = (element: HTMLElement | null): HTMLElement => {
  expect(element).not.toBeNull();
  return element as HTMLElement;
};
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await new Promise((resolve) => setTimeout(resolve, 0));
});

const ICS =
  "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:bin@example\r\nDTSTART;VALUE=DATE:20261101\r\nSUMMARY:Bin day\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
type World = Awaited<ReturnType<typeof calendarWorld>>;
const ROW = "Import events into Family calendar";

/**
 * The dialog shown now, waited for as an ASSERTION (revision 8): a dialog that never appears, or closes at once, fails the expectation
 * instead of throwing a query error (the merged mutation runner treats an error beside the expected assertion as an invalid run).
 */
async function shownDialog(): Promise<HTMLElement> {
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeNull());
  return screen.queryByRole("dialog") as HTMLElement;
}

async function openRow(w: World, name = ROW): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole("button", { name }));
  const dialog = await shownDialog();
  await w.settle();
  return dialog;
}

const fileInput = (dialog: HTMLElement) =>
  present(dialog.querySelector('input[type="file"]')) as HTMLInputElement;

async function choose(
  w: World,
  dialog: HTMLElement,
  text: string,
  name = "retained.ics",
) {
  const file = new File([text], name, { type: "text/calendar" });
  await act(async () => {
    fireEvent.change(fileInput(dialog), { target: { files: [file] } });
  });
  await w.settle();
}

/**
 * The file the dialog shows, or null. Q-1 (WEB-13b maintenance merge of accepted main; family `mutant-oracle-throws-before-asserting`):
 * a `toContain` on it is written `expect(shownFile(d) ?? "")`, so that a missing file fails by a comparison, not by chai's argument check
 * on `null`, which main's unit-mutation runner admits only as an error beside the assertion (MU-5110, MU-5111, MU-5112 tainted). Each such
 * assertion fails in exactly the cases it failed before.
 */
const shownFile = (dialog: HTMLElement) =>
  dialog.querySelector("[data-import-file]")?.textContent ?? null;
const field = (dialog: HTMLElement, label: "From" | "Through") =>
  within(dialog).getByLabelText(label) as HTMLInputElement;
const setField = (
  dialog: HTMLElement,
  label: "From" | "Through",
  value: string,
) => fireEvent.change(field(dialog, label), { target: { value } });

/** The in-dialog sync control (`Dialog`'s header chip). */
async function syncFrom(w: World, dialog: HTMLElement) {
  fireEvent.click(present(dialog.querySelector("button[data-sync-tone]")));
  await w.settle();
}

/** What the dialog shows: the file summary, the raw window, the queued drafts. */
const seen = (w: World, dialog: HTMLElement) => ({
  file: shownFile(dialog),
  from: field(dialog, "From").value,
  through: field(dialog, "Through").value,
  drafts: w.rows("drafts").length,
});

async function edited(w: World) {
  const dialog = await openRow(w);
  await choose(w, dialog, ICS);
  await waitFor(() =>
    expect(shownFile(dialog) ?? "").toContain("retained.ics"),
  );
  setField(dialog, "From", "2026-01-01");
  setField(dialog, "Through", "2026-12-31");
  return dialog;
}

describe("R7: the in-dialog sync control keeps the import (I1, I2)", () => {
  for (const tab of ["queue", "conflicts"] as const)
    test(`I1/I2: chosen file and edited window, sync control to the ${tab} tab, Back, Import events again: everything is shown again; nothing stored or sent`, async () => {
      const w = await calendarWorld({
        cache: [sourceRow()],
        online: false,
        productionSync: true,
        ...(tab === "conflicts"
          ? {
              syncModel: {
                phase: "synced" as const,
                pendingCount: 0,
                conflictCount: 1,
              },
            }
          : {}),
      });
      const dialog = await edited(w);
      await syncFrom(w, dialog);
      // The production route and its screen, not a guessed address.
      expect(w.path()).toBe("/sync");
      expect(new URLSearchParams(window.location.search).get("tab")).toBe(tab);
      expect(
        await screen.findByRole("heading", { level: 1, name: "Sync" }),
      ).toBeInTheDocument();
      expect(screen.queryByRole("dialog")).toBeNull();
      await w.traverse(-1);
      expect(w.path()).toBe("/settings/calendars");
      const again = await openRow(w);
      expect(seen(w, again)).toEqual({
        file: expect.stringContaining("retained.ics"),
        from: "2026-01-01",
        through: "2026-12-31",
        drafts: 0,
      });
      expect(w.calls.filter((call) => call.method === "POST")).toEqual([]);
    });

  test("I1 control: Cancel discards (a new dialog has no file and the default window)", async () => {
    const w = await calendarWorld({
      cache: [sourceRow()],
      online: false,
      productionSync: true,
    });
    const dialog = await edited(w);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await w.settle();
    const again = await openRow(w);
    const now = seen(w, again);
    expect(now.file).toBeNull();
    expect(now.from).not.toBe("2026-01-01");
    expect(now.through).not.toBe("2026-12-31");
    expect(now.drafts).toBe(0);
  });

  for (const how of ["Escape", "the close icon"] as const)
    test(`I1 control: ${how} discards like Cancel`, async () => {
      const w = await calendarWorld({
        cache: [sourceRow()],
        online: false,
        productionSync: true,
      });
      const dialog = await edited(w);
      if (how === "Escape") fireEvent.keyDown(dialog, { key: "Escape" });
      else
        fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
      await w.settle();
      expect(screen.queryByRole("dialog")).toBeNull();
      const again = await openRow(w);
      expect(shownFile(again)).toBeNull();
      expect(field(again, "From").value).not.toBe("2026-01-01");
    });

  test("I1 control: the dialog left open keeps its file and window", async () => {
    const w = await calendarWorld({
      cache: [sourceRow()],
      online: false,
      productionSync: true,
    });
    const dialog = await edited(w);
    await w.settle();
    expect(seen(w, dialog)).toEqual({
      file: expect.stringContaining("retained.ics"),
      from: "2026-01-01",
      through: "2026-12-31",
      drafts: 0,
    });
  });
});

const drafts = (w: World) => w.rows("drafts") as DraftRow[];
const bodyOf = (w: World, id: string) =>
  (
    w.rows("draft_commands") as Array<{ local_id: string; command: unknown }>
  ).find((row) => row.local_id === id)?.command;
const announced = () =>
  document.querySelector('[aria-live="polite"]')?.textContent ?? "";
const press = (dialog: HTMLElement, name: string) =>
  fireEvent.click(within(dialog).getByRole("button", { name }));

/** The facade's next enqueue: stored (or answered) at once, its answer held until `release`. */
function holdEnqueue(
  w: World,
  answer?: () => Promise<{ kind: "refused"; reason: "quota" | "denied" }>,
) {
  const outbox = w.env.outbox();
  if (outbox === null) throw new Error("no outbox");
  const original = outbox.enqueue.bind(outbox);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const keys: string[] = [];
  const spy = vi.spyOn(outbox, "enqueue");
  spy.mockImplementationOnce(async (request) => {
    keys.push(request.localId ?? "");
    const outcome =
      answer === undefined ? await original(request) : await answer();
    await gate;
    return outcome;
  });
  return { release, spy, keys };
}

/** A file whose read completes when the test says. */
function heldFile(text: string, name: string) {
  let deliver!: () => void;
  const bytes = new Promise<ArrayBuffer>((resolve) => {
    deliver = () => resolve(new TextEncoder().encode(text).buffer);
  });
  const file = new File([text], name, { type: "text/calendar" });
  Object.defineProperty(file, "arrayBuffer", { value: () => bytes });
  return { file, deliver };
}

async function toSyncAndBack(w: World, dialog: HTMLElement) {
  await syncFrom(w, dialog);
  expect(w.path()).toBe("/sync");
  await w.traverse(-1);
  expect(w.path()).toBe("/settings/calendars");
}

const world = (over: Parameters<typeof calendarWorld>[0] = {}) =>
  calendarWorld({
    cache: [sourceRow()],
    online: false,
    productionSync: true,
    ...over,
  });

describe("R7: what goes on while the import is kept (I5, I8-I11)", () => {
  test("I5: a read still under way when the sync control is used settles while away; Back shows the file read; nothing stored by itself", async () => {
    const w = await world();
    const dialog = await openRow(w);
    const held = heldFile(ICS, "slow.ics");
    await act(async () => {
      fireEvent.change(fileInput(dialog), { target: { files: [held.file] } });
    });
    await w.settle();
    expect(shownFile(dialog)).toBeNull();
    await syncFrom(w, dialog);
    await act(async () => held.deliver());
    await w.settle();
    await w.traverse(-1);
    const again = await openRow(w);
    expect(shownFile(again) ?? "").toContain("slow.ics");
    expect(within(again).queryByText(words.READING)).toBeNull();
    expect(drafts(w)).toHaveLength(0);
  });

  test("I5: a read delivered after the dialog is shown again settles in it (still reading until then; Import stores nothing meanwhile)", async () => {
    const w = await world();
    const dialog = await openRow(w);
    const held = heldFile(ICS, "slow.ics");
    await act(async () => {
      fireEvent.change(fileInput(dialog), { target: { files: [held.file] } });
    });
    await w.settle();
    await toSyncAndBack(w, dialog);
    const again = await openRow(w);
    // Revision 7: `queryByText` so that a missing message fails this ASSERTION (a throwing `getByText` is an error, which the merged
    // mutation runner rejects beside the expected catch: MU-5110/MU-5111 were invalid). The same requirement: the message is shown.
    expect(within(again).queryByText(words.READING)).not.toBeNull();
    fireEvent.submit(present(again.querySelector("form")));
    await w.settle();
    expect(drafts(w)).toHaveLength(0);
    expect(within(again).queryByText(words.FILE_REQUIRED)).toBeNull();
    await act(async () => held.deliver());
    await w.settle();
    expect(shownFile(again) ?? "").toContain("slow.ics");
  });

  for (const order of ["while away", "after it is shown again"] as const)
    test(`I8: a save stored before the sync control, answered ${order}: one import, one key, the unchanged session consumed (no stale closer)`, async () => {
      const w = await world();
      const dialog = await edited(w);
      const held = holdEnqueue(w);
      press(dialog, words.IMPORT);
      await w.settle();
      expect(drafts(w)).toHaveLength(1);
      await syncFrom(w, dialog);
      if (order === "while away") {
        await act(async () => held.release());
        await w.settle();
        await w.traverse(-1);
        const again = await openRow(w);
        // Consumed: a new session (no file, the default window).
        expect(shownFile(again)).toBeNull();
        expect(field(again, "From").value).not.toBe("2026-01-01");
      } else {
        await w.traverse(-1);
        const again = await openRow(w);
        expect(
          within(again).getByRole("button", { name: words.IMPORT }),
        ).toBeDisabled();
        await act(async () => held.release());
        await w.settle();
        expect(screen.queryByRole("dialog")).toBeNull();
      }
      expect(announced()).toContain(words.IMPORT_QUEUED);
      expect(drafts(w)).toHaveLength(1);
      expect(held.spy).toHaveBeenCalledTimes(1);
      expect(bodyOf(w, drafts(w)[0]?.local_id as string)).toMatchObject({
        from: "2026-01-01",
        through: "2026-12-31",
      });
    });

  test("I9: newer input made before the sync control while the save is held: kept and said to be newer; Import again is a NEW import", async () => {
    const w = await world();
    const dialog = await edited(w);
    const held = holdEnqueue(w);
    press(dialog, words.IMPORT);
    await w.settle();
    setField(dialog, "From", "2026-02-01");
    await syncFrom(w, dialog);
    await act(async () => held.release());
    await w.settle();
    await w.traverse(-1);
    const again = await openRow(w);
    expect(field(again, "From").value).toBe("2026-02-01");
    expect(within(again).getByText(words.IMPORT_QUEUED_NEWER)).toBeVisible();
    const first = drafts(w)[0] as DraftRow;
    press(again, words.IMPORT);
    await w.settle();
    expect(drafts(w)).toHaveLength(2);
    const second = drafts(w).find((d) => d.local_id !== first.local_id);
    expect(bodyOf(w, first.local_id)).toMatchObject({ from: "2026-01-01" });
    expect(bodyOf(w, second?.local_id as string)).toMatchObject({
      from: "2026-02-01",
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("I10: a refusal answered while away is shown on return with the input; the same choices pressed again reuse the save's identity", async () => {
    const w = await world();
    const dialog = await edited(w);
    const held = holdEnqueue(w, async () => ({
      kind: "refused",
      reason: "quota",
    }));
    press(dialog, words.IMPORT);
    await w.settle();
    await syncFrom(w, dialog);
    await act(async () => held.release());
    await w.settle();
    await w.traverse(-1);
    const again = await openRow(w);
    expect(seen(w, again)).toEqual({
      file: expect.stringContaining("retained.ics"),
      from: "2026-01-01",
      through: "2026-12-31",
      drafts: 0,
    });
    expect(
      within(again).getByRole("button", { name: words.IMPORT }),
    ).toBeEnabled();
    expect(within(again).getByText(copy.NOT_SAVED_QUOTA)).toBeVisible();
    press(again, words.IMPORT);
    await w.settle();
    expect(drafts(w)).toHaveLength(1);
    expect(drafts(w)[0]?.local_id).toBe(held.keys[0]);
  });

  test("I11: Cancel while a save is held, then the same row again: a new session; the old answer closes, changes and spends nothing of it", async () => {
    const w = await world();
    const dialog = await edited(w);
    const held = holdEnqueue(w);
    press(dialog, words.IMPORT);
    await w.settle();
    press(dialog, "Cancel");
    await w.settle();
    const again = await openRow(w);
    await choose(w, again, ICS, "next.ics");
    setField(again, "From", "2026-03-01");
    await act(async () => held.release());
    await w.settle();
    expect(screen.queryByRole("dialog")).toBe(again);
    expect(shownFile(again) ?? "").toContain("next.ics");
    expect(field(again, "From").value).toBe("2026-03-01");
    expect(within(again).queryByText(words.IMPORT_QUEUED_NEWER)).toBeNull();
    // Cancel is not a roll-back: the stored import stays, and is said to be.
    expect(drafts(w)).toHaveLength(1);
    expect(announced()).toContain(words.IMPORT_QUEUED);
    press(again, words.IMPORT);
    await w.settle();
    expect(drafts(w)).toHaveLength(2);
    expect(new Set(drafts(w).map((d) => d.local_id)).size).toBe(2);
  });
});

describe("R7: entries and current source facts (I3, I4)", () => {
  const PENDING = "00000000-0000-4000-8000-0000000000b9";
  const pendingCreate = () =>
    draftRow({
      local_id: "create-1",
      endpoint: "/calendar-commands",
      command: {
        command: {
          kind: "create_source",
          id: PENDING,
          label: "Weekend chores",
          timezone: "UTC",
        },
      },
      target_resource_ids: [PENDING],
      index_targets: [PENDING],
    });

  test("I3: a pending source's import kept while its create is published: the same session on return, its source now cached, imported into it", async () => {
    const w = await world({ drafts: [pendingCreate()] });
    const dialog = await openRow(w, "Import events into Weekend chores");
    await choose(w, dialog, ICS);
    setField(dialog, "From", "2026-01-01");
    await toSyncAndBack(w, dialog);
    await syncFrom(w, await openRow(w, "Import events into Weekend chores"));
    // While away, the create is published: the source is cached and the pending draft retired.
    await w.commit({
      put: {
        store: "cache",
        rows: [sourceRow({ id: PENDING, label: "Weekend chores" })],
      },
      retire: ["create-1"],
    });
    await w.traverse(-1);
    const again = await openRow(w, "Import events into Weekend chores");
    expect(shownFile(again) ?? "").toContain("retained.ics");
    expect(field(again, "From").value).toBe("2026-01-01");
    press(again, words.IMPORT);
    await w.settle();
    const stored = drafts(w);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ target_id: PENDING });
  });

  test("I3 control: a cached source that leaves the cache while away is gone on return: Import is unavailable, the choice is not moved to another source", async () => {
    const w = await world({
      cache: [
        sourceRow(),
        sourceRow({
          id: "00000000-0000-4000-8000-0000000000a2",
          label: "School",
        }),
      ],
    });
    const dialog = await edited(w);
    await syncFrom(w, dialog);
    const kept = sourceRow().id;
    await w.traverse(-1);
    const again = await openRow(w);
    await w.commit({ remove: [kept] });
    expect(again.querySelector("[data-import-source]")?.textContent).toBe("—");
    expect(
      within(again).getByRole("button", { name: words.IMPORT }),
    ).toBeDisabled();
    expect(drafts(w)).toHaveLength(0);
  });

  const many = (count: number) =>
    Array.from({ length: count }, (_, i) =>
      sourceRow({
        id: `00000000-0000-4000-8000-${String(i + 1000).padStart(12, "0")}`,
        label: `Calendar ${String(i).padStart(3, "0")}`,
      }),
    );
  const zoneInput = () =>
    present(
      present(document.querySelector("[data-import-drop]")).querySelector(
        'input[type="file"]',
      ),
    ) as HTMLInputElement;
  const browse = () =>
    present(
      present(document.querySelector("[data-import-drop]")).querySelector(
        "button",
      ),
    );

  test("I4: the drop zone's import (a source on page two, edited dates) kept through the sync control: Browse shows it again without asking for a file", async () => {
    const rows = many(101);
    const w = await world({ cache: rows });
    await screen.findByText(words.DROP_PROMPT);
    await act(async () => {
      fireEvent.change(zoneInput(), {
        target: { files: [new File([ICS], "drop.ics")] },
      });
    });
    await w.settle();
    const dialog = await shownDialog();
    fireEvent.click(
      present(
        within(dialog).queryByRole("button", { name: SHOW_NEXT_CALENDARS }),
      ),
    );
    await w.settle();
    fireEvent.change(within(dialog).getByLabelText(words.SOURCE), {
      target: { value: rows[100]?.id },
    });
    setField(dialog, "Through", "2026-12-31");
    await toSyncAndBack(w, dialog);
    const picker = vi.spyOn(HTMLInputElement.prototype, "click");
    fireEvent.click(browse());
    await w.settle();
    // Asserted, not awaited: Browse must show the dialog itself, never the file picker.
    expect(picker).not.toHaveBeenCalled();
    const again = present(screen.queryByRole("dialog"));
    expect(shownFile(again) ?? "").toContain("drop.ics");
    expect(
      (within(again).getByLabelText(words.SOURCE) as HTMLSelectElement).value,
    ).toBe(rows[100]?.id);
    expect(field(again, "Through").value).toBe("2026-12-31");
    press(again, words.IMPORT);
    await w.settle();
    expect(drafts(w)[0]).toMatchObject({ target_id: rows[100]?.id });
  });

  test("I4: the first source offered is kept as the chooser's when the sync control is used (a later first page does not move it)", async () => {
    const w = await world({
      cache: [
        sourceRow({ label: "B calendar" }),
        sourceRow({
          id: "00000000-0000-4000-8000-0000000000a2",
          label: "C calendar",
        }),
      ],
    });
    await screen.findByText(words.DROP_PROMPT);
    await act(async () => {
      fireEvent.change(zoneInput(), {
        target: { files: [new File([ICS], "drop.ics")] },
      });
    });
    await w.settle();
    const dialog = await shownDialog();
    const first = (
      within(dialog).getByLabelText(words.SOURCE) as HTMLSelectElement
    ).value;
    await syncFrom(w, dialog);
    // While away, a source that sorts first arrives.
    await w.commit({
      put: {
        store: "cache",
        rows: [
          sourceRow({
            id: "00000000-0000-4000-8000-0000000000a0",
            label: "A calendar",
          }),
        ],
      },
    });
    await w.traverse(-1);
    fireEvent.click(browse());
    await w.settle();
    const again = present(screen.queryByRole("dialog"));
    expect(
      (within(again).getByLabelText(words.SOURCE) as HTMLSelectElement).value,
    ).toBe(first);
  });

  test("I4: a file dropped while the drop zone's import is kept is a new file chosen in it (its source and window stay)", async () => {
    const rows = many(3);
    const w = await world({ cache: rows });
    await screen.findByText(words.DROP_PROMPT);
    await act(async () => {
      fireEvent.change(zoneInput(), {
        target: { files: [new File([ICS], "first.ics")] },
      });
    });
    await w.settle();
    const dialog = await shownDialog();
    fireEvent.change(within(dialog).getByLabelText(words.SOURCE), {
      target: { value: rows[2]?.id },
    });
    setField(dialog, "From", "2026-01-01");
    await toSyncAndBack(w, dialog);
    await act(async () => {
      fireEvent.change(zoneInput(), {
        target: { files: [new File([ICS], "second.ics")] },
      });
    });
    await w.settle();
    const again = await shownDialog();
    await waitFor(() => expect(shownFile(again) ?? "").toContain("second.ics"));
    expect(
      (within(again).getByLabelText(words.SOURCE) as HTMLSelectElement).value,
    ).toBe(rows[2]?.id);
    expect(field(again, "From").value).toBe("2026-01-01");
  });

  test("I4 control: with nothing kept (Cancel), Browse opens the file picker and no dialog", async () => {
    const w = await world({ cache: many(2) });
    await screen.findByText(words.DROP_PROMPT);
    await act(async () => {
      fireEvent.change(zoneInput(), {
        target: { files: [new File([ICS], "drop.ics")] },
      });
    });
    await w.settle();
    press(await shownDialog(), "Cancel");
    await w.settle();
    const picker = vi
      .spyOn(HTMLInputElement.prototype, "click")
      .mockImplementation(() => undefined);
    fireEvent.click(browse());
    await w.settle();
    expect(picker).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("I4: a row's kept import is not the drop zone's: Browse opens the picker, and a different row is a new import", async () => {
    const w = await world({
      cache: [
        sourceRow(),
        sourceRow({
          id: "00000000-0000-4000-8000-0000000000a2",
          label: "School",
        }),
      ],
    });
    const dialog = await edited(w);
    await toSyncAndBack(w, dialog);
    const other = await openRow(w, "Import events into School");
    expect(shownFile(other)).toBeNull();
    press(other, "Cancel");
    await w.settle();
    // The row's session ended when the other row was opened.
    const again = await openRow(w);
    expect(shownFile(again)).toBeNull();
  });
});

describe("R7: identity and departures (I12, I13)", () => {
  test("I12: A→B→A while the import is kept at the sync screens: back on A, Import events is a new session", async () => {
    const w = await world();
    const dialog = await edited(w);
    await syncFrom(w, dialog);
    const a = w.identity.get();
    act(() =>
      w.identity.set({
        account_id: "22222222-2222-4222-8222-222222222222",
        epoch: 1,
        session_id: "t",
      }),
    );
    act(() => w.identity.set(a));
    await w.settle();
    await w.traverse(-1);
    const again = await openRow(w);
    expect(shownFile(again)).toBeNull();
    expect(field(again, "From").value).not.toBe("2026-01-01");
  });

  test("I12: a save held across A→B→A is stored once and NOT announced; nothing of it reaches A's new session", async () => {
    const w = await world();
    const dialog = await edited(w);
    const held = holdEnqueue(w);
    press(dialog, words.IMPORT);
    await w.settle();
    await syncFrom(w, dialog);
    const a = w.identity.get();
    act(() =>
      w.identity.set({
        account_id: "22222222-2222-4222-8222-222222222222",
        epoch: 1,
        session_id: "t",
      }),
    );
    act(() => w.identity.set(a));
    await act(async () => held.release());
    await w.settle();
    expect(announced()).not.toContain(words.IMPORT_QUEUED);
    await w.traverse(-1);
    const again = await openRow(w);
    expect(shownFile(again)).toBeNull();
    expect(within(again).queryByText(words.IMPORT_QUEUED_NEWER)).toBeNull();
  });

  test("I12: a database no longer the displayed one (another incarnation) is never saved into: Import ends the session and closes; nothing stored", async () => {
    const w = await world();
    const dialog = await edited(w);
    const real = w.env.service();
    if (real === null) throw new Error("no database");
    vi.spyOn(w.env, "service").mockReturnValue(
      Object.create(real, { incarnationId: { value: "another" } }),
    );
    press(dialog, words.IMPORT);
    await w.settle();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(drafts(w)).toHaveLength(0);
    vi.restoreAllMocks();
    const again = await openRow(w);
    expect(shownFile(again)).toBeNull();
  });

  test("I12 control: the protected tree remounted under the same identity at the sync screens keeps the import", async () => {
    const w = await world();
    const dialog = await edited(w);
    await syncFrom(w, dialog);
    await w.remount();
    await w.traverse(-1);
    const again = await openRow(w);
    expect(seen(w, again)).toMatchObject({
      file: expect.stringContaining("retained.ics"),
      from: "2026-01-01",
    });
  });

  for (const hidden of [true, false])
    test(`I12: the cache ${hidden ? "hidden to be brought up to date" : "(control) left valid"} while the import is kept at the sync screens ${hidden ? "ends" : "keeps"} it`, async () => {
      const w = await world();
      const dialog = await edited(w);
      await syncFrom(w, dialog);
      const valid = (w.snapshot()?.sync_state?.[0] ?? {}) as Record<
        string,
        unknown
      >;
      if (hidden) {
        await w.commit({
          put: {
            store: "sync_state",
            rows: [{ ...valid, cache_status: "invalid" }],
          },
        });
        await w.commit({ put: { store: "sync_state", rows: [valid] } });
      }
      await w.traverse(-1);
      const again = await openRow(w);
      if (hidden) {
        expect(shownFile(again)).toBeNull();
        expect(field(again, "From").value).not.toBe("2026-01-01");
      } else
        expect(seen(w, again)).toMatchObject({
          file: expect.stringContaining("retained.ics"),
          from: "2026-01-01",
        });
    });

  test("I13: leaving the sync screens anywhere but back ends the import (coming back to Calendars later is a new session)", async () => {
    const w = await world();
    const dialog = await edited(w);
    await syncFrom(w, dialog);
    await w.navigate("/settings");
    await w.navigate("/settings/calendars");
    const again = await openRow(w);
    expect(shownFile(again)).toBeNull();
    expect(field(again, "From").value).not.toBe("2026-01-01");
  });

  test("I13 control: a change of only the query, and Forward to the sync screens and Back again, keep the import", async () => {
    const w = await world();
    const dialog = await edited(w);
    await toSyncAndBack(w, dialog);
    await w.write("replace", "/settings/calendars?from=r7");
    await w.traverse(1);
    expect(w.path()).toBe("/sync");
    await w.traverse(-1);
    const again = await openRow(w);
    expect(seen(w, again)).toMatchObject({
      file: expect.stringContaining("retained.ics"),
      from: "2026-01-01",
      through: "2026-12-31",
    });
  });
});

/**
 * WEB-13b revision 7 (review 7 R7, family `task-sync-navigation-draft-loss`, incomplete_fix; design assessment C1-C4, L1/L2): the kept
 * import must keep observing the cache after the protected tree is REPLACED. Production's `DataProvider` disposes its controller at
 * unmount and builds a new one at the next mount, while the page's runtime (the leader's) goes on; the revision 6 owner watched the
 * disposed controller and so missed a later invalidation and recovery. Here: the PRODUCTION provider over the page's runtime
 * (`production: true`, a new controller per mount, the first one disposed), and the PRODUCTION writers of the cache's lifetime: the
 * ordinary-phase invalidation (W18, as a `410 resync_required` makes it), the ownership (W20), the capture (W21) and the activation of
 * the replacement snapshot (W23). The controls pair each case with no remount (the review's 422 control) and with no invalidation.
 * FIXTURE evidence (jsdom); the native counterpart is `fixture.calendar-import.spec.ts` (E-IMP8).
 */
describe("R7 (revision 7): the kept import across a production controller replacement and a cache invalidation (L1, L2)", () => {
  const production = (over: Parameters<typeof calendarWorld>[0] = {}) =>
    world({ production: true, validCache: true, ...over });
  const fresh = defaultWindow(deviceToday());
  /** The import POSTs made (none may be: nothing is imported by keeping or by reopening). */
  const importPosts = (w: World) =>
    w.calls.filter(
      (call) => call.method === "POST" && call.path === IMPORT_ENDPOINT,
    );
  /** The first controller was disposed and the one mounted now is another (what production's remount does). */
  function replaced(w: World) {
    const [first, ...rest] = w.controllers();
    expect(rest.length).toBeGreaterThan(0);
    expect(w.env).not.toBe(first);
    expect(first?.service()).toBeNull();
    expect(first?.cacheLifetime.get()).toBeNull();
    expect(w.env.service()).not.toBeNull();
  }
  /** W18 then W23 (through W20/W21), in the same database: invalid in between, valid again under a later generation. */
  async function invalidateAndRecover(w: World) {
    const before = w.sync();
    await w.invalidate();
    expect(w.sync()).toMatchObject({
      cache_status: "invalid",
      recovery_generation: before.recovery_generation + 1,
    });
    await w.recover([sourceRow()]);
    const after = w.sync();
    expect(after.cache_status).toBe("valid");
    expect(after.recovery_generation).toBeGreaterThan(
      before.recovery_generation,
    );
    return { before, after };
  }

  test("L1: remounted (a NEW controller) at the sync screens, then W18 → W23: back, Import events is a new session (no file, the default window); nothing stored or sent", async () => {
    const w = await production();
    const incarnation = w.env.service()?.incarnationId;
    const dialog = await edited(w);
    await syncFrom(w, dialog);
    await w.remount();
    replaced(w);
    await invalidateAndRecover(w);
    expect(w.env.service()?.incarnationId).toBe(incarnation);
    await w.traverse(-1);
    const again = await openRow(w);
    expect(seen(w, again)).toEqual({
      file: null,
      from: fresh.from,
      through: fresh.through,
      drafts: 0,
    });
    expect(importPosts(w)).toHaveLength(0);
  });

  test("L1: the tree gone (no controller at all) while W18 → W23 complete, then mounted again: back, Import events is a new session", async () => {
    const w = await production();
    const dialog = await edited(w);
    await syncFrom(w, dialog);
    await w.detach();
    await invalidateAndRecover(w);
    await w.attach();
    replaced(w);
    await w.traverse(-1);
    const again = await openRow(w);
    expect(seen(w, again)).toEqual({
      file: null,
      from: fresh.from,
      through: fresh.through,
      drafts: 0,
    });
    expect(importPosts(w)).toHaveLength(0);
  });

  test("L1 control (no remount, the review's 422 control): the same controller throughout, W18 → W23: a new session", async () => {
    const w = await production();
    const dialog = await edited(w);
    await syncFrom(w, dialog);
    await invalidateAndRecover(w);
    expect(w.controllers()).toHaveLength(1);
    await w.traverse(-1);
    const again = await openRow(w);
    expect(seen(w, again)).toEqual({
      file: null,
      from: fresh.from,
      through: fresh.through,
      drafts: 0,
    });
  });

  test("L1 control (no invalidation): remounted (a NEW controller) at the sync screens, back: the SAME session (file and window)", async () => {
    const w = await production();
    const dialog = await edited(w);
    await syncFrom(w, dialog);
    const generation = w.sync().recovery_generation;
    await w.remount();
    replaced(w);
    await w.remount();
    expect(w.controllers().length).toBeGreaterThanOrEqual(3);
    expect(w.sync().recovery_generation).toBe(generation);
    await w.traverse(-1);
    const again = await openRow(w);
    expect(seen(w, again)).toEqual({
      file: expect.stringContaining("retained.ics"),
      from: "2026-01-01",
      through: "2026-12-31",
      drafts: 0,
    });
    expect(importPosts(w)).toHaveLength(0);
  });

  test("L1 control (no invalidation): the tree gone and mounted again: back, the SAME session", async () => {
    const w = await production();
    const dialog = await edited(w);
    await syncFrom(w, dialog);
    await w.detach();
    await w.attach();
    replaced(w);
    await w.traverse(-1);
    const again = await openRow(w);
    expect(seen(w, again)).toMatchObject({
      file: expect.stringContaining("retained.ics"),
      from: "2026-01-01",
      through: "2026-12-31",
    });
  });

  for (const failed of [true, false])
    test(`L5${failed ? "" : " control"}: ${failed ? "an admitted invalidation whose write failed (its durable streak at the cache's position; the cache still says valid, the generation unchanged) ends" : "a failure streak of ANOTHER position (one the cache has moved on from) keeps"} the kept import`, async () => {
      const w = await production();
      const dialog = await edited(w);
      await syncFrom(w, dialog);
      await w.remount();
      const s = w.sync();
      await w.commit({
        put: {
          store: "sync_state",
          rows: [
            {
              ...s,
              local_write_streaks: {
                ...s.local_write_streaks,
                [failed ? `invalidate:${s.cursor}` : "invalidate:delta-old"]: 1,
              },
            },
          ],
        },
      });
      expect(w.sync()).toMatchObject({
        cache_status: "valid",
        recovery_generation: s.recovery_generation,
      });
      // Revision 8: the lifetime names the invalidation witness (unchanged, like the generation: the write failed), not the generation.
      expect(w.env.cacheLifetime.get()).toMatchObject({
        invalidations: s.cache_invalidation_seq ?? 0,
        invalidated: failed,
      });
      // The streak gone again and the generation unchanged: only an observer that saw the known-invalid state can tell (no durable trace).
      await w.commit({ put: { store: "sync_state", rows: [s] } });
      await w.traverse(-1);
      const again = await openRow(w);
      if (failed)
        expect(seen(w, again)).toMatchObject({ file: null, from: fresh.from });
      else
        expect(seen(w, again)).toMatchObject({
          file: expect.stringContaining("retained.ics"),
          from: "2026-01-01",
        });
    });

  const zoneInput = () =>
    present(
      present(document.querySelector("[data-import-drop]")).querySelector(
        'input[type="file"]',
      ),
    ) as HTMLInputElement;
  const browse = () =>
    present(
      present(document.querySelector("[data-import-drop]")).querySelector(
        "button",
      ),
    );
  /** The drop zone's import of `drop.ics` with an edited Through, kept by the sync control. */
  async function droppedAndKept(w: World) {
    await screen.findByText(words.DROP_PROMPT);
    await act(async () => {
      fireEvent.change(zoneInput(), {
        target: { files: [new File([ICS], "drop.ics")] },
      });
    });
    await w.settle();
    const dialog = await shownDialog();
    await waitFor(() => expect(shownFile(dialog) ?? "").toContain("drop.ics"));
    setField(dialog, "Through", "2026-12-31");
    await syncFrom(w, dialog);
  }

  for (const invalidated of [true, false])
    test(`L2: the drop zone's kept import, remounted (a NEW controller)${invalidated ? " then W18 → W23" : " (control: no invalidation)"}: Browse ${invalidated ? "opens the file picker, and no dialog" : "shows the SAME session"}`, async () => {
      const w = await production();
      await droppedAndKept(w);
      await w.remount();
      replaced(w);
      if (invalidated) await invalidateAndRecover(w);
      await w.traverse(-1);
      const picker = vi
        .spyOn(HTMLInputElement.prototype, "click")
        .mockImplementation(() => undefined);
      fireEvent.click(browse());
      await w.settle();
      if (invalidated) {
        expect(picker).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole("dialog")).toBeNull();
        // A file dropped now starts from the default window, not the kept one.
        await act(async () => {
          fireEvent.change(zoneInput(), {
            target: { files: [new File([ICS], "later.ics")] },
          });
        });
        await w.settle();
        const dialog = await shownDialog();
        expect(field(dialog, "Through").value).toBe(fresh.through);
      } else {
        expect(picker).not.toHaveBeenCalled();
        const again = present(screen.queryByRole("dialog"));
        expect(shownFile(again) ?? "").toContain("drop.ics");
        expect(field(again, "Through").value).toBe("2026-12-31");
      }
      expect(drafts(w)).toHaveLength(0);
      expect(importPosts(w)).toHaveLength(0);
    });
});

/**
 * WEB-13b revision 8 (review 8 R7a/R7b; design assessment C1-C3, T1, T2, T7): through the PRODUCTION session, router, protected tree and
 * `DataProvider` (a new controller per mount over the page's runtime) and the real writers W18/W20/W21/W23 over the IndexedDB double.
 *
 *  - R7a: a kept import shown again while NOTHING can verify its basis (the new controller's facts, the page runtime's own observation and
 *    the read made at the showing are all held) WAITS: the person's file and window are shown, its source is not, and nothing is saved
 *    (the button explains; Enter stores nothing). Released unchanged, it is ready; released after a committed invalidation, it closes and
 *    says why (expired), and the next Import events is a new session.
 *  - R7b: review 8's pending-source schedule (an empty cache, the first fill, W18 and a refill while no controller is mounted) maintained,
 *    with its first-fill-only control.
 *  - The dialog of a CACHED source whose cache is only unverified (not read yet, an unreadable marker) waits instead of closing (E9 is for
 *    a cache known to be invalid, its control below).
 */
describe("R7a/R7b (revision 8): the kept import waits for its witness; first fill versus invalidation (production composition)", () => {
  const PENDING = "00000000-0000-4000-8000-0000000000a5";
  const PENDING_ROW = "Import events into Pending calendar";
  const pendingCreate = () =>
    draftRow({
      local_id: "create-1",
      endpoint: "/calendar-commands",
      command: {
        command: {
          kind: "create_source",
          id: PENDING,
          label: "Pending calendar",
          timezone: "UTC",
        },
      },
      target_resource_ids: [PENDING],
      index_targets: [PENDING],
    });
  const fresh = defaultWindow(deviceToday());
  const importDrafts = (w: World) =>
    drafts(w).filter((row) => row.local_id !== "create-1");
  /**
   * Holds every readSyncFacts of the page runtime's service made from now on, while `hold` stands: a live read says "loading" and is not
   * heard, a one-off read is not delivered. `release` lets them all go and tells every live read.
   */
  function holdFacts(w: World) {
    const service = w.env.service();
    expect(service).not.toBeNull();
    // The page runtime's service: every controller of the page, and the kept session's own observation, read through it.
    const real = (service as NonNullable<typeof service>).store as unknown as {
      watch: (
        plan: { name: string },
        input: unknown,
      ) => { get(): unknown; subscribe(listener: () => void): () => void };
      run: (plan: { name: string }, ...rest: unknown[]) => Promise<unknown>;
    };
    const watch = real.watch.bind(real);
    const run = real.run.bind(real);
    let holding = true;
    const listeners = new Set<() => void>();
    const runs: Array<() => void> = [];
    vi.spyOn(real, "watch").mockImplementation((plan, input) => {
      const source = watch(plan, input);
      if (plan.name !== "data.readSyncFacts") return source;
      return {
        get: () => (holding ? { status: "loading" } : source.get()),
        subscribe(listener: () => void) {
          listeners.add(listener);
          const off = source.subscribe(() => {
            if (!holding) listener();
          });
          return () => {
            listeners.delete(listener);
            off();
          };
        },
      };
    });
    vi.spyOn(real, "run").mockImplementation((plan, ...rest) => {
      const result = run(plan, ...rest);
      if (plan.name !== "data.readSyncFacts" || !holding) return result;
      return new Promise((resolve, reject) => {
        runs.push(() => {
          result.then(resolve, reject);
        });
      });
    });
    return {
      held: () => runs.length,
      async release() {
        await act(async () => {
          holding = false;
          for (const go of runs.splice(0)) go();
          for (const listener of [...listeners]) listener();
        });
        await w.settle();
      },
    };
  }
  /** The pending source's import, a file and an edited window, kept by the sync control. */
  async function keptPending(w: World) {
    const dialog = await openRow(w, PENDING_ROW);
    await choose(w, dialog, ICS);
    await waitFor(() =>
      expect(shownFile(dialog) ?? "").toContain("retained.ics"),
    );
    setField(dialog, "From", "2026-01-01");
    setField(dialog, "Through", "2026-12-31");
    await syncFrom(w, dialog);
    expect(w.path()).toBe("/sync");
  }

  for (const invalidated of [false, true])
    test(`R7a: shown again while nothing can verify it, the kept import WAITS (input shown, nothing saved, Enter stores nothing); released ${invalidated ? "after W18 -> W23: it closes, says why, and Import events is a new session" : "unchanged: it is ready with the same input"}`, async () => {
      const w = await calendarWorld({
        production: true,
        productionSync: true,
        validCache: true,
        online: false,
        drafts: [pendingCreate()],
      });
      const facts = holdFacts(w);
      await keptPending(w);
      await w.remount();
      if (invalidated) {
        await w.invalidate();
        await w.recover([]);
        expect(w.sync().cache_status).toBe("valid");
      }
      await w.traverse(-1);
      const dialog = await openRow(w, PENDING_ROW);
      expect(facts.held()).toBeGreaterThan(0);
      // Waiting: the person's input is there, the source is not shown, and nothing can be saved.
      expect(shownFile(dialog) ?? "").toContain("retained.ics");
      expect(field(dialog, "From").value).toBe("2026-01-01");
      expect(field(dialog, "Through").value).toBe("2026-12-31");
      expect(dialog.querySelector("[data-import-waiting]")?.textContent).toBe(
        words.IMPORT_CHECKING,
      );
      expect(
        within(dialog).getByRole("button", { name: words.IMPORT }),
      ).toBeDisabled();
      fireEvent.submit(present(dialog.querySelector("form")));
      await w.settle();
      expect(importDrafts(w)).toHaveLength(0);
      await facts.release();
      if (invalidated) {
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
        await waitFor(() =>
          expect(announced()).toBe(words.IMPORT_CLOSED_REFRESHING),
        );
        const again = await openRow(w, PENDING_ROW);
        expect(shownFile(again)).toBeNull();
        expect(field(again, "From").value).toBe(fresh.from);
      } else {
        expect(screen.queryByRole("dialog")).toBe(dialog);
        expect(dialog.querySelector("[data-import-waiting]")).toBeNull();
        expect(shownFile(dialog) ?? "").toContain("retained.ics");
        expect(field(dialog, "Through").value).toBe("2026-12-31");
        expect(
          within(dialog).getByRole("button", { name: words.IMPORT }),
        ).toBeEnabled();
      }
      expect(importDrafts(w)).toHaveLength(0);
      expect(w.calls.filter((call) => call.method === "POST")).toEqual([]);
    });

  for (const invalidate of [false, true])
    test(`R7b: a pending source's import opened on an EMPTY cache; with no controller mounted, the first fill${invalidate ? ", W18 and a refill: back, Import events is a new session" : " only (control): back, the SAME input"}`, async () => {
      const w = await calendarWorld({
        production: true,
        productionSync: true,
        online: false,
        drafts: [pendingCreate()],
      });
      await keptPending(w);
      const initial = w.sync();
      expect(initial.cache_status).toBe("empty");
      const incarnation = w.env.service()?.incarnationId;
      await w.detach();
      await w.recover([]);
      expect(w.sync().cache_status).toBe("valid");
      if (invalidate) {
        await w.invalidate();
        expect(w.sync().cache_status).toBe("invalid");
        await w.recover([]);
      }
      const refilled = w.sync();
      expect(refilled.cache_status).toBe("valid");
      expect(refilled.recovery_generation).toBeGreaterThan(
        initial.recovery_generation,
      );
      expect(refilled.cache_invalidation_seq ?? 0).toBe(invalidate ? 1 : 0);
      await w.attach();
      expect(w.env.service()?.incarnationId).toBe(incarnation);
      await w.traverse(-1);
      const again = await openRow(w, PENDING_ROW);
      if (invalidate) {
        expect(shownFile(again)).toBeNull();
        expect(field(again, "From").value).toBe(fresh.from);
        expect(field(again, "Through").value).toBe(fresh.through);
      } else {
        expect(shownFile(again) ?? "").toContain("retained.ics");
        expect(field(again, "From").value).toBe("2026-01-01");
        expect(field(again, "Through").value).toBe("2026-12-31");
      }
      expect(importDrafts(w)).toHaveLength(0);
      expect(w.calls.filter((call) => call.method === "POST")).toEqual([]);
    });

  // T5 (design assessment): evidence that ONLY a mounted controller has. An admitted invalidation whose failure counter could not be
  // written leaves its fallback marker, which the facts do not carry: neither the page runtime's service nor the witness can tell, and the
  // controller that opened the session is gone. The page's cache lifetime (whichever controller is mounted) is what ends it; the marker
  // retired again before the session is shown, nothing durable remains to compare (MU-5129, MU-5134).
  for (const failed of [true, false])
    test(`L5 (revision 8): after a remount, an admitted invalidation known only by its fallback marker ${failed ? "at the cache's position ends" : "of ANOTHER position (control) keeps"} the kept import, though the marker is gone when it is shown again`, async () => {
      const w = await calendarWorld({
        cache: [sourceRow()],
        production: true,
        validCache: true,
        online: false,
        productionSync: true,
      });
      const dialog = await edited(w);
      await syncFrom(w, dialog);
      await w.remount();
      const s = w.sync();
      const service = w.env.service();
      expect(service).not.toBeNull();
      const scope = {
        account: (service as NonNullable<typeof service>).account,
        incarnationId: (service as NonNullable<typeof service>).incarnationId,
      };
      const operation = invalidateOperation(failed ? s.cursor : "delta-old");
      let recorded: unknown = null;
      await act(async () => {
        recorded = w.host.markers.set(scope, operation).state;
      });
      expect(recorded).toBe("recorded");
      // The page's own marker write announces nothing to its controller; the next read of the facts (here an unchanged commit) derives
      // the cache again and finds it.
      await w.commit({ put: { store: "sync_state", rows: [s] } });
      try {
        expect(w.env.cacheLifetime.get()).toMatchObject({
          invalidations: s.cache_invalidation_seq ?? 0,
          invalidated: failed,
        });
        expect(w.sync()).toEqual(s);
      } finally {
        await act(async () => {
          w.host.markers.clear(scope, operation);
        });
        await w.commit({ put: { store: "sync_state", rows: [s] } });
      }
      expect(w.env.cacheLifetime.get()).toMatchObject({ invalidated: false });
      await w.traverse(-1);
      const again = await openRow(w);
      if (failed)
        expect(seen(w, again)).toMatchObject({ file: null, from: fresh.from });
      else
        expect(seen(w, again)).toMatchObject({
          file: expect.stringContaining("retained.ics"),
          from: "2026-01-01",
        });
    });

  for (const status of ["unverified", "invalid"] as const)
    test(`a CACHED source's open dialog when its cache becomes ${status}: ${status === "unverified" ? "it WAITS (the source not shown, nothing saved) and keeps the input; valid again, it is ready" : "it closes and says why (E9, control)"}`, async () => {
      const w = await calendarWorld({ cache: [sourceRow()], online: false });
      const dialog = await edited(w);
      const valid = w.sync();
      await w.commit({
        put: {
          store: "sync_state",
          rows: [{ ...valid, cache_status: status as never }],
        },
      });
      if (status === "invalid") {
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
        await waitFor(() =>
          expect(announced()).toBe(words.IMPORT_CLOSED_REFRESHING),
        );
        return;
      }
      expect(screen.queryByRole("dialog")).toBe(dialog);
      expect(dialog.querySelector("[data-import-waiting]")).not.toBeNull();
      expect(dialog.querySelector("[data-import-source]")?.textContent).toBe(
        "—",
      );
      expect(shownFile(dialog) ?? "").toContain("retained.ics");
      expect(
        within(dialog).getByRole("button", { name: words.IMPORT }),
      ).toBeDisabled();
      await w.commit({ put: { store: "sync_state", rows: [valid] } });
      expect(dialog.querySelector("[data-import-waiting]")).toBeNull();
      expect(dialog.querySelector("[data-import-source]")?.textContent).toBe(
        "Family calendar",
      );
      expect(field(dialog, "Through").value).toBe("2026-12-31");
      expect(drafts(w)).toHaveLength(0);
    });

  /**
   * WEB-13b revision 9 (review 9 R7c; design assessment C1, C6; schedule T1), review 9's schedule maintained: every readSyncFacts of the
   * page runtime's service from the sync control on is FROZEN (a live read keeps the snapshot it had, and is not heard; a one-off read is
   * not delivered), so the controller's publication stays the OLD valid cache with the basis's witness, which agrees. Writers still run.
   */
  function freezeFacts(w: World) {
    const service = w.env.service();
    expect(service).not.toBeNull();
    const real = (service as NonNullable<typeof service>).store as unknown as {
      watch: (
        plan: { name: string },
        input: unknown,
      ) => { get(): unknown; subscribe(listener: () => void): () => void };
      run: (plan: { name: string }, ...rest: unknown[]) => Promise<unknown>;
    };
    const watch = real.watch.bind(real);
    const run = real.run.bind(real);
    let frozen = false;
    const runs: Array<() => void> = [];
    vi.spyOn(real, "watch").mockImplementation((plan, input) => {
      const source = watch(plan, input);
      if (plan.name !== "data.readSyncFacts") return source;
      let snapshot = source.get();
      return {
        get: () => {
          if (!frozen) snapshot = source.get();
          return snapshot;
        },
        subscribe: (listener: () => void) =>
          source.subscribe(() => {
            if (frozen) return;
            snapshot = source.get();
            listener();
          }),
      };
    });
    vi.spyOn(real, "run").mockImplementation((plan, ...rest) => {
      const result = run(plan, ...rest);
      if (plan.name !== "data.readSyncFacts" || !frozen) return result;
      return new Promise((resolve, reject) => {
        runs.push(() => {
          result.then(resolve, reject);
        });
      });
    });
    return {
      freeze() {
        frozen = true;
      },
      held: () => runs.length,
      async release() {
        await act(async () => {
          frozen = false;
          for (const go of runs.splice(0)) go();
        });
        await w.settle();
      },
    };
  }
  const zoneInput = () =>
    present(
      present(document.querySelector("[data-import-drop]")).querySelector(
        'input[type="file"]',
      ),
    ) as HTMLInputElement;
  const browse = () =>
    present(
      present(document.querySelector("[data-import-drop]")).querySelector(
        "button",
      ),
    );

  for (const entry of ["row", "chooser"] as const)
    for (const invalidated of [false, true])
      test(`R7c (${entry}): shown again with an old agreeing publication and its read held, the kept import WAITS: click, Enter and a programmatic submission store nothing; released ${invalidated ? "after W18 and a refill: it closes, says why, and nothing is ever stored" : "unchanged (control): ready, and Import stores ONE import"}`, async () => {
        const w = await calendarWorld({
          production: true,
          productionSync: true,
          validCache: true,
          online: false,
          drafts: [pendingCreate()],
        });
        const facts = freezeFacts(w);
        let dialog: HTMLElement;
        if (entry === "row") {
          dialog = await openRow(w, PENDING_ROW);
          await choose(w, dialog, ICS);
        } else {
          await screen.findByText(words.DROP_PROMPT);
          await act(async () => {
            fireEvent.change(zoneInput(), {
              target: {
                files: [
                  new File([ICS], "retained.ics", { type: "text/calendar" }),
                ],
              },
            });
          });
          await w.settle();
          dialog = await shownDialog();
          fireEvent.change(within(dialog).getByLabelText(words.SOURCE), {
            target: { value: PENDING },
          });
        }
        await waitFor(() =>
          expect(shownFile(dialog) ?? "").toContain("retained.ics"),
        );
        setField(dialog, "From", "2026-01-01");
        setField(dialog, "Through", "2026-12-31");
        await syncFrom(w, dialog);
        expect(w.path()).toBe("/sync");
        const before = w.sync().cache_invalidation_seq ?? 0;
        facts.freeze();
        if (invalidated) {
          await w.invalidate();
          await w.recover([]);
        }
        expect(w.sync().cache_status).toBe("valid");
        expect(w.sync().cache_invalidation_seq ?? 0).toBe(
          invalidated ? before + 1 : before,
        );
        await w.traverse(-1);
        if (entry === "row") await openRow(w, PENDING_ROW);
        else {
          fireEvent.click(browse());
          await w.settle();
        }
        const again = await shownDialog();
        // The showing's read is held: nothing but the old publication, which agrees, is known.
        expect(facts.held()).toBeGreaterThan(0);
        expect(shownFile(again) ?? "").toContain("retained.ics");
        expect(field(again, "From").value).toBe("2026-01-01");
        expect(field(again, "Through").value).toBe("2026-12-31");
        expect(again.querySelector("[data-import-waiting]")?.textContent).toBe(
          words.IMPORT_CHECKING,
        );
        const button = within(again).getByRole("button", {
          name: words.IMPORT,
        });
        expect(button).toBeDisabled();
        fireEvent.click(button);
        const form = present(again.querySelector("form")) as HTMLFormElement;
        fireEvent.submit(form);
        await act(async () => {
          form.requestSubmit();
        });
        await w.settle();
        expect(importDrafts(w)).toHaveLength(0);
        await facts.release();
        if (invalidated) {
          await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
          await waitFor(() =>
            expect(announced()).toBe(words.IMPORT_CLOSED_REFRESHING),
          );
        } else {
          expect(screen.queryByRole("dialog")).toBe(again);
          expect(again.querySelector("[data-import-waiting]")).toBeNull();
          press(again, words.IMPORT);
          await w.settle();
        }
        expect(importDrafts(w)).toHaveLength(invalidated ? 0 : 1);
        if (!invalidated)
          expect(importDrafts(w)[0]).toMatchObject({ target_id: PENDING });
        expect(w.calls.filter((call) => call.method === "POST")).toEqual([]);
      });

  /**
   * WEB-13b revision 9 (design assessment C2, invariant 6; schedule T5; MORNING-TASK-APPROVALS-20261028): the verification and the enqueue
   * are separate transactions. A ready dialog (shown from its opening, or verified after the sync control) whose page hears nothing more
   * (facts frozen), another page's W18 and refill committed meanwhile: Import states the history it was verified against
   * (`EnqueueRequest.continuity`) and W2 refuses it (`expired`): nothing stored, the dialog closes and says why. Control: no invalidation,
   * one import.
   */
  for (const resumed of [false, true])
    for (const invalidated of [false, true])
      test(`C2/T5 (${resumed ? "verified after the sync control" : "shown from its opening"}): ready, the page hearing nothing more, ${invalidated ? "another page's W18 and refill committed: Import stores NOTHING (expired), closes and says why" : "no invalidation (control): Import stores ONE import"}`, async () => {
        const w = await calendarWorld({
          production: true,
          productionSync: true,
          validCache: true,
          online: false,
          drafts: [pendingCreate()],
        });
        const facts = freezeFacts(w);
        let dialog = await openRow(w, PENDING_ROW);
        await choose(w, dialog, ICS);
        await waitFor(() =>
          expect(shownFile(dialog) ?? "").toContain("retained.ics"),
        );
        setField(dialog, "From", "2026-01-01");
        setField(dialog, "Through", "2026-12-31");
        if (resumed) {
          await syncFrom(w, dialog);
          await w.traverse(-1);
          dialog = await openRow(w, PENDING_ROW);
          await w.settle();
        }
        expect(dialog.querySelector("[data-import-waiting]")).toBeNull();
        expect(
          within(dialog).getByRole("button", { name: words.IMPORT }),
        ).toBeEnabled();
        facts.freeze();
        if (invalidated) {
          await w.invalidate();
          await w.recover([]);
        }
        expect(w.sync().cache_status).toBe("valid");
        expect(w.sync().cache_invalidation_seq ?? 0).toBe(invalidated ? 1 : 0);
        // Nothing of it reached the page: the dialog is as it was.
        expect(screen.queryByRole("dialog")).toBe(dialog);
        press(dialog, words.IMPORT);
        await w.settle();
        if (invalidated) {
          await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
          await waitFor(() =>
            expect(announced()).toBe(words.IMPORT_CLOSED_REFRESHING),
          );
        }
        expect(importDrafts(w)).toHaveLength(invalidated ? 0 : 1);
        expect(
          (w.rows("draft_commands") as Array<{ local_id: string }>).filter(
            (row) => row.local_id !== "create-1",
          ),
        ).toHaveLength(invalidated ? 0 : 1);
        await facts.release();
        expect(importDrafts(w)).toHaveLength(invalidated ? 0 : 1);
        expect(w.calls.filter((call) => call.method === "POST")).toEqual([]);
      });

  /**
   * WEB-13b revision 10 (review 10 R7d; design assessment C1, invariants 2 and 5; schedule M1), review 10's rendered pair maintained:
   * every read a showing asks for (`readCache`) is MADE at once, against the database as it is, and only its return to the owner is held.
   * Shown again twice, the second showing's read verifies it; while it is shown and ready, a pending source's dialog follows W18 and a
   * refill (the visible refresh it is allowed, C3). The FIRST showing's read, of the old witness, then lands: it is no invalidation, and
   * the dialog stays with its file and window. Both orders: delivered before the second showing's read, it verifies nothing.
   */
  function holdShowingReads() {
    const real = observations.readCache;
    const reads: Array<{ value: unknown; deliver: () => void }> = [];
    vi.spyOn(observations, "readCache").mockImplementation((service) => {
      const read = { value: null as unknown, deliver: () => {} };
      const made = real(service).then((value) => {
        read.value = value;
        return value;
      });
      reads.push(read);
      return new Promise((resolve, reject) => {
        read.deliver = () => {
          made.then(resolve, reject);
        };
      });
    });
    return reads;
  }
  const deliver = async (w: World, read: { deliver: () => void }) => {
    await act(async () => {
      read.deliver();
    });
    await w.settle();
  };

  /** Shows the kept import again from its entry: the same row, or the drop zone's Browse (no picker). */
  async function reopen(w: World, entry: "row" | "chooser") {
    if (entry === "row") return openRow(w, PENDING_ROW);
    fireEvent.click(browse());
    await w.settle();
    return shownDialog();
  }

  for (const entry of ["row", "chooser"] as const)
    for (const order of ["after", "before"] as const)
      for (const refreshed of [false, true])
        test(`R7d (${entry}): an earlier showing's read delivered ${order} the later showing's, ${refreshed ? "after W18 and a refill while the later showing is shown and ready" : "with no refresh (control)"}: the kept import stays shown with its file and window, and Import stores ONE import`, async () => {
          const w = await calendarWorld({
            production: true,
            productionSync: true,
            validCache: true,
            online: false,
            drafts: [pendingCreate()],
          });
          let dialog: HTMLElement;
          if (entry === "row") {
            dialog = await openRow(w, PENDING_ROW);
            await choose(w, dialog, ICS);
          } else {
            await screen.findByText(words.DROP_PROMPT);
            await act(async () => {
              fireEvent.change(zoneInput(), {
                target: {
                  files: [
                    new File([ICS], "retained.ics", { type: "text/calendar" }),
                  ],
                },
              });
            });
            await w.settle();
            dialog = await shownDialog();
            fireEvent.change(within(dialog).getByLabelText(words.SOURCE), {
              target: { value: PENDING },
            });
          }
          await waitFor(() =>
            expect(shownFile(dialog) ?? "").toContain("retained.ics"),
          );
          setField(dialog, "From", "2026-01-01");
          setField(dialog, "Through", "2026-12-31");
          const reads = holdShowingReads();
          await toSyncAndBack(w, dialog);
          dialog = await reopen(w, entry);
          expect(reads).toHaveLength(1);
          expect(dialog.querySelector("[data-import-waiting]")).not.toBeNull();
          await toSyncAndBack(w, dialog);
          dialog = await reopen(w, entry);
          expect(reads).toHaveLength(2);
          expect(reads.map((read) => read.value)).toEqual([
            { invalidations: 0, invalidated: false },
            { invalidations: 0, invalidated: false },
          ]);
          const [earlier, later] = reads as [
            (typeof reads)[number],
            (typeof reads)[number],
          ];
          if (order === "before") {
            await deliver(w, earlier);
            // Asked for another showing: it verifies nothing.
            expect(
              dialog.querySelector("[data-import-waiting]"),
            ).not.toBeNull();
            expect(
              within(dialog).getByRole("button", { name: words.IMPORT }),
            ).toBeDisabled();
          }
          await deliver(w, later);
          expect(dialog.querySelector("[data-import-waiting]")).toBeNull();
          if (refreshed) {
            await w.invalidate();
            await w.recover([]);
            expect(w.sync().cache_invalidation_seq ?? 0).toBe(1);
          }
          // The pending source's dialog stays open through the visible refresh (C3).
          expect(screen.queryByRole("dialog")).toBe(dialog);
          if (order === "after") await deliver(w, earlier);
          expect(screen.queryByRole("dialog")).toBe(dialog);
          expect(shownFile(dialog) ?? "").toContain("retained.ics");
          expect(field(dialog, "From").value).toBe("2026-01-01");
          expect(field(dialog, "Through").value).toBe("2026-12-31");
          expect(announced()).not.toBe(words.IMPORT_CLOSED_REFRESHING);
          press(dialog, words.IMPORT);
          await w.settle();
          expect(importDrafts(w)).toHaveLength(1);
          expect(importDrafts(w)[0]).toMatchObject({ target_id: PENDING });
          expect(w.calls.filter((call) => call.method === "POST")).toEqual([]);
        });

  /**
   * WEB-13b revision 10 (review 10 R7e; design assessment C2, invariants 6 and 7; schedule M3), review 10's first-showing schedule
   * maintained: the provider attached again with every readSyncFacts held, so a NEW session of a row knows neither witness nor database
   * history while its pending source and file resolve. It is `acquiring`: its source, file and window are shown, and click, Enter and a
   * programmatic submission reach no enqueue at all (the drop zone's chooser is not offered at all until the cache gate opens). Facts released, ONE explicit Import states the history it then
   * knows; held at the enqueue, another commit of W18 and a refill before W2 refuses it (`expired`: nothing stored, the dialog closes and
   * says why), and the control queues ONE import with that history. Run on a database never invalidated (witness 0) and on one already
   * invalidated and refilled (witness 1: not evidence against a new session).
   */
  for (const entry of ["row", "chooser"] as const)
    for (const witness of [0, 1])
      for (const invalidated of [false, true])
        test(`R7e (${entry}, witness ${witness}): a new import before its cache history is known stores nothing whatever submits it; facts released, ${invalidated ? "W18 and a refill committed before the enqueue: refused, nothing stored" : "(control) Import stores ONE import stating that history"}`, async () => {
          const w = await calendarWorld({
            production: true,
            productionSync: true,
            validCache: true,
            online: false,
            drafts: [pendingCreate()],
          });
          if (witness === 1) {
            await w.invalidate();
            await w.recover([]);
          }
          expect(w.sync().cache_invalidation_seq ?? 0).toBe(witness);
          const facts = freezeFacts(w);
          await w.detach();
          facts.freeze();
          await w.attach();
          let dialog: HTMLElement;
          if (entry === "row") {
            dialog = await openRow(w, PENDING_ROW);
            await choose(w, dialog, ICS);
          } else {
            // The chooser's entry is offered only while the cache gate is open: no chooser session starts before its facts are read.
            await w.settle();
            expect(facts.held()).toBeGreaterThan(0);
            expect(document.querySelector("[data-import-drop]")).toBeNull();
            await facts.release();
            await screen.findByText(words.DROP_PROMPT);
            await act(async () => {
              fireEvent.change(zoneInput(), {
                target: {
                  files: [
                    new File([ICS], "retained.ics", { type: "text/calendar" }),
                  ],
                },
              });
            });
            await w.settle();
            dialog = await shownDialog();
            fireEvent.change(within(dialog).getByLabelText(words.SOURCE), {
              target: { value: PENDING },
            });
          }
          await waitFor(() =>
            expect(shownFile(dialog) ?? "").toContain("retained.ics"),
          );
          setField(dialog, "From", "2026-01-01");
          setField(dialog, "Through", "2026-12-31");
          await w.settle();
          const outbox = w.env.outbox();
          if (outbox === null) throw new Error("no outbox");
          const enqueue = outbox.enqueue.bind(outbox);
          const stated: unknown[] = [];
          let admit = () => {};
          const spy = vi
            .spyOn(outbox, "enqueue")
            .mockImplementation(async (request) => {
              stated.push(request.continuity);
              await new Promise<void>((go) => {
                admit = go;
              });
              return enqueue(request);
            });
          if (entry === "row") {
            // Nothing of the cache's history is known: the opening read and every live reading are held.
            expect(facts.held()).toBeGreaterThan(0);
            expect(w.env.cacheLifetime.get()?.invalidations ?? null).toBeNull();
            expect(
              dialog.querySelector("[data-import-source]")?.textContent,
            ).toBe("Pending calendar");
            const button = within(dialog).getByRole("button", {
              name: words.IMPORT,
            });
            expect(button).toBeDisabled();
            fireEvent.click(button);
            const form = present(
              dialog.querySelector("form"),
            ) as HTMLFormElement;
            fireEvent.submit(form);
            await act(async () => {
              form.requestSubmit();
            });
            await w.settle();
            expect(spy).not.toHaveBeenCalled();
            expect(importDrafts(w)).toHaveLength(0);
            expect(screen.queryByRole("dialog")).toBe(dialog);
            expect(shownFile(dialog) ?? "").toContain("retained.ics");
            expect(field(dialog, "From").value).toBe("2026-01-01");
            await facts.release();
          }
          await waitFor(() =>
            expect(
              within(dialog).getByRole("button", { name: words.IMPORT }),
            ).toBeEnabled(),
          );
          const history = {
            incarnationId: w.sync().incarnation_id,
            invalidations: witness,
          };
          press(dialog, words.IMPORT);
          await w.settle();
          expect(spy).toHaveBeenCalledTimes(1);
          expect(stated).toEqual([history]);
          if (invalidated) {
            await w.invalidate();
            await w.recover([]);
            expect(w.sync().cache_invalidation_seq ?? 0).toBe(witness + 1);
          }
          await act(async () => {
            admit();
          });
          await w.settle();
          if (invalidated) {
            await waitFor(() =>
              expect(screen.queryByRole("dialog")).toBeNull(),
            );
            await waitFor(() =>
              expect(announced()).toBe(words.IMPORT_CLOSED_REFRESHING),
            );
          }
          expect(importDrafts(w)).toHaveLength(invalidated ? 0 : 1);
          if (!invalidated)
            expect(importDrafts(w)[0]).toMatchObject({ target_id: PENDING });
          expect(w.calls.filter((call) => call.method === "POST")).toEqual([]);
        });

  /**
   * WEB-13b revision 11 (review 11 R7f; design assessment C1-C2, invariant 1; schedule S1), review 11's notification schedule maintained:
   * the provider attached again with every readSyncFacts of the page runtime's service held, told apart at the store: a LIVE reading's
   * read (made for a `watch`, the controller's publication and the observation's) or a ONE-OFF read (`readCache`: the opening read of a
   * new session's observation). Only the one-off read is delivered, so no publication, edit or other render happens: what makes the new
   * session ready must tell the dialog itself. Controls: the opening read still held, and failed (`readCache` says nothing): acquiring,
   * nothing told, the input kept, nothing stored.
   */
  function holdFactsReads(w: World) {
    const service = w.env.service();
    expect(service).not.toBeNull();
    const real = (service as NonNullable<typeof service>).store as unknown as {
      watch: (
        plan: { name: string },
        input: unknown,
      ) => { get(): unknown; subscribe(listener: () => void): () => void };
      run: (
        plan: { name: string },
        input: unknown,
        ...rest: unknown[]
      ) => Promise<unknown>;
    };
    const watch = real.watch.bind(real);
    const run = real.run.bind(real);
    // A live reading reads with the input it was watched with (the store re-runs its plan); a one-off read with its own.
    const live = new WeakSet<object>();
    let frozen = false;
    const held: Array<{
      once: boolean;
      deliver: (fail?: boolean) => void;
    }> = [];
    vi.spyOn(real, "watch").mockImplementation((plan, input) => {
      if (plan.name === "data.readSyncFacts" && typeof input === "object")
        live.add(input as object);
      const source = watch(plan, input);
      if (plan.name !== "data.readSyncFacts") return source;
      let snapshot = source.get();
      return {
        get: () => {
          if (!frozen) snapshot = source.get();
          return snapshot;
        },
        subscribe: (listener: () => void) =>
          source.subscribe(() => {
            if (frozen) return;
            snapshot = source.get();
            listener();
          }),
      };
    });
    vi.spyOn(real, "run").mockImplementation((plan, input, ...rest) => {
      const result = run(plan, input, ...rest);
      if (plan.name !== "data.readSyncFacts" || !frozen) return result;
      const once = !(typeof input === "object" && live.has(input as object));
      return new Promise((resolve, reject) => {
        held.push({
          once,
          deliver: (fail = false) => {
            result.then(
              (value) =>
                fail ? reject(new Error("read failed")) : resolve(value),
              reject,
            );
          },
        });
      });
    });
    return {
      freeze() {
        frozen = true;
      },
      /** The one-off reads held. */
      once: () => held.filter((read) => read.once),
      /** The live readings' reads held. */
      live: () => held.filter((read) => !read.once),
      async deliver(read: { deliver: (fail?: boolean) => void }, fail = false) {
        held.splice(held.indexOf(read as (typeof held)[number]), 1);
        await act(async () => {
          read.deliver(fail);
        });
        await w.settle();
      },
      async release() {
        await act(async () => {
          frozen = false;
          for (const read of held.splice(0)) read.deliver();
        });
        await w.settle();
      },
    };
  }

  for (const witness of [0, 1])
    for (const opening of ["delivered", "held", "failed"] as const)
      test(`R7f (row, witness ${witness}): a new import's opening read ${opening === "delivered" ? "delivered alone (no publication, edit or other render) tells the dialog: Import is enabled with the input kept, nothing stored until it is pressed, and then ONE import states that history" : opening === "held" ? "still held (control): acquiring, nothing told, Import disabled, nothing stored" : "failed (control): acquiring, nothing told, Import disabled with the input kept, nothing stored"}`, async () => {
        const w = await calendarWorld({
          production: true,
          productionSync: true,
          validCache: true,
          online: false,
          drafts: [pendingCreate()],
        });
        if (witness === 1) {
          await w.invalidate();
          await w.recover([]);
        }
        expect(w.sync().cache_invalidation_seq ?? 0).toBe(witness);
        const reads = holdFactsReads(w);
        await w.detach();
        reads.freeze();
        await w.attach();
        let told = 0;
        let off = () => {};
        try {
          const dialog = await openRow(w, PENDING_ROW);
          await choose(w, dialog, ICS);
          await waitFor(() =>
            expect(shownFile(dialog) ?? "").toContain("retained.ics"),
          );
          setField(dialog, "From", "2026-01-01");
          setField(dialog, "Through", "2026-12-31");
          await w.settle();
          const outbox = w.env.outbox();
          if (outbox === null) throw new Error("no outbox");
          const enqueue = outbox.enqueue.bind(outbox);
          const stated: unknown[] = [];
          const spy = vi
            .spyOn(outbox, "enqueue")
            .mockImplementation(async (request) => {
              stated.push(request.continuity);
              return enqueue(request);
            });
          // Acquiring: nothing of the cache's history is known; the ONE one-off read held is the new session's opening read.
          expect(reads.live().length).toBeGreaterThan(0);
          expect(reads.once()).toHaveLength(1);
          expect(w.env.cacheLifetime.get()?.invalidations ?? null).toBeNull();
          expect(
            within(dialog).getByRole("button", { name: words.IMPORT }),
          ).toBeDisabled();
          expect(
            within(dialog).getByRole("button", { name: words.IMPORT }),
          ).toHaveAccessibleDescription(words.IMPORT_CHECKING);
          off = subscribeImports(() => {
            told += 1;
          });
          const [read] = reads.once();
          if (read === undefined) throw new Error("no opening read");
          if (opening !== "held")
            await reads.deliver(read, opening === "failed");
          // Only that read went: every live reading is still held, so nothing was published and nothing else rendered the dialog.
          expect(reads.live().length).toBeGreaterThan(0);
          expect(w.env.cacheLifetime.get()?.invalidations ?? null).toBeNull();
          expect(shownFile(dialog) ?? "").toContain("retained.ics");
          expect(field(dialog, "From").value).toBe("2026-01-01");
          expect(field(dialog, "Through").value).toBe("2026-12-31");
          expect(spy).not.toHaveBeenCalled();
          expect(importDrafts(w)).toHaveLength(0);
          const button = within(dialog).getByRole("button", {
            name: words.IMPORT,
          });
          if (opening !== "delivered") {
            expect(told).toBe(0);
            expect(button).toBeDisabled();
            expect(
              within(dialog).getByRole("button", { name: words.IMPORT }),
            ).toHaveAccessibleDescription(words.IMPORT_CHECKING);
            fireEvent.click(button);
            fireEvent.submit(present(dialog.querySelector("form")));
            await w.settle();
            expect(spy).not.toHaveBeenCalled();
            expect(importDrafts(w)).toHaveLength(0);
            expect(screen.queryByRole("dialog")).toBe(dialog);
          } else {
            // Told once: the dialog shown before is enabled (not a new one).
            expect(told).toBe(1);
            expect(screen.queryByRole("dialog")).toBe(dialog);
            expect(button).toBeEnabled();
            expect(button).not.toHaveAccessibleDescription(
              words.IMPORT_CHECKING,
            );
            expect(dialog.textContent).not.toContain(words.IMPORT_CHECKING);
            press(dialog, words.IMPORT);
            await w.settle();
            expect(spy).toHaveBeenCalledTimes(1);
            expect(stated).toEqual([
              {
                incarnationId: w.sync().incarnation_id,
                invalidations: witness,
              },
            ]);
            expect(importDrafts(w)).toHaveLength(1);
            expect(importDrafts(w)[0]).toMatchObject({ target_id: PENDING });
          }
          expect(w.calls.filter((call) => call.method === "POST")).toEqual([]);
        } finally {
          off();
          await reads.release();
        }
      });
});
