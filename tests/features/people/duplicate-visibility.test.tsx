import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { CacheRow } from "../../../src/data";
import { forgetAllPeopleMemory } from "../../../src/features/people/memory";
import { forgetRefusedPolicies } from "../../../src/features/sharing/api";
import { installMatchMedia } from "../../helpers/match-media";
import { fieldRow, peopleWorld, person } from "../../support/people/world";

/**
 * PPL-5 / A14 for the duplicates view (WEB-11a review 15, R15.1; DA15-01 to DA15-03, DA15-06): a hint the duplicates answer listed stays
 * listed, but its field count is shown only while the cache holds that candidate as a person. The count's read is the person AND its
 * fields together (`data.readVisibleChildren`), so a removal of the person alone hides it, however the fields change afterwards, and with
 * no new duplicates answer. Loading, a failed read, a hidden person and a missing one show no count at all (never "0 fields").
 * Review 15's two probes are preserved under `.agtx/evidence/WEB-11a/review-15`; the first two schedules here are their maintained form.
 * jsdom, axe; FIXTURE evidence (the store double answers the plan as the production plan reads it: `tests/data/visible-children.test.ts`).
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
const R = "44444444-4444-4444-8444-444444444444";
const F = "88888888-8888-4888-8888-888888888888";
const G = "99999999-9999-4999-8999-999999999999";
const C = "33333333-3333-4333-8333-333333333333";
const hint = (id: string, label: string) => ({
  id,
  kind: "person" as const,
  parent_id: null,
  label,
  value: null,
  version: 1,
  can_edit: true,
  archived: false,
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const row = (id: string) =>
  document.querySelector(`[data-duplicate-hint="${id}"]`) as HTMLElement;
/** Whatever count the hint shows: "1 field", "2 fields", "100 fields+", or null. */
const countOf = (id: string) =>
  [...row(id).querySelectorAll("span")]
    .map((span) => span.textContent ?? "")
    .find((text) => /^\d+ fields?\+?$/.test(text)) ?? null;

const p = person({ id: P, label: "Mo" });
const q = person({ id: Q, label: "Mo duplicate" });
const f = fieldRow({ id: F, parent_id: Q, label: "Retained field" });
const g = fieldRow({ id: G, parent_id: Q, label: "Later field" });

async function opened(
  cache: CacheRow[],
  options: { next_after?: string | null; hold?: boolean } = {},
) {
  const w = peopleWorld();
  w.setCache(cache);
  w.api.next.duplicates.push({
    ok: true,
    value: {
      items: [hint(Q, q.label)],
      next_after: options.next_after ?? null,
    },
  });
  if (options.hold) w.holdReads("data.readVisibleChildren");
  const view = await w.mount(`/people/${P}/duplicates`);
  await screen.findByText(q.label);
  await tick();
  return { w, view };
}

describe("a retained hint's count follows its person (R15.1)", () => {
  const schedules: Array<{
    name: string;
    after: CacheRow[];
    count: string | null;
  }> = [
    {
      name: "the person is removed, its field kept: no count",
      after: [p, f],
      count: null,
    },
    {
      name: "the person is removed and another field of theirs is cached: no count, not '2 fields'",
      after: [p, f, g],
      count: null,
    },
    {
      name: "control: the person is updated and stays: '1 field'",
      after: [p, { ...q, version: 4 }, f],
      count: "1 field",
    },
    {
      name: "control: the person stays and a field is added: '2 fields'",
      after: [p, q, f, g],
      count: "2 fields",
    },
    {
      name: "control: the field is removed and the person stays: no count",
      after: [p, q],
      count: null,
    },
  ];
  for (const schedule of schedules)
    test(schedule.name, async () => {
      const { w } = await opened([p, q, f]);
      expect(countOf(Q)).toBe("1 field");
      w.setCache(schedule.after);
      await tick();
      // The hint itself stays (its answer is not withdrawn): only what is read of the person's fields depends on the person.
      expect(within(row(Q)).getByText(q.label)).toBeInTheDocument();
      expect(countOf(Q)).toBe(schedule.count);
    });

  test("the person comes back: the count is read again and shown", async () => {
    const { w } = await opened([p, q, f]);
    w.setCache([p, f, g]);
    await tick();
    expect(countOf(Q)).toBeNull();
    w.setCache([p, q, f, g]);
    await tick();
    expect(countOf(Q)).toBe("2 fields");
  });

  test("no duplicates answer is needed: after the person is removed a failed 'Check more' leaves the hint listed and its count hidden", async () => {
    const { w } = await opened([p, q, f], { next_after: C });
    expect(countOf(Q)).toBe("1 field");
    w.setCache([p, f]);
    await tick();
    w.api.next.duplicates.push({ ok: false, kind: "offline" });
    fireEvent.click(screen.getByRole("button", { name: "Check more" }));
    await tick();
    expect(within(row(Q)).getByText(q.label)).toBeInTheDocument();
    expect(countOf(Q)).toBeNull();
    expect(
      w.api.calls.filter((call) => call.op === "readDuplicates"),
    ).toHaveLength(2);
  });

  test("the count's read is the person with its fields, never the fields alone", async () => {
    const { w } = await opened([p, q, f]);
    expect(
      w.watches.filter(
        (watch) =>
          watch.plan === "data.readVisibleChildren" &&
          watch.input.parentId === Q,
      ),
    ).not.toHaveLength(0);
    for (const watch of w.watches.filter(
      (watch) =>
        watch.plan === "data.readVisibleChildren" && watch.input.parentId === Q,
    ))
      expect(watch.input).toMatchObject({
        parentKind: "person",
        kind: "field",
      });
    expect(
      w.watches.filter(
        (watch) =>
          watch.plan === "data.readResourceList" && watch.input.parentId === Q,
      ),
    ).toEqual([]);
  });
});

describe("what is not a visible person shows no count, and is never zero (DA15-02)", () => {
  test("a person this device does not hold, with fields cached under their id: no count", async () => {
    await opened([p, f, g]);
    expect(countOf(Q)).toBeNull();
  });

  test("a row of that id that is not a person: no count", async () => {
    await opened([p, { ...q, kind: "task" }, f]);
    expect(countOf(Q)).toBeNull();
  });

  test("while the read is on its way: no count; once it answers: '1 field'", async () => {
    const { w } = await opened([p, q, f], { hold: true });
    expect(w.gated.some((input) => input.parentId === Q)).toBe(true);
    expect(countOf(Q)).toBeNull();
    w.releaseReads();
    await tick();
    expect(countOf(Q)).toBe("1 field");
  });

  test("a read that fails: no count (not '0 fields'), and the hint is still listed", async () => {
    const w = peopleWorld();
    w.setCache([p, q, f]);
    w.api.next.duplicates.push({
      ok: true,
      value: { items: [hint(Q, q.label)], next_after: null },
    });
    w.failRead("data.readVisibleChildren");
    await w.mount(`/people/${P}/duplicates`);
    await screen.findByText(q.label);
    await tick();
    expect(countOf(Q)).toBeNull();
  });

  test("controls: a read-only person and an archived person are visible, and archived fields are not counted", async () => {
    for (const over of [{ can_edit: false }, { archived: true }]) {
      await opened([
        p,
        { ...q, ...over },
        f,
        g,
        fieldRow({ id: C, parent_id: Q, archived: true }),
      ]);
      expect(countOf(Q)).toBe("2 fields");
      cleanup();
    }
  });

  test("two hints: each count belongs to its own person (one held, one not)", async () => {
    const w = peopleWorld();
    w.setCache([p, q, f, fieldRow({ id: G, parent_id: R })]);
    w.api.next.duplicates.push({
      ok: true,
      value: { items: [hint(Q, q.label), hint(R, "Mo too")], next_after: null },
    });
    await w.mount(`/people/${P}/duplicates`);
    await screen.findByText("Mo too");
    await tick();
    expect(countOf(Q)).toBe("1 field");
    expect(countOf(R)).toBeNull();
  });

  test("more than a page of fields: the bounded count says there are more", async () => {
    await opened([
      p,
      q,
      ...Array.from({ length: 101 }, (_, i) =>
        fieldRow({
          id: `f${String(i).padStart(3, "0")}`,
          parent_id: Q,
        }),
      ),
    ]);
    expect(countOf(Q)).toBe("100 fields+");
  });

  test("axe: the view with a hidden count and a shown one", async () => {
    const w = peopleWorld();
    w.setCache([p, q, f, fieldRow({ id: G, parent_id: R })]);
    w.api.next.duplicates.push({
      ok: true,
      value: { items: [hint(Q, q.label), hint(R, "Mo too")], next_after: null },
    });
    await w.mount(`/people/${P}/duplicates`);
    await screen.findByText("Mo too");
    await tick();
    expect(countOf(Q)).toBe("1 field");
    expect(countOf(R)).toBeNull();
    expect((await axe(document.body)).violations).toEqual([]);
  });
});

describe("the cached people list's count reads the person with its fields (R15.1, the same invariant; DA15-06)", () => {
  const countIn = (id: string) =>
    document
      .querySelector(`[data-person-row="${id}"]`)
      ?.querySelector("[data-field-count]")?.textContent ?? null;
  for (const removed of [true, false])
    test(`${removed ? "the list's read of the people has not answered a commit that removed a person and added their field: the stale row shows no count" : "control: the same commit keeps the person: the row shows '2 fields'"}`, async () => {
      const w = peopleWorld();
      w.setCache([p, q, f]);
      await w.mount("/people");
      await screen.findByText(q.label);
      await tick();
      expect(countIn(Q)).toBe("1 field");
      // The people list's own read keeps its earlier answer (its live query has not delivered the commit); each row's count read has.
      w.freezeReads(
        "data.readResourceList",
        (input) => input.kind === "person",
      );
      w.setCache(removed ? [p, f, g] : [p, q, f, g]);
      await tick();
      expect(document.querySelector(`[data-person-row="${Q}"]`)).not.toBeNull();
      expect(countIn(Q)).toBe(removed ? null : "2 fields");
      w.thawReads();
      await tick();
      expect(document.querySelector(`[data-person-row="${Q}"]`) !== null).toBe(
        !removed,
      );
    });
});
