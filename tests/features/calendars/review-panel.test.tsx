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
import * as words from "../../../src/features/calendars/copy-review";
import {
  parseReview,
  proposedMove,
  resolveReviewRequest,
} from "../../../src/features/calendars/model/review";
import { installMatchMedia } from "../../helpers/match-media";
import { calendarWorld, sourceRow } from "../../support/calendars";
import { cacheRow } from "../../support/data/rows";

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
