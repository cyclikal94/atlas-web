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
import {
  forgetAllPeopleMemory,
  peopleMemory,
} from "../../../src/features/people/memory";
import {
  putFieldUpdateRequest,
  renameEditRequest,
} from "../../../src/features/people/model/commands";
import { forgetRefusedPolicies } from "../../../src/features/sharing/api";
import { installMatchMedia } from "../../helpers/match-media";
import { draftRow } from "../../support/data/rows";
import { HOME, record } from "../../support/people/records";
import {
  fieldRow,
  type PeopleWorld,
  peopleWorld,
  person,
} from "../../support/people/world";
import { ok } from "../../support/sharing/fake-api";

/**
 * WEB-11a review 12, R12.1 (family `people-edit-baseline-rebinding`) and its reverse schedule, at both callers (DA12-05): the field editor
 * and the unlinked rename. The person types into an ENABLED input and saves with the button. The competing write is made through the
 * outbox's public operations, so the digests are the ones the writer stores. The world's outbox decides with the production plans and the
 * same predicates (`predecessorStands`, the newest-save rule); a first claim and its non-send rollback are the draft's status here (the
 * double has no dispatcher), and the real mark/unclaim plans are exercised in `tests/data/outbox-predecessor.test.ts`. Each refusal keeps
 * the input and shows the review; the person's explicit "Save mine" / save again then saves on what they now see. Every schedule has its
 * control. Component evidence: one page, the store double; not independent pages, real IndexedDB or a crash.
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

async function dialogNamed(name: string): Promise<HTMLElement> {
  return waitFor(() => {
    const found = screen.queryByRole("dialog", { name });
    expect(found, `the dialog ${name} is shown`).not.toBeNull();
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
  };
}

const textOf = (d: DraftWithCommand): unknown => {
  const body = d.command as {
    command?: { value?: { text?: string } };
    commands?: Array<{ label?: string }>;
  };
  return body.command?.value?.text ?? body.commands?.[0]?.label;
};
/** Every stored draft as [local id, text], with each body's digest asserted to be that body's. */
const stored = (w: PeopleWorld) =>
  w.drafts.map((d) => {
    expect(d.command_digest).toBe(digestOf(d.command));
    return [d.local_id, textOf(d)];
  });

// ---- the two callers, set up identically: L is the queued save of A at stored base 4; the resource's record is 5 -----------------
interface Caller {
  name: "field" | "rename";
  id: string;
  request(text: string): EnqueueRequest;
  open(w: PeopleWorld): Promise<{ form: HTMLElement; input: HTMLInputElement }>;
  save(form: HTMLElement): void;
  review: string;
  /** The person's explicit continuation after the review: "Save mine on the current version", or saving the form again. */
  again(form: HTMLElement): Promise<void>;
}

const field: Caller = {
  name: "field",
  id: F,
  request: (text) =>
    putFieldUpdateRequest({
      fieldId: F,
      personId: P,
      label: "Note",
      value: { kind: "text", text },
      policyVersion: 6,
      sameKind: true,
    }),
  async open(w) {
    await w.mount(`/people/${P}/fields/${F}`);
    const d = await dialogNamed("Edit Note");
    const input = await waitFor(() => {
      const v = box(d, "Value");
      expect(v).toBeEnabled();
      return v;
    });
    return { form: d, input };
  },
  save: (form) =>
    fireEvent.click(within(form).getByRole("button", { name: "Save" })),
  review: "This field changed since you opened it",
  async again(form) {
    const mine = await waitFor(() => {
      const b = within(form).getByRole("button", {
        name: "Save mine on the current version",
      });
      expect(b).toBeEnabled();
      return b;
    });
    fireEvent.click(mine);
  },
};

const rename: Caller = {
  name: "rename",
  id: P,
  request: (text) =>
    renameEditRequest({ personId: P, name: text, policyVersion: 6 }),
  async open(w) {
    await w.mount(`/people/${P}`);
    const button = await screen.findByRole("button", { name: "Rename" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    const input = (await screen.findByRole("textbox", {
      name: "Name",
    })) as HTMLInputElement;
    await waitFor(() => expect(input).toBeEnabled());
    return {
      form: input.closest("form") as HTMLElement,
      input,
    };
  },
  save: (form) =>
    fireEvent.click(within(form).getByRole("button", { name: "Save" })),
  review:
    "This person changed since you started. Review the name, then save again.",
  async again(form) {
    const button = await waitFor(() => {
      const b = within(form).getByRole("button", { name: "Save" });
      expect(b).toBeEnabled();
      return b;
    });
    fireEvent.click(button);
  },
};

function worldWithL(caller: Caller): PeopleWorld {
  const w = peopleWorld();
  w.setCache([
    person({ id: P, label: "Ada", version: 4, policy_version: 6 }),
    fieldRow({
      id: F,
      parent_id: P,
      label: "Note",
      version: 4,
      policy_version: 6,
    }),
  ]);
  w.env.setDefaults(record());
  const id = caller.id;
  w.setDrafts([
    draftRow({
      local_id: "L",
      created_seq: 1,
      endpoint: caller.name === "field" ? "/task-commands" : "/commands",
      kind: caller.name === "field" ? "put_field" : "edit",
      target_resource_ids: [id],
      index_targets: [id],
      bases: { [id]: 4 },
      bumped: [id],
      expected_version: 4,
      command: caller.request("A").build({ [id]: 4 }).command,
    }),
  ]);
  w.versions.set(id, 5);
  w.sharing.next.policy.push(ok({ version: 6, policy: PRIVATE }));
  w.sharing.next.policy.push(ok({ version: 6, policy: PRIVATE }));
  return w;
}

for (const caller of [field, rename])
  describe(`R12.1 (${caller.name}): the save typed over L follows it only while L is stored as it was read`, () => {
    for (const peer of ["changed", "none"] as const)
      test(`L claimed when Save is pressed, then returned to the queue ${peer === "changed" ? "and edited elsewhere to B: refused at the write, no successor, the input kept, the review shown; the person's explicit save then puts C on B" : "unchanged (control): the successor follows L at base 5"}`, async () => {
        const w = worldWithL(caller);
        const { form, input } = await caller.open(w);
        fireEvent.change(input, { target: { value: "Editor C" } });
        // The dispatcher's first claim of L: no edit in place is possible, so the save will be a new draft after L.
        await act(async () =>
          w.setDrafts([
            { ...(w.drafts[0] as DraftWithCommand), status: "in_flight" },
          ]),
        );
        const g = gate(w, "enqueue");
        caller.save(form);
        await waitFor(() => expect(g.state.entered).toBe(1));
        const read = (w.drafts[0] as DraftWithCommand).command_digest;
        // A definite non-send returns the first claim to the queue (status only: the double has no dispatcher).
        await act(async () =>
          w.setDrafts([
            { ...(w.drafts[0] as DraftWithCommand), status: "queued" },
          ]),
        );
        if (peer === "changed")
          await act(async () => {
            const outbox = w.env.outbox();
            expect(
              await outbox?.editQueued("L", {
                ...caller.request("Peer B"),
                expectDraft: (d) => d.command_digest === read,
              }),
            ).toEqual({ kind: "edited", localId: "L" });
          });
        // The positive witness at the write: L's body is B (another digest) or still A; the record has not moved.
        expect((w.drafts[0] as DraftWithCommand).command_digest === read).toBe(
          peer === "none",
        );
        expect(w.versions.get(caller.id)).toBe(5);
        await g.release();
        if (peer === "changed") {
          await waitFor(() =>
            expect(within(form).queryByText(caller.review)).not.toBeNull(),
          );
          expect(stored(w)).toEqual([["L", "Peer B"]]);
          expect(input).toHaveValue("Editor C");
          expect(w.versions.get(caller.id)).toBe(5);
          // The person reviewed B and saves theirs on it explicitly: L is queued, so C replaces B in place on L's stored base.
          await caller.again(form);
          await waitFor(() => expect(stored(w)).toEqual([["L", "Editor C"]]));
          expect((w.drafts[0] as DraftWithCommand).bases[caller.id]).toBe(4);
        } else {
          await waitFor(() => expect(w.drafts).toHaveLength(2));
          const successor = w.drafts[1] as DraftWithCommand;
          expect(textOf(successor)).toBe("Editor C");
          expect(successor.bases[caller.id]).toBe(5);
          expect(successor.depends_on).toEqual(["L"]);
          expect(w.versions.get(caller.id)).toBe(6);
        }
      });

    test("L stays claimed (a genuinely frozen send): the save follows it, never edits it", async () => {
      const w = worldWithL(caller);
      const { form, input } = await caller.open(w);
      fireEvent.change(input, { target: { value: "Editor C" } });
      await act(async () =>
        w.setDrafts([
          { ...(w.drafts[0] as DraftWithCommand), status: "in_flight" },
        ]),
      );
      caller.save(form);
      await waitFor(() => expect(w.drafts).toHaveLength(2));
      expect(stored(w)).toEqual([
        ["L", "A"],
        [expect.any(String), "Editor C"],
      ]);
    });
  });

for (const caller of [field, rename])
  describe(`reverse schedule (${caller.name}): an edit in place of L is refused once a later save follows it`, () => {
    for (const later of [true, false])
      test(`the edit of L held at its write ${later ? "while another save of the same item is queued after L: refused not_latest, L keeps A, the input kept, the review shown" : "(control, nothing queued after L): L edited in place"}`, async () => {
        const w = worldWithL(caller);
        const { form, input } = await caller.open(w);
        fireEvent.change(input, { target: { value: "Editor C" } });
        const g = gate(w, "editQueued");
        caller.save(form);
        await waitFor(() => expect(g.state.entered).toBe(1));
        const read = (w.drafts[0] as DraftWithCommand).command_digest;
        if (later)
          await act(async () => {
            // Another page's save built over A (it names L as it read it).
            const queued = await w.env.outbox()?.enqueue({
              ...caller.request("Other M"),
              expectPredecessor: {
                resourceId: caller.id,
                localId: "L",
                digest: read,
              },
            });
            expect(queued?.kind).toBe("queued");
          });
        await g.release();
        if (later) {
          await waitFor(() =>
            expect(within(form).queryByText(caller.review)).not.toBeNull(),
          );
          expect(stored(w)).toEqual([
            ["L", "A"],
            [expect.any(String), "Other M"],
          ]);
          expect(input).toHaveValue("Editor C");
        } else {
          await waitFor(() => expect(stored(w)).toEqual([["L", "Editor C"]]));
          if (caller.name === "field") await closed();
        }
      });
  });

describe("reverse schedule (unsent create): an edit of the create is refused once a later save of the field follows it", () => {
  for (const later of [true, false])
    test(`the edit of the queued create held at its write ${later ? "while a save of the same field is queued after it: refused, the create keeps A, the input kept with the reason" : "(control): the create edited in place"}`, async () => {
      const w = peopleWorld();
      w.setCache([person({ id: P, label: "Ada" })]);
      w.env.setDefaults(record());
      await w.mount(`/people/${P}/fields/new`);
      const add = await dialogNamed("Add a field");
      fireEvent.change(box(add, "Name"), { target: { value: "Queued" } });
      fireEvent.change(box(add, "Value"), { target: { value: "A" } });
      fireEvent.click(within(add).getByRole("radio", { name: "Only you" }));
      fireEvent.click(within(add).getByRole("button", { name: "Save" }));
      await closed();
      cleanup();
      const id = w.built[0]?.request.targets[0]?.resourceId as string;
      const create = w.drafts[0] as DraftWithCommand;
      await w.mount(`/people/${P}/fields/${id}`);
      const d = await dialogNamed("Edit Queued");
      fireEvent.change(box(d, "Value"), { target: { value: "Editor C" } });
      const g = gate(w, "editQueued");
      fireEvent.click(within(d).getByRole("button", { name: "Save" }));
      await waitFor(() => expect(g.state.entered).toBe(1));
      if (later)
        await act(async () => {
          const queued = await w.env.outbox()?.enqueue(
            putFieldUpdateRequest({
              fieldId: id,
              personId: P,
              label: "Queued",
              value: { kind: "text", text: "Other M" },
              policyVersion: 1,
              sameKind: true,
            }),
          );
          expect(queued?.kind).toBe("queued");
        });
      await g.release();
      if (later) {
        await waitFor(() =>
          expect(
            within(d).queryByText(
              "This field was changed in another window since you opened it. Close it and open it again to see the change; nothing was saved.",
            ),
          ).not.toBeNull(),
        );
        expect(
          (
            w.drafts.find(
              (x) => x.local_id === create.local_id,
            ) as DraftWithCommand
          ).command_digest,
        ).toBe(create.command_digest);
        expect(w.drafts).toHaveLength(2);
        expect(box(d, "Value")).toHaveValue("Editor C");
      } else {
        await closed();
        expect(stored(w)).toEqual([[create.local_id, "Editor C"]]);
      }
    });
});

// ---- DA12-06: the content step after the audience step (online), and the offline "Save now" -----------------------------------------
const HOME_VIEW = {
  grants: [{ kind: "household" as const, id: HOME, edit: false }],
  exclude_accounts: [],
};
function deferred<T>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
/** The field world with L claimed (in flight) and the audience shown as the household's, version 6. */
function claimedWithAudience(online: boolean): PeopleWorld {
  const w = peopleWorld({ online });
  w.setCache([
    person({ id: P, label: "Ada", version: 4, policy_version: 6 }),
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
      status: "in_flight",
      endpoint: "/task-commands",
      kind: "put_field",
      target_resource_ids: [F],
      index_targets: [F],
      bases: { [F]: 4 },
      bumped: [F],
      expected_version: 4,
      command: field.request("A").build({ [F]: 4 }).command,
    }),
  ]);
  w.versions.set(F, 5);
  peopleMemory(w.people.identity).policies.set(F, {
    version: 6,
    policy: HOME_VIEW,
    checkedAt: Date.now(),
  });
  return w;
}
const peerEditOfL = async (w: PeopleWorld, read: string) => {
  w.setDrafts([{ ...(w.drafts[0] as DraftWithCommand), status: "queued" }]);
  expect(
    await w.env.outbox()?.editQueued("L", {
      ...field.request("Peer B"),
      expectDraft: (d) => d.command_digest === read,
    }),
  ).toEqual({ kind: "edited", localId: "L" });
};

describe("DA12-06: the content is judged where it is written after the audience step, which is never repeated", () => {
  for (const peer of [true, false])
    test(`online: the audience change is confirmed, ${peer ? "while L was returned to the queue and edited elsewhere: the content is refused, the input kept and the review shown; the audience change happened once, and the person's explicit save then edits L in place without sending it again" : "nothing else changed (control): the content follows L on the confirmed policy version"}`, async () => {
      const w = claimedWithAudience(true);
      const send = deferred<unknown>();
      // The read before the change, then the confirming read after it (the editor's own read is the page's memory above).
      w.sharing.next.policy.push(
        ok({ version: 6, policy: HOME_VIEW }),
        ok({ version: 7, policy: PRIVATE }),
      );
      w.sharing.next.management.push(() => send.promise as never);
      const { form, input } = await field.open(w);
      fireEvent.change(input, { target: { value: "Editor C" } });
      fireEvent.click(within(form).getByRole("radio", { name: "Only you" }));
      field.save(form);
      await waitFor(() => expect(w.sharing.sent).toHaveLength(1));
      const read = (w.drafts[0] as DraftWithCommand).command_digest;
      if (peer) await act(async () => peerEditOfL(w, read));
      await act(async () => send.release(ok({ revision: 1 })));
      if (peer) {
        await waitFor(() =>
          expect(within(form).queryByText(field.review)).not.toBeNull(),
        );
        expect(stored(w)).toEqual([["L", "Peer B"]]);
        expect(input).toHaveValue("Editor C");
        expect(w.sharing.sent).toHaveLength(1);
        // The audience change reaches the field's row through sync, as it does in the app (the sharing double does not publish it).
        await act(async () =>
          w.setCache([
            person({ id: P, label: "Ada", version: 4, policy_version: 6 }),
            fieldRow({
              id: F,
              parent_id: P,
              label: "Note",
              version: 4,
              policy_version: 7,
            }),
          ]),
        );
        await field.again(form);
        await waitFor(() => expect(stored(w)).toEqual([["L", "Editor C"]]));
        expect(
          (w.drafts[0] as DraftWithCommand).command as {
            command: { expected_policy_version: number };
          },
        ).toMatchObject({ command: { expected_policy_version: 7 } });
        expect(w.sharing.sent).toHaveLength(1);
      } else {
        await waitFor(() => expect(w.drafts).toHaveLength(2));
        const successor = w.drafts[1] as DraftWithCommand;
        expect(successor.command).toMatchObject({
          command: {
            expected_version: 5,
            expected_policy_version: 7,
            value: { kind: "text", text: "Editor C" },
          },
        });
        expect(successor.depends_on).toEqual(["L"]);
        expect(w.sharing.sent).toHaveLength(1);
      }
    });

  for (const peer of [true, false])
    test(`offline "Save now" (the audience unchanged for now): the save is held at its write ${peer ? "while L is returned to the queue and edited elsewhere: refused, nothing written, the input kept and the review shown" : "(control): it follows L at base 5"}`, async () => {
      const w = claimedWithAudience(false);
      const { form, input } = await field.open(w);
      fireEvent.change(input, { target: { value: "Editor C" } });
      fireEvent.click(within(form).getByRole("radio", { name: "Only you" }));
      field.save(form);
      await within(form).findByText(
        "You're offline, so the audience can't change yet",
      );
      fireEvent.click(
        within(form).getByRole("radio", { name: /Save the Note now/ }),
      );
      const g = gate(w, "enqueue");
      fireEvent.click(within(form).getByRole("button", { name: "Save now" }));
      await waitFor(() => expect(g.state.entered).toBe(1));
      const read = (w.drafts[0] as DraftWithCommand).command_digest;
      if (peer) await act(async () => peerEditOfL(w, read));
      await g.release();
      if (peer) {
        await waitFor(() =>
          expect(within(form).queryByText(field.review)).not.toBeNull(),
        );
        expect(stored(w)).toEqual([["L", "Peer B"]]);
        expect(input).toHaveValue("Editor C");
      } else {
        await waitFor(() => expect(w.drafts).toHaveLength(2));
        expect(w.drafts[1]?.depends_on).toEqual(["L"]);
        expect(w.drafts[1]?.bases[F]).toBe(5);
      }
      expect(w.sharing.sent).toEqual([]);
    });
});
