import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "vitest";
import * as copy from "../../../src/features/people/copy";
import { forgetAllPeopleMemory } from "../../../src/features/people/memory";
import { forgetRefusedPolicies } from "../../../src/features/sharing/api";
import { installMatchMedia } from "../../helpers/match-media";
import { HOME, record } from "../../support/people/records";
import { peopleWorld, person } from "../../support/people/world";

/**
 * Review 26's design assessment, DA26-06, for the third online caller (a new field shared with Home, `/task-access-commands`): a create
 * whose outcome is uncertain keeps the one-attempt-per-body rule. Tried again unchanged, it is the same key and byte-identical body. Its
 * Home policy is the one the editor shows NOW (R22: what is sent is what the explanation says), so a primary household changed since is a
 * new body under a new key — never the kept body of a household that is no longer Home. (A second create of the same id is refused by
 * the server, so it is never made twice.) Characterises the existing rule; review 26 changed nothing here.
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
const FLAT = "99999999-9999-4999-8999-999999999999";

/** The same defaults with another primary household ("Flat"). */
function flatRecord() {
  const home = record();
  return {
    ...home,
    snapshot: {
      ...home.snapshot,
      defaults: { ...home.snapshot.defaults, primary_household_id: FLAT },
      households: home.snapshot.households.map((h) => ({
        ...h,
        id: FLAT,
        name: "Flat",
      })),
    },
  };
}

async function uncertainCreate() {
  const w = peopleWorld();
  w.setCache([person({ id: P, label: "Ada" })]);
  w.env.setDefaults(record());
  const sent: Array<{ key: string; body: string }> = [];
  const putFieldShared = w.api.putFieldShared.bind(w.api);
  w.api.putFieldShared = (attempt) => {
    sent.push({ key: attempt.key, body: attempt.body });
    return putFieldShared(attempt);
  };
  w.api.next.shared.push({ ok: false, kind: "uncertain" });
  await w.mount(`/people/${P}/fields/new`);
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeNull());
  const d = screen.getByRole("dialog");
  fireEvent.change(within(d).getByRole("textbox", { name: "Name" }), {
    target: { value: "Phone" },
  });
  fireEvent.change(within(d).getByRole("textbox", { name: "Value" }), {
    target: { value: "0770" },
  });
  fireEvent.click(
    within(d).getByRole("radio", { name: copy.HOME_VIEW("Home") }),
  );
  fireEvent.click(within(d).getByRole("button", { name: copy.SAVE }));
  await waitFor(() =>
    expect(within(d).queryByText(copy.UNCERTAIN)).not.toBeNull(),
  );
  expect(sent).toHaveLength(1);
  return { w, d, sent };
}

const policyOf = (body: string | undefined) =>
  (JSON.parse(body ?? "{}") as { command: { initial_policy: unknown } }).command
    .initial_policy;

test("unchanged: Save again sends the same key and byte-identical body", async () => {
  const { d, sent } = await uncertainCreate();
  fireEvent.click(within(d).getByRole("button", { name: copy.SAVE }));
  await waitFor(() => expect(sent).toHaveLength(2));
  expect(sent[1]).toEqual(sent[0]);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

test("the primary household changed since: Save sends the policy the editor shows now, under a new key", async () => {
  const { w, d, sent } = await uncertainCreate();
  act(() => w.env.setDefaults(flatRecord()));
  await waitFor(() =>
    expect(
      within(d).queryByRole("radio", { name: copy.HOME_VIEW("Flat") }),
    ).not.toBeNull(),
  );
  fireEvent.click(
    within(d).getByRole("radio", { name: copy.HOME_VIEW("Flat") }),
  );
  fireEvent.click(within(d).getByRole("button", { name: copy.SAVE }));
  await waitFor(() => expect(sent).toHaveLength(2));
  expect(sent[1]?.key).not.toBe(sent[0]?.key);
  expect(policyOf(sent[0]?.body)).toMatchObject({
    grants: [{ kind: "household", id: HOME, edit: false }],
  });
  expect(policyOf(sent[1]?.body)).toMatchObject({
    grants: [{ kind: "household", id: FLAT, edit: false }],
  });
});
