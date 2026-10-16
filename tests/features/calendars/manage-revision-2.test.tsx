import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { DraftRow, EnqueueRequest } from "../../../src/data";
import * as copy from "../../../src/features/calendars/copy";
import {
  configureSourceRequest,
  createSourceRequest,
  importRequest,
} from "../../../src/features/calendars/model/commands";
import { StampedRequestError } from "../../../src/session";
import { installMatchMedia } from "../../helpers/match-media";
import {
  type CalendarWorld,
  calendarWorld,
  DB,
  sourceRow,
  type WireReply,
} from "../../support/calendars";

/**
 * WEB-13a revision 2 (review r1 R6–R8 and the design assessment's schedules S1–S16), through the PRODUCTION screen, controller, plans
 * and outbox facade over the double of IndexedDB, with a recorded typed client. Every forced order is made explicit: a publication is
 * ONE transaction (`commit`, the cache row, the version record and the retired create at once, as a delta page writes them), another
 * tab's save is made between Save and its transaction, an answer is HELD until the test releases it. Each schedule has its control.
 * FIXTURE evidence (jsdom); the native counterparts are E-CAL9 to E-CAL11.
 */
installMatchMedia({ width: 1440 });
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await new Promise((resolve) => setTimeout(resolve, 0));
});

const SOURCE = sourceRow().id;
const TOKYO = { ...(sourceRow().value ?? {}), timezone: "Asia/Tokyo" };
const polite = () =>
  document.querySelector('[aria-live="polite"]')?.textContent ?? "";
const reasonOf = (element: HTMLElement) =>
  document.getElementById(element.getAttribute("aria-describedby") ?? "")
    ?.textContent;
const press = (dialog: HTMLElement, name: string) =>
  fireEvent.click(within(dialog).getByRole("button", { name }));
const commands = (w: CalendarWorld) =>
  w.calls.filter(
    (call) => call.method === "POST" && call.path === "/calendar-commands",
  );
/** The queued settings changes, in the order they were saved (`created_seq`, never store order), joined to their bodies. */
const configures = (w: CalendarWorld) => {
  const bodies = new Map(
    (
      w.rows("draft_commands") as Array<{ local_id: string; command: unknown }>
    ).map((row) => [row.local_id, row.command]),
  );
  return [...(w.rows("drafts") as DraftRow[])]
    .filter((draft) => draft.kind === "configure_source")
    .sort((a, b) => a.created_seq - b.created_seq)
    .map((draft) => ({
      draft,
      command: (
        bodies.get(draft.local_id) as { command: Record<string, unknown> }
      ).command,
    }));
};

async function openManage(w: CalendarWorld, label = "Family calendar") {
  fireEvent.click(
    await screen.findByRole("button", { name: `Manage ${label}` }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: copy.manageTitle(label),
  });
  await w.settle();
  return dialog;
}

async function enqueue(w: CalendarWorld, request: EnqueueRequest) {
  let localId = "";
  await act(async () => {
    const outcome = await w.env.outbox()?.enqueue(request);
    if (outcome?.kind !== "queued") throw new Error("setup: not queued");
    localId = outcome.localId;
  });
  await w.settle();
  return localId;
}

/** This device's create of the source, queued and not sent (offline, or before a leader runs), and Manage opened on its pending row. */
async function pendingManage(w: CalendarWorld, timezone = "Europe/London") {
  const create = await enqueue(
    w,
    createSourceRequest({ id: SOURCE, label: "Family calendar", timezone }),
  );
  expect(document.querySelector("[data-pending-source]")).not.toBeNull();
  return { create, dialog: await openManage(w) };
}

/** The source published at version 4 in ONE transaction: the cache row, the version the outbox assumes, and (when named) the retired create. */
const publish = (
  w: CalendarWorld,
  options: { retire?: string; row?: Parameters<typeof sourceRow>[0] } = {},
) =>
  w.commit({
    put: {
      store: "cache",
      rows: [sourceRow({ version: 4, value: TOKYO, ...options.row })],
    },
    versions: [
      { resource_id: SOURCE, locally_assumed_version: 4, basis: "resource" },
    ],
    ...(options.retire === undefined ? {} : { retire: [options.retire] }),
  });

/** The field, or null when the dialog no longer shows it (an assertion then fails on its value, never a lookup error). */
const timezoneField = (dialog: HTMLElement) =>
  (within(dialog).queryByLabelText(copy.TIMEZONE) as HTMLInputElement | null) ??
  ({ value: null } as unknown as HTMLInputElement);
const enabledBox = (dialog: HTMLElement) =>
  within(dialog).getByLabelText(copy.ENABLED) as HTMLInputElement;

describe("R6: a pending source's Manage follows its source through publication (S1–S4)", () => {
  test.each([
    ["Enabled", { timezone: "Asia/Tokyo", enabled: false }],
    ["Timezone", { timezone: "UTC", enabled: true }],
  ] as const)(
    "published and its create retired at once: Manage stays open as the CACHED source's, and a change of %s keeps the other published value",
    async (dirty, expected) => {
      const w = await calendarWorld({ online: false });
      const { create, dialog } = await pendingManage(w);
      expect(timezoneField(dialog).value).toBe("Europe/London");
      expect(
        reasonOf(within(dialog).getByRole("button", { name: copy.REMOVE })),
      ).toBe(copy.NOT_CREATED_REASON);
      await publish(w, { retire: create });
      expect(document.querySelector("[data-pending-source]")).toBeNull();
      expect(screen.queryByRole("dialog")).toBe(dialog);
      // Promoted: the published values, and the cached rules (the connection actions are now the source's; offline they need a connection).
      expect(timezoneField(dialog).value).toBe("Asia/Tokyo");
      expect(
        reasonOf(within(dialog).getByRole("button", { name: copy.REMOVE })),
      ).toBe(copy.NEEDS_CONNECTION);
      if (dirty === "Enabled") fireEvent.click(enabledBox(dialog));
      else
        fireEvent.change(timezoneField(dialog), { target: { value: "UTC" } });
      press(dialog, copy.SAVE);
      await w.settle();
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      const [saved, ...more] = configures(w);
      expect(more).toEqual([]);
      expect(saved?.command).toEqual({
        kind: "configure_source",
        id: SOURCE,
        expected_version: 4,
        ...expected,
      });
    },
  );

  test("control: Manage opened on the cached source at the outset, the same publication, the same change", async () => {
    const w = await calendarWorld({ online: false, cache: [sourceRow()] });
    const dialog = await openManage(w);
    expect(timezoneField(dialog).value).toBe("Europe/Vienna");
    await publish(w);
    expect(timezoneField(dialog).value).toBe("Asia/Tokyo");
    fireEvent.click(enabledBox(dialog));
    press(dialog, copy.SAVE);
    await w.settle();
    expect(configures(w).map((c) => c.command)).toEqual([
      {
        kind: "configure_source",
        id: SOURCE,
        expected_version: 4,
        timezone: "Asia/Tokyo",
        enabled: false,
      },
    ]);
  });

  test("published while the create is still in the outbox (receipted, not yet retired): promoted too, its connection waits for the create", async () => {
    const w = await calendarWorld({ online: true });
    const { dialog } = await pendingManage(w);
    await publish(w);
    expect(timezoneField(dialog).value).toBe("Asia/Tokyo");
    expect(
      reasonOf(within(dialog).getByRole("button", { name: copy.REMOVE })),
    ).toBe(copy.WAITING_CHANGES_FIRST);
    fireEvent.click(enabledBox(dialog));
    press(dialog, copy.SAVE);
    await w.settle();
    expect(configures(w).map((c) => c.command.timezone)).toEqual([
      "Asia/Tokyo",
    ]);
  });

  test("control: a create still pending stays pending through other writes (another source published), and its change waits for it", async () => {
    const w = await calendarWorld({ online: false });
    const { create, dialog } = await pendingManage(w);
    await w.commit({
      put: {
        store: "cache",
        rows: [
          sourceRow({
            id: "00000000-0000-4000-8000-0000000000b2",
            label: "Other",
          }),
        ],
      },
    });
    expect(screen.queryByRole("dialog")).toBe(dialog);
    expect(timezoneField(dialog).value).toBe("Europe/London");
    fireEvent.click(enabledBox(dialog));
    press(dialog, copy.SAVE);
    await w.settle();
    const [saved] = configures(w);
    expect(saved?.command).toMatchObject({
      expected_version: 1,
      timezone: "Europe/London",
      enabled: false,
    });
    expect(saved?.draft.depends_on).toEqual([create]);
  });

  test("the pending create is edited elsewhere (no version change): Manage shows the create as it is NOW, not as it was opened", async () => {
    const w = await calendarWorld({ online: false });
    const { create, dialog } = await pendingManage(w);
    await act(async () => {
      const outcome = await w.env.outbox()?.editQueued(
        create,
        createSourceRequest({
          id: SOURCE,
          label: "Family calendar",
          timezone: "America/New_York",
          localId: create,
        }),
      );
      expect(outcome?.kind).toBe("edited");
    });
    await w.settle();
    expect(timezoneField(dialog).value).toBe("America/New_York");
  });

  test("the pending create is discarded: Manage closes and says the source can no longer be shown (the opening row is not reused)", async () => {
    const w = await calendarWorld({ online: false });
    const { create } = await pendingManage(w);
    await act(async () => {
      await w.env.outbox()?.discard(create);
    });
    await w.settle();
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(polite()).toBe(copy.MANAGE_CLOSED_GONE));
    expect(configures(w)).toEqual([]);
  });

  test("once promoted it is cache content: the cache being brought up to date closes it", async () => {
    const w = await calendarWorld({ online: false });
    const { create } = await pendingManage(w);
    await publish(w, { retire: create });
    const valid = (w.snapshot()?.sync_state?.[0] ?? {}) as Record<
      string,
      unknown
    >;
    await w.commit({
      put: {
        store: "sync_state",
        rows: [
          {
            ...valid,
            cache_status: "invalid",
            recovery_generation: Number(valid.recovery_generation ?? 0) + 1,
          },
        ],
      },
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.textContent).not.toContain("Asia/Tokyo");
    await waitFor(() => expect(polite()).toBe(copy.MANAGE_CLOSED_REFRESHING));
  });

  test.each([
    ["retired", true],
    ["still in the outbox", false],
  ])(
    "once promoted it never falls back to pending: the source leaves the cache (its create %s) and Manage closes",
    async (_case, retire) => {
      const w = await calendarWorld({ online: false });
      const { create } = await pendingManage(w);
      await publish(w, retire ? { retire: create } : {});
      expect(
        timezoneField(screen.queryByRole("dialog") ?? document.body).value,
      ).toBe("Asia/Tokyo");
      await w.commit({ remove: [SOURCE] });
      expect(screen.queryByRole("dialog")).toBeNull();
      await waitFor(() => expect(polite()).toBe(copy.MANAGE_CLOSED_GONE));
    },
  );
});

describe("the values a Save restates come from ONE read and are checked in its transaction (S6–S8, A1)", () => {
  test("a settings change queued before an import still decides Manage's values and the row's (S7)", async () => {
    const w = await calendarWorld({ online: false, cache: [sourceRow()] });
    await enqueue(
      w,
      configureSourceRequest(sourceRow(), {
        timezone: "Asia/Tokyo",
        enabled: true,
      }),
    );
    await enqueue(
      w,
      importRequest({
        sourceId: SOURCE,
        ics: "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n",
        from: "2026-01-01",
        through: "2026-12-31",
      }),
    );
    const row = (await screen.findByText("Family calendar")).closest(
      "li",
    ) as HTMLElement;
    expect(row).toHaveTextContent("Asia/Tokyo");
    const dialog = await openManage(w);
    expect(timezoneField(dialog).value).toBe("Asia/Tokyo");
    fireEvent.click(enabledBox(dialog));
    press(dialog, copy.SAVE);
    await w.settle();
    expect(configures(w).map((c) => c.command)).toEqual([
      expect.objectContaining({ timezone: "Asia/Tokyo", enabled: true }),
      expect.objectContaining({
        expected_version: 4,
        timezone: "Asia/Tokyo",
        enabled: false,
      }),
    ]);
  });

  test("another tab saves between Save and its transaction (S6/S8): nothing is stored, the person sees the new values, and their own edit is kept", async () => {
    const w = await calendarWorld({ online: false, cache: [sourceRow()] });
    const dialog = await openManage(w);
    fireEvent.click(enabledBox(dialog));
    const outbox = w.env.outbox();
    if (outbox === null) throw new Error("setup");
    const real = outbox.enqueue.bind(outbox);
    vi.spyOn(outbox, "enqueue").mockImplementationOnce(async (request) => {
      // The other tab's change commits first (the dialog has not re-read yet): the version moves from 3 to 4 and the timezone to Tokyo.
      await real(
        configureSourceRequest(sourceRow(), {
          timezone: "Asia/Tokyo",
          enabled: true,
        }),
      );
      return real(request);
    });
    press(dialog, copy.SAVE);
    await w.settle();
    expect(screen.queryByRole("dialog")).toBe(dialog);
    expect(within(dialog).queryByText(copy.NOT_SAVED_CHANGED)).not.toBeNull();
    expect(configures(w).map((c) => c.command)).toEqual([
      expect.objectContaining({ timezone: "Asia/Tokyo", enabled: true }),
    ]);
    // The untouched field follows the other tab's value; the edited one keeps what the person chose. Saving again is deliberate.
    expect(timezoneField(dialog).value).toBe("Asia/Tokyo");
    expect(enabledBox(dialog).checked).toBe(false);
    press(dialog, copy.SAVE);
    await w.settle();
    expect(configures(w).map((c) => c.command)).toEqual([
      expect.objectContaining({ timezone: "Asia/Tokyo", enabled: true }),
      {
        kind: "configure_source",
        id: SOURCE,
        expected_version: 4,
        timezone: "Asia/Tokyo",
        enabled: false,
      },
    ]);
  });

  test("control: nothing changes between Save and its transaction, ONE change is stored", async () => {
    const w = await calendarWorld({ online: false, cache: [sourceRow()] });
    const dialog = await openManage(w);
    fireEvent.click(enabledBox(dialog));
    press(dialog, copy.SAVE);
    await w.settle();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(configures(w).map((c) => c.command)).toEqual([
      expect.objectContaining({
        expected_version: 3,
        timezone: "Europe/Vienna",
        enabled: false,
      }),
    ]);
  });
});

describe("R7: every route that saves is admitted by the rule that disables Save (S9, S10, S15)", () => {
  const form = (dialog: HTMLElement) =>
    dialog.querySelector("form") as HTMLFormElement;
  const save = (dialog: HTMLElement) =>
    within(dialog).getByRole("button", { name: copy.SAVE });

  async function removed(w: CalendarWorld) {
    const dialog = await openManage(w);
    press(dialog, copy.REMOVE);
    press(dialog, copy.REMOVE_SUBMIT);
    await w.settle();
    expect(dialog.querySelector("[data-connection-panel]")).toBeNull();
    return dialog;
  }

  test("after Remove, while the cache has not caught up: the disabled Save is still the form's submit button, and a submission saves nothing", async () => {
    const w = await calendarWorld({ cache: [sourceRow()] });
    const dialog = await removed(w);
    expect(save(dialog)).toBeDisabled();
    expect(reasonOf(save(dialog))).toBe(copy.WAITING_LAST_CHANGE);
    // A disabled default button is what stops the Enter key's implicit submission in a browser (E-CAL10 presses it natively).
    expect(save(dialog)).toHaveAttribute("type", "submit");
    expect(save(dialog).getAttribute("form")).toBe(form(dialog).id);
    fireEvent.change(timezoneField(dialog), { target: { value: "UTC" } });
    fireEvent.submit(form(dialog));
    await w.settle();
    expect(configures(w)).toEqual([]);
    expect(screen.queryByRole("dialog")).toBe(dialog);
    // Control: the cache catches up, and the same submission saves ONE change on the new version.
    await publish(w, { row: { value: sourceRow().value } });
    expect(save(dialog)).toBeEnabled();
    fireEvent.submit(form(dialog));
    await w.settle();
    expect(configures(w).map((c) => c.command)).toEqual([
      expect.objectContaining({ expected_version: 4, timezone: "UTC" }),
    ]);
  });

  test("the wait outlives Manage (D-13a-8): closed and reopened before the cache catches up, Save still waits and a submission saves nothing", async () => {
    const w = await calendarWorld({ cache: [sourceRow()] });
    const first = await removed(w);
    press(first, copy.CANCEL);
    expect(screen.queryByRole("dialog")).toBeNull();
    const dialog = await openManage(w);
    expect(reasonOf(save(dialog))).toBe(copy.WAITING_LAST_CHANGE);
    fireEvent.change(timezoneField(dialog), { target: { value: "UTC" } });
    fireEvent.submit(form(dialog));
    await w.settle();
    expect(configures(w)).toEqual([]);
    // Control: the cache catches up, and the reopened Manage saves on the new version.
    await publish(w, { row: { value: sourceRow().value } });
    fireEvent.submit(form(dialog));
    await w.settle();
    expect(configures(w).map((c) => c.command)).toEqual([
      expect.objectContaining({ expected_version: 4, timezone: "UTC" }),
    ]);
  });

  test("while the Remove request is being sent: Save says so, and a submission saves nothing; its answer then holds Save as before", async () => {
    const w = await calendarWorld({ cache: [sourceRow()] });
    const dialog = await openManage(w);
    let answer: (reply: WireReply) => void = () => undefined;
    w.replies.set("/calendar-commands", [
      {
        wait: new Promise<WireReply>((resolve) => {
          answer = resolve;
        }),
      },
    ]);
    press(dialog, copy.REMOVE);
    press(dialog, copy.REMOVE_SUBMIT);
    await w.settle();
    expect(commands(w)).toHaveLength(1);
    expect(reasonOf(save(dialog))).toBe(copy.WAITING_CONNECTION_CHANGE);
    fireEvent.submit(form(dialog));
    await w.settle();
    expect(configures(w)).toEqual([]);
    await act(async () => answer({ status: 200, json: { revision: 9 } }));
    await w.settle();
    expect(reasonOf(save(dialog))).toBe(copy.WAITING_LAST_CHANGE);
    fireEvent.submit(form(dialog));
    await w.settle();
    expect(configures(w)).toEqual([]);
  });

  test("two submissions before the screen updates save ONE change (a synchronous latch, not the busy state alone)", async () => {
    const w = await calendarWorld({ online: false, cache: [sourceRow()] });
    const dialog = await openManage(w);
    const outbox = w.env.outbox();
    if (outbox === null) throw new Error("setup");
    const spy = vi.spyOn(outbox, "enqueue");
    fireEvent.change(timezoneField(dialog), { target: { value: "UTC" } });
    act(() => {
      fireEvent.submit(form(dialog));
      fireEvent.submit(form(dialog));
    });
    await w.settle();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(configures(w)).toHaveLength(1);
  });

  test("the source becomes view-only while Manage is open (S15): Save and the connection actions stop, with the reason, and a submission saves nothing", async () => {
    const w = await calendarWorld({ cache: [sourceRow()] });
    const dialog = await openManage(w);
    expect(save(dialog)).toBeEnabled();
    await w.commit({
      put: { store: "cache", rows: [sourceRow({ can_edit: false })] },
    });
    expect(reasonOf(save(dialog))).toBe(copy.VIEW_ONLY_REASON);
    expect(
      reasonOf(within(dialog).getByRole("button", { name: copy.REPLACE })),
    ).toBe(copy.VIEW_ONLY_REASON);
    fireEvent.change(timezoneField(dialog), { target: { value: "UTC" } });
    fireEvent.submit(form(dialog));
    await w.settle();
    expect(configures(w)).toEqual([]);
  });

  test("Add source: two submissions before the screen updates save once", async () => {
    const w = await calendarWorld({ online: false });
    fireEvent.click(screen.getByRole("button", { name: copy.ADD_SOURCE }));
    const dialog = await screen.findByRole("dialog", { name: copy.ADD_TITLE });
    const outbox = w.env.outbox();
    if (outbox === null) throw new Error("setup");
    const spy = vi.spyOn(outbox, "enqueue");
    fireEvent.change(within(dialog).getByLabelText(copy.LABEL), {
      target: { value: "Rota" },
    });
    act(() => {
      fireEvent.submit(form(dialog));
      fireEvent.submit(form(dialog));
    });
    await w.settle();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test("Link a calendar…: two submissions before the screen updates send once", async () => {
    const w = await calendarWorld();
    fireEvent.click(screen.getByRole("button", { name: copy.LINK_CALENDAR }));
    const dialog = await screen.findByRole("dialog", { name: copy.LINK_TITLE });
    await w.settle();
    fireEvent.change(within(dialog).getByLabelText(copy.LABEL), {
      target: { value: "Work" },
    });
    fireEvent.change(within(dialog).getByLabelText(copy.URL_LABEL), {
      target: { value: "https://calendar.example.test/work.ics" },
    });
    act(() => {
      fireEvent.submit(form(dialog));
      fireEvent.submit(form(dialog));
    });
    await w.settle();
    expect(commands(w)).toHaveLength(1);
  });
});

describe("a late answer belongs to the form that sent it (S10, S13)", () => {
  const held = (w: CalendarWorld) => {
    let release: (reply: WireReply) => void = () => undefined;
    w.replies.set("/calendar-commands", [
      {
        wait: new Promise<WireReply>((resolve) => {
          release = resolve;
        }),
      },
    ]);
    return (reply: WireReply) => release(reply);
  };

  test("Remove's answer arrives after its panel was closed and another opened: the change is recorded, the new panel stays open", async () => {
    const w = await calendarWorld({ cache: [sourceRow()] });
    const dialog = await openManage(w);
    const release = held(w);
    press(dialog, copy.REMOVE);
    press(dialog, copy.REMOVE_SUBMIT);
    await w.settle();
    press(dialog, copy.CLOSE_PANEL);
    press(dialog, copy.REMOVE);
    expect(within(dialog).queryByText(copy.REMOVE_CONFIRM)).not.toBeNull();
    await act(async () => release({ status: 200, json: { revision: 9 } }));
    await w.settle();
    expect(within(dialog).queryByText(copy.REMOVE_CONFIRM)).not.toBeNull();
    await waitFor(() => expect(polite()).toBe(copy.REMOVED));
    expect(
      reasonOf(within(dialog).getByRole("button", { name: copy.SAVE })),
    ).toBe(copy.WAITING_LAST_CHANGE);
  });

  test("Link's answer arrives after it was cancelled and Add source opened: Add stays open; the link is announced", async () => {
    const w = await calendarWorld();
    fireEvent.click(screen.getByRole("button", { name: copy.LINK_CALENDAR }));
    const link = await screen.findByRole("dialog", { name: copy.LINK_TITLE });
    await w.settle();
    fireEvent.change(within(link).getByLabelText(copy.LABEL), {
      target: { value: "Work" },
    });
    fireEvent.change(within(link).getByLabelText(copy.URL_LABEL), {
      target: { value: "https://calendar.example.test/work.ics" },
    });
    const release = held(w);
    press(link, copy.CONNECT);
    await w.settle();
    press(link, copy.CANCEL);
    fireEvent.click(screen.getByRole("button", { name: copy.ADD_SOURCE }));
    const add = await screen.findByRole("dialog", { name: copy.ADD_TITLE });
    await act(async () => release({ status: 200, json: { revision: 9 } }));
    await w.settle();
    expect(screen.queryByRole("dialog", { name: copy.ADD_TITLE })).toBe(add);
    await waitFor(() => expect(polite()).toBe(copy.LINKED));
  });

  /**
   * WEB-08d revision 20 (review r19 C1): the FIRST `not_sent` answer is held until the waiting change is durable and Manage shows its
   * guard, then released. Without that order the 50 ms retries ran while the change was still being written (legal admissions, before
   * the guard), and they counted against the one admission this test allows. The total still counts from the original press; only
   * the order is fixed. The change is written with its commit prompt and, separately, with its commit held by the engine; the control
   * (nothing queued) is released at the same point and keeps asking.
   */
  test("a Remove waiting to be sent is not admitted again once the source has a waiting change (S13); its control keeps asking", async () => {
    const pause = (ms: number) =>
      act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const notSent = (): WireReply => ({
      throws: new StampedRequestError("not_sent"),
    });
    const removeOf = (dialog: HTMLElement) =>
      within(dialog).getByRole("button", { name: copy.REMOVE });
    const submitOf = (dialog: HTMLElement) =>
      within(dialog).getByRole("button", { name: copy.REMOVE_SUBMIT });
    for (const schedule of ["nothing queued", "commit", "held commit"]) {
      const queued = schedule !== "nothing queued";
      const w = await calendarWorld({ cache: [sourceRow()] });
      const dialog = await openManage(w);
      let release: (reply: WireReply) => void = () => undefined;
      w.replies.set("/calendar-commands", [
        {
          wait: new Promise<WireReply>((resolve) => {
            release = resolve;
          }),
        },
        ...Array.from({ length: 12 }, notSent),
      ]);
      try {
        expect(reasonOf(removeOf(dialog)), schedule).toBeUndefined();
        press(dialog, copy.REMOVE);
        press(dialog, copy.REMOVE_SUBMIT);
        expect(commands(w), schedule).toHaveLength(1);
        await w.settle();
        expect(reasonOf(submitOf(dialog)), schedule).toBe("Working…");
        if (queued) {
          if (schedule === "held commit")
            w.world.idb.inject({
              match: (tx) => tx.label === "data.enqueueDraft",
              mode: "stall_commit",
              times: 1,
            });
          let localId = "";
          await act(async () => {
            const outcome = w.env.outbox()?.enqueue(
              configureSourceRequest(sourceRow(), {
                timezone: "UTC",
                enabled: true,
              }),
            );
            if (schedule === "held commit") {
              await waitFor(() =>
                expect(w.world.idb.hasStalledCommit(DB)).toBe(true),
              );
              // Not durable yet: no row, and nothing has been admitted while the commit is outstanding.
              expect(w.rows("drafts"), schedule).toHaveLength(0);
              expect(w.world.idb.completeStalled(DB), schedule).toBe(true);
            }
            const result = await outcome;
            if (result?.kind !== "queued") throw new Error("setup: not queued");
            localId = result.localId;
          });
          await w.settle();
          // The change is durable and Manage shows it before the held answer is released.
          expect(
            configures(w).map(({ draft }) => draft.local_id),
            schedule,
          ).toEqual([localId]);
          await waitFor(() =>
            expect(reasonOf(removeOf(dialog))).toBe(copy.WAITING_CHANGES_FIRST),
          );
        } else {
          // Control: no waiting change, so Manage still allows Remove at the same point.
          expect(reasonOf(removeOf(dialog)), schedule).toBeUndefined();
        }
        expect(commands(w), schedule).toHaveLength(1);
        await act(async () => release(notSent()));
        await pause(500);
        if (queued) {
          expect(commands(w), schedule).toHaveLength(1);
          // The released answer was consumed and the attempt ended: the control now gives the guard, not "Working…".
          expect(reasonOf(submitOf(dialog)), schedule).toBe(
            copy.WAITING_CHANGES_FIRST,
          );
        } else expect(commands(w).length, schedule).toBeGreaterThan(2);
      } finally {
        release(notSent());
        cleanup();
      }
    }
  });
});

describe("R8: connection details are entered online only (S11)", () => {
  async function open(w: CalendarWorld, mode: "link" | "replace") {
    if (mode === "link") {
      fireEvent.click(screen.getByRole("button", { name: copy.LINK_CALENDAR }));
      const dialog = await screen.findByRole("dialog", {
        name: copy.LINK_TITLE,
      });
      await w.settle();
      fireEvent.change(within(dialog).getByLabelText(copy.LABEL), {
        target: { value: "Work" },
      });
      return dialog;
    }
    const dialog = await openManage(w);
    press(dialog, copy.REPLACE);
    return dialog;
  }

  test.each(["link", "replace"] as const)(
    "%s: offline both fields are disabled with the reason and take no change; back online what was entered is still there and nothing was sent",
    async (mode) => {
      const w = await calendarWorld({ cache: [sourceRow()] });
      const dialog = await open(w, mode);
      const url = within(dialog).getByLabelText(
        copy.URL_LABEL,
      ) as HTMLInputElement;
      const bearer = within(dialog).getByLabelText(
        copy.BEARER_LABEL,
      ) as HTMLInputElement;
      // Control: online, both take entry.
      expect(url).toBeEnabled();
      expect(bearer).toBeEnabled();
      fireEvent.change(url, {
        target: { value: "https://calendar.example.test/a.ics" },
      });
      fireEvent.change(bearer, { target: { value: "token-a" } });
      await act(async () => w.online.set(false));
      await w.settle();
      for (const field of [url, bearer]) {
        expect(field).toBeDisabled();
        expect(field).toHaveAccessibleDescription(copy.NEEDS_CONNECTION);
      }
      // A change that arrives anyway is not taken: the field shows what was entered before.
      fireEvent.change(url, {
        target: { value: "https://calendar.example.test/offline.ics" },
      });
      fireEvent.change(bearer, { target: { value: "token-offline" } });
      expect(url.value).toBe("https://calendar.example.test/a.ics");
      expect(bearer.value).toBe("token-a");
      await act(async () => w.online.set(true));
      await w.settle();
      expect(url).toBeEnabled();
      expect(bearer).toBeEnabled();
      expect(url.value).toBe("https://calendar.example.test/a.ics");
      // Reconnecting sends nothing by itself.
      expect(commands(w)).toEqual([]);
      press(dialog, mode === "link" ? copy.CONNECT : copy.REPLACE_SUBMIT);
      await w.settle();
      expect(commands(w)).toHaveLength(1);
      expect(
        (commands(w)[0]?.body as { command?: { connection?: unknown } })
          ?.command?.connection,
      ).toEqual({
        url: "https://calendar.example.test/a.ics",
        bearer: "token-a",
      });
    },
  );
});
