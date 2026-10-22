import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { act } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as copy from "../../../src/features/calendars/copy";
import {
  buildSnapshot,
  SensitiveFieldError,
} from "../../../src/lib/form-recovery/guard";
import { StampedRequestError } from "../../../src/session";
import { installMatchMedia } from "../../helpers/match-media";
import {
  atlasBody,
  type CalendarWorld,
  calendarWorld,
  sourceRow,
} from "../../support/calendars";

/**
 * The ONLINE-ONLY connection forms (WEB-13a, D-13a-7, case 5): Link a calendar…, and Manage's Replace… and Remove…. What is
 * asserted: the secret fields are marked and refused by the recovery guard; what goes on the wire, under which key; Retry is the same
 * pair and an edit a new one; a refusal after an uncertain attempt stays uncertain and Check settles a Link; a conflict re-reads; the
 * secrets reach no store of the account database; and Save waits for the cache after an online change (D-13a-8). FIXTURE evidence.
 */
installMatchMedia({ width: 1440 });
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await new Promise((resolve) => setTimeout(resolve, 0));
});

const SECRET_URL = "https://feed.example/secret-sentinel-31337.ics";
const SECRET_TOKEN = "token-sentinel-31337";
const commands = (w: CalendarWorld) =>
  w.calls.filter((c) => c.path === "/calendar-commands");
const idOf = (call: { body?: unknown } | undefined): string | undefined =>
  (call?.body as { command?: { id?: string } } | undefined)?.command?.id;

async function openLink(w: CalendarWorld) {
  fireEvent.click(screen.getByRole("button", { name: copy.LINK_CALENDAR }));
  const dialog = await screen.findByRole("dialog", { name: copy.LINK_TITLE });
  const field = (label: string) => within(dialog).getByLabelText(label);
  fireEvent.change(field(copy.LABEL), { target: { value: "Work rota" } });
  fireEvent.change(field(copy.TIMEZONE), { target: { value: "UTC" } });
  fireEvent.change(field(copy.URL_LABEL), { target: { value: SECRET_URL } });
  fireEvent.change(field(copy.BEARER_LABEL), {
    target: { value: SECRET_TOKEN },
  });
  void w;
  return { dialog, field };
}

const submit = (dialog: HTMLElement, name: string | RegExp) =>
  fireEvent.click(within(dialog).getByRole("button", { name }));

describe("the secret fields (case 5)", () => {
  test("are marked sensitive, never autocompleted, typed url and password; the recovery guard refuses them", async () => {
    const w = await calendarWorld();
    const { dialog, field } = await openLink(w);
    for (const label of [copy.URL_LABEL, copy.BEARER_LABEL]) {
      const input = field(label);
      expect(input).toHaveAttribute("data-atlas-sensitive");
      expect(input).toHaveAttribute("autocomplete", "off");
    }
    expect(field(copy.URL_LABEL)).toHaveAttribute("type", "url");
    expect(field(copy.BEARER_LABEL)).toHaveAttribute("type", "password");
    expect(within(dialog).getByText(copy.SECRET_HELP)).toBeInTheDocument();
    const form = dialog.querySelector("form") as HTMLFormElement;
    for (const name of ["url", "bearer"])
      expect(() =>
        buildSnapshot({
          form,
          formContext: "link",
          tabInstanceId: "t",
          allow: [{ name }],
          strict: true,
        }),
      ).toThrow(SensitiveFieldError);
    // Production drops them; the label and timezone are the form's only recoverable fields.
    expect(
      buildSnapshot({
        form,
        formContext: "link",
        tabInstanceId: "t",
        allow: [
          { name: "url" },
          { name: "bearer" },
          { name: "label" },
          { name: "timezone" },
        ],
        strict: false,
      }).values,
    ).toEqual({ label: "Work rota", timezone: "UTC" });
  });
});

describe("Link a calendar… (online-only create with a connection)", () => {
  test("sends the create WITH its connection directly, closes on the receipt, and leaves no secret in any store or the page", async () => {
    const w = await calendarWorld();
    const { dialog } = await openLink(w);
    submit(dialog, copy.CONNECT);
    await w.settle();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const [call] = commands(w);
    expect(call?.body).toEqual({
      command: {
        kind: "create_source",
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        label: "Work rota",
        timezone: "UTC",
        connection: { url: SECRET_URL, bearer: SECRET_TOKEN },
      },
    });
    expect(call?.key).toMatch(/^[0-9a-f-]{36}$/);
    // Nothing was queued, and no store of the account database, nor the page, holds a secret.
    expect(w.rows("drafts")).toEqual([]);
    expect(JSON.stringify(w.snapshot())).not.toMatch(/sentinel-31337/);
    expect(document.body.innerHTML).not.toMatch(/sentinel-31337/);
    expect(JSON.stringify({ ...localStorage })).not.toMatch(/sentinel-31337/);
    expect(JSON.stringify({ ...sessionStorage })).not.toMatch(/sentinel-31337/);
  });

  test("an uncertain answer offers Retry: the SAME key and body; an edit makes the next attempt a new key", async () => {
    const w = await calendarWorld();
    w.replies.set("/calendar-commands", [
      { throws: new TypeError("Failed to fetch") },
      { status: 500, json: atlasBody("internal_error") },
      { status: 200, json: { revision: 4 } },
    ]);
    const { dialog, field } = await openLink(w);
    submit(dialog, copy.CONNECT);
    await w.settle();
    expect(
      await within(dialog).findByText(copy.SAVE_FAILED),
    ).toBeInTheDocument();
    submit(dialog, copy.RETRY);
    await w.settle();
    const [first, second] = commands(w);
    expect(second?.key).toBe(first?.key);
    expect(JSON.stringify(second?.body)).toBe(JSON.stringify(first?.body));
    fireEvent.change(field(copy.LABEL), { target: { value: "Work rota 2" } });
    submit(dialog, copy.CONNECT);
    await w.settle();
    const third = commands(w)[2];
    expect(third?.key).not.toBe(first?.key);
    expect(idOf(third)).not.toBe(idOf(first));
  });

  test("a refusal that FOLLOWS an uncertain attempt stays uncertain; Check finds the source and closes as linked", async () => {
    const w = await calendarWorld();
    w.replies.set("/calendar-commands", [
      { throws: new TypeError("Failed to fetch") },
      { status: 422, json: atlasBody("outbound_denied") },
    ]);
    const { dialog } = await openLink(w);
    submit(dialog, copy.CONNECT);
    await w.settle();
    submit(dialog, copy.RETRY);
    await w.settle();
    // Not shown as a refusal of the address: the first attempt may have landed.
    expect(within(dialog).queryByText(copy.URL_NOT_ALLOWED)).toBeNull();
    expect(within(dialog).getByText(copy.SAVE_FAILED)).toBeInTheDocument();
    const sent = idOf(commands(w)[0]);
    w.replies.set("/calendar-sources", [
      {
        status: 200,
        json: {
          items: [
            {
              id: sent,
              kind: "calendar_source",
              parent_id: null,
              label: "Work rota",
              value: {
                health: "pending",
                timezone: "UTC",
                refresh_in_progress: false,
              },
              version: 1,
              can_edit: true,
              archived: false,
            },
          ],
          next_after: null,
        },
      },
    ]);
    submit(dialog, copy.CHECK);
    await w.settle();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  test("Check that does not find the source says Retry is safe", async () => {
    const w = await calendarWorld();
    w.replies.set("/calendar-commands", [
      { throws: new TypeError("Failed to fetch") },
    ]);
    const { dialog } = await openLink(w);
    submit(dialog, copy.CONNECT);
    await w.settle();
    submit(dialog, copy.CHECK);
    await w.settle();
    expect(
      await within(dialog).findByText(copy.CHECK_NOT_FOUND),
    ).toBeInTheDocument();
  });

  test.each([
    ["invalid_endpoint", 422, copy.URL_REFUSED],
    ["outbound_denied", 422, copy.URL_NOT_ALLOWED],
  ])(
    "a first-attempt %s is shown at the URL field",
    async (code, status, words) => {
      const w = await calendarWorld();
      w.replies.set("/calendar-commands", [{ status, json: atlasBody(code) }]);
      const { dialog } = await openLink(w);
      submit(dialog, copy.CONNECT);
      await w.settle();
      expect(await within(dialog).findByText(words)).toBeInTheDocument();
    },
  );
});

describe("Manage: Replace… and Remove… (online-only)", () => {
  async function openManage(w: CalendarWorld) {
    fireEvent.click(
      await screen.findByRole("button", { name: "Manage Family calendar" }),
    );
    const dialog = await screen.findByRole("dialog");
    await w.settle();
    return dialog;
  }

  test("Replace… starts EMPTY, cannot be sent without a URL, and sends the connection with the current timezone and enabled", async () => {
    const w = await calendarWorld({ cache: [sourceRow()] });
    const dialog = await openManage(w);
    submit(dialog, copy.REPLACE);
    const url = within(dialog).getByLabelText(copy.URL_LABEL);
    expect(url).toHaveValue("");
    const send = within(dialog).getByRole("button", {
      name: copy.REPLACE_SUBMIT,
    });
    expect(send).toBeDisabled();
    expect(
      within(dialog).getAllByText(copy.URL_REQUIRED_FOR_REPLACE).length,
    ).toBeGreaterThan(0);
    fireEvent.change(url, { target: { value: SECRET_URL } });
    submit(dialog, copy.REPLACE_SUBMIT);
    await w.settle();
    expect(commands(w)[0]?.body).toEqual({
      command: {
        kind: "configure_source",
        id: sourceRow().id,
        expected_version: 3,
        timezone: "Europe/Vienna",
        enabled: true,
        connection: { url: SECRET_URL, bearer: null },
      },
    });
    // D-13a-8: the next queued settings change waits until the cache has caught up with this one.
    await waitFor(() =>
      expect(
        document.getElementById(
          within(dialog)
            .getByRole("button", { name: copy.SAVE })
            .getAttribute("aria-describedby") ?? "",
        )?.textContent,
      ).toBe(copy.WAITING_LAST_CHANGE),
    );
    expect(JSON.stringify(w.snapshot())).not.toMatch(/sentinel-31337/);
  });

  test("closing Replace… sends nothing and keeps the connection", async () => {
    const w = await calendarWorld({ cache: [sourceRow()] });
    const dialog = await openManage(w);
    submit(dialog, copy.REPLACE);
    fireEvent.change(within(dialog).getByLabelText(copy.URL_LABEL), {
      target: { value: SECRET_URL },
    });
    submit(dialog, copy.CLOSE_PANEL);
    expect(within(dialog).queryByLabelText(copy.URL_LABEL)).toBeNull();
    expect(commands(w)).toEqual([]);
  });

  test("Remove… asks first, then sends disconnect: true and no connection", async () => {
    const w = await calendarWorld({ cache: [sourceRow({ archived: true })] });
    const dialog = await openManage(w);
    submit(dialog, copy.REMOVE);
    expect(within(dialog).getByText(copy.REMOVE_CONFIRM)).toBeInTheDocument();
    expect(commands(w)).toEqual([]);
    submit(dialog, copy.REMOVE_SUBMIT);
    await w.settle();
    expect(commands(w)[0]?.body).toEqual({
      command: {
        kind: "configure_source",
        id: sourceRow().id,
        expected_version: 3,
        timezone: "Europe/Vienna",
        enabled: false,
        disconnect: true,
      },
    });
  });

  test("a 409 conflict shows the wireframe's conflict words and the next attempt is a new operation, never a blind resend", async () => {
    const w = await calendarWorld({ cache: [sourceRow()] });
    w.replies.set("/calendar-commands", [
      { status: 409, json: atlasBody("conflict") },
    ]);
    const dialog = await openManage(w);
    submit(dialog, copy.REMOVE);
    submit(dialog, copy.REMOVE_SUBMIT);
    await w.settle();
    expect(await within(dialog).findByText(copy.CONFLICT)).toBeInTheDocument();
    expect(commands(w)).toHaveLength(1);
    submit(dialog, copy.REMOVE_SUBMIT);
    await w.settle();
    expect(commands(w)[1]?.key).not.toBe(commands(w)[0]?.key);
  });

  test("a 403 keeps the panel open with the access-lost words", async () => {
    const w = await calendarWorld({ cache: [sourceRow()] });
    w.replies.set("/calendar-commands", [
      { status: 403, json: atlasBody("forbidden") },
    ]);
    const dialog = await openManage(w);
    submit(dialog, copy.REMOVE);
    submit(dialog, copy.REMOVE_SUBMIT);
    await w.settle();
    expect(
      await within(dialog).findByText(copy.ACCESS_LOST),
    ).toBeInTheDocument();
  });

  test("unmounting the screen drops the typed secrets with it", async () => {
    const w = await calendarWorld({ cache: [sourceRow()] });
    const dialog = await openManage(w);
    submit(dialog, copy.REPLACE);
    fireEvent.change(within(dialog).getByLabelText(copy.URL_LABEL), {
      target: { value: SECRET_URL },
    });
    expect(document.body.innerHTML).not.toMatch(/sentinel-31337/);
    cleanup();
    expect(document.body.innerHTML).toBe("");
    expect(commands(w)).toEqual([]);
  });
});

/**
 * Revision 1 (R1): Retry recovers the operation it repeats. Once an attempt of Replace… or Remove… was uncertain, Retry resends THAT
 * pair, byte for byte under its key, whatever the cache learnt meanwhile; the backend looks the key up before it checks the version, so
 * an attempt that landed returns its receipt and nothing is applied twice. An edit (or a conflict) is the only way to a new operation.
 * The wait before the next Save is measured from the version the operation was built on.
 */
describe("Retry repeats the uncertain operation, not a new one (revision 1, R1)", () => {
  async function openManage(w: CalendarWorld) {
    fireEvent.click(
      await screen.findByRole("button", { name: "Manage Family calendar" }),
    );
    const dialog = await screen.findByRole("dialog");
    await w.settle();
    return dialog;
  }
  const lost = { throws: new TypeError("Failed to fetch") };
  /** What a sync brings after the operation landed (or after something else changed the source): a newer version, other values. */
  const advanced = () =>
    sourceRow({
      version: 4,
      value: { ...sourceRow().value, timezone: "UTC", health: "pending" },
    });
  const reasonOf = (button: HTMLElement) =>
    document.getElementById(button.getAttribute("aria-describedby") ?? "")
      ?.textContent ?? null;

  test("Remove: the cache moves on while the answer is lost; Retry sends the SAME key and body, and the receipt ends it", async () => {
    const w = await calendarWorld({ cache: [sourceRow()] });
    w.replies.set("/calendar-commands", [
      lost,
      { status: 200, json: { revision: 4 } },
    ]);
    const dialog = await openManage(w);
    submit(dialog, copy.REMOVE);
    submit(dialog, copy.REMOVE_SUBMIT);
    await w.settle();
    expect(within(dialog).getByText(copy.SAVE_FAILED)).toBeInTheDocument();
    await w.commit({ put: { store: "cache", rows: [advanced()] } });
    submit(dialog, copy.RETRY);
    await w.settle();
    const [first, second] = commands(w);
    expect(second?.key).toBe(first?.key);
    expect(JSON.stringify(second?.body)).toBe(JSON.stringify(first?.body));
    expect(first?.body).toMatchObject({
      command: { expected_version: 3, timezone: "Europe/Vienna" },
    });
    expect(within(dialog).queryByText(copy.REMOVE_CONFIRM)).toBeNull();
    // The cache already holds what followed the operation (version 4 passes the version 3 it was built on): Save is not held back.
    expect(
      within(dialog).getByRole("button", { name: copy.SAVE }),
    ).toBeEnabled();
  });

  test("Replace: the same, with the typed connection resent exactly", async () => {
    const w = await calendarWorld({ cache: [sourceRow()] });
    w.replies.set("/calendar-commands", [
      lost,
      { status: 200, json: { revision: 4 } },
    ]);
    const dialog = await openManage(w);
    submit(dialog, copy.REPLACE);
    fireEvent.change(within(dialog).getByLabelText(copy.URL_LABEL), {
      target: { value: SECRET_URL },
    });
    fireEvent.change(within(dialog).getByLabelText(copy.BEARER_LABEL), {
      target: { value: SECRET_TOKEN },
    });
    submit(dialog, copy.REPLACE_SUBMIT);
    await w.settle();
    await w.commit({ put: { store: "cache", rows: [advanced()] } });
    submit(dialog, copy.RETRY);
    await w.settle();
    const [first, second] = commands(w);
    expect(second?.key).toBe(first?.key);
    expect(JSON.stringify(second?.body)).toBe(JSON.stringify(first?.body));
    expect(first?.body).toEqual({
      command: {
        kind: "configure_source",
        id: sourceRow().id,
        expected_version: 3,
        timezone: "Europe/Vienna",
        enabled: true,
        connection: { url: SECRET_URL, bearer: SECRET_TOKEN },
      },
    });
    expect(within(dialog).queryByLabelText(copy.URL_LABEL)).toBeNull();
  });

  test("an operation that did NOT land meets the newer version: the conflict is shown, and only then is a new operation built on it", async () => {
    const w = await calendarWorld({ cache: [sourceRow()] });
    w.replies.set("/calendar-commands", [
      lost,
      { status: 409, json: atlasBody("conflict") },
      { status: 200, json: { revision: 5 } },
    ]);
    const dialog = await openManage(w);
    submit(dialog, copy.REMOVE);
    submit(dialog, copy.REMOVE_SUBMIT);
    await w.settle();
    await w.commit({ put: { store: "cache", rows: [advanced()] } });
    submit(dialog, copy.RETRY);
    await w.settle();
    expect(await within(dialog).findByText(copy.CONFLICT)).toBeInTheDocument();
    expect(commands(w)[1]?.key).toBe(commands(w)[0]?.key);
    submit(dialog, copy.REMOVE_SUBMIT);
    await w.settle();
    const third = commands(w)[2];
    expect(third?.key).not.toBe(commands(w)[0]?.key);
    expect(third?.body).toMatchObject({
      command: { expected_version: 4, timezone: "UTC", disconnect: true },
    });
    // That operation was built on version 4, which the cache has not passed: Save waits for it.
    expect(
      reasonOf(within(dialog).getByRole("button", { name: copy.SAVE })),
    ).toBe(copy.WAITING_LAST_CHANGE);
  });

  test("controls: with the cache unchanged Retry is the same pair; an edit after an uncertain attempt is a new operation on the current row", async () => {
    const w = await calendarWorld({ cache: [sourceRow()] });
    w.replies.set("/calendar-commands", [lost, lost, lost]);
    const dialog = await openManage(w);
    submit(dialog, copy.REPLACE);
    const url = within(dialog).getByLabelText(copy.URL_LABEL);
    fireEvent.change(url, { target: { value: SECRET_URL } });
    submit(dialog, copy.REPLACE_SUBMIT);
    await w.settle();
    submit(dialog, copy.RETRY);
    await w.settle();
    expect(commands(w)[1]?.key).toBe(commands(w)[0]?.key);
    await w.commit({ put: { store: "cache", rows: [advanced()] } });
    fireEvent.change(url, { target: { value: `${SECRET_URL}?v=2` } });
    submit(dialog, copy.REPLACE_SUBMIT);
    await w.settle();
    const third = commands(w)[2];
    expect(third?.key).not.toBe(commands(w)[0]?.key);
    expect(third?.body).toMatchObject({
      command: {
        expected_version: 4,
        timezone: "UTC",
        connection: { url: `${SECRET_URL}?v=2` },
      },
    });
  });
});

/**
 * Revision 1 (R4): a form's direct request is admitted only while the form is open, under the client it was opened with, and online.
 * `not_sent` (the session holding the request for a moment) is asked again on a bounded schedule; a form closed during that wait sends
 * nothing more. Real time: the schedule's first waits are 50, 100 and 200 ms, and each case waits longer than their sum.
 */
describe("a request still waiting to be sent ends with its form (revision 1, R4)", () => {
  const notSent = () =>
    Array.from({ length: 12 }, () => ({
      throws: new StampedRequestError("not_sent"),
    }));
  const pause = (ms: number) =>
    act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  async function removeWaiting(w: CalendarWorld) {
    fireEvent.click(
      await screen.findByRole("button", { name: "Manage Family calendar" }),
    );
    const dialog = await screen.findByRole("dialog");
    await w.settle();
    w.replies.set("/calendar-commands", notSent());
    submit(dialog, copy.REMOVE);
    submit(dialog, copy.REMOVE_SUBMIT);
    expect(commands(w)).toHaveLength(1);
    return dialog;
  }

  test("control: the panel stays open, so each not_sent is asked again", async () => {
    const w = await calendarWorld({ cache: [sourceRow()] });
    await removeWaiting(w);
    await pause(500);
    expect(commands(w).length).toBeGreaterThan(2);
  });

  test("closing the panel, closing Manage, or the page going offline: nothing more is sent", async () => {
    for (const end of ["panel", "dialog", "offline"] as const) {
      const w = await calendarWorld({ cache: [sourceRow()] });
      const dialog = await removeWaiting(w);
      if (end === "panel") submit(dialog, copy.CLOSE_PANEL);
      if (end === "dialog") submit(dialog, copy.CANCEL);
      if (end === "offline") act(() => w.online.set(false));
      await pause(500);
      expect(commands(w), end).toHaveLength(1);
      if (end === "offline")
        expect(
          dialog.querySelector("[data-connection-panel] [data-form-message]")
            ?.textContent,
        ).toBe(copy.NEEDS_CONNECTION);
      cleanup();
    }
  });

  test("another identity displayed: the old form's request is not admitted again", async () => {
    const w = await calendarWorld({ cache: [sourceRow()] });
    await removeWaiting(w);
    await act(async () =>
      w.identity.set({
        account_id: "22222222-2222-4222-8222-222222222222",
        epoch: 1,
        session_id: "s2",
      }),
    );
    await pause(500);
    expect(commands(w)).toHaveLength(1);
  });

  test("Link a calendar…: cancelling the form while its create waits sends nothing more (with its control)", async () => {
    for (const cancel of [false, true]) {
      const w = await calendarWorld();
      const { dialog } = await openLink(w);
      w.replies.set("/calendar-commands", notSent());
      submit(dialog, copy.CONNECT);
      expect(commands(w)).toHaveLength(1);
      if (cancel) submit(dialog, copy.CANCEL);
      await pause(500);
      if (cancel) expect(commands(w)).toHaveLength(1);
      else expect(commands(w).length).toBeGreaterThan(2);
      cleanup();
    }
  });
});
