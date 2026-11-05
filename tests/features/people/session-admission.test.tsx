import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { EnqueueRequest } from "../../../src/data";
import { REFUSED, SAVING } from "../../../src/features/people/copy";
import { forgetAllPeopleMemory } from "../../../src/features/people/memory";
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
 * Review 7, finding 1 (`people-retained-form-pending-admission`): an editing SESSION saves once at a time (`lifetime.ts` `admit`). The
 * claim lives in the identity's page memory with the session, so a form kept by the sync control and reopened, or remounted (a 403
 * elsewhere, going away and back), shows the save still running and admits no second one; a refusal is told to the form showing the
 * session now; an exact retry of the same input is the same request (its local id); a new session after Cancel is not held back. Each
 * schedule holds the first save after it was observed to start, and has its control. Fixture evidence (jsdom).
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

/** Holds the outbox's `enqueue` until released, recording every request it was asked to write (refused or not). */
function holdEnqueue(w: PeopleWorld, options: { throws?: boolean } = {}) {
  const g = gate();
  const asked: EnqueueRequest[] = [];
  const outbox = w.env.outbox();
  if (outbox === null) throw new Error("no outbox");
  const original = outbox.enqueue.bind(outbox);
  let throwing = options.throws ?? false;
  outbox.enqueue = async (...args: Parameters<typeof original>) => {
    asked.push(args[0]);
    await g.wait();
    if (throwing) {
      throwing = false;
      throw new Error("the write's answer was lost");
    }
    return original(...args);
  };
  return { ...g, asked };
}

const newPerson = async () => {
  fireEvent.click(
    screen.getAllByRole("button", { name: "New person" })[0] as HTMLElement,
  );
  return screen.findByRole("dialog", { name: "New person" });
};
const saveButton = (d: HTMLElement) =>
  within(d).getByRole("button", { name: "Save" });
const keepWithSync = async (d: HTMLElement) => {
  fireEvent.click(within(d).getByRole("button", { name: /sync/i }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
};
const typeField = (d: HTMLElement, name: string, value: string) => {
  fireEvent.change(within(d).getByRole("textbox", { name: "Name" }), {
    target: { value: name },
  });
  fireEvent.change(within(d).getByRole("textbox", { name: "Value" }), {
    target: { value },
  });
};
const header = () =>
  document.querySelector("[data-identity-header]") as HTMLElement;

function seeded() {
  const w = peopleWorld();
  w.setCache([person({ id: P, label: "Ada" })]);
  w.env.setDefaults(record());
  return w;
}

describe("review 7, finding 1: New person admits one save per session", () => {
  for (const note of [false, true])
    for (const schedule of ["reopened", "mounted", "completed first"] as const)
      test(`${note ? "with a first note: " : ""}${schedule === "reopened" ? "kept by the sync control and reopened while its save runs: it shows saving and admits nothing more" : schedule === "mounted" ? "control, the same form pressed again while saving" : "control, the save completed before reopening: a new form is a new session"}`, async () => {
        const w = peopleWorld();
        w.setCache([]);
        w.env.setDefaults(record());
        const g = holdEnqueue(w);
        await w.mount("/people");
        let d = await newPerson();
        fireEvent.change(within(d).getByRole("textbox", { name: "Name" }), {
          target: { value: "One person" },
        });
        if (note) {
          fireEvent.click(
            within(d).getByRole("button", { name: "Add a first note" }),
          );
          fireEvent.change(within(d).getByRole("textbox", { name: /note/i }), {
            target: { value: "First note" },
          });
        }
        fireEvent.click(saveButton(d));
        await waitFor(() => expect(g.state.entered).toBe(1));
        if (schedule === "completed first") {
          await g.release();
          await waitFor(() => expect(w.built).toHaveLength(1));
          await waitFor(() =>
            expect(
              screen.queryByRole("dialog", { name: "New person" }),
            ).toBeNull(),
          );
          d = await newPerson();
          // A new session: nothing kept, nothing pending; a deliberate second person is admitted.
          expect(within(d).getByRole("textbox", { name: "Name" })).toHaveValue(
            "",
          );
          fireEvent.change(within(d).getByRole("textbox", { name: "Name" }), {
            target: { value: "Another person" },
          });
          fireEvent.click(saveButton(d));
          await waitFor(() => expect(w.built).toHaveLength(2));
          return;
        }
        if (schedule === "reopened") {
          await keepWithSync(d);
          d = await newPerson();
          expect(within(d).getByRole("textbox", { name: "Name" })).toHaveValue(
            "One person",
          );
        }
        // Saving, whichever mount shows the session: Save is disabled with its reason, and a press (or a submit) admits nothing.
        expect(saveButton(d)).toBeDisabled();
        expect(within(d).getByText(SAVING)).toBeInTheDocument();
        fireEvent.click(saveButton(d));
        fireEvent.submit(
          within(d)
            .getByRole("textbox", { name: "Name" })
            .closest("form") as HTMLFormElement,
        );
        await g.release();
        await waitFor(() => expect(w.built).toHaveLength(1));
        expect(g.asked).toHaveLength(1);
        const commands = (w.built[0]?.command.commands ?? []) as unknown[];
        expect(commands).toHaveLength(note ? 2 : 1);
        // The completion closed the form showing the session onto the saved person.
        await waitFor(() =>
          expect(
            screen.queryByRole("dialog", { name: "New person" }),
          ).toBeNull(),
        );
      });

  for (const answer of ["refused", "threw"] as const)
    test(`a save ${answer === "refused" ? "refused (quota)" : "that threw (its answer lost)"} while the form is kept and reopened: told to the reopened form, input kept, and the retry of the same input is the same request`, async () => {
      const w = peopleWorld();
      w.setCache([]);
      w.env.setDefaults(record());
      if (answer === "refused")
        w.outcomes.push({ kind: "refused", reason: "quota" });
      const g = holdEnqueue(w, { throws: answer === "threw" });
      await w.mount("/people");
      let d = await newPerson();
      fireEvent.change(within(d).getByRole("textbox", { name: "Name" }), {
        target: { value: "One person" },
      });
      fireEvent.click(saveButton(d));
      await waitFor(() => expect(g.state.entered).toBe(1));
      await keepWithSync(d);
      d = await newPerson();
      expect(saveButton(d)).toBeDisabled();
      await g.release();
      // The reopened form says so (never "saved"), keeps the name and admits the person's retry.
      await waitFor(() =>
        expect(
          within(d).queryByText(
            answer === "refused" ? REFUSED.quota : REFUSED.storage,
          ),
          "the refusal is told to the reopened form",
        ).not.toBeNull(),
      );
      expect(within(d).getByRole("textbox", { name: "Name" })).toHaveValue(
        "One person",
      );
      expect(w.built).toHaveLength(0);
      expect(saveButton(d)).toBeEnabled();
      fireEvent.click(saveButton(d));
      await waitFor(() => expect(w.built).toHaveLength(1));
      expect(g.asked).toHaveLength(2);
      // The same input is the same request: its local id and its person's id (a write whose answer was lost is recognised).
      expect(g.asked[1]?.localId).toBeDefined();
      expect(g.asked[1]?.localId).toBe(g.asked[0]?.localId);
      expect(w.built[0]?.localId).toBe(g.asked[0]?.localId);
    });

  test("control: a retry after the input changed is a NEW request (another local id), never the earlier one's", async () => {
    const w = peopleWorld();
    w.setCache([]);
    w.env.setDefaults(record());
    w.outcomes.push({ kind: "refused", reason: "quota" });
    const g = holdEnqueue(w);
    await g.release();
    await w.mount("/people");
    const d = await newPerson();
    const name = within(d).getByRole("textbox", { name: "Name" });
    fireEvent.change(name, { target: { value: "One person" } });
    fireEvent.click(saveButton(d));
    await waitFor(() =>
      expect(within(d).getByText(REFUSED.quota)).toBeInTheDocument(),
    );
    fireEvent.change(name, { target: { value: "One person, renamed" } });
    fireEvent.click(saveButton(d));
    await waitFor(() => expect(w.built).toHaveLength(1));
    expect(g.asked).toHaveLength(2);
    expect(g.asked[1]?.localId).not.toBe(g.asked[0]?.localId);
  });

  test("Cancel and a new form while the first save runs: the new session is not held back, and the old refusal is not told to it", async () => {
    const w = peopleWorld();
    w.setCache([]);
    w.env.setDefaults(record());
    w.outcomes.push({ kind: "refused", reason: "quota" });
    const g = holdEnqueue(w);
    await w.mount("/people");
    let d = await newPerson();
    fireEvent.change(within(d).getByRole("textbox", { name: "Name" }), {
      target: { value: "One person" },
    });
    fireEvent.click(saveButton(d));
    await waitFor(() => expect(g.state.entered).toBe(1));
    fireEvent.click(within(d).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    d = await newPerson();
    expect(within(d).getByRole("textbox", { name: "Name" })).toHaveValue("");
    fireEvent.change(within(d).getByRole("textbox", { name: "Name" }), {
      target: { value: "Second person" },
    });
    expect(saveButton(d)).toBeEnabled();
    await g.release();
    expect(within(d).queryByText(REFUSED.quota)).toBeNull();
    expect(within(d).getByRole("textbox", { name: "Name" })).toHaveValue(
      "Second person",
    );
    expect(saveButton(d)).toBeEnabled();
  });
});

/**
 * Review 19, finding 1 (`people-retained-form-pending-admission`): the same schedules as above, with the form REMOUNTED (the same identity's
 * tree mounted again over its page memory, as after a 403) instead of kept by the sync control. Before the correction the remounted form
 * began a new session, so Save was enabled beside the running save.
 */
describe("review 19, finding 1: New person remounted while its save runs", () => {
  const remount = async (w: PeopleWorld) => {
    cleanup();
    return w.mount("/people");
  };

  for (const note of [false, true])
    test(`${note ? "with a first note: " : ""}remounted and reopened while its save runs: it shows saving, admits nothing more, and the completion closes it onto the saved person`, async () => {
      const w = peopleWorld();
      w.setCache([]);
      w.env.setDefaults(record());
      const g = holdEnqueue(w);
      await w.mount("/people");
      let d = await newPerson();
      fireEvent.change(within(d).getByRole("textbox", { name: "Name" }), {
        target: { value: "One person" },
      });
      if (note) {
        fireEvent.click(
          within(d).getByRole("button", { name: "Add a first note" }),
        );
        fireEvent.change(within(d).getByRole("textbox", { name: /note/i }), {
          target: { value: "First note" },
        });
      }
      fireEvent.click(saveButton(d));
      await waitFor(() => expect(g.state.entered).toBe(1));
      const { router } = await remount(w);
      d = await newPerson();
      expect(within(d).getByRole("textbox", { name: "Name" })).toHaveValue(
        "One person",
      );
      expect(saveButton(d)).toBeDisabled();
      expect(within(d).getByText(SAVING)).toBeInTheDocument();
      fireEvent.click(saveButton(d));
      fireEvent.submit(
        within(d)
          .getByRole("textbox", { name: "Name" })
          .closest("form") as HTMLFormElement,
      );
      await g.release();
      await waitFor(() => expect(w.built).toHaveLength(1));
      expect(g.asked).toHaveLength(1);
      const commands = (w.built[0]?.command.commands ?? []) as unknown[];
      expect(commands).toHaveLength(note ? 2 : 1);
      await waitFor(() =>
        expect(screen.queryByRole("dialog", { name: "New person" })).toBeNull(),
      );
      expect(router.state.location.pathname).toMatch(/^\/people\/.+/);
      expect(w.people.memory.drafts.get("new-person")).toBeUndefined();
    });

  for (const answer of ["refused", "threw"] as const)
    test(`a save ${answer === "refused" ? "refused (quota)" : "that threw (its answer lost)"} while the form is remounted and reopened: told to the reopened form, input kept, and the retry of the same input is the same request`, async () => {
      const w = peopleWorld();
      w.setCache([]);
      w.env.setDefaults(record());
      if (answer === "refused")
        w.outcomes.push({ kind: "refused", reason: "quota" });
      const g = holdEnqueue(w, { throws: answer === "threw" });
      await w.mount("/people");
      let d = await newPerson();
      fireEvent.change(within(d).getByRole("textbox", { name: "Name" }), {
        target: { value: "One person" },
      });
      fireEvent.click(saveButton(d));
      await waitFor(() => expect(g.state.entered).toBe(1));
      await remount(w);
      d = await newPerson();
      expect(saveButton(d)).toBeDisabled();
      await g.release();
      await waitFor(() =>
        expect(
          within(d).queryByText(
            answer === "refused" ? REFUSED.quota : REFUSED.storage,
          ),
          "the refusal is told to the reopened form",
        ).not.toBeNull(),
      );
      expect(within(d).getByRole("textbox", { name: "Name" })).toHaveValue(
        "One person",
      );
      expect(w.built).toHaveLength(0);
      expect(saveButton(d)).toBeEnabled();
      fireEvent.click(saveButton(d));
      await waitFor(() => expect(w.built).toHaveLength(1));
      expect(g.asked).toHaveLength(2);
      expect(g.asked[1]?.localId).toBeDefined();
      expect(g.asked[1]?.localId).toBe(g.asked[0]?.localId);
      expect(w.built[0]?.localId).toBe(g.asked[0]?.localId);
    });

  test("remounted, reopened and cancelled while its save runs: the next form is a new session, not held back", async () => {
    const w = peopleWorld();
    w.setCache([]);
    w.env.setDefaults(record());
    const g = holdEnqueue(w);
    await w.mount("/people");
    let d = await newPerson();
    fireEvent.change(within(d).getByRole("textbox", { name: "Name" }), {
      target: { value: "One person" },
    });
    fireEvent.click(saveButton(d));
    await waitFor(() => expect(g.state.entered).toBe(1));
    await remount(w);
    d = await newPerson();
    expect(saveButton(d)).toBeDisabled();
    fireEvent.click(within(d).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    d = await newPerson();
    expect(within(d).getByRole("textbox", { name: "Name" })).toHaveValue("");
    fireEvent.change(within(d).getByRole("textbox", { name: "Name" }), {
      target: { value: "Second person" },
    });
    expect(saveButton(d)).toBeEnabled();
    await g.release();
    await waitFor(() => expect(w.built).toHaveLength(1));
    expect(within(d).getByRole("textbox", { name: "Name" })).toHaveValue(
      "Second person",
    );
  });
});

describe("review 7, finding 1: the field editor admits one save per session", () => {
  for (const remounted of [true, false])
    test(`a queued create ${remounted ? "remounted (a 403 elsewhere) while its save runs: the restored editor shows it saving and admits nothing" : "control: pressed again in the same editor"}`, async () => {
      const w = seeded();
      const g = holdEnqueue(w);
      await w.mount(`/people/${P}/fields/new`);
      let d = await screen.findByRole("dialog");
      typeField(d, "First", "First text");
      fireEvent.click(saveButton(d));
      await waitFor(() => expect(g.state.entered).toBe(1));
      if (remounted) {
        cleanup();
        await w.mount(`/people/${P}/fields/new`);
        d = await screen.findByRole("dialog");
        expect(within(d).getByRole("textbox", { name: "Name" })).toHaveValue(
          "First",
        );
      }
      expect(saveButton(d)).toBeDisabled();
      fireEvent.click(saveButton(d));
      await g.release();
      await waitFor(() => expect(w.built).toHaveLength(1));
      expect(g.asked).toHaveLength(1);
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    });

  test("a shared create (Home · can view) remounted while its request is unanswered: no second request, no second key", async () => {
    const w = seeded();
    const g = gate();
    w.api.next.shared.push(async () => {
      await g.wait();
      return { ok: true, value: { revision: 10 } };
    });
    await w.mount(`/people/${P}/fields/new`);
    let d = await screen.findByRole("dialog");
    typeField(d, "Shared", "Shared text");
    fireEvent.click(within(d).getByRole("radio", { name: "Home · can view" }));
    fireEvent.click(saveButton(d));
    await waitFor(() => expect(g.state.entered).toBe(1));
    cleanup();
    await w.mount(`/people/${P}/fields/new`);
    d = await screen.findByRole("dialog");
    expect(saveButton(d)).toBeDisabled();
    fireEvent.click(saveButton(d));
    await g.release();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(
      w.api.calls.filter((call) => call.op === "putFieldShared"),
    ).toHaveLength(1);
  });

  test("an update remounted while it is saved: the restored editor shows it saving; its Archive is not admitted beside it", async () => {
    const w = seeded();
    w.setCache([
      person({ id: P, label: "Ada" }),
      fieldRow({ id: F, parent_id: P, label: "Notes" }),
    ]);
    const g = holdEnqueue(w);
    await w.mount(`/people/${P}/fields/${F}`);
    let d = await screen.findByRole("dialog");
    fireEvent.change(within(d).getByRole("textbox", { name: "Name" }), {
      target: { value: "Notes, first" },
    });
    await waitFor(() => expect(saveButton(d)).toBeEnabled());
    fireEvent.click(saveButton(d));
    await waitFor(() => expect(g.state.entered).toBe(1));
    cleanup();
    await w.mount(`/people/${P}/fields/${F}`);
    d = await screen.findByRole("dialog");
    expect(saveButton(d)).toBeDisabled();
    expect(within(d).getByRole("button", { name: "Archive" })).toBeDisabled();
    fireEvent.click(within(d).getByRole("button", { name: "Archive" }));
    await g.release();
    await waitFor(() => expect(w.built).toHaveLength(1));
    expect(g.asked).toHaveLength(1);
    expect(w.built[0]?.command).not.toMatchObject({ kind: "archive" });
  });

  test("control: the editor's Archive pressed twice while it is saved admits one archive, and Save waits for it", async () => {
    const w = seeded();
    w.setCache([
      person({ id: P, label: "Ada" }),
      fieldRow({ id: F, parent_id: P, label: "Notes" }),
    ]);
    const g = holdEnqueue(w);
    await w.mount(`/people/${P}/fields/${F}`);
    const d = await screen.findByRole("dialog");
    await waitFor(() =>
      expect(within(d).getByRole("button", { name: "Archive" })).toBeEnabled(),
    );
    fireEvent.click(within(d).getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(g.state.entered).toBe(1));
    expect(within(d).getByRole("button", { name: "Archive" })).toBeDisabled();
    expect(saveButton(d)).toBeDisabled();
    fireEvent.click(within(d).getByRole("button", { name: "Archive" }));
    await g.release();
    await waitFor(() => expect(w.built).toHaveLength(1));
    expect(g.asked).toHaveLength(1);
  });
});

describe("review 7, finding 1: rename, unlink and archive admit one at a time", () => {
  test("a queued rename remounted while saved: the restored form shows it saving and admits nothing more", async () => {
    const w = peopleWorld();
    w.setCache([
      person({ id: P, label: "Ada", version: 5, policy_version: 3 }),
    ]);
    const g = holdEnqueue(w);
    await w.mount(`/people/${P}`);
    expect(
      await within(header()).findByText("Not linked to an account"),
    ).toBeInTheDocument();
    fireEvent.click(within(header()).getByRole("button", { name: "Rename" }));
    fireEvent.change(within(header()).getByRole("textbox", { name: "Name" }), {
      target: { value: "Ada L." },
    });
    fireEvent.click(within(header()).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(g.state.entered).toBe(1));
    cleanup();
    await w.mount(`/people/${P}`);
    fireEvent.click(
      await within(header()).findByRole("button", { name: "Rename" }),
    );
    const save = within(header()).getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    fireEvent.click(save);
    await g.release();
    await waitFor(() => expect(w.built).toHaveLength(1));
    expect(g.asked).toHaveLength(1);
  });

  test("a linked profile's rename remounted while unanswered: one rename_profile request", async () => {
    const w = peopleWorld();
    w.setCache([person({ id: P, label: "Kieran", version: 7 })]);
    w.api.linked.set(P, ME);
    const g = gate();
    w.api.next.people.push(async () => {
      await g.wait();
      return { ok: true, value: { revision: 9, person_id: P } };
    });
    await w.mount(`/people/${P}`);
    fireEvent.click(
      await within(header()).findByRole("button", { name: "Rename" }),
    );
    fireEvent.change(within(header()).getByRole("textbox", { name: "Name" }), {
      target: { value: "Kieran L." },
    });
    fireEvent.click(within(header()).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(g.state.entered).toBe(1));
    cleanup();
    await w.mount(`/people/${P}`);
    fireEvent.click(
      await within(header()).findByRole("button", { name: "Rename" }),
    );
    expect(
      within(header()).getByRole("button", { name: "Save" }),
    ).toBeDisabled();
    fireEvent.click(within(header()).getByRole("button", { name: "Save" }));
    await g.release();
    expect(
      w.api.calls.filter((call) => call.op === "peopleCommand"),
    ).toHaveLength(1);
  });

  test("unlink asked again while the first is unanswered: the new confirmation shows it sending and sends nothing more", async () => {
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
        await within(header()).findByRole("button", { name: "Unlink account" }),
      );
      return screen.findByRole("dialog", {
        name: "Unlink your account from this profile?",
      });
    };
    let d = await ask();
    fireEvent.click(within(d).getByRole("button", { name: "Unlink account" }));
    await waitFor(() => expect(g.state.entered).toBe(1));
    fireEvent.click(within(d).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    d = await ask();
    const confirm = within(d).getByRole("button", { name: "Unlink account" });
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    await g.release();
    expect(
      w.api.calls.filter((call) => call.op === "peopleCommand"),
    ).toHaveLength(1);
  });

  for (const target of ["person", "field"] as const)
    test(`the ${target}'s Archive pressed twice while the first is saved: one archive`, async () => {
      const w = seeded();
      w.setCache([
        person({ id: P, label: "Ada" }),
        fieldRow({ id: F, parent_id: P, label: "Note" }),
      ]);
      const g = holdEnqueue(w);
      await w.mount(`/people/${P}`);
      const button = async () =>
        target === "person"
          ? within(header()).findByRole("button", { name: "Archive" })
          : within(
              (await waitFor(() => {
                const row = document.querySelector(`[data-field-row="${F}"]`);
                expect(row).not.toBeNull();
                return row;
              })) as HTMLElement,
            ).findByRole("button", { name: "Archive" });
      fireEvent.click(await button());
      await waitFor(() => expect(g.state.entered).toBe(1));
      expect(await button()).toBeDisabled();
      fireEvent.click(await button());
      await g.release();
      await waitFor(() => expect(w.built).toHaveLength(1));
      expect(g.asked).toHaveLength(1);
    });
});
