import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import type { CacheRow } from "../../../src/data";
import * as words from "../../../src/features/calendars/copy-anchor";
import { forgetBindings } from "../../../src/features/tasks/detail/anchor-binding";
import { forgetKeptPanels } from "../../../src/features/tasks/detail/anchor-kept";
import { PRESET_COPY } from "../../../src/features/tasks/form/PresetPicker";
import { FORM_COPY } from "../../../src/features/tasks/form/TaskFormPage";
import { forgetKept } from "../../../src/features/tasks/kept-input";
import { emptyForm } from "../../../src/features/tasks/model/form";
import { encodeTaskFormInput } from "../../../src/features/tasks/model/recovery";
import { todayIn } from "../../../src/features/tasks/model/time";
import { forgetRecoverableEditors } from "../../../src/lib/form-recovery/editor";
import {
  RESTORED_TEXT,
  UNAVAILABLE_WHILE_RELOADING,
} from "../../../src/lib/form-recovery/RecoveryBanner";
import { pageFormRegistry } from "../../../src/lib/form-recovery/registry";
import { FLUSH_START_GRACE_MS } from "../../../src/lib/pwa/coordinator";
import { installMatchMedia } from "../../helpers/match-media";
import { FakeOrigin } from "../../pwa/coordinator-world";
import { cacheRow } from "../../support/data/rows";
import {
  contextsOf,
  forgetRecoveryWorld,
  freeze,
  installRecoveryLocks,
  unfreeze,
} from "../../support/recovery-editors";
import { SLOW } from "../../support/tasks/journal";
import {
  fakeApi,
  type Mounted,
  mountTasks,
  type SeededTask,
  seededTask,
} from "../../support/tasks/world";

/**
 * WEB-13b maintenance merge of accepted main, correction M-13b-1 (Kieran, 7 November 2026, "Fix all three in the merge"): WEB-13b's
 * anchor input takes part in WEB-14a's app-update recovery (Q4; docs/pwa.md "WEB-13b's editors"). Over the app's router, the PRODUCTION
 * data controller and form-recovery port (IndexedDB double), the page's real registry and the PRODUCTION app-update coordinator (worker,
 * clock and reload are doubles, `tests/pwa/coordinator-world.ts`), as WEB-14a's D-1 suite (`web10c-editors-recovery.test.tsx`):
 *
 *  - G-1: the new task form's calendar ANCHOR is part of the copy the accepted update saves (the task form's text, version 2), and the form
 *    restored after the reload shows it and sends it; a version-1 copy (a build without anchors) restores with none;
 *  - G-2: the anchor PANEL, on the new task form and on a task's detail, is a registered recoverable editor: dirty once edited, saved by the
 *    update, reopened on its copy after the reload (restored notice, focus on its first field), frozen while the reload is prepared (no
 *    edit, no Save, never closed as if saved), its copies ended by Cancel and by the visit's end; a detail panel's copy keeps the read of the
 *    task it is checked against, so a task changed meanwhile is never saved over.
 *
 * The form contexts are spelt out here (not imported), so that on a tree without the correction each test fails at an assertion, not at an
 * import. FIXTURE/COMPONENT evidence (jsdom), not a native browser result.
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
  forgetBindings();
  forgetKeptPanels();
  await new Promise((resolve) => setTimeout(resolve, 0));
});

const NEW_FORM = "task-form:new";
const FORM_PANEL = "task-form:new:anchor";
const DETAIL_PANEL = (task: string) => `task-anchor:${task}`;

const SOURCE = "00000000-0000-4000-8000-0000000000a1";
const EVENT = "00000000-0000-4000-8000-0000000000e1";
const ANCHOR = {
  reference: { kind: "event_series", source_id: SOURCE, uid: "bin@example" },
  offset: { kind: "calendar_days", days: -1, time: "18:00:00" },
  weekdays: [],
};
const calendarRows: CacheRow[] = [
  cacheRow({
    id: SOURCE,
    kind: "calendar_source",
    label: "Family calendar",
    value: { timezone: "Europe/London" },
  }),
  cacheRow({
    id: EVENT,
    kind: "event",
    parent_id: SOURCE,
    label: "Bin day",
    value: {
      uid: "bin@example",
      original: "2026-11-02",
      title: "Bin day",
      start: {
        date: "2026-11-02",
        time: null,
        timezone: "Europe/London",
        instant: null,
      },
      end: null,
      status: "present",
      sequence: 0,
    },
  }),
];

/** The control asserted present (an assertion, not a query error, when it is missing), then returned. */
const present = <T extends Element>(element: T | null | undefined): T => {
  expect(element ?? null).not.toBeNull();
  return element as T;
};
const dialog = () => screen.queryByRole("dialog") as HTMLElement | null;
const formAnchor = () =>
  document.querySelector("[data-task-form-anchor]") as HTMLElement | null;
const detailSection = () =>
  document.querySelector("[data-anchor-section]") as HTMLElement | null;

/** The live copies of `context` in the account's recovery store, decoded from their raw text. */
async function copies(t: Mounted, context: string): Promise<unknown[]> {
  return (await t.data.formRecovery.list(context)).map((copy) =>
    JSON.parse(copy.values.model ?? "null"),
  );
}

/** A tab of the production coordinator over the production page registry (worker, clock and reload are doubles). */
async function updatingTab() {
  const origin = new FakeOrigin();
  const tab = origin.tab();
  Object.defineProperty(tab, "forms", { value: pageFormRegistry });
  await tab.start();
  if (tab.coordinator) started.push(tab.coordinator);
  return { origin, tab };
}

/** A new version installed, the person accepts it ("Save and reload"): the coordinator saves what is dirty, then reloads once. */
async function acceptUpdate(t: Mounted): Promise<{ reloads: number }> {
  const { origin, tab } = await updatingTab();
  const waiting = await origin.installNew(2);
  await act(async () => {
    tab.actions?.accept();
  });
  let activated = false;
  for (let round = 0; round < 40 && tab.reloads === 0; round += 1) {
    await t.settle();
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
 * The page reloads onto the update: page memory (sessions, models, kept panels) is gone; the tree mounts again where it was. A real
 * reload runs nothing, so the models and the sessions' bridge are forgotten FIRST: forgetting the kept sessions afterwards ends them, and
 * an end the bridge still followed would be taken for a departure (and discard the copies the next page is to restore).
 */
async function reload(t: Mounted): Promise<void> {
  for (const coordinator of started.splice(0)) coordinator.dispose();
  const forgetBridge = await forgetSessionRecovery;
  act(() => {
    forgetBridge();
    forgetRecoverableEditors();
    forgetKeptPanels();
    forgetKept();
  });
  t.remount();
  await t.settle();
}

// ---- the new task form -----------------------------------------------------------------------------------------------------------------
async function newForm(): Promise<Mounted> {
  const t = await mountTasks({
    path: "/tasks/new",
    rows: calendarRows,
    env: { online: false },
  });
  await t.until(
    () => screen.queryByRole("button", { name: PRESET_COPY.scratch }) !== null,
  );
  fireEvent.click(
    present(screen.queryByRole("button", { name: PRESET_COPY.scratch })),
  );
  await t.until(() => document.querySelector("[data-task-form]") !== null);
  fireEvent.change(present(screen.queryByLabelText(FORM_COPY.name)), {
    target: { value: "Put the bins out" },
  });
  fireEvent.click(
    present(screen.queryByRole("radio", { name: FORM_COPY.sharingOnlyMe })),
  );
  fireEvent.change(present(screen.queryByLabelText(FORM_COPY.repeats)), {
    target: { value: "none" },
  });
  return t;
}

/** The panel open on the form, its event chosen and a day offset typed (nothing saved yet). */
async function panelEdited(t: Mounted, days = "-1"): Promise<HTMLElement> {
  fireEvent.click(
    present(
      within(present(formAnchor())).queryByRole("button", {
        name: words.FORM_ANCHOR,
      }),
    ),
  );
  await t.until(() => dialog() !== null);
  const panel = present(dialog());
  fireEvent.click(
    present(within(panel).queryByRole("button", { name: words.CHANGE_EVENT })),
  );
  await t.settle();
  fireEvent.click(
    present((await within(panel).findByText("Bin day")).closest("button")),
  );
  await t.settle();
  fireEvent.change(present(within(panel).queryByLabelText(words.DAYS_LABEL)), {
    target: { value: days },
  });
  fireEvent.change(present(within(panel).queryByLabelText(words.TIME_LABEL)), {
    target: { value: "18:00" },
  });
  return panel;
}

async function anchorSaved(t: Mounted): Promise<void> {
  const panel = await panelEdited(t);
  fireEvent.click(
    present(within(panel).queryByRole("button", { name: words.SAVE_ANCHOR })),
  );
  await t.settle();
  expect(dialog(), "the panel's save closed it").toBeNull();
}

describe("M-13b-1 G-1: the new task form's anchor is part of its recoverable text", () => {
  test(
    "an anchored new task: the accepted update saves the form WITH its anchor and reloads once; the restored form shows the anchor, sends nothing, and Save creates the anchored task",
    SLOW,
    async () => {
      const t = await newForm();
      await anchorSaved(t);
      expect(formAnchor()?.dataset.taskFormAnchor).toBe("set");
      expect(contextsOf(pageFormRegistry.dirty())).toContain(NEW_FORM);

      const { reloads } = await acceptUpdate(t);
      expect(reloads, "the update reloaded the tab once").toBe(1);
      const [copy] = (await copies(t, NEW_FORM)) as Array<
        Record<string, unknown>
      >;
      expect(copy?.v, "the task form's text, version 2").toBe(2);
      expect((copy?.anchor as { anchor?: unknown } | null)?.anchor).toEqual(
        ANCHOR,
      );
      expect(t.drafts(), "nothing was sent").toEqual([]);

      await reload(t);
      await t.until(() => formAnchor() !== null);
      expect(formAnchor()?.dataset.taskFormAnchor, "the anchor is back").toBe(
        "set",
      );
      expect(formAnchor()).toHaveTextContent(
        "Family calendar · Bin day · 1 day before at 18:00",
      );
      expect(
        (screen.queryByLabelText(FORM_COPY.name) as HTMLInputElement | null)
          ?.value,
      ).toBe("Put the bins out");
      expect(t.drafts(), "restored, never saved").toEqual([]);
      fireEvent.click(
        present(screen.queryByRole("button", { name: FORM_COPY.save })),
      );
      await t.settle();
      const body = t
        .bodies()
        .find((b) => b.command.command.kind === "create_task")?.command.command;
      expect(body?.anchor, "Save sends the restored anchor").toEqual(ANCHOR);
      // An anchored create projects no first occurrence (R15): the task and its details only.
      expect(t.drafts()[0]?.target_resource_ids).toHaveLength(2);
    },
  );

  test(
    "an anchor set and nothing else typed since the form opened: the copy holds the anchor (version 1 dropped it)",
    SLOW,
    async () => {
      const t = await newForm();
      await anchorSaved(t);
      await acceptUpdate(t);
      const all = (await copies(t, NEW_FORM)) as Array<{
        anchor?: { names?: unknown } | null;
      }>;
      expect(all).toHaveLength(1);
      expect(all[0]?.anchor?.names).toEqual({
        source: "Family calendar",
        event: "Bin day",
      });
    },
  );

  test(
    "CONTROL: a version-1 copy left by a build without anchors restores the form with its name and no anchor",
    SLOW,
    async () => {
      const t = await mountTasks({
        path: "/tasks/new",
        rows: calendarRows,
        env: { online: false },
      });
      await t.until(
        () =>
          screen.queryByRole("button", { name: PRESET_COPY.scratch }) !== null,
      );
      // What the accepted main build (WEB-14a's version 1) saved for a new task's form, left by a tab that has gone: no anchor in it.
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const base = emptyForm(zone, todayIn(zone, Date.now()));
      const typed = {
        ...base,
        title: "Put the bins out",
        repeat: "none" as const,
      };
      expect(
        await t.data.formRecovery.save({
          formContext: NEW_FORM,
          tabInstanceId: "gone-tab",
          values: {
            model: encodeTaskFormInput({ initial: base, state: typed }),
          },
          savedAt: new Date().toISOString(),
          capture: "gone-tab-capture",
        }),
      ).toBe("saved");
      await reload(t);
      await t.until(() => formAnchor() !== null);
      expect(
        (screen.queryByLabelText(FORM_COPY.name) as HTMLInputElement | null)
          ?.value,
      ).toBe("Put the bins out");
      expect(formAnchor()?.dataset.taskFormAnchor).toBe("none");
    },
  );
});

describe("M-13b-1 G-2: the anchor panel on the new task form", () => {
  test(
    "open and edited: registered (Save and reload) and dirty; the accepted update saves its draft; after the reload the form comes back and the panel reopens on the copy with the restored notice, focus on its first field; the form keeps no anchor until Save",
    SLOW,
    async () => {
      const t = await newForm();
      fireEvent.click(
        present(
          within(present(formAnchor())).queryByRole("button", {
            name: words.FORM_ANCHOR,
          }),
        ),
      );
      await t.until(() => dialog() !== null);
      expect(contextsOf(pageFormRegistry.all())).toContain(FORM_PANEL);
      expect(contextsOf(pageFormRegistry.dirty())).not.toContain(FORM_PANEL);
      fireEvent.click(
        present(
          within(present(dialog())).queryByRole("button", {
            name: "Cancel",
          }),
        ),
      );
      await t.settle();
      await panelEdited(t, "-2");
      expect(contextsOf(pageFormRegistry.dirty())).toContain(FORM_PANEL);

      expect((await acceptUpdate(t)).reloads).toBe(1);
      const [copy] = (await copies(t, FORM_PANEL)) as Array<{
        v: number;
        draft: { days: string; time: string; event: unknown };
      }>;
      expect(copy?.v).toBe(1);
      expect(copy?.draft).toMatchObject({ days: "-2", time: "18:00" });

      await reload(t);
      await t.until(() => dialog() !== null);
      const panel = present(dialog());
      expect(
        (within(panel).queryByLabelText(words.DAYS_LABEL) as HTMLInputElement)
          ?.value,
      ).toBe("-2");
      expect(
        within(panel).queryByText(RESTORED_TEXT),
        "the restored notice",
      ).not.toBeNull();
      expect(
        present(
          within(panel).queryByRole("radio", { name: words.EVENT_SERIES }),
        ),
        "focus is the panel's first field, never the banner",
      ).toHaveFocus();
      expect(formAnchor()?.dataset.taskFormAnchor).toBe("none");
      expect(t.drafts()).toEqual([]);
    },
  );

  test(
    "while an update reload is prepared the panel takes no edit and no Save, and never closes as if it had saved",
    SLOW,
    async () => {
      const t = await newForm();
      const panel = await panelEdited(t, "-3");
      freeze();
      fireEvent.change(
        present(within(panel).queryByLabelText(words.DAYS_LABEL)),
        { target: { value: "-9" } },
      );
      expect(
        (within(panel).queryByLabelText(words.DAYS_LABEL) as HTMLInputElement)
          ?.value,
        "the edit was refused",
      ).toBe("-3");
      const save = present(
        within(panel).queryByRole("button", { name: words.SAVE_ANCHOR }),
      );
      expect(save).toBeDisabled();
      expect(panel).toHaveTextContent(UNAVAILABLE_WHILE_RELOADING);
      fireEvent.click(save);
      await t.settle();
      expect(dialog(), "the panel stays open").not.toBeNull();
      expect(formAnchor()?.dataset.taskFormAnchor).toBe("none");
      unfreeze();
      await t.settle();
      fireEvent.click(
        present(
          within(present(dialog())).queryByRole("button", {
            name: words.SAVE_ANCHOR,
          }),
        ),
      );
      await t.settle();
      expect(formAnchor()?.dataset.taskFormAnchor).toBe("set");
    },
  );

  test(
    "CONTROL: Cancel ends the panel's copies; the next update saves none of its draft",
    SLOW,
    async () => {
      const t = await newForm();
      const panel = await panelEdited(t, "-4");
      fireEvent.click(
        present(within(panel).queryByRole("button", { name: "Cancel" })),
      );
      await t.settle();
      expect(contextsOf(pageFormRegistry.dirty())).not.toContain(FORM_PANEL);
      await acceptUpdate(t);
      expect(await copies(t, FORM_PANEL)).toEqual([]);
    },
  );
});

// ---- a task's detail ---------------------------------------------------------------------------------------------------------------------
async function detail(task: SeededTask): Promise<Mounted> {
  const t = await mountTasks({
    path: `/tasks/${task.taskId}`,
    rows: [...task.rows, ...calendarRows],
    api: fakeApi(),
    env: { online: false },
  });
  await t.until(() => detailSection() !== null);
  await t.settle();
  return t;
}

async function detailPanelEdited(
  t: Mounted,
  days = "-1",
): Promise<HTMLElement> {
  fireEvent.click(
    present(
      within(present(detailSection())).queryByRole("button", {
        name: words.ANCHOR_ACTION,
      }),
    ),
  );
  await t.until(() => dialog() !== null);
  const panel = present(dialog());
  fireEvent.click(
    present(within(panel).queryByRole("button", { name: words.CHANGE_EVENT })),
  );
  await t.settle();
  fireEvent.click(
    present((await within(panel).findByText("Bin day")).closest("button")),
  );
  await t.settle();
  fireEvent.change(present(within(panel).queryByLabelText(words.DAYS_LABEL)), {
    target: { value: days },
  });
  fireEvent.change(present(within(panel).queryByLabelText(words.TIME_LABEL)), {
    target: { value: "18:00" },
  });
  return panel;
}

const anchorBodies = (t: Mounted) =>
  t
    .bodies()
    .map((b) => b.command.command)
    .filter((c) => c.kind === "set_anchor");

/**
 * The panel is modal, so the update banner behind it is inert: the person leaves it first, by its in-dialog sync control (the session is
 * kept for the visit), as WEB-14a's native D-1 cases do; the update is accepted at the sync screens and the person comes back to the task.
 */
async function leftForSync(t: Mounted, panel: HTMLElement): Promise<void> {
  fireEvent.click(present(panel.querySelector("[data-sync-tone]")));
  await t.settle();
  expect(dialog(), "the sync control closed the panel").toBeNull();
}
async function backToTask(t: Mounted, task: SeededTask): Promise<HTMLElement> {
  await act(async () => {
    await t.router.navigate({
      to: "/tasks/$taskId",
      params: { taskId: task.taskId },
      search: {},
    });
  });
  await t.until(() => dialog() !== null);
  return present(dialog());
}

describe("M-13b-1 G-2: the anchor panel on a task's detail", () => {
  test(
    "open and edited: registered and dirty; left by its sync control it stays registered and dirty; the accepted update saves its draft and the read of the task it is checked against; after the reload the task's section reopens the panel on it, restored, never queued; Save queues set_anchor on that read",
    SLOW,
    async () => {
      const task = await seededTask();
      const t = await detail(task);
      const CONTEXT = DETAIL_PANEL(task.taskId);
      const panel = await detailPanelEdited(t, "-1");
      expect(contextsOf(pageFormRegistry.dirty())).toContain(CONTEXT);
      await leftForSync(t, panel);
      expect(
        contextsOf(pageFormRegistry.dirty()),
        "kept for the visit: still saved by an update",
      ).toContain(CONTEXT);
      expect((await acceptUpdate(t)).reloads).toBe(1);
      const [copy] = (await copies(t, CONTEXT)) as Array<{
        draft: { days: string };
        base: { observed: { resourceId: string } | null };
      }>;
      expect(copy?.draft.days).toBe("-1");
      expect(
        copy?.base.observed?.resourceId,
        "the read it is checked against",
      ).toBe(task.taskId);
      expect(anchorBodies(t)).toEqual([]);

      await reload(t);
      const restored = await backToTask(t, task);
      expect(
        (
          within(restored).queryByLabelText(
            words.DAYS_LABEL,
          ) as HTMLInputElement | null
        )?.value,
      ).toBe("-1");
      expect(within(restored).queryByText(RESTORED_TEXT)).not.toBeNull();
      expect(
        present(
          within(restored).queryByRole("radio", { name: words.EVENT_SERIES }),
        ),
      ).toHaveFocus();
      expect(anchorBodies(t), "restored, never queued").toEqual([]);
      fireEvent.click(
        present(
          within(restored).queryByRole("button", { name: words.SAVE_ANCHOR }),
        ),
      );
      await t.settle();
      expect(anchorBodies(t)).toEqual([
        {
          kind: "set_anchor",
          id: task.taskId,
          expected_version: 1,
          anchor: ANCHOR,
        },
      ]);
    },
  );

  test(
    "a restored change of a task that changed since it was composed is never saved over it: Save says the task changed, and nothing is queued",
    SLOW,
    async () => {
      const task = await seededTask();
      const t = await detail(task);
      await leftForSync(t, await detailPanelEdited(t, "-1"));
      await acceptUpdate(t);
      await reload(t);
      const restored = await backToTask(t, task);
      // Another device's change of the task arrives after the reload: the read the copy was composed against is not the task now.
      const taskRow = task.rows.find((r) => r.id === task.taskId) as CacheRow;
      expect(taskRow).toBeDefined();
      await t.commitSync([{ ...taskRow, version: 2, label: "Bins, renamed" }]);
      await t.settle();
      fireEvent.click(
        present(
          within(restored).queryByRole("button", { name: words.SAVE_ANCHOR }),
        ),
      );
      await t.settle();
      expect(anchorBodies(t), "nothing saved over the changed task").toEqual(
        [],
      );
      expect(present(dialog())).toHaveTextContent(
        words.ANCHOR_NOT_SAVED_CHANGED,
      );
    },
  );

  test(
    "while an update reload is prepared the detail's panel takes no edit and queues nothing",
    SLOW,
    async () => {
      const task = await seededTask();
      const t = await detail(task);
      const panel = await detailPanelEdited(t, "-7");
      freeze();
      fireEvent.change(
        present(within(panel).queryByLabelText(words.DAYS_LABEL)),
        { target: { value: "-8" } },
      );
      expect(
        (
          within(panel).queryByLabelText(
            words.DAYS_LABEL,
          ) as HTMLInputElement | null
        )?.value,
      ).toBe("-7");
      const save = present(
        within(panel).queryByRole("button", { name: words.SAVE_ANCHOR }),
      );
      expect(save).toBeDisabled();
      fireEvent.click(save);
      await t.settle();
      expect(anchorBodies(t)).toEqual([]);
      expect(dialog()).not.toBeNull();
    },
  );

  test(
    "CONTROL: the task visit's end ends a kept panel's copies (a departure is a discard): the next update saves none",
    SLOW,
    async () => {
      const task = await seededTask();
      const t = await detail(task);
      const CONTEXT = DETAIL_PANEL(task.taskId);
      await leftForSync(t, await detailPanelEdited(t, "-6"));
      expect(contextsOf(pageFormRegistry.dirty())).toContain(CONTEXT);
      // The sync screens are part of the visit; the task list is a departure.
      await act(async () => {
        await t.router.navigate({ to: "/tasks", search: {} });
      });
      await t.settle();
      expect(contextsOf(pageFormRegistry.dirty())).not.toContain(CONTEXT);
      await acceptUpdate(t);
      expect(await copies(t, CONTEXT)).toEqual([]);
    },
  );
});
