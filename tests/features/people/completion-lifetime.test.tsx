import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { LATER_EDITS_KEPT } from "../../../src/features/people/copy";
import {
  forgetAllPeopleMemory,
  peopleMemory,
} from "../../../src/features/people/memory";
import { forgetRefusedPolicies } from "../../../src/features/sharing/api";
import { installMatchMedia } from "../../helpers/match-media";
import { ME, record } from "../../support/people/records";
import {
  fieldRow,
  type PeopleWorld,
  peopleWorld,
  person,
} from "../../support/people/world";

/**
 * Review 6, finding 1 (`people-form-completion-lifetime`): a save's completion ends only the EDITING SESSION it was made in
 * (`src/features/people/lifetime.ts`). Each schedule holds the save after it was observed to start, changes what is open (Cancel and a
 * new form, a remount of the same session, going away, another identity), then releases it; each has a control in which the save
 * completes first. The reviewer's schedule (Cancel, reopen, type, release) is the first case of each form. Fixture evidence (jsdom).
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
const F = "66666666-6666-4666-8666-666666666666";
const NEW_KEY = `field:${P}:new`;

/** A gate on the next calls of `fn`: `entered` once one is waiting, `release` lets every waiting one go on. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  const state = { entered: 0 };
  return {
    state,
    wait: async () => {
      state.entered += 1;
      await opened;
    },
    release: async () => {
      await act(async () => {
        open();
        await opened;
      });
    },
  };
}

/** Holds the outbox's `enqueue` (a queued save) until released. */
function holdEnqueue(w: PeopleWorld) {
  const g = gate();
  const outbox = w.env.outbox();
  if (outbox === null) throw new Error("no outbox");
  const original = outbox.enqueue.bind(outbox);
  outbox.enqueue = async (...args: Parameters<typeof original>) => {
    await g.wait();
    return original(...args);
  };
  return g;
}

const dialog = () => screen.findByRole("dialog");
const typeField = (d: HTMLElement, name: string, value: string) => {
  fireEvent.change(within(d).getByRole("textbox", { name: "Name" }), {
    target: { value: name },
  });
  fireEvent.change(within(d).getByRole("textbox", { name: "Value" }), {
    target: { value },
  });
};
const save = (d: HTMLElement) =>
  fireEvent.click(within(d).getByRole("button", { name: "Save" }));
const cancel = async (d: HTMLElement) => {
  fireEvent.click(within(d).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
};
const kept = (w: PeopleWorld, key: string) =>
  w.people.memory.drafts.get(key) as
    | { session: string; form: { name: string } }
    | undefined;

function seeded() {
  const w = peopleWorld();
  w.setCache([person({ id: P, label: "Ada" })]);
  w.env.setDefaults(record());
  return w;
}

describe("review 6, finding 1: the field editor's completion ends only its own session", () => {
  for (const completedFirst of [false, true])
    test(`a shared create (Home · can view) after Cancel and a new "Add a field": ${completedFirst ? "control, completed before reopening" : "the reviewer's schedule: the new editor and its input stay"}`, async () => {
      const w = seeded();
      const g = gate();
      w.api.next.shared.push(async () => {
        await g.wait();
        return { ok: true, value: { revision: 10 } };
      });
      const { router } = await w.mount(`/people/${P}/fields/new`);
      let d = await dialog();
      typeField(d, "First", "First saved text");
      fireEvent.click(
        within(d).getByRole("radio", { name: "Home · can view" }),
      );
      save(d);
      await waitFor(() => expect(g.state.entered).toBe(1));
      if (completedFirst) {
        await g.release();
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      } else await cancel(d);
      await act(async () => {
        await router.navigate({
          to: "/people/$personId/fields/new",
          params: { personId: P },
        });
      });
      d = await dialog();
      typeField(d, "Second", "Second unsaved text");
      if (!completedFirst) await g.release();
      // The first save was made (once) and is told; the new session is untouched.
      expect(
        w.api.calls.filter((call) => call.op === "putFieldShared"),
      ).toHaveLength(1);
      expect(router.state.location.pathname).toBe(`/people/${P}/fields/new`);
      expect(screen.queryByRole("dialog")).not.toBeNull();
      expect(
        within(screen.getByRole("dialog")).getByRole("textbox", {
          name: "Value",
        }),
      ).toHaveValue("Second unsaved text");
      expect(kept(w, NEW_KEY)?.form.name).toBe("Second");
    });

  for (const completedFirst of [false, true])
    test(`a queued create after Cancel and a new "Add a field": ${completedFirst ? "control, completed before reopening" : "the new editor and its input stay"}`, async () => {
      const w = seeded();
      const g = holdEnqueue(w);
      const { router } = await w.mount(`/people/${P}/fields/new`);
      let d = await dialog();
      typeField(d, "First", "First text");
      save(d);
      await waitFor(() => expect(g.state.entered).toBe(1));
      if (completedFirst) {
        await g.release();
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      } else await cancel(d);
      await act(async () => {
        await router.navigate({
          to: "/people/$personId/fields/new",
          params: { personId: P },
        });
      });
      d = await dialog();
      typeField(d, "Second", "Second unsaved text");
      if (!completedFirst) await g.release();
      await waitFor(() => expect(w.built).toHaveLength(1));
      expect(router.state.location.pathname).toBe(`/people/${P}/fields/new`);
      expect(screen.queryByRole("dialog")).not.toBeNull();
      expect(kept(w, NEW_KEY)?.form.name).toBe("Second");
    });

  for (const completedFirst of [false, true])
    test(`an update of an existing field after Cancel and Edit again: ${completedFirst ? "control" : "the second edit stays"}`, async () => {
      const w = peopleWorld();
      w.setCache([
        person({ id: P, label: "Ada" }),
        fieldRow({ id: F, parent_id: P, label: "Notes" }),
      ]);
      w.env.setDefaults(record());
      const g = holdEnqueue(w);
      const key = `field:${P}:${F}`;
      const { router } = await w.mount(`/people/${P}/fields/${F}`);
      let d = await dialog();
      fireEvent.change(within(d).getByRole("textbox", { name: "Name" }), {
        target: { value: "Notes, first" },
      });
      await waitFor(() =>
        expect(within(d).queryByRole("button", { name: "Save" })).toBeEnabled(),
      );
      save(d);
      await waitFor(() => expect(g.state.entered).toBe(1));
      if (completedFirst) {
        await g.release();
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      } else await cancel(d);
      await act(async () => {
        await router.navigate({
          to: "/people/$personId/fields/$fieldId",
          params: { personId: P, fieldId: F },
        });
      });
      d = await dialog();
      fireEvent.change(within(d).getByRole("textbox", { name: "Name" }), {
        target: { value: "Notes, second" },
      });
      if (!completedFirst) await g.release();
      await waitFor(() => expect(w.built).toHaveLength(1));
      expect(router.state.location.pathname).toBe(`/people/${P}/fields/${F}`);
      expect(screen.queryByRole("dialog")).not.toBeNull();
      expect(kept(w, key)?.form.name).toBe("Notes, second");
    });

  for (const completedFirst of [false, true])
    test(`Archive from the editor after Cancel and Edit again: ${completedFirst ? "control" : "the second editor stays"}`, async () => {
      const w = peopleWorld();
      w.setCache([
        person({ id: P, label: "Ada" }),
        fieldRow({ id: F, parent_id: P, label: "Notes" }),
      ]);
      const g = holdEnqueue(w);
      const key = `field:${P}:${F}`;
      const { router } = await w.mount(`/people/${P}/fields/${F}`);
      let d = await dialog();
      fireEvent.click(within(d).getByRole("button", { name: "Archive" }));
      await waitFor(() => expect(g.state.entered).toBe(1));
      if (completedFirst) {
        await g.release();
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
        expect(router.state.location.pathname).toBe(`/people/${P}`);
        return;
      }
      await cancel(d);
      await act(async () => {
        await router.navigate({
          to: "/people/$personId/fields/$fieldId",
          params: { personId: P, fieldId: F },
        });
      });
      d = await dialog();
      fireEvent.change(within(d).getByRole("textbox", { name: "Name" }), {
        target: { value: "Notes, second" },
      });
      await g.release();
      await waitFor(() => expect(w.built).toHaveLength(1));
      expect(router.state.location.pathname).toBe(`/people/${P}/fields/${F}`);
      expect(screen.queryByRole("dialog")).not.toBeNull();
      expect(kept(w, key)?.form.name).toBe("Notes, second");
    });

  test("the SAME session remounted (a 403 elsewhere) while its save runs: the completion closes the restored editor and forgets its input", async () => {
    const w = seeded();
    const g = holdEnqueue(w);
    await w.mount(`/people/${P}/fields/new`);
    let d = await dialog();
    typeField(d, "First", "First text");
    save(d);
    await waitFor(() => expect(g.state.entered).toBe(1));
    const session = kept(w, NEW_KEY)?.session;
    cleanup();
    const { router } = await w.mount(`/people/${P}/fields/new`);
    d = await dialog();
    expect(within(d).getByRole("textbox", { name: "Name" })).toHaveValue(
      "First",
    );
    expect(kept(w, NEW_KEY)?.session).toBe(session);
    await g.release();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(router.state.location.pathname).toBe(`/people/${P}`);
    expect(kept(w, NEW_KEY)).toBeUndefined();
    expect(w.built).toHaveLength(1);
  });

  test("the same session remounted and typed in further: the completion keeps the later input and says so", async () => {
    const w = seeded();
    const g = holdEnqueue(w);
    await w.mount(`/people/${P}/fields/new`);
    let d = await dialog();
    typeField(d, "First", "First text");
    save(d);
    await waitFor(() => expect(g.state.entered).toBe(1));
    cleanup();
    const { router } = await w.mount(`/people/${P}/fields/new`);
    d = await dialog();
    fireEvent.change(within(d).getByRole("textbox", { name: "Name" }), {
      target: { value: "First, later" },
    });
    await g.release();
    await waitFor(() =>
      expect(within(d).queryByText(LATER_EDITS_KEPT)).not.toBeNull(),
    );
    expect(router.state.location.pathname).toBe(`/people/${P}/fields/new`);
    expect(kept(w, NEW_KEY)?.form.name).toBe("First, later");
  });

  test("gone elsewhere (the session kept, no editor open): the completion forgets the saved input and does not navigate", async () => {
    const w = seeded();
    const g = holdEnqueue(w);
    const { router } = await w.mount(`/people/${P}/fields/new`);
    let d = await dialog();
    typeField(d, "First", "First text");
    save(d);
    await waitFor(() => expect(g.state.entered).toBe(1));
    await act(async () => {
      await router.navigate({ to: "/people" });
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(kept(w, NEW_KEY)?.form.name).toBe("First");
    await g.release();
    await waitFor(() => expect(w.built).toHaveLength(1));
    expect(router.state.location.pathname).toBe("/people");
    expect(kept(w, NEW_KEY)).toBeUndefined();
    // Coming back opens a new session (the saved input is not offered again to be saved twice).
    await act(async () => {
      await router.navigate({
        to: "/people/$personId/fields/new",
        params: { personId: P },
      });
    });
    d = await dialog();
    expect(within(d).getByRole("textbox", { name: "Name" })).toHaveValue("");
  });

  test("another identity is displayed when the save completes: nothing of it is touched", async () => {
    const w = seeded();
    const g = holdEnqueue(w);
    await w.mount(`/people/${P}/fields/new`);
    const d = await dialog();
    typeField(d, "First", "First text");
    save(d);
    await waitFor(() => expect(g.state.entered).toBe(1));
    cleanup();
    const other = peopleWorld({ identity: "other-account:1" });
    other.setCache([person({ id: P, label: "Bea" })]);
    other.env.setDefaults(record());
    const { router } = await other.mount(`/people/${P}/fields/new`);
    const d2 = await dialog();
    typeField(d2, "Theirs", "Their unsaved text");
    await g.release();
    expect(router.state.location.pathname).toBe(`/people/${P}/fields/new`);
    expect(screen.queryByRole("dialog")).not.toBeNull();
    expect(
      (
        peopleMemory("other-account:1").drafts.get(NEW_KEY) as
          | { form: { name: string } }
          | undefined
      )?.form.name,
    ).toBe("Theirs");
  });
});

describe("review 6, finding 1: New person", () => {
  const open = async () => {
    const [button] = screen.getAllByRole("button", { name: "New person" });
    if (button === undefined) throw new Error("no New person button");
    fireEvent.click(button);
    return screen.findByRole("dialog", { name: "New person" });
  };
  const named = (d: HTMLElement, name: string) =>
    fireEvent.change(within(d).getByRole("textbox", { name: "Name" }), {
      target: { value: name },
    });

  for (const completedFirst of [false, true])
    test(`after Cancel and a new form (adapted from the reviewer's probe: the first save's completion is observed through the queue, not a navigation): ${completedFirst ? "control" : "the new form and its input stay"}`, async () => {
      const w = peopleWorld();
      w.setCache([]);
      w.env.setDefaults(record());
      const g = holdEnqueue(w);
      const { router } = await w.mount("/people");
      let d = await open();
      named(d, "First");
      save(d);
      await waitFor(() => expect(g.state.entered).toBe(1));
      if (completedFirst) {
        await g.release();
        await waitFor(() =>
          expect(router.state.location.pathname).toMatch(/^\/people\/.+/),
        );
        await act(async () => {
          await router.navigate({ to: "/people" });
        });
      } else await cancel(d);
      d = await open();
      named(d, "Second unsaved person");
      if (!completedFirst) await g.release();
      await waitFor(() => expect(w.built).toHaveLength(1));
      expect(router.state.location.pathname).toBe("/people");
      expect(
        screen.queryByRole("dialog", { name: "New person" }),
      ).not.toBeNull();
      expect(
        within(screen.getByRole("dialog")).getByRole("textbox", {
          name: "Name",
        }),
      ).toHaveValue("Second unsaved person");
    });

  test("kept by the in-dialog sync control and not reopened: the completion forgets the saved input and does not navigate", async () => {
    const w = peopleWorld();
    w.setCache([]);
    w.env.setDefaults(record());
    const g = holdEnqueue(w);
    const { router } = await w.mount("/people");
    let d = await open();
    named(d, "First");
    save(d);
    await waitFor(() => expect(g.state.entered).toBe(1));
    fireEvent.click(within(d).getByRole("button", { name: /sync/i }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(w.people.memory.drafts.get("new-person")).toBeDefined();
    await g.release();
    await waitFor(() => expect(w.built).toHaveLength(1));
    expect(router.state.location.pathname).toBe("/people");
    expect(w.people.memory.drafts.get("new-person")).toBeUndefined();
    d = await open();
    expect(within(d).getByRole("textbox", { name: "Name" })).toHaveValue("");
  });

  test("kept by the sync control and reopened (the same session): the completion closes it onto the saved person", async () => {
    const w = peopleWorld();
    w.setCache([]);
    w.env.setDefaults(record());
    const g = holdEnqueue(w);
    const { router } = await w.mount("/people");
    let d = await open();
    named(d, "First");
    save(d);
    await waitFor(() => expect(g.state.entered).toBe(1));
    fireEvent.click(within(d).getByRole("button", { name: /sync/i }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    d = await open();
    expect(within(d).getByRole("textbox", { name: "Name" })).toHaveValue(
      "First",
    );
    await g.release();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(router.state.location.pathname).toMatch(/^\/people\/.+/);
    expect(w.people.memory.drafts.get("new-person")).toBeUndefined();
  });
});

describe("review 6, finding 1: rename and unlink", () => {
  const header = () =>
    document.querySelector("[data-identity-header]") as HTMLElement;
  const Q = "77777777-7777-4777-8777-777777777777";

  for (const typedLater of [false, true])
    test(`a queued rename completing after the person was left and the rename reopened: ${typedLater ? "the later name stays, said so" : "control, nothing typed since: the form closes"}`, async () => {
      const w = peopleWorld();
      w.setCache([
        person({ id: P, label: "Ada", version: 5, policy_version: 3 }),
        person({ id: Q, label: "Bea" }),
      ]);
      const g = holdEnqueue(w);
      const { router } = await w.mount(`/people/${P}`);
      expect(
        await within(header()).findByText("Not linked to an account"),
      ).toBeInTheDocument();
      fireEvent.click(within(header()).getByRole("button", { name: "Rename" }));
      fireEvent.change(
        within(header()).getByRole("textbox", { name: "Name" }),
        { target: { value: "Ada L." } },
      );
      fireEvent.click(within(header()).getByRole("button", { name: "Save" }));
      await waitFor(() => expect(g.state.entered).toBe(1));
      await act(async () => {
        await router.navigate({
          to: "/people/$personId",
          params: { personId: Q },
        });
      });
      await act(async () => {
        await router.navigate({
          to: "/people/$personId",
          params: { personId: P },
        });
      });
      fireEvent.click(
        await within(header()).findByRole("button", { name: "Rename" }),
      );
      const name = within(header()).getByRole("textbox", { name: "Name" });
      expect(name).toHaveValue("Ada L.");
      if (typedLater) fireEvent.change(name, { target: { value: "Ada Lo" } });
      await g.release();
      await waitFor(() => expect(w.built).toHaveLength(1));
      if (typedLater) {
        await waitFor(() =>
          expect(within(header()).queryByText(LATER_EDITS_KEPT)).not.toBeNull(),
        );
        expect(
          within(header()).getByRole("textbox", { name: "Name" }),
        ).toHaveValue("Ada Lo");
        expect(
          (
            w.people.memory.drafts.get(`rename:${P}`) as
              | { name: string }
              | undefined
          )?.name,
        ).toBe("Ada Lo");
      } else {
        await waitFor(() =>
          expect(
            within(header()).queryByRole("textbox", { name: "Name" }),
          ).toBeNull(),
        );
        expect(w.people.memory.drafts.get(`rename:${P}`)).toBeUndefined();
      }
    });

  for (const completedFirst of [false, true])
    test(`unlink confirmed, cancelled and asked again: ${completedFirst ? "control, the answer came first" : "the old answer does not close the new confirmation"}`, async () => {
      const w = peopleWorld();
      w.setCache([person({ id: P, label: "Kieran", version: 7 })]);
      w.api.linked.set(P, ME);
      const g = gate();
      w.api.next.people.push(async () => {
        await g.wait();
        return { ok: true, value: { revision: 9, person_id: P } };
      });
      await w.mount(`/people/${P}`);
      const ask = async () => {
        fireEvent.click(
          await within(header()).findByRole("button", {
            name: "Unlink account",
          }),
        );
        return screen.findByRole("dialog", {
          name: "Unlink your account from this profile?",
        });
      };
      let d = await ask();
      fireEvent.click(
        within(d).getByRole("button", { name: "Unlink account" }),
      );
      await waitFor(() => expect(g.state.entered).toBe(1));
      if (completedFirst) {
        await g.release();
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
        return;
      }
      await cancel(d);
      d = await ask();
      await g.release();
      await waitFor(() =>
        expect(
          w.api.calls.filter((call) => call.op === "readPerson").length,
        ).toBeGreaterThan(1),
      );
      expect(
        screen.queryByRole("dialog", {
          name: "Unlink your account from this profile?",
        }),
      ).not.toBeNull();
    });
});
