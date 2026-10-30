import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { CacheRow, DraftRow } from "../../../src/data";
import * as copy from "../../../src/features/calendars/copy";
import {
  SHOW_NEXT_CALENDARS,
  SHOW_PREVIOUS_CALENDARS,
} from "../../../src/features/calendars/copy-anchor";
import * as words from "../../../src/features/calendars/copy-import";
import { IMPORT_ENDPOINT } from "../../../src/features/calendars/model/commands";
import { installMatchMedia } from "../../helpers/match-media";
import { calendarWorld, sourceRow } from "../../support/calendars";
import { historyOf } from "../../support/data/continuity";
import { draftRow, headerOf } from "../../support/data/rows";
import { corpusText, parserEvents } from "../../support/ics-corpus";

/**
 * WEB-13b §4.2 (Q22 "file imports"; the wireframe's import panels): the row's "Import events", the page's drop zone, the import dialog
 * and the Imports panel, through the PRODUCTION controller, plans and outbox facade over the double of IndexedDB. FIXTURE evidence (jsdom):
 * the native specs (E-IMP1..5) cover real engines, layout and the network.
 */
installMatchMedia({ width: 1440 });
/** The control asserted present (an assertion, not a query error, when it is missing), then returned to act on. */
const present = (element: HTMLElement | null): HTMLElement => {
  expect(element).not.toBeNull();
  return element as HTMLElement;
};
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await new Promise((resolve) => setTimeout(resolve, 0));
});

const SOURCE = sourceRow().id;
const ICS =
  "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:bin@example\r\nDTSTART;VALUE=DATE:20261101\r\nSUMMARY:Bin day\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
type World = Awaited<ReturnType<typeof calendarWorld>>;
const drafts = (w: World) => w.rows("drafts") as DraftRow[];
const bodyOf = (w: World, id: string) =>
  (
    w.rows("draft_commands") as Array<{ local_id: string; command: unknown }>
  ).find((row) => row.local_id === id)?.command;
const reasonOf = (element: HTMLElement) =>
  document.getElementById(
    (element.getAttribute("aria-describedby") ?? "").split(" ")[0] ?? "",
  )?.textContent;
const announced = () =>
  document.querySelector('[aria-live="polite"]')?.textContent ?? "";

async function openFromRow(w: World) {
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Import events into Family calendar",
    }),
  );
  const dialog = await screen.findByRole("dialog");
  await w.settle();
  return dialog;
}

async function choose(
  w: World,
  dialog: HTMLElement,
  text: string,
  name = "family.ics",
) {
  const input = dialog.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File([text], name, { type: "text/calendar" });
  await act(async () => {
    fireEvent.change(input, { target: { files: [file] } });
  });
  await w.settle();
  await waitFor(() =>
    expect(dialog.querySelector("[data-import-file]")).not.toBeNull(),
  );
}

const press = (dialog: HTMLElement, name: string) =>
  fireEvent.click(within(dialog).getByRole("button", { name }));

describe("the row's Import events", () => {
  test("enabled on a cached editable source and on a pending one; the dialog names the source and the bounds", async () => {
    const pending = draftRow({
      local_id: "create-1",
      endpoint: "/calendar-commands",
      command: {
        command: {
          kind: "create_source",
          id: "00000000-0000-4000-8000-0000000000b9",
          label: "Weekend chores",
          timezone: "UTC",
        },
      },
      target_resource_ids: ["00000000-0000-4000-8000-0000000000b9"],
      index_targets: ["00000000-0000-4000-8000-0000000000b9"],
    });
    const w = await calendarWorld({ cache: [sourceRow()], drafts: [pending] });
    expect(
      await screen.findByRole("button", {
        name: "Import events into Weekend chores",
      }),
    ).toBeEnabled();
    const dialog = await openFromRow(w);
    expect(within(dialog).getByText("Family calendar")).toBeInTheDocument();
    expect(within(dialog).getByText(words.DIALOG_BOUNDS)).toBeInTheDocument();
    expect((await axe(document.body)).violations).toEqual([]);
  });

  test("a view-only source and a turned-off source cannot be imported into, with the reason", async () => {
    await calendarWorld({
      cache: [
        sourceRow({ can_edit: false }),
        sourceRow({
          id: "00000000-0000-4000-8000-0000000000a2",
          label: "Off calendar",
          archived: true,
        }),
      ],
    });
    const viewOnly = await screen.findByRole("button", {
      name: "Import events into Family calendar",
    });
    expect(viewOnly).toBeDisabled();
    expect(reasonOf(viewOnly)).toBe(words.VIEW_ONLY_IMPORT);
    const off = screen.getByRole("button", {
      name: "Import events into Off calendar",
    });
    expect(off).toBeDisabled();
    expect(reasonOf(off)).toBe(words.TURNED_OFF_IMPORT);
  });

  test("a settings change still waiting to send that turns the source off disables Import events too", async () => {
    const w = await calendarWorld({ cache: [sourceRow()] });
    const outbox = w.env.outbox();
    const { configureSourceRequest } = await import(
      "../../../src/features/calendars/model/commands"
    );
    await act(async () => {
      await outbox?.enqueue(
        configureSourceRequest(sourceRow(), {
          timezone: "Europe/Vienna",
          enabled: false,
        }),
      );
    });
    await w.settle();
    const action = screen.getByRole("button", {
      name: "Import events into Family calendar",
    });
    expect(action).toBeDisabled();
    expect(reasonOf(action)).toBe(words.TURNED_OFF_IMPORT);
  });
});

describe("the dialog", () => {
  test("a checked file and the default window queue ONE import, offline included; the body is exactly {ics, from, through}", async () => {
    const w = await calendarWorld({ cache: [sourceRow()], online: false });
    const dialog = await openFromRow(w);
    await choose(w, dialog, ICS);
    expect(dialog.querySelector("[data-import-file]")?.textContent).toMatch(
      /family\.ics · \d+ B · 1 event/,
    );
    const from = within(dialog).getByLabelText(words.FROM) as HTMLInputElement;
    const through = within(dialog).getByLabelText(
      words.THROUGH,
    ) as HTMLInputElement;
    fireEvent.change(from, { target: { value: "2026-01-01" } });
    fireEvent.change(through, { target: { value: "2026-12-31" } });
    // Two presses before the first is shown as busy store one import (the synchronous latch).
    const importButton = within(dialog).getByRole("button", {
      name: words.IMPORT,
    });
    fireEvent.click(importButton);
    fireEvent.click(importButton);
    await w.settle();
    const stored = drafts(w);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      endpoint: IMPORT_ENDPOINT,
      target_id: SOURCE,
      status: "queued",
    });
    expect(bodyOf(w, stored[0]?.local_id as string)).toEqual({
      ics: ICS,
      from: "2026-01-01",
      through: "2026-12-31",
    });
    expect(w.calls).toEqual([]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(announced()).toContain(words.IMPORT_QUEUED);
  });

  test("two submissions in the same task enqueue once (the synchronous latch: Enter's implicit submission and a press before the busy state renders)", async () => {
    const w = await calendarWorld({ cache: [sourceRow()], online: false });
    const dialog = await openFromRow(w);
    await choose(w, dialog, ICS);
    const outbox = w.env.outbox();
    if (outbox === null) throw new Error("no outbox");
    const enqueue = vi.spyOn(outbox, "enqueue");
    const form = dialog.querySelector("form") as HTMLFormElement;
    act(() => {
      form.requestSubmit();
      form.requestSubmit();
    });
    await w.settle();
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(drafts(w)).toHaveLength(1);
  });

  test("no file, a reversed window, a span over 730 days: inline messages, typed values kept, nothing stored", async () => {
    const w = await calendarWorld({ cache: [sourceRow()] });
    const dialog = await openFromRow(w);
    press(dialog, words.IMPORT);
    await w.settle();
    expect(within(dialog).getByText(words.FILE_REQUIRED)).toBeInTheDocument();
    await choose(w, dialog, ICS);
    const through = within(dialog).getByLabelText(
      words.THROUGH,
    ) as HTMLInputElement;
    fireEvent.change(within(dialog).getByLabelText(words.FROM), {
      target: { value: "2026-01-01" },
    });
    fireEvent.change(through, { target: { value: "2028-01-02" } });
    press(dialog, words.IMPORT);
    await w.settle();
    expect(within(dialog).getByText(words.WINDOW_SPAN)).toBeInTheDocument();
    expect(through.value).toBe("2028-01-02");
    fireEvent.change(through, { target: { value: "2025-12-31" } });
    press(dialog, words.IMPORT);
    await w.settle();
    expect(within(dialog).getByText(words.WINDOW_SPAN)).toBeInTheDocument();
    expect(drafts(w)).toEqual([]);
  });

  test.each([
    ["more than 256 events", "too_many_events", 257],
    ["not a calendar", "not_calendar", -1],
  ])(
    "a file with %s is refused on this device: nothing is stored or sent",
    async (_, reason, events) => {
      const w = await calendarWorld({ cache: [sourceRow()] });
      const dialog = await openFromRow(w);
      const text =
        events < 0
          ? "hello\n"
          : `BEGIN:VCALENDAR\r\n${"BEGIN:VEVENT\r\nEND:VEVENT\r\n".repeat(events)}END:VCALENDAR\r\n`;
      await choose(w, dialog, text);
      expect(
        within(dialog).getByText(words.FILE_PROBLEMS[reason] as string),
      ).toBeInTheDocument();
      press(dialog, words.IMPORT);
      await w.settle();
      expect(drafts(w)).toEqual([]);
    },
  );

  test("a source that becomes view-only while the dialog is open disables Import (its one read; the outbox's own denial is tested in outbox-calendar-extension)", async () => {
    const w = await calendarWorld({ cache: [sourceRow()] });
    const dialog = await openFromRow(w);
    await choose(w, dialog, ICS);
    // The source becomes view-only after the dialog showed it; the dialog follows its one read, and the outbox checks it again.
    await w.commit({
      put: { store: "cache", rows: [sourceRow({ can_edit: false })] },
    });
    const importButton = within(dialog).queryByRole("button", {
      name: words.IMPORT,
    });
    expect(importButton).toBeDisabled();
    expect(drafts(w)).toEqual([]);
  });

  test("the drop zone's Browse opens the dialog with a source to choose (the editable, enabled ones)", async () => {
    const w = await calendarWorld({
      cache: [
        sourceRow(),
        sourceRow({
          id: "00000000-0000-4000-8000-0000000000a2",
          label: "Shared rota",
          can_edit: false,
        }),
      ],
    });
    await screen.findByText(words.DROP_PROMPT);
    const zone = document.querySelector("[data-import-drop]") as HTMLElement;
    const input = zone.querySelector('input[type="file"]') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, {
        target: { files: [new File([ICS], "drop.ics")] },
      });
    });
    await w.settle();
    const dialog = await screen.findByRole("dialog");
    const select = within(dialog).getByLabelText(
      words.SOURCE,
    ) as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual([
      "Family calendar",
    ]);
    await waitFor(() =>
      expect(dialog.querySelector("[data-import-file]")?.textContent).toMatch(
        /drop\.ics/,
      ),
    );
  });

  test("with no source to import into, the drop zone says so", async () => {
    await calendarWorld({ cache: [] });
    const browse = await screen.findByRole("button", { name: words.BROWSE });
    expect(browse).toBeDisabled();
    expect(
      document.getElementById(
        (browse.getAttribute("aria-describedby") ?? "").split(" ")[0] ?? "",
      )?.textContent,
    ).toBe(words.NO_SOURCE_YET);
  });

  test("a source that leaves the cache while the dialog is open: Import is unavailable with the reason, nothing is stored", async () => {
    const w = await calendarWorld({ cache: [sourceRow()] });
    const dialog = await openFromRow(w);
    await choose(w, dialog, ICS);
    await w.commit({ remove: [SOURCE] });
    const importButton = within(dialog).getByRole("button", {
      name: words.IMPORT,
    });
    expect(importButton).toBeDisabled();
    expect(reasonOf(importButton)).toBe(words.SOURCE_GONE);
    expect(drafts(w)).toEqual([]);
  });
});

/** Holds a file's read until released, so a test can act while the dialog is still reading it (R1). */
function heldFile(text: string, name: string) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const file = new File([text], name, { type: "text/calendar" });
  const bytes = new TextEncoder().encode(text).buffer;
  Object.defineProperty(file, "arrayBuffer", {
    value: async () => {
      await gate;
      return bytes;
    },
  });
  return { file, release };
}

/** Holds the delivery of the outbox's successful answer (the draft IS stored), so a test can edit the dialog before it settles (R3). */
function holdEnqueue(w: World) {
  const outbox = w.env.outbox();
  if (outbox === null) throw new Error("no outbox");
  const original = outbox.enqueue.bind(outbox);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const spy = vi
    .spyOn(outbox, "enqueue")
    .mockImplementationOnce(async (request) => {
      const outcome = await original(request);
      await gate;
      return outcome;
    });
  return { release, spy };
}

describe("revision 1: only the latest file, only what was submitted (R1, R3)", () => {
  const REPLACEMENT = ICS.replace("Bin day", "Recycling");

  test("R1: choosing another file forgets the previous one at once; while it is read, no press, Enter or direct submission stores anything", async () => {
    const w = await calendarWorld({ cache: [sourceRow()], online: false });
    const dialog = await openFromRow(w);
    await choose(w, dialog, ICS, "old.ics");
    const held = heldFile(REPLACEMENT, "new.ics");
    const input = dialog.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { files: [held.file] } });
    });
    // The old file is no longer shown or importable; Import says why it waits.
    expect(within(dialog).getByText(words.READING)).toBeInTheDocument();
    expect(dialog.querySelector("[data-import-file]")).toBeNull();
    const importButton = within(dialog).getByRole("button", {
      name: words.IMPORT,
    });
    expect(importButton).toBeDisabled();
    expect(reasonOf(importButton)).toBe(words.WAIT_FOR_FILE);
    const form = dialog.querySelector("form") as HTMLFormElement;
    fireEvent.click(importButton);
    act(() => {
      form.requestSubmit();
    });
    fireEvent.submit(form);
    await w.settle();
    expect(drafts(w)).toEqual([]);
    expect(screen.queryByRole("dialog")).not.toBeNull();
    // Nothing is said to be missing either: the file is being read.
    expect(within(dialog).queryByText(words.FILE_REQUIRED)).toBeNull();
    // Once read, the NEW file is the one imported.
    await act(async () => held.release());
    await w.settle();
    expect(dialog.querySelector("[data-import-file]")?.textContent).toMatch(
      /new\.ics/,
    );
    press(dialog, words.IMPORT);
    await w.settle();
    expect(drafts(w)).toHaveLength(1);
    expect(bodyOf(w, drafts(w)[0]?.local_id as string)).toMatchObject({
      ics: REPLACEMENT,
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("R1 control: a replacement whose read completed is imported (and the earlier file is not)", async () => {
    const w = await calendarWorld({ cache: [sourceRow()], online: false });
    const dialog = await openFromRow(w);
    await choose(w, dialog, ICS, "old.ics");
    await choose(w, dialog, REPLACEMENT, "new.ics");
    press(dialog, words.IMPORT);
    await w.settle();
    expect(drafts(w)).toHaveLength(1);
    expect(bodyOf(w, drafts(w)[0]?.local_id as string)).toMatchObject({
      ics: REPLACEMENT,
    });
  });

  test("R3: a save that completes after the window was changed keeps the dialog with the newer window; the next Import is a new import of it", async () => {
    const w = await calendarWorld({ cache: [sourceRow()], online: false });
    const dialog = await openFromRow(w);
    await choose(w, dialog, ICS);
    const from = within(dialog).getByLabelText(words.FROM) as HTMLInputElement;
    const through = within(dialog).getByLabelText(
      words.THROUGH,
    ) as HTMLInputElement;
    fireEvent.change(from, { target: { value: "2026-11-01" } });
    fireEvent.change(through, { target: { value: "2026-12-31" } });
    const held = holdEnqueue(w);
    press(dialog, words.IMPORT);
    await w.settle();
    expect(drafts(w)).toHaveLength(1);
    fireEvent.change(from, { target: { value: "2026-11-03" } });
    await act(async () => held.release());
    await w.settle();
    expect(screen.queryByRole("dialog")).not.toBeNull();
    expect(from.value).toBe("2026-11-03");
    expect(within(dialog).getByText(words.IMPORT_QUEUED_NEWER)).toBeVisible();
    const first = drafts(w)[0] as DraftRow;
    expect(bodyOf(w, first.local_id)).toMatchObject({ from: "2026-11-01" });
    press(dialog, words.IMPORT);
    await w.settle();
    const stored = drafts(w);
    expect(stored).toHaveLength(2);
    const second = stored.find((d) => d.local_id !== first.local_id);
    expect(bodyOf(w, second?.local_id as string)).toMatchObject({
      from: "2026-11-03",
      through: "2026-12-31",
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("R3: changed and changed back while saving: still kept open, and Import again is a NEW import (a stored import's identity is spent)", async () => {
    const w = await calendarWorld({ cache: [sourceRow()], online: false });
    const dialog = await openFromRow(w);
    await choose(w, dialog, ICS);
    const from = within(dialog).getByLabelText(words.FROM) as HTMLInputElement;
    const original = from.value;
    const held = holdEnqueue(w);
    press(dialog, words.IMPORT);
    await w.settle();
    fireEvent.change(from, { target: { value: "2026-11-03" } });
    fireEvent.change(from, { target: { value: original } });
    await act(async () => held.release());
    await w.settle();
    expect(screen.queryByRole("dialog")).not.toBeNull();
    press(dialog, words.IMPORT);
    await w.settle();
    const stored = drafts(w);
    expect(stored).toHaveLength(2);
    expect(new Set(stored.map((d) => d.local_id)).size).toBe(2);
    expect(bodyOf(w, stored[1]?.local_id as string)).toEqual(
      bodyOf(w, stored[0]?.local_id as string),
    );
  });

  test("R3: a file chosen while the save is being made is kept too (the dialog stays with it)", async () => {
    const w = await calendarWorld({ cache: [sourceRow()], online: false });
    const dialog = await openFromRow(w);
    await choose(w, dialog, ICS, "old.ics");
    const held = holdEnqueue(w);
    press(dialog, words.IMPORT);
    await w.settle();
    await choose(w, dialog, REPLACEMENT, "new.ics");
    await act(async () => held.release());
    await w.settle();
    expect(screen.queryByRole("dialog")).not.toBeNull();
    expect(dialog.querySelector("[data-import-file]")?.textContent).toMatch(
      /new\.ics/,
    );
    expect(drafts(w)).toHaveLength(1);
    expect(bodyOf(w, drafts(w)[0]?.local_id as string)).toMatchObject({
      ics: ICS,
    });
  });

  test("R3 control: nothing changed while saving closes the dialog with the queued announcement", async () => {
    const w = await calendarWorld({ cache: [sourceRow()], online: false });
    const dialog = await openFromRow(w);
    await choose(w, dialog, ICS);
    const held = holdEnqueue(w);
    press(dialog, words.IMPORT);
    await w.settle();
    expect(screen.queryByRole("dialog")).not.toBeNull();
    await act(async () => held.release());
    await w.settle();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(announced()).toContain(words.IMPORT_QUEUED);
  });
});

describe("revision 1: every source can be chosen from the drop zone (R4)", () => {
  const many = (count: number, over: Partial<CacheRow> = {}) =>
    Array.from({ length: count }, (_, i) =>
      sourceRow({
        id: `00000000-0000-4000-8000-${String(i + 1000).padStart(12, "0")}`,
        label: `Calendar ${String(i).padStart(3, "0")}`,
        ...over,
      }),
    );
  async function dropped(w: World) {
    await screen.findByText(words.DROP_PROMPT);
    const zone = document.querySelector("[data-import-drop]") as HTMLElement;
    const input = zone.querySelector('input[type="file"]') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, {
        target: { files: [new File([ICS], "drop.ics")] },
      });
    });
    await w.settle();
    const dialog = await screen.findByRole("dialog");
    await waitFor(() =>
      expect(dialog.querySelector("[data-import-file]")).not.toBeNull(),
    );
    return dialog;
  }
  const options = (dialog: HTMLElement) =>
    [
      ...(within(dialog).getByLabelText(words.SOURCE) as HTMLSelectElement)
        .options,
    ].map((o) => o.textContent);

  test("101 sources: the 101st is reached with Show next calendars, chosen, and imported into; the choice survives paging back", async () => {
    const rows = many(101);
    const w = await calendarWorld({ cache: rows, online: false });
    const dialog = await dropped(w);
    expect(options(dialog)).toHaveLength(100);
    expect(options(dialog)).not.toContain("Calendar 100");
    fireEvent.click(
      present(
        within(dialog).queryByRole("button", { name: SHOW_NEXT_CALENDARS }),
      ),
    );
    await w.settle();
    // The chosen (first) source stays an option while page two is shown; paging alone changes nothing.
    expect(options(dialog)).toEqual(["Calendar 000", "Calendar 100"]);
    const select = within(dialog).getByLabelText(
      words.SOURCE,
    ) as HTMLSelectElement;
    expect(select.value).toBe(rows[0]?.id);
    fireEvent.change(select, { target: { value: rows[100]?.id } });
    await w.settle();
    fireEvent.click(
      present(
        within(dialog).queryByRole("button", { name: SHOW_PREVIOUS_CALENDARS }),
      ),
    );
    await w.settle();
    expect(select.value).toBe(rows[100]?.id);
    expect(options(dialog)).toHaveLength(101);
    press(dialog, words.IMPORT);
    await w.settle();
    expect(drafts(w)).toHaveLength(1);
    expect(drafts(w)[0]).toMatchObject({ target_id: rows[100]?.id });
  });

  test("100 view-only sources and an editable 101st: the drop zone is available and its dialog reaches the editable one", async () => {
    const rows = [
      ...many(100, { can_edit: false }),
      sourceRow({
        id: "00000000-0000-4000-8000-000000009999",
        label: "Zebra calendar",
      }),
    ];
    const w = await calendarWorld({ cache: rows, online: false });
    expect(
      await screen.findByRole("button", { name: words.BROWSE }),
    ).toBeEnabled();
    const dialog = await dropped(w);
    expect(
      within(dialog).getByRole("button", { name: words.IMPORT }),
    ).toBeDisabled();
    fireEvent.click(
      present(
        within(dialog).queryByRole("button", { name: SHOW_NEXT_CALENDARS }),
      ),
    );
    await w.settle();
    expect(options(dialog)).toEqual(["Zebra calendar"]);
    press(dialog, words.IMPORT);
    await w.settle();
    expect(drafts(w)[0]).toMatchObject({
      target_id: "00000000-0000-4000-8000-000000009999",
    });
  });

  test("control: two sources need no paging", async () => {
    const w = await calendarWorld({ cache: many(2), online: false });
    const dialog = await dropped(w);
    expect(options(dialog)).toEqual(["Calendar 000", "Calendar 001"]);
    expect(
      within(dialog).queryByRole("button", { name: SHOW_NEXT_CALENDARS }),
    ).toBeNull();
  });
});

describe("the Imports panel (headers only)", () => {
  const imported = (n: number, over: Partial<DraftRow> = {}) =>
    headerOf(
      draftRow({
        local_id: `imp-${n}`,
        created_seq: n,
        endpoint: IMPORT_ENDPOINT,
        kind: IMPORT_ENDPOINT,
        target_id: SOURCE,
        command: { ics: ICS, from: "2026-01-01", through: "2026-12-31" },
        target_resource_ids: [SOURCE],
        index_targets: [SOURCE],
        ...over,
      }),
    );

  test.each([
    ["queued", {}, [words.STATUS_QUEUED]],
    [
      "in flight, not yet answered",
      { status: "in_flight", attempts: 0 },
      [words.STATUS_QUEUED],
    ],
    [
      "in flight after a failed attempt",
      {
        status: "in_flight",
        attempts: 2,
        retry_state: { state: "backing_off", since: 1 },
      },
      [words.STATUS_SENT, words.STATUS_RETRYING],
    ],
    [
      "paused",
      {
        status: "in_flight",
        attempts: 9,
        retry_state: { state: "paused", since: 1 },
      },
      [words.STATUS_PAUSED],
    ],
    [
      "accepted",
      { status: "acknowledged", receipt_revision: 4 },
      [words.STATUS_ACCEPTED, words.STATUS_SYNCING],
    ],
    [
      "refused (an unsupported rule)",
      {
        status: "rejected",
        last_error: {
          status: 422,
          code: "unsupported_calendar_rule",
          stage: "rejected",
        },
      },
      [
        words.rejectedImport(
          words.IMPORT_REASONS.unsupported_calendar_rule as string,
        ),
      ],
    ],
    [
      "refused (stale refresh)",
      {
        status: "rejected",
        last_error: { status: 409, code: "stale_refresh", stage: "conflict" },
      },
      [words.rejectedImport(words.IMPORT_REASONS.stale_refresh as string)],
    ],
    [
      "refused with an earlier change",
      { status: "rejected", last_error: { stage: "dependency_rejected" } },
      [
        words.rejectedImport(
          words.IMPORT_REASONS.dependency_rejected as string,
        ),
      ],
    ],
    [
      "blocked (slice capacity)",
      { status: "blocked", blocked_reason: "slice_capacity" },
      [words.IMPORT_CAPACITY],
    ],
  ] as const)("%s", async (_, over, lines) => {
    await calendarWorld({
      cache: [sourceRow()],
      drafts: [imported(1, over as Partial<DraftRow>) as never],
    });
    const entry = (await screen.findByText(words.IMPORTS_HEADING))
      .closest("section")
      ?.querySelector("[data-import-draft]") as HTMLElement;
    expect(entry).toHaveTextContent("Family calendar");
    for (const line of lines) expect(entry).toHaveTextContent(line);
    expect(entry.textContent).not.toMatch(/imported|skipped/i);
    expect(entry.textContent).not.toContain("your account is full");
  });

  test("a refused import is dismissed (discarded) from the panel; a paused one links to the queue", async () => {
    const w = await calendarWorld({
      cache: [sourceRow()],
      drafts: [
        imported(1, {
          status: "rejected",
          last_error: { status: 422, code: "invalid_ics", stage: "rejected" },
        }) as never,
        imported(2, {
          status: "in_flight",
          attempts: 9,
          retry_state: { state: "paused", since: 1 },
        }) as never,
      ],
    });
    await screen.findByText(words.IMPORTS_HEADING);
    expect(
      screen.getByRole("link", { name: words.OPEN_QUEUE }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: words.DISMISS_IMPORT }));
    await w.settle();
    expect(drafts(w).map((d) => d.local_id)).toEqual(["imp-2"]);
    expect(announced()).toContain(copy.DISCARDED);
  });

  test("an import into a source the cache does not show names no source", async () => {
    await calendarWorld({
      cache: [],
      drafts: [
        imported(1, {
          target_id: "00000000-0000-4000-8000-0000000000ff",
          target_resource_ids: ["00000000-0000-4000-8000-0000000000ff"],
          index_targets: ["00000000-0000-4000-8000-0000000000ff"],
        }) as never,
      ],
    });
    const entry = (await screen.findByText(words.IMPORTS_HEADING))
      .closest("section")
      ?.querySelector("[data-import-draft]") as HTMLElement;
    expect(entry).toHaveTextContent(words.UNKNOWN_SOURCE);
  });
});

describe("E6: no list or status read loads an import's body", () => {
  test("the screen with a queued 600 KiB import reads its body from `draft_commands` never (rows, the action, the panel)", async () => {
    const w = await calendarWorld({ cache: [sourceRow()], online: false });
    const { importRequest } = await import(
      "../../../src/features/calendars/model/commands"
    );
    const big = `BEGIN:VCALENDAR\r\n${"X-PAD:".padEnd(600 * 1024, "x")}\r\nEND:VCALENDAR\r\n`;
    await act(async () => {
      const out = await w.env.outbox()?.enqueue(
        importRequest({
          sourceId: SOURCE,
          ics: big,
          from: "2026-01-01",
          through: "2026-12-31",
          continuity: historyOf(w),
        }),
      );
      expect(out?.kind).toBe("queued");
    });
    await w.settle();
    w.world.idb.reads.reset();
    await w.remount();
    await screen.findByText(words.IMPORTS_HEADING);
    await w.settle();
    expect(w.world.idb.reads.rows.get("draft_commands") ?? 0).toBe(0);
    // Control: the panel and the row did read the drafts' headers.
    expect(w.world.idb.reads.rows.get("drafts") ?? 0).toBeGreaterThan(0);
  });
});

/*
 * Review 15 R12 (revision 14): a component is counted on the content lines the server's parser reads, through EVERY way a file reaches
 * the dialog (the row's chooser, the drop zone's Browse, a page drop), with the count shown and the text queued exactly as chosen. The
 * texts and their counts are the pinned parser's corpus (`tests/support/ics-corpus.ts`).
 */
describe("review 15 R12: what the parser counts is what is shown, refused and queued", () => {
  const pressIn = (dialog: HTMLElement, name: string) =>
    fireEvent.click(present(within(dialog).queryByRole("button", { name })));
  const summaryOf = (dialog: HTMLElement) =>
    dialog.querySelector("[data-import-file]")?.textContent ?? "";
  const commands = (w: World) => w.rows("draft_commands");

  test("R12: a folded calendar header is a calendar: the row's Import queues it, the text unchanged", async () => {
    const w = await calendarWorld({ cache: [sourceRow()], online: false });
    const dialog = await openFromRow(w);
    const text = corpusText("header-folded-many");
    await choose(w, dialog, text, "folded.ics");
    expect(dialog).not.toHaveTextContent(
      words.FILE_PROBLEMS.not_calendar as string,
    );
    expect(summaryOf(dialog)).toMatch(/^folded\.ics · .+ · 1 event$/);
    pressIn(dialog, words.IMPORT);
    await w.settle();
    expect(drafts(w)).toHaveLength(1);
    const body = bodyOf(w, drafts(w)[0]?.local_id as string) as {
      ics: string;
    };
    expect(body.ics).toBe(text);
  });

  test("R12: 256 components however written are shown as 256 events and queued once by Enter, the text unchanged", async () => {
    const w = await calendarWorld({ cache: [sourceRow()], online: false });
    const dialog = await openFromRow(w);
    const text = corpusText("variants-256");
    expect(parserEvents("variants-256")).toBe(256);
    await choose(w, dialog, text, "mixed.ics");
    expect(summaryOf(dialog)).toMatch(/ · 256 events$/);
    act(() => {
      (dialog.querySelector("form") as HTMLFormElement).requestSubmit();
    });
    await w.settle();
    expect(drafts(w)).toHaveLength(1);
    expect(bodyOf(w, drafts(w)[0]?.local_id as string)).toMatchObject({
      ics: text,
    });
  });

  test("R12: 257 folded components are refused before anything is stored, by the button and by Enter; an earlier import is untouched", async () => {
    const w = await calendarWorld({ cache: [sourceRow()], online: false });
    const first = await openFromRow(w);
    await choose(w, first, ICS);
    pressIn(first, words.IMPORT);
    await w.settle();
    expect(drafts(w)).toHaveLength(1);
    const before = { drafts: drafts(w), commands: commands(w) };

    const dialog = await openFromRow(w);
    expect(parserEvents("events-folded-257")).toBe(257);
    await choose(w, dialog, corpusText("events-folded-257"), "over.ics");
    expect(dialog).toHaveTextContent(
      words.FILE_PROBLEMS.too_many_events as string,
    );
    expect(summaryOf(dialog)).toBe("over.ics");
    pressIn(dialog, words.IMPORT);
    await w.settle();
    act(() => {
      (dialog.querySelector("form") as HTMLFormElement).requestSubmit();
    });
    await w.settle();
    expect(drafts(w)).toEqual(before.drafts);
    expect(commands(w)).toEqual(before.commands);
    expect(w.calls).toEqual([]);
    expect(screen.queryByRole("dialog")).not.toBeNull();
  });

  test.each([
    ["Browse", "events-folded-257", null],
    ["Browse", "header-folded-tab", 1],
    ["a page drop", "variants-257", null],
    ["a page drop", "overrides-folded", 3],
  ] as const)(
    "R12: the drop zone's %s checks %s the same way",
    async (way, name, events) => {
      const w = await calendarWorld({ cache: [sourceRow()], online: false });
      await screen.findByText(words.DROP_PROMPT);
      const zone = present(document.querySelector("[data-import-drop]"));
      const text = corpusText(name);
      const file = new File([text], `${name}.ics`, { type: "text/calendar" });
      await act(async () => {
        if (way === "Browse")
          fireEvent.change(present(zone.querySelector('input[type="file"]')), {
            target: { files: [file] },
          });
        else fireEvent.drop(zone, { dataTransfer: { files: [file] } });
      });
      await w.settle();
      const dialog = present(screen.queryByRole("dialog"));
      await waitFor(() =>
        expect(dialog.querySelector("[data-import-file]")).not.toBeNull(),
      );
      pressIn(dialog, words.IMPORT);
      await w.settle();
      if (events === null) {
        expect(dialog).toHaveTextContent(
          words.FILE_PROBLEMS.too_many_events as string,
        );
        expect(drafts(w)).toEqual([]);
        expect(commands(w)).toEqual([]);
      } else {
        expect(parserEvents(name)).toBe(events);
        expect(drafts(w)).toHaveLength(1);
        expect(bodyOf(w, drafts(w)[0]?.local_id as string)).toMatchObject({
          ics: text,
        });
      }
    },
  );

  test("R12: a 256-event file still being read when a 257-event folded one replaces it: only the newer is shown, and nothing is stored", async () => {
    const w = await calendarWorld({ cache: [sourceRow()], online: false });
    const dialog = await openFromRow(w);
    const input = present(dialog.querySelector('input[type="file"]'));
    const held = heldFile(corpusText("events-folded-256"), "held.ics");
    await act(async () => {
      fireEvent.change(input, { target: { files: [held.file] } });
    });
    await choose(w, dialog, corpusText("variants-257"), "newer.ics");
    await act(async () => {
      held.release();
    });
    await w.settle();
    expect(summaryOf(dialog)).toBe("newer.ics");
    expect(dialog).toHaveTextContent(
      words.FILE_PROBLEMS.too_many_events as string,
    );
    pressIn(dialog, words.IMPORT);
    await w.settle();
    expect(drafts(w)).toEqual([]);
    // Control: the 256-event file chosen again is shown with its count and imported.
    await choose(w, dialog, corpusText("events-folded-256"), "again.ics");
    expect(summaryOf(dialog)).toMatch(/^again\.ics · .+ · 256 events$/);
    pressIn(dialog, words.IMPORT);
    await w.settle();
    expect(drafts(w)).toHaveLength(1);
  });
});
