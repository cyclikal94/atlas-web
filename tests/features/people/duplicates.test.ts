// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  addPage,
  firstPageCount,
  initialDuplicates,
  summarise,
  visibleHints,
} from "../../../src/features/people/model/duplicates";

/**
 * PPL-3: `GET /people/{id}/duplicates` scans a bounded page of visible people, so a page can be EMPTY with a `next_after`. Completeness
 * is claimed only after `next_after: null`; dismissal ("Not the same") is page memory only (D-11a-9).
 */
const SELF = "self";
const none = new Set<string>();

describe("the duplicates reducer", () => {
  test("an empty page with next_after is 'none so far', never 'none at all'", () => {
    const state = addPage(
      initialDuplicates(),
      { items: [], next_after: "c1" },
      SELF,
    );
    expect(state.exhausted).toBe(false);
    expect(summarise(state, none)).toEqual({ kind: "none_so_far" });
  });

  test("only a page with next_after null completes the check", () => {
    let state = addPage(
      initialDuplicates(),
      { items: [], next_after: "c1" },
      SELF,
    );
    state = addPage(state, { items: [], next_after: null }, SELF);
    expect(summarise(state, none)).toEqual({ kind: "none_at_all" });
  });

  test("hints accumulate across pages without repeats or the person themself", () => {
    let state = addPage(
      initialDuplicates(),
      {
        items: [
          { id: "a", label: "Mo" },
          { id: SELF, label: "Me" },
        ],
        next_after: "c",
      },
      SELF,
    );
    state = addPage(
      state,
      {
        items: [
          { id: "a", label: "Mo" },
          { id: "b", label: "Mohammed A." },
        ],
        next_after: null,
      },
      SELF,
    );
    expect(state.hints.map((h) => h.id)).toEqual(["a", "b"]);
    expect(summarise(state, none)).toEqual({ kind: "some", complete: true });
  });

  test("a dismissed pair is hidden; with every hint dismissed the summary follows the cursor, never claiming more", () => {
    let state = addPage(
      initialDuplicates(),
      { items: [{ id: "a", label: "Mo" }], next_after: "c" },
      SELF,
    );
    const dismissed = new Set(["a"]);
    expect(visibleHints(state, dismissed)).toEqual([]);
    expect(summarise(state, dismissed)).toEqual({ kind: "none_so_far" });
    state = addPage(state, { items: [], next_after: null }, SELF);
    expect(summarise(state, dismissed)).toEqual({ kind: "none_at_all" });
  });

  test("nothing read yet says nothing", () => {
    expect(summarise(initialDuplicates(), none)).toEqual({ kind: "not_read" });
  });
});

describe("firstPageCount", () => {
  test("'2' on a final page, '2+' when more follow, and no count when the first page is empty but more follow", () => {
    expect(firstPageCount({ items: [1, 2], next_after: null })).toBe("2");
    expect(firstPageCount({ items: [1, 2], next_after: "c" })).toBe("2+");
    expect(firstPageCount({ items: [], next_after: null })).toBe("0");
    expect(firstPageCount({ items: [], next_after: "c" })).toBeNull();
  });
});
