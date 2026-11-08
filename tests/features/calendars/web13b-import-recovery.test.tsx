import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import * as words from "../../../src/features/calendars/copy-import";
import { forgetImportSessions } from "../../../src/features/calendars/import-kept";
import { forgetRecoverableEditors } from "../../../src/lib/form-recovery/editor";
import {
  RESTORED_TEXT,
  UNAVAILABLE_WHILE_RELOADING,
} from "../../../src/lib/form-recovery/RecoveryBanner";
import { pageFormRegistry } from "../../../src/lib/form-recovery/registry";
import { FLUSH_START_GRACE_MS } from "../../../src/lib/pwa/coordinator";
import { installMatchMedia } from "../../helpers/match-media";
import { FakeOrigin } from "../../pwa/coordinator-world";
import { calendarWorld, sourceRow } from "../../support/calendars";
import {
  contextsOf,
  forgetRecoveryWorld,
  freeze,
  installRecoveryLocks,
} from "../../support/recovery-editors";
import { SLOW } from "../../support/tasks/journal";

/**
 * WEB-13b maintenance merge of accepted main, correction M-13b-1 G-3 (Kieran, 7 November 2026, "Fix all three in the merge"): the
 * import dialog takes part in WEB-14a's app-update recovery (Q4; docs/pwa.md "WEB-13b's editors"), through the calendar screen's PRODUCTION
 * router, data controller and form-recovery port (IndexedDB double), the page's real registry and the PRODUCTION app-update coordinator
 * (worker, clock and reload are doubles), as WEB-14a's D-1 suite:
 *
 *  - a row's dialog is a registered recoverable editor: dirty once its window is edited, kept (and still saved) when the person leaves it by
 *    its in-dialog sync control; the accepted update saves the source and the window AS TYPED, never the file, and reloads once; back at the
 *    calendar screen the row reopens the dialog on the copy, with the restored notice and focus on From, nothing queued;
 *  - a file chosen is input no copy can hold: the update STOPS (nothing reloads over it) and no copy holds the file or its text, with the
 *    dialog left by its sync control and nothing asking the model in between (revision 37, Review 46 F-R46-1/F-R46-2), and while the file
 *    is still being read; a kept session that ends (a departure) stops nothing any more;
 *  - while an update reload is prepared nothing changes and nothing is stored; Cancel ends the copies.
 *
 * The form contexts are spelt out here (not imported), so that on a tree without the correction each test fails at an assertion. FIXTURE/
 * COMPONENT evidence (jsdom), not a native browser result.
 */
installMatchMedia({ width: 1440 });
/**
 * The sessions' bridge to their models (`session-recovery.ts`, M-13b-1), loaded at run time: on a tree WITHOUT the correction (the negative
 * control runs these cases there) it does not exist, and there is nothing of it to forget.
 */
const BRIDGE = "../../../src/features/calendars/session-recovery";
const forgetSessionRecovery: Promise<() => void> = import(
  /* @vite-ignore */ BRIDGE
).then(
  (module: { forgetSessionRecovery?: () => void }) =>
    module.forgetSessionRecovery ?? (() => undefined),
  () => () => undefined,
);
beforeAll(installRecoveryLocks);
const started: { dispose(): void }[] = [];
afterEach(async () => {
  for (const coordinator of started.splice(0)) coordinator.dispose();
  forgetRecoveryWorld();
  forgetImportSessions();
  await new Promise((resolve) => setTimeout(resolve, 0));
});

const SOURCE = "00000000-0000-4000-8000-0000000000a1";
const CONTEXT = `calendar-import:${SOURCE}`;
const ROW = "Import events into Family calendar";
const ICS =
  "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:bin@example\r\nDTSTART;VALUE=DATE:20261101\r\nSUMMARY:Bin day\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
type World = Awaited<ReturnType<typeof calendarWorld>>;

const present = <T extends Element>(element: T | null | undefined): T => {
  expect(element ?? null).not.toBeNull();
  return element as T;
};
const dialog = () => screen.queryByRole("dialog") as HTMLElement | null;
const field = (shown: HTMLElement, label: "From" | "Through") =>
  present(within(shown).queryByLabelText(label)) as HTMLInputElement;

async function world(): Promise<World> {
  return calendarWorld({
    cache: [sourceRow({ id: SOURCE })],
    online: false,
    productionSync: true,
  });
}

async function openRow(w: World): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole("button", { name: ROW }));
  await waitFor(() => expect(dialog()).not.toBeNull());
  await w.settle();
  return present(dialog());
}

async function windowTyped(w: World): Promise<HTMLElement> {
  const shown = await openRow(w);
  fireEvent.change(field(shown, "From"), { target: { value: "2026-01-01" } });
  fireEvent.change(field(shown, "Through"), {
    target: { value: "2026-12-31" },
  });
  await w.settle();
  return shown;
}

async function chooseFile(
  w: World,
  shown: HTMLElement,
  file: File = new File([ICS], "retained.ics", { type: "text/calendar" }),
): Promise<void> {
  const input = present(
    shown.querySelector('input[type="file"]'),
  ) as HTMLInputElement;
  await act(async () => {
    fireEvent.change(input, { target: { files: [file] } });
  });
  await w.settle();
}

/**
 * Revision 37 (Review 46, F-R46-1): a file whose read the test holds (`readImportFile` reads `arrayBuffer`): the session is READING it
 * until `release`, as a large file on a slow device is.
 */
function heldFile(): { file: File; release(): void } {
  const file = new File([ICS], "held.ics", { type: "text/calendar" });
  let release: () => void = () => undefined;
  const read = new Promise<ArrayBuffer>((resolve) => {
    release = () => resolve(new TextEncoder().encode(ICS).buffer);
  });
  Object.defineProperty(file, "arrayBuffer", { value: () => read });
  return { file, release: () => release() };
}

/** The person leaves the modal dialog by its in-dialog sync control (the session is kept for the import's visit). */
async function leftForSync(w: World, shown: HTMLElement): Promise<void> {
  fireEvent.click(present(shown.querySelector("button[data-sync-tone]")));
  await w.settle();
  expect(dialog()).toBeNull();
}

/** The account's copies of `context`, as the store holds their raw text. */
async function texts(w: World, context = CONTEXT): Promise<string[]> {
  return (await w.env.formRecovery.list(context)).map(
    (copy) => copy.values.model ?? "",
  );
}

async function acceptUpdate(w: World): Promise<{ reloads: number }> {
  const origin = new FakeOrigin();
  const tab = origin.tab();
  Object.defineProperty(tab, "forms", { value: pageFormRegistry });
  await tab.start();
  if (tab.coordinator) started.push(tab.coordinator);
  const waiting = await origin.installNew(2);
  await act(async () => {
    tab.actions?.accept();
  });
  let activated = false;
  for (let round = 0; round < 40 && tab.reloads === 0; round += 1) {
    await w.settle();
    await act(async () => {
      await origin.clock.advance(FLUSH_START_GRACE_MS);
    });
    const asked = waiting.messages.some(
      (m) => (m.message as { type?: string }).type === "atlas:skip-waiting",
    );
    if (asked && !activated) {
      activated = true;
      await act(async () => {
        await origin.activate(waiting);
      });
    }
  }
  return { reloads: tab.reloads };
}

/**
 * The page reloads onto the update (at the sync screens, where the person accepted it): page memory is gone. A real reload runs nothing,
 * so the models and the sessions' bridge are forgotten before the kept session is (an end the bridge still followed would discard the
 * copies the next page is to restore).
 */
async function reload(w: World): Promise<void> {
  for (const coordinator of started.splice(0)) coordinator.dispose();
  const forgetBridge = await forgetSessionRecovery;
  act(() => {
    forgetBridge();
    forgetRecoverableEditors();
    forgetImportSessions();
  });
  await w.remount();
}

describe("M-13b-1 G-3: the import dialog takes part in app-update recovery", () => {
  test(
    "a row's dialog: registered and dirty once its window is edited; kept by its sync control it stays dirty; the accepted update saves the source and the window as typed and reloads once; back at the calendar screen the row reopens the dialog on the copy, restored, focus on From, nothing queued",
    SLOW,
    async () => {
      const w = await world();
      const shown = await openRow(w);
      expect(contextsOf(pageFormRegistry.all())).toContain(CONTEXT);
      expect(contextsOf(pageFormRegistry.dirty())).not.toContain(CONTEXT);
      fireEvent.change(field(shown, "From"), {
        target: { value: "2026-01-01" },
      });
      fireEvent.change(field(shown, "Through"), {
        target: { value: "2026-12-31" },
      });
      expect(contextsOf(pageFormRegistry.dirty())).toContain(CONTEXT);
      await leftForSync(w, shown);
      expect(contextsOf(pageFormRegistry.dirty())).toContain(CONTEXT);

      expect((await acceptUpdate(w)).reloads).toBe(1);
      expect((await texts(w)).map((t) => JSON.parse(t))).toEqual([
        { v: 1, chosen: null, from: "2026-01-01", through: "2026-12-31" },
      ]);
      expect(w.rows("drafts"), "nothing was stored").toHaveLength(0);

      await reload(w);
      await act(async () => {
        await w.traverse(-1);
      });
      await w.settle();
      await waitFor(() => expect(dialog()).not.toBeNull());
      const again = present(dialog());
      expect(field(again, "From").value).toBe("2026-01-01");
      expect(field(again, "Through").value).toBe("2026-12-31");
      expect(within(again).queryByText(RESTORED_TEXT)).not.toBeNull();
      expect(
        field(again, "From"),
        "focus is From, never the banner",
      ).toHaveFocus();
      expect(again.querySelector("[data-import-file]"), "no file").toBeNull();
      expect(w.rows("drafts"), "restored, never stored").toHaveLength(0);
    },
  );

  test(
    "a file chosen is input no copy can hold: the accepted update STOPS (nothing reloads over it) after the dialog was left by its sync control with nothing asking the model in between; back at the row the dialog shows the file and the window; no copy holds the file or its text",
    SLOW,
    async () => {
      // Revision 37 (Review 46, F-R46-1/F-R46-2): the person's real path. A modal dialog makes the update banner inert, so the update is
      // reached only after leaving the dialog by its sync control. NOTHING asks the registry or the model between choosing the file and
      // the update (before, the case asked `pageFormRegistry.dirty()` while the dialog was shown, and that question alone kept the model
      // unfinished after the dialog had gone: without it the update reloaded over the file).
      const w = await world();
      const shown = await windowTyped(w);
      await chooseFile(w, shown);
      await waitFor(() =>
        expect(shown.querySelector("[data-import-file]")).not.toBeNull(),
      );
      await leftForSync(w, shown);
      expect((await acceptUpdate(w)).reloads, "the update did not reload").toBe(
        0,
      );
      for (const text of await texts(w)) {
        expect(text).not.toContain("retained.ics");
        expect(text).not.toContain("VCALENDAR");
      }
      // Nothing was lost: Back at the calendar screen, the row's Import events shows the kept session again, file and window.
      await act(async () => {
        await w.traverse(-1);
      });
      await w.settle();
      fireEvent.click(await screen.findByRole("button", { name: ROW }));
      await waitFor(() => expect(dialog()).not.toBeNull());
      await w.settle();
      const again = present(dialog());
      expect(again.querySelector("[data-import-file]")).toHaveTextContent(
        "retained.ics",
      );
      expect(field(again, "From").value).toBe("2026-01-01");
      expect(w.rows("drafts"), "nothing was stored").toHaveLength(0);
    },
  );

  test(
    "a file still being READ when the dialog is left by its sync control (no window typed): the accepted update STOPS, and stops again once the read has finished",
    SLOW,
    async () => {
      // Revision 37 (F-R46-1, the related state the review names): the session is reading the file while no dialog shows it. Nothing
      // was typed, so the model's own text is the session's opening: only what the session holds keeps it listed and unfinished.
      const w = await world();
      const shown = await openRow(w);
      const held = heldFile();
      await chooseFile(w, shown, held.file);
      expect(shown, "the read is held").toHaveTextContent(words.READING);
      await leftForSync(w, shown);
      expect(
        (await acceptUpdate(w)).reloads,
        "the update did not reload over the read",
      ).toBe(0);
      held.release();
      await w.settle();
      expect(
        (await acceptUpdate(w)).reloads,
        "the file read since is still input no copy can hold",
      ).toBe(0);
      for (const text of await texts(w)) expect(text).not.toContain("held.ics");
    },
  );

  test(
    "CONTROL: a kept session that ENDS (the person goes elsewhere) while its file is still being read holds the update no longer: the next update reloads and restores nothing",
    SLOW,
    async () => {
      // Revision 37 (F-R46-1): the session's own check is asked only while the session is kept. Its end (a departure: the import's visit
      // is over) ends the model's session too, and the update must not keep stopping for a file the person can no longer reach.
      const w = await world();
      const shown = await windowTyped(w);
      const held = heldFile();
      await chooseFile(w, shown, held.file);
      expect(shown).toHaveTextContent(words.READING);
      await leftForSync(w, shown);
      await w.navigate("/settings");
      await w.settle();
      expect(contextsOf(pageFormRegistry.dirty())).not.toContain(CONTEXT);
      expect((await acceptUpdate(w)).reloads, "the update reloaded").toBe(1);
      expect(await texts(w), "the ended session left no copy").toEqual([]);
      held.release();
    },
  );

  test(
    "while an update reload is prepared the dialog takes no window edit and no file, and Import stores nothing",
    SLOW,
    async () => {
      const w = await world();
      const shown = await windowTyped(w);
      freeze();
      fireEvent.change(field(shown, "From"), {
        target: { value: "2027-02-02" },
      });
      expect(field(shown, "From").value, "the edit was refused").toBe(
        "2026-01-01",
      );
      await chooseFile(w, shown);
      expect(
        shown.querySelector("[data-import-file]"),
        "no file taken",
      ).toBeNull();
      const importButton = present(
        within(shown).queryByRole("button", { name: words.IMPORT }),
      );
      expect(importButton).toBeDisabled();
      expect(shown).toHaveTextContent(UNAVAILABLE_WHILE_RELOADING);
      fireEvent.click(importButton);
      await w.settle();
      expect(w.rows("drafts")).toHaveLength(0);
    },
  );

  test(
    "CONTROL: Cancel ends the dialog's copies; the next update saves none of its window",
    SLOW,
    async () => {
      const w = await world();
      const shown = await windowTyped(w);
      fireEvent.click(
        present(within(shown).queryByRole("button", { name: "Cancel" })),
      );
      await w.settle();
      expect(contextsOf(pageFormRegistry.dirty())).not.toContain(CONTEXT);
      await acceptUpdate(w);
      expect(await texts(w)).toEqual([]);
    },
  );
});
