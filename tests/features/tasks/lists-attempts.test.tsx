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
import { listItem } from "../../../src/features/tasks/model/lists";
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
    commands(t, "list_item").map(
      (c) => `${c.included ? "+" : "-"}${c.task_id}`,
    );

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
