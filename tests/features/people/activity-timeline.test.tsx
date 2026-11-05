import {
  act,
  cleanup,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { PeopleResult } from "../../../src/features/people/api";
import {
  forgetAllPeopleMemory,
  isCurrentMemory,
  peopleMemory,
} from "../../../src/features/people/memory";
import type {
  PersonActivityEvent,
  PersonActivityPage,
} from "../../../src/features/people/model/activity";
import { SUMMARY_REFRESH_MS } from "../../../src/features/people/summaries";
import { forgetRefusedPolicies } from "../../../src/features/sharing/api";
import { installMatchMedia } from "../../helpers/match-media";
import { draftRow } from "../../support/data/rows";
import {
  accountActor,
  activityEvent,
  eventId,
  fieldTarget,
  manyEdits,
  personTarget,
  SOMEONE,
} from "../../support/people/activity";
import { ME, MO } from "../../support/people/records";
import {
  ACTIVITY_COVERAGE,
  fieldRow,
  type PeopleWorld,
  peopleWorld,
  person,
} from "../../support/people/world";

/**
 * WEB-19, "Recent changes" on the person detail (`activity/`), in the real `PersonDetail` composition over the people world (jsdom, axe;
 * fixture evidence, never real-backend evidence). S-AC1..S-AC15 of the plan (§7.2), the freshness rules (D-19-4) and P-11.
 */
installMatchMedia({ width: 1440 });
beforeEach(() => {
  forgetAllPeopleMemory();
  forgetRefusedPolicies();
});
afterEach(async () => {
  vi.restoreAllMocks();
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 0));
});

const P = "55555555-5555-4555-8555-555555555555";
const ALIAS = "57575757-5757-4757-8757-575757575757";
const OTHER = "58585858-5858-4858-8858-585858585858";
const F = (n: number) =>
  `66666666-6666-4666-8666-${String(n).padStart(12, "0")}`;

const section = () =>
  document.querySelector("[data-activity]") as HTMLElement | null;
const stateOf = () => section()?.getAttribute("data-activity") ?? null;
const shownIds = () =>
  [...document.querySelectorAll("[data-activity-event]")].map((li) =>
    li.getAttribute("data-activity-event"),
  );
const sentenceOf = (id: string) =>
  document.querySelector(`[data-activity-event="${id}"] p`)?.textContent ??
  null;
const until = async (state: string) =>
  waitFor(() => expect(stateOf()).toBe(state));
const press = (name: string) =>
  fireEvent.click(
    within(section() as HTMLElement).getByRole("button", { name }),
  );

/** Ada with her Phone field; `events` are the fake server's timeline of Ada, newest first. */
function world(
  events: PersonActivityEvent[],
  options: Parameters<typeof peopleWorld>[0] = {},
): PeopleWorld {
  const w = peopleWorld(options);
  w.setCache([
    person({ id: P, label: "Ada" }),
    fieldRow({ id: F(1), parent_id: P, label: "Phone" }),
  ]);
  w.api.activity.events.set(P, events);
  return w;
}

const page = (
  items: PersonActivityEvent[],
  next: string | null,
  over: Partial<PersonActivityPage> = {},
): PeopleResult<PersonActivityPage> => ({
  ok: true,
  value: {
    person_id: P,
    items,
    next_after: next,
    coverage_started_at: ACTIVITY_COVERAGE,
    ...over,
  },
});

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const phone = fieldTarget(F(1), "Phone");
const ada = personTarget(P, "Ada");

describe("S-AC1 / S-AC7: every type, its sentence, the current label and the actor", () => {
  test("the eleven types, in the server's order, named as the server may name the actor", async () => {
    const alice = accountActor(MO, "alice");
    const events = [
      activityEvent(1, "field_restored", phone),
      activityEvent(2, "field_archived", phone, { actor: SOMEONE }),
      activityEvent(3, "field_edited", phone, { changed: ["label", "value"] }),
      activityEvent(4, "field_edited", phone, { changed: ["label"] }),
      activityEvent(5, "field_edited", phone, { actor: alice }),
      activityEvent(6, "field_created", phone),
      activityEvent(7, "person_merged", ada, {
        merged_from: { id: ALIAS, label: "Ada L" },
      }),
      activityEvent(8, "person_unlinked", ada, { account: alice }),
      activityEvent(9, "person_linked", ada, { actor: alice, account: alice }),
      activityEvent(10, "person_restored", ada),
      activityEvent(11, "person_archived", ada),
      activityEvent(12, "person_renamed", ada, { actor: SOMEONE }),
      activityEvent(13, "person_created", ada),
    ];
    const w = world(events);
    await w.mount(`/people/${P}`);
    await until("ready");
    expect(shownIds()).toEqual(events.slice(0, 5).map((e) => e.id));
    press("Show all changes");
    await waitFor(() => expect(shownIds()).toHaveLength(13));
    expect(shownIds()).toEqual(events.map((e) => e.id));
    expect(events.map((e) => sentenceOf(e.id))).toEqual([
      "You restored Phone.",
      "Someone else archived Phone.",
      "You changed the name and value of Phone.",
      "You changed the name of Phone.",
      "alice changed the value of Phone.",
      "You added Phone.",
      "You merged Ada L into this person.",
      "You unlinked this person from alice's account.",
      "alice linked this person to their account.",
      "You restored this person.",
      "You archived this person.",
      "Someone else renamed this person.",
      "You added this person.",
    ]);
    // Each event has its time; nothing carries the contract's summary phrase (presentation is the client's).
    const times = (section() as HTMLElement).querySelectorAll("time");
    expect(times).toHaveLength(13);
    expect(times[0]?.getAttribute("dateTime")).toBe(
      new Date((events[0]?.occurred_at ?? 0) * 1000).toISOString(),
    );
    expect(section()).not.toHaveTextContent("Edited a field");
    expect((await axe(section() as HTMLElement)).violations).toEqual([]);
  });
});

describe("S-AC2 / S-AC12: tags and links only for the current item on this device", () => {
  test("a current cached field links to its editor; archived, uncached, another person's or merged targets are plain with their tags", async () => {
    const w = world([
      activityEvent(1, "field_edited", phone),
      activityEvent(
        2,
        "field_archived",
        fieldTarget(F(2), "Notes", { archived: true }),
      ),
      activityEvent(3, "field_created", fieldTarget(F(3), "Not here")),
      activityEvent(4, "field_created", fieldTarget(F(4), "Moved")),
      activityEvent(
        5,
        "person_created",
        personTarget(ALIAS, "Ada L", {
          archived: true,
          state: "merged",
          canonical_person_id: P,
        }),
      ),
    ]);
    w.putCache(
      fieldRow({ id: F(2), parent_id: P, label: "Notes", archived: true }),
    );
    w.putCache(person({ id: OTHER, label: "Bea" }));
    w.putCache(fieldRow({ id: F(4), parent_id: OTHER, label: "Moved" }));
    await w.mount(`/people/${P}`);
    await until("ready");
    const links = [
      ...(section() as HTMLElement).querySelectorAll("[data-activity-link]"),
    ].map((a) => a.getAttribute("data-activity-link"));
    expect(links).toEqual([F(1)]);
    const link = within(section() as HTMLElement).getByRole("link", {
      name: "Phone",
    });
    expect(link.getAttribute("href")).toBe(`/people/${P}/fields/${F(1)}`);
    const tags = (id: string) =>
      [
        ...document.querySelectorAll(
          `[data-activity-event="${id}"] [data-activity-tag]`,
        ),
      ].map((t) => t.textContent);
    expect(tags(eventId(2))).toEqual(["Archived"]);
    expect(tags(eventId(5))).toEqual(["Merged profile"]);
    expect(tags(eventId(1))).toEqual([]);
    // The merged profile is linked once this device holds it.
    w.putCache(
      person({
        id: ALIAS,
        label: "Ada L",
        archived: true,
        value: { canonical_person_id: P } as never,
      }),
    );
    await waitFor(() =>
      expect(
        (section() as HTMLElement).querySelector(
          `[data-activity-link="${ALIAS}"]`,
        ),
      ).not.toBeNull(),
    );
  });

  test("S-AC12: the route's person was merged (the answer is another person's): nothing is listed, only the note and its link", async () => {
    const w = world([activityEvent(1, "field_edited", phone)]);
    w.putCache(
      person({
        id: ALIAS,
        label: "Ada L",
        archived: true,
        value: { canonical_person_id: P } as never,
      }),
    );
    w.api.activity.canonical.set(ALIAS, P);
    await w.mount(`/people/${ALIAS}`);
    await until("merged");
    expect(shownIds()).toEqual([]);
    expect(section()).toHaveTextContent(
      "This profile was merged. Its changes are shown on the person it was merged into.",
    );
    expect(
      within(section() as HTMLElement)
        .getByRole("link", { name: "Open that person" })
        .getAttribute("href"),
    ).toBe(`/people/${P}`);
    expect(section()).not.toHaveTextContent("Phone");
  });
});

describe("S-AC4 / S-AC5: order and pagination", () => {
  test("S-AC4: the server's order is kept when the times disagree (never re-sorted)", async () => {
    const events = [
      activityEvent(1, "field_edited", phone, {
        occurred_at: ACTIVITY_COVERAGE + 10,
      }),
      activityEvent(2, "field_created", phone, {
        occurred_at: ACTIVITY_COVERAGE + 500,
      }),
      activityEvent(3, "person_created", ada, {
        occurred_at: ACTIVITY_COVERAGE + 20,
      }),
    ];
    const w = world(events);
    await w.mount(`/people/${P}`);
    await until("ready");
    expect(shownIds()).toEqual([eventId(1), eventId(2), eventId(3)]);
  });

  test("S-AC5: preview 5, Show all 50, Show older +50 to the start, Show fewer without a read", async () => {
    const events = manyEdits(120, phone);
    const w = world(events);
    await w.mount(`/people/${P}`);
    await until("ready");
    expect(shownIds()).toHaveLength(5);
    expect(w.api.activityCalls).toEqual([{ id: P, after: null, limit: 5 }]);
    expect(section()).not.toHaveTextContent(
      "Earlier changes weren't recorded.",
    );
    press("Show all changes");
    await waitFor(() => expect(shownIds()).toHaveLength(50));
    press("Show older changes");
    await waitFor(() => expect(shownIds()).toHaveLength(100));
    press("Show older changes");
    await waitFor(() => expect(shownIds()).toHaveLength(120));
    expect(w.api.activityCalls).toEqual([
      { id: P, after: null, limit: 5 },
      { id: P, after: eventId(5), limit: 45 },
      { id: P, after: eventId(50), limit: 50 },
      { id: P, after: eventId(100), limit: 50 },
    ]);
    expect(new Set(shownIds()).size).toBe(120);
    expect(shownIds()).toEqual(events.map((e) => e.id));
    expect(section()).toHaveTextContent("Earlier changes weren't recorded.");
    expect(
      within(section() as HTMLElement).queryByRole("button", {
        name: "Show older changes",
      }),
    ).toBeNull();
    press("Show fewer");
    await waitFor(() => expect(shownIds()).toHaveLength(5));
    expect(w.api.activityCalls).toHaveLength(4);
    // Shown again from what is held: no read.
    press("Show all changes");
    await waitFor(() => expect(shownIds()).toHaveLength(50));
    expect(w.api.activityCalls).toHaveLength(4);
  });

  test("S-AC5 / E15: at most 500 events, then an honest note instead of Show older", async () => {
    const w = world(manyEdits(520, phone));
    await w.mount(`/people/${P}`);
    await until("ready");
    press("Show all changes");
    await waitFor(() => expect(shownIds()).toHaveLength(50));
    for (let shown = 100; shown <= 500; shown += 50) {
      press("Show older changes");
      await waitFor(() => expect(shownIds()).toHaveLength(shown));
    }
    expect(section()).toHaveTextContent("Showing the 500 most recent changes.");
    expect(section()).not.toHaveTextContent(
      "Earlier changes weren't recorded.",
    );
    expect(
      within(section() as HTMLElement).queryByRole("button", {
        name: "Show older changes",
      }),
    ).toBeNull();
    expect(
      within(section() as HTMLElement).getByRole("button", {
        name: "Show fewer",
      }),
    ).toBeEnabled();
    expect(w.api.activityCalls.at(-1)).toEqual({
      id: P,
      after: eventId(450),
      limit: 50,
    });
  });
});

describe("S-AC6: one entry per event across pages, retries and refreshes", () => {
  test("an id repeated on the next page is kept once, at its first position", async () => {
    const events = manyEdits(9, phone);
    const w = world(events);
    w.api.next.activity.push(
      page(events.slice(0, 5), eventId(5)),
      page([events[4] as PersonActivityEvent, ...events.slice(5, 9)], null),
    );
    await w.mount(`/people/${P}`);
    await until("ready");
    press("Show all changes");
    await waitFor(() => expect(shownIds()).toHaveLength(9));
    expect(shownIds()).toEqual(events.map((e) => e.id));
  });

  test("a failed read retried, then refreshes: every event once, the timeline replaced whole (never stitched)", async () => {
    const events = manyEdits(60, phone, 10);
    const w = world(events);
    w.api.next.activity.push({ ok: false, kind: "uncertain" });
    await w.mount(`/people/${P}`);
    await until("failed");
    expect(section()).toHaveTextContent("Couldn't load recent changes.");
    press("Try again");
    await until("ready");
    press("Show all changes");
    await waitFor(() => expect(shownIds()).toHaveLength(50));
    // A new event arrives (another device), and the oldest held one becomes hidden: the refresh re-reads from the first page to 50.
    const fresh = activityEvent(1, "field_created", phone, { actor: SOMEONE });
    w.api.activity.events.set(P, [
      fresh,
      ...events.filter((e) => e.id !== eventId(59)),
    ]);
    const before = w.api.activityCalls.length;
    w.advanceRevision();
    await waitFor(() => expect(shownIds()[0]).toBe(fresh.id));
    expect(w.api.activityCalls.slice(before)).toEqual([
      { id: P, after: null, limit: 50 },
    ]);
    expect(shownIds()).toEqual(
      [fresh, ...events].slice(0, 50).map((e) => e.id),
    );
    expect(new Set(shownIds()).size).toBe(50);
  });
});

describe("S-AC8 / P-11: accounts, devices and re-authentication", () => {
  test("an answer for an identity no longer shown applies nothing; the next identity reads its own from the first page", async () => {
    const held = deferred<PeopleResult<PersonActivityPage>>();
    const a = world([activityEvent(1, "field_edited", phone)]);
    a.api.next.activity.push(() => held.promise);
    await a.mount(`/people/${P}`);
    await until("loading");
    const first = peopleMemory(`${ME}:1`);
    cleanup();
    const b = world([activityEvent(2, "field_created", phone)], {
      identity: "other-account:1",
    });
    await b.mount(`/people/${P}`);
    await until("ready");
    held.resolve(page([activityEvent(9, "person_renamed", ada)], null));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(isCurrentMemory(first)).toBe(false);
    expect(shownIds()).toEqual([eventId(2)]);
    expect(b.api.activityCalls).toEqual([{ id: P, after: null, limit: 5 }]);
  });

  test("P-11: a re-authentication is a new epoch, so a new memory: the timeline is read again from its first page, to the preview", async () => {
    const a = world(manyEdits(60, phone));
    await a.mount(`/people/${P}`);
    await until("ready");
    press("Show all changes");
    await waitFor(() => expect(shownIds()).toHaveLength(50));
    cleanup();
    const again = world(manyEdits(60, phone), { identity: `${ME}:2` });
    await again.mount(`/people/${P}`);
    await until("ready");
    expect(again.api.activityCalls).toEqual([{ id: P, after: null, limit: 5 }]);
    expect(peopleMemory(`${ME}:2`).activityDepth.get(P)).toBeUndefined();
  });
});

describe("S-AC9 / S-AC10: revoked cursors, lost access and hidden fields", () => {
  test("a 422 on Show older restarts from the first page to the new depth", async () => {
    const w = world(manyEdits(60, phone));
    w.api.next.activity.push(page(manyEdits(5, phone), eventId(5)), {
      ok: false,
      kind: "invalid",
    });
    await w.mount(`/people/${P}`);
    await until("ready");
    press("Show all changes");
    await waitFor(() => expect(shownIds()).toHaveLength(50));
    expect(w.api.activityCalls).toEqual([
      { id: P, after: null, limit: 5 },
      { id: P, after: eventId(5), limit: 45 },
      { id: P, after: null, limit: 50 },
    ]);
  });

  test("three consecutive refused cursors in one re-read: it says it failed", async () => {
    const events = manyEdits(120, phone);
    const w = world(events);
    peopleMemory(`${ME}:1`).activityDepth.set(P, 100);
    for (let i = 0; i < 3; i += 1)
      w.api.next.activity.push(page(events.slice(0, 50), eventId(50)), {
        ok: false,
        kind: "invalid",
      });
    await w.mount(`/people/${P}`);
    await until("failed");
    expect(w.api.activityCalls.map((c) => c.after)).toEqual([
      null,
      eventId(50),
      null,
      eventId(50),
      null,
      eventId(50),
    ]);
    expect(shownIds()).toEqual([]);
  });

  test("a 404 (access lost) drops everything held: no label, no link, no count", async () => {
    const w = world([activityEvent(1, "field_edited", phone)]);
    await w.mount(`/people/${P}`);
    await until("ready");
    expect(sentenceOf(eventId(1))).toBe("You changed the value of Phone.");
    w.api.next.activity.push({ ok: false, kind: "not_found" });
    w.advanceRevision();
    await until("gone");
    expect(shownIds()).toEqual([]);
    expect(section()).toHaveTextContent(
      "You can no longer see this person's changes.",
    );
    expect(section()).not.toHaveTextContent("Phone");
    expect((section() as HTMLElement).querySelector("a")).toBeNull();
  });

  test("a 404 on Show older loses the timeline too", async () => {
    const w = world(manyEdits(60, phone));
    w.api.next.activity.push(page(manyEdits(5, phone), eventId(5)), {
      ok: false,
      kind: "not_found",
    });
    await w.mount(`/people/${P}`);
    await until("ready");
    press("Show all changes");
    await until("gone");
    expect(shownIds()).toEqual([]);
  });

  test("a field that leaves this device (by sync) is withheld at once while the re-read is on its way", async () => {
    const w = world([
      activityEvent(1, "field_edited", fieldTarget(F(2), "Medical note")),
      activityEvent(2, "field_edited", phone),
      activityEvent(3, "person_renamed", ada),
    ]);
    w.putCache(fieldRow({ id: F(2), parent_id: P, label: "Medical note" }));
    await w.mount(`/people/${P}`);
    await until("ready");
    expect(shownIds()).toEqual([eventId(1), eventId(2), eventId(3)]);
    const held = deferred<PeopleResult<PersonActivityPage>>();
    w.api.next.activity.push(() => held.promise);
    // The narrowing arrives by sync: the field leaves the cache, and the applied revision moves.
    act(() => {
      w.cache.delete(F(2));
    });
    w.advanceRevision();
    await until("loading");
    await waitFor(() => expect(shownIds()).toEqual([eventId(2), eventId(3)]));
    expect(section()).not.toHaveTextContent("Medical note");
    expect(section()?.querySelector("[aria-busy='true']")).not.toBeNull();
    held.resolve(
      page(
        [
          activityEvent(2, "field_edited", phone),
          activityEvent(3, "person_renamed", ada),
        ],
        null,
      ),
    );
    await until("ready");
    expect(shownIds()).toEqual([eventId(2), eventId(3)]);
  });
});

describe("S-AC11 / S-AC15: current names, honest coverage, nothing made up", () => {
  test("a field renamed to remove sensitive wording shows only its new label on all of its events after a refresh", async () => {
    const before = fieldTarget(F(2), "Diagnosis: example");
    const w = world([
      activityEvent(1, "field_edited", before, { changed: ["value"] }),
      activityEvent(2, "field_created", before),
    ]);
    await w.mount(`/people/${P}`);
    await until("ready");
    expect(section()).toHaveTextContent("Diagnosis: example");
    const after = fieldTarget(F(2), "Medical note");
    w.api.activity.events.set(P, [
      activityEvent(0, "field_edited", after, { changed: ["label"] }),
      activityEvent(1, "field_edited", after, { changed: ["value"] }),
      activityEvent(2, "field_created", after),
    ]);
    w.advanceRevision();
    await waitFor(() => expect(shownIds()).toHaveLength(3));
    expect(section()).not.toHaveTextContent("Diagnosis");
    expect(sentenceOf(eventId(0))).toBe(
      "You changed the name of Medical note.",
    );
  });

  test("coverage is the server's coverage_started_at, never the oldest event; start reached only when nothing earlier exists", async () => {
    const w = world([activityEvent(1, "field_edited", phone)]);
    // 1 October 2026, 12:00 UTC: weeks before the only event.
    w.api.activity.coverage = 1790856000;
    await w.mount(`/people/${P}`);
    await until("ready");
    expect(section()).toHaveTextContent("Recorded since 1 Oct 2026.");
    expect(section()).toHaveTextContent("Earlier changes weren't recorded.");
    expect(section()).toHaveTextContent(
      "Shows changes to what you can see now, with current names.",
    );
    cleanup();
    forgetAllPeopleMemory();
    const more = world(manyEdits(6, phone));
    await more.mount(`/people/${P}`);
    await until("ready");
    expect(section()).not.toHaveTextContent(
      "Earlier changes weren't recorded.",
    );
    expect(section()).toHaveTextContent("Recorded since 4 Nov 2026.");
  });

  test("this device's unsent saves never appear as events: the confirmed-empty timeline stays empty", async () => {
    const w = world([]);
    w.setDrafts([
      draftRow({
        local_id: "f1",
        created_seq: 1,
        endpoint: "/task-commands",
        command: {
          command: {
            kind: "put_field",
            id: F(5),
            parent_id: P,
            label: "Email",
            value: { kind: "text", text: "a@example.org" },
          },
        },
      }),
    ]);
    await w.mount(`/people/${P}`);
    await until("ready");
    expect(shownIds()).toEqual([]);
    expect(section()).toHaveTextContent(
      "No changes recorded since 4 Nov 2026.",
    );
    expect(section()).not.toHaveTextContent("Email");
  });
});

describe("S-AC13: loading, empty, offline, failed, older-failed, gone", () => {
  test("loading is busy and says so; then confirmed empty", async () => {
    const held = deferred<PeopleResult<PersonActivityPage>>();
    const w = world([]);
    w.api.next.activity.push(() => held.promise);
    await w.mount(`/people/${P}`);
    await until("loading");
    expect(
      within(section() as HTMLElement).getByText("Checking recent changes…"),
    ).toHaveAttribute("aria-busy", "true");
    held.resolve(page([], null));
    await until("ready");
    expect(section()).toHaveTextContent(
      "No changes recorded since 4 Nov 2026.",
    );
  });

  test("offline: unavailable and nothing earlier shown; back online it reads again", async () => {
    const w = world([activityEvent(1, "field_edited", phone)]);
    await w.mount(`/people/${P}`);
    await until("ready");
    w.setOnline(false);
    await until("offline");
    expect(shownIds()).toEqual([]);
    expect(section()).toHaveTextContent(
      "Recent changes are shown when you're online.",
    );
    const before = w.api.activityCalls.length;
    w.setOnline(true);
    await until("ready");
    expect(w.api.activityCalls.length).toBe(before + 1);
    expect(shownIds()).toEqual([eventId(1)]);
  });

  test("mounted offline: no read at all", async () => {
    const w = world([activityEvent(1, "field_edited", phone)], {
      online: false,
    });
    await w.mount(`/people/${P}`);
    await until("offline");
    expect(w.api.activityCalls).toEqual([]);
  });

  test("an older step that fails keeps what is shown, says so, and Try again reads that step again", async () => {
    const events = manyEdits(60, phone);
    const w = world(events);
    w.api.next.activity.push(page(events.slice(0, 5), eventId(5)), {
      ok: false,
      kind: "uncertain",
    });
    await w.mount(`/people/${P}`);
    await until("ready");
    press("Show all changes");
    await waitFor(() =>
      expect(section()).toHaveTextContent("Couldn't load older changes."),
    );
    expect(shownIds()).toHaveLength(5);
    press("Try again");
    await waitFor(() => expect(shownIds()).toHaveLength(50));
    expect(w.api.activityCalls.slice(1)).toEqual([
      { id: P, after: eventId(5), limit: 45 },
      { id: P, after: eventId(5), limit: 45 },
    ]);
  });

  test("an answer that is not the contract's (a sharing row) is not shown in part: failed, with Try again", async () => {
    const w = world([]);
    w.api.next.activity.push({ ok: false, kind: "uncertain" });
    await w.mount(`/people/${P}`);
    await until("failed");
    expect(
      within(section() as HTMLElement).getByRole("button", {
        name: "Try again",
      }),
    ).toBeEnabled();
  });

  test("a projected (unpublished) person has no Recent changes", async () => {
    const w = peopleWorld();
    w.setCache([]);
    w.setDrafts([
      draftRow({
        local_id: "p1",
        created_seq: 1,
        command: {
          commands: [{ kind: "create_person", id: P, name: "New Ada" }],
        },
      }),
    ]);
    await w.mount(`/people/${P}`);
    await waitFor(() =>
      expect(document.querySelector("[data-person-detail]")).not.toBeNull(),
    );
    expect(section()).toBeNull();
    expect(w.api.activityCalls).toEqual([]);
  });
});

describe("S-AC14: keyboard and screen reader", () => {
  test("a named region with a list of items and times; Show older moves focus to the first new item and says how many", async () => {
    const w = world(manyEdits(60, phone));
    await w.mount(`/people/${P}`);
    await until("ready");
    const region = within(document.body).getByRole("region", {
      name: "Recent changes",
    });
    expect(within(region).getByRole("list")).toBeInTheDocument();
    expect(within(region).getAllByRole("listitem")).toHaveLength(5);
    press("Show all changes");
    await waitFor(() => expect(shownIds()).toHaveLength(50));
    await waitFor(() =>
      expect(document.activeElement?.getAttribute("data-activity-event")).toBe(
        eventId(6),
      ),
    );
    await waitFor(() =>
      expect(document.body).toHaveTextContent("45 older changes shown."),
    );
    press("Show older changes");
    await waitFor(() => expect(shownIds()).toHaveLength(60));
    await waitFor(() =>
      expect(document.activeElement?.getAttribute("data-activity-event")).toBe(
        eventId(51),
      ),
    );
    press("Show fewer");
    await waitFor(() => expect(shownIds()).toHaveLength(5));
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe("Show all changes"),
    );
    expect((await axe(region)).violations).toEqual([]);
  });
});

describe("R-1: a refresh keeps the timeline's tree (keyboard and screen reader across a re-read)", () => {
  /** Holds the next read's first page until `resolve`; the pages after it are the fake server's. */
  const holdNextRead = (w: PeopleWorld) => {
    const held = deferred<PeopleResult<PersonActivityPage>>();
    w.api.next.activity.push(() => held.promise);
    return held;
  };
  const item = (n: number) =>
    document.querySelector(
      `[data-activity-event="${eventId(n)}"]`,
    ) as HTMLElement | null;
  const button = (name: string) =>
    within(section() as HTMLElement).queryByRole("button", { name });

  test("a refresh keeps the list's nodes, its controls and keyboard focus while the re-read is on its way, and after it", async () => {
    const events = manyEdits(60, phone);
    const w = world(events);
    await w.mount(`/people/${P}`);
    await until("ready");
    press("Show all changes");
    await waitFor(() => expect(shownIds()).toHaveLength(50));
    const older = button("Show older changes") as HTMLElement;
    older.focus();
    const first = item(1);
    const list = section()?.querySelector("ul");
    const held = holdNextRead(w);
    act(() => {
      w.advanceRevision();
    });
    await until("loading");
    expect(shownIds()).toHaveLength(50);
    expect(item(1)).toBe(first);
    expect(section()?.querySelector("ul")).toBe(list);
    expect(button("Show older changes")).toBe(older);
    expect(button("Show fewer")).not.toBeNull();
    expect(document.activeElement).toBe(older);
    expect(section()?.querySelector("[aria-busy='true']")).not.toBeNull();
    held.resolve(page(events.slice(0, 50), eventId(50)));
    await until("ready");
    expect(item(1)).toBe(first);
    expect(button("Show older changes")).toBe(older);
    expect(document.activeElement).toBe(older);
    expect(section()?.querySelector("[aria-busy='true']")).toBeNull();
  });

  test("the item Show all moved focus to keeps it across a refresh, and its announcement is not withdrawn", async () => {
    const events = manyEdits(60, phone);
    const w = world(events);
    await w.mount(`/people/${P}`);
    await until("ready");
    press("Show all changes");
    await waitFor(() =>
      expect(document.activeElement?.getAttribute("data-activity-event")).toBe(
        eventId(6),
      ),
    );
    await waitFor(() =>
      expect(document.body).toHaveTextContent("45 older changes shown."),
    );
    const focused = document.activeElement;
    const held = holdNextRead(w);
    act(() => {
      w.advanceRevision();
    });
    await until("loading");
    expect(document.activeElement).toBe(focused);
    expect(document.body).toHaveTextContent("45 older changes shown.");
    held.resolve(page(events.slice(0, 50), eventId(50)));
    await until("ready");
    expect(document.activeElement).toBe(focused);
    expect(document.body).toHaveTextContent("45 older changes shown.");
  });

  test("a synced change during Show older: the re-read reads to the new depth, then focus moves to the first new item and it says how many", async () => {
    const events = manyEdits(120, phone);
    const w = world(events);
    await w.mount(`/people/${P}`);
    await until("ready");
    press("Show all changes");
    await waitFor(() => expect(shownIds()).toHaveLength(50));
    const step = holdNextRead(w);
    press("Show older changes");
    await waitFor(() =>
      expect(section()).toHaveTextContent("Loading older changes…"),
    );
    act(() => {
      w.advanceRevision();
    });
    await waitFor(() => expect(shownIds()).toHaveLength(100));
    await until("ready");
    await waitFor(() =>
      expect(document.activeElement?.getAttribute("data-activity-event")).toBe(
        eventId(51),
      ),
    );
    await waitFor(() =>
      expect(document.body).toHaveTextContent("50 older changes shown."),
    );
    // The superseded step's answer applies nothing.
    step.resolve(page(events.slice(50, 100), eventId(100)));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(shownIds()).toEqual(events.slice(0, 100).map((e) => e.id));
  });

  test("Show older pressed while a re-read is on its way: that one re-read reads to the new depth (one piece), then focus moves and it says so", async () => {
    const events = manyEdits(120, phone);
    const w = world(events);
    await w.mount(`/people/${P}`);
    await until("ready");
    press("Show all changes");
    await waitFor(() => expect(shownIds()).toHaveLength(50));
    const held = holdNextRead(w);
    act(() => {
      w.advanceRevision();
    });
    await until("loading");
    const calls = w.api.activityCalls.length;
    press("Show older changes");
    expect(section()).toHaveTextContent("Loading older changes…");
    expect(shownIds()).toHaveLength(50);
    // The re-read asked for 50 before the press; once that page is in, it goes on to 100.
    held.resolve(page(events.slice(0, 50), eventId(50)));
    await until("ready");
    await waitFor(() => expect(shownIds()).toHaveLength(100));
    expect(w.api.activityCalls.slice(calls - 1)).toEqual([
      { id: P, after: null, limit: 50 },
      { id: P, after: eventId(50), limit: 50 },
    ]);
    await waitFor(() =>
      expect(document.activeElement?.getAttribute("data-activity-event")).toBe(
        eventId(51),
      ),
    );
    await waitFor(() =>
      expect(document.body).toHaveTextContent("50 older changes shown."),
    );
  });

  test("an item pushed past the 50th by newer events keeps its node and a focused link; no link flashes out while the reads catch up", async () => {
    const email = fieldTarget(F(3), "Email");
    const events = manyEdits(120, phone);
    const w = world(events);
    w.putCache(fieldRow({ id: F(3), parent_id: P, label: "Email" }));
    await w.mount(`/people/${P}`);
    await until("ready");
    press("Show all changes");
    await waitFor(() => expect(shownIds()).toHaveLength(50));
    press("Show older changes");
    await waitFor(() => expect(shownIds()).toHaveLength(100));
    const fiftieth = item(50) as HTMLElement;
    const link = fiftieth.querySelector("[data-activity-link]") as HTMLElement;
    expect(link).not.toBeNull();
    link.focus();
    // What leaves the DOM: whole items (by id), or a link alone (its item kept, the link replaced by plain text).
    const removed: string[] = [];
    const watcher = new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.removedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          const id = node.getAttribute("data-activity-event");
          if (id !== null) removed.push(`item ${id}`);
          else if (
            node.matches("[data-activity-link]") ||
            node.querySelector("[data-activity-link]") !== null
          )
            removed.push("link");
        }
    });
    watcher.observe(section() as HTMLElement, {
      childList: true,
      subtree: true,
    });
    // Another device edits Email: a newer event about another field arrives on the refresh.
    w.api.activity.events.set(P, [
      activityEvent(200, "field_edited", email),
      ...events,
    ]);
    act(() => {
      w.advanceRevision();
    });
    await waitFor(() => expect(shownIds()[0]).toBe(eventId(200)));
    await until("ready");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    watcher.disconnect();
    expect(shownIds().indexOf(eventId(50))).toBe(50);
    expect(item(50)).toBe(fiftieth);
    expect(document.activeElement).toBe(link);
    // Only the oldest, pushed beyond the 100 shown, left; no link flashed out of an item that stayed.
    expect(removed).toEqual([`item ${eventId(100)}`]);
    expect(
      item(200)?.querySelector(`[data-activity-link="${F(3)}"]`),
    ).not.toBeNull();
  });

  test("the rules that drop the earlier answer still drop it: a failed re-read shows no rows and no controls", async () => {
    const events = manyEdits(60, phone);
    const w = world(events);
    await w.mount(`/people/${P}`);
    await until("ready");
    press("Show all changes");
    await waitFor(() => expect(shownIds()).toHaveLength(50));
    const held = holdNextRead(w);
    act(() => {
      w.advanceRevision();
    });
    await until("loading");
    held.resolve({ ok: false, kind: "uncertain" });
    await until("failed");
    expect(shownIds()).toEqual([]);
    expect(button("Show older changes")).toBeNull();
    expect(button("Show fewer")).toBeNull();
  });
});

describe("D-19-4: freshness (joins the summaries' invalidation)", () => {
  const settle = async (w: PeopleWorld) => {
    await w.mount(`/people/${P}`);
    await until("ready");
    return w.api.activityCalls.length;
  };

  test("a synced change, a receipt (queue counts) and a households change each read the timeline again from its first page", async () => {
    const w = world([activityEvent(1, "field_edited", phone)]);
    let count = await settle(w);
    w.advanceRevision();
    await waitFor(() => expect(w.api.activityCalls.length).toBe(count + 1));
    count += 1;
    w.env.set({
      summary: { waiting: 1, needsDecision: 0, held: 0, total: 1, warn: false },
    });
    await waitFor(() => expect(w.api.activityCalls.length).toBe(count + 1));
    expect(w.api.activityCalls.every((c) => c.after === null)).toBe(true);
  });

  test("every 60 seconds while shown and visible, and when the page becomes visible again", async () => {
    const intervals: Array<{ run: () => void; ms: number }> = [];
    const real = globalThis.setInterval;
    vi.spyOn(globalThis, "setInterval").mockImplementation(((
      run: () => void,
      ms: number,
    ) => {
      intervals.push({ run, ms });
      return real(() => {}, 1_000_000);
    }) as typeof setInterval);
    const w = world([activityEvent(1, "field_edited", phone)]);
    const count = await settle(w);
    const refresh = intervals.filter((i) => i.ms === SUMMARY_REFRESH_MS).at(-1);
    expect(SUMMARY_REFRESH_MS).toBe(60_000);
    act(() => refresh?.run());
    await waitFor(() => expect(w.api.activityCalls.length).toBe(count + 1));
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(w.api.activityCalls.length).toBe(count + 2));
  });

  test("an answer that arrives after an invalidation is never shown; the newer read is", async () => {
    const held = deferred<PeopleResult<PersonActivityPage>>();
    const w = world([activityEvent(2, "field_created", phone)]);
    w.api.next.activity.push(() => held.promise);
    await w.mount(`/people/${P}`);
    await until("loading");
    w.advanceRevision();
    await until("ready");
    held.resolve(page([activityEvent(9, "person_renamed", ada)], null));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(shownIds()).toEqual([eventId(2)]);
  });

  test("an online command's receipt (rename_profile) reads the timeline again", async () => {
    const w = world([activityEvent(1, "field_edited", phone)]);
    w.api.linked.set(P, ME);
    const count = await settle(w);
    const header = document.querySelector(
      "[data-identity-header]",
    ) as HTMLElement;
    await within(header).findByText("This is you — you control this profile");
    fireEvent.click(within(header).getByRole("button", { name: "Rename" }));
    fireEvent.change(within(header).getByRole("textbox", { name: "Name" }), {
      target: { value: "Ada L." },
    });
    fireEvent.click(within(header).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(w.api.activityCalls.length).toBeGreaterThan(count),
    );
  });
});
