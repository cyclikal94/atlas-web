import {
  act,
  cleanup,
  fireEvent,
  renderHook,
  screen,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { AnnouncerProvider } from "../../../src/components/ui/announcer";
import type {
  CacheRow,
  DataEnv,
  DraftRow,
  EnqueueRequest,
} from "../../../src/data";
import { DataEnvProvider } from "../../../src/data";
import { reviewedOf } from "../../../src/data/model/review-confirmation";
import { accountDatabaseName } from "../../../src/data/model/schema";
import { useTaskActions } from "../../../src/features/tasks/actions";
import * as copy from "../../../src/features/tasks/copy";
import { CONTROLS_COPY } from "../../../src/features/tasks/detail/Controls";
import { RECORD_COPY } from "../../../src/features/tasks/detail/RecordCard";
import { TasksEnvProvider } from "../../../src/features/tasks/env";
import { forgetTaskMemory } from "../../../src/features/tasks/memory";
import type { Evidence } from "../../../src/features/tasks/model/contract";
import type { RowModel } from "../../../src/features/tasks/view";
import { installMatchMedia } from "../../helpers/match-media";
import {
  fakeApi,
  ME,
  mountTasks,
  OTHER,
  type SeededTask,
  seededTask,
  tasksEnv,
} from "../../support/tasks/world";

/**
 * DA17-N1 and DA17-N2 (WEB-10a revision 17) over the PRODUCTION data controller, screens and IndexedDB double: a denial of the
 * occurrence that another tab committed after the detail page offered Close/Reopen or an Anyone occurrence's first record (the page is
 * not told: only the writing transaction can see it) admits nothing: no command, no seeded stream, no pending "You", the amount typed
 * stays and the refusal is said. The editable controls queue once; an existing participant records without the occurrence's edit access.
 * The defaults review's confirmation of a held first record goes through the data controller's registry. A denial already on screen is
 * refused by the act itself, before the outbox is asked. FIXTURE evidence.
 */
installMatchMedia({ width: 1440 });
afterEach(() => {
  cleanup();
  forgetTaskMemory();
});

const NAME = accountDatabaseName(ME);
type Mounted = Awaited<ReturnType<typeof mountTasks>>;
const detailPath = (task: SeededTask) =>
  `/tasks/${task.taskId}?occurrence=${task.occurrenceId}`;
const card = () =>
  document.querySelector("[data-record-card]") as HTMLElement | null;
const occurrenceOf = (task: SeededTask) =>
  task.rows.find((r) => r.id === task.occurrenceId) as CacheRow;
const durable = (t: Mounted) =>
  JSON.stringify({ drafts: t.drafts(), bodies: t.bodies() });
const denied = copy.refusalMessage("denied") as string;
/** Another tab commits the occurrence's denial into the account database: no live read hears it (a seeded row is not heard). */
const denyUnheard = (t: Mounted, task: SeededTask) =>
  t.world.idb.seed(NAME, "cache", [{ ...occurrenceOf(task), can_edit: false }]);

async function detail(task: SeededTask) {
  const t = await mountTasks({
    path: detailPath(task),
    rows: task.rows,
    env: { online: false },
  });
  await t.until(() => card() !== null);
  return t;
}

describe("Close and Reopen under a denial another tab committed (DA17-N1, S8)", () => {
  for (const resolved of [false, true]) {
    const label = resolved ? CONTROLS_COPY.reopen : CONTROLS_COPY.close;
    const task = () =>
      seededTask({ occurrence: { resolved }, participants: [ME] });

    test(`control: ${label} by an editor queues one resolve`, async () => {
      const t = await detail(await task());
      fireEvent.click(screen.getByRole("button", { name: label }));
      await t.settle();
      expect(t.drafts().map((d) => d.kind)).toEqual(["resolve"]);
      expect(t.bodies()[0]?.command.command).toMatchObject({
        kind: "resolve",
        resolved: !resolved,
      });
    });

    test(`${label} offered, then the occurrence denied unheard: nothing is queued and the refusal is said`, async () => {
      const seeded = await task();
      const t = await detail(seeded);
      const before = durable(t);
      denyUnheard(t, seeded);
      const button = screen.getByRole("button", { name: label });
      expect(button).toBeEnabled();
      fireEvent.click(button);
      await t.settle();
      expect(durable(t)).toBe(before);
      expect(document.body.textContent).toContain(denied);
    });
  }
});

describe("the first record of an Anyone occurrence under a denial another tab committed (DA17-N2, S9)", () => {
  const anyone = (over: { stream?: boolean; canEdit?: boolean } = {}) =>
    seededTask({
      title: "Shared task",
      definition: {
        participation: "anyone",
        goal: { kind: "numeric", minimum: "8", maximum: null, unit: "glasses" },
      },
      participants: [OTHER],
      stream: over.stream ?? false,
      canEdit: over.canEdit ?? true,
    });
  const amountField = () =>
    screen.getByLabelText(
      `${RECORD_COPY.amount} (glasses)`,
    ) as HTMLInputElement;
  const recordButton = () =>
    within(card() as HTMLElement).getByRole("button", { name: copy.RECORD });

  test("control: an editor's first amount is queued once; the field clears and I take part", async () => {
    const t = await detail(await anyone());
    fireEvent.change(amountField(), { target: { value: "2" } });
    fireEvent.click(recordButton());
    await t.settle();
    expect(t.drafts().map((d) => d.kind)).toEqual(["record"]);
    expect(amountField().value).toBe("");
  });

  test("offered, then the occurrence denied unheard: no record, no seeded stream, the amount stays and the refusal is said", async () => {
    const seeded = await anyone();
    const t = await detail(seeded);
    const before = durable(t);
    denyUnheard(t, seeded);
    fireEvent.change(amountField(), { target: { value: "2" } });
    expect(recordButton()).toBeEnabled();
    fireEvent.click(recordButton());
    await t.settle();
    expect(durable(t)).toBe(before);
    expect(
      t.world.idb.peek(NAME, "resource_versions", seeded.progressId),
    ).toBeUndefined();
    expect(amountField().value).toBe("2");
    expect(document.body.textContent).toContain(denied);
  });

  test("an existing participant (my stream cached) whose occurrence is denied still records (S10)", async () => {
    const t = await detail(await anyone({ stream: true, canEdit: false }));
    fireEvent.change(amountField(), { target: { value: "2" } });
    expect(recordButton()).toBeEnabled();
    fireEvent.click(recordButton());
    await t.settle();
    expect(t.drafts().map((d) => d.kind)).toEqual(["record"]);
  });
});

describe("the defaults review's confirmation of a held first record, through the data controller (S12)", () => {
  async function held() {
    const seeded = await seededTask({
      title: "Shared task",
      definition: { participation: "anyone" },
      participants: [OTHER],
      stream: false,
      canEdit: true,
    });
    const t = await detail(seeded);
    fireEvent.click(
      within(card() as HTMLElement).getByRole("button", {
        name: copy.MARK_DONE,
      }),
    );
    await t.settle();
    const [draft] = t.drafts();
    // The progress defaults were never fetched here: the first record is held for the person's review.
    if (draft === undefined || draft.review_block === null)
      throw new Error("setup: no held first record");
    return { t, seeded, draft };
  }
  const confirm = (t: Mounted, draft: DraftRow) =>
    act(() =>
      t.data.actions.confirmDefaultsReview(draft.local_id, {
        reviewed: reviewedOf(draft),
        defaultsRevision: "b".repeat(64),
        defaultsContext: { progress: { households: [], accounts: [] } },
      }),
    );

  test("control: confirmed with the occurrence editable", async () => {
    const { t, draft } = await held();
    expect(await confirm(t, draft)).toMatchObject({
      kind: "confirmed",
      how: "edited",
    });
  });

  test("the occurrence denied unheard before the confirmation: refused `denied`, the held draft unchanged", async () => {
    const { t, seeded, draft } = await held();
    denyUnheard(t, seeded);
    const before = durable(t);
    expect(await confirm(t, draft)).toEqual({
      kind: "refused",
      reason: "denied",
    });
    expect(durable(t)).toBe(before);
  });
});

describe("a denial already on screen: the act refuses before the outbox is asked", () => {
  async function actions() {
    const t = await mountTasks({ path: "/", env: { online: false } });
    const asked: EnqueueRequest[] = [];
    const data: DataEnv = {
      ...t.data,
      outbox: () => {
        const real = t.data.outbox();
        return real === null
          ? null
          : {
              ...real,
              enqueue: (request: EnqueueRequest) => {
                asked.push(request);
                return real.enqueue(request);
              },
            };
      },
    };
    const env = tasksEnv(fakeApi());
    const wrapper = ({ children }: { children: ReactNode }) => (
      <AnnouncerProvider>
        <DataEnvProvider env={data}>
          <TasksEnvProvider value={env}>{children}</TasksEnvProvider>
        </DataEnvProvider>
      </AnnouncerProvider>
    );
    const { result } = renderHook(() => useTaskActions(), { wrapper });
    return { act: result.current, asked };
  }
  const row = (over: {
    canEdit: boolean;
    participation?: "anyone" | "everyone";
    stream?: boolean;
  }) =>
    ({
      id: "70000000-0000-4000-8000-000000000301",
      progressId: "70000000-0000-4000-8000-000000000302",
      canEdit: over.canEdit,
      streamPresent: over.stream ?? false,
      streamPending: false,
      data: {
        definition: { participation: over.participation ?? "anyone" },
      },
    }) as unknown as RowModel;
  const tick: Evidence = { kind: "checkbox", complete: true };

  test("Close under a shown denial: refused, the outbox not asked; control: asked once", async () => {
    const shown = await actions();
    expect(await shown.act.resolve(row({ canEdit: false }), true)).toEqual({
      ok: false,
      message: denied,
    });
    expect(shown.asked).toEqual([]);
    const control = await actions();
    await control.act.resolve(row({ canEdit: true }), true);
    expect(control.asked).toHaveLength(1);
  });

  test("a first Anyone record under a shown denial: refused, the outbox not asked; an existing participant: asked", async () => {
    const shown = await actions();
    expect(await shown.act.record(row({ canEdit: false }), tick)).toEqual({
      ok: false,
      message: denied,
    });
    expect(shown.asked).toEqual([]);
    const participant = await actions();
    await participant.act.record(row({ canEdit: false, stream: true }), tick);
    expect(participant.asked).toHaveLength(1);
    const everyone = await actions();
    await everyone.act.record(
      row({ canEdit: false, participation: "everyone" }),
      tick,
    );
    expect(everyone.asked).toHaveLength(1);
  });
});
