import type { OccurrenceData, RotaState, TaskDefinition } from "./contract";
import { addDays } from "./time";

/**
 * Rotas (CM-356; TASK-15, 29, 32; WF-TASK-05; WEB-10c D-10c-9/11). PURE.
 *
 * A rota is an Anyone task's ordered roster of up to 8 accounts. `set_rota` REPLACES the order and resets the next turn to the first
 * (ordinal 0); `rota_consent` is each person's own "Take turns" answer, separate from the order. A turn is set when the server generates
 * a day: `participants[ordinal % n]` when that person still takes part and has agreed, otherwise left open (`account_id: null`); an empty
 * roster sets no turns. Turns already set keep their person whatever the order becomes.
 */
export const MAX_ROSTER = 8;

/** A roster with `id` added at the end (unique, at most 8): the same list when it cannot be. */
export function addTo(order: readonly string[], id: string): string[] {
  if (order.includes(id) || order.length >= MAX_ROSTER) return [...order];
  return [...order, id];
}

export const removeFrom = (order: readonly string[], id: string): string[] =>
  order.filter((x) => x !== id);

/** `id` moved one place earlier (`-1`) or later (`+1`); unchanged at an end. */
export function move(
  order: readonly string[],
  id: string,
  by: -1 | 1,
): string[] {
  const at = order.indexOf(id);
  const to = at + by;
  if (at < 0 || to < 0 || to >= order.length) return [...order];
  const out = [...order];
  out[at] = out[to] as string;
  out[to] = id;
  return out;
}

/** The days this device holds with their turn, newest first. */
export interface SetTurn {
  occurrenceId: string;
  date: string | null;
  accountId: string | null;
  revision: number;
  ordinal: number;
}

export function setTurns(
  days: ReadonlyArray<{ id: string; data: OccurrenceData }>,
): SetTurn[] {
  return days
    .flatMap((day) =>
      day.data.rota
        ? [
            {
              occurrenceId: day.id,
              date: day.data.slot.date,
              accountId: day.data.rota.account_id,
              revision: day.data.rota.revision,
              ordinal: day.data.rota.ordinal,
            },
          ]
        : [],
    )
    .sort(
      (a, b) =>
        (b.date ?? "").localeCompare(a.date ?? "") ||
        b.ordinal - a.ordinal ||
        b.occurrenceId.localeCompare(a.occurrenceId),
    );
}

/**
 * The ordinal of the next turn of the SAVED order: after the latest day this device holds whose turn was set under the current roster
 * version, else 0 (a roster saved since, or nothing set yet).
 */
export function nextOrdinal(
  turns: readonly SetTurn[],
  state: Pick<RotaState, "version">,
): number {
  const latest = turns.find((t) => t.revision === state.version);
  return latest === undefined ? 0 : latest.ordinal + 1;
}

const ymd = (date: string) =>
  date.split("-").map(Number) as [number, number, number];
const dayNumber = (date: string) => {
  const [y, m, d] = ymd(date);
  return Date.UTC(y, m - 1, d) / 86_400_000;
};
const isoOf = (y: number, m: number, d: number) =>
  `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/**
 * The next `count` dates of a repeating task after `after`, as the server generates them (`crates/core/src/tasks/schedule.rs`, `slots`):
 * every candidate is derived from the schedule's OWN start date (`start + n × interval` days, weeks, months or years), never from the
 * previous result, and a month or year whose day does not exist (31 April, 29 February outside a leap year) is SKIPPED, not clamped. The
 * walk starts at the candidate the server would reach for `after` and is bounded as the server's is (4,096 probes).
 */
export function nextDates(
  definition: TaskDefinition,
  after: string,
  count: number,
): string[] {
  const { repeat, start_date: start } = definition.schedule;
  if (repeat === null || repeat.frequency === "after_completion") return [];
  if (start === null) return [];
  const [sy, sm, sd] = ymd(start);
  const [ay, am] = ymd(after);
  const n = repeat.interval;
  let index = 0;
  if (after > start) {
    const distance =
      repeat.frequency === "daily"
        ? dayNumber(after) - dayNumber(start)
        : repeat.frequency === "weekly"
          ? Math.floor((dayNumber(after) - dayNumber(start)) / 7)
          : repeat.frequency === "monthly"
            ? (ay - sy) * 12 + am - sm
            : ay - sy;
    index = Math.floor(distance / n);
  }
  const out: string[] = [];
  for (let probes = 0; out.length < count && probes < 4096; probes += 1) {
    const step = index * n;
    index += 1;
    let candidate: string | null;
    if (repeat.frequency === "daily") candidate = addDays(start, step);
    else if (repeat.frequency === "weekly")
      candidate = addDays(start, 7 * step);
    else {
      const total =
        sy * 12 + (sm - 1) + (repeat.frequency === "yearly" ? 12 * step : step);
      const year = Math.floor(total / 12);
      const month = (total % 12) + 1;
      if (year > 9999) break;
      const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
      candidate = sd > last ? null : isoOf(year, month, sd);
    }
    if (candidate === null || candidate <= after) continue;
    out.push(candidate);
  }
  return out;
}

export type Projected =
  | { kind: "person"; accountId: string }
  /** The person in that place has not agreed to take turns (known for eligible accounts only): the turn is left open. */
  | { kind: "open"; accountId: string }
  /** An empty order: no turns are set. */
  | { kind: "none" };

/**
 * What the order would give the next days: `order[(ordinal + i) % n]`. An order not saved yet projects from the first place (saving resets
 * the next turn to 0). A person known not to have agreed (an editor sees who has: `eligible`) is shown as left open.
 */
export function project(input: {
  order: readonly string[];
  saved: boolean;
  ordinal: number;
  count: number;
  eligible: readonly string[] | null;
}): Projected[] {
  if (input.order.length === 0)
    return Array.from({ length: input.count }, () => ({ kind: "none" }));
  const start = input.saved ? input.ordinal : 0;
  return Array.from({ length: input.count }, (_, i) => {
    const accountId = input.order[(start + i) % input.order.length] as string;
    return input.eligible !== null && !input.eligible.includes(accountId)
      ? { kind: "open", accountId }
      : { kind: "person", accountId };
  });
}

/** Who a turn names, in words: "You", a username this page knows (household membership), else the anonymous label. */
export function labelOf(
  accountId: string,
  me: string,
  usernames: ReadonlyMap<string, string>,
  anonymous: (id: string) => string,
): string {
  if (accountId === me) return "You";
  return usernames.get(accountId) ?? anonymous(accountId);
}
