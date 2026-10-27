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
import * as copy from "../../../src/features/calendars/copy";
import { SHOW_NEXT_CALENDARS } from "../../../src/features/calendars/copy-anchor";
import * as words from "../../../src/features/calendars/copy-import";
import { deviceToday } from "../../../src/features/calendars/ImportDialog";
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

async function openRow(w: World, name = ROW): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole("button", { name }));
  const dialog = await screen.findByRole("dialog");
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
  await waitFor(() => expect(shownFile(dialog)).toContain("retained.ics"));
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
    expect(shownFile(again)).toContain("slow.ics");
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
    // mutation runner rejects beside the expected catch: MU-2637/MU-2638 were invalid). The same requirement: the message is shown.
    expect(within(again).queryByText(words.READING)).toBeInTheDocument();
    fireEvent.submit(present(again.querySelector("form")));
    await w.settle();
    expect(drafts(w)).toHaveLength(0);
    expect(within(again).queryByText(words.FILE_REQUIRED)).toBeNull();
    await act(async () => held.deliver());
    await w.settle();
    expect(shownFile(again)).toContain("slow.ics");
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
    expect(shownFile(again)).toContain("next.ics");
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
    expect(shownFile(again)).toContain("retained.ics");
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
    const dialog = await screen.findByRole("dialog");
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
    expect(shownFile(again)).toContain("drop.ics");
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
    const dialog = await screen.findByRole("dialog");
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
    const dialog = await screen.findByRole("dialog");
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
    const again = await screen.findByRole("dialog");
    await waitFor(() => expect(shownFile(again)).toContain("second.ics"));
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
    press(await screen.findByRole("dialog"), "Cancel");
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
      expect(w.env.cacheLifetime.get()).toMatchObject({
        generation: s.recovery_generation,
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
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(shownFile(dialog)).toContain("drop.ics"));
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
        const dialog = await screen.findByRole("dialog");
        expect(field(dialog, "Through").value).toBe(fresh.through);
      } else {
        expect(picker).not.toHaveBeenCalled();
        const again = present(screen.queryByRole("dialog"));
        expect(shownFile(again)).toContain("drop.ics");
        expect(field(again, "Through").value).toBe("2026-12-31");
      }
      expect(drafts(w)).toHaveLength(0);
      expect(importPosts(w)).toHaveLength(0);
    });
});
