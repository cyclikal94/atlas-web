import type { Reconciled } from "../../../src/data/model/reconcile";
import type {
  DraftRow,
  DraftWithCommand,
  PendingEffectRow,
  ResourceVersionRow,
} from "../../../src/data/model/types";
import { headerOf } from "./rows";

/**
 * The reference for the reconciliation of a delta page: the final rows that the WHOLE-POPULATION function (`reconcilePage`) implies for a
 * starting state, applied in plain JavaScript. The page-commit plan, which reconciles in windows, must leave exactly these rows.
 */
export interface State {
  effects: PendingEffectRow[];
  versions: ResourceVersionRow[];
  drafts: DraftWithCommand[];
}

export const byKey = <T>(rows: readonly T[], key: (row: T) => string): T[] =>
  [...rows].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));

/** The final rows the reference function implies, applied to the starting state in plain JavaScript. */
export function expected(state: State, reconciled: Reconciled) {
  const effects = new Map(
    state.effects.map((e) => [JSON.stringify([e.resource_id, e.local_id]), e]),
  );
  for (const key of reconciled.effectDeletes)
    effects.delete(JSON.stringify(key));
  for (const row of reconciled.effectPuts)
    effects.set(JSON.stringify([row.resource_id, row.local_id]), row);
  const drafts = new Map<string, DraftRow>(
    state.drafts.map((d) => [d.local_id, headerOf(d)]),
  );
  const bodies = new Set(state.drafts.map((d) => d.local_id));
  for (const id of reconciled.draftDeletes) {
    drafts.delete(id);
    bodies.delete(id);
  }
  for (const row of reconciled.draftPuts) drafts.set(row.local_id, row);
  const versions = new Map(state.versions.map((v) => [v.resource_id, v]));
  for (const id of reconciled.versionDeletes) versions.delete(id);
  for (const row of reconciled.versionPuts) versions.set(row.resource_id, row);
  return {
    effects: byKey([...effects.values()], (e) =>
      JSON.stringify([e.resource_id, e.local_id]),
    ),
    drafts: byKey([...drafts.values()], (d) => d.local_id),
    bodies: [...bodies].sort(),
    versions: byKey([...versions.values()], (v) => v.resource_id),
  };
}
