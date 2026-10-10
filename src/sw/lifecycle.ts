import type { ReportAck } from "../lib/pwa/protocol";
import {
  activeIsNewer,
  generationOfCache,
  generationsOfEntry,
  planRetention,
  precacheCacheName,
} from "./core";
import type { SwState } from "./state";

/**
 * The worker's lifecycle steps over injected platform parts (WEB-14a D-P3), so they are unit-tested without a browser. `src/sw.ts` calls
 * them from `install`, `activate` and `message`.
 */
export interface LifecycleDeps {
  /** This worker's generation and its files. */
  own: { generation: string; paths: readonly string[] };
  state: SwState;
  caches: {
    keys(): Promise<readonly string[]>;
    delete(name: string): Promise<boolean>;
  };
  /** Every window client of the origin, controlled or not. */
  windows(): Promise<ReadonlyArray<{ id: string }>>;
  now(): number;
}

/** Installation's record of this generation (after its files are in its cache). */
export async function recordInstalled(deps: LifecycleDeps): Promise<void> {
  const existing = (await deps.state.generations()).find(
    (record) => record.generation === deps.own.generation,
  );
  await deps.state.putGeneration({
    generation: deps.own.generation,
    paths: [...deps.own.paths],
    // A re-install of the same generation keeps when it was first installed (the order of generations is by installation).
    installedAt: existing?.installedAt ?? deps.now(),
    retiredAt: null,
  });
}

/** Activation: every other generation is retired now, and the retention pass runs. */
export async function onActivated(deps: LifecycleDeps): Promise<void> {
  await deps.state.retireAllBut(deps.own.generation, deps.now());
  // This generation may have been retired by an earlier activation of another one and is active again.
  const self = (await deps.state.generations()).find(
    (record) => record.generation === deps.own.generation,
  );
  if (self && self.retiredAt !== null)
    await deps.state.putGeneration({ ...self, retiredAt: null });
  await retentionPass(deps);
}

/**
 * A page's report: the generations its entry belongs to are recorded for its client, and only THEN is the answer built; an entry no
 * generation knows is recorded as nothing (the client stays unacknowledged, which keeps every generation) and answered `generation: null`.
 */
export async function handleReport(
  deps: LifecycleDeps,
  clientId: string,
  entry: string,
  nonce: string,
): Promise<ReportAck> {
  const records = await deps.state.generations();
  const generations = generationsOfEntry(entry, records);
  if (generations.length > 0)
    await deps.state.recordReport(clientId, {
      generations,
      reportedAt: deps.now(),
    });
  return {
    type: "atlas:report-ack",
    nonce,
    generation: generations[0] ?? null,
    active: deps.own.generation,
    newer: activeIsNewer(deps.own.generation, generations, records),
  };
}

/**
 * The retention pass: purges the generations `planRetention` does not keep (their caches and records), and forgets the reports of
 * clients that are no longer open. The active generation's cache is never deleted.
 */
export async function retentionPass(deps: LifecycleDeps): Promise<{
  purged: string[];
}> {
  const names = await deps.caches.keys();
  const retainedNames = new Map<string, string>();
  for (const name of names) {
    const generation = generationOfCache(name);
    if (generation !== null) retainedNames.set(generation, name);
  }
  const records = await deps.state.generations();
  const windows = await deps.windows();
  const reports = await deps.state.clients();
  const open = new Set(windows.map((client) => client.id));
  const plan = planRetention({
    active: deps.own.generation,
    retained: [...retainedNames.keys()].map((generation) => ({
      generation,
      retiredAt:
        records.find((record) => record.generation === generation)?.retiredAt ??
        null,
    })),
    clients: windows.map((client) => ({
      id: client.id,
      reported: reports.get(client.id)?.generations ?? null,
    })),
    now: deps.now(),
  });
  const purged: string[] = [];
  for (const generation of plan.purge) {
    if (generation === deps.own.generation) continue;
    await deps.caches.delete(
      retainedNames.get(generation) ?? precacheCacheName(generation),
    );
    await deps.state.deleteGeneration(generation);
    purged.push(generation);
  }
  for (const clientId of reports.keys())
    if (!open.has(clientId)) await deps.state.deleteClient(clientId);
  return { purged };
}
