import {
  type AccountService,
  type DataEnv,
  issueTimerOrderNow,
  useTimerCopy,
} from "../../../data";
import { type AccountTimerSession, parseAccountTimer } from "../model/contract";

/**
 * The running-timer copy of the displayed account's database (W28, D-10c-4), parsed row by row: a row that does not parse is left out,
 * never guessed. `null`: no copy (none was ever written here, or it is unreadable).
 */
export interface TimerCopy {
  /** ms, when the read the copy was written from was issued: shown ("last checked"), never compared. */
  readAt: number;
  /** That read's place in the observation order (W28; 0 for a copy written before the order existed). */
  order: number;
  /**
   * The copy lists every running session its read could see, and every row of it was read here (review R14): only then does a session
   * it does not list count as not running at its order. A row that does not parse makes it incomplete (what it held is not known).
   */
  complete: boolean;
  /** Every row read, restricted ones included (a restricted row lists its session, though it offers nothing). */
  rows: AccountTimerSession[];
}

export function useCopiedTimers(): TimerCopy | null {
  const copy = useTimerCopy();
  if (copy.status !== "ready" || copy.value === null) return null;
  const rows: AccountTimerSession[] = [];
  let lost = false;
  for (const raw of copy.value.running) {
    const row = parseAccountTimer(raw);
    if (row !== null && row.stopped_at === null) rows.push(row);
    else lost = true;
  }
  return {
    readAt: copy.value.read_at,
    order: copy.value.order,
    complete: copy.value.complete && !lost,
    rows,
  };
}

/** The epoch of a displayed identity (`account:epoch`). */
export const epochOf = (identity: string): number =>
  Number(identity.slice(identity.lastIndexOf(":") + 1));

/** A timer read about to be sent: the binding it is asked under and its place in the observation order (W28). */
export interface IssuedRead {
  service: AccountService;
  captured: ReturnType<AccountService["capture"]>;
  order: number;
}

/**
 * Gives a timer read its place in the observation order BEFORE it is sent (review R10, design assessment DA-T2). `null`: none (no open
 * service, another identity, a store failure): the read is still shown, but it neither corrects nor replaces the copy.
 */
export async function issueTimerRead(
  data: Pick<DataEnv, "service">,
  identity: string,
): Promise<IssuedRead | null> {
  const service = data.service();
  if (service === null || service === undefined) return null;
  const captured = service.capture(epochOf(identity));
  const order = await issueTimerOrderNow(service, captured);
  return order === null ? null : { service, captured, order };
}
