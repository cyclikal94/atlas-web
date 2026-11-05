import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { PeopleResult } from "../../../src/features/people/api";
import { forgetAllPeopleMemory } from "../../../src/features/people/memory";
import * as copy from "../../../src/features/people/requests/copy";
import { forgetRefusedPolicies } from "../../../src/features/sharing/api";
import { installMatchMedia } from "../../helpers/match-media";
import { ME, MO, record } from "../../support/people/records";
import { peopleWorld, person } from "../../support/people/world";

/**
 * R1 of review 4 (family people-request-replay-form-ownership): a sender's successful merge or merge request consumes ONLY the name choice
 * its own attempt captured. A choice made after that capture (in the same dialog while the command is held, in a reopened comparison of
 * the same pair through either public entry, or before an uncertain attempt is tried again) is kept, whatever the earlier attempt's
 * outcome. An unchanged choice is still consumed by its own success. Each schedule holds the command's answer explicitly, observes its
 * dispatch, and asserts the visible radio (and, where nothing is visible, the presence of the pair's draft) after the completion has been
 * observed (its announcement or report). The uncertain/refused/conflict controls differ only in the answer released.
 *
 * Production components and routes over the people world's fake server: FIXTURE evidence (design assessment S01-S16; native counterparts
 * are E-R21 in `fixture.people-requests.spec.ts`).
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

const ADA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // the source (merged into the other)
const TARGET = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; // the target (kept), labelled "Other"
type Receipt = PeopleResult<{ revision: number; person_id: string }>;
const DRAFT = `merge-name:${ADA}:${TARGET}`;
const ORIGIN = `request-origin:merge:${ADA}:${TARGET}`;

/** The two public sender entries of the same ordered pair, and where a request's success closes each to. */
const ROUTES = [
  {
    name: "the duplicates' Compare & merge",
    path: `/people/${TARGET}/duplicates/${ADA}`,
    closed: `/people/${TARGET}/duplicates`,
  },
  {
    name: "Requests' Compare",
    path: `/people/requests/merge/${ADA}/${TARGET}`,
    closed: "/people/requests",
  },
] as const;
const [DUPLICATES, REQUESTS] = ROUTES;

const SUCCESS: Receipt = {
  ok: true,
  value: { revision: 123, person_id: TARGET },
};
const OUTCOMES = [
  { name: "success", answer: SUCCESS, said: null },
  {
    name: "uncertain",
    answer: { ok: false, kind: "uncertain" } as Receipt,
    said: copy.UNCERTAIN,
  },
  {
    name: "refused (422)",
    answer: { ok: false, kind: "invalid", requestId: "ref-422" } as Receipt,
    said: copy.INVALID,
  },
  {
    name: "conflict (409)",
    answer: { ok: false, kind: "conflict" } as Receipt,
    said: copy.COMPARISON_CHANGED,
  },
] as const;

/** Two unlinked people with different labels; `approval`: a cross-owner pair (a request to mo), else a direct merge. */
function world({ approval }: { approval: boolean }) {
  const w = peopleWorld();
  w.env.setDefaults(record({ members: [ME, MO] }));
  w.setCache([
    person({ id: ADA, label: "Ada" }),
    person({ id: TARGET, label: "Other" }),
  ]);
  w.api.linked.set(ADA, null);
  w.api.linked.set(TARGET, null);
  if (approval) {
    w.api.requests.merge.set(`${ADA}:${TARGET}`, { requires_approval: true });
    w.api.summary.persons.set(ADA, {
      your_access: "view",
      added_by_you: "no",
      owner: { account_id: MO, username: "mo", you: false, person: null },
      audience: {
        disclosure: "partial",
        in_home: false,
        households: [],
        your_direct_grant: { can_edit: false },
        direct_grant_count: null,
        excluded_count: null,
      },
    });
  }
  return w;
}
const commands = (w: ReturnType<typeof peopleWorld>) =>
  w.api.calls.filter((call) => call.op === "peopleCommand");
const nameSent = (w: ReturnType<typeof peopleWorld>, index: number) =>
  (commands(w)[index]?.args[1] as { command: { name: string } } | undefined)
    ?.command.name;
const dialog = () => screen.getByRole("dialog");
const radio = (name: string) => within(dialog()).getByRole("radio", { name });
const confirm = () =>
  within(dialog())
    .getAllByRole("button")
    .find(
      (button) => button.getAttribute("data-people-action") === "confirm-merge",
    ) as HTMLButtonElement | undefined;
/** The action while a command of the pair runs: disabled, described by "Saving…" first (no `data-people-action` is rendered on it). */
const heldAction = () =>
  within(dialog())
    .getAllByRole("button")
    .find((button) => {
      const reason = button.getAttribute("aria-describedby")?.split(" ")[0];
      return (
        button.hasAttribute("disabled") &&
        reason !== undefined &&
        document.getElementById(reason)?.textContent === copy.SAVING
      );
    });
const ready = () =>
  waitFor(() => {
    expect(confirm()).toBeDefined();
    expect(confirm()).toBeEnabled();
  });
/** A real edit: a change event on a radio that is not already selected, then its effect is checked. */
function choose(name: string) {
  expect(radio(name)).toHaveAttribute("aria-checked", "false");
  fireEvent.click(radio(name));
  expect(radio(name)).toHaveAttribute("aria-checked", "true");
}
/** The next command's answer is held until `release`; `dispatched` once the command was really made. */
function hold(w: ReturnType<typeof peopleWorld>) {
  let resolve: ((answer: Receipt) => void) | null = null;
  w.api.next.people.push(
    () =>
      new Promise<Receipt>((r) => {
        resolve = r;
      }),
  );
  return {
    dispatched: () => waitFor(() => expect(resolve).not.toBeNull()),
    release: (answer: Receipt) =>
      act(async () => {
        if (resolve === null) throw new Error("the command was not dispatched");
        resolve(answer);
      }),
  };
}
type Router = Awaited<
  ReturnType<ReturnType<typeof peopleWorld>["mount"]>
>["router"];
/** Navigates within the app (a concrete path of a typed route). */
const go = (router: Router, path: string) =>
  act(async () => {
    await router.navigate({ to: path as never });
  });
const comparisonShown = () =>
  waitFor(() =>
    expect(document.querySelector("[data-merge-comparison]")).not.toBeNull(),
  );
/**
 * Leaves the comparison (to Requests: no dialog) and opens `path` again: a new mount over the same page memory. `whileHeld`: a command
 * of the pair still runs, so the action is disabled (Saving…); the reopened dialog is ready once its comparison is shown.
 */
async function reopen(
  router: Router,
  path: string,
  { whileHeld = false }: { whileHeld?: boolean } = {},
) {
  await go(router, "/people/requests");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await go(router, path);
  await screen.findByRole("dialog");
  await comparisonShown();
  if (whileHeld) {
    expect(confirm()).toBeUndefined();
    expect(heldAction()).toBeDisabled();
  } else await ready();
}
/** The completion of the earlier attempt was observed: its announcement (a success), or what its dialog now says. */
const completed = (said: string | null, announced: string) =>
  waitFor(() =>
    said === null
      ? expect(document.body.textContent).toContain(announced)
      : expect(dialog().textContent).toContain(said),
  );
const settled = (w: ReturnType<typeof peopleWorld>) =>
  waitFor(() => expect(w.people.memory.pending.size).toBe(0));

describe("R1 (review 4): a sender's success consumes only the name choice its own attempt captured", () => {
  // ---- S01/S02: an unchanged choice is consumed by its own success (disproves "always keep") ----
  for (const route of ROUTES)
    for (const approval of [true, false])
      test(`S01/S02 ${route.name}, ${approval ? "a request" : "a direct merge"}: the unchanged chosen name is sent, said and consumed`, async () => {
        const w = world({ approval });
        const { router } = await w.mount(route.path);
        await ready();
        choose("Ada");
        const held = hold(w);
        fireEvent.click(confirm() as HTMLButtonElement);
        await held.dispatched();
        expect(commands(w)).toHaveLength(1);
        expect(commands(w)[0]?.args[1]).toMatchObject({
          command: { kind: approval ? "request_merge" : "merge", name: "Ada" },
        });
        await held.release(SUCCESS);
        await completed(
          null,
          approval ? copy.MERGE_REQUESTED("mo") : copy.MERGED_INTO("Ada"),
        );
        await waitFor(() =>
          expect(router.state.location.pathname).toBe(
            approval ? route.closed : `/people/${TARGET}`,
          ),
        );
        await settled(w);
        expect(w.people.memory.drafts.has(DRAFT)).toBe(false);
        await reopen(router, route.path);
        expect(radio("Other")).toHaveAttribute("aria-checked", "true");
        expect(radio("Ada")).toHaveAttribute("aria-checked", "false");
        expect(commands(w)).toHaveLength(1);
      });

  test("S02: the default (never chosen) name is sent and its success leaves no draft behind", async () => {
    const w = world({ approval: false });
    await w.mount(REQUESTS.path);
    await ready();
    const held = hold(w);
    fireEvent.click(confirm() as HTMLButtonElement);
    await held.dispatched();
    expect(nameSent(w, 0)).toBe("Other");
    await held.release(SUCCESS);
    await completed(null, copy.MERGED_INTO("Other"));
    await settled(w);
    expect(w.people.memory.drafts.has(DRAFT)).toBe(false);
    expect(w.people.memory.drafts.has(ORIGIN)).toBe(false);
  });

  test("S02: a linked side fixes the name; its success sends that name and leaves no draft behind", async () => {
    const w = world({ approval: false });
    w.api.linked.set(ADA, MO);
    await w.mount(DUPLICATES.path);
    await waitFor(() =>
      expect(within(dialog()).queryByText(copy.LINKED_NAME)).not.toBeNull(),
    );
    await ready();
    const held = hold(w);
    fireEvent.click(confirm() as HTMLButtonElement);
    await held.dispatched();
    expect(nameSent(w, 0)).toBe("Ada");
    await held.release(SUCCESS);
    await completed(null, copy.MERGED_INTO("Ada"));
    await settled(w);
    expect(w.people.memory.drafts.has(DRAFT)).toBe(false);
  });

  test("S02: two equal labels offer no choice; the success sends that name and leaves no draft behind", async () => {
    const w = world({ approval: false });
    w.setCache([
      person({ id: ADA, label: "Ada" }),
      person({ id: TARGET, label: "Ada" }),
    ]);
    await w.mount(DUPLICATES.path);
    await ready();
    expect(within(dialog()).queryAllByRole("radio")).toHaveLength(0);
    const held = hold(w);
    fireEvent.click(confirm() as HTMLButtonElement);
    await held.dispatched();
    expect(nameSent(w, 0)).toBe("Ada");
    await held.release(SUCCESS);
    await completed(null, copy.MERGED_INTO("Ada"));
    await settled(w);
    expect(w.people.memory.drafts.has(DRAFT)).toBe(false);
  });

  // ---- S03: an edit in the original, still mounted dialog while the command is held ----
  for (const route of ROUTES)
    for (const approval of [true, false])
      test(`S03 ${route.name}, ${approval ? "a request" : "a direct merge"}: a choice made while the command is held survives its success`, async () => {
        const w = world({ approval });
        const { router } = await w.mount(route.path);
        await ready();
        const held = hold(w);
        fireEvent.click(confirm() as HTMLButtonElement);
        await held.dispatched();
        choose("Ada");
        await held.release(SUCCESS);
        // The earlier attempt completes as itself: the name it carried.
        await completed(
          null,
          approval ? copy.MERGE_REQUESTED("mo") : copy.MERGED_INTO("Other"),
        );
        expect(nameSent(w, 0)).toBe("Other");
        await waitFor(() =>
          expect(router.state.location.pathname).toBe(
            approval ? route.closed : `/people/${TARGET}`,
          ),
        );
        await settled(w);
        expect(w.people.memory.drafts.has(DRAFT)).toBe(true);
        await reopen(router, route.path);
        expect(
          radio("Ada"),
          "the earlier success must not consume the choice made after its capture",
        ).toHaveAttribute("aria-checked", "true");
        expect(commands(w)).toHaveLength(1);
      });

  // ---- S04: the visible review-4 failure, with its paired outcome controls ----
  for (const route of ROUTES)
    for (const outcome of OUTCOMES)
      test(`S04 ${route.name}: reopened and changed while the request is held; the earlier ${outcome.name} keeps the newer visible choice`, async () => {
        const w = world({ approval: true });
        const { router } = await w.mount(route.path);
        await ready();
        const held = hold(w);
        fireEvent.click(confirm() as HTMLButtonElement);
        await held.dispatched();
        expect(nameSent(w, 0)).toBe("Other");
        await reopen(router, route.path, { whileHeld: true });
        choose("Ada");
        expect(w.people.memory.drafts.has(DRAFT)).toBe(true);
        const before = w.api.calls.filter(
          (c) => c.op === "previewMerge",
        ).length;
        await held.release(outcome.answer);
        await completed(outcome.said, copy.MERGE_REQUESTED("mo"));
        await settled(w);
        // The successor's route is its own; nothing else was sent.
        expect(router.state.location.pathname).toBe(route.path);
        expect(commands(w)).toHaveLength(1);
        expect(
          radio("Ada"),
          `the earlier ${outcome.name} must not change the reopened dialog's newer choice`,
        ).toHaveAttribute("aria-checked", "true");
        // ... and a subsequent read of the comparison does not either.
        await waitFor(() =>
          expect(
            w.api.calls.filter((c) => c.op === "previewMerge").length,
          ).toBeGreaterThan(before),
        );
        await comparisonShown();
        expect(radio("Ada")).toHaveAttribute("aria-checked", "true");
      });

  // ---- S05: one draft for the ordered pair, whichever public entry shows it ----
  for (const [from, to] of [
    [DUPLICATES, REQUESTS],
    [REQUESTS, DUPLICATES],
  ] as const)
    test(`S05 held from ${from.name}, changed in ${to.name}: the success keeps the newer choice there`, async () => {
      const w = world({ approval: true });
      const { router } = await w.mount(from.path);
      await ready();
      const held = hold(w);
      fireEvent.click(confirm() as HTMLButtonElement);
      await held.dispatched();
      await go(router, to.path);
      await comparisonShown();
      choose("Ada");
      await held.release(SUCCESS);
      await completed(null, copy.MERGE_REQUESTED("mo"));
      await settled(w);
      expect(router.state.location.pathname).toBe(to.path);
      expect(radio("Ada")).toHaveAttribute("aria-checked", "true");
      await reopen(router, from.path);
      expect(radio("Ada")).toHaveAttribute("aria-checked", "true");
    });

  // ---- S06: uncertain, a newer choice, then the exact replay succeeds ----
  test("S06: an uncertain merge, a newer choice, then Try again: the same key and body, the original name said, the newer choice kept", async () => {
    const w = world({ approval: false });
    w.api.next.people.push({ ok: false, kind: "uncertain" } as Receipt);
    const { router } = await w.mount(DUPLICATES.path);
    await ready();
    fireEvent.click(confirm() as HTMLButtonElement);
    await completed(copy.UNCERTAIN, "");
    await settled(w);
    expect(nameSent(w, 0)).toBe("Other");
    choose("Ada");
    await ready();
    const held = hold(w);
    fireEvent.click(confirm() as HTMLButtonElement);
    await held.dispatched();
    expect(commands(w)).toHaveLength(2);
    expect(commands(w)[1]).toEqual(commands(w)[0]);
    await held.release(SUCCESS);
    await completed(null, copy.MERGED_INTO("Other"));
    expect(document.body.textContent).not.toContain(copy.MERGED_INTO("Ada"));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/people/${TARGET}`),
    );
    await settled(w);
    // The attempt and its origin end with the definite answer.
    expect(w.people.memory.attempts.size).toBe(0);
    expect(w.people.memory.drafts.has(ORIGIN)).toBe(false);
    await reopen(router, DUPLICATES.path);
    expect(
      radio("Ada"),
      "the replayed success must not consume the choice made after the original capture",
    ).toHaveAttribute("aria-checked", "true");
  });

  test("S06 control: an uncertain merge tried again unchanged consumes the choice it was made of", async () => {
    const w = world({ approval: false });
    w.api.next.people.push({ ok: false, kind: "uncertain" } as Receipt);
    const { router } = await w.mount(REQUESTS.path);
    await ready();
    choose("Ada");
    fireEvent.click(confirm() as HTMLButtonElement);
    await completed(copy.UNCERTAIN, "");
    await settled(w);
    await ready();
    fireEvent.click(confirm() as HTMLButtonElement);
    await waitFor(() => expect(commands(w)).toHaveLength(2));
    expect(commands(w)[1]).toEqual(commands(w)[0]);
    await completed(null, copy.MERGED_INTO("Ada"));
    await settled(w);
    expect(w.people.memory.drafts.has(DRAFT)).toBe(false);
    await reopen(router, REQUESTS.path);
    expect(radio("Other")).toHaveAttribute("aria-checked", "true");
  });

  // ---- S07: the replay from the fallback footer (the comparison cannot be shown) ----
  test("S07: uncertain, a newer choice, the comparison then fails; the fallback Try again replays exactly and keeps the newer choice", async () => {
    const w = world({ approval: false });
    w.api.next.people.push({ ok: false, kind: "uncertain" } as Receipt);
    const { router } = await w.mount(DUPLICATES.path);
    await ready();
    fireEvent.click(confirm() as HTMLButtonElement);
    await completed(copy.UNCERTAIN, "");
    await settled(w);
    choose("Ada");
    // Every later comparison read fails; the page reads again (a freshness signal).
    for (let n = 0; n < 6; n += 1)
      w.api.next.mergePreview.push({ ok: false, kind: "uncertain" });
    act(() => w.people.memory.invalidateSummaries());
    await waitFor(() =>
      expect(dialog().textContent).toContain(copy.PREVIEW_FAILED),
    );
    expect(within(dialog()).queryAllByRole("radio")).toHaveLength(0);
    await ready();
    // The server answers comparisons again from now on (the reads after the success, and the reopened dialog's).
    w.api.next.mergePreview.length = 0;
    fireEvent.click(confirm() as HTMLButtonElement);
    await waitFor(() => expect(commands(w)).toHaveLength(2));
    expect(commands(w)[1]).toEqual(commands(w)[0]);
    await completed(null, copy.MERGED_INTO("Other"));
    await settled(w);
    expect(w.people.memory.drafts.has(DRAFT)).toBe(true);
    await go(router, "/people/requests");
    await go(router, DUPLICATES.path);
    await screen.findByRole("dialog");
    await comparisonShown();
    expect(radio("Ada")).toHaveAttribute("aria-checked", "true");
  });

  // ---- S08: a replacement edit with the SAME value as the captured one ----
  test("S08: changed away and back to the captured value while held: the replacement is newer and survives", async () => {
    const w = world({ approval: true });
    const { router } = await w.mount(DUPLICATES.path);
    await ready();
    choose("Ada");
    const held = hold(w);
    fireEvent.click(confirm() as HTMLButtonElement);
    await held.dispatched();
    expect(nameSent(w, 0)).toBe("Ada");
    choose("Other");
    choose("Ada");
    await held.release(SUCCESS);
    await completed(null, copy.MERGE_REQUESTED("mo"));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(DUPLICATES.closed),
    );
    await settled(w);
    await reopen(router, DUPLICATES.path);
    expect(
      radio("Ada"),
      "an equal-valued edit made after the capture is not the captured one",
    ).toHaveAttribute("aria-checked", "true");
  });

  // ---- S09: the default submitted, then a later choice ----
  test("S09: the default sent, then changed away and back while held: the later draft survives", async () => {
    const w = world({ approval: true });
    await w.mount(DUPLICATES.path);
    await ready();
    const held = hold(w);
    fireEvent.click(confirm() as HTMLButtonElement);
    await held.dispatched();
    choose("Ada");
    choose("Other");
    await held.release(SUCCESS);
    await completed(null, copy.MERGE_REQUESTED("mo"));
    await settled(w);
    expect(w.people.memory.drafts.has(DRAFT)).toBe(true);
  });

  // ---- S10: a remount alone does not make the captured choice newer ----
  test("S10: reopened without a change while held: the success consumes the captured choice, and the reopened route stays", async () => {
    const w = world({ approval: true });
    const { router } = await w.mount(DUPLICATES.path);
    await ready();
    choose("Ada");
    const held = hold(w);
    fireEvent.click(confirm() as HTMLButtonElement);
    await held.dispatched();
    await go(router, "/people/requests");
    await go(router, DUPLICATES.path);
    await screen.findByRole("dialog");
    await comparisonShown();
    expect(radio("Ada")).toHaveAttribute("aria-checked", "true");
    await held.release(SUCCESS);
    await completed(null, copy.MERGE_REQUESTED("mo"));
    await settled(w);
    // The old mount does not close its successor; the consumed choice is shown as the default again.
    expect(router.state.location.pathname).toBe(DUPLICATES.path);
    expect(w.people.memory.drafts.has(DRAFT)).toBe(false);
    await waitFor(() =>
      expect(radio("Other")).toHaveAttribute("aria-checked", "true"),
    );
  });

  // ---- S11: another (or the reversed) pair is another draft ----
  test("S11: the reversed pair's choice is untouched by the success; the held pair's own choice is consumed", async () => {
    const w = world({ approval: false });
    const REVERSED = `/people/requests/merge/${TARGET}/${ADA}`;
    const { router } = await w.mount(DUPLICATES.path);
    await ready();
    choose("Ada");
    const held = hold(w);
    fireEvent.click(confirm() as HTMLButtonElement);
    await held.dispatched();
    await go(router, REVERSED);
    await comparisonShown();
    // In the reversed pair "Other" is the merged (source) side: choosing it is that pair's own draft.
    choose("Other");
    await held.release(SUCCESS);
    await completed(null, copy.MERGED_INTO("Ada"));
    await settled(w);
    expect(router.state.location.pathname).toBe(REVERSED);
    expect(radio("Other")).toHaveAttribute("aria-checked", "true");
    expect(w.people.memory.drafts.has(`merge-name:${TARGET}:${ADA}`)).toBe(
      true,
    );
    expect(w.people.memory.drafts.has(DRAFT)).toBe(false);
  });

  // ---- S12: the choice hidden by a linkage change after the edit ----
  test("S12: a newer choice hidden by a linkage change is kept through the success", async () => {
    const w = world({ approval: true });
    await w.mount(DUPLICATES.path);
    await ready();
    const held = hold(w);
    fireEvent.click(confirm() as HTMLButtonElement);
    await held.dispatched();
    // The dialog stays mounted: the newer choice is made, then the source becomes linked (read again after the command).
    choose("Ada");
    w.api.linked.set(ADA, MO);
    await held.release(SUCCESS);
    await completed(null, copy.MERGE_REQUESTED("mo"));
    await settled(w);
    expect(nameSent(w, 0)).toBe("Other");
    expect(w.people.memory.drafts.has(DRAFT)).toBe(true);
  });

  // ---- S13: one send per pair while it runs; a later explicit send captures the kept choice ----
  test("S13: a second press while held sends nothing; after the success, an explicit send carries the kept newer choice and consumes it", async () => {
    const w = world({ approval: true });
    const { router } = await w.mount(DUPLICATES.path);
    await ready();
    const held = hold(w);
    // Two presses of the one rendered button (the second reaches the same handler before any re-render).
    const pressed = confirm() as HTMLButtonElement;
    fireEvent.click(pressed);
    fireEvent.click(pressed);
    await held.dispatched();
    await reopen(router, DUPLICATES.path, { whileHeld: true });
    choose("Ada");
    expect(heldAction()).toBeDisabled();
    await held.release(SUCCESS);
    await completed(null, copy.MERGE_REQUESTED("mo"));
    await settled(w);
    expect(commands(w)).toHaveLength(1);
    await ready();
    expect(radio("Ada")).toHaveAttribute("aria-checked", "true");
    fireEvent.click(confirm() as HTMLButtonElement);
    await waitFor(() => expect(commands(w)).toHaveLength(2));
    expect(nameSent(w, 1)).toBe("Ada");
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(DUPLICATES.closed),
    );
    await settled(w);
    expect(w.people.memory.drafts.has(DRAFT)).toBe(false);
  });

  // ---- S16: another identity is displayed when the success arrives ----
  test("S16: another identity's choice for the same pair is untouched by the earlier identity's late success", async () => {
    const w = world({ approval: true });
    await w.mount(DUPLICATES.path);
    await ready();
    const held = hold(w);
    fireEvent.click(confirm() as HTMLButtonElement);
    await held.dispatched();
    cleanup();
    const other = peopleWorld({ identity: "other-account:1" });
    other.env.setDefaults(record({ members: [ME, MO] }));
    other.setCache([
      person({ id: ADA, label: "Ada" }),
      person({ id: TARGET, label: "Other" }),
    ]);
    other.api.linked.set(ADA, null);
    other.api.linked.set(TARGET, null);
    const { router } = await other.mount(DUPLICATES.path);
    await ready();
    choose("Ada");
    await held.release(SUCCESS);
    await waitFor(() => expect(w.people.memory.pending.size).toBe(0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(router.state.location.pathname).toBe(DUPLICATES.path);
    expect(radio("Ada")).toHaveAttribute("aria-checked", "true");
    expect(other.people.memory.drafts.has(DRAFT)).toBe(true);
    expect(commands(other)).toHaveLength(0);
  });
});
