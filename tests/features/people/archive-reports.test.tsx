import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { useLayoutEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  type LedgerState,
  ledgerReported,
} from "../../../src/features/people/archived/ArchivedItems";
import {
  archivedLedgerKinds,
  type LedgerReport,
} from "../../../src/features/people/archived/ledger";
import { forgetAllPeopleMemory } from "../../../src/features/people/memory";
import {
  type Child,
  type Report,
  reported,
  scanStep,
} from "../../../src/features/people/reads";
import { installMatchMedia } from "../../helpers/match-media";
import { cacheRow } from "../../support/data/rows";
import { peopleWorld, person } from "../../support/people/world";

/**
 * Review 5, finding 2 (C12): the archive ledger's reports belong to their CURRENT owner and reading (U4), and the registry's contract
 * holds for any kind, not only People's (U6). Fixture evidence: pure reductions, then the production ledger with a synthetic kind.
 */
installMatchMedia({ width: 1440 });
beforeEach(() => forgetAllPeopleMemory());
afterEach(() => cleanup());

const F = "66666666-6666-4666-8666-666666666666";

/**
 * Adapted in revision 17 (WEB-11a review 16, R16.1). U4 tested `parentReported`, the reduction of a field row's SEPARATE parent read, which no
 * longer exists: a field and its person are now one answer of a page read (`Child`), reported per page. U4's intent is kept on that report:
 * an answer of an earlier read (another cursor at the same position) is never counted for the current step, a later page that no longer holds
 * the parent withdraws what earlier pages kept, and the current read's reports are followed (control). The original file is kept in
 * `.agtx/evidence/WEB-11a/revision-17/original-tests/archive-reports.test.tsx.orig`.
 */
describe("U4: a page's report (a field with its parent) is counted only for the current read", () => {
  const P = "55555555-5555-4555-8555-555555555555";
  const child = (id: string): Child => ({
    row: cacheRow({ id, kind: "field", parent_id: P, archived: true }),
    parent: cacheRow({ id: P, kind: "person", label: "Mo" }),
    drafts: [],
  });
  type Entry = { after: string | null; report: Report<Child, string> };
  const page = (
    after: string | null,
    rows: Child[],
    next: string | null,
    extra: Partial<Report<Child, string>> = {},
  ): Entry => ({ after, report: { status: "ready", rows, next, ...extra } });
  const step = (entries: Array<[number, Entry]>, start: string | null = null) =>
    scanStep(
      new Map(entries),
      start,
      () => true,
      100,
      5,
      (c: Child) => c.row.id,
    );

  test("an earlier read's late report at the same position (another cursor) is never counted: loading, not its rows", () => {
    const now = step([[0, page("previous-start", [child(F)], null)]], null);
    expect(now.status).toBe("loading");
    expect(now.rows).toEqual([]);
    expect(now.settled).toBe(false);
  });

  test("a later page whose read no longer holds the parent withdraws what earlier pages kept (nothing shown, never settled)", () => {
    const now = step([
      [0, page(null, [child(F)], "f1")],
      [1, page("f1", [], null, { hidden: true })],
    ]);
    expect(now.rows).toEqual([]);
    expect(now.hidden).toBe(true);
    expect(now.settled).toBe(false);
  });

  test("control: the current read's pages are followed to the end, and their rows kept", () => {
    const now = step([
      [0, page(null, [child(F)], "f1")],
      [1, page("f1", [child("f2")], null)],
    ]);
    expect(now.rows.map((c) => c.row.id)).toEqual([F, "f2"]);
    expect(now.settled).toBe(true);
    expect(now.hidden).toBeUndefined();
  });

  test("an earlier read's LATE CLEANUP at the same position withdraws nothing; the current read's own withdrawal does", () => {
    const earlier = page(null, [child(F)], null);
    const current = page("f0", [child("f2")], null);
    const now = reported(
      reported(new Map(), 0, earlier.after, earlier.report),
      0,
      current.after,
      current.report,
    );
    expect(now.get(0)?.after).toBe("f0");
    // The earlier read's cleanup, applied after the current read reported.
    expect(reported(now, 0, null, null)).toBe(now);
    // Control: the current read withdraws its own report.
    expect(reported(now, 0, "f0", null).has(0)).toBe(false);
  });

  test("the ledger applies a kind's report only for its own reading, whenever the update is applied", () => {
    const report: LedgerReport = { count: 0, state: "complete" };
    const before: LedgerState = { reading: 1, reports: {} };
    const now = ledgerReported(before, 1, "field", report);
    expect(now.reports.field).toEqual(report);
    // A report (or withdrawal) of reading 0 applied after Try again started reading 1.
    expect(ledgerReported(now, 0, "field", { count: 0, state: "failed" })).toBe(
      now,
    );
    expect(ledgerReported(now, 0, "field", null)).toBe(now);
    // Control: the current reading withdraws.
    expect(ledgerReported(now, 1, "field", null).reports).toEqual({});
  });
});

describe("U6: any registered kind blocks 'Nothing archived' until it reports complete (the registry contract)", () => {
  let say: (mode: LedgerReport["state"] | "withdrawn") => void = () => {};
  function Synthetic({
    report,
  }: {
    report(report: LedgerReport | null): void;
  }) {
    const [mode, setMode] = useState<LedgerReport["state"] | "withdrawn">(
      "loading",
    );
    say = (next) => act(() => setMode(next));
    useLayoutEffect(() => {
      report(mode === "withdrawn" ? null : { count: 0, state: mode });
    }, [mode, report]);
    return null;
  }
  archivedLedgerKinds.register({ id: "synthetic", order: 30, Rows: Synthetic });

  test("loading, withdrawn and failed are never empty; complete with nothing is", async () => {
    const EMPTY = /Nothing archived/;
    const failed = () =>
      document.querySelector('[data-archived-state="failed"]');
    const settle = () => act(() => new Promise((r) => setTimeout(r, 0)));
    const w = peopleWorld();
    w.setCache([person({ label: "Mo" })]);
    await w.mount("/settings/archived");
    await screen.findByRole("heading", { level: 1, name: "Archived items" });
    await settle();
    expect(screen.queryByText(EMPTY)).toBeNull();
    say("complete");
    await waitFor(() => expect(screen.queryByText(EMPTY)).not.toBeNull());
    say("withdrawn");
    await settle();
    expect(screen.queryByText(EMPTY)).toBeNull();
    say("failed");
    await waitFor(() => expect(failed()).not.toBeNull());
    expect(screen.queryByText(EMPTY)).toBeNull();
  });
});
