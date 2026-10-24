import {
  act,
  cleanup,
  fireEvent,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import {
  CORRECTION_COPY,
  forgetAllCorrections,
} from "../../../src/features/tasks/detail/CorrectionDialog";
import {
  type CorrectionEvent,
  correctionEntry,
  correctionKey,
  subscribeCorrection,
} from "../../../src/features/tasks/detail/correction-owner";
import { forgetKeptFixes } from "../../../src/features/tasks/detail/EntryHistory";
import { forgetKept } from "../../../src/features/tasks/kept-input";
import { forgetTaskMemory } from "../../../src/features/tasks/memory";
import { installMatchMedia } from "../../helpers/match-media";
import { ME, mountTasks, seededTask } from "../../support/tasks/world";

/**
 * Revision 24 (Review 24 R36, `regression` in the family `task-sync-navigation-draft-loss`; design assessment after Review 24, invariants
 * 1-10). FIXTURE evidence: the app's router (memory history, observed by the task visits) over the PRODUCTION data controller and the
 * IndexedDB double; a save's acknowledgement is held AFTER the real outbox committed its `revise_occurrence`.
 *
 * An occurrence-correction dialog React never removed (the person went away, to the task list or the sync screens, and came back before it
 * re-rendered) is the editor the person is at again. Its consumed save never closes it (the old attachment was revoked, R35), but it must
 * not be left holding the deleted session either: it starts afresh, a new session from what the day shows now, so the person's next input
 * is saved by the next explicit Save, and that Save closes it. Input kept by a refused save, or typed after the pending one, stays and is
 * saved by the next Save; the dialog's presentation is renewed for that later work only, never for the old save's acknowledgement.
 *
 * Every schedule's barriers are asserted: the history moved and the original dialog was still mounted when the acknowledgement arrived,
 * the settlement reached it, and it is that same instance (`data-instance`) the person returns to. Durable writes are read from the outbox.
 */
installMatchMedia({ width: 1440 });
afterEach(() => {
  cleanup();
  forgetKept();
  forgetTaskMemory();
  forgetKeptFixes();
  forgetAllCorrections();
});

type Mounted = Awaited<ReturnType<typeof mountTasks>>;
type Where = "/tasks" | "/sync";

const IDENTITY = `${ME}:1`;
const SYNC = { to: "/sync", search: { tab: "queue" } } as const;
const dialog = () => screen.queryByRole("dialog");
const inDialog = () => within(dialog() as HTMLElement);
const minimum = () =>
  inDialog().getByLabelText(CORRECTION_COPY.minimum) as HTMLInputElement;
const saveButton = () =>
  inDialog().getByRole("button", {
    name: CORRECTION_COPY.save,
  }) as HTMLButtonElement;
const at = (t: Mounted) => t.router.history.location.pathname;
const instance = () =>
  (dialog() as HTMLElement | null)?.getAttribute("data-instance") ?? null;
const corrections = (t: Mounted) =>
  t
    .bodies()
    .map((b) => b.command.command)
    .map((c) => ({
      kind: c.kind,
      id: c.id,
      minimum: (c.definition as { goal: { minimum: string | null } }).goal
        .minimum,
    }));
const navigateTo = (t: Mounted, where: Where | string) =>
  void t.router.navigate(
    (where === "/sync" ? SYNC : { to: where, search: {} }) as never,
  );

/**
 * Holds the acknowledgement of the next `enqueue` until `release()`: the write commits first (`committed`). `refuse`/`throws`: hold BEFORE
 * the transaction, then refuse or throw (nothing written). Later calls pass through.
 */
function holdNext(
  t: Mounted,
  outcome: "commit" | "refuse" | "throws" = "commit",
) {
  const outbox = t.data.outbox();
  if (outbox === null) throw new Error("setup: no outbox");
  const real = outbox.enqueue.bind(outbox);
  let open!: () => void;
  const gate = new Promise<void>((r) => {
    open = r;
  });
  const state = { committed: false, asked: false };
  let used = false;
  outbox.enqueue = async (request) => {
    if (used) return real(request);
    used = true;
    state.asked = true;
    if (outcome === "refuse") {
      await gate;
      return { kind: "refused", reason: "quota" } as never;
    }
    if (outcome === "throws") {
      await gate;
      throw new Error("the store threw");
    }
    const result = await real(request);
    state.committed = true;
    await gate;
    return result;
  };
  return { state, release: () => open() };
}

/** Every settlement of the day's correction, with whether the original dialog was still mounted when it was published. */
function watch(key: string, original: () => HTMLElement | null) {
  const seen: { kind: CorrectionEvent["kind"]; mounted: boolean }[] = [];
  const stop = subscribeCorrection(key, (event) => {
    const node = original();
    seen.push({
      kind: event.kind,
      mounted: node !== null && document.contains(node),
    });
  });
  return { seen, stop };
}

async function openCorrection() {
  const task = await seededTask({
    definition: {
      goal: { kind: "numeric", minimum: "10", maximum: null, unit: "cups" },
    },
  });
  const path = `/tasks/${task.taskId}`;
  const t = await mountTasks({ path, rows: task.rows, env: { online: false } });
  await t.until(
    () => screen.queryByRole("button", { name: CORRECTION_COPY.open }) !== null,
  );
  fireEvent.click(screen.getByRole("button", { name: CORRECTION_COPY.open }));
  await t.until(() => dialog() !== null);
  const original = dialog() as HTMLElement;
  original.setAttribute("data-instance", "original");
  const key = correctionKey(IDENTITY, task.occurrenceId);
  return { t, task, path, key, original };
}

/** Type `value` and Save; wait until the outbox committed it (the acknowledgement held). */
async function saveHeld(t: Mounted, value: string) {
  fireEvent.change(minimum(), { target: { value } });
  const hold = holdNext(t);
  fireEvent.click(saveButton());
  await t.until(() => hold.state.committed);
  expect(hold.state.committed, "the outbox committed the save").toBe(true);
  expect(saveButton().disabled, "the save is pending").toBe(true);
  return hold;
}

/** Away to `where` and back to `path` in ONE act (React never removes the dialog), releasing `hold` after the return. */
async function awayAndBackThenRelease(
  t: Mounted,
  where: Where,
  path: string,
  hold: { release(): void },
  original: HTMLElement,
) {
  await act(async () => {
    navigateTo(t, where);
    expect(at(t), "the history moved").toBe(where);
    expect(document.contains(original), "the dialog is still mounted").toBe(
      true,
    );
    navigateTo(t, path);
    expect(at(t), "back at the task").toBe(path);
    hold.release();
  });
  await t.settle();
}

/** A fixed settle after Save, not a wait: a Save that does nothing must fail the write assertions, not time out. */
async function save(t: Mounted) {
  fireEvent.click(saveButton());
  await t.settle();
}

describe("R36: the same dialog instance, away and back before the acknowledgement", () => {
  for (const where of ["/tasks", "/sync"] as const)
    test(`${where} and back, then acknowledged: one correction, the same dialog starts afresh, the next Save writes 13 and closes it`, async () => {
      const { t, task, path, key, original } = await openCorrection();
      const hold = await saveHeld(t, "12");
      const consumed = correctionEntry(key)?.session;
      const w = watch(key, () => original);
      await awayAndBackThenRelease(t, where, path, hold, original);
      w.stop();
      expect(w.seen, "consumed while the original dialog was mounted").toEqual([
        { kind: "consumed", mounted: true },
      ]);
      expect(at(t)).toBe(path);
      expect(instance(), "the same dialog instance").toBe("original");
      expect(corrections(t)).toEqual([
        { kind: "revise_occurrence", id: task.occurrenceId, minimum: "12" },
      ]);
      // A fresh session, from the day as shown now: never the consumed one, nothing pending, nothing written by opening it.
      const fresh = correctionEntry(key);
      expect(fresh, "the dialog holds a session").not.toBeNull();
      expect(fresh?.session).not.toBe(consumed);
      expect(fresh?.revision).toBe(0);
      expect(fresh?.submitting).toBeNull();
      expect(minimum().value).toBe(fresh?.state.minimum);
      expect(saveButton().disabled).toBe(false);
      fireEvent.change(minimum(), { target: { value: "13" } });
      expect(minimum().value, "the later value is shown").toBe("13");
      await save(t);
      expect(
        corrections(t)
          .map((c) => c.minimum)
          .sort(),
      ).toEqual(["12", "13"]);
      expect(
        corrections(t).every(
          (c) => c.kind === "revise_occurrence" && c.id === task.occurrenceId,
        ),
      ).toBe(true);
      expect(dialog(), "the current correction's success closes it").toBeNull();
      expect(at(t)).toBe(path);
      expect(correctionEntry(key)).toBeNull();
    });

  test("control: staying, acknowledged: the dialog closes; reopened, the next Save writes 13", async () => {
    const { t, task, key } = await openCorrection();
    const hold = await saveHeld(t, "12");
    await act(async () => hold.release());
    await t.settle();
    expect(dialog()).toBeNull();
    expect(correctionEntry(key)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: CORRECTION_COPY.open }));
    await t.until(() => dialog() !== null);
    fireEvent.change(minimum(), { target: { value: "13" } });
    await save(t);
    expect(corrections(t)).toEqual([
      expect.objectContaining({
        id: task.occurrenceId,
        minimum: expect.any(String),
      }),
      expect.objectContaining({
        id: task.occurrenceId,
        minimum: expect.any(String),
      }),
    ]);
    expect(
      corrections(t)
        .map((c) => c.minimum)
        .sort(),
    ).toEqual(["12", "13"]);
    expect(dialog()).toBeNull();
  });

  test("control: the dialog removed (the sync screens), acknowledged there, back and reopened: the next Save writes 13", async () => {
    const { t, path, original } = await openCorrection();
    const hold = await saveHeld(t, "12");
    await act(async () => {
      await t.router.navigate(SYNC as never);
    });
    await t.settle();
    expect(document.contains(original), "the old dialog was removed").toBe(
      false,
    );
    await act(async () => hold.release());
    await t.settle();
    await act(async () => {
      await t.router.navigate({ to: path, search: {} } as never);
    });
    await t.settle();
    expect(dialog(), "the consumed save is not shown again").toBeNull();
    await t.until(
      () =>
        screen.queryByRole("button", { name: CORRECTION_COPY.open }) !== null,
    );
    fireEvent.click(screen.getByRole("button", { name: CORRECTION_COPY.open }));
    await t.until(() => dialog() !== null);
    fireEvent.change(minimum(), { target: { value: "13" } });
    await save(t);
    expect(
      corrections(t)
        .map((c) => c.minimum)
        .sort(),
    ).toEqual(["12", "13"]);
    expect(dialog()).toBeNull();
  });
});

describe("R36: the same dialog instance, acknowledged while away, then back", () => {
  for (const where of ["/tasks", "/sync"] as const)
    test(`${where}: acknowledged there before the dialog was removed, then back: the dialog starts afresh on the return, and the next Save writes 13`, async () => {
      const { t, task, path, key, original } = await openCorrection();
      const hold = await saveHeld(t, "12");
      const consumed = correctionEntry(key)?.session;
      const w = watch(key, () => original);
      await act(async () => {
        navigateTo(t, where);
        expect(at(t)).toBe(where);
        hold.release();
        // The acknowledgement settles while the person is away and the dialog is still mounted.
        for (let i = 0; i < 50 && w.seen.length === 0; i += 1)
          await Promise.resolve();
        expect(w.seen, "settled while away").toEqual([
          { kind: "consumed", mounted: true },
        ]);
        expect(at(t)).toBe(where);
        expect(correctionEntry(key), "nothing opened while away").toBeNull();
        navigateTo(t, path);
        expect(at(t)).toBe(path);
      });
      await t.settle();
      w.stop();
      expect(instance()).toBe("original");
      const fresh = correctionEntry(key);
      expect(fresh?.session).not.toBe(consumed);
      expect(fresh?.revision).toBe(0);
      expect(corrections(t)).toHaveLength(1);
      fireEvent.change(minimum(), { target: { value: "13" } });
      await save(t);
      expect(
        corrections(t)
          .map((c) => c.minimum)
          .sort(),
      ).toEqual(["12", "13"]);
      expect(corrections(t).every((c) => c.id === task.occurrenceId)).toBe(
        true,
      );
      expect(dialog()).toBeNull();
    });
});

describe("R36: three explicit saves across two immediate returns", () => {
  test("12 (the sync screens and back), 13 (the task list and back), 14 (staying): three corrections, each listener and cleanup following the current session", async () => {
    const { t, task, path, key, original } = await openCorrection();
    const first = await saveHeld(t, "12");
    await awayAndBackThenRelease(t, "/sync", path, first, original);
    expect(instance()).toBe("original");
    const second = await saveHeld(t, "13");
    const secondSession = correctionEntry(key)?.session;
    await awayAndBackThenRelease(t, "/tasks", path, second, original);
    expect(instance()).toBe("original");
    expect(correctionEntry(key)?.session).not.toBe(secondSession);
    fireEvent.change(minimum(), { target: { value: "14" } });
    await save(t);
    expect(
      corrections(t)
        .map((c) => c.minimum)
        .sort(),
    ).toEqual(["12", "13", "14"]);
    expect(corrections(t).every((c) => c.id === task.occurrenceId)).toBe(true);
    expect(dialog()).toBeNull();
    expect(correctionEntry(key)).toBeNull();
  });
});

describe("R36: kept input on the same instance (refusal, newer edit)", () => {
  for (const outcome of ["refuse", "throws"] as const)
    for (const where of ["/tasks", "/sync"] as const)
      test(`${outcome === "refuse" ? "refused" : "the store threw"}, ${where} and back: 12 kept, nothing written; Save again writes 12 once and closes the dialog`, async () => {
        const { t, task, path, key, original } = await openCorrection();
        fireEvent.change(minimum(), { target: { value: "12" } });
        const hold = holdNext(t, outcome);
        fireEvent.click(saveButton());
        await t.until(() => hold.state.asked);
        const session = correctionEntry(key)?.session;
        const w = watch(key, () => original);
        await awayAndBackThenRelease(t, where, path, hold, original);
        w.stop();
        expect(w.seen).toEqual([{ kind: "settled", mounted: true }]);
        expect(instance()).toBe("original");
        expect(t.bodies()).toEqual([]);
        expect(minimum().value, "the refused input is kept").toBe("12");
        expect(correctionEntry(key)?.session, "the same session").toBe(session);
        expect(saveButton().disabled).toBe(false);
        await save(t);
        expect(corrections(t)).toEqual([
          { kind: "revise_occurrence", id: task.occurrenceId, minimum: "12" },
        ]);
        expect(
          dialog(),
          "the retried save closes the dialog the person is at",
        ).toBeNull();
        expect(at(t)).toBe(path);
      });

  for (const where of ["/tasks", "/sync"] as const)
    test(`15 typed while 12 was pending, ${where} and back, then 12 acknowledged: 15 is kept; Save writes 15 and closes the dialog`, async () => {
      const { t, task, path, key, original } = await openCorrection();
      const hold = await saveHeld(t, "12");
      fireEvent.change(minimum(), { target: { value: "15" } });
      const session = correctionEntry(key)?.session;
      const w = watch(key, () => original);
      await awayAndBackThenRelease(t, where, path, hold, original);
      w.stop();
      expect(w.seen, "the older save leaves the newer input").toEqual([
        { kind: "settled", mounted: true },
      ]);
      expect(instance()).toBe("original");
      expect(minimum().value).toBe("15");
      expect(correctionEntry(key)?.session).toBe(session);
      expect(corrections(t).map((c) => c.minimum)).toEqual(["12"]);
      await save(t);
      expect(
        corrections(t)
          .map((c) => c.minimum)
          .sort(),
      ).toEqual(["12", "15"]);
      expect(corrections(t).every((c) => c.id === task.occurrenceId)).toBe(
        true,
      );
      expect(dialog()).toBeNull();
    });
});

describe("R36: the visit owns the same instance's input after a return", () => {
  test("the task list and back (a new visit), 16 typed, the in-dialog sync control, Back: Correct resumes 16; nothing written", async () => {
    const { t, path, key, original } = await openCorrection();
    fireEvent.change(minimum(), { target: { value: "12" } });
    await act(async () => {
      navigateTo(t, "/tasks");
      expect(document.contains(original)).toBe(true);
      navigateTo(t, path);
    });
    await t.settle();
    expect(instance()).toBe("original");
    expect(minimum().value, "the input on the screen").toBe("12");
    fireEvent.change(minimum(), { target: { value: "16" } });
    const chip = inDialog()
      .getAllByRole("button")
      .find((b) => b.hasAttribute("data-sync-tone"));
    expect(chip, "the in-dialog sync control").toBeDefined();
    fireEvent.click(chip as HTMLElement);
    await t.until(() => dialog() === null);
    await act(async () => {
      await t.router.navigate(SYNC as never);
    });
    await t.settle();
    expect(correctionEntry(key)?.retained, "kept for the visit").toBe(true);
    await act(async () => {
      t.router.history.back();
    });
    await t.settle();
    expect(at(t)).toBe(path);
    await t.until(
      () =>
        screen.queryByRole("button", { name: CORRECTION_COPY.open }) !== null,
    );
    fireEvent.click(screen.getByRole("button", { name: CORRECTION_COPY.open }));
    await t.until(() => dialog() !== null);
    expect(minimum().value).toBe("16");
    expect(t.bodies()).toEqual([]);
  });

  test("control: the task list and back with nothing typed, Cancel: the session ends; Correct starts from the day", async () => {
    const { t, path, key, original } = await openCorrection();
    await act(async () => {
      navigateTo(t, "/tasks");
      expect(document.contains(original)).toBe(true);
      navigateTo(t, path);
    });
    await t.settle();
    expect(instance()).toBe("original");
    fireEvent.click(
      inDialog().getByRole("button", { name: CORRECTION_COPY.cancel }),
    );
    await t.settle();
    expect(dialog()).toBeNull();
    expect(correctionEntry(key)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: CORRECTION_COPY.open }));
    await t.until(() => dialog() !== null);
    expect(minimum().value).toBe("10");
    expect(t.bodies()).toEqual([]);
  });

  test("after a fresh start on return, Cancel ends the NEW session and leaves the consumed save queued", async () => {
    const { t, path, key, original } = await openCorrection();
    const hold = await saveHeld(t, "12");
    await awayAndBackThenRelease(t, "/sync", path, hold, original);
    expect(instance()).toBe("original");
    expect(correctionEntry(key)).not.toBeNull();
    fireEvent.change(minimum(), { target: { value: "17" } });
    fireEvent.click(
      inDialog().getByRole("button", { name: CORRECTION_COPY.cancel }),
    );
    await t.settle();
    expect(dialog()).toBeNull();
    expect(correctionEntry(key), "the fresh session ended").toBeNull();
    expect(corrections(t).map((c) => c.minimum)).toEqual(["12"]);
  });

  test("leaving after a fresh start on return: the task list drops the fresh session; nothing more written", async () => {
    const { t, path, key, original } = await openCorrection();
    const hold = await saveHeld(t, "12");
    await awayAndBackThenRelease(t, "/tasks", path, hold, original);
    expect(instance()).toBe("original");
    fireEvent.change(minimum(), { target: { value: "18" } });
    await act(async () => {
      await t.router.navigate({ to: "/tasks", search: {} } as never);
    });
    await t.settle();
    expect(dialog()).toBeNull();
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    expect(
      correctionEntry(key),
      "an ended visit's input is dropped",
    ).toBeNull();
    expect(corrections(t).map((c) => c.minimum)).toEqual(["12"]);
  });
});
