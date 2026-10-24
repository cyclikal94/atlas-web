import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import * as copy from "../../../src/features/tasks/copy";
import { takesPart, whoLabel } from "../../../src/features/tasks/format";
import { forgetTaskMemory } from "../../../src/features/tasks/memory";
import type { Participation } from "../../../src/features/tasks/model/contract";
import type { RowModel } from "../../../src/features/tasks/view";
import { installMatchMedia } from "../../helpers/match-media";
import {
  ME,
  mountTasks,
  OTHER,
  seededTask,
  TODAY,
} from "../../support/tasks/world";

/**
 * R28 (WEB-10a revision 15, family `today-participant-membership-label`): Today and the task say "You…" only for someone KNOWN to take
 * part (the roster names them, or their own stream is held or being created here), never because they can see the task. The same words
 * on both screens. Recording eligibility (`recordBlock`) keeps its own rules. In the app's router over the PRODUCTION data controller and the
 * IndexedDB double: FIXTURE evidence.
 */
installMatchMedia({ width: 1440 });
afterEach(() => {
  cleanup();
  forgetTaskMemory();
});
const PATH = `/today?day=${TODAY}&tz=UTC`;
const THIRD = "33333333-3333-4333-8333-333333333333";
const row = (id: string) =>
  document.querySelector(`[data-today-row="${id}"]`) as HTMLElement | null;
const who = () =>
  document.querySelector("[data-participation] p") as HTMLElement | null;

const goal = (participation: Participation) =>
  participation === "pooled"
    ? {
        goal: {
          kind: "numeric" as const,
          minimum: "1",
          maximum: null,
          unit: "items",
        },
      }
    : {};

async function shared(
  participation: Participation,
  options: { participants: string[]; stream: boolean; canEdit: boolean },
) {
  return seededTask({
    title: "Shared task",
    definition: { participation, ...goal(participation) },
    participants: options.participants,
    stream: options.stream,
    canEdit: options.canEdit,
  });
}

describe("the label is the roster's (pure)", () => {
  const model = (
    participants: string[],
    stream: { present?: boolean; pending?: boolean } = {},
  ) =>
    ({
      data: { participants },
      streamPresent: stream.present ?? false,
      streamPending: stream.pending ?? false,
    }) as unknown as RowModel;

  test.each([
    { participants: [OTHER], expected: "1 person", member: false },
    { participants: [OTHER, THIRD], expected: "2 people", member: false },
    { participants: [], expected: "0 people", member: false },
    { participants: [ME], expected: "You", member: true },
    { participants: [ME, OTHER], expected: "You and 1 other", member: true },
    {
      participants: [OTHER, ME, THIRD],
      expected: "You and 2 others",
      member: true,
    },
  ])(
    "roster $participants → $expected",
    ({ participants, expected, member }) => {
      expect(takesPart(model(participants), ME)).toBe(member);
      expect(whoLabel(model(participants), ME)).toBe(expected);
    },
  );

  test("my own stream held, or being created here, is known participation; seeing the task is not", () => {
    expect(whoLabel(model([OTHER], { present: true }), ME)).toBe(
      "You and 1 other",
    );
    expect(whoLabel(model([OTHER], { pending: true }), ME)).toBe(
      "You and 1 other",
    );
    expect(whoLabel(model([], { pending: true }), ME)).toBe("You");
    expect(whoLabel(model([OTHER]), ME)).toBe("1 person");
  });
});

describe("Today never names a viewer who is not taking part (R28)", () => {
  for (const participation of ["everyone", "pooled", "anyone"] as const)
    test(`${participation}: a viewer off the roster, with no stream and no edit, is counted as the roster, not as You`, async () => {
      const task = await shared(participation, {
        participants: [OTHER],
        stream: false,
        canEdit: false,
      });
      const t = await mountTasks({
        path: PATH,
        rows: task.rows,
        env: { online: false },
      });
      await t.until(() => row(task.occurrenceId) !== null);
      const text = row(task.occurrenceId)?.textContent ?? "";
      expect(text).toContain(`${copy.PARTICIPATION[participation]} · 1 person`);
      expect(text).not.toContain("You");
    });

  test("control: an enrolled viewer is still You and the others", async () => {
    const task = await shared("everyone", {
      participants: [ME, OTHER],
      stream: true,
      canEdit: true,
    });
    const t = await mountTasks({
      path: PATH,
      rows: task.rows,
      env: { online: false },
    });
    await t.until(() => row(task.occurrenceId) !== null);
    expect(row(task.occurrenceId)?.textContent).toContain(
      "Everyone · You and 1 other",
    );
  });

  test("an empty roster says no one, never You", async () => {
    const task = await shared("everyone", {
      participants: [],
      stream: false,
      canEdit: false,
    });
    const t = await mountTasks({
      path: PATH,
      rows: task.rows,
      env: { online: false },
    });
    await t.until(() => row(task.occurrenceId) !== null);
    const text = row(task.occurrenceId)?.textContent ?? "";
    expect(text).toContain("Everyone · 0 people");
    expect(text).not.toContain("You");
  });

  test("Just me says no count at all (unchanged)", async () => {
    const task = await seededTask({ title: "Mine" });
    const t = await mountTasks({
      path: PATH,
      rows: task.rows,
      env: { online: false },
    });
    await t.until(() => row(task.occurrenceId) !== null);
    const text = row(task.occurrenceId)?.textContent ?? "";
    expect(text).toContain(`${copy.PARTICIPATION.personal} · `);
    expect(text).not.toMatch(/You|person|people/);
  });

  test("Anyone I may edit stays recordable without a stream (eligibility is not membership), and my first record makes me You", async () => {
    const task = await shared("anyone", {
      participants: [OTHER],
      stream: false,
      canEdit: true,
    });
    const t = await mountTasks({
      path: PATH,
      rows: task.rows,
      env: { online: false },
    });
    await t.until(() => row(task.occurrenceId) !== null);
    const el = row(task.occurrenceId) as HTMLElement;
    expect(el.textContent).toContain("Anyone · 1 person");
    const mark = within(el).getByRole("button", { name: copy.MARK_DONE });
    expect(mark).toBeEnabled();
    fireEvent.click(mark);
    await t.until(
      () =>
        row(task.occurrenceId)?.textContent?.includes("You and 1 other") ===
        true,
    );
    expect(t.drafts().map((d) => d.kind)).toEqual(["record"]);
  });
});

describe("the task says the same as Today (R28)", () => {
  for (const [label, participants, expected] of [
    ["a viewer off the roster", [OTHER], "1 person"],
    ["an enrolled viewer", [ME, OTHER], "You and 1 other"],
  ] as const)
    test(`${label}: ${expected} on both screens`, async () => {
      const member = participants.includes(ME as never);
      const task = await shared("everyone", {
        participants: [...participants],
        stream: member,
        canEdit: member,
      });
      const t = await mountTasks({
        path: PATH,
        rows: task.rows,
        env: { online: false },
      });
      await t.until(() => row(task.occurrenceId) !== null);
      expect(row(task.occurrenceId)?.textContent).toContain(
        `Everyone · ${expected}`,
      );
      await t.router.navigate({
        to: "/tasks/$taskId",
        params: { taskId: task.taskId },
        search: { occurrence: task.occurrenceId },
      });
      await t.until(() => who() !== null);
      expect(who()?.textContent).toBe(`Everyone · ${expected}`);
      expect(screen.queryByText(/^You$/)).toBeNull();
    });
});
