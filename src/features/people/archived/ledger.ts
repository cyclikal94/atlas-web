import type { ComponentType } from "react";

/**
 * The Settings "Archived items" ledger's KINDS (D-11a-11). The ledger is WEB-11a's; each slice that archives something adds its own kind
 * here (WEB-10a tasks, WEB-10b lists) without editing the ledger: a component that renders that kind's archived rows as `<li>` items
 * ("Kind | Name | Restore") and REPORTS what it knows (`LedgerReport`), so the ledger knows when it is empty. Registering an id twice is a
 * defect.
 *
 * A REPORT IS AN INVENTORY STATE, NOT A NUMBER (WEB-11a review 4 of 23 October 2026, finding 5). A kind says `complete` only when every
 * read it needs (its rows, the drafts folded over them, anything that decides whether a row is shown) succeeded and nothing more follows;
 * `loading` while any is still on its way; `failed` when one failed or could not be completed (what it shows is then partial). It reports
 * again on every change (a new step, a reload) and withdraws its report (`null`) when it unmounts, so an earlier count is never taken for
 * the current one. The ledger says "Nothing archived" only when every kind is `complete` with nothing shown.
 */
export interface LedgerReport {
  /** How many rows it shows now (a kind with a further step to move to counts one more: it is never empty). */
  count: number;
  state: "loading" | "failed" | "complete";
}

export interface ArchivedLedgerKind {
  id: string;
  /** Lower first. */
  order: number;
  Rows: ComponentType<{ report(report: LedgerReport | null): void }>;
}

const kinds = new Map<string, ArchivedLedgerKind>();

export const archivedLedgerKinds = {
  register(kind: ArchivedLedgerKind): void {
    const known = kinds.get(kind.id);
    if (known === kind) return;
    if (known !== undefined)
      throw new Error(`an archived-items kind is registered twice: ${kind.id}`);
    kinds.set(kind.id, kind);
  },
  list(): ArchivedLedgerKind[] {
    return [...kinds.values()].sort((a, b) => a.order - b.order);
  },
};
