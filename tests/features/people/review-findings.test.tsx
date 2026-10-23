import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { FormRecoveryRow, JsonObject } from "../../../src/data";
import type { HeldChange } from "../../../src/features/people/field/held-store";
import {
  forgetAllPeopleMemory,
  peopleMemory,
} from "../../../src/features/people/memory";
import { toWirePolicy } from "../../../src/features/sharing";
import { forgetRefusedPolicies } from "../../../src/features/sharing/api";
import { nextAttempt } from "../../../src/features/sharing/model/submission";
import { installMatchMedia } from "../../helpers/match-media";
import { draftRow } from "../../support/data/rows";
import { HOME, ME, record } from "../../support/people/records";
import { fieldRow, peopleWorld, person } from "../../support/people/world";
import { ok } from "../../support/sharing/fake-api";

/**
 * The corrections of the review of 13 October 2026 (WEB-11a, findings 1–7), composed through the real screens over the component world.
 * Each schedule has its positive control; every assertion names what was SENT or QUEUED (or that nothing was), never only what is shown.
 * Fixture evidence: the world's outbox models the real bases (`resource_versions` follows the server; a build that throws writes nothing).
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
const Q = "77777777-7777-4777-8777-777777777777";
const F = "66666666-6666-4666-8666-666666666666";
const H = "88888888-8888-4888-8888-888888888888";
const HOLD = "aaaaaaaa-0000-4000-8000-000000000001";
const PRIVATE = { grants: [], exclude_accounts: [] };
const HOME_VIEW = {
  grants: [{ kind: "household" as const, id: HOME, edit: false }],
  exclude_accounts: [],
};
const dialog = () => screen.findByRole("dialog");
/** One answer object for a held read: a store's snapshot must be stable between changes (`useSyncExternalStore`). */
const LOADING = { status: "loading" } as const;
const body = (index = 0, w: ReturnType<typeof peopleWorld>) =>
  ((w.built[index]?.command ?? {}) as { command: Record<string, unknown> })
    .command;
/** The first command of the first `/commands` batch built (a rename's `edit`). */
const firstOfBatch = (w: ReturnType<typeof peopleWorld>) =>
  (
    w.built[0]?.command as
      | { commands?: Array<Record<string, unknown>> }
      | undefined
  )?.commands?.[0];
const said = (text: string) =>
  waitFor(() => expect(document.body.textContent).toContain(text));
const settle = () =>
  act(async () => {
    for (let i = 0; i < 5; i += 1)
      await new Promise((resolve) => setTimeout(resolve, 0));
  });

/** A field at content version 4 / policy version 6, "Only you", its editor open and a confidential value typed. */
async function editing(options: { online?: boolean } = {}) {
  const w = peopleWorld({ online: options.online ?? true });
  w.setCache([
    person({ id: P, label: "Ada" }),
    fieldRow({
      id: F,
      parent_id: P,
      label: "Note",
      version: 4,
      policy_version: 6,
      value: { kind: "text", text: "Original" },
    }),
  ]);
  w.env.setDefaults(record());
  if (options.online ?? true)
    w.sharing.next.policy.push(ok({ version: 6, policy: PRIVATE }));
  await w.mount(`/people/${P}/fields/${F}`);
  const d = await dialog();
  if (options.online ?? true)
    await within(d).findByRole("radio", { name: "Only you", checked: true });
  fireEvent.change(within(d).getByRole("textbox", { name: "Value" }), {
    target: { value: "Confidential" },
  });
  return { w, d };
}

describe("finding 1: an edit keeps the versions and audience it began on", () => {
  test("control: nothing changed meanwhile, the update carries the versions the edit began on", async () => {
    const { w, d } = await editing();
    fireEvent.click(within(d).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(w.built).toHaveLength(1));
    expect(body(0, w)).toMatchObject({
      expected_version: 4,
      expected_policy_version: 6,
      value: { kind: "text", text: "Confidential" },
    });
  });

  test("a policy published while the edit is open: Save writes NOTHING; the current audience is shown and only an explicit 'Save mine' re-binds", async () => {
    const { w, d } = await editing();
    // Version 7 widened the audience; the editor reads it again (its read is older than the field's policy version).
    w.sharing.next.policy.push(ok({ version: 7, policy: HOME_VIEW }));
    w.putCache(
      fieldRow({
        id: F,
        parent_id: P,
        label: "Note",
        version: 4,
        policy_version: 7,
        value: { kind: "text", text: "Original" },
      }),
    );
    const review = await within(d).findByText(
      "This field changed since you opened it",
    );
    const panel = review.closest("section") as HTMLElement;
    await within(panel).findByText("Who can see it now: Home · can view");
    fireEvent.click(within(d).getByRole("button", { name: "Save" }));
    await settle();
    expect(w.built).toEqual([]);
    expect(w.sharing.sent).toEqual([]);
    expect(
      within(panel).queryByText(
        "Nothing was saved. Check the current value, then save yours on it or discard it.",
      ),
    ).not.toBeNull();
    fireEvent.click(
      within(panel).getByRole("button", {
        name: "Save mine on the current version",
      }),
    );
    await waitFor(() => expect(w.built).toHaveLength(1));
    expect(body(0, w)).toMatchObject({
      expected_version: 4,
      expected_policy_version: 7,
      value: { kind: "text", text: "Confidential" },
    });
  });

  test("offline, a changed audience cannot be shown: 'Save mine' is withheld with its reason and nothing is written", async () => {
    const w = peopleWorld({ online: false });
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
    await w.mount(`/people/${P}/fields/${F}`);
    const d = await dialog();
    fireEvent.change(within(d).getByRole("textbox", { name: "Value" }), {
      target: { value: "Confidential" },
    });
    w.putCache(
      fieldRow({
        id: F,
        parent_id: P,
        label: "Note",
        version: 4,
        policy_version: 7,
      }),
    );
    const panel = (
      await within(d).findByText("This field changed since you opened it")
    ).closest("section") as HTMLElement;
    expect(
      within(panel).getByText(
        "Who can see it changed since you saved. Check it before saving yours again.",
      ),
    ).toBeInTheDocument();
    expect(
      within(panel).getByRole("button", {
        name: "Save mine on the current version",
      }),
    ).toBeDisabled();
    expect(
      within(panel).getByText(
        "Check who can see it first: that needs a connection",
      ),
    ).toBeInTheDocument();
    fireEvent.click(within(d).getByRole("button", { name: "Save" }));
    await settle();
    expect(w.built).toEqual([]);
  });

  test("content published while the edit is open: nothing is written on the newer version until the person chooses 'Save mine'", async () => {
    const { w, d } = await editing();
    w.putCache(
      fieldRow({
        id: F,
        parent_id: P,
        label: "Note",
        version: 5,
        policy_version: 6,
        value: { kind: "text", text: "Someone else's newer text" },
      }),
    );
    const panel = (
      await within(d).findByText("This field changed since you opened it")
    ).closest("section") as HTMLElement;
    expect(
      within(panel).getByText(/Someone else's newer text/),
    ).toBeInTheDocument();
    expect(within(d).getByRole("textbox", { name: "Value" })).toHaveValue(
      "Confidential",
    );
    fireEvent.click(within(d).getByRole("button", { name: "Save" }));
    await settle();
    expect(w.built).toEqual([]);
    fireEvent.click(
      within(panel).getByRole("button", {
        name: "Save mine on the current version",
      }),
    );
    await waitFor(() => expect(w.built).toHaveLength(1));
    expect(body(0, w)).toMatchObject({
      expected_version: 5,
      expected_policy_version: 6,
      value: { kind: "text", text: "Confidential" },
    });
  });

  test("another save of the field queued by another page after the edit began: the outbox base moved, so nothing is written", async () => {
    const { w, d } = await editing();
    // The record (`resource_versions`) was raised by another page's save; the cache still shows 4.
    w.versions.set(F, 5);
    fireEvent.click(within(d).getByRole("button", { name: "Save" }));
    await settle();
    expect(w.built).toEqual([]);
    expect(
      within(d).queryByText("This field changed since you opened it"),
    ).not.toBeNull();
  });

  test("restored after a remount, the edit is still bound to what it began on", async () => {
    const { w } = await editing();
    cleanup();
    w.putCache(
      fieldRow({
        id: F,
        parent_id: P,
        label: "Note",
        version: 5,
        policy_version: 6,
      }),
    );
    await w.mount(`/people/${P}/fields/${F}`);
    const d = await dialog();
    expect(within(d).getByRole("textbox", { name: "Value" })).toHaveValue(
      "Confidential",
    );
    await within(d).findByText("This field changed since you opened it");
    fireEvent.click(within(d).getByRole("button", { name: "Save" }));
    await settle();
    expect(w.built).toEqual([]);
  });

  test("an unsent save the edit began on is edited in place; one queued AFTER it began is never coalesced or re-based", async () => {
    const queuedUpdate = (localId: string, seq: number, base: number) =>
      draftRow({
        local_id: localId,
        created_seq: seq,
        endpoint: "/task-commands",
        kind: "put_field",
        target_resource_ids: [F],
        index_targets: [F],
        bases: { [F]: base },
        bumped: [F],
        command: {
          command: {
            kind: "put_field",
            id: F,
            parent_id: P,
            expected_version: base,
            expected_policy_version: 6,
            label: "Note",
            value: { kind: "text", text: `queued ${localId}` },
          },
        },
      });
    // Control: the edit began on the queued save L; it is edited in place.
    {
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
      w.setDrafts([queuedUpdate("L", 1, 4)]);
      w.versions.set(F, 5);
      w.env.setDefaults(record());
      w.sharing.next.policy.push(ok({ version: 6, policy: PRIVATE }));
      await w.mount(`/people/${P}/fields/${F}`);
      const d = await dialog();
      fireEvent.change(within(d).getByRole("textbox", { name: "Value" }), {
        target: { value: "Edited in place" },
      });
      fireEvent.click(within(d).getByRole("button", { name: "Save" }));
      await waitFor(() => expect(w.built).toHaveLength(1));
      expect(w.built[0]).toMatchObject({ op: "edit", target: "L" });
      cleanup();
      forgetAllPeopleMemory();
    }
    // Another page queued M after the edit began: never coalesced into M, and the guarded enqueue refuses (the base is no longer 5).
    {
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
      w.setDrafts([queuedUpdate("L", 1, 4)]);
      w.versions.set(F, 5);
      w.env.setDefaults(record());
      w.sharing.next.policy.push(ok({ version: 6, policy: PRIVATE }));
      await w.mount(`/people/${P}/fields/${F}`);
      const d = await dialog();
      fireEvent.change(within(d).getByRole("textbox", { name: "Value" }), {
        target: { value: "Edited in place" },
      });
      w.setDrafts([queuedUpdate("L", 1, 4), queuedUpdate("M", 2, 5)]);
      w.versions.set(F, 6);
      fireEvent.click(within(d).getByRole("button", { name: "Save" }));
      await within(d).findByText("This field changed since you opened it");
      expect(w.built).toEqual([]);
    }
  });

  test("a rename is bound to the version its form opened on (Q21): a newer version is reviewed before anything is sent", async () => {
    const w = peopleWorld();
    w.setCache([
      person({ id: P, label: "Ada", version: 3, policy_version: 2 }),
    ]);
    await w.mount(`/people/${P}`);
    const rename = await screen.findByRole("button", {
      name: "Rename",
    });
    await waitFor(() => expect(rename).toBeEnabled());
    fireEvent.click(rename);
    fireEvent.change(await screen.findByRole("textbox", { name: "Name" }), {
      target: { value: "Ada corrected" },
    });
    w.putCache(
      person({ id: P, label: "Ada (server)", version: 4, policy_version: 2 }),
    );
    const form = document.querySelector("[data-rename-form]") as HTMLElement;
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));
    await within(form).findByText(
      "This person changed since you started. Review the name, then save again.",
    );
    expect(w.built).toEqual([]);
    // The person's deliberate second save, on the version now shown.
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(w.built).toHaveLength(1));
    expect(firstOfBatch(w)).toMatchObject({
      id: P,
      expected_version: 4,
      expected_policy_version: 2,
      label: "Ada corrected",
    });
  });
});

describe("review 2, finding 3: an old editor never overwrites a newer edit of the SAME queued draft", () => {
  const queuedL = (
    text: string,
    digest: string,
    over: Record<string, unknown> = {},
  ) =>
    draftRow({
      local_id: "L",
      created_seq: 1,
      endpoint: "/task-commands",
      kind: "put_field",
      target_resource_ids: [F],
      index_targets: [F],
      bases: { [F]: 4 },
      bumped: [F],
      command_digest: digest,
      command: {
        command: {
          kind: "put_field",
          id: F,
          parent_id: P,
          expected_version: 4,
          expected_policy_version: 6,
          label: "Note",
          value: { kind: "text", text },
        },
      },
      ...over,
    });
  async function openOnL() {
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
    w.setDrafts([queuedL("Original queued", "digest-original")]);
    w.versions.set(F, 5);
    w.env.setDefaults(record());
    w.sharing.next.policy.push(ok({ version: 6, policy: PRIVATE }));
    await w.mount(`/people/${P}/fields/${F}`);
    const d = await dialog();
    await within(d).findByRole("textbox", { name: "Value" });
    fireEvent.change(within(d).getByRole("textbox", { name: "Value" }), {
      target: { value: "Older open editor" },
    });
    return { w, d };
  }

  for (const concurrent of [false, true])
    test(`a field update over queued L ${concurrent ? "that another page edited meanwhile: nothing is written, no successor, the field is reviewed" : "(control): edited in place"}`, async () => {
      const { w, d } = await openOnL();
      if (concurrent) {
        w.setDrafts([queuedL("Newer save from another tab", "digest-newer")]);
        await settle();
      }
      fireEvent.click(within(d).getByRole("button", { name: "Save" }));
      if (!concurrent) {
        await waitFor(() => expect(w.built).toHaveLength(1));
        expect(w.built[0]).toMatchObject({ op: "edit", target: "L" });
        return;
      }
      await waitFor(() =>
        expect(
          within(d).queryByText("This field changed since you opened it"),
        ).not.toBeNull(),
      );
      expect(w.built).toEqual([]);
      expect(
        (
          w.drafts[0] as unknown as {
            command: { command: { value: { text: string } } };
          }
        ).command.command.value.text,
      ).toBe("Newer save from another tab");
      // The person's input is kept for the review.
      expect(within(d).getByRole("textbox", { name: "Value" })).toHaveValue(
        "Older open editor",
      );
    });

  for (const changed of [false, true])
    test(`L left the queue ${changed ? "with ANOTHER body than the editor read: no successor is queued" : "with the body the editor read (control): a successor follows it"}`, async () => {
      const { w, d } = await openOnL();
      // L is being sent (no longer editable in place).
      w.setDrafts([
        queuedL(
          changed ? "Changed before it was sent" : "Original queued",
          changed ? "digest-newer" : "digest-original",
          { status: "in_flight" },
        ),
      ]);
      await settle();
      fireEvent.click(within(d).getByRole("button", { name: "Save" }));
      if (!changed) {
        await waitFor(() => expect(w.built).toHaveLength(1));
        expect(w.built[0]).toMatchObject({ op: "enqueue" });
        return;
      }
      await waitFor(() =>
        expect(
          within(d).queryByText("This field changed since you opened it"),
        ).not.toBeNull(),
      );
      expect(w.built).toEqual([]);
    });

  for (const concurrent of [false, true])
    test(`a queued rename edited ${concurrent ? "by another page while the form was open: nothing is written; it is reviewed again" : "(control): in place"}`, async () => {
      const renameL = (label: string, digest: string) =>
        draftRow({
          local_id: "R",
          created_seq: 1,
          endpoint: "/commands",
          kind: "edit",
          target_resource_ids: [P],
          index_targets: [P],
          bases: { [P]: 3 },
          bumped: [P],
          command_digest: digest,
          command: {
            commands: [
              {
                kind: "edit",
                id: P,
                expected_version: 3,
                expected_policy_version: 2,
                label,
                value: "",
              },
            ],
          },
        });
      const w = peopleWorld();
      w.setCache([
        person({ id: P, label: "Ada", version: 3, policy_version: 2 }),
      ]);
      w.setDrafts([renameL("Ada queued", "r-original")]);
      w.versions.set(P, 4);
      await w.mount(`/people/${P}`);
      const rename = await screen.findByRole("button", { name: "Rename" });
      await waitFor(() => expect(rename).toBeEnabled());
      fireEvent.click(rename);
      fireEvent.change(await screen.findByRole("textbox", { name: "Name" }), {
        target: { value: "Ada from the old form" },
      });
      if (concurrent) {
        w.setDrafts([renameL("Ada from another tab", "r-newer")]);
        await settle();
      }
      const form = document.querySelector("[data-rename-form]") as HTMLElement;
      fireEvent.click(within(form).getByRole("button", { name: "Save" }));
      if (!concurrent) {
        await waitFor(() => expect(w.built).toHaveLength(1));
        expect(w.built[0]).toMatchObject({ op: "edit", target: "R" });
        return;
      }
      await waitFor(() =>
        expect(
          within(form).queryByText(
            "This person changed since you started. Review the name, then save again.",
          ),
        ).not.toBeNull(),
      );
      expect(w.built).toEqual([]);
    });

  for (const concurrent of [false, true])
    test(`an unsent create edited ${concurrent ? "by another page while the editor was open: nothing is written, the editor says so" : "(control): in place"}`, async () => {
      const create = (text: string, digest: string) =>
        draftRow({
          local_id: "f1",
          created_seq: 1,
          endpoint: "/task-commands",
          target_resource_ids: [F],
          command_digest: digest,
          command: {
            command: {
              kind: "put_field",
              id: F,
              parent_id: P,
              label: "Phone",
              value: { kind: "text", text },
            },
          },
        });
      const w = peopleWorld();
      w.setCache([person({ id: P, label: "Ada" })]);
      w.env.setDefaults(record());
      w.setDrafts([create("0770", "c-original")]);
      await w.mount(`/people/${P}/fields/${F}`);
      const d = await dialog();
      fireEvent.change(within(d).getByRole("textbox", { name: "Value" }), {
        target: { value: "0771 (old editor)" },
      });
      if (concurrent) {
        w.setDrafts([create("0772 (another tab)", "c-newer")]);
        await settle();
      }
      fireEvent.click(within(d).getByRole("button", { name: "Save" }));
      if (!concurrent) {
        await waitFor(() => expect(w.built).toHaveLength(1));
        expect(w.built[0]).toMatchObject({ op: "edit", target: "f1" });
        return;
      }
      await waitFor(() =>
        expect(
          within(d).queryByText(/This field was changed in another window/),
        ).not.toBeNull(),
      );
      expect(w.built).toEqual([]);
    });
});

describe("finding 1 (continued): a linked rename and a held continuation", () => {
  test("a linked rename (rename_profile, online-only) sends nothing on a version newer than the form opened on until saved again", async () => {
    const w = peopleWorld();
    w.api.linked.set(P, ME);
    w.setCache([
      person({ id: P, label: "Ada", version: 3, policy_version: 2 }),
    ]);
    await w.mount(`/people/${P}`);
    const rename = await screen.findByRole("button", { name: "Rename" });
    await waitFor(() => expect(rename).toBeEnabled());
    fireEvent.click(rename);
    fireEvent.change(await screen.findByRole("textbox", { name: "Name" }), {
      target: { value: "Ada Lovelace" },
    });
    w.putCache(
      person({ id: P, label: "Ada (server)", version: 4, policy_version: 2 }),
    );
    const form = document.querySelector("[data-rename-form]") as HTMLElement;
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));
    await settle();
    expect(w.api.calls.filter((c) => c.op === "peopleCommand")).toEqual([]);
    expect(
      within(form).queryByText(
        "This person changed since you started. Review the name, then save again.",
      ),
    ).not.toBeNull();
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(w.api.calls.filter((c) => c.op === "peopleCommand")).toHaveLength(
        1,
      ),
    );
    expect(
      w.api.calls.find((c) => c.op === "peopleCommand")?.args[1],
    ).toMatchObject({
      command: {
        kind: "rename_profile",
        expected_version: 4,
        name: "Ada Lovelace",
      },
    });
  });

  test("a held change whose field changed while its policy read was on its way queues no content on the newer version", async () => {
    const w = heldWorld();
    const read = deferred<unknown>();
    w.sharing.next.policy.push(
      () => read.promise as never,
      ok({ version: 7, policy: PRIVATE }),
    );
    await w.mount(`/people/${P}`);
    await waitFor(() =>
      expect(w.sharing.calls.filter((c) => c.op === "readPolicy")).toHaveLength(
        1,
      ),
    );
    w.putCache(
      fieldRow({
        id: F,
        parent_id: P,
        label: "Note",
        version: 5,
        policy_version: 6,
        value: { kind: "text", text: "Newer content" },
      }),
    );
    await act(async () => read.release(ok({ version: 6, policy: HOME_VIEW })));
    await waitFor(() =>
      expect(heldRow()?.textContent ?? "").toContain(
        "Someone else changed this field. Open it to see the current value.",
      ),
    );
    expect(w.built).toEqual([]);
  });

  test("the editor waits for this device's WHOLE chain of saves before it binds an edit (a later window still loading is not 'none')", async () => {
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
    const others = Array.from({ length: 100 }, (_, i) =>
      draftRow({
        local_id: `o${i}`,
        created_seq: i + 1,
        endpoint: "/task-commands",
        kind: "archive",
        command: { command: { kind: "archive", id: `x${i}`, archived: true } },
      }),
    );
    const mine = draftRow({
      local_id: "L",
      created_seq: 200,
      endpoint: "/task-commands",
      kind: "put_field",
      target_resource_ids: [F],
      index_targets: [F],
      bases: { [F]: 4 },
      bumped: [F],
      command: {
        command: {
          kind: "put_field",
          id: F,
          parent_id: P,
          expected_version: 4,
          expected_policy_version: 6,
          label: "Note",
          value: { kind: "text", text: "queued" },
        },
      },
    });
    w.setDrafts([...others, mine]);
    w.versions.set(F, 5);
    w.env.setDefaults(record());
    w.sharing.next.policy.push(ok({ version: 6, policy: PRIVATE }));
    // The second window of outstanding drafts (where this field's own save is) answers late.
    let released = false;
    const service = (
      w.env.serviceStore as unknown as {
        get(): {
          store: {
            watch(
              plan: { name: string },
              input: Record<string, unknown>,
            ): { get(): unknown; subscribe(l: () => void): () => void };
          };
        };
      }
    ).get();
    const original = service.store.watch;
    service.store.watch = (plan, input) => {
      const watch = original(plan, input);
      if (plan.name === "data.readOutstandingCreates" && input.after)
        return {
          ...watch,
          get: () => (released ? watch.get() : LOADING),
        };
      return watch;
    };
    await w.mount(`/people/${P}/fields/${F}`);
    expect(screen.queryByRole("dialog")).toBeNull();
    released = true;
    w.setDrafts([...others, mine]);
    const d = await dialog();
    fireEvent.change(within(d).getByRole("textbox", { name: "Value" }), {
      target: { value: "Edited in place" },
    });
    fireEvent.click(within(d).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(w.built).toHaveLength(1));
    expect(w.built[0]).toMatchObject({ op: "edit", target: "L" });
  });
});

const heldChange = (over: Partial<HeldChange> = {}): HeldChange => ({
  holdId: HOLD,
  fieldId: F,
  personId: P,
  label: "Note",
  value: { kind: "text", text: "Secret held text" },
  sameKind: true,
  version: 4,
  expectedBase: 4,
  from: { version: 6, policy: HOME_VIEW },
  to: PRIVATE,
  attempt: null,
  status: { kind: "waiting" },
  heldAt: "2026-10-13T09:00:00.000Z",
  rev: 0,
  queued: false,
  seq: 0,
  retired: false,
  ...over,
});

/**
 * A page with one held change. `authorised` (the default): the hold was made in THIS page, which may run it by itself (D1 of 22 October
 * 2026); false: a hold recovered from the database, which waits for "Send now".
 */
function heldWorld(
  change: HeldChange = heldChange(),
  { authorised = true }: { authorised?: boolean } = {},
) {
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
  w.putHeld(change);
  if (authorised)
    peopleMemory(w.people.identity).heldAuthority.add(change.holdId);
  return w;
}
const heldRow = () =>
  document.querySelector(`[data-held-field="${F}"]`) as HTMLElement | null;
function deferred<T>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("finding 2: a discarded held change is never continued", () => {
  test("control: a held change runs, one policy change and one content command", async () => {
    const w = heldWorld();
    w.sharing.next.policy.push(
      ok({ version: 6, policy: HOME_VIEW }),
      ok({ version: 7, policy: PRIVATE }),
    );
    await w.mount(`/people/${P}`);
    await waitFor(() => expect(w.built).toHaveLength(1));
    expect(w.sharing.sent).toHaveLength(1);
    expect(body(0, w)).toMatchObject({
      expected_version: 4,
      expected_policy_version: 7,
    });
    await waitFor(() => expect(w.held()).toEqual([]));
  });

  test("Discard while its policy read is on its way: no replace_policy is sent and no content is queued; the hold ends", async () => {
    const w = heldWorld();
    const read = deferred<unknown>();
    w.sharing.next.policy.push(() => read.promise as never);
    await w.mount(`/people/${P}`);
    await waitFor(() =>
      expect(w.sharing.calls.filter((c) => c.op === "readPolicy")).toHaveLength(
        1,
      ),
    );
    fireEvent.click(
      within(heldRow() as HTMLElement).getByRole("button", { name: "Discard" }),
    );
    await act(async () => read.release(ok({ version: 6, policy: HOME_VIEW })));
    await waitFor(() => expect(w.held()).toEqual([]));
    await settle();
    expect(w.sharing.sent).toEqual([]);
    expect(w.built).toEqual([]);
    await said("The held change to Note was discarded. Nothing was sent.");
  });

  test("Discard of a hold whose policy outcome is uncertain keeps its attempt for recovery and says the change may have been made", async () => {
    const attempt = { key: "k-1", body: '[{"kind":"replace_policy"}]' };
    const w = heldWorld(
      heldChange({ attempt, status: { kind: "failed", reason: "uncertain" } }),
    );
    await w.mount(`/people/${P}`);
    const row = await waitFor(() => heldRow() as HTMLElement);
    fireEvent.click(within(row).getByRole("button", { name: "Discard" }));
    // Revision 3 (review 3 C3c): the attempt is kept DURABLY, as a reconciliation record with no content, not only in page memory.
    await waitFor(() =>
      expect(w.held()).toEqual([
        expect.objectContaining({
          holdId: HOLD,
          retired: true,
          attempt,
          value: { kind: "text", text: "" },
        }),
      ]),
    );
    expect(peopleMemory(w.people.identity).attempts.get(`policy:${F}`)).toEqual(
      attempt,
    );
    await said("may already have been made");
    await waitFor(() =>
      expect(document.querySelector("[data-held-retired]")).not.toBeNull(),
    );
    expect(w.sharing.sent).toEqual([]);
  });
});

describe("finding 3: 'Save mine' sends the conflicted save's own content", () => {
  const conflicted = (policyVersion: number) => {
    const command: JsonObject = {
      command: {
        kind: "put_field",
        id: F,
        parent_id: P,
        expected_version: 8,
        expected_policy_version: policyVersion,
        label: "Phone",
        value: { kind: "text", text: "0771" },
      },
    };
    return {
      command,
      row: draftRow({
        local_id: "c",
        kind: "put_field",
        status: "version_conflict",
        endpoint: "/task-commands",
        index_targets: [F],
        target_resource_ids: [F],
        command,
      }),
    };
  };
  function conflictWorld(policyVersion: number, online = true) {
    const w = peopleWorld({ online });
    w.setCache([
      person({ id: P, label: "Ada" }),
      fieldRow({
        id: F,
        parent_id: P,
        label: "Phone",
        version: 9,
        policy_version: 3,
        value: { kind: "text", text: "0779" },
      }),
    ]);
    w.env.setDefaults(record());
    const { command, row } = conflicted(policyVersion);
    w.env.setDrafts([row]);
    w.putBody("c", command);
    return w;
  }

  test("the current value is shown NEXT TO the conflicted save's own, and 'Save mine' supersedes with THAT content on the current version", async () => {
    const w = conflictWorld(3);
    w.sharing.next.policy.push(ok({ version: 3, policy: PRIVATE }));
    await w.mount(`/people/${P}/fields/${F}`);
    const d = await dialog();
    const panel = (
      await within(d).findByText("Someone else changed this field")
    ).closest("section") as HTMLElement;
    expect(
      within(panel).getByText("Current: Phone — 0779"),
    ).toBeInTheDocument();
    await within(panel).findByText("Yours: Phone — 0771");
    // The form shows the current value; "Save mine" must not send it.
    expect(within(d).getByRole("textbox", { name: "Value" })).toHaveValue(
      "0779",
    );
    fireEvent.click(
      within(panel).getByRole("button", {
        name: "Save mine on the current version",
      }),
    );
    await waitFor(() => expect(w.built).toHaveLength(1));
    expect(w.built[0]).toMatchObject({ op: "supersede", target: "c" });
    expect(body(0, w)).toMatchObject({
      expected_version: 9,
      expected_policy_version: 3,
      label: "Phone",
      value: { kind: "text", text: "0771" },
    });
  });

  test("a conflicted save under an older audience: the audience now is shown before 'Save mine'; offline it is withheld", async () => {
    {
      const w = conflictWorld(2);
      w.sharing.next.policy.push(ok({ version: 3, policy: HOME_VIEW }));
      await w.mount(`/people/${P}/fields/${F}`);
      const d = await dialog();
      const panel = (
        await within(d).findByText("Someone else changed this field")
      ).closest("section") as HTMLElement;
      await within(panel).findByText("Who can see it now: Home · can view");
      fireEvent.click(
        within(panel).getByRole("button", {
          name: "Save mine on the current version",
        }),
      );
      await waitFor(() => expect(w.built).toHaveLength(1));
      expect(body(0, w)).toMatchObject({
        expected_policy_version: 3,
        value: { kind: "text", text: "0771" },
      });
      cleanup();
      forgetAllPeopleMemory();
    }
    {
      const w = conflictWorld(2, false);
      await w.mount(`/people/${P}/fields/${F}`);
      const d = await dialog();
      const panel = (
        await within(d).findByText("Someone else changed this field")
      ).closest("section") as HTMLElement;
      await within(panel).findByText("Yours: Phone — 0771");
      expect(
        within(panel).getByRole("button", {
          name: "Save mine on the current version",
        }),
      ).toBeDisabled();
      expect(
        within(panel).getByText(
          "Check who can see it first: that needs a connection",
        ),
      ).toBeInTheDocument();
      expect(w.built).toEqual([]);
    }
  });

  test("after a remount the conflicted content is still the one offered (it is read from the queue, not the form)", async () => {
    const w = conflictWorld(3);
    w.sharing.next.policy.push(ok({ version: 3, policy: PRIVATE }));
    await w.mount(`/people/${P}/fields/${F}`);
    await dialog();
    cleanup();
    await w.mount(`/people/${P}/fields/${F}`);
    const d = await dialog();
    await within(d).findByText("Yours: Phone — 0771");
  });
});

describe("finding 4: state stays with its person when the route changes", () => {
  test("a rename typed on one person is never shown or saved on another, and is kept under its own person", async () => {
    const w = peopleWorld();
    w.setCache([
      person({ id: P, label: "Ada" }),
      person({ id: Q, label: "Bob" }),
    ]);
    const { router } = await w.mount(`/people/${P}`);
    const rename = await screen.findByRole("button", {
      name: "Rename",
    });
    await waitFor(() => expect(rename).toBeEnabled());
    fireEvent.click(rename);
    fireEvent.change(await screen.findByRole("textbox", { name: "Name" }), {
      target: { value: "Ada corrected" },
    });
    await act(async () => {
      await router.navigate({
        to: "/people/$personId",
        params: { personId: Q },
      });
    });
    await waitFor(() =>
      expect(document.querySelector("[data-person-detail]")).toHaveAttribute(
        "data-person-detail",
        Q,
      ),
    );
    expect(document.querySelector("[data-rename-form]")).toBeNull();
    expect(w.built).toEqual([]);
    // Back on Ada, the typed name comes back on Ada only, and saves for Ada.
    await act(async () => {
      await router.navigate({
        to: "/people/$personId",
        params: { personId: P },
      });
    });
    const again = await screen.findByRole("button", {
      name: "Rename",
    });
    await waitFor(() => expect(again).toBeEnabled());
    fireEvent.click(again);
    expect(await screen.findByRole("textbox", { name: "Name" })).toHaveValue(
      "Ada corrected",
    );
    const form = document.querySelector("[data-rename-form]") as HTMLElement;
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(w.built).toHaveLength(1));
    expect(firstOfBatch(w)?.id).toBe(P);
  });

  test("the duplicates view of another person asks for THAT person's first page and shows none of the first person's hints", async () => {
    const w = peopleWorld();
    w.setCache([
      person({ id: P, label: "Ada" }),
      person({ id: Q, label: "Bob" }),
    ]);
    w.api.next.duplicates.push(
      {
        ok: true,
        value: {
          items: [person({ id: H, label: "Ada hint" })],
          next_after: null,
        },
      },
      { ok: true, value: { items: [], next_after: null } },
    );
    const { router } = await w.mount(`/people/${P}/duplicates`);
    await screen.findByText("Ada hint");
    await act(async () => {
      await router.navigate({
        to: "/people/$personId/duplicates",
        params: { personId: Q },
      });
    });
    await waitFor(() =>
      expect(document.querySelector("[data-duplicates]")).toHaveAttribute(
        "data-duplicates",
        Q,
      ),
    );
    await waitFor(() =>
      expect(
        w.api.calls
          .filter((c) => c.op === "readDuplicates")
          .map((c) => c.args[0]),
      ).toEqual([P, Q]),
    );
    expect(screen.queryByText("Ada hint")).toBeNull();
  });
});

describe("finding 4 (continued): a person's field steps", () => {
  test("the step of one person's fields is not carried to another person", async () => {
    const w = peopleWorld();
    w.setCache([
      person({ id: P, label: "Ada" }),
      person({ id: Q, label: "Bob" }),
      ...Array.from({ length: 150 }, (_, i) =>
        fieldRow({
          id: `bbbbbbbb-0000-4000-8000-${String(i).padStart(12, "0")}`,
          parent_id: P,
          label: `Ada field ${String(i).padStart(3, "0")}`,
        }),
      ),
      // Bob's fields sort BEFORE Ada's cursor: a step carried over would skip every one of them.
      ...Array.from({ length: 3 }, (_, i) =>
        fieldRow({
          id: `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, "0")}`,
          parent_id: Q,
          label: `Bob field ${i}`,
        }),
      ),
    ]);
    const { router } = await w.mount(`/people/${P}`);
    await screen.findByText("Ada field 000");
    fireEvent.click(screen.getByRole("button", { name: "Next fields" }));
    await screen.findByText("Ada field 149");
    await act(async () => {
      await router.navigate({
        to: "/people/$personId",
        params: { personId: Q },
      });
    });
    await screen.findByText("Bob field 0");
    expect(
      screen.queryByRole("button", { name: "Previous fields" }),
    ).toBeNull();
  });
});

describe("finding 5: a partial read is not a complete inventory", () => {
  test("a held change of a field on a LATER page, whose page is still loading, runs on a direct read of its own field", async () => {
    const w = heldWorld();
    for (let i = 0; i < 100; i += 1) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
      w.cache.set(id, fieldRow({ id, parent_id: P }));
    }
    const service = (
      w.env.serviceStore as unknown as {
        get(): {
          store: {
            watch(
              plan: { name: string },
              input: Record<string, unknown>,
            ): { get(): unknown };
          };
        };
      }
    ).get();
    const original = service.store.watch;
    service.store.watch = (
      plan: { name: string },
      input: Record<string, unknown>,
    ) => {
      const watch = original(plan, input);
      if (
        plan.name === "data.readResourceList" &&
        input.parentId === P &&
        input.after
      )
        return { ...watch, get: () => LOADING };
      return watch;
    };
    w.sharing.next.policy.push(
      ok({ version: 6, policy: HOME_VIEW }),
      ok({ version: 7, policy: PRIVATE }),
    );
    await w.mount(`/people/${P}`);
    await waitFor(() => expect(w.built).toHaveLength(1));
    expect(body(0, w)).toMatchObject({ expected_version: 4 });
    expect(heldRow()?.textContent ?? "").not.toMatch(/changed this field/);
  });
});

describe("finding 6: a held change is durable for its account", () => {
  async function holdOffline() {
    const w = peopleWorld({ online: false });
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
    // The audience was read on this page earlier (online); now the device is offline.
    peopleMemory(w.people.identity).policies.set(F, {
      version: 6,
      policy: HOME_VIEW,
      checkedAt: Date.now(),
    });
    await w.mount(`/people/${P}/fields/${F}`);
    const d = await dialog();
    fireEvent.change(within(d).getByRole("textbox", { name: "Value" }), {
      target: { value: "Inhaler" },
    });
    fireEvent.click(within(d).getByRole("radio", { name: "Only you" }));
    fireEvent.click(within(d).getByRole("button", { name: "Save" }));
    await within(d).findByText(
      "You're offline, so the audience can't change yet",
    );
    return { w, d };
  }

  test("'Hold as draft' writes the change, with the versions it began on, to the account's database (not page memory)", async () => {
    const { w, d } = await holdOffline();
    fireEvent.click(within(d).getByRole("button", { name: "Hold as draft" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(w.held()).toEqual([
      expect.objectContaining({
        fieldId: F,
        personId: P,
        value: { kind: "text", text: "Inhaler" },
        version: 4,
        expectedBase: 4,
        from: { version: 6, policy: HOME_VIEW },
        to: PRIVATE,
        status: { kind: "waiting" },
      }),
    ]);
    expect(w.built).toEqual([]);
  });

  // ADAPTATION (D1, decided 22 October 2026: "explicit Send now"): the earlier assertion ran the recovered hold by itself once online. Its
  // intent (the hold survives the page forgetting everything and runs on the confirmed audience) is kept; it now runs when the person
  // chooses "Send now", and sends nothing before that, online included.
  test("it survives the page forgetting everything (an account switch and back, a reload); online it waits for 'Send now', then runs", async () => {
    const { w, d } = await holdOffline();
    fireEvent.click(within(d).getByRole("button", { name: "Hold as draft" }));
    await waitFor(() => expect(w.held()).toHaveLength(1));
    cleanup();
    // Another account's page memory replaces this one's, then this account comes back (or the page reloads): nothing of the page remains.
    peopleMemory(`${ME}-other:1`);
    forgetAllPeopleMemory();
    await w.mount(`/people/${P}`);
    await waitFor(() => expect(heldRow()).not.toBeNull());
    expect(w.built).toEqual([]);
    w.sharing.next.policy.push(
      ok({ version: 6, policy: HOME_VIEW }),
      ok({ version: 7, policy: PRIVATE }),
    );
    w.setOnline(true);
    await settle();
    expect(w.sharing.calls.filter((c) => c.op === "readPolicy")).toEqual([]);
    expect(w.built).toEqual([]);
    expect(heldRow()?.textContent ?? "").toContain(
      "Waiting to change who can see Note. Send it when you're ready.",
    );
    fireEvent.click(
      within(heldRow() as HTMLElement).getByRole("button", {
        name: "Send now",
      }),
    );
    await waitFor(() => expect(w.built).toHaveLength(1));
    expect(body(0, w)).toMatchObject({
      expected_version: 4,
      expected_policy_version: 7,
      value: { kind: "text", text: "Inhaler" },
    });
    await waitFor(() => expect(w.held()).toEqual([]));
  });

  test("a hold that could not be kept is never acknowledged: the editor stays open with the reason", async () => {
    for (const [answer, text] of [
      [
        "failed",
        "Couldn't keep this on the device. Try again, or save it now.",
      ],
      ["refused", "Saving isn't possible while signing out."],
    ] as const) {
      const { w, d } = await holdOffline();
      w.heldSaves.push(answer);
      fireEvent.click(within(d).getByRole("button", { name: "Hold as draft" }));
      await within(d).findByText(text);
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(w.held()).toEqual([]);
      cleanup();
      forgetAllPeopleMemory();
    }
  });

  test("a new hold of the same field replaces the earlier one once it is kept", async () => {
    const { w, d } = await holdOffline();
    w.putHeld(heldChange({ holdId: "bbbbbbbb-0000-4000-8000-000000000002" }));
    await settle();
    fireEvent.click(within(d).getByRole("button", { name: "Hold as draft" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(w.held()).toHaveLength(1));
    expect(w.held()[0]?.value).toEqual({ kind: "text", text: "Inhaler" });
  });

  test("run by one page at a time: while another page holds it, this page sends nothing", async () => {
    const w = heldWorld();
    // One run of the FIELD's holds at a time (review 2: a replacement hold has another id, the same field).
    w.heldElsewhere.add(`atlas-people-held:${ME}:${F}`);
    await w.mount(`/people/${P}`);
    await settle();
    expect(w.sharing.calls.filter((c) => c.op === "readPolicy")).toEqual([]);
    expect(w.built).toEqual([]);
    expect(heldRow()).not.toBeNull();
  });
});

describe("review 2, finding 2: a hold ends only when the store says so; a recovered hold waits for the person (D1)", () => {
  for (const failure of [false, true])
    test(`Discard of a waiting hold whose end ${failure ? "FAILS stays visible, says so, and is never sent after a reload" : "commits ends it (healthy control)"}`, async () => {
      const w = heldWorld(heldChange(), { authorised: false });
      await w.mount(`/people/${P}`);
      const row = await waitFor(() => heldRow() as HTMLElement);
      if (failure) w.heldEnds.push("failed");
      fireEvent.click(within(row).getByRole("button", { name: "Discard" }));
      if (!failure) {
        await waitFor(() => expect(w.held()).toEqual([]));
        await said("The held change to Note was discarded. Nothing was sent.");
        return;
      }
      await waitFor(() =>
        expect(heldRow()?.textContent ?? "").toContain(
          "Couldn't discard it on this device. It's still kept. Try again.",
        ),
      );
      expect(w.held()).toHaveLength(1);
      expect(
        document.querySelector("[aria-live]")?.textContent ?? "",
      ).not.toContain("was discarded");
      // The page is gone (a reload, fresh memory) and the device is online: the surviving copy is shown and sends nothing by itself.
      cleanup();
      forgetAllPeopleMemory();
      w.sharing.next.policy.push(
        ok({ version: 6, policy: HOME_VIEW }),
        ok({ version: 7, policy: PRIVATE }),
      );
      await w.mount(`/people/${P}`);
      await waitFor(() => expect(heldRow()).not.toBeNull());
      await settle();
      expect(w.sharing.calls.filter((c) => c.op === "readPolicy")).toEqual([]);
      expect(w.sharing.sent).toEqual([]);
      expect(w.built).toEqual([]);
      expect(
        within(heldRow() as HTMLElement).queryByRole("button", {
          name: "Send now",
        }),
      ).not.toBeNull();
    });

  test("a recovered hold online and writable: nothing is read or sent until 'Send now' (control: the page's own hold runs)", async () => {
    const recovered = heldWorld(heldChange(), { authorised: false });
    await recovered.mount(`/people/${P}`);
    await waitFor(() => expect(heldRow()).not.toBeNull());
    await settle();
    expect(recovered.sharing.calls).toEqual([]);
    expect(recovered.built).toEqual([]);
    cleanup();
    forgetAllPeopleMemory();
    const own = heldWorld();
    own.sharing.next.policy.push(
      ok({ version: 6, policy: HOME_VIEW }),
      ok({ version: 7, policy: PRIVATE }),
    );
    await own.mount(`/people/${P}`);
    await waitFor(() => expect(own.built).toHaveLength(1));
  });

  test("a Discard while it runs whose end FAILS: the row stays with the reason, and it does not run again by itself", async () => {
    const w = heldWorld();
    const read = deferred<unknown>();
    w.sharing.next.policy.push(() => read.promise as never);
    await w.mount(`/people/${P}`);
    await waitFor(() =>
      expect(w.sharing.calls.filter((c) => c.op === "readPolicy")).toHaveLength(
        1,
      ),
    );
    w.heldEnds.push("failed");
    fireEvent.click(
      within(heldRow() as HTMLElement).getByRole("button", { name: "Discard" }),
    );
    await act(async () => read.release(ok({ version: 6, policy: HOME_VIEW })));
    await waitFor(() =>
      expect(heldRow()?.textContent ?? "").toContain(
        "Couldn't discard it on this device. It's still kept. Try again.",
      ),
    );
    await settle();
    expect(w.sharing.sent).toEqual([]);
    expect(w.built).toEqual([]);
    expect(w.held()).toHaveLength(1);
    expect(w.sharing.calls.filter((c) => c.op === "readPolicy")).toHaveLength(
      1,
    );
  });

  test("Discard of a hold another page moved on: refused (`changed`), said so, and nothing is announced as discarded", async () => {
    const w = heldWorld(heldChange(), { authorised: false });
    await w.mount(`/people/${P}`);
    const row = await waitFor(() => heldRow() as HTMLElement);
    // Another page wrote another state of it (its live list here has not caught up).
    const key = [...w.copies.keys()][0] as string;
    const stored = w.copies.get(key) as FormRecoveryRow;
    w.copies.set(key, { ...stored, content_digest: "moved-elsewhere" });
    fireEvent.click(within(row).getByRole("button", { name: "Discard" }));
    await waitFor(() =>
      expect(heldRow()?.textContent ?? "").toContain(
        "This held change was updated in another window.",
      ),
    );
    expect(w.held()).toHaveLength(1);
  });
});

describe("review 2, finding 2 (native WebKit E-P6, 22 October 2026): a run that finds the field's lock taken looks again when it is let go", () => {
  test("the lock is held (another page's run, or this page's replacement of an earlier hold) while the page goes online: nothing is sent, then the run follows the release", async () => {
    const w = heldWorld();
    const lock = `atlas-people-held:${ME}:${F}`;
    w.heldElsewhere.add(lock);
    w.sharing.next.policy.push(
      ok({ version: 6, policy: HOME_VIEW }),
      ok({ version: 7, policy: PRIVATE }),
    );
    await w.mount(`/people/${P}`);
    await waitFor(() => expect(heldRow()).not.toBeNull());
    await settle();
    expect(w.sharing.calls.filter((c) => c.op === "readPolicy")).toEqual([]);
    expect(w.built).toEqual([]);
    w.releaseElsewhere(lock);
    await waitFor(() => expect(w.built).toHaveLength(1));
    expect(w.sharing.sent).toHaveLength(1);
  });
});

describe("review 2, finding 4: held changes past any number of ended ones stay reachable", () => {
  // The real reader's crossing of terminal-only ranges is in tests/data/form-copies.test.ts; here the page's own continuation.
  test("more holds than one page: 'Show more held changes' reaches the rest, 'Back to the first' returns", async () => {
    const w = heldWorld(heldChange(), { authorised: false });
    // 120 holds of fields whose contexts sort before F's, so F's hold is on the second page.
    for (let i = 0; i < 120; i += 1) {
      const holdId = `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, "0")}`;
      w.putHeld(
        heldChange({ holdId, fieldId: `1-${String(i).padStart(3, "0")}` }),
      );
    }
    await w.mount(`/people/${P}`);
    await waitFor(() =>
      expect(
        document.querySelectorAll("[data-held-change]").length,
      ).toBeGreaterThan(0),
    );
    // 100 shown, and a way on; the 121st (the live one under F) is on the next page.
    expect(document.querySelectorAll("[data-held-change]")).toHaveLength(100);
    expect(heldRow()).toBeNull();
    const more = await waitFor(() => {
      const button = screen.queryByRole("button", {
        name: "Show more held changes",
      });
      expect(button).not.toBeNull();
      return button as HTMLElement;
    });
    fireEvent.click(more);
    await waitFor(() => expect(heldRow()).not.toBeNull());
    fireEvent.click(
      screen.getByRole("button", { name: "Back to the first held changes" }),
    );
    await waitFor(() => expect(heldRow()).toBeNull());
  });
});

describe("finding 7: every record stays reachable", () => {
  const people = (count: number) =>
    Array.from({ length: count }, (_, i) =>
      person({
        id: `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, "0")}`,
        label:
          i === count - 1
            ? "Tail person"
            : `Person ${String(i).padStart(4, "0")}`,
      }),
    );

  test("control: in a small list a search finds the last person at once", async () => {
    const w = peopleWorld();
    w.setCache(people(201));
    await w.mount("/people");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search people" }), {
      target: { value: "Tail person" },
    });
    await screen.findByRole("link", { name: /Tail person/ });
  });

  test("beyond a step's bound, search continues with 'Keep searching' and finds the last person", async () => {
    const w = peopleWorld();
    w.setCache(people(2101));
    await w.mount("/people");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search people" }), {
      target: { value: "Tail person" },
    });
    await screen.findByText(
      "No one matches “Tail person” so far. There are more people to check.",
    );
    expect(screen.queryByRole("link", { name: /Tail person/ })).toBeNull();
    await settle();
    expect(
      screen.queryByRole("button", { name: "Keep searching" }),
    ).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Keep searching" }));
    await screen.findByRole("link", { name: /Tail person/ });
  });

  test("browsing: 'Next people' moves a step at a time to the last person; 'Previous people' goes back", async () => {
    const w = peopleWorld();
    w.setCache(people(250));
    await w.mount("/people");
    await screen.findByRole("link", { name: /Person 0000/ });
    expect(screen.queryByRole("link", { name: /Tail person/ })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Next people" }),
    ).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Next people" }));
    await screen.findByRole("link", { name: /Person 0100/ });
    fireEvent.click(screen.getByRole("button", { name: "Next people" }));
    await screen.findByRole("link", { name: /Tail person/ });
    expect(screen.queryByRole("button", { name: "Next people" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Previous people" }));
    await screen.findByRole("link", { name: /Person 0100/ });
  });

  test("a person's fields beyond one step are reached with 'Next fields'", async () => {
    const w = peopleWorld();
    w.setCache([
      person({ id: P, label: "Ada" }),
      ...Array.from({ length: 150 }, (_, i) =>
        fieldRow({
          id: `bbbbbbbb-0000-4000-8000-${String(i).padStart(12, "0")}`,
          parent_id: P,
          label: `Field ${String(i).padStart(3, "0")}`,
        }),
      ),
    ]);
    await w.mount(`/people/${P}`);
    await screen.findByText("Field 000");
    expect(screen.queryByText("Field 149")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Next fields" }),
    ).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Next fields" }));
    await screen.findByText("Field 149");
    fireEvent.click(screen.getByRole("button", { name: "Previous fields" }));
    await screen.findByText("Field 000");
  });
});

// ---- review 3 of 22 October 2026 -----------------------------------------------------------------------------------------------------

describe("review 3, finding 1: leaving the page never discards a held change (H1, H2)", () => {
  test("navigating to the list while its first policy read is on its way: the hold is kept as held, nothing is sent, and it runs again back on the person", async () => {
    const w = heldWorld();
    const read = deferred<unknown>();
    w.sharing.next.policy.push(
      () => read.promise as never,
      ok({ version: 6, policy: HOME_VIEW }),
      ok({ version: 7, policy: PRIVATE }),
    );
    const { router } = await w.mount(`/people/${P}`);
    await waitFor(() =>
      expect(w.sharing.calls.filter((c) => c.op === "readPolicy")).toHaveLength(
        1,
      ),
    );
    await act(async () => {
      await router.navigate({ to: "/people" });
    });
    await waitFor(() => expect(heldRow()).toBeNull());
    await act(async () => read.release(ok({ version: 6, policy: HOME_VIEW })));
    await settle();
    expect(w.sharing.sent).toEqual([]);
    expect(w.built).toEqual([]);
    expect(w.held()).toEqual([
      expect.objectContaining({
        holdId: HOLD,
        value: { kind: "text", text: "Secret held text" },
        to: PRIVATE,
        retired: false,
        queued: false,
      }),
    ]);
    await act(async () => {
      await router.navigate({
        to: "/people/$personId",
        params: { personId: P },
      });
    });
    // Its authority is this page's (D1): back on the person, it runs, once.
    await waitFor(() => expect(w.built).toHaveLength(1));
    expect(w.sharing.sent).toHaveLength(1);
    await waitFor(() => expect(w.held()).toEqual([]));
  });

  test("control: an explicit Discard at the same moment ends it", async () => {
    const w = heldWorld();
    const read = deferred<unknown>();
    w.sharing.next.policy.push(() => read.promise as never);
    await w.mount(`/people/${P}`);
    await waitFor(() =>
      expect(w.sharing.calls.filter((c) => c.op === "readPolicy")).toHaveLength(
        1,
      ),
    );
    fireEvent.click(
      within(heldRow() as HTMLElement).getByRole("button", { name: "Discard" }),
    );
    await act(async () => read.release(ok({ version: 6, policy: HOME_VIEW })));
    await waitFor(() => expect(w.held()).toEqual([]));
    expect(w.sharing.sent).toEqual([]);
  });

  test("another page of held changes unmounts the running row: it is kept, and runs again when its page is shown", async () => {
    const w = heldWorld();
    // 120 recovered holds of fields whose contexts sort AFTER F's: F's hold is on the first page, the rest continue.
    for (let i = 0; i < 120; i += 1)
      w.putHeld(
        heldChange({
          holdId: `bbbbbbbb-0000-4000-8000-${String(i).padStart(12, "0")}`,
          fieldId: `9-${String(i).padStart(3, "0")}`,
        }),
      );
    const read = deferred<unknown>();
    w.sharing.next.policy.push(
      () => read.promise as never,
      ok({ version: 6, policy: HOME_VIEW }),
      ok({ version: 7, policy: PRIVATE }),
    );
    await w.mount(`/people/${P}`);
    await waitFor(() =>
      expect(w.sharing.calls.filter((c) => c.op === "readPolicy")).toHaveLength(
        1,
      ),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Show more held changes" }),
    );
    await waitFor(() => expect(heldRow()).toBeNull());
    await act(async () => read.release(ok({ version: 6, policy: HOME_VIEW })));
    await settle();
    expect(w.sharing.sent).toEqual([]);
    expect(w.held().find((h) => h.holdId === HOLD)).toMatchObject({
      value: { kind: "text", text: "Secret held text" },
      retired: false,
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Back to the first held changes" }),
    );
    await waitFor(() => expect(w.built).toHaveLength(1));
    expect(w.sharing.sent).toHaveLength(1);
  });
});

describe("review 3, finding 2: one current hold per field (H4)", () => {
  async function holdFromEditor(
    w: ReturnType<typeof peopleWorld>,
    text: string,
  ) {
    await w.mount(`/people/${P}/fields/${F}`);
    const d = await dialog();
    fireEvent.change(within(d).getByRole("textbox", { name: "Value" }), {
      target: { value: text },
    });
    fireEvent.click(within(d).getByRole("radio", { name: "Only you" }));
    fireEvent.click(within(d).getByRole("button", { name: "Save" }));
    await within(d).findByText(
      "You're offline, so the audience can't change yet",
    );
    fireEvent.click(within(d).getByRole("button", { name: "Hold as draft" }));
    return d;
  }
  function offlineWorld() {
    const w = peopleWorld({ online: false });
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
    peopleMemory(w.people.identity).policies.set(F, {
      version: 6,
      policy: HOME_VIEW,
      checkedAt: Date.now(),
    });
    return w;
  }

  test("the field's lock is taken (another page's save or run): 'Hold as draft' writes nothing, says why and keeps the edit open as typed", async () => {
    const w = offlineWorld();
    w.heldElsewhere.add(`atlas-people-held:${ME}:${F}`);
    const d = await holdFromEditor(w, "Typed while busy");
    await waitFor(() =>
      expect(
        within(d).queryByText(
          "Another change to this field is being saved or sent. Try again in a moment.",
        ),
      ).not.toBeNull(),
    );
    expect(w.held()).toEqual([]);
    expect(
      (within(d).getByRole("textbox", { name: "Value" }) as HTMLInputElement)
        .value,
    ).toBe("Typed while busy");
  });

  test("control: with the lock free, a later hold replaces the earlier one of the field (one live copy, the later generation)", async () => {
    const w = offlineWorld();
    w.putHeld(heldChange({ holdId: "hold-earlier", seq: 1 }));
    await holdFromEditor(w, "Later");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(w.held().map((h) => [h.value, h.seq])).toEqual([
      [{ kind: "text", text: "Later" }, 2],
    ]);
  });

  test("an earlier hold this page may run, kept beside a later one: online it is NOT run; it is retired as the later one's predecessor", async () => {
    const w = heldWorld(heldChange({ holdId: "hold-earlier", seq: 1 }));
    w.putHeld(heldChange({ holdId: "hold-later", seq: 2 }));
    await w.mount(`/people/${P}`);
    await waitFor(() =>
      expect(w.held().map((h) => h.holdId)).toEqual(["hold-later"]),
    );
    await said("A later held change to who can see Note replaced this one.");
    expect(w.sharing.calls.filter((c) => c.op === "readPolicy")).toEqual([]);
    expect(w.built).toEqual([]);
  });
});

describe("review 3: an unresolved attempt is kept on the device until checked (C3c, H8)", () => {
  const ATTEMPT = { key: "k-1", body: "[]" };
  const retired = () =>
    heldChange({
      attempt: ATTEMPT,
      retired: true,
      value: { kind: "text", text: "" },
    });

  test("after a reload (fresh page memory) the record is shown, never run; 'Check now' reads the policy once, says it was made, and ends it", async () => {
    const w = heldWorld(retired(), { authorised: false });
    w.sharing.next.policy.push(ok({ version: 7, policy: PRIVATE }));
    await w.mount(`/people/${P}`);
    const row = await waitFor(() => {
      const found = document.querySelector("[data-held-retired]");
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(row.textContent).toContain(
      "An earlier change to who can see Note may already have been made.",
    );
    await settle();
    expect(w.sharing.calls).toEqual([]);
    fireEvent.click(within(row).getByRole("button", { name: "Check now" }));
    await said("Checked: who can see Note was changed.");
    await waitFor(() => expect(w.held()).toEqual([]));
    expect(w.sharing.calls.map((c) => c.op)).toEqual(["readPolicy"]);
    expect(w.sharing.sent).toEqual([]);
  });

  test("'Check now' finds the policy still at the version the attempt was guarded by: it was not made; the record ends", async () => {
    const w = heldWorld(retired(), { authorised: false });
    w.sharing.next.policy.push(ok({ version: 6, policy: HOME_VIEW }));
    await w.mount(`/people/${P}`);
    const row = await waitFor(
      () => document.querySelector("[data-held-retired]") as HTMLElement,
    );
    fireEvent.click(within(row).getByRole("button", { name: "Check now" }));
    await said("Checked: who can see Note wasn't changed by it.");
    await waitFor(() => expect(w.held()).toEqual([]));
  });

  test("'Check now' finds another policy at a later version: it was not made (it never can be now); the record ends", async () => {
    const w = heldWorld(retired(), { authorised: false });
    w.sharing.next.policy.push(
      ok({
        version: 8,
        policy: { grants: [], exclude_accounts: ["someone-else"] },
      }),
    );
    await w.mount(`/people/${P}`);
    const row = await waitFor(
      () => document.querySelector("[data-held-retired]") as HTMLElement,
    );
    fireEvent.click(within(row).getByRole("button", { name: "Check now" }));
    await said("Checked: who can see Note wasn't changed by it.");
    await waitFor(() => expect(w.held()).toEqual([]));
  });

  test("'Check now' that cannot read the policy keeps the record and says so; offline it needs a connection", async () => {
    const w = heldWorld(retired(), { authorised: false });
    w.sharing.next.policy.push({ ok: false, kind: "uncertain" } as never);
    await w.mount(`/people/${P}`);
    const row = await waitFor(
      () => document.querySelector("[data-held-retired]") as HTMLElement,
    );
    fireEvent.click(within(row).getByRole("button", { name: "Check now" }));
    await said("Couldn't check it now. Try again.");
    expect(w.held()).toHaveLength(1);
    w.setOnline(false);
    await waitFor(() =>
      expect(
        within(
          document.querySelector("[data-held-retired]") as HTMLElement,
        ).getByRole("button", { name: "Check now" }),
      ).toBeDisabled(),
    );
  });

  for (const kept of [true, false])
    test(`a direct change of the same audience in the editor ${kept ? "sends the kept attempt's key and body (the record on the device, not page memory)" : "control: with no record on the device, a new key"}`, async () => {
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
      const attempt = nextAttempt(
        null,
        [
          {
            kind: "replace_policy",
            id: F,
            expected_version: 6,
            policy: toWirePolicy(PRIVATE),
          },
        ],
        () => "k-durable",
      );
      if (kept) w.putHeld(heldChange({ attempt, retired: true }));
      w.sharing.next.policy.push(
        ok({ version: 6, policy: HOME_VIEW }),
        ok({ version: 6, policy: HOME_VIEW }),
        ok({ version: 7, policy: PRIVATE }),
      );
      await w.mount(`/people/${P}/fields/${F}`);
      const d = await dialog();
      await within(d).findByRole("radio", {
        name: "Home · can view",
        checked: true,
      });
      fireEvent.click(within(d).getByRole("radio", { name: "Only you" }));
      fireEvent.click(within(d).getByRole("button", { name: "Save" }));
      await waitFor(() => expect(w.sharing.sent).toHaveLength(1));
      if (kept) expect(w.sharing.sent[0]?.key).toBe("k-durable");
      else expect(w.sharing.sent[0]?.key).not.toBe("k-durable");
    });
});

describe("review 3, finding 3: a field's audience is never named from a policy known to be old (C6, A1, A2)", () => {
  async function shown(options: {
    read: number;
    cached: number;
    floor?: number;
    online?: boolean;
  }) {
    const w = peopleWorld({ online: options.online ?? false });
    w.setCache([
      person({ id: P, label: "Ada" }),
      fieldRow({
        id: F,
        parent_id: P,
        label: "Note",
        version: 4,
        policy_version: options.cached,
      }),
    ]);
    w.env.setDefaults(record());
    const memory = peopleMemory(w.people.identity);
    memory.policies.set(F, {
      version: options.read,
      policy: PRIVATE,
      checkedAt: Date.parse("2026-10-22T09:41:00Z"),
    });
    if (options.floor !== undefined)
      memory.summaryFloors.set(F, { version: 4, policyVersion: options.floor });
    await w.mount(`/people/${P}`);
    const button = await waitFor(() => {
      const found = document.querySelector(
        `[data-field-row="${F}"] [data-people-action="field-audience"]`,
      );
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    return { w, button };
  }

  test("the reviewer's case: a read at policy version 6, the cached field at 7, offline: never 'Only you'", async () => {
    const { button } = await shown({ read: 6, cached: 7 });
    expect(button.textContent).toBe("Who can see it?");
    expect(document.querySelector("[data-field-checked]")).toBeNull();
  });

  test("control: the read IS the cached version: its audience, said with when it was read (never as live)", async () => {
    const { button } = await shown({ read: 6, cached: 6 });
    expect(button.textContent).toBe("Only you");
    expect(
      document.querySelector("[data-field-checked]")?.textContent ?? "",
    ).toMatch(/^Checked at /);
  });

  test("a later policy version a summary applied (the floor) also makes the read old", async () => {
    const { button } = await shown({ read: 6, cached: 6, floor: 7 });
    expect(button.textContent).toBe("Who can see it?");
  });

  test("a read AHEAD of a lagging cache (this page's own confirmed change) is kept", async () => {
    const { button } = await shown({ read: 8, cached: 7 });
    expect(button.textContent).toBe("Only you");
  });

  test("closing the shared policy editor (which may have changed it) withdraws the page's own read until it is read again", async () => {
    const { button } = await shown({ read: 6, cached: 6 });
    expect(button.textContent).toBe("Only you");
    fireEvent.click(button);
    const editor = await screen.findByRole("dialog");
    fireEvent.keyDown(editor, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() =>
      expect(
        document.querySelector(
          `[data-field-row="${F}"] [data-people-action="field-audience"]`,
        )?.textContent,
      ).toBe("Who can see it?"),
    );
  });

  test("a policy version published while the page shows the read (sync) withdraws it at once, without a new read", async () => {
    const { w, button } = await shown({ read: 6, cached: 6 });
    expect(button.textContent).toBe("Only you");
    w.putCache(
      fieldRow({
        id: F,
        parent_id: P,
        label: "Note",
        version: 4,
        policy_version: 7,
      }),
    );
    await waitFor(() =>
      expect(
        document.querySelector(
          `[data-field-row="${F}"] [data-people-action="field-audience"]`,
        )?.textContent,
      ).toBe("Who can see it?"),
    );
  });
});
