import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { useLayoutEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  type LedgerState,
  ledgerReported,
  type ParentReport,
  parentReported,
} from "../../../src/features/people/archived/ArchivedItems";
import {
  archivedLedgerKinds,
  type LedgerReport,
} from "../../../src/features/people/archived/ledger";
import { forgetAllPeopleMemory } from "../../../src/features/people/memory";
import { installMatchMedia } from "../../helpers/match-media";
import { peopleWorld, person } from "../../support/people/world";

/**
 * Review 5, finding 2 (C12): the archive ledger's reports belong to their CURRENT owner and reading (U4), and the registry's contract
 * holds for any kind, not only People's (U6). Fixture evidence: pure reductions, then the production ledger with a synthetic kind.
 */
installMatchMedia({ width: 1440 });
beforeEach(() => forgetAllPeopleMemory());
afterEach(() => cleanup());

const F = "66666666-6666-4666-8666-666666666666";

describe("U4: a field's parent report is applied only for its current owner", () => {
  const empty: ReadonlyMap<string, ParentReport> = new Map();

  const replaced = () =>
    parentReported(
      parentReported(empty, F, 1, { parent: "P", state: "hidden" }),
      F,
      2,
      { parent: "Q", state: "loading" },
    );

  test("a later owner's report replaces an earlier one's; the earlier one's LATE REPORT changes nothing", () => {
    const second = replaced();
    expect(second.get(F)).toEqual({ owner: 2, parent: "Q", state: "loading" });
    // The earlier owner's late answer, even for the same parent and state as the current one.
    expect(
      parentReported(second, F, 1, { parent: "Q", state: "loading" }),
    ).toBe(second);
    expect(parentReported(second, F, 1, { parent: "P", state: "hidden" })).toBe(
      second,
    );
  });

  test("the earlier owner's LATE CLEANUP after the replacement published withdraws nothing; the current owner's own withdrawal does", () => {
    const second = replaced();
    expect(parentReported(second, F, 1, null)).toBe(second);
    // Control: the current owner withdraws its own report.
    expect(parentReported(second, F, 2, null).has(F)).toBe(false);
  });

  test("control: the current owner's reports follow its read (loading, then settled), and an unchanged report keeps the same state", () => {
    const loading = parentReported(empty, F, 3, {
      parent: "P",
      state: "loading",
    });
    const hidden = parentReported(loading, F, 3, {
      parent: "P",
      state: "hidden",
    });
    expect(hidden.get(F)?.state).toBe("hidden");
    expect(parentReported(hidden, F, 3, { parent: "P", state: "hidden" })).toBe(
      hidden,
    );
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
