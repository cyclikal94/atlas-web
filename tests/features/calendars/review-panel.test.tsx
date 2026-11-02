import {
  act,
  cleanup,
  fireEvent,
  screen,
  within,
} from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { CacheRow, DraftRow } from "../../../src/data";
import { admitReceipt, markInFlight } from "../../../src/data/plans/outbox";
import * as words from "../../../src/features/calendars/copy-review";
import {
  parseReview,
  proposedMove,
  resolveReviewRequest,
} from "../../../src/features/calendars/model/review";
import { installMatchMedia } from "../../helpers/match-media";
import { calendarWorld, sourceRow } from "../../support/calendars";
import { cacheRow, draftRow } from "../../support/data/rows";

/**
 * WEB-13b §4.5 (Q22 "resolution of locally available calendar review items"; the wireframe's review panel and its two state cards): the
 * synced reviews' cards, Acknowledge (queued `resolve_review` on the review's version, from one observed read), "Review this move…" for
 * a review whose occurrence was not moved, the private generic card that shows no date, title or task, and "no longer available". Through
 * the PRODUCTION data controller over the IndexedDB double: FIXTURE evidence.
 */
installMatchMedia({ width: 1440 });
/** The control asserted present (an assertion, not a query error, when it is missing), then returned to act on. */
const present = (element: HTMLElement | null): HTMLElement => {
  expect(element).not.toBeNull();
  return element as HTMLElement;
};
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await new Promise((resolve) => setTimeout(resolve, 0));
});

const SOURCE = sourceRow().id;
const TASK = "00000000-0000-4000-8000-0000000000b1";
const EVENT = "00000000-0000-4000-8000-0000000000e1";
const OCC = "00000000-0000-4000-8000-0000000000c1";
const REVIEW = "00000000-0000-4000-8000-0000000000d1";
const slot = (date: string, time: string | null) => ({
  key: `anchor:${EVENT}`,
  date,
  intended_time: time,
  timezone: "Europe/London",
  instant: null,
});
const review = (value: object, over: Partial<CacheRow> = {}) =>
  cacheRow({
    id: REVIEW,
    kind: "review",
    parent_id: OCC,
    label: "Review task",
    value: value as never,
    version: 1,
    ...over,
  });
const context = [
  sourceRow(),
  cacheRow({ id: TASK, kind: "task", label: "Put the bins out", version: 2 }),
  cacheRow({
    id: EVENT,
    kind: "event",
    parent_id: SOURCE,
    label: "Bin day",
    value: { uid: "bin@example" } as never,
  }),
  cacheRow({
    id: OCC,
    kind: "occurrence",
    parent_id: "00000000-0000-4000-8000-0000000000b2",
    label: "Occurrence",
    value: { task_id: TASK, slot: slot("2026-11-02", "18:00:00") } as never,
  }),
];
type World = Awaited<ReturnType<typeof calendarWorld>>;
const drafts = (w: World) => w.rows("drafts") as DraftRow[];
const bodyOf = (w: World, id: string) =>
  (
    w.rows("draft_commands") as Array<{ local_id: string; command: unknown }>
  ).find((row) => row.local_id === id)?.command;
const card = async () => {
  await screen.findByText(words.REVIEWS_HEADING);
  return document.querySelector(`[data-review="${REVIEW}"]`) as HTMLElement;
};

describe("the review model", () => {
  test("strict: the six reasons, a slot only for moved and work_started, nothing else", () => {
    const s = slot("2026-11-02", null);
    expect(
      parseReview({ reason: "work_started", resolved: false, slot: s }),
    ).toMatchObject({
      reason: "work_started",
    });
    expect(
      parseReview({
        reason: "context_unavailable",
        resolved: false,
        slot: null,
      }),
    ).toMatchObject({
      reason: "context_unavailable",
      slot: null,
    });
    expect(
      parseReview({ reason: "context_unavailable", resolved: false, slot: s }),
    ).toBeNull();
    expect(
      parseReview({ reason: "moved", resolved: false, slot: null }),
    ).toBeNull();
    expect(
      parseReview({ reason: "teleported", resolved: false, slot: null }),
    ).toBeNull();
    expect(
      parseReview({ reason: "missing", resolved: false, slot: null, extra: 1 }),
    ).toBeNull();
    expect(
      proposedMove(
        parseReview({
          reason: "work_started",
          resolved: false,
          slot: slot("2026-11-02", "18:00:00"),
        }) as never,
      ),
    ).toBe("2026-11-02T18:00:00");
  });

  test("resolve_review is version-checked on the REVIEW, needs edit access, and shows resolved at once", () => {
    const row = review({ reason: "missing", resolved: false, slot: null });
    const request = resolveReviewRequest(row, "k");
    expect(request.targets).toEqual([
      {
        resourceId: REVIEW,
        role: "primary",
        basis: "resource",
        versionChecked: true,
        requiresEdit: true,
      },
    ]);
    expect(request.build({ [REVIEW]: 4 })).toEqual({
      command: {
        command: {
          kind: "resolve_review",
          id: REVIEW,
          expected_version: 4,
          resolved: true,
        },
      },
      displayPatch: {
        [REVIEW]: { value: { reason: "missing", resolved: true, slot: null } },
      },
    });
  });
});

describe("the cards", () => {
  test("work_started: the wireframe's words, the proposed time, Review this move… (the seeded correction) and Acknowledge (keep current timing)", async () => {
    await calendarWorld({
      cache: [
        ...context,
        review({
          reason: "work_started",
          resolved: false,
          slot: slot("2026-11-03", "18:30:00"),
        }),
      ],
    });
    const item = await card();
    expect(item).toHaveTextContent(words.movedTitle("Put the bins out"));
    expect(item).toHaveTextContent(words.workStartedBody("Family calendar"));
    expect(item).toHaveTextContent(/Tue,? 3 Nov 2026 at 18:30/);
    const link = within(item).getByRole("link", { name: words.REVIEW_MOVE });
    expect(link.getAttribute("href")).toBe(
      `/tasks/${TASK}?occurrence=${OCC}&move=2026-11-03T18%3A30%3A00`,
    );
    expect(
      within(item).getByRole("button", { name: words.ACKNOWLEDGE_KEEP }),
    ).toBeEnabled();
    expect((await axe(document.body)).violations).toEqual([]);
  });

  test("the private generic review shows no date, no title and no task name, only Acknowledge", async () => {
    await calendarWorld({
      cache: [
        ...context,
        review({ reason: "context_unavailable", resolved: false, slot: null }),
      ],
    });
    const item = await card();
    expect(item).toHaveTextContent(words.PRIVATE_GENERIC);
    expect(item.textContent).not.toContain("Put the bins out");
    expect(item.textContent).not.toContain("Bin day");
    expect(item.textContent).not.toContain("Family calendar");
    expect(item.textContent).not.toMatch(/\d{4}|Nov/);
    expect(within(item).queryByRole("link")).toBeNull();
    expect(
      within(item).getByRole("button", { name: words.ACKNOWLEDGE }),
    ).toBeEnabled();
  });

  test.each([
    [
      "moved",
      { reason: "moved", resolved: false, slot: slot("2026-11-01", null) },
      words.followedTitle("Put the bins out"),
    ],
    [
      "cancelled",
      { reason: "cancelled", resolved: false, slot: null },
      words.cancelledTitle("Put the bins out"),
    ],
    [
      "missing",
      { reason: "missing", resolved: false, slot: null },
      words.MISSING_BODY,
    ],
    [
      "no longer eligible",
      { reason: "no_longer_eligible", resolved: false, slot: null },
      words.INELIGIBLE_BODY,
    ],
  ])("%s: its words, Open task and Acknowledge", async (_, value, text) => {
    await calendarWorld({ cache: [...context, review(value)] });
    const item = await card();
    expect(item).toHaveTextContent(text);
    expect(
      within(item).getByRole("link", { name: words.OPEN_TASK }),
    ).toBeInTheDocument();
    expect(
      within(item).getByRole("button", { name: words.ACKNOWLEDGE }),
    ).toBeEnabled();
  });

  test("an unreadable review says it cannot be shown and offers nothing; a resolved one is not shown", async () => {
    await calendarWorld({
      cache: [
        ...context,
        review({ reason: "teleported", resolved: false, slot: null }),
        review(
          { reason: "missing", resolved: true, slot: null },
          { id: "00000000-0000-4000-8000-0000000000d2" },
        ),
      ],
    });
    const item = await card();
    expect(item).toHaveTextContent(words.UNREADABLE);
    expect(within(item).queryByRole("button")).toBeNull();
    expect(
      document.querySelector(
        '[data-review="00000000-0000-4000-8000-0000000000d2"]',
      ),
    ).toBeNull();
  });

  test("a task this device does not hold: 'a task', and Review this move… is unavailable with the reason", async () => {
    await calendarWorld({
      cache: [
        sourceRow(),
        review({
          reason: "work_started",
          resolved: false,
          slot: slot("2026-11-03", null),
        }),
      ],
    });
    const item = await card();
    expect(item).toHaveTextContent(words.movedTitle(words.A_TASK));
    const move = within(item).getByRole("button", { name: words.REVIEW_MOVE });
    expect(move).toBeDisabled();
    expect(move).toHaveAccessibleDescription(words.TASK_NOT_HERE);
  });

  test("a review I cannot edit cannot be acknowledged, with the reason", async () => {
    await calendarWorld({
      cache: [
        ...context,
        review(
          { reason: "missing", resolved: false, slot: null },
          { can_edit: false },
        ),
      ],
    });
    const item = await card();
    const button = within(item).getByRole("button", {
      name: words.ACKNOWLEDGE,
    });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(words.CANT_ACKNOWLEDGE);
  });
});

describe("Acknowledge", () => {
  test("offline: queues resolve_review on the review's version with the observation; the card says it is waiting to send", async () => {
    const w = await calendarWorld({
      online: false,
      cache: [
        ...context,
        review(
          { reason: "missing", resolved: false, slot: null },
          { version: 3 },
        ),
      ],
    });
    const item = await card();
    await w.settle();
    fireEvent.click(
      within(item).getByRole("button", { name: words.ACKNOWLEDGE }),
    );
    fireEvent.click(
      within(item).queryByRole("button", { name: words.ACKNOWLEDGE }) ?? item,
    );
    await w.settle();
    const stored = drafts(w).filter((d) => d.kind === "resolve_review");
    expect(stored).toHaveLength(1);
    expect(bodyOf(w, stored[0]?.local_id as string)).toEqual({
      command: {
        kind: "resolve_review",
        id: REVIEW,
        expected_version: 3,
        resolved: true,
      },
    });
    const now = document.querySelector(
      `[data-review="${REVIEW}"]`,
    ) as HTMLElement;
    expect(now).toHaveTextContent(words.ACKNOWLEDGE_QUEUED);
    expect(
      within(now).queryByRole("button", { name: words.ACKNOWLEDGE }),
    ).toBeNull();
    expect(w.calls).toEqual([]);
  });

  test("a review that changed between showing and pressing is refused as changed (nothing stored); the card shows the new state", async () => {
    const w = await calendarWorld({
      online: false,
      cache: [
        ...context,
        review(
          { reason: "missing", resolved: false, slot: null },
          { version: 3 },
        ),
      ],
    });
    const item = await card();
    await w.settle();
    // Another device's change lands in the SAME turn as the press: the card's read is now older than the store.
    const outbox = w.env.outbox();
    const original = outbox?.enqueue.bind(outbox);
    if (outbox && original)
      vi.spyOn(outbox, "enqueue").mockImplementation(async (request) => {
        await w.commit({
          put: {
            store: "cache",
            rows: [
              review(
                { reason: "missing", resolved: false, slot: null },
                { version: 4 },
              ),
            ],
          },
        });
        return original(request);
      });
    await act(async () => {
      fireEvent.click(
        within(item).getByRole("button", { name: words.ACKNOWLEDGE }),
      );
    });
    await w.settle();
    const spy = outbox?.enqueue as unknown as {
      mock?: { calls: unknown[]; results: Array<{ value: unknown }> };
    };
    const result = await (spy.mock?.results[0]?.value as
      | Promise<unknown>
      | undefined);
    expect({ calls: spy.mock?.calls.length, result }).toEqual({
      calls: 1,
      result: { kind: "refused", reason: "changed" },
    });
    // The refusal is answered after the nested commit's own act scope: let React apply it.
    await w.settle();
    expect(drafts(w).filter((d) => d.kind === "resolve_review")).toEqual([]);
    expect(
      document.querySelector(`[data-review="${REVIEW}"]`),
    ).toHaveTextContent(words.REVIEW_CHANGED);
  });

  test("a review the person was shown that leaves the cache: 'no longer available', both actions disabled", async () => {
    const w = await calendarWorld({
      cache: [
        ...context,
        review({
          reason: "work_started",
          resolved: false,
          slot: slot("2026-11-03", null),
        }),
      ],
    });
    await card();
    await w.commit({ remove: [REVIEW] });
    const gone = document.querySelector(
      `[data-review="${REVIEW}"]`,
    ) as HTMLElement;
    expect(gone.getAttribute("data-review-state")).toBe("gone");
    expect(gone).toHaveTextContent(words.NO_LONGER_AVAILABLE);
    for (const button of within(gone).getAllByRole("button"))
      expect(button).toBeDisabled();
    expect(within(gone).queryByRole("link")).toBeNull();
  });

  test("published resolved (by this device or another), the card simply goes", async () => {
    const w = await calendarWorld({
      cache: [
        ...context,
        review({ reason: "missing", resolved: false, slot: null }),
      ],
    });
    await card();
    await w.commit({
      put: {
        store: "cache",
        rows: [
          review(
            { reason: "missing", resolved: true, slot: null },
            { version: 2 },
          ),
        ],
      },
    });
    expect(document.querySelector(`[data-review="${REVIEW}"]`)).toBeNull();
  });
});

describe("revision 1: every unresolved review stays reachable; a stored acknowledgement's identity is spent (R4, R2's rule)", () => {
  const generic = (i: number, resolved = false) =>
    review(
      { reason: "context_unavailable", resolved, slot: null },
      {
        id: `00000000-0000-4000-8000-${String(i + 1000).padStart(12, "0")}`,
        label: `Review ${String(i).padStart(3, "0")}`,
      },
    );
  const shownIds = () =>
    [...document.querySelectorAll("[data-review]")].map((el) =>
      el.getAttribute("data-review"),
    );
  const more = () =>
    fireEvent.click(
      present(screen.queryByRole("button", { name: words.SHOW_MORE_REVIEWS })),
    );

  test("101 reviews: Show more through page one keeps its earlier cards, then the next page; Show previous reviews brings page one back whole", async () => {
    const rows = Array.from({ length: 101 }, (_, i) => generic(i));
    const w = await calendarWorld({ cache: [sourceRow(), ...rows] });
    await screen.findByText(words.REVIEWS_HEADING);
    await w.settle();
    expect(shownIds()).toHaveLength(20);
    const first = shownIds()[0];
    // Control: within the page, Show more appends.
    more();
    await w.settle();
    expect(shownIds()).toHaveLength(40);
    expect(shownIds()[0]).toBe(first);
    expect(
      screen.queryByRole("button", { name: words.SHOW_PREVIOUS_REVIEWS }),
    ).toBeNull();
    for (let n = 0; n < 3; n += 1) {
      more();
      await w.settle();
    }
    expect(shownIds()).toHaveLength(100);
    // Past the page's last card: the next page, with the way back.
    more();
    await w.settle();
    expect(shownIds()).toHaveLength(1);
    expect(shownIds()).not.toContain(first);
    fireEvent.click(
      present(
        screen.queryByRole("button", { name: words.SHOW_PREVIOUS_REVIEWS }),
      ),
    );
    await w.settle();
    expect(shownIds()).toHaveLength(100);
    expect(shownIds()[0]).toBe(first);
    expect(
      screen.queryByRole("button", { name: words.SHOW_PREVIOUS_REVIEWS }),
    ).toBeNull();
  });

  test("a later page holding only resolved reviews keeps the panel and its way back", async () => {
    const rows = [
      ...Array.from({ length: 100 }, (_, i) => generic(i)),
      ...Array.from({ length: 3 }, (_, i) => generic(100 + i, true)),
    ];
    const w = await calendarWorld({ cache: [sourceRow(), ...rows] });
    await screen.findByText(words.REVIEWS_HEADING);
    await w.settle();
    for (let n = 0; n < 5; n += 1) {
      more();
      await w.settle();
    }
    expect(shownIds()).toEqual([]);
    expect(screen.queryByText(words.REVIEWS_HEADING)).not.toBeNull();
    fireEvent.click(
      present(
        screen.queryByRole("button", { name: words.SHOW_PREVIOUS_REVIEWS }),
      ),
    );
    await w.settle();
    expect(shownIds()).toHaveLength(100);
  });

  test("an acknowledgement stored then discarded: Acknowledge again on the same version is a NEW operation (its own identity)", async () => {
    const w = await calendarWorld({
      online: false,
      cache: [
        ...context,
        review({ reason: "missing", resolved: false, slot: null }),
      ],
    });
    const item = await card();
    await w.settle();
    const outbox = w.env.outbox();
    if (outbox === null) throw new Error("no outbox");
    const enqueue = vi.spyOn(outbox, "enqueue");
    fireEvent.click(
      within(item).getByRole("button", { name: words.ACKNOWLEDGE }),
    );
    await w.settle();
    const [stored] = drafts(w).filter((d) => d.kind === "resolve_review");
    expect(stored).toBeDefined();
    await outbox.discard(stored?.local_id as string);
    await w.settle();
    const again = document.querySelector(
      `[data-review="${REVIEW}"]`,
    ) as HTMLElement;
    fireEvent.click(
      await within(again).findByRole("button", { name: words.ACKNOWLEDGE }),
    );
    await w.settle();
    const keys = enqueue.mock.calls.map(([request]) => request.localId);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
    expect(drafts(w).filter((d) => d.kind === "resolve_review")).toHaveLength(
      1,
    );
  });
});

describe("revision 12 (review 13 R8): the card shows and acknowledges ONE reading of its review", () => {
  type Held = "list" | "view";
  /**
   * The review list's watch and the card's resource-view watch, each of which can be HELD: the store commits and the watch reads on, but
   * its publication to the screen waits (`release` publishes the newest reading). The real watches, plans and outbox underneath; nothing
   * is fabricated. Mounted again (a new tree over the same page runtime, as production) so that the screen subscribes through them.
   */
  const publications = async (w: World, initially: Held[] = []) => {
    const store = w.env.service()?.store;
    if (store === undefined) throw new Error("no service");
    const watch = store.watch.bind(store);
    const held = new Set<Held>(initially);
    const waiting = new Map<Held, Set<() => void>>([
      ["list", new Set()],
      ["view", new Set()],
    ]);
    const count = { list: 0, view: 0 };
    const subscribed = { list: 0, view: 0 };
    await w.detach();
    vi.spyOn(store, "watch").mockImplementation(((
      plan: { name: string },
      input: { kind?: string; id?: string },
    ) => {
      const source = watch(plan as never, input as never);
      const which: Held | null =
        plan.name === "data.readResourceList" && input.kind === "review"
          ? "list"
          : plan.name === "data.readResourceView" && input.id === REVIEW
            ? "view"
            : null;
      if (which === null) return source;
      subscribed[which] += 1;
      let snapshot = source.get();
      return {
        get: () => {
          if (!held.has(which)) snapshot = source.get();
          return snapshot;
        },
        subscribe: (listener: () => void) => {
          const publish = () => {
            snapshot = source.get();
            listener();
          };
          const off = source.subscribe(() => {
            if (!held.has(which)) return publish();
            count[which] += 1;
            waiting.get(which)?.add(publish);
          });
          return () => {
            waiting.get(which)?.delete(publish);
            off();
          };
        },
      };
    }) as never);
    await w.attach();
    return {
      hold: (which: Held) => held.add(which),
      async release(which: Held) {
        held.delete(which);
        const queue = [...(waiting.get(which) ?? [])];
        waiting.get(which)?.clear();
        await act(async () => {
          for (const publish of queue) publish();
        });
        await w.settle();
      },
      /** Publications held back so far: a held order is asserted to have happened, not assumed. */
      count,
      subscribed,
    };
  };
  const shown = () =>
    document.querySelector(`[data-review="${REVIEW}"]`) as HTMLElement | null;
  const reviewDrafts = (w: World) =>
    drafts(w).filter((d) => d.kind === "resolve_review");
  const press = async (w: World, name: string) => {
    const item = present(shown());
    await act(async () => {
      fireEvent.click(within(item).getByRole("button", { name }));
    });
    await w.settle();
  };
  /** A sync's publication of the review: its row and the version the outbox assumes, in one transaction (W1). */
  const publish = (w: World, row: CacheRow) =>
    w.commit({
      put: { store: "cache", rows: [row] },
      versions: [
        {
          resource_id: REVIEW,
          locally_assumed_version: row.version,
          basis: "resource",
        },
      ],
    });
  const start = async (
    rows: CacheRow[],
    initially: Held[] = [],
    extra = {},
  ) => {
    const w = await calendarWorld({
      production: true,
      validCache: true,
      online: false,
      cache: rows,
      ...extra,
    });
    await screen.findByText(words.REVIEWS_HEADING);
    await w.settle();
    const p = await publications(w, initially);
    await w.settle();
    return { w, p };
  };
  const missing3 = review(
    { reason: "missing", resolved: false, slot: null },
    { version: 3 },
  );
  const cancelled4 = review(
    { reason: "cancelled", resolved: false, slot: null },
    { version: 4 },
  );
  /** What a stored acknowledgement resolves: its version and the review value its display patch says. */
  const resolves = (w: World, d: DraftRow) => ({
    expected_version: d.expected_version,
    reason: (
      d.display_patch?.[REVIEW] as { value?: { reason?: string } } | undefined
    )?.value?.reason,
    body: bodyOf(w, d.local_id),
  });

  test("R8 control: both publications through, the card shows the newer review and Acknowledge resolves that one, once", async () => {
    const { w, p } = await start([...context, missing3]);
    expect(p.subscribed.list).toBeGreaterThan(0);
    expect(p.subscribed.view).toBeGreaterThan(0);
    await publish(w, cancelled4);
    expect(present(shown()).getAttribute("data-review-reason")).toBe(
      "cancelled",
    );
    await press(w, words.ACKNOWLEDGE);
    const stored = reviewDrafts(w);
    expect(stored).toHaveLength(1);
    expect(resolves(w, stored[0] as DraftRow)).toEqual({
      expected_version: 4,
      reason: "cancelled",
      body: {
        command: {
          kind: "resolve_review",
          id: REVIEW,
          expected_version: 4,
          resolved: true,
        },
      },
    });
    expect(w.calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  test("R8 (view first, list held): the card shows the reading Acknowledge is built from, so what it resolves is what it shows", async () => {
    const { w, p } = await start([...context, missing3]);
    p.hold("list");
    await publish(w, cancelled4);
    expect(p.count.list).toBeGreaterThan(0);
    const item = present(shown());
    // The card's own reading reached it: it shows the newer review although the list has not published it.
    expect(item.getAttribute("data-review-reason")).toBe("cancelled");
    expect(item).toHaveTextContent(words.cancelledTitle("Put the bins out"));
    expect(item.textContent).not.toContain(words.MISSING_BODY);
    await press(w, words.ACKNOWLEDGE);
    const stored = reviewDrafts(w);
    expect(stored).toHaveLength(1);
    expect(resolves(w, stored[0] as DraftRow)).toMatchObject({
      expected_version: 4,
      reason: "cancelled",
    });
    expect(w.calls.filter((c) => c.method === "POST")).toEqual([]);
    await p.release("list");
    expect(reviewDrafts(w)).toHaveLength(1);
  });

  test("R8 (list first, view held): the card keeps showing what its reading saw; Acknowledge of that older review is refused as changed, nothing stored", async () => {
    const { w, p } = await start([...context, missing3]);
    p.hold("view");
    await publish(w, cancelled4);
    expect(p.count.view).toBeGreaterThan(0);
    const item = present(shown());
    // The list's newer copy is not mixed into the card: it shows the one reading it has.
    expect(item.getAttribute("data-review-reason")).toBe("missing");
    expect(item).toHaveTextContent(words.MISSING_BODY);
    await press(w, words.ACKNOWLEDGE);
    expect(reviewDrafts(w)).toEqual([]);
    expect(present(shown())).toHaveTextContent(words.REVIEW_CHANGED);
    // Its reading published: the newer review shown, and acknowledged as shown.
    await p.release("view");
    expect(present(shown()).getAttribute("data-review-reason")).toBe(
      "cancelled",
    );
    await press(w, words.ACKNOWLEDGE);
    const stored = reviewDrafts(w);
    expect(stored).toHaveLength(1);
    expect(resolves(w, stored[0] as DraftRow)).toMatchObject({
      expected_version: 4,
      reason: "cancelled",
    });
    expect(w.calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  test.each(["list", "view"] as const)(
    "R8 Acknowledge (keep current timing), %s held: the proposed slot shown, the link and what is resolved agree",
    async (which) => {
      const started = (date: string, time: string, version: number) =>
        review(
          { reason: "work_started", resolved: false, slot: slot(date, time) },
          { version },
        );
      const { w, p } = await start([
        ...context,
        started("2026-11-03", "18:30:00", 3),
      ]);
      p.hold(which);
      await publish(w, started("2026-11-04", "09:15:00", 4));
      expect(p.count[which]).toBeGreaterThan(0);
      const item = present(shown());
      const link = within(item).getByRole("link", { name: words.REVIEW_MOVE });
      // The reading the card has: the newer one when the list is held, the older one when the card's own reading is.
      const [day, move, version] =
        which === "list"
          ? [/Wed,? 4 Nov 2026 at 09:15/, "2026-11-04T09%3A15%3A00", 4]
          : [/Tue,? 3 Nov 2026 at 18:30/, "2026-11-03T18%3A30%3A00", 3];
      expect(item).toHaveTextContent(day);
      expect(link.getAttribute("href")).toBe(
        `/tasks/${TASK}?occurrence=${OCC}&move=${move}`,
      );
      await press(w, words.ACKNOWLEDGE_KEEP);
      const stored = reviewDrafts(w);
      if (which === "list") {
        expect(stored).toHaveLength(1);
        const d = stored[0] as DraftRow;
        expect(d.expected_version).toBe(version);
        expect(
          (
            d.display_patch?.[REVIEW] as
              | { value?: { slot?: { date?: string } } }
              | undefined
          )?.value?.slot?.date,
        ).toBe("2026-11-04");
      } else {
        expect(stored).toEqual([]);
        expect(present(shown())).toHaveTextContent(words.REVIEW_CHANGED);
      }
      // The current timing is kept: no correction is stored and nothing moves the occurrence.
      expect(drafts(w).filter((d) => d.kind !== "resolve_review")).toEqual([]);
      expect(w.calls.filter((c) => c.method === "POST")).toEqual([]);
    },
  );

  /** An acknowledgement that the server refused as a version conflict, on the review's version 3. */
  const conflicted = () =>
    draftRow({
      local_id: "00000000-0000-4000-8000-00000000c0f1",
      created_seq: 1,
      endpoint: "/calendar-commands",
      command: {
        command: {
          kind: "resolve_review",
          id: REVIEW,
          expected_version: 3,
          resolved: true,
        },
      },
      target_resource_ids: [REVIEW],
      index_targets: [REVIEW],
      bases: { [REVIEW]: 3 },
      bumped: [REVIEW],
      expected_version: 3,
      status: "version_conflict",
    });

  test.each(["list", "view"] as const)(
    "R8 conflict, Acknowledge again with the %s held: the conflict shown is replaced once by what is shown, or refused with the conflict kept",
    async (which) => {
      const { w, p } = await start([...context, missing3], [], {
        drafts: [conflicted()],
      });
      const before = present(shown());
      expect(before).toHaveTextContent(words.REVIEW_CONFLICT);
      p.hold(which);
      await publish(w, cancelled4);
      expect(p.count[which]).toBeGreaterThan(0);
      const item = present(shown());
      expect(item).toHaveTextContent(words.REVIEW_CONFLICT);
      expect(item.getAttribute("data-review-reason")).toBe(
        which === "list" ? "cancelled" : "missing",
      );
      await press(w, words.ACKNOWLEDGE_AGAIN);
      const stored = reviewDrafts(w);
      if (which === "list") {
        expect(stored).toHaveLength(1);
        const d = stored[0] as DraftRow;
        expect(d.local_id).not.toBe(conflicted().local_id);
        expect(resolves(w, d)).toMatchObject({
          expected_version: 4,
          reason: "cancelled",
        });
      } else {
        // Refused: the conflicted acknowledgement stays exactly as it was, and nothing new is stored.
        expect(stored.map((d) => [d.local_id, d.status])).toEqual([
          [conflicted().local_id, "version_conflict"],
        ]);
        expect(present(shown())).toHaveTextContent(words.REVIEW_CHANGED);
      }
      expect(w.calls.filter((c) => c.method === "POST")).toEqual([]);
    },
  );

  test("R8 conflict, a change between pressing Acknowledge again and the replacement's write: refused as changed, the conflict kept", async () => {
    const { w } = await start([...context, missing3], [], {
      drafts: [conflicted()],
    });
    const outbox = w.env.outbox();
    if (outbox === null) throw new Error("no outbox");
    const original = outbox.supersede.bind(outbox);
    const supersede = vi
      .spyOn(outbox, "supersede")
      .mockImplementation(async (id, request) => {
        await publish(w, cancelled4);
        return original(id, request);
      });
    await press(w, words.ACKNOWLEDGE_AGAIN);
    await w.settle();
    expect(supersede).toHaveBeenCalledTimes(1);
    expect(await supersede.mock.results[0]?.value).toEqual({
      kind: "refused",
      reason: "changed",
    });
    expect(reviewDrafts(w).map((d) => [d.local_id, d.status])).toEqual([
      [conflicted().local_id, "version_conflict"],
    ]);
  });

  test("R8 privacy (list held): a review that became private shows the generic card at once: no task, no date, no link", async () => {
    const { w, p } = await start([...context, missing3]);
    expect(present(shown())).toHaveTextContent("Put the bins out");
    p.hold("list");
    await publish(
      w,
      review(
        { reason: "context_unavailable", resolved: false, slot: null },
        { version: 4 },
      ),
    );
    expect(p.count.list).toBeGreaterThan(0);
    const item = present(shown());
    expect(item).toHaveTextContent(words.PRIVATE_TITLE);
    expect(item).toHaveTextContent(words.PRIVATE_GENERIC);
    expect(item.textContent).not.toContain("Put the bins out");
    expect(item.textContent).not.toMatch(/\d{4}|Nov/);
    expect(within(item).queryByRole("link")).toBeNull();
  });

  test("R8 navigation (list held): a review moved to another occurrence links to THAT occurrence's task", async () => {
    const TASK2 = "00000000-0000-4000-8000-0000000000b3";
    const OCC2 = "00000000-0000-4000-8000-0000000000c2";
    const { w, p } = await start([
      ...context,
      cacheRow({ id: TASK2, kind: "task", label: "Water the plants" }),
      cacheRow({
        id: OCC2,
        kind: "occurrence",
        parent_id: "00000000-0000-4000-8000-0000000000b4",
        label: "Occurrence",
        value: {
          task_id: TASK2,
          slot: slot("2026-11-05", "08:00:00"),
        } as never,
      }),
      missing3,
    ]);
    expect(
      within(present(shown()))
        .getByRole("link", { name: words.OPEN_TASK })
        .getAttribute("href"),
    ).toBe(`/tasks/${TASK}?occurrence=${OCC}`);
    p.hold("list");
    await publish(
      w,
      review(
        { reason: "missing", resolved: false, slot: null },
        { version: 4, parent_id: OCC2 },
      ),
    );
    expect(p.count.list).toBeGreaterThan(0);
    const item = present(shown());
    expect(item).toHaveTextContent(words.missingTitle("Water the plants"));
    expect(
      within(item)
        .getByRole("link", { name: words.OPEN_TASK })
        .getAttribute("href"),
    ).toBe(`/tasks/${TASK2}?occurrence=${OCC2}`);
  });

  test("R8 permission (list held): edit access lost at the same version: Acknowledge is unavailable with the reason", async () => {
    const { w, p } = await start([...context, missing3]);
    p.hold("list");
    await publish(
      w,
      review(
        { reason: "missing", resolved: false, slot: null },
        { version: 3, can_edit: false },
      ),
    );
    expect(p.count.list).toBeGreaterThan(0);
    const button = within(present(shown())).getByRole("button", {
      name: words.ACKNOWLEDGE,
    });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(words.CANT_ACKNOWLEDGE);
  });

  test("R8 gone (list held): a review that left the cache is 'no longer available', with nothing to press or follow", async () => {
    const { w, p } = await start([...context, missing3]);
    p.hold("list");
    await w.commit({ remove: [REVIEW] });
    expect(p.count.list).toBeGreaterThan(0);
    const item = present(shown());
    expect(item.getAttribute("data-review-state")).toBe("gone");
    expect(item).toHaveTextContent(words.NO_LONGER_AVAILABLE);
    expect(item.textContent).not.toContain(words.MISSING_BODY);
    for (const button of within(item).getAllByRole("button"))
      expect(button).toBeDisabled();
    expect(within(item).queryByRole("link")).toBeNull();
  });

  test("R8 resolved (list held): a review published resolved goes from the screen", async () => {
    const { w, p } = await start([...context, missing3]);
    p.hold("list");
    await publish(
      w,
      review({ reason: "missing", resolved: true, slot: null }, { version: 4 }),
    );
    expect(p.count.list).toBeGreaterThan(0);
    expect(shown()).toBeNull();
    expect(
      screen.queryByRole("button", { name: words.ACKNOWLEDGE }),
    ).toBeNull();
  });

  test("R8 loading: until the card's own reading arrives it shows neither the list's copy nor an action", async () => {
    const { w, p } = await start([...context, missing3], ["view"]);
    const item = present(shown());
    expect(item.getAttribute("data-review-state")).toBe("loading");
    expect(item).toHaveAttribute("aria-busy", "true");
    expect(item).toHaveTextContent(words.REVIEW_LOADING);
    expect(item.textContent).not.toContain("Put the bins out");
    expect(within(item).queryByRole("button")).toBeNull();
    expect(within(item).queryByRole("link")).toBeNull();
    await p.release("view");
    const ready = present(shown());
    expect(ready.getAttribute("data-review-reason")).toBe("missing");
    expect(
      within(ready).getByRole("button", { name: words.ACKNOWLEDGE }),
    ).toBeEnabled();
    expect(reviewDrafts(w)).toEqual([]);
  });
});

describe("revision 23 (review 27 F27-1): leaving a bounded page is not leaving the cache", () => {
  /** Reviews whose ids sort by `n` (the page's order), private and generic, under one occurrence (as a private review's cache row is). */
  const rid = (n: number) =>
    `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const many = (n: number, resolved = false, over: Partial<CacheRow> = {}) =>
    review(
      { reason: "context_unavailable", resolved, slot: null },
      { id: rid(n), label: `Review ${n}`, ...over },
    );
  const range = (from: number, count: number) =>
    Array.from({ length: count }, (_, i) => many(from + i));
  const item = (n: number) =>
    document.querySelector(`[data-review="${rid(n)}"]`) as HTMLElement | null;
  const states = () =>
    [...document.querySelectorAll("[data-review]")].map(
      (el) =>
        `${el.getAttribute("data-review")}:${el.getAttribute("data-review-state")}`,
    );
  const gone = () =>
    [...document.querySelectorAll('[data-review-state="gone"]')].map((el) =>
      el.getAttribute("data-review"),
    );
  const click = async (w: World, name: string) => {
    await act(async () => {
      fireEvent.click(present(screen.queryByRole("button", { name })));
    });
    await w.settle();
  };
  /** Shows the whole of page one (Show more until it holds no more), as a person reading every card does. */
  const showAll = async (w: World) => {
    for (let n = 0; n < 4; n += 1) await click(w, words.SHOW_MORE_REVIEWS);
  };
  const start = async (rows: CacheRow[], extra = {}) => {
    const w = await calendarWorld({ cache: [sourceRow(), ...rows], ...extra });
    await screen.findByText(words.REVIEWS_HEADING);
    await w.settle();
    return w;
  };
  const cached = (w: World, n: number) =>
    (w.rows("cache") as CacheRow[]).find((row) => row.id === rid(n));
  /**
   * The id reads (`readResourcesById`) of the panel, recorded, and each one-id read can be HELD: the store commits and the watch reads on,
   * but its publication waits until `release`. The real watches and plans underneath; installed on the mounted controller's store, before
   * the reads it records are made.
   */
  const idReads = (w: World) => {
    const store = w.env.service()?.store;
    if (store === undefined) throw new Error("no service");
    const watch = store.watch.bind(store);
    const asked: string[][] = [];
    const held = new Set<string>();
    const waiting = new Map<string, Set<() => void>>();
    const heldCount = new Map<string, number>();
    vi.spyOn(store, "watch").mockImplementation(((
      plan: { name: string },
      input: { ids?: readonly string[] },
    ) => {
      const source = watch(plan as never, input as never);
      if (plan.name !== "data.readResourcesById") return source;
      const ids = [...(input.ids ?? [])];
      asked.push(ids);
      const only = ids.length === 1 ? (ids[0] as string) : null;
      if (only === null) return source;
      let snapshot = source.get();
      return {
        get: () => {
          if (!held.has(only)) snapshot = source.get();
          return snapshot;
        },
        subscribe: (listener: () => void) => {
          const publish = () => {
            snapshot = source.get();
            listener();
          };
          const off = source.subscribe(() => {
            if (!held.has(only)) return publish();
            heldCount.set(only, (heldCount.get(only) ?? 0) + 1);
            const set = waiting.get(only) ?? new Set();
            set.add(publish);
            waiting.set(only, set);
          });
          return () => {
            waiting.get(only)?.delete(publish);
            off();
          };
        },
      };
    }) as never);
    return {
      asked,
      hold: (id: string) => held.add(id),
      heldCount: (id: string) => heldCount.get(id) ?? 0,
      async release(id: string) {
        held.delete(id);
        const queue = [...(waiting.get(id) ?? [])];
        waiting.get(id)?.clear();
        await act(async () => {
          for (const publish of queue) publish();
        });
        await w.settle();
      },
    };
  };

  test("F27-1 boundary shift (all shown): an earlier review moves the 100th to page two; page one says nothing of it, it is open there and Acknowledge queues it", async () => {
    const initial = range(1000, 100);
    const w = await start(initial, { online: false });
    await showAll(w);
    expect(states()).toHaveLength(100);
    expect(item(1099)).toHaveAttribute("data-review-state", "open");
    await w.commit({ put: { store: "cache", rows: [many(999)] } });
    // The displaced review is unchanged in the cache: only the page's boundary moved.
    expect(cached(w, 1099)).toEqual(initial[99]);
    expect(item(999)).toHaveAttribute("data-review-state", "open");
    expect(item(1099)).toBeNull();
    expect(gone()).toEqual([]);
    expect(states()).toHaveLength(100);
    await click(w, words.SHOW_MORE_REVIEWS);
    expect(states()).toEqual([`${rid(1099)}:open`]);
    await act(async () => {
      fireEvent.click(
        within(present(item(1099))).getByRole("button", {
          name: words.ACKNOWLEDGE,
        }),
      );
    });
    await w.settle();
    const stored = drafts(w);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      kind: "resolve_review",
      status: "queued",
      target_resource_ids: [rid(1099)],
      expected_version: 1,
    });
    expect(item(1099)).toHaveAttribute("data-review-state", "queued");
    // Back: page one whole again, still claiming nothing of the review now on page two.
    await click(w, words.SHOW_PREVIOUS_REVIEWS);
    expect(states()).toHaveLength(100);
    expect(item(999)).not.toBeNull();
    expect(item(1099)).toBeNull();
    expect(gone()).toEqual([]);
  });

  test("F27-1 never shown: reviews the page fetched but did not show are not remembered (an insertion or a deletion makes no gone card)", async () => {
    const w = await start(range(1000, 100));
    expect(states()).toHaveLength(20);
    expect(item(1099)).toBeNull();
    await w.commit({ put: { store: "cache", rows: [many(999)] } });
    expect(item(999)).not.toBeNull();
    expect(gone()).toEqual([]);
    // A fetched but never shown review that really leaves the cache: still nothing to say, the person never saw it.
    await w.commit({ remove: [rid(1050)] });
    expect(cached(w, 1050)).toBeUndefined();
    expect(gone()).toEqual([]);
    await showAll(w);
    // Shown now: 999 to 1099 without 1050 is exactly the page.
    expect(states()).toHaveLength(100);
    expect(gone()).toEqual([]);
    // Control: once shown, a review that leaves the cache is said to be gone.
    await w.commit({ remove: [rid(1060)] });
    expect(gone()).toEqual([rid(1060)]);
  });

  test("F27-1 shown, moved off the page, then deleted: page one says it is no longer available, with nothing to press or follow", async () => {
    const w = await start(range(1000, 100));
    await showAll(w);
    await w.commit({ put: { store: "cache", rows: [many(999)] } });
    expect(gone()).toEqual([]);
    await w.commit({ remove: [rid(1099)] });
    expect(cached(w, 1099)).toBeUndefined();
    const left = present(item(1099));
    expect(left.getAttribute("data-review-state")).toBe("gone");
    expect(left).toHaveTextContent(words.NO_LONGER_AVAILABLE);
    expect(left.textContent).not.toContain(words.PRIVATE_GENERIC);
    for (const button of within(left).getAllByRole("button"))
      expect(button).toBeDisabled();
    expect(within(left).queryByRole("link")).toBeNull();
    // One element for the review, never a card and a gone item together.
    expect(
      document.querySelectorAll(`[data-review="${rid(1099)}"]`),
    ).toHaveLength(1);
  });

  test("F27-1 shown, moved off the page, then published resolved: forgotten (never gone), even when later deleted", async () => {
    const w = await start(range(1000, 100));
    await showAll(w);
    await w.commit({ put: { store: "cache", rows: [many(999)] } });
    await w.commit({
      put: { store: "cache", rows: [many(1099, true, { version: 2 })] },
    });
    expect(item(1099)).toBeNull();
    expect(gone()).toEqual([]);
    await w.commit({ remove: [rid(1099)] });
    expect(item(1099)).toBeNull();
    expect(gone()).toEqual([]);
  });

  test("F27-1 a LOCAL acknowledgement is not a published resolution: sent and receipted on page two (its overlay says resolved), the review is still remembered on page one", async () => {
    // A valid cache, as production holds rows in: a receipt shows its overlay only over a valid cache (`decideReceipt`).
    const w = await start(range(1000, 100), {
      online: false,
      validCache: true,
    });
    await showAll(w);
    await w.commit({ put: { store: "cache", rows: [many(999)] } });
    await click(w, words.SHOW_MORE_REVIEWS);
    await act(async () => {
      fireEvent.click(
        within(present(item(1099))).getByRole("button", {
          name: words.ACKNOWLEDGE,
        }),
      );
    });
    await w.settle();
    expect(item(1099)).toHaveAttribute("data-review-state", "queued");
    // A queued draft has no overlay yet (it is written when the draft is claimed): the PRODUCTION claim (W5) and receipt (W6), so the
    // merged review says resolved while the published base does not.
    const stored = drafts(w);
    expect(stored).toHaveLength(1);
    const localId = (stored[0] as DraftRow).local_id;
    const service = w.env.service();
    if (service === null) throw new Error("no service");
    await act(async () => {
      expect(
        await service.commit(markInFlight, {
          captured: service.capture(1),
          localId,
        }),
      ).toMatchObject({ kind: "applied" });
      expect(
        await service.commit(admitReceipt, {
          captured: service.capture(1),
          localId,
          revision: 5,
        }),
      ).toMatchObject({ kind: "applied" });
    });
    await w.settle();
    expect(drafts(w)[0]?.status).toBe("acknowledged");
    // The precondition: the card's reading is the overlay's resolved review (an acknowledged card), the cache's base is unresolved.
    expect(item(1099)).toHaveAttribute("data-review-state", "acknowledged");
    expect(item(1099)).toHaveTextContent(words.ACKNOWLEDGED);
    expect(parseReview(cached(w, 1099)?.value)?.resolved).toBe(false);
    await click(w, words.SHOW_PREVIOUS_REVIEWS);
    expect(item(1099)).toBeNull();
    expect(gone()).toEqual([]);
    // Access lost before the sync that would publish it: the review was shown on page one and has left the cache.
    await w.commit({ remove: [rid(1099)] });
    expect(gone()).toEqual([rid(1099)]);
  });

  test("F27-1 the id read decides, and until it answers nothing is claimed (held answer; deletion; a reinsertion after 'none')", async () => {
    const w = await start(range(1000, 100));
    const reads = idReads(w);
    await showAll(w);
    reads.hold(rid(1099));
    await w.commit({ put: { store: "cache", rows: [many(999)] } });
    expect(reads.asked).toContainEqual([rid(1099)]);
    expect(item(1099)).toBeNull();
    // Deleted while its read's answer is held: not yet known, so not yet said.
    await w.commit({ remove: [rid(1099)] });
    expect(reads.heldCount(rid(1099))).toBeGreaterThan(0);
    expect(gone()).toEqual([]);
    await reads.release(rid(1099));
    expect(gone()).toEqual([rid(1099)]);
    // It comes back (access regained) and onto page one again (999 deleted): the card, once, and no gone item.
    reads.hold(rid(1099));
    await w.commit({
      put: { store: "cache", rows: [many(1099)] },
      remove: [rid(999)],
    });
    expect(
      document.querySelectorAll(`[data-review="${rid(1099)}"]`),
    ).toHaveLength(1);
    expect(item(1099)).toHaveAttribute("data-review-state", "open");
    await reads.release(rid(1099));
    expect(
      document.querySelectorAll(`[data-review="${rid(1099)}"]`),
    ).toHaveLength(1);
    expect(item(1099)).toHaveAttribute("data-review-state", "open");
    // 999 was shown (all of page one was) and has now left the cache: its deletion is said.
    expect(gone()).toEqual([rid(999)]);
  });

  test("F27-1 many remembered reviews: each is asked for by its own id (never a read of more than one), and every one that left is said once", async () => {
    const w = await start(range(1000, 100));
    const reads = idReads(w);
    await showAll(w);
    await w.commit({ remove: range(1000, 100).map((row) => row.id) });
    expect(gone()).toHaveLength(100);
    // The page shows all of its reviews since Show more reached its end: the 30 new ones are drawn at once.
    await w.commit({ put: { store: "cache", rows: range(2000, 30) } });
    expect(
      document.querySelectorAll('[data-review-state="open"]'),
    ).toHaveLength(30);
    await w.commit({ remove: range(2000, 30).map((row) => row.id) });
    const left = gone();
    expect(left).toHaveLength(130);
    expect(new Set(left).size).toBe(130);
    expect(new Set(left)).toEqual(
      new Set([...range(1000, 100), ...range(2000, 30)].map((row) => row.id)),
    );
    // Every id read the panel's gone items made is of one id; none is clipped to a working set.
    const departedReads = reads.asked.filter((ids) =>
      ids.some((id) => left.includes(id)),
    );
    expect(departedReads.length).toBeGreaterThanOrEqual(130);
    for (const ids of departedReads) expect(ids).toHaveLength(1);
  });

  test("F27-1 page two: the cursor's review deleted and one inserted behind the cursor; both ways still work and the inserted one is reachable", async () => {
    const w = await start(range(1000, 101));
    await showAll(w);
    await click(w, words.SHOW_MORE_REVIEWS);
    expect(states()).toEqual([`${rid(1100)}:open`]);
    await w.commit({
      remove: [rid(1099)],
      put: { store: "cache", rows: [many(999)] },
    });
    // Page two is the reviews after the cursor: still 1100, and the way back.
    expect(states()).toEqual([`${rid(1100)}:open`]);
    await click(w, words.SHOW_PREVIOUS_REVIEWS);
    // Page one: 999 (inserted behind the cursor) is reachable; 1099, shown here and deleted, is said to be gone.
    expect(item(999)).toHaveAttribute("data-review-state", "open");
    expect(gone()).toEqual([rid(1099)]);
    expect(
      document.querySelectorAll('[data-review-state="open"]'),
    ).toHaveLength(100);
    await click(w, words.SHOW_MORE_REVIEWS);
    expect(states()).toEqual([`${rid(1100)}:open`]);
  });

  test("F27-1 a card that never drew its review (its reading not yet arrived) is not remembered: deleted, it simply goes", async () => {
    const w = await start([many(1000)]);
    // A new tree whose card's own reading is held, so the card is drawn only as loading.
    const store = w.env.service()?.store;
    if (store === undefined) throw new Error("no service");
    const watch = store.watch.bind(store);
    await w.detach();
    let views = 0;
    // One loading value, the same each time it is read (a new object per read would never settle).
    const loading = { status: "loading" } as const;
    vi.spyOn(store, "watch").mockImplementation(((
      plan: { name: string },
      input: { id?: string },
    ) => {
      const source = watch(plan as never, input as never);
      if (plan.name !== "data.readResourceView" || input.id !== rid(1000))
        return source;
      views += 1;
      return {
        get: () => loading,
        subscribe: () => source.subscribe(() => undefined),
      };
    }) as never);
    await w.attach();
    expect(views).toBeGreaterThan(0);
    expect(item(1000)).toHaveAttribute("data-review-state", "loading");
    await w.commit({ remove: [rid(1000)] });
    expect(item(1000)).toBeNull();
    expect(gone()).toEqual([]);
  });

  test("F27-1 published resolved then deleted while the LIST is held: the card's own reading forgets it, so the list's later news is not 'gone'", async () => {
    const w = await start([many(1000), many(1001)]);
    const store = w.env.service()?.store;
    if (store === undefined) throw new Error("no service");
    const watch = store.watch.bind(store);
    await w.detach();
    let held = false;
    let heldPublications = 0;
    const waiting = new Set<() => void>();
    vi.spyOn(store, "watch").mockImplementation(((
      plan: { name: string },
      input: { kind?: string },
    ) => {
      const source = watch(plan as never, input as never);
      if (plan.name !== "data.readResourceList" || input.kind !== "review")
        return source;
      let snapshot = source.get();
      return {
        get: () => {
          if (!held) snapshot = source.get();
          return snapshot;
        },
        subscribe: (listener: () => void) => {
          const publish = () => {
            snapshot = source.get();
            listener();
          };
          const off = source.subscribe(() => {
            if (!held) return publish();
            heldPublications += 1;
            waiting.add(publish);
          });
          return () => {
            waiting.delete(publish);
            off();
          };
        },
      };
    }) as never);
    await w.attach();
    await screen.findByText(words.REVIEWS_HEADING);
    await w.settle();
    expect(item(1000)).toHaveAttribute("data-review-state", "open");
    held = true;
    await w.commit({
      put: { store: "cache", rows: [many(1000, true, { version: 2 })] },
    });
    // The card's own reading saw the resolution (the list did not): the card goes.
    expect(item(1000)).toBeNull();
    await w.commit({ remove: [rid(1000)] });
    expect(heldPublications).toBeGreaterThan(0);
    held = false;
    await act(async () => {
      for (const publish of [...waiting]) publish();
    });
    await w.settle();
    // The list now lacks it without ever having shown it resolved: it was settled, not lost.
    expect(item(1000)).toBeNull();
    expect(gone()).toEqual([]);
    expect(item(1001)).toHaveAttribute("data-review-state", "open");
  });

  test("F27-1 lifetime: what a panel showed does not outlive it (a remount, the cache invalidated and recovered)", async () => {
    const w = await start(range(1000, 2), {
      production: true,
      validCache: true,
    });
    expect(states()).toEqual([`${rid(1000)}:open`, `${rid(1001)}:open`]);
    await w.commit({ remove: [rid(1000)] });
    expect(gone()).toEqual([rid(1000)]);
    // A new tree: a new panel, which showed nothing yet.
    await w.remount();
    await screen.findByText(words.REVIEWS_HEADING);
    expect(states()).toEqual([`${rid(1001)}:open`]);
    // The cache invalidated (the panel goes with the gate) and replaced by a recovery without 1001: no deletion is inferred from that.
    await w.invalidate();
    expect(screen.queryByText(words.REVIEWS_HEADING)).toBeNull();
    await w.recover([sourceRow(), many(1002)]);
    await screen.findByText(words.REVIEWS_HEADING);
    await w.settle();
    expect(states()).toEqual([`${rid(1002)}:open`]);
  });
});

describe("revision 24 (review 28 F28-1): a published resolution retires the review from every page that showed it", () => {
  /** Reviews whose ids sort by `n` (the page's order), private and generic, under one occurrence (as a private review's cache row is). */
  const rid = (n: number) =>
    `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const many = (n: number, resolved = false, version = 1) =>
    review(
      { reason: "context_unavailable", resolved, slot: null },
      { id: rid(n), label: `Review ${n}`, version },
    );
  const range = (from: number, count: number, step = 1) =>
    Array.from({ length: count }, (_, i) => many(from + i * step));
  const item = (n: number) =>
    document.querySelector(`[data-review="${rid(n)}"]`) as HTMLElement | null;
  const elements = (n: number) =>
    document.querySelectorAll(`[data-review="${rid(n)}"]`).length;
  const states = () =>
    [...document.querySelectorAll("[data-review]")].map(
      (el) =>
        `${el.getAttribute("data-review")}:${el.getAttribute("data-review-state")}`,
    );
  const gone = () =>
    [...document.querySelectorAll('[data-review-state="gone"]')].map((el) =>
      el.getAttribute("data-review"),
    );
  const click = async (w: World, name: string) => {
    await act(async () => {
      fireEvent.click(present(screen.queryByRole("button", { name })));
    });
    await w.settle();
  };
  /** Shows the whole of the current page (Show more until it holds no more), as a person reading every card does. */
  const showAll = async (w: World) => {
    for (let n = 0; n < 4; n += 1) await click(w, words.SHOW_MORE_REVIEWS);
  };
  const next = (w: World) => click(w, words.SHOW_MORE_REVIEWS);
  const back = (w: World) => click(w, words.SHOW_PREVIOUS_REVIEWS);
  const start = async (rows: CacheRow[], extra = {}) => {
    const w = await calendarWorld({ cache: [sourceRow(), ...rows], ...extra });
    await screen.findByText(words.REVIEWS_HEADING);
    await w.settle();
    return w;
  };
  const cached = (w: World, n: number) =>
    (w.rows("cache") as CacheRow[]).find((row) => row.id === rid(n));
  /** Publishes a review's new version (as a sync page does) and asserts the cache holds exactly that published value. */
  const publish = async (
    w: World,
    n: number,
    resolved: boolean,
    version: number,
  ) => {
    await w.commit({
      put: { store: "cache", rows: [many(n, resolved, version)] },
    });
    expect(cached(w, n)).toMatchObject({
      version,
      value: { reason: "context_unavailable", resolved, slot: null },
    });
  };
  const remove = async (w: World, ...ns: number[]) => {
    await w.commit({ remove: ns.map(rid) });
    for (const n of ns) expect(cached(w, n)).toBeUndefined();
  };
  /**
   * The panel's readings of the mounted controller's store, each one able to be HELD or REPLAYED. Installed on that store before the
   * readings it controls are made (the real watches and plans underneath):
   * - `view:<id>` a card's `readResourceView`, `list:<cursor>` (or `list:*` for every page) the page's `readResourceList`, `id:<id>` a
   *   departed review's one-id `readResourcesById`;
   * - HOLD: the store commits and the watch reads on, but `get` keeps its last snapshot and every publication waits until `release`;
   * - REPLAY: a watch made while armed answers `get` with a snapshot captured earlier, the last one a SUBSCRIBED watch of that key served
   *   (what the screen was given; an OLDER publication
   *   delivered after a newer one; stronger than an ordinary delay) until `release`, which publishes the live reading to it.
   * `made` counts the watches made per key and `waited` the publications held, so a test asserts its control was reached.
   */
  const control = (w: World) => {
    const store = w.env.service()?.store;
    if (store === undefined) throw new Error("no service");
    const watch = store.watch.bind(store);
    const held = new Set<string>();
    const replays = new Map<string, unknown>();
    const served = new Map<string, unknown>();
    const releases = new Map<string, Set<() => void>>();
    const made = new Map<string, number>();
    const waited = new Map<string, number>();
    const keyOf = (
      plan: string,
      input: {
        id?: string;
        kind?: string;
        after?: string | null;
        ids?: readonly string[];
      },
    ): string | null => {
      if (plan === "data.readResourceView") return `view:${input.id}`;
      if (plan === "data.readResourceList" && input.kind === "review")
        return `list:${input.after ?? "first"}`;
      if (plan === "data.readResourcesById" && input.ids?.length === 1)
        return `id:${input.ids[0]}`;
      return null;
    };
    vi.spyOn(store, "watch").mockImplementation(((
      plan: { name: string },
      input: never,
    ) => {
      const source = watch(plan as never, input);
      const key = keyOf(plan.name, input);
      if (key === null) return source;
      made.set(key, (made.get(key) ?? 0) + 1);
      let frozen = replays.has(key);
      let snapshot = frozen ? replays.get(key) : source.get();
      let listening = 0;
      const stopped = () =>
        frozen ||
        held.has(key) ||
        (key.startsWith("list:") && held.has("list:*"));
      return {
        get: () => {
          if (!stopped()) snapshot = source.get();
          if (listening > 0) served.set(key, snapshot);
          return snapshot;
        },
        subscribe: (listener: () => void) => {
          const publish = () => {
            snapshot = source.get();
            listener();
          };
          const resume = () => {
            frozen = false;
            publish();
          };
          listening += 1;
          const set = releases.get(key) ?? new Set();
          set.add(resume);
          releases.set(key, set);
          const off = source.subscribe(() => {
            if (!stopped()) return publish();
            waited.set(key, (waited.get(key) ?? 0) + 1);
          });
          return () => {
            listening -= 1;
            set.delete(resume);
            off();
          };
        },
      };
    }) as never);
    return {
      made: (key: string) => made.get(key) ?? 0,
      /** Publications held for `key`, or for every key it begins (`list:`). */
      waited: (key: string) =>
        [...waited].reduce(
          (sum, [k, n]) =>
            k === key || (key.endsWith(":") && k.startsWith(key))
              ? sum + n
              : sum,
          0,
        ),
      hold: (key: string) => held.add(key),
      /** What a subscribed watch of `key` last served, captured to replay later. */
      capture(key: string) {
        if (!served.has(key)) throw new Error(`nothing served for ${key}`);
        return served.get(key);
      },
      replay: (key: string, snapshot: unknown) => replays.set(key, snapshot),
      async release(...keys: string[]) {
        const due: Array<() => void> = [];
        for (const key of keys) {
          held.delete(key);
          replays.delete(key);
          for (const [k, set] of releases)
            if (k === key || (key === "list:*" && k.startsWith("list:")))
              due.push(...set);
        }
        await act(async () => {
          for (const resume of due) resume();
        });
        await w.settle();
      },
    };
  };
  /** 1000 to 1099 all shown on page one, then 999 inserted: 1099 moves to page two, where it is shown too (two pages showed it). */
  const twoPages = async (extra = {}) => {
    const w = await start(range(1000, 100), extra);
    await showAll(w);
    expect(item(1099)).toHaveAttribute("data-review-state", "open");
    await w.commit({ put: { store: "cache", rows: [many(999)] } });
    expect(item(1099)).toBeNull();
    await next(w);
    expect(states()).toEqual([`${rid(1099)}:open`]);
    return w;
  };

  test.each([
    ["published resolved on page two", true],
    ["control: deleted without a resolution", false],
  ])(
    "F28-1 the review's own schedule (shown on page one and on page two, then deleted from page two): %s",
    async (_, resolved) => {
      const w = await twoPages({ online: false });
      if (resolved) {
        await publish(w, 1099, true, 2);
        expect(item(1099)).toBeNull();
      }
      await remove(w, 1099);
      // Page two showed it: deleted unresolved it is said to be gone there too; resolved, nothing is said.
      expect(gone()).toEqual(resolved ? [] : [rid(1099)]);
      await back(w);
      // Page one: 999 to 1098, and (deleted unresolved) its gone item.
      expect(states()).toHaveLength(resolved ? 100 : 101);
      expect(gone()).toEqual(resolved ? [] : [rid(1099)]);
      if (!resolved) {
        const left = present(item(1099));
        expect(left).toHaveTextContent(words.NO_LONGER_AVAILABLE);
        for (const button of within(left).getAllByRole("button"))
          expect(button).toBeDisabled();
      }
      expect(elements(1099)).toBeLessThanOrEqual(1);
    },
  );

  /**
   * Three pages showed X (199000): ids 100000 to 199000 in steps of 1000 all shown on page one; 99999 inserted moves X to page two (shown
   * there); 100 ids inserted between 198000 and X move it on to page three (shown there). The cursors stay [first, after 198000, after
   * 198100]; Y (100000) is an unrelated review page one showed.
   */
  const X = 199000;
  const Y = 100000;
  const threePages = async () => {
    const w = await start(range(100000, 100, 1000));
    await showAll(w);
    expect(item(X)).toHaveAttribute("data-review-state", "open");
    await w.commit({ put: { store: "cache", rows: [many(99999)] } });
    await next(w);
    expect(states()).toEqual([`${rid(X)}:open`]);
    await w.commit({ put: { store: "cache", rows: range(198001, 100) } });
    expect(item(X)).toBeNull();
    await showAll(w);
    expect(
      document.querySelectorAll('[data-review-state="open"]'),
    ).toHaveLength(100);
    await next(w);
    expect(states()).toEqual([`${rid(X)}:open`]);
    expect(gone()).toEqual([]);
    return w;
  };

  test.each([
    ["the last page (its card and list)", "last"],
    ["the middle page (its departed id read)", "middle"],
    ["the first page (its departed id read)", "first"],
  ])(
    "F28-1 three pages showed it, resolved seen on %s: every page's history retires it, back and forth; an unrelated deleted review is still gone",
    async (_, where) => {
      const w = await threePages();
      if (where === "last") {
        await publish(w, X, true, 2);
        expect(item(X)).toBeNull();
        await remove(w, X, Y);
        expect(gone()).toEqual([]);
        await back(w);
        expect(gone()).toEqual([]);
        await back(w);
        expect(gone()).toEqual([rid(Y)]);
        expect(item(X)).toBeNull();
      } else if (where === "middle") {
        await back(w);
        expect(item(X)).toBeNull();
        await publish(w, X, true, 2);
        await remove(w, X, Y);
        expect(gone()).toEqual([]);
        await back(w);
        expect(gone()).toEqual([rid(Y)]);
        expect(item(X)).toBeNull();
      } else {
        await back(w);
        await back(w);
        expect(item(X)).toBeNull();
        await publish(w, X, true, 2);
        await remove(w, X);
        expect(gone()).toEqual([]);
        // Forward again over the same cursor (page one is unchanged): page two showed X too, and says nothing of it.
        await next(w);
        expect(item(198001)).toHaveAttribute("data-review-state", "open");
        expect(gone()).toEqual([]);
        await remove(w, Y);
        await back(w);
        expect(gone()).toEqual([rid(Y)]);
        expect(item(X)).toBeNull();
      }
    },
  );

  test("F28-1 two reviews each shown on two pages, both resolved, the resolution published again (same and newer versions), then deleted: none is gone, an unrelated one is", async () => {
    const w = await start(range(1000, 100));
    await showAll(w);
    await w.commit({ put: { store: "cache", rows: [many(998), many(999)] } });
    await next(w);
    expect(states()).toEqual([`${rid(1098)}:open`, `${rid(1099)}:open`]);
    await publish(w, 1098, true, 2);
    await publish(w, 1099, true, 2);
    expect(states()).toEqual([]);
    // Delivered again: the same resolution, then a newer resolved version. Nothing is shown and nothing loops.
    await publish(w, 1099, true, 2);
    await publish(w, 1098, true, 3);
    expect(states()).toEqual([]);
    await remove(w, 1098, 1099, 1000);
    await back(w);
    expect(gone()).toEqual([rid(1000)]);
    expect(item(1098)).toBeNull();
    expect(item(1099)).toBeNull();
  });

  test("F28-1 the LIST alone sees the resolution (the card's reading held): page one's history retires it; deleted while the card's reading is still held, nothing is said", async () => {
    const w = await start(range(1000, 100));
    const ctl = control(w);
    await showAll(w);
    await w.commit({ put: { store: "cache", rows: [many(999)] } });
    await next(w);
    expect(states()).toEqual([`${rid(1099)}:open`]);
    expect(ctl.made(`view:${rid(1099)}`)).toBeGreaterThan(0);
    ctl.hold(`view:${rid(1099)}`);
    await publish(w, 1099, true, 2);
    // From the hold on, the card's reading answers with what it had (1099 unresolved, version 1) and its publications wait; the card
    // goes with the list's news, so whether one was waiting by then is not asserted. MU-2775 removes the list's retirement.
    // The page's list says resolved: the card goes (its own reading never said so).
    expect(item(1099)).toBeNull();
    await remove(w, 1099);
    expect(gone()).toEqual([]);
    await back(w);
    expect(gone()).toEqual([]);
    await ctl.release(`view:${rid(1099)}`);
    expect(gone()).toEqual([]);
    expect(item(1099)).toBeNull();
  });

  test("F28-1 the CARD alone sees the resolution (the list held): it goes, and deleted while the list is still held nothing is said, before or after the list arrives, here or on page one", async () => {
    const w = await start(range(1000, 100));
    const ctl = control(w);
    await showAll(w);
    await w.commit({ put: { store: "cache", rows: [many(999)] } });
    await next(w);
    expect(states()).toEqual([`${rid(1099)}:open`]);
    ctl.hold("list:*");
    await publish(w, 1099, true, 2);
    expect(ctl.waited("list:")).toBeGreaterThan(0);
    // Only the card's own reading saw it: the card goes while the held list still lists it.
    expect(item(1099)).toBeNull();
    await remove(w, 1099);
    // The card's reading now finds no row; the panel already saw it resolved, so it is not "no longer available".
    expect(item(1099)).toBeNull();
    expect(gone()).toEqual([]);
    await ctl.release("list:*");
    expect(item(1099)).toBeNull();
    expect(gone()).toEqual([]);
    await back(w);
    expect(gone()).toEqual([]);
  });

  test("F28-1 a review the current page fetched resolved but never showed: the list's resolution still retires page one's history", async () => {
    const w = await start(range(1000, 100));
    await showAll(w);
    // 21 earlier reviews: page two is 1079 to 1099, of which only the first 20 are shown, so page two never showed 1099.
    await w.commit({ put: { store: "cache", rows: range(979, 21) } });
    await next(w);
    expect(states()).toHaveLength(20);
    expect(item(1099)).toBeNull();
    await publish(w, 1099, true, 2);
    await remove(w, 1099);
    await back(w);
    expect(gone()).toEqual([]);
    expect(item(1099)).toBeNull();
  });

  /** 1000 to 1100: page one is 1000 to 1099 (all shown), page two 1100. Next and back again, so page one's list and cards are read
   * through watches made after `control` (their readings can then be captured). */
  const reread = async () => {
    const w = await start(range(1000, 101));
    const ctl = control(w);
    await showAll(w);
    await next(w);
    expect(states()).toEqual([`${rid(1100)}:open`]);
    await back(w);
    expect(states()).toHaveLength(100);
    expect(ctl.made("list:first")).toBeGreaterThan(0);
    return { w, ctl };
  };

  test("F28-1 an OLDER unresolved reading arriving after the resolution (page one's list and card readings replayed on return): not drawn, not remembered, never gone", async () => {
    const { w, ctl } = await reread();
    // Page one's list and 1099's card reading as they are now: 1099 listed and unresolved, version 1.
    const list = ctl.capture("list:first");
    const view = ctl.capture(`view:${rid(1099)}`);
    expect(view).toMatchObject({
      status: "ready",
      value: { base: { id: rid(1099), version: 1 } },
    });
    await w.commit({ put: { store: "cache", rows: [many(999)] } });
    await next(w);
    expect(states()).toEqual([`${rid(1099)}:open`, `${rid(1100)}:open`]);
    await publish(w, 1099, true, 2);
    await remove(w, 1099);
    expect(gone()).toEqual([]);
    // Back to page one, its list answering from before 999 (1099 listed, unresolved) and 1099's new card reading from before the
    // resolution.
    const views = ctl.made(`view:${rid(1099)}`);
    const lists = ctl.made("list:first");
    ctl.replay("list:first", list);
    ctl.replay(`view:${rid(1099)}`, view);
    await back(w);
    expect(ctl.made("list:first")).toBeGreaterThan(lists);
    expect(ctl.made(`view:${rid(1099)}`)).toBeGreaterThan(views);
    expect(item(999)).toBeNull();
    // The older reading is not drawn (and so not remembered), and its card is not "no longer available".
    expect(item(1099)).toBeNull();
    expect(gone()).toEqual([]);
    await ctl.release("list:first", `view:${rid(1099)}`);
    expect(item(999)).toHaveAttribute("data-review-state", "open");
    expect(item(1099)).toBeNull();
    expect(gone()).toEqual([]);
  });

  test("F28-1 reopened: a NEWER unresolved version after the resolution is shown and remembered again; deleted, it is said to be gone", async () => {
    const w = await twoPages();
    await publish(w, 1099, true, 2);
    expect(item(1099)).toBeNull();
    await publish(w, 1099, false, 3);
    expect(states()).toEqual([`${rid(1099)}:open`]);
    await back(w);
    expect(item(1099)).toBeNull();
    expect(gone()).toEqual([]);
    await next(w);
    expect(states()).toEqual([`${rid(1099)}:open`]);
    await remove(w, 1099);
    expect(gone()).toEqual([rid(1099)]);
    // Page one's history was retired by the resolution and the reopened review was not shown there since.
    await back(w);
    expect(gone()).toEqual([]);
  });

  test("F28-1 an OLDER resolved reading after a reopening (a replayed card reading) settles nothing: deleted while it is replayed, the review is said to be gone", async () => {
    const { w, ctl } = await reread();
    // Resolved at version 2, seen by the card's reading alone (the list held), captured, then reopened at version 3.
    ctl.hold("list:*");
    await publish(w, 1000, true, 2);
    expect(item(1000)).toBeNull();
    const resolved = ctl.capture(`view:${rid(1000)}`);
    expect(resolved).toMatchObject({
      status: "ready",
      value: { base: { id: rid(1000), version: 2 } },
    });
    await ctl.release("list:*");
    await publish(w, 1000, false, 3);
    expect(item(1000)).toHaveAttribute("data-review-state", "open");
    // A new card for it (next and back) whose reading answers with the older resolution.
    await next(w);
    const views = ctl.made(`view:${rid(1000)}`);
    ctl.replay(`view:${rid(1000)}`, resolved);
    await back(w);
    expect(ctl.made(`view:${rid(1000)}`)).toBeGreaterThan(views);
    expect(item(1000)).toBeNull();
    // Deleted while that older reading is still being answered: the panel last saw it open, so it is gone.
    await remove(w, 1000);
    expect(gone()).toEqual([rid(1000)]);
    await ctl.release(`view:${rid(1000)}`);
    expect(gone()).toEqual([rid(1000)]);
  });

  describe("revision 25 (review 29 F29-1): a card says 'no longer available' only of a review its page actually showed", () => {
    /** The ids the held (or live) page list last gave the screen: the card is still mounted from it while the list is held. */
    const listed = (ctl: ReturnType<typeof control>, key: string) =>
      (
        ctl.capture(key) as {
          status: string;
          value: { rows: Array<{ base: { id: string } }> };
        }
      ).value.rows.map((row) => row.base.id);
    /** What a card's own reading last gave the screen. */
    const viewOf = (ctl: ReturnType<typeof control>, n: number) =>
      ctl.capture(`view:${rid(n)}`) as {
        status: string;
        value: { base: { id: string } | null; merged: unknown };
      };
    /** 100 shown (an unrelated live card); a new panel whose list and cards are read through `control`. */
    const live = async () => {
      const w = await start([many(100)]);
      const ctl = control(w);
      await w.remount();
      expect(item(100)).toHaveAttribute("data-review-state", "open");
      expect(ctl.made("list:first")).toBeGreaterThan(0);
      return { w, ctl };
    };
    /** …then 200 inserted with its card's FIRST reading held: the card is drawn only as loading (it has never shown the review). */
    const loadingOnly = async () => {
      const { w, ctl } = await live();
      ctl.hold(`view:${rid(200)}`);
      await w.commit({ put: { store: "cache", rows: [many(200)] } });
      expect(ctl.made(`view:${rid(200)}`)).toBeGreaterThan(0);
      expect(item(200)).toHaveAttribute("data-review-state", "loading");
      expect(item(200)).toHaveAttribute("aria-busy", "true");
      return { w, ctl };
    };

    test("F29-1 the review's own schedule: a card only ever loading, its review deleted while the list is held, says nothing when its first reading finds no row (before and after the list arrives)", async () => {
      const { w, ctl } = await loadingOnly();
      ctl.hold("list:first");
      await remove(w, 200);
      expect(ctl.waited("list:first")).toBeGreaterThan(0);
      expect(ctl.waited(`view:${rid(200)}`)).toBeGreaterThan(0);
      expect(item(200)).toHaveAttribute("data-review-state", "loading");
      await ctl.release(`view:${rid(200)}`);
      // The held list still names 200 (so its card is mounted), and the card's own first reading says the cache holds no such row.
      expect(listed(ctl, "list:first")).toContain(rid(200));
      expect(viewOf(ctl, 200)).toMatchObject({
        status: "ready",
        value: { base: null, merged: null },
      });
      // Never shown, so never "no longer available": asserted while the list is still held (the window of the defect).
      expect(item(200)).toBeNull();
      expect(gone()).toEqual([]);
      expect(item(100)).toHaveAttribute("data-review-state", "open");
      expect(drafts(w)).toEqual([]);
      await ctl.release("list:first");
      expect(listed(ctl, "list:first")).not.toContain(rid(200));
      expect(item(200)).toBeNull();
      expect(gone()).toEqual([]);
      expect(states()).toEqual([`${rid(100)}:open`]);
    });

    test("F29-1 control: the held first reading released while the review is still cached opens it from that reading (nothing saved)", async () => {
      const { w, ctl } = await loadingOnly();
      expect(ctl.waited(`view:${rid(200)}`)).toBeGreaterThan(0);
      await ctl.release(`view:${rid(200)}`);
      expect(viewOf(ctl, 200)).toMatchObject({
        status: "ready",
        value: { base: { id: rid(200) } },
      });
      expect(item(200)).toHaveAttribute("data-review-state", "open");
      expect(item(100)).toHaveAttribute("data-review-state", "open");
      expect(drafts(w)).toEqual([]);
    });

    test("F29-1 control: a review its card SHOWED, deleted while the list is held, is 'no longer available' at once and after the list arrives", async () => {
      const { w, ctl } = await live();
      await w.commit({ put: { store: "cache", rows: [many(200)] } });
      expect(item(200)).toHaveAttribute("data-review-state", "open");
      ctl.hold("list:first");
      await remove(w, 200);
      expect(ctl.waited("list:first")).toBeGreaterThan(0);
      // Still listed (the list held): this is the card's own "no longer available", not a departed review's.
      expect(listed(ctl, "list:first")).toContain(rid(200));
      expect(gone()).toEqual([rid(200)]);
      const card = present(item(200));
      expect(card).toHaveTextContent(words.NO_LONGER_AVAILABLE);
      for (const button of within(card).getAllByRole("button"))
        expect(button).toBeDisabled();
      expect(within(card).queryByRole("link")).toBeNull();
      expect(elements(200)).toBe(1);
      expect(item(100)).toHaveAttribute("data-review-state", "open");
      await ctl.release("list:first");
      expect(listed(ctl, "list:first")).not.toContain(rid(200));
      expect(gone()).toEqual([rid(200)]);
      expect(elements(200)).toBe(1);
      expect(drafts(w)).toEqual([]);
    });

    test("F29-1 control: an UNREADABLE review its card showed counts as shown: deleted while the list is held, it is 'no longer available'", async () => {
      const { w, ctl } = await live();
      await w.commit({
        put: {
          store: "cache",
          rows: [
            review(
              { reason: "teleported", resolved: false, slot: null },
              { id: rid(200), label: "Review 200" },
            ),
          ],
        },
      });
      expect(present(item(200))).toHaveTextContent(words.UNREADABLE);
      ctl.hold("list:first");
      await remove(w, 200);
      expect(listed(ctl, "list:first")).toContain(rid(200));
      expect(gone()).toEqual([rid(200)]);
      await ctl.release("list:first");
      expect(gone()).toEqual([rid(200)]);
    });

    test("F29-1 the PAGE's history decides, not the card: shown on page one, moved off and back (a new card whose first reading is held), then deleted: 'no longer available'", async () => {
      const w = await start(range(1000, 100));
      const ctl = control(w);
      await w.remount();
      await showAll(w);
      expect(item(1099)).toHaveAttribute("data-review-state", "open");
      // 999 moves 1099 to page two (its card unmounts); removing 999 brings it back to page one as a NEW card, its first reading held.
      await w.commit({ put: { store: "cache", rows: [many(999)] } });
      expect(item(1099)).toBeNull();
      const views = ctl.made(`view:${rid(1099)}`);
      ctl.hold(`view:${rid(1099)}`);
      await remove(w, 999);
      expect(ctl.made(`view:${rid(1099)}`)).toBeGreaterThan(views);
      expect(item(1099)).toHaveAttribute("data-review-state", "loading");
      // 999 was shown on page one too (first on it) before it was deleted: genuinely no longer available, the unrelated control.
      expect(gone()).toEqual([rid(999)]);
      ctl.hold("list:first");
      await remove(w, 1099);
      expect(ctl.waited("list:first")).toBeGreaterThan(0);
      await ctl.release(`view:${rid(1099)}`);
      expect(listed(ctl, "list:first")).toContain(rid(1099));
      expect(gone()).toEqual([rid(1099), rid(999)]);
      await ctl.release("list:first");
      expect(gone()).toEqual([rid(1099), rid(999)]);
      expect(elements(1099)).toBe(1);
    });

    test("F29-1 ANOTHER page's history is not this page's: shown on page one, only loading on page two, deleted there while its list is held: nothing on page two, 'no longer available' back on page one", async () => {
      const w = await start(range(1000, 100));
      const ctl = control(w);
      await w.remount();
      await showAll(w);
      expect(item(1099)).toHaveAttribute("data-review-state", "open");
      await w.commit({ put: { store: "cache", rows: [many(999)] } });
      expect(item(1099)).toBeNull();
      ctl.hold(`view:${rid(1099)}`);
      await next(w);
      expect(states()).toEqual([`${rid(1099)}:loading`]);
      ctl.hold("list:*");
      await remove(w, 1099);
      expect(ctl.waited("list:")).toBeGreaterThan(0);
      await ctl.release(`view:${rid(1099)}`);
      expect(listed(ctl, `list:${rid(1098)}`)).toContain(rid(1099));
      expect(viewOf(ctl, 1099)).toMatchObject({
        status: "ready",
        value: { base: null },
      });
      // Page two never showed 1099 (its card was only loading there): nothing is said here.
      expect(item(1099)).toBeNull();
      expect(gone()).toEqual([]);
      await ctl.release("list:*");
      expect(gone()).toEqual([]);
      // Page one showed it: there it is no longer available.
      await back(w);
      expect(gone()).toEqual([rid(1099)]);
    });

    test("F29-1 published resolved before its card showed it, then deleted while the list is held: never shown, never gone", async () => {
      const { w, ctl } = await loadingOnly();
      ctl.hold("list:first");
      await publish(w, 200, true, 2);
      // The card's first reading is the resolution: not drawn, retired.
      await ctl.release(`view:${rid(200)}`);
      expect(viewOf(ctl, 200)).toMatchObject({
        status: "ready",
        value: { base: { id: rid(200), version: 2 } },
      });
      expect(item(200)).toBeNull();
      await remove(w, 200);
      expect(listed(ctl, "list:first")).toContain(rid(200));
      expect(item(200)).toBeNull();
      expect(gone()).toEqual([]);
      await ctl.release("list:first");
      expect(gone()).toEqual([]);
      expect(states()).toEqual([`${rid(100)}:open`]);
    });

    test("F29-1 lifetime: shown by an EARLIER panel, then only loading in a new one, deleted while its list is held: the new panel says nothing", async () => {
      const { w, ctl } = await live();
      await w.commit({ put: { store: "cache", rows: [many(200)] } });
      expect(item(200)).toHaveAttribute("data-review-state", "open");
      // A new panel (the screen left and come back to): its card for 200 waits for its first reading.
      ctl.hold(`view:${rid(200)}`);
      const views = ctl.made(`view:${rid(200)}`);
      await w.remount();
      expect(ctl.made(`view:${rid(200)}`)).toBeGreaterThan(views);
      expect(item(200)).toHaveAttribute("data-review-state", "loading");
      ctl.hold("list:first");
      await remove(w, 200);
      await ctl.release(`view:${rid(200)}`);
      expect(listed(ctl, "list:first")).toContain(rid(200));
      expect(item(200)).toBeNull();
      expect(gone()).toEqual([]);
      await ctl.release("list:first");
      expect(gone()).toEqual([]);
      expect(states()).toEqual([`${rid(100)}:open`]);
    });
  });
});
