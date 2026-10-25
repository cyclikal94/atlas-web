import { useTimerCopy } from "../../../data";
import { type AccountTimerSession, parseAccountTimer } from "../model/contract";

/**
 * The running-timer copy of the displayed account's database (W28, D-10c-4), parsed row by row: a row that does not parse is left out,
 * never guessed. `null`: no copy (none was ever written here, or it is unreadable).
 */
export interface TimerCopy {
  /** ms, when the read the copy was written from was issued. */
  readAt: number;
  complete: boolean;
  rows: AccountTimerSession[];
}

export function useCopiedTimers(): TimerCopy | null {
  const copy = useTimerCopy();
  if (copy.status !== "ready" || copy.value === null) return null;
  const rows: AccountTimerSession[] = [];
  for (const raw of copy.value.running) {
    const row = parseAccountTimer(raw);
    if (row !== null && row.stopped_at === null) rows.push(row);
  }
  return { readAt: copy.value.read_at, complete: copy.value.complete, rows };
}
