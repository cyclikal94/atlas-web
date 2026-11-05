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
import * as copy from "../../../src/features/people/copy";
import {
  forgetAllPeopleMemory,
  personFloor,
} from "../../../src/features/people/memory";
import { readLinkage } from "../../../src/features/people/reads";
import { forgetRefusedPolicies } from "../../../src/features/sharing/api";
import { installMatchMedia } from "../../helpers/match-media";
import { ME, MO } from "../../support/people/records";
import { peopleWorld, person } from "../../support/people/world";

/**
 * Review 26, R26.1/R26.2 (§4.7, E-P7, A10, A17; DA26-01..07 at the component level, with the production providers and route): an
 * online Unlink or Rename whose outcome is uncertain is tried again EXACTLY as it was sent (its key and byte-identical body, at its own
 * version), whatever the page has learnt since — its own commit read back, a later version, another linkage, a synced name. Only a NEW or
 * deliberately changed command is judged on the person and linkage as read now. Every detail answer is released by the test (a held
 * gate), the summaries are admitted when the test says (`invalidateSummaries`, as the page's freshness signals ask) and the synced row
 * moves with `setCache`; each is awaited at its own barrier before the retry. Commands are recorded with their key and body.
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
const NAME = "Kieran";
const RENAMED = "Kieran L.";

type Linked = string | null;
interface ServerPerson {
  version: number;
  label: string;
  linked: Linked;
  archived: boolean;
}
type Command = PeopleResult<{ revision: number; person_id: string }>;
type Evidence = "detail" | "summary" | "sync";

/**
 * The person as the fake server holds it; detail reads answer what it holds WHEN they are released (the gate is open unless held).
 * `commit` is what the first command did on the server before its answer was lost (null: it did not reach it).
 */
function world(start: Partial<ServerPerson> = {}) {
  const w = peopleWorld();
  const server: ServerPerson = {
    version: 1,
    label: NAME,
    linked: ME,
    archived: false,
    ...start,
  };
  const row = (s: ServerPerson) =>
    person({
      id: P,
      label: s.label,
      version: s.version,
      archived: s.archived,
    });
  w.setCache([row(server)]);
  w.api.linked.set(P, server.linked);
  let gate: Promise<void> = Promise.resolve();
  let open: () => void = () => {};
  let failing = false;
  const answer = async (): Promise<PeopleResult<PersonDetailAnswer>> => {
    await gate;
    if (failing) return { ok: false, kind: "uncertain" };
    return {
      ok: true,
      value: { person: row(server), linked_account_id: server.linked },
    };
  };
  for (let n = 0; n < 60; n += 1) w.api.next.person.push(answer);
  // Each command as it was sent: its key and its body's exact bytes (the fake's own log keeps the body parsed).
  const sent: Array<{ key: string; body: string }> = [];
  const peopleCommand = w.api.peopleCommand.bind(w.api);
  w.api.peopleCommand = (attempt) => {
    sent.push({ key: attempt.key, body: attempt.body });
    return peopleCommand(attempt);
  };
  const commands = () => sent;
  return {
    w,
    server,
    commands,
    /** Detail reads answered from now on fail (the linkage is then not known). */
    failReads() {
      failing = true;
    },
    /** Detail reads asked from now on wait until `releaseDetail`. */
    holdDetail() {
      gate = new Promise<void>((resolve) => {
        open = resolve;
      });
    },
    /**
     * The held detail reads are answered. With `ask`, one is asked first (as Reload, a remount after a failure or another caller's refresh
     * asks it): a rename's own answer asks none, so its read of the person comes only from a later version known or from such a caller.
     */
    async releaseDetail(ask = false) {
      if (ask) act(() => void readLinkage(w.people, P, { force: true }));
      await act(async () => {
        open();
        await gate;
      });
      await waitFor(() => {
        const kept = w.people.memory.linkage.get(P)?.state;
        expect(kept).toMatchObject({ known: true, version: server.version });
      });
    },
    /** The summaries are read again and P's is admitted at the server's version. */
    async summarise() {
      w.api.summary.persons.set(P, {
        label: server.label,
        version: server.version,
        archived: server.archived,
        linkage:
          server.linked === null
            ? "none"
            : server.linked === ME
              ? "you"
              : "other",
        linked_account_id: server.linked,
      } as never);
      act(() => w.people.memory.invalidateSummaries());
      await waitFor(() =>
        expect(w.people.memory.summaryFloors.get(P)?.version).toBe(
          server.version,
        ),
      );
    },
    /** The synced row is the server's (the real cache, read back by the screen). */
    async sync() {
      act(() => w.setCache([row(server)]));
      await waitFor(() =>
        expect(personFloor(w.people.memory, P)).toBeGreaterThanOrEqual(
          server.version,
        ),
      );
      await waitFor(() =>
        expect(document.querySelector("[data-person-name]")?.textContent).toBe(
          server.label,
        ),
      );
    },
    /** The first command's answer is lost; `commit` (if any) is what it did on the server first. */
    lose(commit: Partial<ServerPerson> | null) {
      w.api.next.people.push(async () => {
        if (commit !== null) Object.assign(server, commit);
        return { ok: false, kind: "uncertain" } as Command;
      });
    },
    answerNext(...answers: Command[]) {
      w.api.next.people.push(...answers);
    },
  };
}
type World = ReturnType<typeof world>;

const header = () =>
  document.querySelector("[data-identity-header]") as HTMLElement;
/** `text` is shown in `within` (an assertion, not a query that throws: a mutant is caught by what it asserts). */
const shows = async (scope: HTMLElement, text: string) =>
  waitFor(() => expect(within(scope).queryByText(text)).not.toBeNull());

/** The confirmation's Unlink button as rendered NOW (its enabled and disabled forms are different elements). */
const unlinkButton = (dialog: HTMLElement) =>
  within(dialog).getByRole("button", { name: copy.UNLINK });
const linkageShown = () =>
  header().querySelector("[data-linkage]")?.getAttribute("data-linkage");

async function apply(t: World, order: readonly Evidence[], ask = false) {
  for (const evidence of order) {
    if (evidence === "detail") await t.releaseDetail(ask);
    else if (evidence === "summary") await t.summarise();
    else await t.sync();
  }
}

/** Every order the three kinds of evidence of the commit can arrive in, and each alone (DA26-03). */
const ORDERS: readonly (readonly Evidence[])[] = [
  ["detail"],
  ["summary"],
  ["sync"],
  ["detail", "summary", "sync"],
  ["detail", "sync", "summary"],
  ["summary", "detail", "sync"],
  ["summary", "sync", "detail"],
  ["sync", "detail", "summary"],
  ["sync", "summary", "detail"],
];

// ---------------------------------------------------------------- Unlink ----------------------------------------------------------------

/** The header offers the kept unlink again; its confirmation says it is uncertain and sends it as it was; then nothing is left. */
async function reopenAndResolve(t: World) {
  const entry = () =>
    within(header()).queryByRole("button", { name: copy.UNLINK });
  expect(entry()).not.toBeNull();
  expect(entry()).toBeEnabled();
  fireEvent.click(entry() as HTMLElement);
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeNull());
  const again = screen.getByRole("dialog");
  expect(within(again).queryByText(copy.UNCERTAIN)).not.toBeNull();
  t.answerNext({ ok: true, value: { revision: 2, person_id: P } });
  expect(unlinkButton(again)).toBeEnabled();
  fireEvent.click(unlinkButton(again));
  await waitFor(() => expect(t.commands()).toHaveLength(2));
  expect(t.commands()[1]).toEqual(t.commands()[0]);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(t.w.people.memory.attempts.has(`unlink:${P}`)).toBe(false);
}

/** Opens /people/P, confirms Unlink and loses its answer; the forced read that follows is held. */
async function unlinkUncertain(t: World, commit: Partial<ServerPerson> | null) {
  t.lose(commit);
  await t.w.mount(`/people/${P}`);
  await waitFor(() => expect(linkageShown()).toBe("self"));
  fireEvent.click(within(header()).getByRole("button", { name: copy.UNLINK }));
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: copy.UNLINK_TITLE }),
    ).not.toBeNull(),
  );
  const dialog = screen.getByRole("dialog", { name: copy.UNLINK_TITLE });
  t.holdDetail();
  fireEvent.click(within(dialog).getByRole("button", { name: copy.UNLINK }));
  await shows(dialog, copy.UNCERTAIN);
  expect(t.commands()).toHaveLength(1);
  expect(JSON.parse(t.commands()[0]?.body ?? "")).toEqual({
    command: { kind: "unlink", person_id: P, expected_version: 1 },
  });
  expect(t.w.people.memory.attempts.has(`unlink:${P}`)).toBe(true);
  return dialog;
}

describe("R26.1: an uncertain unlink is tried again as it was sent, whatever is read since", () => {
  for (const order of ORDERS)
    test(`committed, then ${order.join(" → ")} before Try again: the original key and body, its receipt closes it`, async () => {
      const t = world();
      const dialog = await unlinkUncertain(t, { version: 2, linked: null });
      await apply(t, order);
      if (order.includes("detail")) expect(linkageShown()).toBe("unlinked");
      else expect(linkageShown()).toBe("unknown");
      t.answerNext({ ok: true, value: { revision: 2, person_id: P } });
      const retry = within(dialog).getByRole("button", { name: copy.UNLINK });
      expect(retry).toBeEnabled();
      fireEvent.click(retry);
      await waitFor(() => expect(t.commands()).toHaveLength(2));
      expect(t.commands()[1]).toEqual(t.commands()[0]);
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(t.w.people.memory.attempts.has(`unlink:${P}`)).toBe(false);
      expect(t.w.built).toHaveLength(0);
    });

  test("control: nothing changed before Try again — the same key and body (as before review 26)", async () => {
    const t = world();
    const dialog = await unlinkUncertain(t, null);
    await t.releaseDetail();
    expect(linkageShown()).toBe("self");
    t.answerNext({ ok: true, value: { revision: 2, person_id: P } });
    fireEvent.click(within(dialog).getByRole("button", { name: copy.UNLINK }));
    await waitFor(() => expect(t.commands()).toHaveLength(2));
    expect(t.commands()[1]).toEqual(t.commands()[0]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  // DA26-04: a later state than the commit; the old body is still sent as it was, and the server's answer decides.
  const LATER: ReadonlyArray<[string, Partial<ServerPerson>]> = [
    ["relinked to the viewer at a later version", { version: 3, linked: ME }],
    ["linked to another account", { version: 3, linked: MO }],
    ["archived", { version: 3, linked: null, archived: true }],
  ];
  for (const [what, later] of LATER)
    for (const committed of [true, false])
      test(`${committed ? "committed" : "not committed"}, then ${what}: Try again sends the unlink of version 1, never one of the later state`, async () => {
        const t = world();
        const dialog = await unlinkUncertain(
          t,
          committed ? { version: 2, linked: null } : null,
        );
        Object.assign(t.server, later);
        await t.releaseDetail();
        await t.sync();
        t.answerNext(
          committed
            ? { ok: true, value: { revision: 2, person_id: P } }
            : { ok: false, kind: "conflict" },
        );
        const retry = within(dialog).getByRole("button", {
          name: copy.UNLINK,
        });
        expect(retry).toBeEnabled();
        fireEvent.click(retry);
        await waitFor(() => expect(t.commands()).toHaveLength(2));
        expect(t.commands()[1]).toEqual(t.commands()[0]);
        expect(t.w.built).toHaveLength(0);
        if (committed) {
          await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
        } else {
          // A definite refusal ends the old attempt: what follows is a NEW unlink, judged on the linkage read now.
          await shows(dialog, copy.CONFLICT);
          expect(t.w.people.memory.attempts.has(`unlink:${P}`)).toBe(false);
          if (later.linked === ME) {
            // Bound again to the viewer's own linkage read after the conflict (the existing rule): a deliberate new unlink of v3.
            await waitFor(() => expect(unlinkButton(dialog)).toBeEnabled());
            t.answerNext({ ok: true, value: { revision: 4, person_id: P } });
            fireEvent.click(unlinkButton(dialog));
            await waitFor(() => expect(t.commands()).toHaveLength(3));
            expect(t.commands()[2]?.key).not.toBe(t.commands()[0]?.key);
            expect(JSON.parse(t.commands()[2]?.body ?? "")).toEqual({
              command: { kind: "unlink", person_id: P, expected_version: 3 },
            });
          } else {
            expect(unlinkButton(dialog)).toBeDisabled();
            fireEvent.click(unlinkButton(dialog));
            await act(async () => {});
            expect(t.commands()).toHaveLength(2);
          }
        }
      });

  // DA26-05: what each answer to the retry leaves.
  const OUTCOMES: ReadonlyArray<[Command, boolean, string | null]> = [
    [{ ok: false, kind: "uncertain" }, true, copy.UNCERTAIN],
    [{ ok: false, kind: "conflict" }, false, copy.CONFLICT],
    [{ ok: false, kind: "operation_conflict" }, false, copy.CONFLICT],
    [{ ok: false, kind: "forbidden" }, false, copy.FORBIDDEN_PROFILE],
    [{ ok: false, kind: "not_found" }, false, copy.REFUSED.storage],
    [{ ok: false, kind: "offline" }, true, copy.NEEDS_CONNECTION],
    [{ ok: false, kind: "closed" }, true, null],
  ];
  for (const [outcome, kept, text] of OUTCOMES)
    test(`after the commit is read back, a retry answered ${outcome.ok ? "ok" : outcome.kind} ${kept ? "keeps" : "ends"} the original attempt`, async () => {
      const t = world();
      const dialog = await unlinkUncertain(t, { version: 2, linked: null });
      await t.releaseDetail();
      t.answerNext(outcome);
      fireEvent.click(
        within(dialog).getByRole("button", { name: copy.UNLINK }),
      );
      await waitFor(() => expect(t.commands()).toHaveLength(2));
      expect(t.commands()[1]).toEqual(t.commands()[0]);
      await waitFor(() =>
        expect(t.w.people.memory.attempts.has(`unlink:${P}`)).toBe(kept),
      );
      if (text !== null) await shows(dialog, text);
      if (kept) {
        // Still the same attempt: a further Try again sends it again, exactly.
        await waitFor(() => expect(unlinkButton(dialog)).toBeEnabled());
        t.answerNext({ ok: true, value: { revision: 2, person_id: P } });
        fireEvent.click(unlinkButton(dialog));
        await waitFor(() => expect(t.commands()).toHaveLength(3));
        expect(t.commands()[2]).toEqual(t.commands()[0]);
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      } else {
        // Nothing is left to resolve: the person is not linked, so no new unlink can be made.
        expect(unlinkButton(dialog)).toBeDisabled();
        expect(t.commands()).toHaveLength(2);
      }
      expect(t.w.built).toHaveLength(0);
    });

  test("not sent, then sent: the bounded quiet resend and the next Try again keep the original key and body", async () => {
    const t = world();
    const dialog = await unlinkUncertain(t, { version: 2, linked: null });
    await t.releaseDetail();
    t.answerNext(
      { ok: false, kind: "not_sent" },
      { ok: true, value: { revision: 2, person_id: P } },
    );
    fireEvent.click(within(dialog).getByRole("button", { name: copy.UNLINK }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(t.commands()).toHaveLength(3);
    expect(t.commands()[1]).toEqual(t.commands()[0]);
    expect(t.commands()[2]).toEqual(t.commands()[0]);
  });

  test("offline: the retry waits for a connection (nothing is sent), then sends the original", async () => {
    const t = world();
    const dialog = await unlinkUncertain(t, { version: 2, linked: null });
    await t.releaseDetail();
    act(() => t.w.setOnline(false));
    await waitFor(() => expect(unlinkButton(dialog)).toBeDisabled());
    fireEvent.click(unlinkButton(dialog));
    await act(async () => {});
    expect(t.commands()).toHaveLength(1);
    act(() => t.w.setOnline(true));
    t.answerNext({ ok: true, value: { revision: 2, person_id: P } });
    await waitFor(() => expect(unlinkButton(dialog)).toBeEnabled());
    fireEvent.click(unlinkButton(dialog));
    await waitFor(() => expect(t.commands()).toHaveLength(2));
    expect(t.commands()[1]).toEqual(t.commands()[0]);
  });

  // DA26-07: the confirmation's own state is gone (closed, as a remount would), but the attempt is kept with the person.
  test("closed after the uncertainty and the commit read back: the header still offers it, the confirmation says so and tries it as it was", async () => {
    const t = world();
    const dialog = await unlinkUncertain(t, { version: 2, linked: null });
    await t.releaseDetail();
    fireEvent.click(within(dialog).getByRole("button", { name: copy.CANCEL }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(linkageShown()).toBe("unlinked");
    await reopenAndResolve(t);
  });

  test("closed after the uncertainty, then the linkage cannot be read: the kept unlink is still offered, on its own version", async () => {
    const t = world();
    const dialog = await unlinkUncertain(t, { version: 2, linked: null });
    fireEvent.click(within(dialog).getByRole("button", { name: copy.CANCEL }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    t.failReads();
    await act(async () => {
      t.releaseDetail().catch(() => {});
    });
    await t.sync();
    await waitFor(() => expect(linkageShown()).toBe("unknown"));
    await reopenAndResolve(t);
  });

  test("control: an unlinked person with nothing kept offers no unlink", async () => {
    const t = world({ linked: null });
    await t.w.mount(`/people/${P}`);
    await waitFor(() => expect(linkageShown()).toBe("unlinked"));
    expect(
      within(header()).queryByRole("button", { name: copy.UNLINK }),
    ).toBeNull();
  });

  test("control: another account's person with nothing kept: Unlink is disabled with its reason", async () => {
    const t = world({ linked: MO });
    await t.w.mount(`/people/${P}`);
    await waitFor(() => expect(linkageShown()).toBe("other"));
    expect(
      within(header()).getByRole("button", { name: copy.UNLINK }),
    ).toBeDisabled();
  });
});

// ---------------------------------------------------------------- Rename ----------------------------------------------------------------

const nameBox = () =>
  within(header()).getByRole("textbox", { name: copy.NAME });
const saveButton = () =>
  within(header()).getByRole("button", { name: copy.SAVE });

/** Opens /people/P, renames to "Kieran L." and loses its answer; the forced read that follows is held. */
async function renameUncertain(t: World, commit: Partial<ServerPerson> | null) {
  t.lose(commit);
  await t.w.mount(`/people/${P}`);
  await waitFor(() => expect(linkageShown()).toBe("self"));
  fireEvent.click(within(header()).getByRole("button", { name: copy.RENAME }));
  fireEvent.change(nameBox(), { target: { value: RENAMED } });
  t.holdDetail();
  fireEvent.click(saveButton());
  await shows(header(), copy.UNCERTAIN);
  expect(t.commands()).toHaveLength(1);
  expect(JSON.parse(t.commands()[0]?.body ?? "")).toEqual({
    command: {
      kind: "rename_profile",
      person_id: P,
      expected_version: 1,
      name: RENAMED,
    },
  });
  expect(t.w.people.memory.attempts.has(`rename:${P}`)).toBe(true);
}

const renamed = { version: 2, label: RENAMED };

describe("R26.2: an unchanged uncertain rename is tried again as it was sent, before the form is judged or bound again", () => {
  for (const order of ORDERS)
    test(`committed, then ${order.join(" → ")} before Save: the original key and body, its receipt closes the form`, async () => {
      const t = world();
      await renameUncertain(t, renamed);
      await apply(t, order, true);
      expect(nameBox()).toHaveValue(RENAMED);
      t.answerNext({ ok: true, value: { revision: 2, person_id: P } });
      expect(saveButton()).toBeEnabled();
      fireEvent.click(saveButton());
      await waitFor(() => expect(t.commands()).toHaveLength(2));
      expect(t.commands()[1]).toEqual(t.commands()[0]);
      await waitFor(() =>
        expect(header().querySelector("[data-rename-form]")).toBeNull(),
      );
      expect(within(header()).queryByText(copy.STALE_RENAME)).toBeNull();
      expect(t.w.people.memory.attempts.has(`rename:${P}`)).toBe(false);
      expect(t.w.built).toHaveLength(0);
    });

  test("control: the sync lags until after Save — the same key and body (as before review 26)", async () => {
    const t = world();
    await renameUncertain(t, null);
    await t.releaseDetail(true);
    t.answerNext({ ok: true, value: { revision: 2, person_id: P } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(t.commands()).toHaveLength(2));
    expect(t.commands()[1]).toEqual(t.commands()[0]);
    await waitFor(() =>
      expect(header().querySelector("[data-rename-form]")).toBeNull(),
    );
  });

  // DA26-04: the person moved on after the commit. The rename is still the online rename of version 1 — never the queued content edit of
  // an unlinked person, never a rename of the later version.
  const LATER: ReadonlyArray<[string, Partial<ServerPerson>]> = [
    ["unlinked", { version: 3, label: RENAMED, linked: null }],
    ["linked to another account", { version: 3, label: RENAMED, linked: MO }],
    ["renamed again", { version: 3, label: "Kieran Lane", linked: ME }],
  ];
  for (const [what, later] of LATER)
    for (const committed of [true, false])
      test(`${committed ? "committed" : "not committed"}, then ${what}: the unchanged Save sends the original online rename only`, async () => {
        const t = world();
        await renameUncertain(t, committed ? renamed : null);
        Object.assign(t.server, later);
        await t.releaseDetail(true);
        await t.sync();
        expect(nameBox()).toHaveValue(RENAMED);
        t.answerNext(
          committed
            ? { ok: true, value: { revision: 2, person_id: P } }
            : { ok: false, kind: "conflict" },
        );
        expect(saveButton()).toBeEnabled();
        fireEvent.click(saveButton());
        await waitFor(() => expect(t.commands()).toHaveLength(2));
        expect(t.commands()[1]).toEqual(t.commands()[0]);
        expect(t.w.built).toHaveLength(0);
        if (committed) {
          await waitFor(() =>
            expect(header().querySelector("[data-rename-form]")).toBeNull(),
          );
        } else {
          // A definite refusal ends it; the typed name stays, and the next Save is a NEW rename judged on the person read now.
          await shows(header(), copy.CONFLICT);
          expect(t.w.people.memory.attempts.has(`rename:${P}`)).toBe(false);
          expect(nameBox()).toHaveValue(RENAMED);
          if (later.linked === MO) {
            await waitFor(() => expect(saveButton()).toBeDisabled());
          } else {
            fireEvent.click(saveButton());
            await shows(header(), copy.STALE_RENAME);
            expect(t.commands()).toHaveLength(2);
            expect(t.w.built).toHaveLength(0);
          }
        }
      });

  const OUTCOMES: ReadonlyArray<[Command, boolean, string | null]> = [
    [{ ok: false, kind: "uncertain" }, true, copy.UNCERTAIN],
    [{ ok: false, kind: "conflict" }, false, copy.CONFLICT],
    [{ ok: false, kind: "operation_conflict" }, false, copy.CONFLICT],
    [{ ok: false, kind: "forbidden" }, false, copy.FORBIDDEN_PROFILE],
    [{ ok: false, kind: "invalid" }, false, copy.REFUSED.storage],
    [{ ok: false, kind: "offline" }, true, copy.NEEDS_CONNECTION],
    [{ ok: false, kind: "closed" }, true, null],
  ];
  for (const [outcome, kept, text] of OUTCOMES)
    test(`after the sync of its commit, a retry answered ${outcome.ok ? "ok" : outcome.kind} ${kept ? "keeps" : "ends"} the original attempt`, async () => {
      const t = world();
      await renameUncertain(t, renamed);
      await t.sync();
      await t.releaseDetail();
      t.answerNext(outcome);
      fireEvent.click(saveButton());
      await waitFor(() => expect(t.commands()).toHaveLength(2));
      expect(t.commands()[1]).toEqual(t.commands()[0]);
      await waitFor(() =>
        expect(t.w.people.memory.attempts.has(`rename:${P}`)).toBe(kept),
      );
      if (text !== null) await shows(header(), text);
      expect(nameBox()).toHaveValue(RENAMED);
      if (kept) {
        t.answerNext({ ok: true, value: { revision: 2, person_id: P } });
        await waitFor(() => expect(saveButton()).toBeEnabled());
        fireEvent.click(saveButton());
        await waitFor(() => expect(t.commands()).toHaveLength(3));
        expect(t.commands()[2]).toEqual(t.commands()[0]);
        await waitFor(() =>
          expect(header().querySelector("[data-rename-form]")).toBeNull(),
        );
      } else {
        // Nothing is left to resolve: the next Save is a new rename of the person as read now (bound again, so not sent yet).
        fireEvent.click(saveButton());
        await shows(header(), copy.STALE_RENAME);
        expect(t.commands()).toHaveLength(2);
      }
      expect(t.w.built).toHaveLength(0);
    });

  // DA26-06: what the person submits decides; the page's later reads do not.
  test("a changed name after the sync is a NEW rename: bound again first, then sent under a new key at the version read now", async () => {
    const t = world();
    await renameUncertain(t, renamed);
    await t.sync();
    await t.releaseDetail();
    fireEvent.change(nameBox(), { target: { value: "Kieran Lane" } });
    fireEvent.click(saveButton());
    await shows(header(), copy.STALE_RENAME);
    expect(t.commands()).toHaveLength(1);
    t.answerNext({ ok: true, value: { revision: 3, person_id: P } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(t.commands()).toHaveLength(2));
    expect(t.commands()[1]?.key).not.toBe(t.commands()[0]?.key);
    expect(JSON.parse(t.commands()[1]?.body ?? "")).toEqual({
      command: {
        kind: "rename_profile",
        person_id: P,
        expected_version: 2,
        name: "Kieran Lane",
      },
    });
  });

  test("the same name typed again (changed and back, with spaces around it) is the same rename: its key and body", async () => {
    const t = world();
    await renameUncertain(t, renamed);
    await t.sync();
    await t.releaseDetail();
    fireEvent.change(nameBox(), { target: { value: "Kieran Lane" } });
    fireEvent.change(nameBox(), { target: { value: `  ${RENAMED} ` } });
    t.answerNext({ ok: true, value: { revision: 2, person_id: P } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(t.commands()).toHaveLength(2));
    expect(t.commands()[1]).toEqual(t.commands()[0]);
    await waitFor(() =>
      expect(header().querySelector("[data-rename-form]")).toBeNull(),
    );
  });

  test("offline: Save waits for a connection (nothing is sent or queued), then sends the original", async () => {
    const t = world();
    await renameUncertain(t, { ...renamed, linked: null });
    await t.sync();
    await t.releaseDetail();
    expect(linkageShown()).toBe("unlinked");
    act(() => t.w.setOnline(false));
    await waitFor(() => expect(saveButton()).toBeDisabled());
    fireEvent.click(saveButton());
    await act(async () => {});
    expect(t.commands()).toHaveLength(1);
    expect(t.w.built).toHaveLength(0);
    act(() => t.w.setOnline(true));
    t.answerNext({ ok: true, value: { revision: 2, person_id: P } });
    await waitFor(() => expect(saveButton()).toBeEnabled());
    fireEvent.click(saveButton());
    await waitFor(() => expect(t.commands()).toHaveLength(2));
    expect(t.commands()[1]).toEqual(t.commands()[0]);
    expect(t.w.built).toHaveLength(0);
  });

  // DA26-07: the form's session is ended (Cancel) but the attempt stays with the person.
  test("cancelled after the uncertainty, then linked to another account: Rename still opens on the synced name and tries it as it was", async () => {
    const t = world();
    await renameUncertain(t, renamed);
    fireEvent.click(
      within(header()).getByRole("button", { name: copy.CANCEL }),
    );
    await waitFor(() =>
      expect(header().querySelector("[data-rename-form]")).toBeNull(),
    );
    Object.assign(t.server, { version: 3, linked: MO });
    await t.releaseDetail(true);
    await t.sync();
    expect(linkageShown()).toBe("other");
    const entry = within(header()).getByRole("button", { name: copy.RENAME });
    expect(entry).toBeEnabled();
    fireEvent.click(entry);
    expect(nameBox()).toHaveValue(RENAMED);
    t.answerNext({ ok: true, value: { revision: 2, person_id: P } });
    expect(saveButton()).toBeEnabled();
    fireEvent.click(saveButton());
    await waitFor(() => expect(t.commands()).toHaveLength(2));
    expect(t.commands()[1]).toEqual(t.commands()[0]);
    await waitFor(() =>
      expect(header().querySelector("[data-rename-form]")).toBeNull(),
    );
    // Resolved: another account's name, nothing kept — Rename is disabled again.
    expect(
      within(header()).getByRole("button", { name: copy.RENAME }),
    ).toBeDisabled();
  });

  test("control: another account's person with nothing kept: Rename is disabled", async () => {
    const t = world({ linked: MO });
    await t.w.mount(`/people/${P}`);
    await waitFor(() => expect(linkageShown()).toBe("other"));
    expect(
      within(header()).getByRole("button", { name: copy.RENAME }),
    ).toBeDisabled();
  });
});
