import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { CacheRow } from "../../../src/data";
import { accountDatabaseName } from "../../../src/data/model/schema";
import {
  CORRECTION_COPY,
  forgetAllCorrections,
} from "../../../src/features/tasks/detail/CorrectionDialog";
import { forgetTaskMemory } from "../../../src/features/tasks/memory";
import { installMatchMedia } from "../../helpers/match-media";
import { draftRow } from "../../support/data/rows";
import {
  ME,
  mountTasks,
  OTHER,
  type SeededTask,
  seededTask,
} from "../../support/tasks/world";

/**
 * R30 (WEB-10a revision 16, family `occurrence-correction-permission-admission`): a correction needs write access to the occurrence. A
 * known denial (`can_edit: false` as this device last read it) withholds "Correct this day", withholds Save in a dialog that is open when
 * the permission is lost (what was typed stays, the dialog stays), and withholds "Save mine on the current version" for a correction that
 * met another one (the conflicted correction stays as it is). A denial committed by another tab AFTER a screen offered the save is refused
 * by the writing transaction (`denied`), and the screen keeps the input and says why. A permitted editor's controls still save once,
 * offline. In the app's router over the PRODUCTION data controller and the IndexedDB double: FIXTURE evidence.
 */
installMatchMedia({ width: 1440 });
afterEach(() => {
  cleanup();
  forgetTaskMemory();
  forgetAllCorrections();
});

const NAME = accountDatabaseName(ME);

async function sharedTask(canEdit: boolean): Promise<SeededTask> {
  return seededTask({
    definition: { participation: "everyone" },
    participants: [OTHER, ME],
    canEdit,
  });
}
const occurrenceOf = (task: SeededTask) =>
  task.rows.find((r) => r.kind === "occurrence") as CacheRow;
const detail = () => document.querySelector("[data-task-detail]") !== null;
const openButton = () =>
  screen.getByRole("button", { name: CORRECTION_COPY.open });
const dialog = () => screen.queryByRole("dialog");
const closeDays = () =>
  within(screen.getByRole("dialog")).getByLabelText(
    CORRECTION_COPY.close,
  ) as HTMLInputElement;
const saveCorrection = () =>
  within(screen.getByRole("dialog")).getByRole("button", {
    name: CORRECTION_COPY.save,
  }) as HTMLButtonElement;
type Mounted = Awaited<ReturnType<typeof mountTasks>>;
const corrections = (t: Mounted) =>
  t.drafts().filter((d) => d.kind === "revise_occurrence");

async function mounted(task: SeededTask) {
  const t = await mountTasks({
    path: `/tasks/${task.taskId}?occurrence=${task.occurrenceId}`,
    rows: task.rows,
    env: { online: false },
  });
  await t.until(detail);
  return t;
}

describe("Correct this day (S2)", () => {
  test("a known denial of the occurrence: it is not offered, and says why", async () => {
    await mounted(await sharedTask(false));
    expect(openButton()).toBeDisabled();
    expect(openButton()).toHaveAccessibleDescription(CORRECTION_COPY.denied);
    fireEvent.click(openButton());
    expect(dialog()).toBeNull();
  });

  test("control: an editor opens the dialog and queues exactly one correction offline", async () => {
    const t = await mounted(await sharedTask(true));
    fireEvent.click(openButton());
    fireEvent.change(closeDays(), { target: { value: "3" } });
    expect(saveCorrection()).toBeEnabled();
    fireEvent.click(saveCorrection());
    await t.until(() => dialog() === null);
    expect(corrections(t)).toHaveLength(1);
  });
});

describe("the permission lost while the dialog is open (S3)", () => {
  test("Save is withheld with the reason; the dialog and what was typed stay; nothing is queued; the grant restored saves once", async () => {
    const task = await sharedTask(true);
    const t = await mounted(task);
    fireEvent.click(openButton());
    fireEvent.change(closeDays(), { target: { value: "3" } });
    const occ = occurrenceOf(task);
    await t.commitSync([{ ...occ, can_edit: false, version: occ.version + 1 }]);
    await t.until(() => saveCorrection().disabled);
    expect(saveCorrection()).toHaveAccessibleDescription(
      CORRECTION_COPY.deniedKept,
    );
    fireEvent.click(saveCorrection());
    await t.settle();
    expect(corrections(t)).toEqual([]);
    expect(dialog()).not.toBeNull();
    expect(closeDays().value).toBe("3");
    // The grant comes back (a later read): the same session's input is saved by the person's explicit act, once.
    await t.commitSync([{ ...occ, can_edit: true, version: occ.version + 2 }]);
    await t.until(() => !saveCorrection().disabled);
    expect(closeDays().value).toBe("3");
    fireEvent.click(saveCorrection());
    await t.until(() => dialog() === null);
    expect(corrections(t)).toHaveLength(1);
    const body = t
      .bodies()
      .find((b) => b.local_id === corrections(t)[0]?.local_id)?.command.command;
    expect(body).toMatchObject({
      kind: "revise_occurrence",
      expected_version: occ.version + 2,
      definition: { close_days_after: 3 },
    });
  });
});

describe("a denial committed by another tab after the dialog offered Save (S4)", () => {
  test("the writing transaction refuses it: nothing is queued, the dialog keeps the input and can save again", async () => {
    const task = await sharedTask(true);
    const t = await mounted(task);
    fireEvent.click(openButton());
    fireEvent.change(closeDays(), { target: { value: "4" } });
    // Another tab's committed denial: the cache row changes and this page is not told (a seeded row is not heard).
    t.world.idb.seed(NAME, "cache", [
      { ...occurrenceOf(task), can_edit: false },
    ]);
    expect(saveCorrection()).toBeEnabled();
    fireEvent.click(saveCorrection());
    await t.settle();
    expect(corrections(t)).toEqual([]);
    expect(t.bodies()).toEqual([]);
    expect(dialog()).not.toBeNull();
    expect(closeDays().value).toBe("4");
    // Not left saving: the person can act again.
    expect(saveCorrection()).toBeEnabled();
  });
});

describe("Save mine on the current version (S7, S8)", () => {
  const LOCAL = "cccccccc-0000-4000-8000-00000000e001";
  async function conflicted(canEdit: boolean) {
    const task = await sharedTask(true);
    const occ = occurrenceOf(task);
    const submitted = {
      kind: "revise_occurrence",
      id: task.occurrenceId,
      expected_version: 1,
      definition: { ...task.data.definition, close_days_after: 5 },
      date: "2026-11-02",
      time: null,
    };
    const t = await mountTasks({
      path: `/tasks/${task.taskId}?occurrence=${task.occurrenceId}`,
      // Someone else's correction committed first: version 2 is now saved, with the permission as `canEdit`.
      rows: [
        ...task.rows.filter((r) => r.id !== occ.id),
        { ...occ, version: 2, can_edit: canEdit },
      ],
      env: { online: false },
      drafts: [
        draftRow({
          local_id: LOCAL,
          created_seq: 1,
          kind: "revise_occurrence",
          endpoint: "/task-commands",
          account_id: ME,
          status: "version_conflict",
          command_digest: "digest-1",
          target_resource_ids: [task.occurrenceId],
          index_targets: [task.occurrenceId],
          bases: { [task.occurrenceId]: 1 },
          command: { command: submitted } as never,
        }),
      ],
    });
    await t.until(
      () => document.querySelector("[data-correction-conflict]") !== null,
    );
    await t.settle();
    const before = JSON.stringify({ drafts: t.drafts(), bodies: t.bodies() });
    return { t, task, occ, before };
  }
  const section = () =>
    document.querySelector("[data-correction-conflict]") as HTMLElement;
  const saveMine = () =>
    within(section()).getByRole("button", {
      name: CORRECTION_COPY.saveMine,
    }) as HTMLButtonElement;
  const failure = () =>
    section()?.querySelector("[data-correction-replace-failed]")?.textContent ??
    null;
  const durable = (t: Mounted) =>
    JSON.stringify({ drafts: t.drafts(), bodies: t.bodies() });

  test("a known denial of the newer occurrence: Save mine is withheld with the reason; the conflicted correction stays as it was", async () => {
    const { t, before } = await conflicted(false);
    expect(saveMine()).toBeDisabled();
    expect(saveMine()).toHaveAccessibleDescription(CORRECTION_COPY.denied);
    fireEvent.click(saveMine());
    await t.settle();
    expect(durable(t)).toBe(before);
    expect(t.drafts().map((d) => [d.local_id, d.status])).toEqual([
      [LOCAL, "version_conflict"],
    ]);
  });

  test("control: an editor's Save mine replaces it once, on the version shown", async () => {
    const { t } = await conflicted(true);
    fireEvent.click(saveMine());
    await t.until(() => t.drafts().every((d) => d.local_id !== LOCAL));
    expect(t.drafts()).toHaveLength(1);
    expect(
      t.bodies().find((b) => b.local_id === t.drafts()[0]?.local_id)?.command
        .command,
    ).toMatchObject({ expected_version: 2, date: "2026-11-02" });
    expect(document.querySelector("[data-correction-conflict]")).toBeNull();
  });

  test("a denial another tab committed after the choice was shown: the replacement is refused, the conflicted correction and the block stay, and it says why", async () => {
    const { t, occ, before } = await conflicted(true);
    t.world.idb.seed(NAME, "cache", [{ ...occ, version: 2, can_edit: false }]);
    expect(saveMine()).toBeEnabled();
    fireEvent.click(saveMine());
    await t.settle();
    expect(durable(t)).toBe(before);
    expect(section()).not.toBeNull();
    expect(failure()).toBe(CORRECTION_COPY.replaceDenied);
  });

  test("the conflicted correction edited elsewhere: the replacement is refused, nothing changes, and it says so", async () => {
    const { t } = await conflicted(true);
    const header = t.drafts()[0];
    if (header === undefined) throw new Error("setup");
    t.world.idb.seed(NAME, "drafts", [
      { ...header, command_digest: "digest-2" },
    ] as never);
    const before = durable(t);
    fireEvent.click(saveMine());
    await t.settle();
    expect(durable(t)).toBe(before);
    expect(failure()).toBe(CORRECTION_COPY.replaceChanged);
    // Not left in progress: the choice can be made again.
    expect(saveMine()).toBeEnabled();
  });
});
