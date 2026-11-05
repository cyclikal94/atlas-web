import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type {
  PeopleResult,
  PersonDetailAnswer,
} from "../../../src/features/people/api";
import { forgetAllPeopleMemory } from "../../../src/features/people/memory";
import { forgetRefusedPolicies } from "../../../src/features/sharing/api";
import { installMatchMedia } from "../../helpers/match-media";
import { HOME, ME, MO, record } from "../../support/people/records";
import { peopleWorld, person } from "../../support/people/world";

/**
 * Review 25, R25.1 (A5, A9, A15, PPL-6, WF-PEOPLE-03): a linkage answer is current only while no later version of the person is known.
 * A summary (or the synced row) of a later version withdraws it AT ONCE from every consumer — the header's line, Rename, Unlink and the
 * field editor's subject note — and ONE read is asked for that version, shared by both; nothing is inferred while it is on its way, and
 * no command is sent by it. Every detail answer is released by the test; reads and commands are counted. The design assessment's
 * DA25-01/03/04/08/09/10 at the component level, with the production providers and route.
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
const ANNA = "66666666-6666-4666-8666-666666666666";
const NOTE = "Mo won't see this field unless you share it with them.";
const IN_HOME =
  "Mo is in Home, so this sharing includes them. They'll see it if they can also see this profile.";

type Answer = PeopleResult<PersonDetailAnswer>;
const detail = (version: number, linked: string | null): Answer => ({
  ok: true,
  value: {
    person: person({ id: P, label: "Mo", version }),
    linked_account_id: linked,
  },
});

/** A detail answer the test releases. */
function held(answer: Answer) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let asked = false;
  return {
    reply: async () => {
      asked = true;
      await gate;
      return answer;
    },
    asked: () => asked,
    release: async () => {
      await act(async () => {
        release();
        await gate;
      });
    },
  };
}

/** Mo, linked to `linked`, owns the profile; Home (ME and `members`) can edit it; the viewer's field default is Home view. */
function moWorld(linked: string | null = MO, members = [ME, MO]) {
  const w = peopleWorld();
  w.setCache([
    person({ id: P, label: "Mo", version: 1 }),
    person({ id: Q, label: "Quinn", version: 1 }),
  ]);
  w.api.linked.set(P, linked);
  w.env.setDefaults(
    record({ field: { kind: "primary_household", edit: false }, members }),
  );
  w.api.summary.persons.set(P, {
    owner: {
      account_id: MO,
      username: "mo",
      you: false,
      person: { id: P, label: "Mo" },
    },
    your_access: "edit",
    added_by_you: "no",
    audience: {
      disclosure: "partial",
      in_home: true,
      households: [
        {
          id: HOME,
          can_edit: true,
          you_are_member: true,
          name: "Home",
          version: 1,
          member_count: members.length,
        },
      ],
      your_direct_grant: null,
      direct_grant_count: null,
      excluded_count: null,
    },
  } as never);
  return w;
}

/** The summaries are read again and P's (and Q's) answer is admitted at `version`, as the page's freshness signals ask. */
async function summarise(
  w: ReturnType<typeof peopleWorld>,
  id: string,
  version: number,
  linked: string | null,
) {
  const kept = w.api.summary.persons.get(id) ?? {};
  w.api.summary.persons.set(id, {
    ...kept,
    version,
    linkage: linked === null ? "none" : linked === ME ? "you" : "other",
    linked_account_id: linked,
  } as never);
  act(() => w.people.memory.invalidateSummaries());
  await waitFor(() =>
    expect(w.people.memory.summaryFloors.get(id)?.version).toBe(version),
  );
}

const reads = (w: ReturnType<typeof peopleWorld>) =>
  w.api.calls.filter((c) => c.op === "readPerson" && c.args[0] === P).length;
const commands = (w: ReturnType<typeof peopleWorld>) =>
  w.api.calls.filter((c) => c.op === "peopleCommand");
const header = () =>
  document.querySelector("[data-identity-header]") as HTMLElement;
const linkage = () =>
  header().querySelector("[data-linkage]")?.getAttribute("data-linkage");
const note = (d: HTMLElement) =>
  d.querySelector("[data-subject-note]")?.textContent ?? null;
/** The props React rendered on `element` last: a handler of THAT render, called later as a press of it would be. */
const propsOf = (element: Element) =>
  Object.entries(element).find(([key]) =>
    key.startsWith("__reactProps$"),
  )?.[1] as Record<string, (...args: unknown[]) => unknown>;

async function newField(w: ReturnType<typeof peopleWorld>) {
  await w.mount(`/people/${P}/fields/new`);
  const d = await screen.findByRole("dialog");
  await waitFor(() => expect(note(d)).toBe(NOTE));
  fireEvent.change(within(d).getByRole("textbox", { name: "Value" }), {
    target: { value: "Unfinished input" },
  });
  return d;
}

describe("a later person version withdraws the linkage answer from every consumer (DA25-01, DA25-03)", () => {
  test("unlinked at v2 by a summary: the note and the header stop claiming v1 at once; one read; then 'Not linked'", async () => {
    const w = moWorld();
    const renewal = held(detail(2, null));
    w.api.next.person.push(detail(1, MO), renewal.reply);
    const d = await newField(w);
    expect(linkage()).toBe("other");
    expect(reads(w)).toBe(1);
    await summarise(w, P, 2, null);
    // The summary is admitted: nothing claims v1 now, while v2's own answer is on its way.
    expect(note(d)).toBeNull();
    expect(linkage()).toBe("unknown");
    expect(header().querySelector("[data-linkage]")?.textContent).toContain(
      "Checking…",
    );
    await waitFor(() => expect(renewal.asked()).toBe(true));
    expect(reads(w)).toBe(2);
    await renewal.release();
    await waitFor(() => expect(linkage()).toBe("unlinked"));
    expect(note(d)).toBeNull();
    // An unchanged summary read again asks nothing more.
    await summarise(w, P, 2, null);
    expect(reads(w)).toBe(2);
    expect(within(d).getByRole("textbox", { name: "Value" })).toHaveValue(
      "Unfinished input",
    );
    expect(w.built).toEqual([]);
    expect(w.sharing.sent).toEqual([]);
    expect(commands(w)).toEqual([]);
  });

  test("control: the same version read again keeps the answer, its promise and the input, and asks nothing", async () => {
    const w = moWorld();
    const d = await newField(w);
    await summarise(w, P, 1, MO);
    act(() => w.people.memory.invalidateSummaries());
    await waitFor(() =>
      expect(w.people.memory.summaries.size).toBeGreaterThan(0),
    );
    expect(note(d)).toBe(NOTE);
    expect(linkage()).toBe("other");
    expect(reads(w)).toBe(1);
    expect(within(d).getByRole("textbox", { name: "Value" })).toHaveValue(
      "Unfinished input",
    );
  });

  test("control: another person's later version changes nothing of Mo's", async () => {
    const w = moWorld();
    const d = await newField(w);
    await summarise(w, Q, 2, null);
    expect(note(d)).toBe(NOTE);
    expect(linkage()).toBe("other");
    expect(reads(w)).toBe(1);
  });

  test("still linked at v2: withdrawn while v2 is read, then the promise is current again (same subject, newer version)", async () => {
    const w = moWorld();
    const renewal = held(detail(2, MO));
    w.api.next.person.push(detail(1, MO), renewal.reply);
    const d = await newField(w);
    await summarise(w, P, 2, MO);
    expect(note(d)).toBeNull();
    await renewal.release();
    await waitFor(() => expect(note(d)).toBe(NOTE));
    expect(linkage()).toBe("other");
    expect(reads(w)).toBe(2);
  });

  test("the synced row's later version withdraws it too (no summary): one read, then current", async () => {
    const w = moWorld();
    const renewal = held(detail(2, null));
    w.api.next.person.push(detail(1, MO), renewal.reply);
    const d = await newField(w);
    act(() => w.putCache(person({ id: P, label: "Mo", version: 2 })));
    await waitFor(() => expect(note(d)).toBeNull());
    expect(linkage()).toBe("unknown");
    await waitFor(() => expect(renewal.asked()).toBe(true));
    await renewal.release();
    await waitFor(() => expect(linkage()).toBe("unlinked"));
    expect(reads(w)).toBe(2);
    expect(commands(w)).toEqual([]);
  });

  test("the editor's own read of the person is ahead of the header's: the editor withdraws its note and asks the read itself", async () => {
    const w = moWorld();
    const renewal = held(detail(2, null));
    w.api.next.person.push(detail(1, MO), renewal.reply);
    const { router } = await w.mount(`/people/${P}`);
    await waitFor(() => expect(linkage()).toBe("other"));
    // The header's live reads of the person keep answering v1 (a commit their query has not delivered yet, DA7-12).
    const before = w.watches.length;
    w.freezeReads("data.readMerged", (_input, watch) => watch < before);
    await act(async () => {
      await router.navigate({
        to: "/people/$personId/fields/new",
        params: { personId: P },
      });
    });
    const d = await screen.findByRole("dialog");
    await waitFor(() => expect(note(d)).toBe(NOTE));
    act(() => w.putCache(person({ id: P, label: "Mo", version: 2 })));
    await waitFor(() => expect(note(d)).toBeNull());
    await waitFor(() => expect(renewal.asked()).toBe(true));
    await renewal.release();
    await waitFor(() => expect(reads(w)).toBe(2));
    expect(note(d)).toBeNull();
    expect(commands(w)).toEqual([]);
    w.thawReads();
  });

  test("a read answering below the summary's version is not current, and is not asked again by itself; Try again asks once more", async () => {
    const w = moWorld();
    w.api.next.person.push(detail(1, MO), detail(1, MO), detail(2, null));
    // The person's own screen: its Try again is not behind the editor's modal dialog.
    await w.mount(`/people/${P}`);
    await waitFor(() => expect(linkage()).toBe("other"));
    await summarise(w, P, 2, null);
    await waitFor(() => expect(reads(w)).toBe(2));
    await waitFor(() =>
      expect(header().querySelector("[data-linkage]")?.textContent).toContain(
        "Atlas couldn't check just now.",
      ),
    );
    await summarise(w, P, 2, null);
    act(() => w.people.memory.touch());
    expect(reads(w)).toBe(2);
    fireEvent.click(
      within(header()).getByRole("button", { name: "Try again" }),
    );
    await waitFor(() => expect(linkage()).toBe("unlinked"));
    expect(reads(w)).toBe(3);
  });
});

describe("the subject the note describes is the current one (DA25-08, DA25-10)", () => {
  test("relinked from Mo (in Home) to another account (not in Home): no promise about the former subject", async () => {
    const w = moWorld();
    const renewal = held(detail(2, ANNA));
    w.api.next.person.push(detail(1, MO), renewal.reply);
    const d = await newField(w);
    fireEvent.click(within(d).getByRole("radio", { name: "Home · can view" }));
    await waitFor(() => expect(note(d)).toBe(IN_HOME));
    await summarise(w, P, 2, ANNA);
    expect(note(d)).toBeNull();
    await renewal.release();
    await waitFor(() => expect(linkage()).toBe("other"));
    expect(note(d)).toBeNull();
    // Defaults: the server excludes the CURRENT subject, which is true of the new one as well.
    fireEvent.click(within(d).getByRole("radio", { name: /Use my defaults/ }));
    expect(note(d)).toBe(NOTE);
    expect(w.built).toEqual([]);
  });

  test("other → self: no other-subject note at all", async () => {
    const w = moWorld();
    w.api.next.person.push(detail(1, MO), detail(2, ME));
    const d = await newField(w);
    await summarise(w, P, 2, ME);
    await waitFor(() => expect(linkage()).toBe("self"));
    expect(note(d)).toBeNull();
  });

  test("unlinked → other: the note appears only once v2's answer says so", async () => {
    const w = moWorld(null);
    const renewal = held(detail(2, MO));
    w.api.next.person.push(detail(1, null), renewal.reply);
    await w.mount(`/people/${P}/fields/new`);
    const d = await screen.findByRole("dialog");
    await waitFor(() => expect(linkage()).toBe("unlinked"));
    expect(note(d)).toBeNull();
    await summarise(w, P, 2, MO);
    expect(note(d)).toBeNull();
    await renewal.release();
    await waitFor(() => expect(note(d)).toBe(NOTE));
  });
});

describe("refusals and failures of the renewal (DA25-07)", () => {
  test("a refusal is remembered: a later summary asks nothing; Try again asks once", async () => {
    const w = moWorld();
    w.api.next.person.push(detail(1, MO), { ok: false, kind: "forbidden" });
    await w.mount(`/people/${P}`);
    await waitFor(() => expect(linkage()).toBe("other"));
    await summarise(w, P, 2, null);
    await waitFor(() =>
      expect(header().querySelector("[data-linkage]")?.textContent).toContain(
        "Atlas can't check this person for you.",
      ),
    );
    await summarise(w, P, 3, null);
    expect(reads(w)).toBe(2);
    w.api.next.person.push(detail(3, null));
    fireEvent.click(
      within(header()).getByRole("button", { name: "Try again" }),
    );
    await waitFor(() => expect(linkage()).toBe("unlinked"));
    expect(reads(w)).toBe(3);
  });

  test("a failed renewal: failed (never the old answer); offline asks nothing; the reconnection asks once", async () => {
    const w = moWorld();
    w.api.next.person.push(detail(1, MO), { ok: false, kind: "uncertain" });
    const d = await newField(w);
    await summarise(w, P, 2, null);
    await waitFor(() =>
      expect(header().querySelector("[data-linkage]")?.textContent).toContain(
        "Atlas couldn't check just now.",
      ),
    );
    expect(note(d)).toBeNull();
    expect(reads(w)).toBe(2);
    act(() => w.setOnline(false));
    await waitFor(() => expect(linkage()).toBe("unknown"));
    expect(note(d)).toBeNull();
    expect(reads(w)).toBe(2);
    w.api.next.person.push(detail(2, null));
    act(() => w.setOnline(true));
    await waitFor(() => expect(linkage()).toBe("unlinked"));
    expect(reads(w)).toBe(3);
  });
});

describe("the header's actions judge the current linkage at the press (DA25-09)", () => {
  test("an open unlink confirmation never unlinks on an answer a later version superseded, nor adopts the later version", async () => {
    const w = moWorld(ME);
    const renewal = held(detail(2, ME));
    w.api.next.person.push(detail(1, ME), renewal.reply);
    w.api.next.people.push({ ok: true, value: { revision: 3, person_id: P } });
    await w.mount(`/people/${P}`);
    await waitFor(() => expect(linkage()).toBe("self"));
    fireEvent.click(
      within(header()).getByRole("button", { name: "Unlink account" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Unlink your account from this profile?",
    });
    const confirm = within(dialog).getByRole("button", {
      name: "Unlink account",
    });
    const pressOfV1 = propsOf(confirm).onClick;
    await summarise(w, P, 2, ME);
    // The press of the render that showed v1, made now: nothing is sent.
    await act(async () => {
      await pressOfV1?.({});
    });
    expect(commands(w)).toEqual([]);
    await renewal.release();
    await waitFor(() => expect(linkage()).toBe("self"));
    // Self again, at v2: the confirmation opened on v1 is not re-bound to it.
    expect(
      within(dialog).getByRole("button", { name: "Unlink account" }),
    ).toBeDisabled();
    expect(commands(w)).toEqual([]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // Opened again on v2: one guarded unlink at v2.
    fireEvent.click(
      within(header()).getByRole("button", { name: "Unlink account" }),
    );
    const again = await screen.findByRole("dialog", {
      name: "Unlink your account from this profile?",
    });
    fireEvent.click(
      within(again).getByRole("button", { name: "Unlink account" }),
    );
    await waitFor(() => expect(commands(w)).toHaveLength(1));
    expect(commands(w)[0]?.args[1]).toMatchObject({
      command: { kind: "unlink", expected_version: 2 },
    });
  });

  test("self → unlinked while the confirmation is open: it cannot unlink, and says why", async () => {
    const w = moWorld(ME);
    w.api.next.person.push(detail(1, ME), detail(2, null));
    await w.mount(`/people/${P}`);
    await waitFor(() => expect(linkage()).toBe("self"));
    fireEvent.click(
      within(header()).getByRole("button", { name: "Unlink account" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Unlink your account from this profile?",
    });
    await summarise(w, P, 2, null);
    await waitFor(() => expect(linkage()).toBe("unlinked"));
    const confirm = within(dialog).getByRole("button", {
      name: "Unlink account",
    });
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(commands(w)).toEqual([]);
  });

  test("a rename form open on an unlinked v1: a press of its earlier render sends nothing while v2 is checked; the typed name stays", async () => {
    const w = moWorld(null);
    const renewal = held(detail(2, null));
    w.api.next.person.push(detail(1, null), renewal.reply);
    await w.mount(`/people/${P}`);
    await waitFor(() => expect(linkage()).toBe("unlinked"));
    fireEvent.click(within(header()).getByRole("button", { name: "Rename" }));
    const form = header().querySelector("[data-rename-form]") as HTMLElement;
    fireEvent.change(within(form).getByRole("textbox", { name: "Name" }), {
      target: { value: "Mo Lane" },
    });
    const submitOfV1 = propsOf(form).onSubmit;
    await summarise(w, P, 2, null);
    await act(async () => {
      submitOfV1?.({ preventDefault() {} });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(w.built).toEqual([]);
    expect(
      within(header()).getByRole("button", { name: "Save" }),
    ).toBeDisabled();
    expect(within(form).getByRole("textbox", { name: "Name" })).toHaveValue(
      "Mo Lane",
    );
    // Control: once v2 is known to be unlinked, the deliberate save queues one content edit.
    await renewal.release();
    await waitFor(() => expect(linkage()).toBe("unlinked"));
    fireEvent.click(within(header()).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(w.built).toHaveLength(1));
    expect(w.built[0]?.command).toMatchObject({
      commands: [{ kind: "edit", id: P, label: "Mo Lane" }],
    });
    expect(commands(w)).toEqual([]);
  });

  test("self → other while a rename form is open: Save is disabled with the reason; nothing is sent", async () => {
    const w = moWorld(ME);
    w.api.next.person.push(detail(1, ME), detail(2, MO));
    await w.mount(`/people/${P}`);
    await waitFor(() => expect(linkage()).toBe("self"));
    fireEvent.click(within(header()).getByRole("button", { name: "Rename" }));
    const form = header().querySelector("[data-rename-form]") as HTMLElement;
    fireEvent.change(within(form).getByRole("textbox", { name: "Name" }), {
      target: { value: "Mo Lane" },
    });
    await summarise(w, P, 2, MO);
    await waitFor(() => expect(linkage()).toBe("other"));
    const save = within(header()).getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    fireEvent.click(save);
    expect(commands(w)).toEqual([]);
    expect(w.built).toEqual([]);
    expect(within(form).getByRole("textbox", { name: "Name" })).toHaveValue(
      "Mo Lane",
    );
  });
});
