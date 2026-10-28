import {
  type AccountService,
  type DataEnv,
  issueTimerOrderNow,
  type TimerAuthorityRecord,
  type TimerCopyRecord,
  useTimerAuthority,
} from "../../../data";
import { type AccountTimerSession, parseAccountTimer } from "../model/contract";
import type { TimerAuthority } from "../model/timers";

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

function parsed(copy: TimerCopyRecord | null): TimerCopy | null {
  if (copy === null) return null;
  const rows: AccountTimerSession[] = [];
  let lost = false;
  for (const raw of copy.running) {
    const row = parseAccountTimer(raw);
    if (row !== null && row.stopped_at === null) rows.push(row);
    else lost = true;
  }
  return {
    readAt: copy.read_at,
    order: copy.order,
    complete: copy.complete && !lost,
    rows,
  };
}

/**
 * The authority a stored snapshot gives (revisions 4 and 5, reviews R19 and R23): every day's scope, the floor, the account's latest
 * complete observation and the sessions listed finished. One builder, so the live screens and an act's re-check judge alike.
 */
export const authorityOf = (record: TimerAuthorityRecord): TimerAuthority => {
  // The account's observation was taken from the copy stored with its order: when a row of that copy does not read here, what it listed
  // is not known, so its absences decide nothing (review R14). One a later partial page replaced stands by itself.
  const copy = parsed(record.copy);
  const account =
    record.account !== null &&
    copy !== null &&
    copy.order === record.account.order &&
    !copy.complete
      ? null
      : record.account;
  return {
    scopes: record.scopes,
    floor: record.floor,
    account,
    ended: new Set(record.ended),
    endedLost: record.endedLost,
    endedThrough: record.endedThrough,
  };
};

/**
 * The copy and the authority it, and every other server-derived running session, is judged by (revision 4, review R19), from ONE read of
 * the displayed account's database: the detail's block and the account's list use the same snapshot and the same rule (`stillRunning`).
 * `authority` is null while that read is not answered (loading, or the store failed): then no copy is shown and no ordered positive is
 * trusted.
 */
export function useTimerEvidence(): {
  copy: TimerCopy | null;
  authority: TimerAuthority | null;
} {
  const read = useTimerAuthority();
  if (read.status !== "ready") return { copy: null, authority: null };
  return { copy: parsed(read.value.copy), authority: authorityOf(read.value) };
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
