import type { ComponentType } from "react";

/**
 * The Settings "Archived items" ledger's KINDS (D-11a-11). The ledger is WEB-11a's; each slice that archives something adds its own kind
 * here (WEB-10a tasks, WEB-10b lists) without editing the ledger: a component that renders that kind's archived rows as `<li>` items
 * ("Kind | Name | Restore") and reports how many it shows, so the ledger knows when it is empty. Registering an id twice is a defect.
 */
export interface ArchivedLedgerKind {
  id: string;
  /** Lower first. */
  order: number;
  Rows: ComponentType<{ report(count: number): void }>;
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
