import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { forgetAllPeopleMemory } from "../../../src/features/people/memory";
import { forgetRefusedPolicies } from "../../../src/features/sharing/api";
import { installMatchMedia } from "../../helpers/match-media";
import { ME } from "../../support/people/records";
import { peopleWorld, person } from "../../support/people/world";

/**
 * Review 20, R20.1 (A9, A10, Q21): a linkage read asked before an unlink never replaces the one asked after it. The header's rename,
 * unlink and Reload each ask a new read; the read answered last is not the one that counts — the read ASKED last is. Each answer is held
 * by the test and released at the step named; command versions are asserted, so the journey is the contract-valid one.
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
const header = () =>
  document.querySelector("[data-identity-header]") as HTMLElement;
const linkage = () =>
  header().querySelector("[data-linkage]")?.getAttribute("data-linkage");
const answer = (version: number, linked: string | null) => ({
  ok: true as const,
  value: {
    person: person({
      id: P,
      label: version === 1 ? "Kieran" : "Kieran L.",
      version,
    }),
    linked_account_id: linked,
  },
});
const commands = (w: ReturnType<typeof peopleWorld>) =>
  w.api.calls
    .filter((c) => c.op === "peopleCommand")
    .map((c) => {
      const { command } = c.args[1] as {
        command: { kind: string; expected_version: number };
      };
      return [command.kind, command.expected_version];
    });

/**
 * A linked self at version 1 is renamed (its read answers linked v2, held); Unlink at v1 conflicts (its read answers linked v2); Unlink
 * again at v2 succeeds (its read answers unlinked v3). `late` releases the rename's read before the second unlink, or after it.
 *
 * Adapted in review 25 (R25.1), assertions unchanged: the rename's v2 is no longer synced before Unlink is pressed. Once the page knows
 * v2 (the synced row, a summary), a v1 answer is not current, so no Unlink is offered on it at all and unlink@1 cannot be sent (that
 * schedule is "a synced newer version withdraws the v1 answer" below). Here the sync lags, as the read ordering under test needs.
 */
async function renamedThenUnlinked(late: boolean) {
  const w = peopleWorld();
  w.setCache([person({ id: P, label: "Kieran", version: 1 })]);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let asked = false;
  w.api.next.person.push(
    answer(1, ME),
    async () => {
      asked = true;
      await held;
      return answer(2, ME);
    },
    answer(2, ME),
    answer(3, null),
  );
  w.api.next.people.push(
    { ok: true, value: { revision: 2, person_id: P } },
    { ok: false, kind: "conflict" },
    async () => {
      w.setCache([person({ id: P, label: "Kieran L.", version: 3 })]);
      return { ok: true, value: { revision: 3, person_id: P } };
    },
  );
  await w.mount(`/people/${P}`);
  await waitFor(() => expect(linkage()).toBe("self"));
  fireEvent.click(within(header()).getByRole("button", { name: "Rename" }));
  fireEvent.change(within(header()).getByRole("textbox", { name: "Name" }), {
    target: { value: "Kieran L." },
  });
  fireEvent.click(within(header()).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(asked).toBe(true));
  await waitFor(() =>
    expect(header().querySelector("[data-rename-form]")).toBeNull(),
  );
  fireEvent.click(
    within(header()).getByRole("button", { name: "Unlink account" }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Unlink your account from this profile?",
  });
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Unlink account" }),
  );
  await within(dialog).findByText(
    "Someone else already changed this — reload and try again.",
  );
  await waitFor(() =>
    expect(w.people.memory.linkage.get(P)?.state).toMatchObject({
      known: true,
      version: 2,
      kind: "self",
    }),
  );
  if (!late)
    await act(async () => {
      release();
      await held;
    });
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Unlink account" }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(linkage()).toBe("unlinked"));
  if (late)
    await act(async () => {
      release();
      await held;
    });
  return w;
}

describe("rename, a conflicting unlink, then the unlink (DA20-08)", () => {
  for (const late of [false, true]) {
    test(`${late ? "the rename's read answers last" : "control, in order"}: unlinked at v3; no Unlink; commands rename@1, unlink@1, unlink@2`, async () => {
      const w = await renamedThenUnlinked(late);
      expect(commands(w)).toEqual([
        ["rename_profile", 1],
        ["unlink", 1],
        ["unlink", 2],
      ]);
      expect(linkage()).toBe("unlinked");
      expect(w.people.memory.linkage.get(P)?.state).toMatchObject({
        kind: "unlinked",
        version: 3,
      });
      expect(
        within(header()).queryByRole("button", { name: "Unlink account" }),
      ).toBeNull();
      expect(within(header()).getByText("Not linked to an account")).toBe(
        header().querySelector("[data-linkage]"),
      );
    });
  }
});

describe("after the unlink, an offline rename is the ordinary queued edit (DA20-09)", () => {
  for (const late of [false, true]) {
    test(`${late ? "the rename's read answers last" : "control, in order"}: Save is enabled offline and queues one content edit over v3; no rename_profile`, async () => {
      const w = await renamedThenUnlinked(late);
      w.setOnline(false);
      fireEvent.click(within(header()).getByRole("button", { name: "Rename" }));
      fireEvent.change(
        within(header()).getByRole("textbox", { name: "Name" }),
        { target: { value: "Kieran Lane" } },
      );
      const save = within(header()).getByRole("button", { name: "Save" });
      expect(save).toBeEnabled();
      fireEvent.click(save);
      await waitFor(() => expect(w.built).toHaveLength(1));
      expect(w.built[0]?.command).toEqual({
        commands: [
          {
            kind: "edit",
            id: P,
            expected_version: 3,
            expected_policy_version: 2,
            label: "Kieran Lane",
            value: "",
          },
        ],
      });
      expect(commands(w)).toEqual([
        ["rename_profile", 1],
        ["unlink", 1],
        ["unlink", 2],
      ]);
    });
  }
});

describe("Reload after a conflicting rename asks a new read each time", () => {
  for (const late of [false, true]) {
    test(`${late ? "the first Reload's read answers last" : "control, in order"}: the second Reload's answer stands`, async () => {
      const w = peopleWorld();
      w.setCache([person({ id: P, label: "Kieran", version: 1 })]);
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let asked = false;
      w.api.next.person.push(
        answer(1, ME),
        async () => {
          asked = true;
          await held;
          return answer(1, ME);
        },
        answer(2, null),
      );
      w.api.next.people.push({ ok: false, kind: "conflict" });
      await w.mount(`/people/${P}`);
      await waitFor(() => expect(linkage()).toBe("self"));
      fireEvent.click(within(header()).getByRole("button", { name: "Rename" }));
      fireEvent.change(
        within(header()).getByRole("textbox", { name: "Name" }),
        { target: { value: "Kieran L." } },
      );
      fireEvent.click(within(header()).getByRole("button", { name: "Save" }));
      fireEvent.click(
        await within(header()).findByRole("button", { name: "Reload" }),
      );
      await waitFor(() => expect(asked).toBe(true));
      if (!late)
        await act(async () => {
          release();
          await held;
        });
      fireEvent.click(within(header()).getByRole("button", { name: "Reload" }));
      await waitFor(() => expect(linkage()).toBe("unlinked"));
      if (late)
        await act(async () => {
          release();
          await held;
        });
      expect(
        w.api.calls.filter((c) => c.op === "readPerson").map((c) => c.args[0]),
      ).toEqual([P, P, P]);
      expect(commands(w)).toEqual([["rename_profile", 1]]);
      expect(linkage()).toBe("unlinked");
      expect(w.people.memory.linkage.get(P)?.state).toMatchObject({
        version: 2,
      });
    });
  }
});
