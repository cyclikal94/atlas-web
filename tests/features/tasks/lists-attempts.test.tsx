import {
  act,
  cleanup,
  fireEvent,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { EnqueueRequest } from "../../../src/data";
import {
  CREATE,
  DETAIL,
  PICKER,
  RENAME,
} from "../../../src/features/tasks/lists/copy";
import { createList, listItem } from "../../../src/features/tasks/model/lists";
import { installMatchMedia } from "../../helpers/match-media";
import {
  forgetLists,
  listId,
  listRow,
  taskId,
  taskRow,
} from "../../support/tasks/lists";
import { mountTasks } from "../../support/tasks/world";

/**
 * WEB-10b review R1/R2 (revision 1): a save's local id stays bound to the ONE request it was sent with. In the app's router over the
 * PRODUCTION data controller, outbox and the IndexedDB double; a lost answer is placed by wrapping the outbox's enqueue (the commit made,
 * or not, then a throw), a controlled simulation rather than an observed storage failure. FIXTURE evidence.
 *
 * R1 (create, and rename of a cached list): an answer that may hide a stored save binds the session to that request; every later Save
 * sends it again unchanged (same key, body and captured defaults) until it is saved, and only then is newer input saved, under new ids.
 * Newer input is never consumed by the earlier request's success, and no second list or rename comes of one attempt. A definite refusal
 * binds nothing. R2 (the picker): a saved add retires its id, so the same task chosen again later is a new add; ids of adds not saved stay.
 */
installMatchMedia({ width: 1440 });
afterEach(() => {
  cleanup();
  forgetLists();
});
type Mounted = Awaited<ReturnType<typeof mountTasks>>;

const commands = (t: Mounted, kind: string) =>
  t
    .drafts()
    .map(
      (d) =>
        t.bodies().find((b) => b.local_id === d.local_id)?.command as {
          command: Record<string, unknown>;
        },
    )
    .map((b) => b.command)
    .filter((c) => c.kind === kind);
const names = (t: Mounted, kind: string) =>
  commands(t, kind).map((c) => c.name);
const dialog = () => screen.queryByRole("dialog") as HTMLElement | null;
function press(name: string, root: HTMLElement | Document = document) {
  const found = within(root as HTMLElement).queryAllByRole("button", {
    name,
  })[0];
  expect(found, `the button "${name}"`).toBeDefined();
  fireEvent.click(found as HTMLElement);
}
const nameField = () =>
  within(dialog() as HTMLElement).getByLabelText(
    CREATE.name,
  ) as HTMLInputElement;
const typeName = (value: string) =>
  fireEvent.change(nameField(), { target: { value } });
const saveButton = (label: string) =>
  within(dialog() as HTMLElement).getByRole("button", {
    name: label,
  }) as HTMLButtonElement;

/**
 * The outbox's enqueue, wrapped: the `n`th call is answered by `answer` (`lost-after-commit`: stored, then the answer lost; `lost-before-
 * commit`: nothing stored, the call throws; `storage-after-commit`: stored, then refused `storage`; `refused`: a definite quota refusal; `hold`: held until it settles, then answered as `after`,
 * else by the real enqueue).
 */
type Lost =
  | "lost-after-commit"
  | "lost-before-commit"
  | "storage-after-commit"
  | "refused";
type Answer = Lost | { hold: Promise<void>; after?: Lost };
function answers(t: Mounted, plan: Record<number, Answer>) {
  const outbox = t.data.outbox();
  if (outbox === null) throw new Error("no outbox");
  const real = outbox.enqueue.bind(outbox);
  const asked: EnqueueRequest[] = [];
  outbox.enqueue = async (request) => {
    asked.push(request);
    const planned = plan[asked.length];
    if (typeof planned === "object") await planned.hold;
    const answer = typeof planned === "object" ? planned.after : planned;
    if (answer === "lost-before-commit")
      throw new Error("lost before the commit");
    if (answer === "refused") return { kind: "refused", reason: "quota" };
    const result = await real(request);
    if (answer === "lost-after-commit") throw new Error("lost after commit");
    // The facade's own answer when the store failed after the write committed (`refuse`: "storage").
    if (answer === "storage-after-commit")
      return { kind: "refused", reason: "storage" };
    return result;
  };
  return { asked, real };
}
function held() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function openCreate() {
  const t = await mountTasks({ path: "/tasks/lists", env: { online: false } });
  await t.until(() => document.querySelector("[data-new-list]") !== null);
  return t;
}
async function createFirst(t: Mounted, name: string) {
  press("+ New list");
  await t.settle();
  typeName(name);
  press(CREATE.submit, dialog() as HTMLElement);
  await t.settle();
}
const box = (id: string) =>
  document.querySelector(
    `[data-picker-task="${id}"] input`,
  ) as HTMLInputElement | null;
/** The task a `list_item` request names (its body, built on a stand-in base). */
const taskOf = (request: EnqueueRequest) =>
  (
    request.build({ [request.targets[0]?.resourceId as string]: 1 }) as {
      command: { command: { task_id?: string } };
    }
  ).command.command.task_id;
const adds = (t: Mounted) =>
  commands(t, "list_item").map((c) => `${c.included ? "+" : "-"}${c.task_id}`);
/** The in-dialog sync control, then the sync screens (the dialog is removed); `back` returns (Back mounts it again). */
async function toSync(t: Mounted) {
  const chip = within(dialog() as HTMLElement)
    .getAllByRole("button")
    .find((x) => x.hasAttribute("data-sync-tone"));
  expect(chip, "the in-dialog sync control").toBeDefined();
  await act(async () => {
    fireEvent.click(chip as HTMLElement);
    await t.router.navigate({ to: "/sync", search: { tab: "queue" } });
  });
  await t.settle();
  expect(dialog(), "the dialog is removed at the sync screens").toBeNull();
}
async function back(t: Mounted) {
  await act(async () => {
    t.router.history.back();
  });
  await t.until(() => dialog() !== null);
}
const sameIds = (a?: EnqueueRequest, b?: EnqueueRequest) =>
  a !== undefined &&
  b !== undefined &&
  a.localId === b.localId &&
  a.targets[0]?.resourceId === b.targets[0]?.resourceId;

describe("R1: create, an answer that may hide a stored save", () => {
  for (const lost of ["lost-after-commit", "lost-before-commit"] as const)
    test(`${lost}, unchanged retry: the same request again, one list, the dialog goes to it`, async () => {
      const t = await openCreate();
      const { asked } = answers(t, { 1: lost });
      await createFirst(t, "Original name");
      expect(dialog(), "the uncertain save keeps the dialog").not.toBeNull();
      press(CREATE.submit, dialog() as HTMLElement);
      await t.until(() => dialog() === null);
      expect(asked).toHaveLength(2);
      expect(asked[1], "the request sent first, unchanged").toBe(asked[0]);
      expect(names(t, "create_list")).toEqual(["Original name"]);
      const id = commands(t, "create_list")[0]?.id as string;
      expect(t.router.state.location.pathname).toBe(`/tasks/lists/${id}`);
    });

  for (const lost of [
    "lost-after-commit",
    "lost-before-commit",
    "storage-after-commit",
  ] as const)
    test(`${lost}, edited retry: the earlier request is settled as sent; the newer name stays, then is a list of its own`, async () => {
      const t = await openCreate();
      const { asked } = answers(t, { 1: lost });
      await createFirst(t, "Original name");
      typeName("Newer name");
      press(CREATE.submit, dialog() as HTMLElement);
      await t.settle();
      expect(asked[1], "the earlier request, not the edited one").toBe(
        asked[0],
      );
      expect(names(t, "create_list")).toEqual(["Original name"]);
      expect(dialog(), "the newer input is not consumed").not.toBeNull();
      expect(nameField().value).toBe("Newer name");
      expect(
        within(dialog() as HTMLElement).queryByText(
          CREATE.earlier("Original name"),
        ),
      ).not.toBeNull();
      expect(t.router.state.location.pathname).toBe("/tasks/lists");
      // The next Save is the newer name under NEW ids: a list of its own, never a duplicate of the first.
      press(CREATE.submit, dialog() as HTMLElement);
      await t.until(() => dialog() === null);
      expect(names(t, "create_list")).toEqual(["Original name", "Newer name"]);
      expect(sameIds(asked[2], asked[0])).toBe(false);
      expect(asked[2]?.localId).not.toBe(asked[0]?.localId);
    });

  test("a definite refusal binds nothing: the edited retry sends the newer name under the same ids", async () => {
    const t = await openCreate();
    const { asked } = answers(t, { 1: "refused" });
    await createFirst(t, "Original name");
    expect(dialog()).not.toBeNull();
    expect(t.drafts()).toEqual([]);
    typeName("Newer name");
    press(CREATE.submit, dialog() as HTMLElement);
    await t.until(() => dialog() === null);
    expect(sameIds(asked[1], asked[0])).toBe(true);
    expect(names(t, "create_list")).toEqual(["Newer name"]);
  });

  test("edits while the save is pending: a success keeps them (new ids); an uncertain answer keeps them and binds its request", async () => {
    const t = await openCreate();
    const first = held();
    const second = held();
    const { asked } = answers(t, {
      1: { hold: first.promise },
      2: { hold: second.promise, after: "lost-after-commit" },
    });
    await createFirst(t, "One");
    // The fieldset is disabled while saving; the session takes newer input through its editor.
    typeName("One more");
    await act(async () => {
      first.resolve();
    });
    await t.settle();
    expect(names(t, "create_list")).toEqual(["One"]);
    expect(nameField().value).toBe("One more");
    expect(
      within(dialog() as HTMLElement).queryByText(RENAME.newer),
    ).not.toBeNull();
    // The next save is under new ids; its answer is lost while yet newer input arrives.
    press(CREATE.submit, dialog() as HTMLElement);
    await t.settle();
    typeName("One more again");
    await act(async () => {
      second.resolve();
    });
    await t.settle();
    expect(sameIds(asked[1], asked[0])).toBe(false);
    expect(names(t, "create_list")).toEqual(["One", "One more"]);
    expect(nameField().value, "the newest input stays").toBe("One more again");
    // Save sends the bound request again (stored: recognised, nothing added), and the newest input still stays.
    press(CREATE.submit, dialog() as HTMLElement);
    await t.settle();
    expect(asked[2]).toBe(asked[1]);
    expect(names(t, "create_list")).toEqual(["One", "One more"]);
    expect(nameField().value).toBe("One more again");
    expect(
      within(dialog() as HTMLElement).queryByText(CREATE.earlier("One more")),
    ).not.toBeNull();
  });
});

describe("R1: rename of a cached list, an answer that may hide a stored save", () => {
  async function renameFirst(answer: Answer, name: string) {
    const id = listId();
    const t = await mountTasks({
      path: `/tasks/lists/${id}`,
      rows: [listRow(id, "Initial", [])],
      env: { online: false },
    });
    await t.until(
      () => document.querySelector(`[data-list-detail="${id}"]`) !== null,
    );
    const { asked } = answers(t, { 1: answer });
    press(DETAIL.rename);
    await t.settle();
    typeName(name);
    press(RENAME.submit, dialog() as HTMLElement);
    await t.settle();
    return { t, asked };
  }

  test("lost after commit, unchanged retry: Save stays available, sends the same request, one rename, the dialog closes", async () => {
    const { t, asked } = await renameFirst(
      "lost-after-commit",
      "Original rename",
    );
    expect(dialog()).not.toBeNull();
    // The queued rename already shows as the list's name; the unsettled save can still be confirmed.
    expect(saveButton(RENAME.submit).disabled).toBe(false);
    press(RENAME.submit, dialog() as HTMLElement);
    await t.until(() => dialog() === null);
    expect(asked[1]).toBe(asked[0]);
    expect(names(t, "edit_list")).toEqual(["Original rename"]);
  });

  for (const lost of ["lost-after-commit", "lost-before-commit"] as const)
    test(`${lost}, edited retry: the earlier rename is settled as sent; the newer name stays, then is saved as its own rename`, async () => {
      const { t, asked } = await renameFirst(lost, "Original rename");
      typeName("Newer rename");
      press(RENAME.submit, dialog() as HTMLElement);
      await t.settle();
      expect(asked[1]).toBe(asked[0]);
      expect(names(t, "edit_list")).toEqual(["Original rename"]);
      expect(dialog()).not.toBeNull();
      expect(nameField().value).toBe("Newer rename");
      expect(
        within(dialog() as HTMLElement).queryByText(
          RENAME.earlier("Original rename"),
        ),
      ).not.toBeNull();
      press(RENAME.submit, dialog() as HTMLElement);
      await t.until(() => dialog() === null);
      expect(names(t, "edit_list")).toEqual([
        "Original rename",
        "Newer rename",
      ]);
      expect(asked[2]?.localId).not.toBe(asked[0]?.localId);
    });

  test("a definite refusal binds nothing: the edited retry sends the newer name under the same local id", async () => {
    const { t, asked } = await renameFirst("refused", "Original rename");
    expect(t.drafts()).toEqual([]);
    typeName("Newer rename");
    press(RENAME.submit, dialog() as HTMLElement);
    await t.until(() => dialog() === null);
    expect(asked[1]?.localId).toBe(asked[0]?.localId);
    expect(names(t, "edit_list")).toEqual(["Newer rename"]);
  });
});

describe("R2: the picker retires a saved add's id", () => {
  async function partialSave() {
    const id = listId();
    const [a, b] = [taskId(1), taskId(2)];
    const t = await mountTasks({
      path: `/tasks/lists/${id}`,
      rows: [
        listRow(id, "Errands", []),
        taskRow(a, "First"),
        taskRow(b, "Second"),
      ],
      env: { online: false },
    });
    await t.until(
      () => document.querySelector(`[data-list-detail="${id}"]`) !== null,
    );
    const { asked, real } = answers(t, { 2: "refused" });
    press(DETAIL.add);
    await t.until(() => box(a) !== null);
    fireEvent.click(box(a) as HTMLInputElement);
    fireEvent.click(box(b) as HTMLInputElement);
    press(PICKER.submit, dialog() as HTMLElement);
    await t.settle();
    expect(dialog(), "a partial save keeps the picker").not.toBeNull();
    expect(commands(t, "list_item")).toHaveLength(1);
    return { t, id, a, b, asked, real };
  }

  test("removed elsewhere, then chosen again in the same session: a NEW add, after the remove; the unsaved task keeps its id", async () => {
    const { t, id, a, b, asked, real } = await partialSave();
    // Another tab's remove of A, an ordinary command through the same outbox.
    await act(async () => {
      await real(listItem({ listId: id, taskId: a, included: false }));
    });
    await t.until(() => box(a) !== null);
    fireEvent.click(box(a) as HTMLInputElement);
    press(PICKER.submit, dialog() as HTMLElement);
    await t.until(() => dialog() === null);
    expect(adds(t)).toEqual([`+${a}`, `-${a}`, `+${b}`, `+${a}`]);
    const ofA = asked.filter((r) => taskOf(r) === a);
    expect(ofA).toHaveLength(2);
    expect(ofA[1]?.localId, "the second add of A is a new add").not.toBe(
      ofA[0]?.localId,
    );
    const ofB = asked.filter((r) => taskOf(r) === b);
    expect(ofB[1]?.localId, "B's add keeps its id").toBe(ofB[0]?.localId);
  });

  test("control: without the remove, the retry adds only the task not saved, with its id", async () => {
    const { t, a, b } = await partialSave();
    press(PICKER.submit, dialog() as HTMLElement);
    await t.until(() => dialog() === null);
    expect(adds(t)).toEqual([`+${a}`, `+${b}`]);
  });

  test("the session kept through the sync screens retires it too: chosen again on return, a new add", async () => {
    const { t, id, a, real } = await partialSave();
    const chip = within(dialog() as HTMLElement)
      .getAllByRole("button")
      .find((x) => x.hasAttribute("data-sync-tone"));
    expect(chip, "the in-dialog sync control").toBeDefined();
    await act(async () => {
      fireEvent.click(chip as HTMLElement);
      await t.router.navigate({ to: "/sync", search: { tab: "queue" } });
    });
    await t.settle();
    await act(async () => {
      await real(listItem({ listId: id, taskId: a, included: false }));
    });
    await act(async () => {
      t.router.history.back();
    });
    await t.until(() => dialog() !== null && box(a) !== null);
    fireEvent.click(box(a) as HTMLInputElement);
    press(PICKER.submit, dialog() as HTMLElement);
    await t.until(() => dialog() === null);
    expect(
      adds(t).filter((x) => x === `+${a}`),
      "two separate adds of A around its remove",
    ).toHaveLength(2);
  });

  for (const lost of ["lost-after-commit", "lost-before-commit"] as const)
    test(`${lost}: the add is retried under its id, or seen as made; one add`, async () => {
      const id = listId();
      const a = taskId(7);
      const t = await mountTasks({
        path: `/tasks/lists/${id}`,
        rows: [listRow(id, "Errands", []), taskRow(a, "Lost answer")],
        env: { online: false },
      });
      await t.until(
        () => document.querySelector(`[data-list-detail="${id}"]`) !== null,
      );
      const { asked } = answers(t, { 1: lost });
      press(DETAIL.add);
      await t.until(() => box(a) !== null);
      fireEvent.click(box(a) as HTMLInputElement);
      press(PICKER.submit, dialog() as HTMLElement);
      await t.settle();
      expect(dialog()).not.toBeNull();
      if (lost === "lost-after-commit") {
        // Stored after all: the composition now holds it, so the picker no longer offers or counts it.
        await t.until(() => box(a) === null);
        expect(box(a)).toBeNull();
        expect(screen.queryByText(PICKER.selected(0))).not.toBeNull();
      } else {
        expect(box(a)?.checked, "still selected").toBe(true);
        press(PICKER.submit, dialog() as HTMLElement);
        await t.until(() => dialog() === null);
        expect(dialog()).toBeNull();
        expect(asked[1]?.localId).toBe(asked[0]?.localId);
      }
      expect(adds(t)).toEqual([`+${a}`]);
    });
});

/**
 * Review 2 R1 (revision 2): the settlement of an earlier, unsettled request reaches the editor holding the session WHEN it settles, with
 * what it leaves (new ids, the binding gone): on the mount that took the save, while the dialog is away at the sync screens, and on the
 * dialog Back mounted again while the retry was pending (the review's failing schedule). The next explicit Save then saves the newer input
 * once, under new ids: never the earlier request again, never an extra Save that does nothing.
 */
describe("R1 (review 2): the earlier request's settlement reaches the editor holding the session", () => {
  type Kind = "create" | "rename";
  type Schedule =
    | "same mount"
    | "remounted while pending"
    | "settled while away";
  const label = (kind: Kind) =>
    kind === "create" ? CREATE.submit : RENAME.submit;
  const stored = (t: Mounted, kind: Kind) =>
    names(t, kind === "create" ? "create_list" : "edit_list");
  async function retryHeld(kind: Kind) {
    const id = listId();
    const t = await mountTasks({
      path: kind === "create" ? "/tasks/lists" : `/tasks/lists/${id}`,
      rows: [listRow(id, "Initial", [])],
      env: { online: false },
    });
    await t.until(() =>
      kind === "create"
        ? document.querySelector("[data-new-list]") !== null
        : document.querySelector(`[data-list-detail="${id}"]`) !== null,
    );
    const gate = held();
    const { asked } = answers(t, {
      1: "lost-after-commit",
      2: { hold: gate.promise },
    });
    press(kind === "create" ? "+ New list" : DETAIL.rename);
    await t.settle();
    typeName("Original");
    press(label(kind), dialog() as HTMLElement);
    await t.settle();
    expect(stored(t, kind)).toEqual(["Original"]);
    typeName("Newer");
    press(label(kind), dialog() as HTMLElement);
    await t.settle();
    expect(asked, "the retry of the earlier request is pending").toHaveLength(
      2,
    );
    expect(asked[1]).toBe(asked[0]);
    return { t, id, gate, asked };
  }

  for (const kind of ["create", "rename"] as const)
    for (const schedule of [
      "same mount",
      "remounted while pending",
      "settled while away",
    ] as Schedule[])
      test(`${kind}, ${schedule}: the next Save saves the newer name once, under new ids`, async () => {
        const { t, gate, asked } = await retryHeld(kind);
        const at = t.router.state.location.pathname;
        if (schedule !== "same mount") await toSync(t);
        if (schedule === "remounted while pending") await back(t);
        await act(async () => {
          gate.resolve();
        });
        await t.settle();
        if (schedule === "settled while away") {
          expect(
            t.router.state.location.pathname,
            "no navigation while away",
          ).toBe("/sync");
          await back(t);
        }
        expect(t.router.state.location.pathname).toBe(at);
        expect(nameField().value, "the newer input stays").toBe("Newer");
        const earlier =
          kind === "create"
            ? CREATE.earlier("Original")
            : RENAME.earlier("Original");
        expect(
          within(dialog() as HTMLElement).queryByText(earlier),
          "the earlier save's note",
        ).not.toBeNull();
        expect(saveButton(label(kind)).disabled).toBe(false);
        press(label(kind), dialog() as HTMLElement);
        await t.until(() => dialog() === null);
        expect(stored(t, kind)).toEqual(["Original", "Newer"]);
        expect(asked, "no Save that does nothing").toHaveLength(3);
        expect(
          asked[2]?.localId,
          "the newer name under a new local id",
        ).not.toBe(asked[0]?.localId);
        if (kind === "create") {
          expect(sameIds(asked[2], asked[0])).toBe(false);
          const id = commands(t, "create_list")[1]?.id as string;
          expect(t.router.state.location.pathname).toBe(`/tasks/lists/${id}`);
          expect(asked[2]?.targets[0]?.resourceId).toBe(id);
        }
      });

  for (const kind of ["create", "rename"] as const)
    test(`${kind}, abandoned while the retry is pending (Cancel): its settlement opens, navigates and binds nothing; the next dialog starts afresh`, async () => {
      const { t, gate, asked } = await retryHeld(kind);
      const at = t.router.state.location.pathname;
      press(
        kind === "create" ? CREATE.cancel : RENAME.cancel,
        dialog() as HTMLElement,
      );
      await t.settle();
      expect(dialog()).toBeNull();
      await act(async () => {
        gate.resolve();
      });
      await t.settle();
      expect(dialog(), "nothing reopens").toBeNull();
      expect(t.router.state.location.pathname).toBe(at);
      press(kind === "create" ? "+ New list" : DETAIL.rename);
      await t.settle();
      expect(nameField().value, "a fresh session").toBe(
        kind === "create" ? "" : "Original",
      );
      expect(
        within(dialog() as HTMLElement).queryByText(/earlier save/),
      ).toBeNull();
      typeName("Third");
      press(label(kind), dialog() as HTMLElement);
      await t.until(() => dialog() === null);
      expect(stored(t, kind)).toEqual(["Original", "Third"]);
      expect(asked).toHaveLength(3);
      expect(asked[2]?.localId).not.toBe(asked[0]?.localId);
    });

  test("rename of a list whose create is queued, its in-place edit's answer lost after it was written: never shown as saved, the input kept; the digest still guards a later edit (no edit_list)", async () => {
    const t = await mountTasks({
      path: "/tasks/lists",
      env: { online: false },
    });
    const outbox = t.data.outbox();
    if (outbox === null) throw new Error("no outbox");
    const id = listId();
    await act(async () => {
      await outbox.enqueue(
        createList({ listId: id, name: "Old", defaults: null }),
      );
    });
    await act(async () => {
      await t.router.navigate({ to: `/tasks/lists/${id}` } as never);
    });
    await t.until(
      () => document.querySelector(`[data-list-detail="${id}"]`) !== null,
    );
    const real = outbox.editQueued.bind(outbox);
    let edits = 0;
    outbox.editQueued = async (localId, request) => {
      edits += 1;
      const result = await real(localId, request);
      if (edits === 1) throw new Error("lost after the edit was written");
      return result;
    };
    press(DETAIL.rename);
    await t.settle();
    typeName("Renamed");
    press(RENAME.submit, dialog() as HTMLElement);
    await t.settle();
    // Written after all: the queued create carries the name; the dialog never says it saved, and keeps what was typed (P2: the refusal
    // stays visible). With the list already so named there is nothing to save, so Save says why.
    expect(names(t, "create_list")).toEqual(["Renamed"]);
    expect(dialog(), "not shown as saved").not.toBeNull();
    expect(nameField().value).toBe("Renamed");
    expect(
      within(dialog() as HTMLElement).queryByText(RENAME.saved),
    ).toBeNull();
    expect(saveButton(RENAME.submit).disabled).toBe(true);
    // A later edit meets the digest this dialog saw (`seen`): the lost edit is never silently overwritten as if unseen.
    typeName("Again");
    press(RENAME.submit, dialog() as HTMLElement);
    await t.settle();
    expect(
      within(dialog() as HTMLElement).queryByText(RENAME.changedElsewhere),
    ).not.toBeNull();
    expect(names(t, "create_list")).toEqual(["Renamed"]);
    expect(nameField().value).toBe("Again");
    press(RENAME.submit, dialog() as HTMLElement);
    await t.until(() => dialog() === null);
    expect(names(t, "create_list")).toEqual(["Again"]);
    expect(commands(t, "edit_list")).toEqual([]);
    expect(edits).toBe(2);
  });
});

/**
 * Review 2 R2 (revision 2): a SELECTION, not the task, names an add. The review's failing schedule: A's add stored but its answer lost (B
 * not sent), the list then holds A, another actor removes A, and the person chooses A again: a NEW add after the remove. A selection whose
 * add was lost is settled by what is stored under its id, never by the list's membership: found, it is done (and the person is told); not
 * found, the same add is sent again. FIXTURE evidence over the production outbox; the lost answers are controlled simulations.
 */
describe("R2 (review 2): a lost add, then a remove, then the task chosen again", () => {
  async function lostThenSeen(
    answer: Record<number, Answer> = { 1: "lost-after-commit" },
  ) {
    const id = listId();
    const [a, b] = [taskId(1), taskId(2)];
    const t = await mountTasks({
      path: `/tasks/lists/${id}`,
      rows: [
        listRow(id, "Errands", []),
        taskRow(a, "First"),
        taskRow(b, "Second"),
      ],
      env: { online: false },
    });
    await t.until(
      () => document.querySelector(`[data-list-detail="${id}"]`) !== null,
    );
    const { asked, real } = answers(t, answer);
    press(DETAIL.add);
    await t.until(() => box(a) !== null);
    fireEvent.click(box(a) as HTMLInputElement);
    fireEvent.click(box(b) as HTMLInputElement);
    press(PICKER.submit, dialog() as HTMLElement);
    await t.settle();
    expect(dialog(), "the uncertain add keeps the picker").not.toBeNull();
    const remove = () =>
      act(async () => {
        await real(listItem({ listId: id, taskId: a, included: false }));
      });
    return { t, id, a, b, asked, real, remove };
  }
  const requested = (asked: EnqueueRequest[], task: string) =>
    asked.filter((r) => taskOf(r) === task);

  test("the review's schedule: A seen in the list, removed elsewhere, chosen again: +A, -A, +B, +A; the second A a new add", async () => {
    const { t, a, b, asked, remove } = await lostThenSeen();
    await t.until(() => box(a) === null);
    expect(adds(t)).toEqual([`+${a}`]);
    await remove();
    await t.until(() => box(a) !== null);
    if ((box(a) as HTMLInputElement).checked)
      fireEvent.click(box(a) as HTMLInputElement);
    expect((box(a) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(box(a) as HTMLInputElement);
    press(PICKER.submit, dialog() as HTMLElement);
    await t.until(() => dialog() === null);
    expect(adds(t)).toEqual([`+${a}`, `-${a}`, `+${b}`, `+${a}`]);
    const ofA = requested(asked, a);
    expect(ofA).toHaveLength(2);
    expect(ofA[1]?.localId, "a new add").not.toBe(ofA[0]?.localId);
    expect(requested(asked, b), "B sent once").toHaveLength(1);
  });

  test("the earlier selection shown again and Add pressed: it is found saved, not made again, and the person is told; chosen again, a new add", async () => {
    const { t, a, b, asked, remove } = await lostThenSeen();
    await t.until(() => box(a) === null);
    await remove();
    await t.until(() => box(a) !== null);
    expect((box(a) as HTMLInputElement).checked, "the earlier selection").toBe(
      true,
    );
    press(PICKER.submit, dialog() as HTMLElement);
    await t.settle();
    expect(dialog(), "not closed as if A were added").not.toBeNull();
    expect(adds(t)).toEqual([`+${a}`, `-${a}`, `+${b}`]);
    expect(
      within(dialog() as HTMLElement).queryByText(PICKER.earlier(1)),
    ).not.toBeNull();
    // B is a member now: the offered page is read again before A's row is back.
    await t.until(() => box(a) !== null);
    expect((box(a) as HTMLInputElement).checked, "that selection is done").toBe(
      false,
    );
    expect(requested(asked, a), "nothing sent again for A").toHaveLength(1);
    fireEvent.click(box(a) as HTMLInputElement);
    press(PICKER.submit, dialog() as HTMLElement);
    await t.until(() => dialog() === null);
    expect(adds(t)).toEqual([`+${a}`, `-${a}`, `+${b}`, `+${a}`]);
    const ofA = requested(asked, a);
    expect(ofA[1]?.localId).not.toBe(ofA[0]?.localId);
  });

  test("the add and the remove both while the picker is at the sync screens (no membership ever seen): chosen again on return, a new add", async () => {
    const { t, a, b, asked, remove } = await lostThenSeen();
    await toSync(t);
    await remove();
    await back(t);
    await t.until(() => box(a) !== null);
    if ((box(a) as HTMLInputElement).checked)
      fireEvent.click(box(a) as HTMLInputElement);
    fireEvent.click(box(a) as HTMLInputElement);
    press(PICKER.submit, dialog() as HTMLElement);
    await t.until(() => dialog() === null);
    expect(adds(t)).toEqual([`+${a}`, `-${a}`, `+${b}`, `+${a}`]);
    const ofA = requested(asked, a);
    expect(ofA[1]?.localId).not.toBe(ofA[0]?.localId);
  });

  test("control, no remove: the lost add is seen made; B alone is added, once", async () => {
    const { t, a, b, asked } = await lostThenSeen();
    await t.until(() => box(a) === null);
    press(PICKER.submit, dialog() as HTMLElement);
    await t.until(() => dialog() === null);
    expect(adds(t)).toEqual([`+${a}`, `+${b}`]);
    expect(requested(asked, a)).toHaveLength(1);
  });

  test("another actor adds and removes A while this add was NOT stored: membership settles nothing; Add sends the same add again", async () => {
    const { t, id, a, b, asked, real } = await lostThenSeen({
      1: "lost-before-commit",
    });
    expect(adds(t)).toEqual([]);
    await act(async () => {
      await real(listItem({ listId: id, taskId: a, included: true }));
    });
    await t.until(() => box(a) === null);
    await act(async () => {
      await real(listItem({ listId: id, taskId: a, included: false }));
    });
    await t.until(() => box(a) !== null);
    expect((box(a) as HTMLInputElement).checked, "still this selection").toBe(
      true,
    );
    press(PICKER.submit, dialog() as HTMLElement);
    await t.until(() => dialog() === null);
    expect(adds(t)).toEqual([`+${a}`, `-${a}`, `+${a}`, `+${b}`]);
    const ofA = requested(asked, a);
    expect(ofA).toHaveLength(2);
    expect(ofA[1]?.localId, "the same add, sent again").toBe(ofA[0]?.localId);
    const stored = t.drafts().map((d) => d.local_id);
    expect(stored).toContain(ofA[0]?.localId);
  });

  test("a partial save settled on the picker mounted again on Back: A done, B kept (its add retried under its id), the search typed meanwhile kept", async () => {
    const id = listId();
    const [a, b] = [taskId(1), taskId(2)];
    const t = await mountTasks({
      path: `/tasks/lists/${id}`,
      rows: [
        listRow(id, "Errands", []),
        taskRow(a, "First"),
        taskRow(b, "Second"),
      ],
      env: { online: false },
    });
    await t.until(
      () => document.querySelector(`[data-list-detail="${id}"]`) !== null,
    );
    const gate = held();
    const { asked } = answers(t, {
      2: { hold: gate.promise, after: "lost-before-commit" },
    });
    press(DETAIL.add);
    await t.until(() => box(a) !== null);
    fireEvent.click(box(a) as HTMLInputElement);
    fireEvent.click(box(b) as HTMLInputElement);
    press(PICKER.submit, dialog() as HTMLElement);
    await t.until(() => asked.length === 2);
    fireEvent.change(screen.getByLabelText(PICKER.searchLabel), {
      target: { value: "Sec" },
    });
    await toSync(t);
    await back(t);
    await act(async () => {
      gate.resolve();
    });
    await t.settle();
    expect(
      (screen.getByLabelText(PICKER.searchLabel) as HTMLInputElement).value,
    ).toBe("Sec");
    await t.until(() => box(b) !== null);
    expect((box(b) as HTMLInputElement).checked, "B still selected").toBe(true);
    expect(screen.queryByText(PICKER.selected(1))).not.toBeNull();
    expect(screen.queryByText(/Added 1 of 2\./)).not.toBeNull();
    press(PICKER.submit, dialog() as HTMLElement);
    await t.until(() => dialog() === null);
    expect(adds(t)).toEqual([`+${a}`, `+${b}`]);
    const ofB = requested(asked, b);
    expect(ofB).toHaveLength(2);
    expect(ofB[1]?.localId, "B's add retried under its id").toBe(
      ofB[0]?.localId,
    );
  });

  test("every add saved while the search changed, settled on the picker mounted again on Back: the search and the note stay, nothing is selected", async () => {
    const id = listId();
    const a = taskId(1);
    const t = await mountTasks({
      path: `/tasks/lists/${id}`,
      rows: [
        listRow(id, "Errands", []),
        taskRow(a, "First"),
        taskRow(taskId(2), "Second"),
      ],
      env: { online: false },
    });
    await t.until(
      () => document.querySelector(`[data-list-detail="${id}"]`) !== null,
    );
    const gate = held();
    const { asked } = answers(t, { 1: { hold: gate.promise } });
    press(DETAIL.add);
    await t.until(() => box(a) !== null);
    fireEvent.click(box(a) as HTMLInputElement);
    press(PICKER.submit, dialog() as HTMLElement);
    await t.until(() => asked.length === 1);
    fireEvent.change(screen.getByLabelText(PICKER.searchLabel), {
      target: { value: "Sec" },
    });
    await toSync(t);
    await back(t);
    await act(async () => {
      gate.resolve();
    });
    await t.settle();
    expect(dialog(), "newer input keeps the picker").not.toBeNull();
    expect(
      (screen.getByLabelText(PICKER.searchLabel) as HTMLInputElement).value,
    ).toBe("Sec");
    expect(
      within(dialog() as HTMLElement).queryByText(PICKER.newer),
    ).not.toBeNull();
    expect(screen.queryByText(PICKER.selected(0))).not.toBeNull();
    expect(adds(t)).toEqual([`+${a}`]);
  });
});

/**
 * Review 2 R2, the design assessment's matrix rows for the picker that the schedules above leave: a save settled while the picker is away at
 * the sync screens, a picker abandoned while its save is pending, and an exact read of the stored draft that FAILS (no answer is not "not
 * stored", and certainly not "stored": the same add is sent again, as before revision 2).
 */
describe("R2 (review 2): the picker's other settlement and evidence paths", () => {
  async function pickerOf(titles: string[]) {
    const id = listId();
    const tasks = titles.map((title, n) => ({ id: taskId(n + 1), title }));
    const t = await mountTasks({
      path: `/tasks/lists/${id}`,
      rows: [
        listRow(id, "Errands", []),
        ...tasks.map((x) => taskRow(x.id, x.title)),
      ],
      env: { online: false },
    });
    await t.until(
      () => document.querySelector(`[data-list-detail="${id}"]`) !== null,
    );
    return { t, id, ids: tasks.map((x) => x.id) };
  }

  test("a partial save settled while the picker is at the sync screens: on Back, A is done and B kept with its add's id", async () => {
    const { t, ids } = await pickerOf(["First", "Second"]);
    const [a, b] = ids as [string, string];
    const gate = held();
    const { asked } = answers(t, {
      2: { hold: gate.promise, after: "lost-before-commit" },
    });
    press(DETAIL.add);
    await t.until(() => box(a) !== null);
    fireEvent.click(box(a) as HTMLInputElement);
    fireEvent.click(box(b) as HTMLInputElement);
    press(PICKER.submit, dialog() as HTMLElement);
    await t.until(() => asked.length === 2);
    await toSync(t);
    await act(async () => {
      gate.resolve();
    });
    await t.settle();
    expect(t.router.state.location.pathname, "no navigation while away").toBe(
      "/sync",
    );
    await back(t);
    await t.until(() => box(b) !== null);
    expect((box(b) as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByText(PICKER.selected(1))).not.toBeNull();
    expect(screen.queryByText(/Added 1 of 2\./)).not.toBeNull();
    press(PICKER.submit, dialog() as HTMLElement);
    await t.until(() => dialog() === null);
    expect(adds(t)).toEqual([`+${a}`, `+${b}`]);
    const ofB = asked.filter((r) => taskOf(r) === b);
    expect(ofB[1]?.localId).toBe(ofB[0]?.localId);
  });

  test("abandoned (Escape) while its save is pending: the settlement opens nothing, and the picker opened again starts afresh", async () => {
    const { t, ids } = await pickerOf(["First"]);
    const [a] = ids as [string];
    const gate = held();
    const { asked } = answers(t, { 1: { hold: gate.promise } });
    press(DETAIL.add);
    await t.until(() => box(a) !== null);
    fireEvent.click(box(a) as HTMLInputElement);
    press(PICKER.submit, dialog() as HTMLElement);
    await t.until(() => asked.length === 1);
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    await t.settle();
    expect(dialog()).toBeNull();
    await act(async () => {
      gate.resolve();
    });
    await t.settle();
    expect(dialog(), "nothing reopens").toBeNull();
    expect(adds(t)).toEqual([`+${a}`]);
    press(DETAIL.add);
    await t.until(() => dialog() !== null);
    expect(screen.queryByText(PICKER.selected(0))).not.toBeNull();
    expect(
      within(dialog() as HTMLElement).queryByText(PICKER.newer),
    ).toBeNull();
  });

  test("the exact read of a lost add's draft fails: no answer is taken as neither stored nor absent; the same add is sent again", async () => {
    const { t, ids } = await pickerOf(["First"]);
    const [a] = ids as [string];
    const { asked } = answers(t, { 1: "lost-before-commit" });
    press(DETAIL.add);
    await t.until(() => box(a) !== null);
    fireEvent.click(box(a) as HTMLInputElement);
    press(PICKER.submit, dialog() as HTMLElement);
    await t.settle();
    expect(dialog()).not.toBeNull();
    const service = t.data.service();
    if (service === null) throw new Error("no service");
    const run = service.store.run.bind(service.store);
    let failedReads = 0;
    service.store.run = (async (plan: { name: string }, ...rest: unknown[]) => {
      if (plan.name === "data.readDraftHeader") {
        failedReads += 1;
        throw new Error("the read failed");
      }
      return (run as (...args: unknown[]) => unknown)(plan, ...rest);
    }) as typeof service.store.run;
    expect((box(a) as HTMLInputElement).checked).toBe(true);
    press(PICKER.submit, dialog() as HTMLElement);
    await t.until(() => dialog() === null);
    expect(failedReads, "the read was asked, and failed").toBe(1);
    expect(adds(t)).toEqual([`+${a}`]);
    expect(asked[1]?.localId, "the same add again").toBe(asked[0]?.localId);
  });
});
