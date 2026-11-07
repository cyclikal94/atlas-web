import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { PRESET_COPY } from "../../../src/features/tasks/form/PresetPicker";
import { FORM_COPY } from "../../../src/features/tasks/form/TaskFormPage";
import { forgetKept } from "../../../src/features/tasks/kept-input";
import { encodePresetChoice } from "../../../src/features/tasks/model/recovery";
import {
  RESTORED_TEXT,
  UNAVAILABLE_WHILE_RELOADING,
} from "../../../src/lib/form-recovery/RecoveryBanner";
import { RESTORE_COPY } from "../../../src/lib/form-recovery/RecoveryNotice";
import {
  flushDirty,
  pageFormRegistry,
} from "../../../src/lib/form-recovery/registry";
import { installMatchMedia } from "../../helpers/match-media";
import {
  forgetRecoveryWorld,
  freeze,
  installRecoveryLocks,
} from "../../support/recovery-editors";
import { SLOW } from "../../support/tasks/journal";
import {
  definition,
  fakeApi,
  mountTasks,
  seededTask,
} from "../../support/tasks/world";

/**
 * WEB-14a revision 38 (review of revision 37, R40-B; design assessment C3, I4, I11, DA-R40-E; Q3/Q5): the task editors' recovery choices
 * over the app's router, the PRODUCTION data controller and form-recovery port (IndexedDB double) and the page's real registry:
 *
 *  - the new-task form and the edit form (the kept-input owner, `task-form:new`/`task-form:<id>`): after the automatic restore, the other
 *    saved copy the person chooses replaces what the form shows, never sent;
 *  - the preset picker (`task-form:new:preset`) shows its recovery as every editor does (restored, Discard instead), and while an update
 *    reload is prepared its footer opens no form.
 */
installMatchMedia({ width: 1440 });
beforeAll(installRecoveryLocks);
afterEach(forgetRecoveryWorld);
type Mounted = Awaited<ReturnType<typeof mountTasks>>;

const name = () => screen.getByLabelText(FORM_COPY.name) as HTMLInputElement;
const formShown = () => document.querySelector("[data-task-form]") !== null;
async function reload(t: Mounted): Promise<void> {
  act(() => forgetKept());
  t.remount();
  await t.settle();
}
/** The page's own copy of `context`, and an older one another tab left with `older` in place of `typed`. */
async function twoCopies(
  t: Mounted,
  context: string,
  typed: string,
  older: string,
): Promise<void> {
  expect(await flushDirty(pageFormRegistry)).toContain("saved");
  const [own] = await t.data.formRecovery.list(context);
  if (!own?.values.model) throw new Error("setup: no copy of the form");
  expect(
    await t.data.formRecovery.save({
      formContext: context,
      tabInstanceId: "older-tab",
      values: { model: own.values.model.replace(typed, older) },
      savedAt: "2026-10-25T10:00:00.000Z",
      capture: "older-capture",
    }),
  ).toBe("saved");
}

describe("the task form after an update: choosing the other saved copy (R40-B)", () => {
  test(
    "new task: the form restored at its stage; the older copy chosen replaces the name; nothing is queued",
    SLOW,
    async () => {
      const t = await mountTasks({ path: "/tasks/new" });
      fireEvent.click(
        await screen.findByRole("button", { name: PRESET_COPY.scratch }),
      );
      await t.until(formShown);
      fireEvent.change(name(), { target: { value: "Newer unsent task" } });
      await twoCopies(t, "task-form:new", "Newer unsent task", "Older task");
      await reload(t);
      await t.until(formShown);
      expect(formShown(), "the form restored at its stage").toBe(true);
      expect(name().value).toBe("Newer unsent task");
      fireEvent.click(
        screen.getByRole("button", {
          name: RESTORE_COPY("2026-10-25T10:00:00.000Z"),
        }),
      );
      await t.settle();
      expect(name().value).toBe("Older task");
      expect(t.drafts()).toEqual([]);
    },
  );

  test(
    "edit task: the edit restored on the next page; the older copy chosen replaces it; nothing is queued",
    SLOW,
    async () => {
      const task = await seededTask({ title: "Water plants" });
      const t = await mountTasks({
        path: `/tasks/${task.taskId}/edit`,
        rows: task.rows,
        env: { online: false },
      });
      await t.until(formShown);
      fireEvent.change(name(), { target: { value: "Water the ferns" } });
      const context = `task-form:${task.taskId}`;
      await twoCopies(t, context, "Water the ferns", "Water the cactus");
      await reload(t);
      await t.until(formShown);
      expect(formShown(), "the form restored at its stage").toBe(true);
      // The form's look for what was left to it has read the store.
      await t.until(
        () =>
          document
            .querySelector("[data-recovery-ready]")
            ?.getAttribute("data-recovery-ready") === "true",
      );
      expect(name().value).toBe("Water the ferns");
      fireEvent.click(
        screen.getByRole("button", {
          name: RESTORE_COPY("2026-10-25T10:00:00.000Z"),
        }),
      );
      await t.settle();
      expect(name().value).toBe("Water the cactus");
      expect(t.drafts()).toEqual([]);
    },
  );
});

describe("the preset picker's recovery (PresetPicker.tsx, DA-R40-E)", () => {
  const presetsApi = () =>
    fakeApi({
      readPresets: async () => ({
        ok: true,
        value: [
          { id: "first", title: "First preset", definition: definition() },
          { id: "chore", title: "Shared chore", definition: definition() },
        ],
      }),
    });
  async function restored() {
    const t = await mountTasks({ path: "/tasks/new", api: presetsApi() });
    await t.until(() => screen.queryAllByRole("radio").length > 0);
    expect(
      await t.data.formRecovery.save({
        formContext: "task-form:new:preset",
        tabInstanceId: "gone-tab",
        values: { model: encodePresetChoice("chore") },
        savedAt: new Date().toISOString(),
        capture: "gone-capture",
      }),
    ).toBe("saved");
    await reload(t);
    await t.until(
      () => screen.queryByText(RESTORED_TEXT, { selector: "p" }) !== null,
    );
    expect(
      screen.queryByText(RESTORED_TEXT, { selector: "p" }),
      "the picker shows its restored choice",
    ).not.toBeNull();
    return t;
  }
  const checked = () =>
    screen
      .getAllByRole("radio")
      .find((radio) => (radio as HTMLInputElement).checked)
      ?.closest("label")?.textContent ?? "";

  test(
    "a choice left by the page before the update is shown restored, with Discard instead; nothing opens on its own",
    SLOW,
    async () => {
      const t = await restored();
      expect(checked()).toContain("Shared chore");
      expect(formShown()).toBe(false);
      fireEvent.click(screen.getByRole("button", { name: "Discard instead" }));
      expect(checked()).toContain("First preset");
      await t.settle();
      expect(await t.data.formRecovery.list("task-form:new:preset")).toEqual(
        [],
      );
    },
  );

  /** WEB-14a revision 51 (F-R51-1): "Discard instead" used from the keyboard (focused when pressed; jsdom does not focus on click). */
  function keyboardDiscard(): void {
    const button = screen.getByRole("button", { name: "Discard instead" });
    button.focus();
    expect(button, "the control: Discard instead has focus").toHaveFocus();
    fireEvent.click(button);
  }
  const focusedChoice = () =>
    (document.activeElement as HTMLInputElement | null)?.type === "radio"
      ? (document.activeElement?.closest("label")?.textContent ?? "")
      : null;

  test(
    "revision 51 (F-R51-1): the restored choice is focused (the checked preset); a keyboard discard focuses the preset its reset checks, choosing nothing",
    SLOW,
    async () => {
      const t = await restored();
      expect(checked()).toContain("Shared chore");
      await t.until(() => focusedChoice() !== null);
      expect(focusedChoice()).toContain("Shared chore");
      keyboardDiscard();
      await t.settle();
      expect(checked()).toContain("First preset");
      expect(focusedChoice()).toContain("First preset");
      expect(checked(), "focusing chose nothing").toContain("First preset");
      expect(formShown()).toBe(false);
    },
  );

  test(
    "revision 51, decision D1 (Kieran, 3 November 2026): restored with NO choice to show (the presets could not be read): the dialog's own opening focus, never the banner; a keyboard discard returns there",
    SLOW,
    async () => {
      let failing = false;
      const api = fakeApi({
        readPresets: async () =>
          failing
            ? { ok: false, kind: "uncertain", requestId: "req-51" }
            : {
                ok: true,
                value: [
                  {
                    id: "first",
                    title: "First preset",
                    definition: definition(),
                  },
                  {
                    id: "chore",
                    title: "Shared chore",
                    definition: definition(),
                  },
                ],
              },
      });
      const t = await mountTasks({ path: "/tasks/new", api });
      await t.until(() => screen.queryAllByRole("radio").length > 0);
      expect(
        await t.data.formRecovery.save({
          formContext: "task-form:new:preset",
          tabInstanceId: "gone-tab",
          values: { model: encodePresetChoice("chore") },
          savedAt: new Date().toISOString(),
          capture: "gone-capture",
        }),
      ).toBe("saved");
      failing = true;
      await reload(t);
      await t.until(
        () => screen.queryByText(RESTORED_TEXT, { selector: "p" }) !== null,
      );
      const dialog = screen.getByRole("dialog");
      expect(
        dialog.querySelector('[data-preset-picker="failed"]'),
        "the presets could not be read",
      ).not.toBeNull();
      expect(screen.queryAllByRole("radio")).toHaveLength(0);
      const opening = () => {
        const active = document.activeElement as HTMLElement | null;
        return active !== null &&
          dialog.contains(active) &&
          active.closest("[data-recovery-state]") === null
          ? active
          : null;
      };
      await t.until(() => opening() !== null);
      const first = opening();
      expect(first, "focus is in the dialog, not on the banner").not.toBeNull();
      keyboardDiscard();
      await t.settle();
      expect(screen.queryByText(RESTORED_TEXT, { selector: "p" })).toBeNull();
      expect(document.activeElement, "the same opening control").toBe(first);
      expect(formShown()).toBe(false);
    },
  );

  test(
    "while an update reload is prepared the footer opens no form (Use preset and Start from scratch are unavailable)",
    SLOW,
    async () => {
      const t = await restored();
      act(freeze);
      const footer = within(screen.getByRole("dialog"));
      for (const label of [PRESET_COPY.use, PRESET_COPY.scratch]) {
        const button = footer.getByRole("button", { name: label });
        expect(button).toBeDisabled();
        expect(
          document.getElementById(button.getAttribute("aria-describedby") ?? "")
            ?.textContent,
        ).toBe(UNAVAILABLE_WHILE_RELOADING);
        fireEvent.click(button);
      }
      await t.settle();
      expect(formShown()).toBe(false);
    },
  );
});
