import { DATA_CONFIG, type DataConfig } from "./config";

/**
 * The quota reserve policy (plan 5.4.6; FP:507-513). The origin's estimated free space must leave room for `atlas-auth`, so a
 * lease or an observation write never fails because the data stores filled the origin. The exhaustion screen therefore applies
 * to the DATA stores first: cache pages are refused before user input, and user input (drafts, recovery copies) is the LAST
 * thing refused. `reserveBytes` is provisional and unmeasured (P-Q sizes it); it is reported, not decided.
 *
 * `free = null` means `navigator.storage.estimate()` is missing or threw: the guard reports `unknown` and the engine relies on
 * actual failures.
 *
 * The estimate is the origin's, so it already includes the other tabs' writes once it is read again; the guard therefore re-reads
 * it after every successful growth of the stores and when another tab says it wrote (`data_changed`), and holds the bytes of the
 * writes that are in flight against it, so several saves near exhaustion cannot each be admitted by the same stale figure.
 */
export type QuotaKind = "cache" | "input";
export type QuotaVerdict = "ok" | "refuse" | "unknown";

export function decideQuota(
  free: number | null,
  kind: QuotaKind,
  estimatedBytes: number,
  config: Pick<DataConfig, "quotaReserveBytes"> = DATA_CONFIG,
): QuotaVerdict {
  if (free === null) return "unknown";
  if (kind === "cache")
    return free < config.quotaReserveBytes + estimatedBytes ? "refuse" : "ok";
  // User input is the last thing refused: only when the write itself would leave less than HALF the reserve. The size of the write
  // counts (a 1 MiB import must not be admitted because the space before it was enough).
  return free - estimatedBytes < config.quotaReserveBytes / 2 ? "refuse" : "ok";
}

export function freeBytes(estimate: {
  usage?: number;
  quota?: number;
}): number | null {
  if (
    typeof estimate.quota !== "number" ||
    typeof estimate.usage !== "number" ||
    !Number.isFinite(estimate.quota) ||
    !Number.isFinite(estimate.usage)
  )
    return null;
  return Math.max(0, estimate.quota - estimate.usage);
}
