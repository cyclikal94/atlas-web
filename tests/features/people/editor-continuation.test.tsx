import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { DraftWithCommand, EnqueueRequest } from "../../../src/data";
import { digestOf } from "../../../src/data/model/canonical";
import { forgetAllPeopleMemory } from "../../../src/features/people/memory";
import {
  editCreateRequest,
  putFieldUpdateRequest,
  renameEditRequest,
} from "../../../src/features/people/model/commands";
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
import { ok } from "../../support/sharing/fake-api";

/**
 * Review 11's design assessment: the REACHABLE continuations (DA11-06) and stale writes judged at the write (DA11-03), over the People
 * world whose outbox now writes as the real one does (R11.1). Every save here is the person's: typed into an enabled input and saved
 * with the button; while it is written the input is asserted DISABLED (nothing is dispatched into it). The competing change of DA11-03
 * is committed through the outbox's own write, so its digest is the one the real writer stores, never a name a test chose. Each schedule
 * has its control. Component evidence: one page, the store double; not independent pages, real IndexedDB or a crash.
 */
const P = "55555555-5555-4555-8555-555555555555";
const F = "66666666-6666-4666-8666-666666666666";
const PRIVATE = { grants: [], exclude_accounts: [] };

installMatchMedia({ width: 1440 });
beforeEach(() => {
  forgetAllPeopleMemory();
  forgetRefusedPolicies();
});
afterEach(() => cleanup());

async function dialogNamed(name: string | RegExp): Promise<HTMLElement> {
  return waitFor(() => {
    const found = screen.queryByRole("dialog", { name });
    expect(found, `the dialog ${String(name)} is shown`).not.toBeNull();
    return found as HTMLElement;
  });
}
const closed = () =>
  waitFor(() => expect(screen.queryAllByRole("dialog")).toHaveLength(0));
const box = (d: HTMLElement, name: string) =>
  within(d).getByRole("textbox", { name }) as HTMLInputElement;

/** Holds the outbox's `method` until released; `original` writes without the hold (another writer of the same outbox). */
function gate<M extends "enqueue" | "editQueued">(w: PeopleWorld, method: M) {
  const outbox = w.env.outbox();
  if (outbox === null) throw new Error("no outbox");
  const original = outbox[method].bind(outbox) as (typeof outbox)[M];
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  const state = { entered: 0 };
  (outbox as unknown as Record<string, unknown>)[method] = async (
    ...args: unknown[]
  ) => {
    state.entered += 1;
    await opened;
    return (original as (...a: unknown[]) => Promise<unknown>)(...args);
  };
  return {
    state,
    original,
    release: async () => {
      await act(async () => {
        open();
        await opened;
      });
    },
    restore: () => {
      (outbox as unknown as Record<string, unknown>)[method] = original;
    },
  };
}

/** The stored pair of the one draft there must be: the body and the digest of that body. */
function onlyDraft(w: PeopleWorld): DraftWithCommand {
  expect(w.drafts).toHaveLength(1);
  const d = w.drafts[0] as DraftWithCommand;
  expect(d.command_digest).toBe(digestOf(d.command));
  return d;
}

const createBody = (id: string, text: string) => ({
  command: {
    kind: "put_field",
    id,
    parent_id: P,
    label: "Queued",
    value: { kind: "text", text },
    initial_policy: PRIVATE,
  },
});

async function addQueuedField(w: PeopleWorld): Promise<string> {
  await w.mount(`/people/${P}/fields/new`);
  const d = await dialogNamed("Add a field");
  fireEvent.change(box(d, "Name"), { target: { value: "Queued" } });
  fireEvent.change(box(d, "Value"), { target: { value: "A" } });
  fireEvent.click(within(d).getByRole("radio", { name: "Only you" }));
  fireEvent.click(within(d).getByRole("button", { name: "Save" }));
  await closed();
  cleanup();
  const id = w.built[0]?.request.targets[0]?.resourceId;
  if (id === undefined) throw new Error("no create queued");
  return id;
}

/** Opens the field's editor, types `text` and saves while the write is held: the input is disabled until the write completes. */
async function saveHeld(
  w: PeopleWorld,
  id: string,
  name: string,
  text: string,
  method: "enqueue" | "editQueued",
) {
  await w.mount(`/people/${P}/fields/${id}`);
  const d = await dialogNamed(name);
  const value = await waitFor(() => {
    const v = box(d, "Value");
    expect(v).toBeEnabled();
    return v;
  });
  fireEvent.change(value, { target: { value: text } });
  const g = gate(w, method);
  fireEvent.click(within(d).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(g.state.entered).toBe(1));
  expect(box(d, "Value")).toBeDisabled();
  await g.release();
  g.restore();
  await closed();
  cleanup();
}

describe("DA11-06: save, reopen, save again: each write is the person's, on one draft whose body and digest agree", () => {
  test("a queued create: A, then B and C edited in place on the create's own base (the input disabled while each is written)", async () => {
    const w = peopleWorld();
    w.setCache([person({ id: P, label: "Ada" })]);
    w.env.setDefaults(record());
    const id = await addQueuedField(w);
    const created = onlyDraft(w);
    expect(created.command).toEqual(createBody(id, "A"));
    for (const text of ["B", "C"]) {
      await saveHeld(w, id, "Edit Queued", text, "editQueued");
      const stored = onlyDraft(w);
      expect(stored).toMatchObject({
        local_id: created.local_id,
        created_seq: created.created_seq,
        bases: created.bases,
        status: "queued",
      });
      expect(stored.command).toEqual(createBody(id, text));
      expect(w.built.at(-1)).toMatchObject({
        op: "edit",
        target: created.local_id,
      });
    }
    expect(w.built.map((b) => b.op)).toEqual(["enqueue", "edit", "edit"]);
    expect(w.versions.get(id)).toBe(1);
  });

  test("a queued update of a published field: B and C each edit it in place on its stored base 4, never on the raised record 5", async () => {
    const w = peopleWorld();
    w.setCache([
      person({ id: P, label: "Ada" }),
      fieldRow({
        id: F,
        parent_id: P,
        label: "Note",
        version: 4,
        policy_version: 6,
      }),
    ]);
    w.env.setDefaults(record());
    const body = (text: string) => ({
      command: {
        kind: "put_field",
        id: F,
        parent_id: P,
        expected_version: 4,
        expected_policy_version: 6,
        label: "Note",
        value: { kind: "text", text },
      },
    });
    w.setDrafts([
      draftRow({
        local_id: "L",
        created_seq: 1,
        endpoint: "/task-commands",
        kind: "put_field",
        target_resource_ids: [F],
        index_targets: [F],
        bases: { [F]: 4 },
        bumped: [F],
        expected_version: 4,
        command: body("A"),
      }),
    ]);
    w.versions.set(F, 5);
    for (const text of ["B", "C"]) {
      w.sharing.next.policy.push(ok({ version: 6, policy: PRIVATE }));
      await saveHeld(w, F, "Edit Note", text, "editQueued");
      const stored = onlyDraft(w);
      expect(stored).toMatchObject({ local_id: "L", bases: { [F]: 4 } });
      expect(stored.command).toEqual(body(text));
      expect(w.built.at(-1)).toMatchObject({ op: "edit", target: "L" });
    }
    expect(w.versions.get(F)).toBe(5);
  });

  test("an unlinked person's rename: A queued, then B and C renamed in place on base 3 (the name disabled while each is written)", async () => {
    const w = peopleWorld();
    w.setCache([
      person({ id: P, label: "Ada", version: 3, policy_version: 2 }),
    ]);
    const body = (name: string) => ({
      commands: [
        {
          kind: "edit",
          id: P,
          expected_version: 3,
          expected_policy_version: 2,
          label: name,
          value: "",
        },
      ],
    });
    let first: DraftWithCommand | undefined;
    for (const name of ["A", "B", "C"]) {
      await w.mount(`/people/${P}`);
      const rename = await screen.findByRole("button", { name: "Rename" });
      await waitFor(() => expect(rename).toBeEnabled());
      fireEvent.click(rename);
      const input = await screen.findByRole("textbox", { name: "Name" });
      fireEvent.change(input, { target: { value: name } });
      const g = gate(w, first === undefined ? "enqueue" : "editQueued");
      const form = document.querySelector("[data-rename-form]") as HTMLElement;
      fireEvent.click(within(form).getByRole("button", { name: "Save" }));
      await waitFor(() => expect(g.state.entered).toBe(1));
      expect(
        within(form).getByRole("textbox", { name: "Name" }),
      ).toBeDisabled();
      await g.release();
      g.restore();
      await waitFor(() =>
        expect(document.querySelector("[data-rename-form]")).toBeNull(),
      );
      cleanup();
      const stored = onlyDraft(w);
      first ??= stored;
      expect(stored).toMatchObject({
        local_id: first.local_id,
        bases: { [P]: 3 },
      });
      expect(stored.command).toEqual(body(name));
    }
    expect(w.built.map((b) => b.op)).toEqual(["enqueue", "edit", "edit"]);
    expect(w.versions.get(P)).toBe(4);
  });
});

describe("DA11-03: the editor's reviewed body is judged at the write, after a change the outbox itself committed", () => {
  function queuedUpdateWorld() {
    const w = peopleWorld();
    w.setCache([
      person({ id: P, label: "Ada" }),
      fieldRow({
        id: F,
        parent_id: P,
        label: "Note",
        version: 4,
        policy_version: 6,
      }),
    ]);
    w.env.setDefaults(record());
    w.setDrafts([
      draftRow({
        local_id: "L",
        created_seq: 1,
        endpoint: "/task-commands",
        kind: "put_field",
        target_resource_ids: [F],
        index_targets: [F],
        bases: { [F]: 4 },
        bumped: [F],
        expected_version: 4,
        command: {
          command: {
            kind: "put_field",
            id: F,
            parent_id: P,
            expected_version: 4,
            expected_policy_version: 6,
            label: "Note",
            value: { kind: "text", text: "A" },
          },
        },
      }),
    ]);
    w.versions.set(F, 5);
    w.sharing.next.policy.push(ok({ version: 6, policy: PRIVATE }));
    return w;
  }
  const peerEdit = (reviewed: string): EnqueueRequest => ({
    ...putFieldUpdateRequest({
      fieldId: F,
      personId: P,
      label: "Note",
      value: { kind: "text", text: "Peer B" },
      policyVersion: 6,
      sameKind: true,
    }),
    expectDraft: (d) => d.command_digest === reviewed,
  });

  for (const peer of [true, false])
    test(`field: the editor's in-place edit held at the write ${peer ? "while the outbox commits another edit of L: refused, no successor, the field reviewed" : "(control, nothing in between): L edited on base 4"}`, async () => {
      const w = queuedUpdateWorld();
      await w.mount(`/people/${P}/fields/${F}`);
      const d = await dialogNamed("Edit Note");
      const value = await waitFor(() => {
        const v = box(d, "Value");
        expect(v).toBeEnabled();
        return v;
      });
      fireEvent.change(value, { target: { value: "Editor C" } });
      const g = gate(w, "editQueued");
      fireEvent.click(within(d).getByRole("button", { name: "Save" }));
      await waitFor(() => expect(g.state.entered).toBe(1));
      const before = (w.drafts[0] as DraftWithCommand).command_digest;
      if (peer)
        await act(async () => {
          expect(await g.original("L", peerEdit(before))).toEqual({
            kind: "edited",
            localId: "L",
          });
        });
      // The positive witness: what L holds when the held write proceeds.
      const atWrite = onlyDraft(w);
      expect(atWrite.command_digest === before).toBe(!peer);
      await g.release();
      if (peer) {
        await waitFor(() =>
          expect(
            within(d).queryByText("This field changed since you opened it"),
          ).not.toBeNull(),
        );
        const stored = onlyDraft(w);
        expect(stored.local_id).toBe("L");
        expect(stored.command).toMatchObject({
          command: {
            expected_version: 4,
            value: { kind: "text", text: "Peer B" },
          },
        });
        expect(w.built.map((b) => [b.op, b.target])).toEqual([["edit", "L"]]);
        expect(box(d, "Value")).toHaveValue("Editor C");
      } else {
        await closed();
        const stored = onlyDraft(w);
        expect(stored.command).toMatchObject({
          command: {
            expected_version: 4,
            value: { kind: "text", text: "Editor C" },
          },
        });
      }
      expect(w.versions.get(F)).toBe(5);
    });

  for (const peer of [true, false])
    test(`queued create: the editor's in-place edit held at the write ${peer ? "while the outbox commits another edit of the create: refused, no second create, the input kept" : "(control): the create edited in place"}`, async () => {
      const w = peopleWorld();
      w.setCache([person({ id: P, label: "Ada" })]);
      w.env.setDefaults(record());
      const id = await addQueuedField(w);
      const created = onlyDraft(w);
      await w.mount(`/people/${P}/fields/${id}`);
      const d = await dialogNamed("Edit Queued");
      fireEvent.change(box(d, "Value"), { target: { value: "Editor C" } });
      const g = gate(w, "editQueued");
      fireEvent.click(within(d).getByRole("button", { name: "Save" }));
      await waitFor(() => expect(g.state.entered).toBe(1));
      if (peer)
        await act(async () => {
          const request = editCreateRequest(created, {
            label: "Queued",
            value: { kind: "text", text: "Peer B" },
          });
          if (request === null) throw new Error("no create edit");
          expect(
            await g.original(created.local_id, {
              ...request,
              expectDraft: (row) =>
                row.command_digest === created.command_digest,
            }),
          ).toEqual({ kind: "edited", localId: created.local_id });
        });
      await g.release();
      if (peer) {
        await waitFor(() => expect(w.built).toHaveLength(2));
        // Nothing more is written, and the editor stays open with the person's input.
        await act(async () => undefined);
        expect(w.built.map((b) => b.op)).toEqual(["enqueue", "edit"]);
        expect(onlyDraft(w).command).toEqual(createBody(id, "Peer B"));
        expect(box(await dialogNamed("Edit Queued"), "Value")).toHaveValue(
          "Editor C",
        );
      } else {
        await closed();
        expect(onlyDraft(w).command).toEqual(createBody(id, "Editor C"));
        expect(w.built.map((b) => b.op)).toEqual(["enqueue", "edit"]);
      }
    });

  for (const peer of [true, false])
    test(`rename: the form's in-place rename held at the write ${peer ? "while the outbox commits another rename: refused into review, no successor" : "(control): renamed in place"}`, async () => {
      const w = peopleWorld();
      w.setCache([
        person({ id: P, label: "Ada", version: 3, policy_version: 2 }),
      ]);
      const outbox = w.env.outbox();
      if (outbox === null) throw new Error("no outbox");
      await outbox.enqueue(
        renameEditRequest({ personId: P, name: "Queued", policyVersion: 2 }),
      );
      const queued = onlyDraft(w);
      await w.mount(`/people/${P}`);
      const rename = await screen.findByRole("button", { name: "Rename" });
      await waitFor(() => expect(rename).toBeEnabled());
      fireEvent.click(rename);
      fireEvent.change(await screen.findByRole("textbox", { name: "Name" }), {
        target: { value: "Form C" },
      });
      const g = gate(w, "editQueued");
      const form = document.querySelector("[data-rename-form]") as HTMLElement;
      fireEvent.click(within(form).getByRole("button", { name: "Save" }));
      await waitFor(() => expect(g.state.entered).toBe(1));
      if (peer)
        await act(async () => {
          expect(
            await g.original(queued.local_id, {
              ...renameEditRequest({
                personId: P,
                name: "Peer B",
                policyVersion: 2,
              }),
              expectDraft: (row) =>
                row.command_digest === queued.command_digest,
            }),
          ).toEqual({ kind: "edited", localId: queued.local_id });
        });
      await g.release();
      const label = () =>
        (
          onlyDraft(w).command as {
            commands: Array<{ label: string; expected_version: number }>;
          }
        ).commands[0];
      if (peer) {
        // Its absence is an assertion failure (never a query error): the form stays open with the review.
        await waitFor(() =>
          expect(
            within(form).queryByText(
              "This person changed since you started. Review the name, then save again.",
            ),
          ).not.toBeNull(),
        );
        expect(label()).toEqual(
          expect.objectContaining({ label: "Peer B", expected_version: 3 }),
        );
        expect(w.built.map((b) => b.op)).toEqual(["enqueue", "edit"]);
      } else {
        await waitFor(() =>
          expect(document.querySelector("[data-rename-form]")).toBeNull(),
        );
        expect(label()).toEqual(
          expect.objectContaining({ label: "Form C", expected_version: 3 }),
        );
      }
      expect(w.versions.get(P)).toBe(4);
    });
});
