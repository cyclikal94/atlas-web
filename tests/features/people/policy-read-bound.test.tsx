import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { Policy } from "../../../src/data";
import {
  forgetAllPeopleMemory,
  peopleMemory,
} from "../../../src/features/people/memory";
import {
  forgetRefusedPolicies,
  type SharingResult,
} from "../../../src/features/sharing/api";
import { installMatchMedia } from "../../helpers/match-media";
import { HOME, ME, MO, record } from "../../support/people/records";
import { fieldRow, peopleWorld, person } from "../../support/people/world";
import { ok } from "../../support/sharing/fake-api";

/**
 * Review 24, R24.1 (family people-policy-editor-return-coherence): the field editor asks a read again once per version a summary applied
 * ahead of its kept read, never on every answer. Its own file, so that a mutant asking on every answer shows here as a count: in the field
 * editor's file other cases answer reads at once below the synced version, and such a mutant storms them until the heap is exhausted.
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
const ORIGINAL: Policy = {
  grants: [{ kind: "household", id: HOME, edit: false }],
  exclude_accounts: [MO],
};
const EXCLUDED =
  "Mo is excluded from this field's sharing, so they won't see it.";
const CHANGED =
  "Who can see this field changed since you opened it. Check the change above before saving yours.";
type Answer = SharingResult<{ version: number; policy: Policy }>;
const summary = (version: number, excluded: number) => ({
  policy_version: version,
  audience: {
    disclosure: "complete" as const,
    in_home: true,
    households: [
      {
        id: HOME,
        can_edit: false,
        you_are_member: true,
        name: "Home",
        version: 1,
        member_count: 2,
      },
    ],
    your_direct_grant: null,
    direct_grant_count: 0,
    excluded_count: excluded,
  },
  effective: {
    disclosure: "partial" as const,
    account_count: null,
    limited_count: null,
  },
});
const noteOf = (d: HTMLElement) =>
  d.querySelector("[data-subject-note]")?.textContent ?? null;
const memory = () => peopleMemory(`${ME}:1`);

test("R24.1 a read answering below the summary's version revives nothing, and is not asked again in a loop", async () => {
  const w = peopleWorld();
  w.setCache([
    person({ id: P, label: "Mo" }),
    fieldRow({
      id: F,
      parent_id: P,
      label: "Note",
      version: 4,
      policy_version: 6,
    }),
  ]);
  w.api.linked.set(P, MO);
  w.env.setDefaults(record({ members: [ME, MO] }));
  w.sharing.defaults.households = ok(record().snapshot.households);
  w.sharing.defaults.policy = ok({ version: 6, policy: ORIGINAL });
  w.api.summary.fields.set(F, summary(6, 1));
  const asked: Array<{ fresh?: boolean } | undefined> = [];
  const read = w.sharing.readPolicy;
  w.sharing.readPolicy = (id, options) => {
    if (id === F) asked.push(options);
    return read(id, options);
  };
  await w.mount(`/people/${P}/fields/${F}`);
  const d = await screen.findByRole("dialog");
  await waitFor(() => expect(noteOf(d)).toBe(EXCLUDED));
  await waitFor(() =>
    expect(memory().summaryFloors.get(F)?.policyVersion).toBe(6),
  );
  fireEvent.change(within(d).getByRole("textbox", { name: "Value" }), {
    target: { value: "Unfinished input" },
  });
  const before = asked.length;
  // The read the summary asks is held, and so is any read asked again (never answered at once: a loop shows as a count, not a hang).
  let release: (answer: Answer) => void = () => undefined;
  w.sharing.next.policy.push(
    () =>
      new Promise<Answer>((resolve) => {
        release = resolve;
      }),
  );
  w.sharing.next.policy.push(() => new Promise<Answer>(() => undefined));
  w.api.summary.fields.set(F, summary(7, 0));
  act(() => memory().invalidateSummaries());
  await waitFor(() =>
    expect(memory().summaryFloors.get(F)?.policyVersion).toBe(7),
  );
  await waitFor(() => expect(asked.length).toBe(before + 1));
  await act(async () => {
    release(ok({ version: 6, policy: ORIGINAL }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const after = screen.getByRole("dialog");
  expect(noteOf(after)).toBeNull();
  expect(
    after.querySelector('[data-audience="unknown"]')?.textContent ?? null,
  ).toBe(CHANGED);
  expect(asked.length).toBe(before + 1);
  expect(memory().summaryFloors.get(F)?.policyVersion).toBe(7);
  expect(within(after).getByRole("textbox", { name: "Value" })).toHaveValue(
    "Unfinished input",
  );
  expect(w.built).toEqual([]);
});
