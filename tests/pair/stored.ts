import type { Page } from "@playwright/test";

// WEB-09c revision 30 (R30-DIAG; design assessment Q6b): the pair spec's RAW stored read, moved unchanged (plus the database incarnation,
// C1) out of tests/pair/support.ts so the native fixture qualification (tests/e2e/fixture.pair-rendering.spec.ts) drives the very same
// read inside the maintained capture composition without importing the pair runner's bridge, proxy or evidence state.

// ---- what the browser stores: raw IndexedDB, one read-only transaction ---------------------------------------------------------------
export interface CacheLike {
  id: string;
  kind: string;
  parent_id: string | null;
  label: string;
  value: unknown;
  version: number;
}
export interface Stored {
  /** Revision 30 (R30-DIAG, C1): the database's lifetime (`sync_state.incarnation_id`); another one is a replaced database. */
  incarnation: string | null;
  cursor: string | null;
  phase: string | null;
  cache_status: string | null;
  applied_revision: number | null;
  page_seq: number | null;
  request_seq: number | null;
  composition_seq: number;
  delta_stage: {
    revision: number;
    next_index: number;
    boundary_cursor: string;
    cursor: string;
  } | null;
  staged: number;
  drafts: number;
  /** The live cache's identity: sorted id:version pairs, hashed in the page (never the values, so the read stays small). */
  cache_digest: string;
  cache_count: number;
  rows?: CacheLike[];
  /** Revision 27 (R27-DIAG.b): the recovery's own fields and its hidden snapshot staging, read in the SAME transaction. */
  recovery_generation: number | null;
  staging_position: unknown | null;
  staging_rows: number;
  /** The distinct `recovery_generation` tags of the staged snapshot rows (sorted). */
  staging_generations: number[];
  /** Revision 27 (C4): the local work, only when asked (`local`): every draft row and pending effect, and whether the cache holds `ids`. */
  local?: LocalWork;
}
export interface LocalWork {
  drafts: Array<{
    local_id: string;
    status: string;
    command_digest: string;
    receipt_revision: number | null;
    target_resource_ids: string[];
    attempts: number;
  }>;
  effects: Array<{
    local_id: string;
    resource_id: string;
    receipt_revision: number | null;
    submitted_at_request_seq: number | null;
  }>;
  in_cache: Record<string, number>;
}
/**
 * The account database read with RAW IndexedDB in ONE read-only transaction (a connection opened without a version, closed at once): the
 * harness's Dexie reads may lag the engine's commit (WEB-09c revision 20). Null while the database does not exist (it is never created
 * here: `indexedDB.databases()` is asked first).
 */
export const stored = (
  page: Page,
  account: string,
  withRows = false,
  localIds: string[] | null = null,
): Promise<Stored | null> =>
  page.evaluate(
    async ({ name, rows, local }) => {
      const names = (await indexedDB.databases()).map((d) => d.name);
      if (!names.includes(name)) return null;
      return new Promise<Stored | null>((resolve, reject) => {
        const open = indexedDB.open(name);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const wanted = [
            "sync_state",
            "cache",
            "delta_staging",
            "drafts",
            "cache_staging",
            "pending_effects",
          ];
          if (!wanted.every((s) => db.objectStoreNames.contains(s))) {
            db.close();
            resolve(null);
            return;
          }
          const tx = db.transaction(wanted, "readonly");
          const sync = tx.objectStore("sync_state").get("singleton");
          const cache = tx.objectStore("cache").getAll();
          const staged = tx.objectStore("delta_staging").count();
          const drafts = tx.objectStore("drafts").count();
          // Revision 27: the hidden snapshot staging (its size and generations, never its values) and, when asked, the local work.
          const staging = tx.objectStore("cache_staging").getAll();
          const draftRows = local ? tx.objectStore("drafts").getAll() : null;
          const effects = local
            ? tx.objectStore("pending_effects").getAll()
            : null;
          tx.oncomplete = async () => {
            db.close();
            const row = (sync.result ?? {}) as Record<string, unknown>;
            const all = cache.result as Array<Record<string, unknown>>;
            const pairs = all
              .map((r) => `${String(r.id)}:${String(r.version)}`)
              .sort()
              .join("\n");
            const digest = Array.from(
              new Uint8Array(
                await crypto.subtle.digest(
                  "SHA-256",
                  new TextEncoder().encode(pairs),
                ),
              ),
            )
              .map((b) => b.toString(16).padStart(2, "0"))
              .join("");
            resolve({
              incarnation:
                typeof row.incarnation_id === "string"
                  ? row.incarnation_id
                  : null,
              cursor: (row.cursor as string | null) ?? null,
              phase: (row.phase as string | null) ?? null,
              cache_status: (row.cache_status as string | null) ?? null,
              applied_revision: (row.applied_revision as number | null) ?? null,
              page_seq: (row.page_seq as number | null) ?? null,
              request_seq: (row.request_seq as number | null) ?? null,
              composition_seq: (row.composition_seq as number | undefined) ?? 0,
              delta_stage: (row.delta_stage as Stored["delta_stage"]) ?? null,
              staged: staged.result,
              drafts: drafts.result,
              cache_digest: digest,
              cache_count: all.length,
              recovery_generation:
                (row.recovery_generation as number | null) ?? null,
              staging_position: row.staging_position ?? null,
              staging_rows: (staging.result as unknown[]).length,
              staging_generations: [
                ...new Set(
                  (
                    staging.result as Array<{ recovery_generation: number }>
                  ).map((x) => x.recovery_generation),
                ),
              ].sort((a, b) => a - b),
              ...(local
                ? {
                    local: {
                      drafts: (
                        (draftRows?.result ?? []) as Array<
                          Record<string, unknown>
                        >
                      ).map((d) => ({
                        local_id: d.local_id as string,
                        status: d.status as string,
                        command_digest: d.command_digest as string,
                        receipt_revision:
                          (d.receipt_revision as number | null) ?? null,
                        target_resource_ids:
                          (d.target_resource_ids as string[]) ?? [],
                        attempts: (d.attempts as number) ?? 0,
                      })),
                      effects: (
                        (effects?.result ?? []) as Array<
                          Record<string, unknown>
                        >
                      ).map((e) => ({
                        local_id: e.local_id as string,
                        resource_id: e.resource_id as string,
                        receipt_revision:
                          (e.receipt_revision as number | null) ?? null,
                        submitted_at_request_seq:
                          (e.submitted_at_request_seq as number | null) ?? null,
                      })),
                      in_cache: Object.fromEntries(
                        local.map((id: string) => [
                          id,
                          all.filter((r) => r.id === id).length,
                        ]),
                      ),
                    },
                  }
                : {}),
              ...(rows
                ? {
                    rows: all.map((r) => ({
                      id: r.id as string,
                      kind: r.kind as string,
                      parent_id: (r.parent_id as string | null) ?? null,
                      label: r.label as string,
                      value: r.value,
                      version: r.version as number,
                    })),
                  }
                : {}),
            });
          };
          tx.onerror = () => reject(tx.error);
        };
      });
    },
    { name: `atlas-${account}`, rows: withRows, local: localIds },
  );
