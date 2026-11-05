import type { PeopleApi, PeopleResult } from "../api";
import type { PeopleEnv } from "../env";
import {
  type ActivityEntry,
  isCurrentMemory,
  type PeopleMemory,
} from "../memory";
import type {
  PersonActivityEvent,
  PersonActivityPage,
} from "../model/activity";

/**
 * WEB-19: how the person detail READS a person's activity timeline (`GET /people/{id}/activity`; backend `docs/people.md` "Activity
 * timeline"). Online-only, identity-bound DISPLAY data, kept in that identity's PAGE memory (`memory.activity`) for the current
 * invalidation only. Nothing is ever written to storage, `/sync`, the service worker or `localStorage`; a reload forgets it.
 *
 *  - ONE PIECE (D-19-3): every read walks the timeline from its first page to the depth the reader asked for (`memory.activityDepth`), and
 *    replaces what was held in one step. Pages of two generations are never stitched together, so an event that has become hidden since
 *    (a narrowed field, a revoked share) cannot survive a refresh. The one exception is "Show older changes" (`extendActivity`), which
 *    follows `next_after` from the read held now, within its generation.
 *  - FRESHNESS (D-19-4): the timeline is invalidated with the summaries (`memory.invalidateSummaries`, `useSummaryFreshness`): any synced
 *    change, any receipt or online command, reconnection, households, every 60 seconds while shown and visible, and the page becoming
 *    visible. An answer that arrives after an invalidation or under another identity applies nothing.
 *  - `404` (the person is not visible now): access was lost, and nothing of the timeline is held (`gone`). `422 invalid_value` for a later
 *    page (its cursor is no longer one the reader may follow): the walk starts again from the first page, at most `STALE_RETRIES` times.
 *  - The answer's `person_id` is the CANONICAL person: on a merged alias's route it is another person (`merged`), and nothing is shown
 *    under the alias (D-19-7).
 *  - Order is the server's (commit order): never re-sorted by `occurred_at`. An event id is kept once, at its first position.
 */
export const ACTIVITY_PREVIEW = 5;
export const ACTIVITY_STEP = 50;
/** At most 10 steps of 50 (the person's field steps' bound): an honest note replaces "Show older changes" there. */
export const ACTIVITY_MAX = 500;
/** How many times a walk whose cursor was refused, or whose pages disagree, starts again before the view says it failed. */
const STALE_RETRIES = 3;

export interface ActivityTimeline {
  /** The canonical person (the route's person here). */
  personId: string;
  /** Deduplicated by id, in the server's order (newest first). */
  items: PersonActivityEvent[];
  /** The cursor after the last item held; null: the start of the recorded history was reached. */
  next: string | null;
  /** Unix seconds: nothing earlier was recorded. */
  coverageStartedAt: number;
}

export type ActivityWalk =
  | { kind: "ok"; timeline: ActivityTimeline }
  | { kind: "failed"; reason: "failed" | "not_found" }
  | { kind: "merged"; canonicalId: string }
  /** A later page refused its cursor (`422`), or the pages disagree (another person, another coverage): start again. */
  | { kind: "restart" }
  | { kind: "superseded" };

/** How many events of the person's timeline the reader asked to see. */
export const depthOf = (memory: PeopleMemory, personId: string): number =>
  memory.activityDepth.get(personId) ?? ACTIVITY_PREVIEW;

/** The depth "Show all changes" / "Show older changes" asks for after `depth`. */
export const nextDepth = (depth: number): number =>
  Math.min(
    ACTIVITY_MAX,
    depth < ACTIVITY_STEP ? ACTIVITY_STEP : depth + ACTIVITY_STEP,
  );

function failureOf(result: { kind: string }): "failed" | "not_found" {
  return result.kind === "not_found" ? "not_found" : "failed";
}

/**
 * One read of the timeline from its first page until `depth` events are held or the start of the recorded history is reached. `current`
 * is asked before and after every page: once it says no, the walk stops (`superseded`). `depth` is asked before every page too: a
 * "Show all changes" / "Show older changes" / "Show fewer" pressed while this read is on its way (the earlier answer shown, busy) moves
 * the depth this read stops at, within its one piece (R-1).
 */
export async function walkActivity(
  api: Pick<PeopleApi, "readPersonActivity">,
  personId: string,
  depthNow: () => number,
  current: () => boolean,
): Promise<ActivityWalk> {
  const items: PersonActivityEvent[] = [];
  const seen = new Set<string>();
  let after: string | null = null;
  let coverage: number | null = null;
  let depth = depthNow();
  // Bounded whatever the server answers: each page is at least one event, and a page of repeats still moves the cursor.
  for (
    let page = 0;
    page < 2 * Math.ceil(Math.min(depth, ACTIVITY_MAX) / ACTIVITY_STEP) + 1;
    page += 1
  ) {
    if (!current()) return { kind: "superseded" };
    const result: PeopleResult<PersonActivityPage> =
      await api.readPersonActivity(personId, {
        after,
        limit: Math.min(ACTIVITY_STEP, depth - items.length),
      });
    if (!current()) return { kind: "superseded" };
    if (!result.ok) {
      // A refused cursor on a later page follows an access change: start again. Without a cursor it is not the contract's answer.
      if (after !== null && result.kind === "invalid")
        return { kind: "restart" };
      return { kind: "failed", reason: failureOf(result) };
    }
    const answer = result.value;
    if (coverage === null) {
      if (answer.person_id !== personId)
        return { kind: "merged", canonicalId: answer.person_id };
      coverage = answer.coverage_started_at;
    } else if (
      answer.person_id !== personId ||
      answer.coverage_started_at !== coverage
    )
      return { kind: "restart" };
    for (const event of answer.items) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      items.push(event);
    }
    after = answer.next_after;
    depth = depthNow();
    if (after === null || items.length >= depth) break;
  }
  return {
    kind: "ok",
    timeline: {
      personId,
      items,
      next: after,
      coverageStartedAt: coverage ?? 0,
    },
  };
}

/**
 * Reads the person's timeline for the env's identity unless the current generation already has it (or is reading it: a read is never
 * made twice), and keeps the answer in page memory. `force`: "Try again" after a failure.
 */
export function readActivity(
  env: PeopleEnv,
  personId: string,
  options: { force?: boolean } = {},
): void {
  const memory = env.memory;
  const known = memory.activity.get(personId);
  if (known !== undefined && !(options.force && known.state.kind === "failed"))
    return;
  if (!env.online) return;
  const entry: ActivityEntry = {
    generation: memory.summaryGeneration,
    state: { kind: "loading" },
  };
  memory.activity.set(personId, entry);
  const current = () => stillCurrent(memory, personId, entry);
  void (async () => {
    let state: ActivityEntry["state"] = { kind: "failed", reason: "stale" };
    for (let attempt = 0; attempt < STALE_RETRIES; attempt += 1) {
      // Asked afresh before every page: "Show older changes" may have raised it meanwhile.
      const outcome = await walkActivity(
        env.api,
        personId,
        () => depthOf(memory, personId),
        current,
      );
      if (outcome.kind === "superseded" || !current()) return;
      if (outcome.kind === "restart") continue;
      state =
        outcome.kind === "ok"
          ? {
              kind: "ready",
              timeline: outcome.timeline,
              checkedAt: env.now(),
              extending: false,
              extendFailed: false,
            }
          : outcome.kind === "merged"
            ? { kind: "merged", canonicalId: outcome.canonicalId }
            : outcome.reason === "not_found"
              ? { kind: "gone" }
              : { kind: "failed", reason: "failed" };
      break;
    }
    if (!current()) return;
    entry.state = state;
    memory.touch();
  })();
}

/** Still the read that counts: the same identity, no invalidation since, and this entry still the person's. */
function stillCurrent(
  memory: PeopleMemory,
  personId: string,
  entry: ActivityEntry,
): boolean {
  return (
    isCurrentMemory(memory) &&
    memory.summaryGeneration === entry.generation &&
    memory.activity.get(personId) === entry
  );
}

/**
 * "Show all changes" / "Show older changes": the depth rises first (an invalidation meanwhile re-reads to the new depth), then the next
 * events are read after the held timeline's cursor, within its generation. A refused cursor (`422`) reads the timeline again from its
 * first page; a `404` loses it; any other failure keeps what is held and says so.
 *
 * Pressed while a re-read is on its way (the earlier answer shown, busy; R-1), only the depth rises: that re-read reads to it.
 */
export function extendActivity(env: PeopleEnv, personId: string): void {
  const memory = env.memory;
  const entry = memory.activity.get(personId);
  if (entry === undefined || entry.state.kind === "loading") {
    const depth = depthOf(memory, personId);
    if (depth >= ACTIVITY_MAX) return;
    memory.activityDepth.set(personId, nextDepth(depth));
    memory.touch();
    return;
  }
  if (
    entry.state.kind !== "ready" ||
    entry.state.extending ||
    entry.generation !== memory.summaryGeneration
  )
    return;
  const held = entry.state;
  const depth = depthOf(memory, personId);
  // Short of the depth already asked for (its step failed: "Try again"): that step is read again, not one more.
  const short =
    held.timeline.items.length < depth && held.timeline.next !== null;
  if (!short && depth >= ACTIVITY_MAX) return;
  const target = short ? depth : nextDepth(depth);
  memory.activityDepth.set(personId, target);
  // Already held (after "Show fewer"), or nothing earlier exists: only the depth moves.
  if (held.timeline.items.length >= target || held.timeline.next === null) {
    memory.touch();
    return;
  }
  if (!env.online) {
    memory.touch();
    return;
  }
  const extending = { ...held, extending: true, extendFailed: false };
  entry.state = extending;
  memory.touch();
  const current = () =>
    stillCurrent(memory, personId, entry) && entry.state === extending;
  const after = held.timeline.next;
  void (async () => {
    const result = await env.api.readPersonActivity(personId, {
      after,
      limit: Math.min(ACTIVITY_STEP, target - held.timeline.items.length),
    });
    if (!current()) return;
    if (!result.ok) {
      if (result.kind === "invalid") {
        // The cursor is no longer one the reader may follow (an access change): read again from the first page, to the new depth.
        memory.activity.delete(personId);
        readActivity(env, personId);
        memory.touch();
        return;
      }
      entry.state =
        result.kind === "not_found"
          ? { kind: "gone" }
          : { ...held, extending: false, extendFailed: true };
      memory.touch();
      return;
    }
    const answer = result.value;
    if (
      answer.person_id !== held.timeline.personId ||
      answer.coverage_started_at !== held.timeline.coverageStartedAt
    ) {
      memory.activity.delete(personId);
      readActivity(env, personId);
      memory.touch();
      return;
    }
    const seen = new Set(held.timeline.items.map((event) => event.id));
    const items = [...held.timeline.items];
    for (const event of answer.items) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      items.push(event);
    }
    entry.state = {
      kind: "ready",
      timeline: { ...held.timeline, items, next: answer.next_after },
      checkedAt: held.checkedAt,
      extending: false,
      extendFailed: false,
    };
    memory.touch();
  })();
}

/** "Show fewer": back to the preview, with no read (the view shows the newest events of what it holds). */
export function collapseActivity(memory: PeopleMemory, personId: string): void {
  memory.activityDepth.set(personId, ACTIVITY_PREVIEW);
  memory.touch();
}
