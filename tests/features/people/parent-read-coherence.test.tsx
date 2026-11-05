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
import type { HeldChange } from "../../../src/features/people/field/held-store";
import {
  forgetAllPeopleMemory,
  peopleMemory,
} from "../../../src/features/people/memory";
import { forgetRefusedPolicies } from "../../../src/features/sharing/api";
import { POLICY_ABSENT } from "../../../src/features/sharing/copy";
import { installMatchMedia } from "../../helpers/match-media";
import { draftRow } from "../../support/data/rows";
import { fieldRow, peopleWorld, person } from "../../support/people/world";

/**
 * WEB-11a review 16, R16.1 (PPL-5 / A14) and the design assessment's DA16-S1: whatever is shown of a field (its value, label, archival, a
 * held change, its sharing dialog) is admitted only with evidence from the SAME read that its person is visible. The schedules hold one read
 * at its last answer (`freezeReads`: a live query that has not delivered the commit yet) while another delivers it, in both orders, and
 * record EVERY rendered state from the commit on: eventual removal does not excuse a disclosure. Each adverse schedule has a visible-person
 * control that shows the new content. FIXTURE evidence (jsdom, the People world): the native order is E-P40's.
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
const F = "88888888-8888-4888-8888-888888888888";
const G = "99999999-9999-4999-8999-999999999999";
const O = "77777777-7777-4777-8777-777777777777";
const SECRET = "Newly delivered secret";
const MERGED = "data.readMerged";
const UNDER = "data.readMergedUnder";
const CHILD = "data.readChildPage";
const CHAIN = "data.readOutstandingCreates";
const tick = () => act(() => new Promise((r) => setTimeout(r, 0)));
const ofP = (input: Record<string, unknown>) =>
  input.id === P || input.parentId === P;

/** Every rendered text from now on, until `stop`. */
function observe() {
  const texts: string[] = [document.body.textContent ?? ""];
  const observer = new MutationObserver(() =>
    texts.push(document.body.textContent ?? ""),
  );
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
  });
  return {
    ever: (text: string) => texts.some((t) => t.includes(text)),
    stop: () => observer.disconnect(),
  };
}

const mo = () => person({ id: P, label: "Mo" });
const phone = (over: Parameters<typeof fieldRow>[0] = {}) =>
  fieldRow({
    id: F,
    parent_id: P,
    label: "Phone",
    value: { kind: "text", text: "Old value" },
    version: 2,
    policy_version: 1,
    ...over,
  });
const putUpdate = (
  id: string,
  label: string,
  over: Partial<DraftWithCommand> = {},
) =>
  draftRow({
    local_id: `u-${label}`,
    created_seq: 7,
    endpoint: "/task-commands",
    command: {
      command: {
        kind: "put_field",
        id,
        parent_id: P,
        label,
        value: { kind: "text", text: label },
        expected_version: 2,
      },
    },
    target_resource_ids: [id],
    index_targets: [id],
    ...over,
  });

describe("R16.1 person detail: a field shown only with its person from the same read (DA16-03, DA16-05, DA16-06)", () => {
  for (const removed of [true, false])
    for (const change of ["a new field", "a changed value"] as const)
      test(`child page first, the person's read still at its earlier answer: ${change} ${removed ? "of a removed person is never shown" : "(control: visible person) is shown"}`, async () => {
        const w = peopleWorld({ online: false });
        w.setCache([mo(), phone()]);
        await w.mount(`/people/${P}`);
        await screen.findByText("Old value");
        w.freezeReads(MERGED, ofP);
        w.freezeReads(CHAIN);
        const seen = observe();
        const next =
          change === "a new field"
            ? [
                phone(),
                fieldRow({
                  id: G,
                  parent_id: P,
                  label: "New",
                  value: { kind: "text", text: SECRET },
                }),
              ]
            : [phone({ value: { kind: "text", text: SECRET }, version: 3 })];
        w.setCache(removed ? next : [mo(), ...next]);
        await tick();
        await tick();
        if (!removed) {
          expect(await screen.findByText(SECRET)).toBeInTheDocument();
          seen.stop();
          return;
        }
        // The removal is evidence: nothing of the person's fields stays, not even the value shown before.
        expect(screen.queryByText("Old value")).toBeNull();
        w.thawReads();
        await tick();
        seen.stop();
        expect(seen.ever(SECRET)).toBe(false);
      });

  test("the person's read first, the child page still at its earlier answer: the detail goes, nothing new is shown", async () => {
    const w = peopleWorld({ online: false });
    w.setCache([mo(), phone()]);
    await w.mount(`/people/${P}`);
    await screen.findByText("Old value");
    w.freezeReads(CHILD);
    const seen = observe();
    w.setCache([phone({ value: { kind: "text", text: SECRET }, version: 3 })]);
    await waitFor(() =>
      expect(
        document.querySelector('[data-people-state="not-on-device"]'),
      ).not.toBeNull(),
    );
    w.thawReads();
    await tick();
    seen.stop();
    expect(seen.ever(SECRET)).toBe(false);
    expect(screen.queryByText("Old value")).toBeNull();
  });

  for (const removed of [true, false])
    test(`an unsent field created in another page, read from a state ${removed ? "without the person, is never shown under the person's earlier read" : "with the person (control), is shown"} (DA16-05)`, async () => {
      const w = peopleWorld({ online: false });
      w.setCache([mo(), phone()]);
      await w.mount(`/people/${P}`);
      await screen.findByText("Old value");
      // The person's and the field page's reads have not delivered the commit; the outstanding drafts' read has, with a field created in
      // another page of this device (a projected row: the cache does not hold it). A cached field's own unsent changes are read WITH it.
      w.freezeReads(MERGED, ofP);
      w.freezeReads(CHILD);
      const seen = observe();
      w.setCache(removed ? [phone()] : [mo(), phone()]);
      w.setDrafts([
        draftRow({
          local_id: "create-g",
          created_seq: 9,
          endpoint: "/task-commands",
          command: {
            command: {
              kind: "put_field",
              id: G,
              parent_id: P,
              label: "Typed elsewhere",
              value: { kind: "text", text: SECRET },
            },
          },
          target_resource_ids: [G],
          index_targets: [G],
        }),
      ]);
      await tick();
      await tick();
      if (!removed) {
        await waitFor(() => expect(screen.queryByText(SECRET)).not.toBeNull());
        seen.stop();
        return;
      }
      w.thawReads();
      await tick();
      seen.stop();
      expect(seen.ever(SECRET)).toBe(false);
    });

  for (const removed of [true, false])
    test(`a cached field's unsent change is read WITH the field and its person: ${removed ? "never shown once the person is gone" : "shown under the visible person (control)"} (DA16-05)`, async () => {
      const w = peopleWorld({ online: false });
      w.setCache([mo(), phone()]);
      await w.mount(`/people/${P}`);
      await screen.findByText("Old value");
      w.freezeReads(MERGED, ofP);
      w.freezeReads(CHAIN);
      const seen = observe();
      w.setCache(removed ? [phone()] : [mo(), phone()]);
      w.setDrafts([putUpdate(F, SECRET)]);
      await tick();
      await tick();
      if (!removed) {
        // The change's label and value.
        await waitFor(() =>
          expect(screen.queryAllByText(SECRET)).toHaveLength(2),
        );
        seen.stop();
        return;
      }
      w.thawReads();
      await tick();
      seen.stop();
      expect(seen.ever(SECRET)).toBe(false);
    });

  for (const removed of [true, false])
    test(`a field page read ${removed ? "WITHOUT the person withdraws this device's own unsent field shown before" : "with the person (control) keeps it"} (DA16-03, invariant 4)`, async () => {
      const w = peopleWorld({ online: false });
      w.setCache([mo(), phone()]);
      w.setDrafts([
        draftRow({
          local_id: "create-g",
          created_seq: 9,
          endpoint: "/task-commands",
          command: {
            command: {
              kind: "put_field",
              id: G,
              parent_id: P,
              label: "Typed before",
              value: { kind: "text", text: "Unsent before the removal" },
            },
          },
          target_resource_ids: [G],
          index_targets: [G],
        }),
      ]);
      await w.mount(`/people/${P}`);
      await screen.findByText("Unsent before the removal");
      // The person's read and the drafts' read keep their earlier answers; the field page delivers the commit.
      w.freezeReads(MERGED, ofP);
      w.freezeReads(CHAIN);
      w.setCache(removed ? [phone()] : [mo(), phone()]);
      await tick();
      await tick();
      if (removed)
        await waitFor(() =>
          expect(screen.queryByText("Unsent before the removal")).toBeNull(),
        );
      else
        expect(screen.queryByText("Unsent before the removal")).not.toBeNull();
      expect(screen.queryByText("No fields yet.")).toBeNull();
    });

  test("a person only this device creates: its own unsent field is shown; a cached field under the same id is never (DA16-06)", async () => {
    const w = peopleWorld({ online: false });
    w.setCache([
      fieldRow({
        id: O,
        parent_id: P,
        label: "Orphan",
        value: { kind: "text", text: "Retained orphan value" },
      }),
    ]);
    w.setDrafts([
      draftRow({
        local_id: "create-p",
        created_seq: 1,
        command: {
          commands: [{ kind: "create_person", id: P, name: "Mo" }],
        },
        target_resource_ids: [P],
        index_targets: [P],
      }),
      draftRow({
        local_id: "create-g",
        created_seq: 2,
        endpoint: "/task-commands",
        command: {
          command: {
            kind: "put_field",
            id: G,
            parent_id: P,
            label: "Unsent",
            value: { kind: "text", text: "Unsent value" },
          },
        },
        target_resource_ids: [G],
        index_targets: [G],
      }),
    ]);
    await w.mount(`/people/${P}`);
    expect(await screen.findByText("Unsent value")).toBeInTheDocument();
    expect(screen.queryByText("Retained orphan value")).toBeNull();
  });

  test("a person whose later step of fields is read without them: the step shows nothing (DA16-07)", async () => {
    const w = peopleWorld({ online: false });
    w.setCache([
      mo(),
      ...Array.from({ length: 101 }, (_, n) =>
        fieldRow({
          id: `66666666-6666-4666-8666-${String(n + 1).padStart(12, "0")}`,
          parent_id: P,
          label: `Field ${n + 1}`,
          value: { kind: "text", text: `Value ${n + 1}` },
        }),
      ),
    ]);
    await w.mount(`/people/${P}`);
    fireEvent.click(await screen.findByRole("button", { name: "Next fields" }));
    expect(await screen.findByText("Value 101")).toBeInTheDocument();
    w.freezeReads(MERGED, ofP);
    w.freezeReads(CHAIN);
    w.setCache(
      Array.from({ length: 101 }, (_, n) =>
        fieldRow({
          id: `66666666-6666-4666-8666-${String(n + 1).padStart(12, "0")}`,
          parent_id: P,
          label: `Field ${n + 1}`,
          value: { kind: "text", text: n === 100 ? SECRET : `Value ${n + 1}` },
        }),
      ),
    );
    await waitFor(() => expect(screen.queryByText("Value 101")).toBeNull());
    expect(screen.queryByText(SECRET)).toBeNull();
  });
});

describe("R16.1 held changes: read with their person (DA16-09)", () => {
  const held = (over: Partial<HeldChange> = {}): HeldChange => ({
    holdId: "bbbbbbbb-0000-4000-8000-000000000001",
    fieldId: F,
    personId: P,
    label: "Phone",
    value: { kind: "text", text: SECRET },
    sameKind: true,
    version: 2,
    expectedBase: 2,
    predecessor: null,
    from: { version: 1, policy: { grants: [], exclude_accounts: [] } },
    to: { grants: [], exclude_accounts: [] },
    attempt: null,
    status: { kind: "waiting" },
    heldAt: "2026-10-13T09:00:00.000Z",
    rev: 0,
    queued: false,
    seq: 0,
    retired: false,
    legacy: false,
    ...over,
  });

  for (const removed of [true, false])
    test(`a change held in another page after the commit that ${removed ? "removed the person is never listed under the person's earlier read" : "kept the person (control) is listed"}`, async () => {
      const w = peopleWorld({ online: false });
      w.setCache([mo(), phone()]);
      await w.mount(`/people/${P}`);
      await screen.findByText("Old value");
      w.freezeReads(MERGED, ofP);
      w.freezeReads(CHAIN);
      w.freezeReads(CHILD);
      const seen = observe();
      w.setCache(removed ? [phone()] : [mo(), phone()]);
      w.putHeld(held({ label: removed ? "Removed person's hold" : "Phone" }));
      peopleMemory(w.people.identity).heldAuthority.clear();
      await tick();
      await tick();
      seen.stop();
      if (removed) expect(seen.ever("Removed person's hold")).toBe(false);
      else
        await waitFor(() =>
          expect(document.querySelector(`[data-held-change]`)).not.toBeNull(),
        );
    });
});

describe("R16.1 archived items: a field listed only with its person from the same read (DA16-03, DA16-05, DA16-07)", () => {
  for (const removed of [true, false])
    test(`an unsent archive of a field, read with ${removed ? "no person: never listed" : "its person (control): listed with the person's name"}`, async () => {
      const w = peopleWorld({ online: false });
      w.setCache(removed ? [phone()] : [mo(), phone()]);
      w.setDrafts([
        draftRow({
          local_id: "archive-f",
          created_seq: 3,
          command: {
            command: {
              kind: "archive",
              id: F,
              expected_version: 2,
              archived: true,
            },
          },
          target_resource_ids: [F],
          index_targets: [F],
        }),
      ]);
      const seen = observe();
      await w.mount("/settings/archived");
      await screen.findByRole("heading", { level: 1, name: "Archived items" });
      if (removed) {
        await waitFor(() =>
          expect(screen.queryByText(/Nothing archived/)).not.toBeNull(),
        );
        seen.stop();
        expect(seen.ever("Phone")).toBe(false);
      } else {
        await waitFor(() =>
          expect(screen.queryByText("Phone · Mo")).not.toBeNull(),
        );
        seen.stop();
      }
    });

  test("100 archived fields of a person not on this device never keep a later visible one out of reach, nor say 'Nothing archived'", async () => {
    const w = peopleWorld({ online: false });
    w.setCache([
      person({ id: G, label: "Bo" }),
      ...Array.from({ length: 100 }, (_, n) =>
        fieldRow({
          id: `66666666-6666-4666-8666-${String(n).padStart(12, "0")}`,
          parent_id: P,
          label: `Hidden ${n}`,
          archived: true,
        }),
      ),
      fieldRow({
        id: "77777777-7777-4777-8777-000000000001",
        parent_id: G,
        label: "Visible",
        archived: true,
      }),
    ]);
    const seen = observe();
    await w.mount("/settings/archived");
    expect(await screen.findByText("Visible · Bo")).toBeInTheDocument();
    seen.stop();
    expect(seen.ever("Nothing archived")).toBe(false);
    expect(seen.ever("Hidden 0")).toBe(false);
  });
});

describe("R16.1 field editor: the person and the field as one read (DA16-03, DA16-08)", () => {
  const dialog = () => screen.queryByRole("dialog");
  // The reviewer's values (Review 16's editor probe): a changed cached field is reviewed in the open editor ("Current: …").
  const contact = (over: Parameters<typeof fieldRow>[0] = {}) =>
    fieldRow({
      id: F,
      parent_id: P,
      label: "Contact",
      value: { kind: "text", text: "Old visible value" },
      version: 1,
      policy_version: 1,
      ...over,
    });
  for (const order of [
    "visible",
    "child-first",
    "parent-first",
    "the editor's own read first",
  ] as const)
    test(`the field's newer value with the person ${order === "visible" ? "visible (control): reviewable" : `removed (${order}): never shown`}`, async () => {
      const w = peopleWorld({ online: false });
      w.setCache([mo(), contact()]);
      await w.mount(`/people/${P}/fields/${F}`);
      await screen.findByRole("dialog", { name: "Edit Contact" });
      if (order === "child-first") w.freezeReads(MERGED, ofP);
      if (order === "parent-first") w.freezeReads(UNDER);
      if (order === "the editor's own read first") {
        // Only the editor's person-and-field read delivers: the person's and the drafts' reads (the detail's and the editor's), and the
        // field page, keep their earlier answers (no other gate withdraws the editor first).
        w.freezeReads(MERGED, ofP);
        w.freezeReads(CHAIN);
        w.freezeReads(CHILD);
      }
      const seen = observe();
      const changed = contact({
        version: 2,
        value: { kind: "text", text: SECRET },
      });
      w.setCache(order === "visible" ? [mo(), changed] : [changed]);
      await tick();
      await tick();
      if (order === "visible") {
        await waitFor(() => expect(dialog()?.textContent).toContain(SECRET));
        seen.stop();
        return;
      }
      w.thawReads();
      await tick();
      seen.stop();
      expect(seen.ever(SECRET)).toBe(false);
    });

  for (const removed of [true, false])
    test(`the editor's own read of the unsent changes, newer than its person-and-field read and the detail's: ${removed ? "read without the person, shows nothing new" : "with the person (control), shows the newer save's name"}`, async () => {
      const w = peopleWorld({ online: false });
      w.setCache([mo(), contact()]);
      await w.mount(`/people/${P}/fields/${F}`);
      await screen.findByRole("dialog", { name: "Edit Contact" });
      // Every read keeps its earlier answer but the EDITOR's read of the drafts (the later of the two such watches): the detail's own
      // read of the drafts would otherwise withdraw the editor with the detail.
      // The editor's watches are made after the detail's (each twice: React's development render): its drafts' reads are the ones made
      // after its person-and-field read.
      const editorReads = w.watches.findIndex((entry) => entry.plan === UNDER);
      expect(editorReads).toBeGreaterThan(0);
      expect(
        w.watches.some(
          (entry, number) => entry.plan === CHAIN && number > editorReads,
        ),
      ).toBe(true);
      w.freezeReads(MERGED, ofP);
      w.freezeReads(UNDER);
      w.freezeReads(CHILD);
      w.freezeReads(CHAIN, (_input, number) => number < editorReads);
      const seen = observe();
      w.setCache(removed ? [contact()] : [mo(), contact()]);
      w.setDrafts([
        putUpdate(F, SECRET, {
          command: {
            command: {
              kind: "put_field",
              id: F,
              parent_id: P,
              label: SECRET,
              value: { kind: "text", text: SECRET },
              expected_version: 1,
              expected_policy_version: 1,
            },
          },
        }),
      ]);
      await tick();
      await tick();
      seen.stop();
      if (removed) expect(seen.ever(SECRET)).toBe(false);
      else
        await waitFor(() =>
          expect(
            screen.queryByRole("dialog", { name: `Edit ${SECRET}` }),
          ).not.toBeNull(),
        );
    });

  for (const projected of [true, false])
    test(`a cached field under a person ${projected ? "only this device creates is never edited or shown in the editor" : "the cache holds (control) is edited"} (DA16-06)`, async () => {
      const w = peopleWorld({ online: false });
      w.setCache([
        ...(projected ? [] : [mo()]),
        fieldRow({
          id: O,
          parent_id: P,
          label: "Orphan",
          value: { kind: "text", text: "Retained orphan value" },
        }),
      ]);
      if (projected)
        w.setDrafts([
          draftRow({
            local_id: "create-p",
            created_seq: 1,
            command: {
              commands: [{ kind: "create_person", id: P, name: "Mo" }],
            },
            target_resource_ids: [P],
            index_targets: [P],
          }),
        ]);
      const seen = observe();
      await w.mount(`/people/${P}/fields/${O}`);
      await tick();
      await tick();
      seen.stop();
      if (projected) {
        expect(seen.ever("Retained orphan value")).toBe(false);
        expect(
          screen.queryByRole("dialog", { name: "Edit Orphan" }),
        ).toBeNull();
      } else
        expect(
          await screen.findByRole("dialog", { name: "Edit Orphan" }),
        ).toBeInTheDocument();
    });

  test("hidden is not discarded: the typed input is kept while the person is not shown and is there again when they return", async () => {
    const w = peopleWorld({ online: false });
    w.setCache([mo(), phone()]);
    await w.mount(`/people/${P}/fields/${F}`);
    const d = await screen.findByRole("dialog", { name: "Edit Phone" });
    fireEvent.change(within(d).getByRole("textbox", { name: "Value" }), {
      target: { value: "Typed while visible" },
    });
    w.setCache([phone()]);
    await waitFor(() => expect(dialog()).toBeNull());
    expect(w.built).toHaveLength(0);
    w.setCache([mo(), phone()]);
    const again = await screen.findByRole("dialog", { name: "Edit Phone" });
    expect(within(again).getByRole("textbox", { name: "Value" })).toHaveValue(
      "Typed while visible",
    );
    expect(w.built).toHaveLength(0);
  });
});

describe("DA16-S1: the shared sharing dialog of a field, embedded and at its deep link", () => {
  const titled = (text: string) =>
    screen.queryByRole("dialog", { name: `Sharing — ${text}` });

  test("embedded: the field changed and its person removed while the detail's reads lag: the dialog never names the new label", async () => {
    const w = peopleWorld({ online: true });
    w.setCache([mo(), phone()]);
    await w.mount(`/people/${P}`);
    const button = await waitFor(() => {
      const found = document.querySelector(
        `[data-field-row="${F}"] [data-people-action="field-audience"]`,
      );
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    fireEvent.click(button);
    await waitFor(() => expect(titled("Phone")).not.toBeNull());
    w.freezeReads(MERGED);
    w.freezeReads(CHILD);
    w.freezeReads(CHAIN);
    const seen = observe();
    w.setCache([phone({ label: "Renamed secret label", version: 3 })]);
    await waitFor(() =>
      expect(screen.queryByText(POLICY_ABSENT)).not.toBeNull(),
    );
    seen.stop();
    expect(seen.ever("Renamed secret label")).toBe(false);
  });

  for (const held of [false, true])
    test(`deep link /sharing/items/<field> with the person ${held ? "on this device (control): named, its policy read" : "not on this device: nothing named, no policy read"}`, async () => {
      const w = peopleWorld({ online: true });
      w.setCache(held ? [mo(), phone()] : [phone()]);
      await w.mount(`/sharing/items/${F}`);
      if (held) {
        await waitFor(() => expect(titled("Phone")).not.toBeNull());
        await waitFor(() =>
          expect(w.sharing.calls.some((c) => c.op === "readPolicy")).toBe(true),
        );
        return;
      }
      await waitFor(() =>
        expect(screen.queryByText(POLICY_ABSENT)).not.toBeNull(),
      );
      expect(document.body.textContent).not.toContain("Phone");
      expect(w.sharing.calls.some((c) => c.op === "readPolicy")).toBe(false);
    });

  test("control: a resource with no parent (a person) is named at its deep link", async () => {
    const w = peopleWorld({ online: true });
    w.setCache([mo()]);
    await w.mount(`/sharing/items/${P}`);
    await waitFor(() => expect(titled("Mo")).not.toBeNull());
  });

  test("a policy read answering after the person was removed never opens the editing view", async () => {
    const w = peopleWorld({ online: true });
    w.setCache([mo(), phone()]);
    let answer!: (value: unknown) => void;
    w.sharing.next.policy.push(
      () =>
        new Promise((resolve) => {
          answer = resolve as (value: unknown) => void;
        }) as never,
    );
    await w.mount(`/sharing/items/${F}`);
    await waitFor(() =>
      expect(w.sharing.calls.some((c) => c.op === "readPolicy")).toBe(true),
    );
    w.setCache([phone()]);
    await waitFor(() =>
      expect(screen.queryByText(POLICY_ABSENT)).not.toBeNull(),
    );
    await act(async () => {
      answer({
        ok: true,
        value: { version: 1, policy: { grants: [], exclude_accounts: [] } },
      });
    });
    await tick();
    expect(document.querySelector('[data-policy-state="editing"]')).toBeNull();
    expect(screen.queryByText(POLICY_ABSENT)).not.toBeNull();
  });
});
