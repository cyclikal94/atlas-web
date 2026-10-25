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
import type { DraftRow } from "../../../src/data";
import * as copy from "../../../src/features/calendars/copy";
import * as words from "../../../src/features/calendars/copy-import";
import { IMPORT_ENDPOINT } from "../../../src/features/calendars/model/commands";
import { installMatchMedia } from "../../helpers/match-media";
import { calendarWorld, sourceRow } from "../../support/calendars";
import { draftRow, headerOf } from "../../support/data/rows";

/**
 * WEB-13b §4.2 (Q22 "file imports"; the wireframe's import panels): the row's "Import events", the page's drop zone, the import dialog
 * and the Imports panel, through the PRODUCTION controller, plans and outbox facade over the double of IndexedDB. FIXTURE evidence (jsdom):
 * the native specs (E-IMP1..5) cover real engines, layout and the network.
 */
installMatchMedia({ width: 1440 });
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
