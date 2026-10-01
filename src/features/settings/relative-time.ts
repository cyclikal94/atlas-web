/** Plain relative times for the session and device rows ("3 hours ago", "in 2 days"). Display only. */
const UNITS: ReadonlyArray<readonly [string, number]> = [
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];

function amount(ms: number): string {
  for (const [unit, size] of UNITS) {
    if (ms >= size) {
      const n = Math.floor(ms / size);
      return `${n} ${unit}${n === 1 ? "" : "s"}`;
    }
  }
  return "";
}

/** "just now", "5 minutes ago", "3 hours ago", "2 days ago"; empty when the instant is unreadable. */
export function formatAgo(iso: string | null | undefined, now: Date): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const ms = now.getTime() - then;
  if (ms < 60_000) return "just now";
  return `${amount(ms)} ago`;
}

/** "in 5 minutes", "in 3 hours", "in 2 days", or "expired" once passed. */
export function formatIn(iso: string | null | undefined, now: Date): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const ms = then - now.getTime();
  if (ms <= 0) return "expired";
  if (ms < 60_000) return "in under a minute";
  return `in ${amount(ms)}`;
}
