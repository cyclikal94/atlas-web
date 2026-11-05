// @vitest-environment node
import { describe, expect, test } from "vitest";
import type { CacheRow } from "../../../src/data";
import {
  type ChainStatus,
  chainResult,
  type Report,
  scanStep,
} from "../../../src/features/people/reads";
import { cacheRow } from "../../support/data/rows";

/**
 * The people screens' bounded reads (Q9). `scanStep`: one step of a walk with a continuation (finding 7 of the review of 13 October: a fixed
 * cap is not a continuation). `chainResult`: a chain is a COMPLETE inventory only when every page to the last has reported (finding 5).
 * PURE.
 */
const rowsOf = (from: number, count: number, over: Partial<CacheRow> = {}) =>
  Array.from({ length: count }, (_, i) =>
    cacheRow({
      id: `r${String(from + i).padStart(5, "0")}`,
      kind: "person",
      ...over,
    }),
  );

type Entry = {
  after: string | null;
  report: Report<CacheRow, string>;
};
const page = (
  after: string | null,
  rows: CacheRow[],
  next: string | null,
  status: ChainStatus = "ready",
): Entry => ({ after, report: { status, rows, next } });
const all = () => true;

describe("scanStep", () => {
  test("a step that keeps `limit` rows in its first page ends at the last row it kept: the next step begins right after it", () => {
    const first = rowsOf(0, 100);
    const step = scanStep(
      new Map([[0, page(null, first, "r00099")]]),
      null,
      (row) => Number(row.id.slice(1)) % 2 === 0,
      10,
      20,
    );
    expect(step.settled).toBe(true);
    expect(step.rows.map((r) => r.id)).toEqual(
      Array.from(
        { length: 10 },
        (_, i) => `r${String(i * 2).padStart(5, "0")}`,
      ),
    );
    // The 10th kept row is r00018: nothing after it was consumed, so nothing is skipped.
    expect(step.next).toBe("r00018");
    expect(step.end).toBe(false);
    expect(step.depth).toBe(1);
  });

  test("a step that reaches its page bound before `limit` rows ends at that page's cursor, never at the cap (more may follow)", () => {
    const reports = new Map<number, Entry>();
    let after: string | null = null;
    for (let i = 0; i < 3; i += 1) {
      const rows = rowsOf(i * 100, 100);
      const next = rows.at(-1)?.id ?? null;
      reports.set(i, page(after, rows, next));
      after = next;
    }
    const step = scanStep(reports, null, () => false, 100, 3);
    expect(step).toMatchObject({
      settled: true,
      next: "r00299",
      end: false,
      rows: [],
    });
  });

  test("the last page ends the walk: `end`, no `next`", () => {
    const step = scanStep(
      new Map([[0, page(null, rowsOf(0, 30), null)]]),
      null,
      all,
      100,
      20,
    );
    expect(step).toMatchObject({ settled: true, next: null, end: true });
    expect(step.rows).toHaveLength(30);
  });

  test("a later page still loading (or a stale report) is NOT a settled step: the rows so far are partial", () => {
    const first = rowsOf(0, 100);
    const loading = scanStep(
      new Map([
        [0, page(null, first, "r00099")],
        [1, page("r00099", [], null, "loading")],
      ]),
      null,
      () => false,
      100,
      20,
    );
    expect(loading.settled).toBe(false);
    expect(loading.end).toBe(false);
    expect(loading.depth).toBe(2);
    const stale = scanStep(
      new Map([
        [0, page(null, first, "r00099")],
        [1, page("somewhere-else", [], null)],
      ]),
      null,
      () => false,
      100,
      20,
    );
    expect(stale.settled).toBe(false);
    const failed = scanStep(
      new Map([
        [0, page(null, first, "r00099")],
        [1, page("r00099", [], null, "failed")],
      ]),
      null,
      () => false,
      100,
      20,
    );
    expect(failed).toMatchObject({ status: "failed", settled: false });
  });

  test("a step starts where it is told: a report read after another cursor is not this step's", () => {
    const step = scanStep(
      new Map([[0, page(null, rowsOf(0, 10), null)]]),
      "r00004",
      all,
      100,
      20,
    );
    expect(step.status).toBe("loading");
    expect(step.settled).toBe(false);
  });
});

describe("chainResult", () => {
  test("complete only when every page to the last has reported ready", () => {
    const complete = chainResult(
      new Map([
        [0, page(null, rowsOf(0, 100), "r00099")],
        [1, page("r00099", rowsOf(100, 1), null)],
      ]),
      10,
    );
    expect(complete).toMatchObject({ status: "ready", complete: true });
    expect(complete.rows).toHaveLength(101);
  });

  test("a later page loading, absent or failed leaves READABLE rows but no complete inventory", () => {
    for (const status of ["loading", "absent", "failed"] as const) {
      const partial = chainResult(
        new Map([
          [0, page(null, rowsOf(0, 100), "r00099")],
          [1, page("r00099", [], null, status)],
        ]),
        10,
      );
      expect(partial.complete).toBe(false);
      expect(partial.rows).toHaveLength(100);
    }
    const missing = chainResult(
      new Map([[0, page(null, rowsOf(0, 100), "r00099")]]),
      10,
    );
    expect(missing).toMatchObject({ status: "ready", complete: false });
  });

  test("the cap is not completion either", () => {
    const capped = chainResult(
      new Map([[0, page(null, rowsOf(0, 100), "r00099")]]),
      1,
    );
    expect(capped).toMatchObject({ capped: true, complete: false });
  });
});
