import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { CacheRow } from "../../../src/data";
import { accountDatabaseName } from "../../../src/data/model/schema";
import {
  CORRECTION_COPY,
  forgetAllCorrections,
} from "../../../src/features/tasks/detail/CorrectionDialog";
import { dayLabel } from "../../../src/features/tasks/format";
import { forgetTaskMemory } from "../../../src/features/tasks/memory";
import { submittedCorrection } from "../../../src/features/tasks/model/correction";
import { installMatchMedia } from "../../helpers/match-media";
import { draftRow } from "../../support/data/rows";
import {
  ME,
  mountTasks,
  seededTask,
  definition as taskDefinition,
} from "../../support/tasks/world";

/**
 * Design assessment DA-N1 (revision 2; family `task-correction-conflict-context-lifetime`, C5, schedule S4): the choices for a correction
 * that met another correction read what the person SUBMITTED from the queued operation itself, never from page memory. Each case seeds the
 * conflicted operation durably and mounts a fresh page (as after a reload or in another tab): no dialog of this page ever saved it.
 */
installMatchMedia({ width: 1440 });
afterEach(() => {
  cleanup();
  forgetTaskMemory();
  forgetAllCorrections();
});

const LOCAL = "cccccccc-0000-4000-8000-00000000d001";

async function conflicted(
  options: {
    command?: Record<string, unknown>;
    status?: "version_conflict" | "queued";
    digest?: string;
    /** The version now saved (someone else's correction committed first). */
    cached?: number;
    localId?: string;
  } = {},
) {
  const task = await seededTask({
    definition: {
      goal: { kind: "numeric", minimum: "10", maximum: null, unit: "cups" },
    },
  });
  const occurrence = task.rows[2] as CacheRow;
  // Someone else's correction was committed first: the cache holds version 2 (or `cached`).
  const cached = options.cached ?? 2;
  const rows = [
    ...task.rows.filter((r) => r.id !== occurrence.id),
    { ...occurrence, version: cached },
  ];
  const submitted = {
    kind: "revise_occurrence",
    id: task.occurrenceId,
    expected_version: cached - 1,
    definition: {
      ...task.data.definition,
      goal: { kind: "numeric", minimum: "12", maximum: null, unit: "cups" },
    },
    date: "2026-11-02",
    time: null,
    ...options.command,
  };
  const t = await mountTasks({
    path: `/tasks/${task.taskId}?occurrence=${task.occurrenceId}`,
    rows,
    env: { online: false },
    drafts: [
      draftRow({
        local_id: options.localId ?? LOCAL,
        created_seq: 1,
        kind: "revise_occurrence",
        endpoint: "/task-commands",
        account_id: ME,
        status: options.status ?? "version_conflict",
        command_digest: options.digest ?? "digest-1",
        target_resource_ids: [task.occurrenceId],
        index_targets: [task.occurrenceId],
        bases: { [task.occurrenceId]: cached - 1 },
        command: { command: submitted } as never,
      }),
    ],
  });
  await t.until(
    () => document.querySelector("[data-correction-conflict]") !== null,
  );
  return { t, task, submitted };
}
const section = () =>
  document.querySelector("[data-correction-conflict]") as HTMLElement | null;

describe("submittedCorrection: what a queued correction submitted (C5)", () => {
  test("reads the full definition, date and time of this occurrence's correction; anything else is unavailable", () => {
    const definition = taskDefinition() as unknown as Record<string, unknown>;
    const base = {
      kind: "revise_occurrence",
      id: "occ",
      definition,
      date: "2026-10-14",
      time: "09:00:00",
    };
    expect(submittedCorrection(base, "occ")).toMatchObject({
      date: "2026-10-14",
      time: "09:00:00",
    });
    expect(submittedCorrection(base, "other")).toBeNull();
    expect(submittedCorrection({ ...base, kind: "record" }, "occ")).toBeNull();
    expect(
      submittedCorrection({ ...base, definition: { nope: 1 } }, "occ"),
    ).toBeNull();
    expect(
      submittedCorrection({ ...base, date: null, time: "09:00:00" }, "occ"),
    ).toBeNull();
    expect(submittedCorrection(null, "occ")).toBeNull();
  });
});

describe("the conflict choices after a reload or in another tab (S4)", () => {
  test("the submitted day is shown and 'Save mine' resends the SUBMITTED correction in full on the version now saved", async () => {
    const { t, task } = await conflicted();
    const s = section();
    expect(s?.textContent).toContain(
      `${CORRECTION_COPY.mine}: ${dayLabel("2026-11-02")}`,
    );
    fireEvent.click(
      within(s as HTMLElement).getByRole("button", {
        name: CORRECTION_COPY.saveMine,
      }),
    );
    await t.settle();
    await t.until(() => t.drafts().every((d) => d.local_id !== LOCAL));
    const drafts = t.drafts();
    expect(drafts.map((d) => d.local_id)).not.toContain(LOCAL);
    expect(drafts).toHaveLength(1);
    const body = t.bodies().find((b) => b.local_id === drafts[0]?.local_id)
      ?.command.command;
    expect(body).toMatchObject({
      kind: "revise_occurrence",
      id: task.occurrenceId,
      expected_version: 2,
      date: "2026-11-02",
      definition: { goal: { minimum: "12" } },
    });
  });

  test("a replacement made by 'Save mine' that meets another correction again: its OWN body is what is resent, on the newer version", async () => {
    // The replacement (another id, built on version 2) was refused in turn; version 3 is now saved. A fresh page has no memory of either.
    const replacement = "cccccccc-0000-4000-8000-00000000d002";
    const { t, task } = await conflicted({
      cached: 3,
      localId: replacement,
      command: { date: "2026-11-09" },
    });
    expect(section()?.textContent).toContain(dayLabel("2026-11-09"));
    fireEvent.click(
      within(section() as HTMLElement).getByRole("button", {
        name: CORRECTION_COPY.saveMine,
      }),
    );
    await t.until(() => t.drafts().every((d) => d.local_id !== replacement));
    const drafts = t.drafts();
    expect(drafts).toHaveLength(1);
    expect(
      t.bodies().find((b) => b.local_id === drafts[0]?.local_id)?.command
        .command,
    ).toMatchObject({
      id: task.occurrenceId,
      expected_version: 3,
      date: "2026-11-09",
    });
  });

  test("the operation changed while the choice was on screen: 'Save mine' writes nothing", async () => {
    const { t } = await conflicted();
    // Another tab replaced the operation's body under the same id: the reviewed one is no longer what is stored.
    const header = t.drafts()[0];
    if (header === undefined) throw new Error("setup");
    t.world.idb.seed(accountDatabaseName(ME), "drafts", [
      { ...header, command_digest: "digest-2" },
    ] as never);
    fireEvent.click(
      within(section() as HTMLElement).getByRole("button", {
        name: CORRECTION_COPY.saveMine,
      }),
    );
    await t.settle();
    expect(t.drafts().map((d) => [d.local_id, d.command_digest])).toEqual([
      [LOCAL, "digest-2"],
    ]);
  });

  test("an unreadable submitted correction offers no 'Save mine' and says so; 'Discard mine' stays", async () => {
    await conflicted({ command: { definition: { broken: true } } });
    const s = section() as HTMLElement;
    expect(s.textContent).toContain(CORRECTION_COPY.mineUnavailable);
    expect(
      within(s).queryByRole("button", { name: CORRECTION_COPY.saveMine }),
    ).toBeNull();
    expect(
      within(s).queryByRole("button", { name: CORRECTION_COPY.discardMine }),
    ).not.toBeNull();
  });

  test("control: newer unsaved input in an open correction dialog is never offered as 'mine'", async () => {
    const { t } = await conflicted();
    fireEvent.click(screen.getByRole("button", { name: CORRECTION_COPY.open }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(CORRECTION_COPY.date), {
      target: { value: "2026-12-25" },
    });
    await t.settle();
    expect(section()?.textContent).not.toContain(dayLabel("2026-12-25"));
    expect(section()?.textContent).toContain(dayLabel("2026-11-02"));
  });
});
