import {
  act,
  cleanup,
  fireEvent,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { captureDefaults, type EnqueueRequest } from "../../../src/data";
import { selectCandidate } from "../../../src/data/model/dispatch";
import { reviewedOf } from "../../../src/data/model/review-confirmation";
import { accountDatabaseName } from "../../../src/data/model/schema";
import type { DraftRow } from "../../../src/data/model/types";
import {
  admitReceipt,
  markInFlight,
  readDispatchWindow,
} from "../../../src/data/plans/outbox";
import { admitTask } from "../../../src/features/tasks/lists/actions";
import { DETAIL, PICKER } from "../../../src/features/tasks/lists/copy";
import { createTask } from "../../../src/features/tasks/model/commands";
import { installMatchMedia } from "../../helpers/match-media";
import {
  record as defaultsRecord,
  revision,
  snapshot,
} from "../../support/data/sharing";
import {
  forgetLists,
  listId,
  listRow,
  taskId,
  taskRow,
} from "../../support/tasks/lists";
import { definition, ME, mountTasks } from "../../support/tasks/world";

/**
 * WEB-10b revision 4 (review 4, D1 / DA-N1, family `list-uncertain-attempt-retirement`, `incomplete_fix`): an add to a list waits for the
 * CURRENT create of its task, read when the add is made, never the create the selection remembered. In the app's router over the
 * PRODUCTION data controller, outbox, defaults confirmation, discard, receipt and dispatch rules, over the IndexedDB double (FIXTURE
 * evidence). The review's reproduction (`.agtx/evidence/review4-20261025/dependency.test.tsx`) is kept as the first block, with its two
 * retained-create controls: a task created on this device and not sent, selected in the picker, then its create REPLACED by a legitimate
 * defaults confirmation (the production `confirmDefaultsReview`, with the in-flight `defaults_changed` shape a server refusal leaves:
 * `outcomes.ts` 210-218; the fixture cannot produce that server answer, so the refused header is seeded and its shape asserted) before
 * an ordinary Add, or before the explicit "Add as new adds" after an earlier add whose outcome is unknown.
 *
 * Every case asserts the stored add's dependency by identity AND what the dispatcher would send: the whole-queue reference
 * (`selectCandidate`) and the production window (`readDispatchWindow`), with the task's create backing off (an explicit `blockedUntil`;
 * no defaults review holds the queue), and that the add can go once the create is receipted.
 */
installMatchMedia({ width: 1440 });
afterEach(() => {
  cleanup();
  forgetLists();
});
type Mounted = Awaited<ReturnType<typeof mountTasks>>;
const DB = accountDatabaseName(ME);

const dialog = () => screen.queryByRole("dialog") as HTMLElement | null;
function press(name: string, root: HTMLElement | Document = document) {
  const found = within(root as HTMLElement).queryAllByRole("button", {
    name,
  })[0];
  expect(found, `the button "${name}"`).toBeDefined();
  fireEvent.click(found as HTMLElement);
}
const box = (id: string) =>
  document.querySelector(
    `[data-picker-task="${id}"] input`,
  ) as HTMLInputElement | null;
const noted = (text: string) =>
  dialog() !== null &&
  within(dialog() as HTMLElement).queryByText(text, { exact: false }) !== null;
async function closed(t: Mounted) {
  await t.until(() => dialog() === null);
  expect(dialog(), "the dialog closed").toBeNull();
}
/** The outbox's version record of a resource, as stored. */
const versionOf = (t: Mounted, id: string) =>
  (t.world.idb.snapshot(DB)?.resource_versions ?? []).find(
    (r) => (r as { resource_id?: string }).resource_id === id,
  );
const adds = (t: Mounted) => t.drafts().filter((d) => d.kind === "list_item");
const header = (t: Mounted, localId: string) =>
  t.drafts().find((d) => d.local_id === localId);

/** The outbox's enqueue, wrapped: the first call stores nothing and throws (an answer lost before the commit); later ones are real. */
function loseFirstAnswer(t: Mounted) {
  const outbox = t.data.outbox();
  if (outbox === null) throw new Error("no outbox");
  const real = outbox.enqueue.bind(outbox);
  const asked: EnqueueRequest[] = [];
  outbox.enqueue = async (request) => {
    asked.push(request);
    if (asked.length === 1) throw new Error("lost before the commit");
    return real(request);
  };
  return asked;
}

/** The `create_task` of task `n` with known defaults (no review); `localId` for an in-place edit of a queued one. */
const taskCreate = (n: number, title: string, localId?: string) =>
  createTask({
    taskId: taskId(n),
    executionId: taskId(n + 1),
    occurrenceId: null,
    progressId: null,
    title,
    definition: definition({
      schedule: {
        start_date: "2999-01-01",
        time: null,
        timezone: "UTC",
        repeat: null,
      },
    }),
    sharing: "only_me",
    defaults: defaultsRecord(),
    ...(localId === undefined ? {} : { localId }),
  });

/** A task this device created and has not sent: its `create_task`, with known defaults (no review), queued. */
async function pendingTask(t: Mounted, n: number, title = "Pending task") {
  const outbox = t.data.outbox();
  if (outbox === null) throw new Error("no outbox");
  const task = taskId(n);
  await act(async () => {
    expect(await outbox.enqueue(taskCreate(n, title))).toMatchObject({
      kind: "queued",
    });
  });
  const create = t
    .drafts()
    .find(
      (d) => d.kind === "create_task" && d.target_resource_ids[0] === task,
    ) as DraftRow;
  expect(create, "the task's create").toBeDefined();
  expect(create.review_block, "known defaults: no review").toBeNull();
  return { task, create };
}

/**
 * The create REPLACED by a legitimate defaults confirmation: the header as a `409 defaults_changed` leaves it (in flight, a defaults
 * review with no kinds), then the production confirmation with a newer defaults revision, which supersedes it under a fresh id. Returns
 * the replacement's header.
 */
async function replaceByConfirmation(t: Mounted, original: DraftRow) {
  const outbox = t.data.outbox();
  if (outbox === null) throw new Error("no outbox");
  const refused: DraftRow = {
    ...original,
    status: "in_flight",
    review_block: { kind: "defaults", kinds: [] },
  };
  t.world.idb.seed(DB, "drafts", [refused] as never);
  const now = captureDefaults(
    defaultsRecord(snapshot({ revision: revision(3) })),
    ["progress"],
  );
  await act(async () => {
    expect(
      await outbox.confirmDefaultsReview(original.local_id, {
        reviewed: reviewedOf(refused),
        defaultsRevision: now.defaultsRevision as string,
        defaultsContext: now.defaultsContext,
        replacementId: crypto.randomUUID(),
      }),
    ).toMatchObject({ kind: "confirmed", how: "superseded" });
  });
  await t.settle();
  const current = t
    .drafts()
    .find(
      (d) =>
        d.kind === "create_task" &&
        d.target_resource_ids[0] === original.target_resource_ids[0],
    ) as DraftRow;
  expect(current, "the replacement create").toBeDefined();
  expect(current.local_id).not.toBe(original.local_id);
  expect(current.status).toBe("queued");
  expect(current.review_block, "no defaults review holds the queue").toBeNull();
  expect(header(t, original.local_id), "the replaced create is gone").toBe(
    undefined,
  );
  return current;
}

/** What would be sent now with `backingOff` waiting for its back-off: by the whole-queue reference and by the production window. */
async function picks(t: Mounted, backingOff: string | null) {
  const service = t.data.service();
  if (service === null) throw new Error("no service");
  const now = Date.now();
  const blockedUntil = new Map<string, number>(
    backingOff === null ? [] : [[backingOff, now + 100_000]],
  );
  const reference = selectCandidate({
    rows: [...t.drafts()].sort((a, b) => a.created_seq - b.created_seq),
    now,
    blockedUntil,
  });
  const window = await service.store.run(readDispatchWindow, {
    incarnationId: service.incarnationId,
    now,
    blockedUntil,
  });
  expect(reference.holdFrom, "no queue-wide hold").toBeNull();
  return {
    reference: reference.pick?.local_id ?? null,
    production: window.pick?.local_id ?? null,
  };
}

/** The create sent and receipted through the production plans (in flight, then acknowledged). */
async function receipt(t: Mounted, localId: string) {
  const service = t.data.service();
  if (service === null) throw new Error("no service");
  await act(async () => {
    expect(
      await service.commit(markInFlight, {
        captured: service.capture(1),
        localId,
      }),
    ).toMatchObject({ kind: "applied" });
    expect(
      await service.commit(admitReceipt, {
        captured: service.capture(1),
        localId,
        revision: 5,
      }),
    ).toMatchObject({ kind: "applied" });
  });
}

/** The store's runs of the admission read (`data.readResourceView`): `after` runs once it answered, before the picker hears it. */
const ADMISSION = "data.readResourceView";
function admissions(
  t: Mounted,
  options: { after?: () => Promise<void>; fail?: boolean } = {},
) {
  const service = t.data.service();
  if (service === null) throw new Error("no service");
  const run = service.store.run.bind(service.store);
  const order: string[] = [];
  service.store.run = (async (plan: { name: string }, ...rest: unknown[]) => {
    const real = () => (run as (...args: unknown[]) => unknown)(plan, ...rest);
    if (plan.name === "data.enqueueDraft") order.push("enqueue");
    if (plan.name !== ADMISSION) return real();
    order.push("read");
    if (options.fail) throw new Error("the read failed");
    const answer = await real();
    if (options.after) {
      const after = options.after;
      options.after = undefined;
      await after();
      order.push("writer");
    }
    return answer;
  }) as typeof service.store.run;
  return order;
}

async function openPicker(t: Mounted, ...tasks: string[]) {
  press(DETAIL.add);
  await t.until(() => tasks.every((task) => box(task) !== null));
  for (const task of tasks) {
    expect(box(task), `the picker offers ${task}`).not.toBeNull();
    fireEvent.click(box(task) as HTMLInputElement);
  }
}
async function detailOf(rows = [] as ReturnType<typeof taskRow>[]) {
  const id = listId();
  const t = await mountTasks({
    path: `/tasks/lists/${id}`,
    rows: [listRow(id, "Dependencies", []), ...rows],
    env: { online: false },
  });
  return { t, id };
}

describe("review 4: the reproduction, an add waits for the task's CURRENT create", () => {
  for (const recovery of [false, true])
    for (const replaced of [false, true])
      test(`${recovery ? "explicit recovery Add (after an add whose outcome is unknown)" : "first ordinary Add"}: the create ${replaced ? "REPLACED before the add: the add names the replacement and waits for it" : "retained (control): the add names it and waits for it"}`, async () => {
        const { t } = await detailOf();
        const { task, create: original } = await pendingTask(t, 81);
        const asked = recovery ? loseFirstAnswer(t) : [];
        await openPicker(t, task);
        if (recovery) {
          press(PICKER.submit, dialog() as HTMLElement);
          await t.settle();
          expect(asked, "the lost add was issued once").toHaveLength(1);
          expect(adds(t), "and stored nothing").toEqual([]);
        }
        const current = replaced
          ? await replaceByConfirmation(t, original)
          : original;
        press(PICKER.submit, dialog() as HTMLElement);
        await t.settle();
        if (recovery) {
          expect(noted(PICKER.unknown(1)), "the outcome is unknown").toBe(true);
          expect(adds(t), "ordinary Add wrote nothing").toEqual([]);
          press(PICKER.again, dialog() as HTMLElement);
          await t.settle();
        }
        await closed(t);
        const [add] = adds(t);
        expect(add, "one add").toBeDefined();
        expect(adds(t)).toHaveLength(1);
        if (recovery)
          expect(add?.local_id, "a fresh id after the decision").not.toBe(
            asked[0]?.localId,
          );
        expect(add?.depends_on, "the CURRENT create").toContain(
          current.local_id,
        );
        if (replaced)
          expect(add?.depends_on, "never the replaced one").not.toContain(
            original.local_id,
          );
        expect(
          await picks(t, current.local_id),
          "nothing is sent while the create backs off",
        ).toEqual({ reference: null, production: null });
        expect(await picks(t, null), "the create goes first").toEqual({
          reference: current.local_id,
          production: current.local_id,
        });
        await receipt(t, current.local_id);
        expect(
          await picks(t, null),
          "once the create is receipted, the add can go",
        ).toEqual({
          reference: add?.local_id,
          production: add?.local_id,
        });
      });
});

describe("revision 4: admission against the task as it is when the add is made", () => {
  test("a cached task: the add depends on no create; a projected one on its create (pure rule)", () => {
    const task = taskId(90);
    const row = taskRow(task, "Cached");
    expect(admitTask({ merged: row, create: null }, task)).toEqual({
      kind: "ready",
      after: null,
    });
    expect(
      admitTask({ merged: { ...row, kind: "list" }, create: null }, task),
      "another kind at the id",
    ).toEqual({ kind: "gone" });
    expect(admitTask({ merged: null, create: null }, task)).toEqual({
      kind: "gone",
    });
  });

  test("the create replaced at the sync screens while the selection is kept: on Back, Add names the replacement", async () => {
    const { t } = await detailOf();
    const { task, create: original } = await pendingTask(t, 83);
    await openPicker(t, task);
    const chip = within(dialog() as HTMLElement)
      .getAllByRole("button")
      .find((x) => x.hasAttribute("data-sync-tone"));
    expect(chip, "the in-dialog sync control").toBeDefined();
    await act(async () => {
      fireEvent.click(chip as HTMLElement);
      await t.router.navigate({ to: "/sync", search: { tab: "queue" } });
    });
    await t.settle();
    expect(dialog(), "away at the sync screens").toBeNull();
    const current = await replaceByConfirmation(t, original);
    await act(async () => {
      t.router.history.back();
    });
    await t.until(() => box(task) !== null);
    expect(box(task)?.checked, "the selection was kept").toBe(true);
    press(PICKER.submit, dialog() as HTMLElement);
    await closed(t);
    const [add] = adds(t);
    expect(add?.depends_on).toContain(current.local_id);
    expect(add?.depends_on).not.toContain(original.local_id);
    expect(await picks(t, current.local_id)).toEqual({
      reference: null,
      production: null,
    });
  });

  for (const writer of ["replaced", "discarded", "edited", "none"] as const)
    test(`the create ${writer === "none" ? "unchanged between the admission read and the write (control): the add is written" : `${writer} BETWEEN the admission read and the write: refused, nothing written, the selection kept`}`, async () => {
      const { t, id } = await detailOf();
      const { task, create: original } = await pendingTask(t, 85);
      await openPicker(t, task);
      const outbox = t.data.outbox();
      if (outbox === null) throw new Error("no outbox");
      let current: DraftRow | null = null;
      const versionBefore = versionOf(t, id);
      const order = admissions(t, {
        after: async () => {
          if (writer === "replaced")
            current = await replaceByConfirmation(t, original);
          if (writer === "discarded")
            expect(await outbox.discard(original.local_id)).toMatchObject({
              kind: "discarded",
            });
          // An in-place edit of the queued create (same id, another body): the observation covers its digest.
          if (writer === "edited")
            expect(
              await outbox.editQueued(
                original.local_id,
                taskCreate(85, "Renamed pending task", original.local_id),
              ),
            ).toMatchObject({ kind: "edited" });
        },
      });
      press(PICKER.submit, dialog() as HTMLElement);
      await t.until(
        () =>
          dialog() === null ||
          noted(PICKER.taskChanged) ||
          noted(PICKER.gone) ||
          noted(PICKER.unread),
      );
      expect(order, "the writer ran between the read and the write").toEqual([
        "read",
        "writer",
        "enqueue",
      ]);
      if (writer === "none") {
        await closed(t);
        expect(adds(t)[0]?.depends_on).toContain(original.local_id);
        return;
      }
      expect(adds(t), "nothing written").toEqual([]);
      expect(versionOf(t, id), "the list's version is not raised").toEqual(
        versionBefore,
      );
      expect(
        noted(PICKER.taskChanged),
        `the task changed: ${dialog()?.textContent}`,
      ).toBe(true);
      expect(box(task)?.checked ?? null, "still selected").not.toBe(false);
      expect(dialog()?.querySelector("[data-picker-selected]")).toHaveProperty(
        "dataset.pickerSelected",
        "1",
      );
      // The person adds again: read anew, the add names what makes the task NOW, or nothing is written.
      press(PICKER.submit, dialog() as HTMLElement);
      await t.settle();
      if (writer === "edited") {
        await closed(t);
        expect(adds(t)[0]?.depends_on, "the same create, read again").toContain(
          original.local_id,
        );
        expect(header(t, original.local_id)?.command_digest).not.toBe(
          original.command_digest,
        );
        return;
      }
      if (writer === "replaced") {
        await closed(t);
        const [add] = adds(t);
        expect(add?.depends_on).toContain(
          (current as DraftRow | null)?.local_id,
        );
        expect(add?.depends_on).not.toContain(original.local_id);
        return;
      }
      expect(adds(t), "nothing makes the task: nothing written").toEqual([]);
      expect(noted(PICKER.gone), "the task isn't here any more").toBe(true);
    });

  for (const state of ["discarded", "rejected", "retained"] as const)
    test(`the create ${state === "retained" ? "retained (control): added" : `${state} before Add: nothing written, the selection kept and shown, Deselect lets the others be added`}`, async () => {
      const cached = taskId(88);
      const { t } = await detailOf([taskRow(cached, "Cached task")]);
      const { task, create } = await pendingTask(t, 86, "Unsent task");
      // In the order selected: the unsent task first, the cached one after it.
      await openPicker(t, task, cached);
      const outbox = t.data.outbox();
      if (outbox === null) throw new Error("no outbox");
      if (state === "discarded")
        await act(async () => {
          expect(await outbox.discard(create.local_id)).toMatchObject({
            kind: "discarded",
          });
        });
      if (state === "rejected")
        t.world.idb.seed(DB, "drafts", [
          {
            ...create,
            status: "rejected",
            last_error: { stage: "discarded" },
          },
        ] as never);
      await t.settle();
      press(PICKER.submit, dialog() as HTMLElement);
      await t.settle();
      if (state === "retained") {
        await closed(t);
        expect(
          adds(t).map((d) => d.depends_on.includes(create.local_id)),
        ).toEqual([true, false]);
        return;
      }
      expect(adds(t), "an ordered save stops at it: nothing written").toEqual(
        [],
      );
      expect(noted(PICKER.gone)).toBe(true);
      const missing = dialog()?.querySelector(
        `[data-picker-missing="${task}"]`,
      );
      expect(missing, "the selection is shown").not.toBeNull();
      expect(missing?.textContent).toContain(PICKER.missing("Unsent task"));
      expect(dialog()?.querySelector("[data-picker-selected]")).toHaveProperty(
        "dataset.pickerSelected",
        "2",
      );
      press(PICKER.deselect("Unsent task"), dialog() as HTMLElement);
      await t.settle();
      expect(
        dialog()?.querySelector(`[data-picker-missing="${task}"]`),
        "deselected",
      ).toBeNull();
      press(PICKER.submit, dialog() as HTMLElement);
      await closed(t);
      expect(adds(t), "the cached task added").toHaveLength(1);
      expect(adds(t)[0]?.depends_on).not.toContain(create.local_id);
    });

  test("a failed admission read writes nothing and is no uncertain add: the selection kept, the next Add is ordinary", async () => {
    const { t } = await detailOf();
    const { task, create } = await pendingTask(t, 92);
    await openPicker(t, task);
    const service = t.data.service();
    if (service === null) throw new Error("no service");
    const run = service.store.run;
    admissions(t, { fail: true });
    press(PICKER.submit, dialog() as HTMLElement);
    await t.settle();
    expect(adds(t), "nothing written").toEqual([]);
    expect(noted(PICKER.unread)).toBe(true);
    expect(
      dialog()?.querySelector("[data-list-decision]"),
      "no earlier add to decide about",
    ).toBeNull();
    service.store.run = run;
    press(PICKER.submit, dialog() as HTMLElement);
    await closed(t);
    expect(adds(t)[0]?.depends_on).toContain(create.local_id);
  });

  test("the add stored BEFORE the create is replaced: the replacement takes it over (the existing supersession), and it still waits", async () => {
    const { t } = await detailOf();
    const { task, create: original } = await pendingTask(t, 94);
    await openPicker(t, task);
    press(PICKER.submit, dialog() as HTMLElement);
    await closed(t);
    const [stored] = adds(t);
    expect(stored?.depends_on).toContain(original.local_id);
    const current = await replaceByConfirmation(t, original);
    const after = header(t, stored?.local_id as string);
    expect(after?.depends_on, "retargeted to the replacement").toContain(
      current.local_id,
    );
    expect(await picks(t, current.local_id)).toEqual({
      reference: null,
      production: null,
    });
  });

  test("the add stored BEFORE the create is discarded: the add is refused with it (the existing cascade), never sent", async () => {
    const { t } = await detailOf();
    const { task, create } = await pendingTask(t, 96);
    await openPicker(t, task);
    press(PICKER.submit, dialog() as HTMLElement);
    await closed(t);
    const [stored] = adds(t);
    const outbox = t.data.outbox();
    if (outbox === null) throw new Error("no outbox");
    await act(async () => {
      expect(await outbox.discard(create.local_id)).toMatchObject({
        kind: "discarded",
      });
    });
    expect(header(t, stored?.local_id as string)?.status).toBe("rejected");
    expect(await picks(t, null)).toEqual({ reference: null, production: null });
  });

  test("the create receipted and the task published before Add: the add names no create and can go at once", async () => {
    const { t } = await detailOf();
    const { task, create } = await pendingTask(t, 98, "Published");
    await openPicker(t, task);
    await receipt(t, create.local_id);
    await t.commitSync([taskRow(task, "Published")]);
    expect(header(t, create.local_id), "the create is retired").toBe(undefined);
    press(PICKER.submit, dialog() as HTMLElement);
    await closed(t);
    const [add] = adds(t);
    expect(add?.depends_on).not.toContain(create.local_id);
    expect(await picks(t, null)).toEqual({
      reference: add?.local_id,
      production: add?.local_id,
    });
  });
});
