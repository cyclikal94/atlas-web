import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { DraftWithCommand } from "../../../src/data";
import { forgetAllPeopleMemory } from "../../../src/features/people/memory";
import { forgetRefusedPolicies } from "../../../src/features/sharing/api";
import { installMatchMedia } from "../../helpers/match-media";
import { draftRow } from "../../support/data/rows";
import { record } from "../../support/people/records";
import {
  fieldRow,
  type PeopleWorld,
  peopleWorld,
  person,
} from "../../support/people/world";

/**
 * Review 9, finding 1 (`people-form-completion-lifetime`, incomplete fix of review 8, finding 1): the field editor has ONE owner per
 * TARGET (the identity, the person, the field or a new one). The router shows another field of the same person through the same route
 * component; that view's title, its kept session and what its Cancel, close icon and Escape end are all the new target's, and nothing of
 * the previous target's view (still reachable: a handler captured before the change) ends a session or navigates. Every case has its
 * same-target or normal-editor control. Fixture evidence (jsdom, the real route composition of the people world). Review 9's design
 * assessment, DA9-01 to DA9-03 and DA9-10.
 */
installMatchMedia({ width: 1440 });
beforeEach(() => {
  forgetAllPeopleMemory();
  forgetRefusedPolicies();
});
afterEach(async () => {
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 0));
});

const P = "55555555-5555-4555-8555-555555555555";
const Q = "57575757-5757-4575-8575-575757575757";
const F = "66666666-6666-4666-8666-666666666666";
const G = "88888888-8888-4888-8888-888888888888";
const H = "89898989-8989-4898-8898-898989898989";
const OUTSTANDING = "data.readOutstandingCreates";

const capping = (): DraftWithCommand[] =>
  Array.from({ length: 1001 }, (_, i) =>
    draftRow({
      local_id: `a${i + 1}`,
      created_seq: i + 1,
      command: {
        command: {
          kind: "archive",
          id: `99999999-9999-4999-8999-${String(i).padStart(12, "0")}`,
          expected_version: 1,
          archived: true,
        },
      },
    }),
  );

function world() {
  const w = peopleWorld();
  w.setCache([
    person({ id: P, label: "Ada" }),
    person({ id: Q, label: "Bo" }),
    fieldRow({
      id: F,
      parent_id: P,
      label: "First",
      value: { kind: "text", text: "First saved" },
    }),
    fieldRow({
      id: G,
      parent_id: P,
      label: "Second",
      value: { kind: "text", text: "Second saved" },
    }),
    fieldRow({
      id: H,
      parent_id: Q,
      label: "Third",
      value: { kind: "text", text: "Third saved" },
    }),
  ]);
  w.env.setDefaults(record());
  return w;
}

/** The dialog named `name`, once shown (its absence is an assertion failure, never a query error). */
async function dialogNamed(name: string | RegExp): Promise<HTMLElement> {
  return waitFor(() => {
    const found = screen.queryByRole("dialog", { name });
    expect(found, `the dialog ${String(name)} is shown`).not.toBeNull();
    return found as HTMLElement;
  });
}
const pathOf = (personId: string, fieldId: string | null) =>
  `/people/${personId}/fields/${fieldId ?? "new"}`;
const editor = (name: string) => dialogNamed(name);
/** The editor's Value input (its absence is an assertion failure). */
function value(d: HTMLElement): HTMLElement {
  const box = within(d).queryByRole("textbox", { name: "Value" });
  expect(box, "the editor's Value input is shown").not.toBeNull();
  return box as HTMLElement;
}
const unread = (d: HTMLElement) =>
  d.querySelector('[data-people-state="editor-unread"]');
const closed = () =>
  waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

type Reads = "failed" | "capped";
function spoil(w: PeopleWorld, reads: Reads) {
  if (reads === "failed") w.failRead(OUTSTANDING);
  else w.setDrafts(capping());
}
function repair(w: PeopleWorld, reads: Reads) {
  if (reads === "failed") w.restoreReads();
  else w.setDrafts([]);
}

/** Types `text` into the field's editor and leaves it kept (the tree unmounted, the same identity). */
async function keep(
  w: PeopleWorld,
  fieldId: string,
  name: string,
  text: string,
  personId = P,
) {
  await w.mount(pathOf(personId, fieldId));
  const d = await editor(`Edit ${name}`);
  fireEvent.change(value(d), { target: { value: text } });
  cleanup();
}

/** The value a field's editor opens with, its reads readable (a fresh tree). */
async function reopenedValue(
  w: PeopleWorld,
  fieldId: string,
  name: string,
  personId = P,
) {
  cleanup();
  await w.mount(pathOf(personId, fieldId));
  return (value(await editor(`Edit ${name}`)) as HTMLInputElement).value;
}

async function go(
  router: Awaited<ReturnType<PeopleWorld["mount"]>>["router"],
  personId: string,
  fieldId: string | null,
) {
  await act(async () => {
    if (fieldId === null)
      await router.navigate({
        to: "/people/$personId/fields/new",
        params: { personId },
      });
    else
      await router.navigate({
        to: "/people/$personId/fields/$fieldId",
        params: { personId, fieldId },
      });
  });
}

const ENDINGS = ["Cancel", "Close", "Escape"] as const;
type Ending = (typeof ENDINGS)[number];
async function dismiss(d: HTMLElement, ending: Ending) {
  if (ending === "Escape") fireEvent.keyDown(d, { key: "Escape" });
  else fireEvent.click(within(d).getByRole("button", { name: ending }));
  await closed();
}

/** A React handler of an element, as it was when captured: invoked after its view was replaced, as a stale handler would be. */
function handlerOf(element: HTMLElement, name: "onClick") {
  const key = Object.keys(element).find((k) => k.startsWith("__reactProps$"));
  if (key === undefined) throw new Error("no React props on the element");
  const handler = (
    element as unknown as Record<string, Record<string, unknown>>
  )[key]?.[name];
  if (typeof handler !== "function") throw new Error(`no ${name}`);
  return handler as (event?: unknown) => void;
}

describe("DA9-01: another field's route through the same route component, while the editor cannot edit", () => {
  for (const reads of ["failed", "capped"] as const)
    for (const ending of ENDINGS) {
      test(`${reads} chain, First → Second, ${ending}: Second's session ends, First keeps its own`, async () => {
        const w = world();
        await keep(w, F, "First", "First unsaved secret");
        await keep(w, G, "Second", "Second unsaved secret");
        spoil(w, reads);
        const { router } = await w.mount(pathOf(P, F));
        expect(unread(await editor("Edit First"))).not.toBeNull();
        await go(router, P, G);
        const d = await editor("Edit Second");
        expect(unread(d), "Second's own view, unread").not.toBeNull();
        expect(router.state.location.pathname).toBe(pathOf(P, G));
        await dismiss(d, ending);
        expect(router.state.location.pathname).toBe(`/people/${P}`);
        repair(w, reads);
        expect(await reopenedValue(w, G, "Second")).toBe("Second saved");
        expect(await reopenedValue(w, F, "First")).toBe("First unsaved secret");
        expect(w.built).toHaveLength(0);
      });

      test(`control, ${reads} chain, Second opened directly, ${ending}: Second's session ends`, async () => {
        const w = world();
        await keep(w, F, "First", "First unsaved secret");
        await keep(w, G, "Second", "Second unsaved secret");
        spoil(w, reads);
        await w.mount(pathOf(P, G));
        const d = await editor("Edit Second");
        expect(unread(d)).not.toBeNull();
        await dismiss(d, ending);
        repair(w, reads);
        expect(await reopenedValue(w, G, "Second")).toBe("Second saved");
        expect(await reopenedValue(w, F, "First")).toBe("First unsaved secret");
      });
    }

  for (const ending of ENDINGS)
    test(`control, the normal editor, First → Second, ${ending}: Second's session ends, First keeps its own`, async () => {
      const w = world();
      await keep(w, F, "First", "First unsaved secret");
      await keep(w, G, "Second", "Second unsaved secret");
      const { router } = await w.mount(pathOf(P, F));
      expect(value(await editor("Edit First"))).toHaveValue(
        "First unsaved secret",
      );
      await go(router, P, G);
      const d = await editor("Edit Second");
      expect(value(d)).toHaveValue("Second unsaved secret");
      await dismiss(d, ending);
      expect(await reopenedValue(w, G, "Second")).toBe("Second saved");
      expect(await reopenedValue(w, F, "First")).toBe("First unsaved secret");
    });
});

describe("DA9-02: the target's session follows the target, from no session as from one", () => {
  test("First kept nothing, Second kept input: First → Second, Cancel ends Second's session", async () => {
    const w = world();
    await keep(w, G, "Second", "Second unsaved secret");
    w.failRead(OUTSTANDING);
    const { router } = await w.mount(pathOf(P, F));
    expect(unread(await editor("Edit First"))).not.toBeNull();
    await go(router, P, G);
    const d = await editor("Edit Second");
    expect(unread(d)).not.toBeNull();
    await dismiss(d, "Cancel");
    w.restoreReads();
    expect(await reopenedValue(w, G, "Second")).toBe("Second saved");
  });

  test("First kept input, Second kept nothing: First → Second, Cancel ends nothing of First's", async () => {
    const w = world();
    await keep(w, F, "First", "First unsaved secret");
    w.failRead(OUTSTANDING);
    const { router } = await w.mount(pathOf(P, F));
    expect(unread(await editor("Edit First"))).not.toBeNull();
    await go(router, P, G);
    await dismiss(await editor("Edit Second"), "Cancel");
    w.restoreReads();
    expect(await reopenedValue(w, F, "First")).toBe("First unsaved secret");
    expect(await reopenedValue(w, G, "Second")).toBe("Second saved");
  });

  test("existing → new → existing: each view ends its own target's session only", async () => {
    const w = world();
    await keep(w, F, "First", "First unsaved secret");
    await w.mount(pathOf(P, null));
    fireEvent.change(
      within(await editor("Add a field")).getByRole("textbox", {
        name: "Name",
      }),
      { target: { value: "New secret name" } },
    );
    cleanup();
    w.failRead(OUTSTANDING);
    const { router } = await w.mount(pathOf(P, F));
    expect(unread(await editor("Edit First"))).not.toBeNull();
    await go(router, P, null);
    const fresh = await editor("Add a field");
    expect(unread(fresh)).not.toBeNull();
    await dismiss(fresh, "Cancel");
    await go(router, P, F);
    expect(unread(await editor("Edit First"))).not.toBeNull();
    w.restoreReads();
    cleanup();
    await w.mount(pathOf(P, null));
    expect(
      within(await editor("Add a field")).getByRole("textbox", {
        name: "Name",
      }),
      "the new field's ended session is gone: an empty new field",
    ).toHaveValue("");
    expect(await reopenedValue(w, F, "First")).toBe("First unsaved secret");
  });

  test("another person's field (the person's screen remounts): Cancel ends that field's session, not the first person's", async () => {
    const w = world();
    await keep(w, F, "First", "First unsaved secret");
    await keep(w, H, "Third", "Third unsaved secret", Q);
    w.failRead(OUTSTANDING);
    const { router } = await w.mount(pathOf(P, F));
    expect(unread(await editor("Edit First"))).not.toBeNull();
    await go(router, Q, H);
    const d = await editor("Edit Third");
    expect(unread(d)).not.toBeNull();
    await dismiss(d, "Cancel");
    expect(router.state.location.pathname).toBe(`/people/${Q}`);
    w.restoreReads();
    expect(await reopenedValue(w, H, "Third", Q)).toBe("Third saved");
    expect(await reopenedValue(w, F, "First")).toBe("First unsaved secret");
  });
});

describe("DA9-03: a handler of a replaced view ends nothing and navigates nowhere", () => {
  test("the unread First's Cancel, invoked after Second is shown: no navigation, Second and First keep their input", async () => {
    const w = world();
    await keep(w, F, "First", "First unsaved secret");
    await keep(w, G, "Second", "Second unsaved secret");
    w.failRead(OUTSTANDING);
    const { router } = await w.mount(pathOf(P, F));
    const first = await editor("Edit First");
    const oldCancel = handlerOf(
      within(first).getByRole("button", { name: "Cancel" }),
      "onClick",
    );
    await go(router, P, G);
    const second = await editor("Edit Second");
    await act(async () => oldCancel());
    expect(router.state.location.pathname).toBe(pathOf(P, G));
    expect(screen.queryByRole("dialog", { name: "Edit Second" })).toBe(second);
    w.restoreReads();
    expect(await reopenedValue(w, G, "Second")).toBe("Second unsaved secret");
    expect(await reopenedValue(w, F, "First")).toBe("First unsaved secret");
  });

  test("the normal First's Cancel, invoked after Second is shown: no navigation, Second and First keep their input", async () => {
    const w = world();
    await keep(w, F, "First", "First unsaved secret");
    await keep(w, G, "Second", "Second unsaved secret");
    const { router } = await w.mount(pathOf(P, F));
    const first = await editor("Edit First");
    const oldCancel = handlerOf(
      within(first).getByRole("button", { name: "Cancel" }),
      "onClick",
    );
    await go(router, P, G);
    const second = await editor("Edit Second");
    await act(async () => oldCancel());
    expect(router.state.location.pathname).toBe(pathOf(P, G));
    expect(screen.queryByRole("dialog", { name: "Edit Second" })).toBe(second);
    expect(value(second)).toHaveValue("Second unsaved secret");
    expect(await reopenedValue(w, F, "First")).toBe("First unsaved secret");
  });

  test("the unread view's Cancel, invoked after Try again showed the editor: the same session stays open and kept", async () => {
    const w = world();
    await keep(w, F, "First", "First unsaved secret");
    w.failRead(OUTSTANDING);
    const { router } = await w.mount(pathOf(P, F));
    const d = await editor("Edit First");
    const oldCancel = handlerOf(
      within(d).getByRole("button", { name: "Cancel" }),
      "onClick",
    );
    w.restoreReads();
    fireEvent.click(within(d).getByRole("button", { name: "Try again" }));
    const shown = await waitFor(() => {
      const now = screen.getByRole("dialog", { name: "Edit First" });
      expect(value(now)).toHaveValue("First unsaved secret");
      return now;
    });
    await act(async () => oldCancel());
    expect(router.state.location.pathname).toBe(pathOf(P, F));
    expect(screen.queryByRole("dialog", { name: "Edit First" })).toBe(shown);
    expect(await reopenedValue(w, F, "First")).toBe("First unsaved secret");
  });

  test("control: the view shown now ends its session (the same Cancel, pressed on the current view)", async () => {
    const w = world();
    await keep(w, F, "First", "First unsaved secret");
    w.failRead(OUTSTANDING);
    const { router } = await w.mount(pathOf(P, F));
    const d = await editor("Edit First");
    await act(async () =>
      handlerOf(within(d).getByRole("button", { name: "Cancel" }), "onClick")(),
    );
    await closed();
    expect(router.state.location.pathname).toBe(`/people/${P}`);
    w.restoreReads();
    expect(await reopenedValue(w, F, "First")).toBe("First saved");
  });
});

describe("DA9-10: Try again and the sync control keep the session through a target change; dismissal of nothing is harmless", () => {
  test("First → Second (unread), the sync control: Second's input is kept, First's too", async () => {
    const w = world();
    await keep(w, F, "First", "First unsaved secret");
    await keep(w, G, "Second", "Second unsaved secret");
    w.failRead(OUTSTANDING);
    const { router } = await w.mount(pathOf(P, F));
    expect(unread(await editor("Edit First"))).not.toBeNull();
    await go(router, P, G);
    const d = await editor("Edit Second");
    fireEvent.click(within(d).getByRole("button", { name: /sync/i }));
    await closed();
    w.restoreReads();
    expect(await reopenedValue(w, G, "Second")).toBe("Second unsaved secret");
    expect(await reopenedValue(w, F, "First")).toBe("First unsaved secret");
    expect(w.built).toHaveLength(0);
  });

  test("First → Second (unread), repaired, Try again: Second's own input comes back, nothing is saved", async () => {
    const w = world();
    await keep(w, F, "First", "First unsaved secret");
    await keep(w, G, "Second", "Second unsaved secret");
    w.failRead(OUTSTANDING);
    const { router } = await w.mount(pathOf(P, F));
    expect(unread(await editor("Edit First"))).not.toBeNull();
    await go(router, P, G);
    const d = await editor("Edit Second");
    w.restoreReads();
    fireEvent.click(within(d).getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(
        value(screen.getByRole("dialog", { name: "Edit Second" })),
      ).toHaveValue("Second unsaved secret"),
    );
    expect(w.built).toHaveLength(0);
  });

  test("nothing kept for either field: First → Second, Cancel closes and leaves both on their saved values", async () => {
    const w = world();
    w.failRead(OUTSTANDING);
    const { router } = await w.mount(pathOf(P, F));
    expect(unread(await editor("Edit First"))).not.toBeNull();
    await go(router, P, G);
    await dismiss(await editor("Edit Second"), "Cancel");
    w.restoreReads();
    expect(await reopenedValue(w, G, "Second")).toBe("Second saved");
    expect(await reopenedValue(w, F, "First")).toBe("First saved");
  });
});
