import { useEffect, useRef } from "react";
import {
  useAppliedRevision,
  useSharingDefaults,
  useStatusInputs,
} from "../../data";
import type { PeopleResult } from "./api";
import { type PeopleEnv, usePeopleEnv } from "./env";
import {
  isCurrentMemory,
  type PeopleMemory,
  type SummaryEntry,
  useMemoryRevision,
} from "./memory";
import type { PeopleHome, SummaryPage } from "./model/summary";

/**
 * The viewer-safe summaries as the People screens READ them (finding 8 of the review of 13 October 2026; API 0.29, backend `docs/people.md`
 * "Viewer-safe summaries"). Online-only, identity-bound DISPLAY data, never a permission and never stored:
 *
 *  - Every read is made for the displayed `(account, epoch)` (the env) and kept in that identity's PAGE memory (`memory.summaries`), per
 *    query, for the current invalidation generation only. Offline, nothing is shown: a summary is unavailable, never an old one.
 *  - An INVALIDATION (`memory.invalidateSummaries`) supersedes every earlier read: an answer that arrives after it is dropped, and a
 *    traversal that it interrupts restarts from its own first page instead of mixing pages. A late answer for another identity writes into
 *    a memory nobody reads (`isCurrentMemory`).
 *  - MONOTONIC: an answer whose `preferences_version` is lower than one already applied in this epoch is older and is not applied (read
 *    again); a higher one makes every other summary out of date (they are read again). A row is never replaced by one with a lower
 *    `version` or `policy_version`. The pages of one traversal must come from one `preferences_version`, or it restarts.
 *  - FRESHNESS (`useSummaryFreshness`, mounted once by the People layout): read again on any synced change (the applied revision), any
 *    command receipt (the queue's counts; online commands invalidate directly), reconnection, a change of the households or the primary
 *    household (the B5 record), every 60 seconds while shown online and visible, and whenever the page becomes visible again.
 */

/** How many times an answer found out of date (an older snapshot, a mixed traversal) is read again before the view says it failed. */
const STALE_RETRIES = 3;
/** The contract's "at least every 60 seconds while a summary is shown online". */
export const SUMMARY_REFRESH_MS = 60_000;

/** A summarised row's identity and versions (the monotonicity rule's input). */
export interface SummaryRow {
  id: string;
  version: number;
  policy_version: number;
}

/** What a walk found, or why it has nothing to show. */
export type WalkOutcome<T> =
  | {
      kind: "ok";
      value: T;
      preferencesVersion: number;
      /** Every summarised row the answer carries (for the monotonicity rule). */
      rows: readonly SummaryRow[];
    }
  | { kind: "failed"; reason: "failed" | "not_found" }
  /** The traversal's pages came from different snapshots: it starts again from its first page. */
  | { kind: "restart" }
  /** An invalidation or another identity took over while it ran: nothing of it is applied. */
  | { kind: "superseded" };

/** The rows a bounded walk kept, every row it read (for a join by id), where the next step begins, and the snapshot's home. */
export interface WalkedPages<Item> {
  kept: Item[];
  read: ReadonlyMap<string, Item>;
  /** Where the following step begins (null: the last page was reached). */
  next: string | null;
  end: boolean;
  home: PeopleHome | null;
}

function failureOf(result: { kind: string }): "failed" | "not_found" {
  return result.kind === "not_found" ? "not_found" : "failed";
}

/**
 * One BOUNDED traversal of a paginated summary read from `start`: pages of `pageLimit` are read one after another, each item offered to
 * `keep`, until `limit` items are kept, `pages` pages are read, `covered` says the walk has seen what it needs, or the last page is reached.
 * The server applies the scope to the whole visible set BEFORE paginating, so following `next` to the end is complete at each read; one
 * step never claims more than it read (`end`). `current` is asked before every page: once it says no, the walk stops (`superseded`).
 */
export async function walkPages<
  Item extends { id: string; version: number; policy_version: number },
>(
  readPage: (after: string | null) => Promise<PeopleResult<SummaryPage<Item>>>,
  options: {
    start: string | null;
    keep(item: Item): boolean;
    limit: number;
    pages: number;
    covered?(read: ReadonlyMap<string, Item>, last: string | null): boolean;
  },
  current: () => boolean,
): Promise<WalkOutcome<WalkedPages<Item>>> {
  const kept: Item[] = [];
  const read = new Map<string, Item>();
  let after = options.start;
  let preferences: number | null = null;
  let home: PeopleHome | null = null;
  const done = (next: string | null, end: boolean) => ({
    kind: "ok" as const,
    value: { kept, read, next, end, home },
    preferencesVersion: preferences ?? 0,
    rows: [...read.values()],
  });
  for (let page = 0; page < options.pages; page += 1) {
    if (!current()) return { kind: "superseded" };
    const result = await readPage(after);
    if (!current()) return { kind: "superseded" };
    if (!result.ok) return { kind: "failed", reason: failureOf(result) };
    const answer = result.value;
    if (preferences === null) {
      preferences = answer.preferences_version;
      home = answer.home;
    } else if (answer.preferences_version !== preferences)
      return { kind: "restart" };
    for (const item of answer.items) {
      read.set(item.id, item);
      if (!options.keep(item)) continue;
      kept.push(item);
      if (kept.length >= options.limit) return done(item.id, false);
    }
    if (answer.next_after === null) return done(null, true);
    after = answer.next_after;
    if (options.covered?.(read, answer.items.at(-1)?.id ?? null))
      return done(after, false);
  }
  return done(after, false);
}

/** One read of a single summary (a person's): the same outcome as a walk. */
export async function readOne<T extends { preferences_version: number }>(
  read: () => Promise<PeopleResult<T>>,
  rows: (value: T) => readonly SummaryRow[],
  current: () => boolean,
): Promise<WalkOutcome<T>> {
  if (!current()) return { kind: "superseded" };
  const result = await read();
  if (!current()) return { kind: "superseded" };
  if (!result.ok) return { kind: "failed", reason: failureOf(result) };
  return {
    kind: "ok",
    value: result.value,
    preferencesVersion: result.value.preferences_version,
    rows: rows(result.value),
  };
}

/**
 * Whether an answer may be applied in this epoch (the contract's monotonicity rules), and its effect when it is: the rows' floors rise,
 * and a higher `preferences_version` than any applied makes every OTHER summary out of date (they are read again; `keep` stays).
 */
export function admitSummary(
  memory: PeopleMemory,
  outcome: Extract<WalkOutcome<unknown>, { kind: "ok" }>,
  keep: { key: string; entry: SummaryEntry },
): "admitted" | "stale" {
  if (outcome.preferencesVersion < memory.summaryPreferences) return "stale";
  for (const row of outcome.rows) {
    const floor = memory.summaryFloors.get(row.id);
    if (
      floor !== undefined &&
      (row.version < floor.version || row.policy_version < floor.policyVersion)
    )
      return "stale";
  }
  for (const row of outcome.rows)
    memory.summaryFloors.set(row.id, {
      version: row.version,
      policyVersion: row.policy_version,
    });
  const before = memory.summaryPreferences;
  memory.summaryPreferences = outcome.preferencesVersion;
  if (before !== 0 && outcome.preferencesVersion > before) {
    // Every home and in-home this page holds is out of date. This answer is the newer state: it stays, under the new generation.
    memory.invalidateSummaries();
    keep.entry.generation = memory.summaryGeneration;
    memory.summaries.set(keep.key, keep.entry);
  }
  return "admitted";
}

/**
 * Reads the summary `key` for the env's identity unless the current generation already has it (or is reading it: a read is never made
 * twice), and keeps the answer in page memory. `force`: "Try again" after a failure.
 */
export function readSummary<T>(
  env: PeopleEnv,
  key: string,
  walk: (current: () => boolean) => Promise<WalkOutcome<T>>,
  options: { force?: boolean } = {},
): void {
  const memory = env.memory;
  const known = memory.summaries.get(key);
  if (known !== undefined) {
    if (known.state.kind === "loading") return;
    if (!(options.force && known.state.kind === "failed")) return;
  }
  if (!env.online) return;
  const generation = memory.summaryGeneration;
  const entry: SummaryEntry = { generation, state: { kind: "loading" } };
  memory.summaries.set(key, entry);
  // Still the read that counts: the same identity, no invalidation since, and this entry still the query's.
  const current = () =>
    isCurrentMemory(memory) &&
    memory.summaryGeneration === entry.generation &&
    memory.summaries.get(key) === entry;
  void (async () => {
    let state: typeof entry.state = { kind: "failed", reason: "stale" };
    for (let attempt = 0; attempt < STALE_RETRIES; attempt += 1) {
      const outcome = await walk(current);
      if (outcome.kind === "superseded" || !current()) return;
      if (outcome.kind === "restart") continue;
      if (outcome.kind === "failed") {
        state = { kind: "failed", reason: outcome.reason };
        break;
      }
      if (admitSummary(memory, outcome, { key, entry }) === "stale") continue;
      state = { kind: "ready", value: outcome.value, checkedAt: env.now() };
      break;
    }
    if (!current()) return;
    entry.state = state;
    memory.touch();
  })();
}

export type SummaryView<T> =
  | { status: "offline" }
  /** `previous`: the answer this view showed before the read in flight (an invalidation re-reads it), shown meanwhile with its time. */
  | { status: "loading"; previous: { value: T; checkedAt: number } | null }
  | { status: "ready"; value: T; checkedAt: number }
  | {
      status: "failed";
      reason: "failed" | "not_found" | "stale";
      retry(): void;
    };

/**
 * The summary `key` (null: nothing to read yet) for the displayed identity, read by `walk` while online. While a re-read is on its way the
 * view keeps what it showed for the same key (never across keys, never offline).
 */
export function useSummary<T>(
  key: string | null,
  walk: (current: () => boolean) => Promise<WalkOutcome<T>>,
): SummaryView<T> {
  const env = usePeopleEnv();
  useMemoryRevision(env.memory);
  const memory = env.memory;
  const generation = memory.summaryGeneration;
  const walkRef = useRef(walk);
  walkRef.current = walk;
  // biome-ignore lint/correctness/useExhaustiveDependencies: an invalidation (a new generation) asks again
  useEffect(() => {
    if (key === null || !env.online) return;
    readSummary(env, key, (current) => walkRef.current(current));
  }, [env, key, generation]);
  const shown = useRef<{ key: string; value: T; checkedAt: number } | null>(
    null,
  );
  if (key === null || !env.online) {
    shown.current = null;
    return env.online
      ? { status: "loading", previous: null }
      : { status: "offline" };
  }
  const state = memory.summaries.get(key)?.state;
  if (state?.kind === "ready") {
    const value = state.value as T;
    shown.current = { key, value, checkedAt: state.checkedAt };
    return { status: "ready", value, checkedAt: state.checkedAt };
  }
  if (state?.kind === "failed")
    return {
      status: "failed",
      reason: state.reason,
      retry: () =>
        readSummary(env, key, (current) => walkRef.current(current), {
          force: true,
        }),
    };
  const previous =
    shown.current !== null && shown.current.key === key
      ? { value: shown.current.value, checkedAt: shown.current.checkedAt }
      : null;
  return { status: "loading", previous };
}

/** What a view that may show its previous answer meanwhile shows: the answer and its time, or null. */
export function shownOf<T>(
  view: SummaryView<T>,
): { value: T; checkedAt: number } | null {
  if (view.status === "ready")
    return { value: view.value, checkedAt: view.checkedAt };
  if (view.status === "loading") return view.previous;
  return null;
}

/**
 * The FRESHNESS rules of the summaries, for the People screens while they are shown (mounted once, by the layout). Each signal
 * invalidates every summary of the identity; the reads shown then ask again.
 */
export function useSummaryFreshness(): void {
  const env = usePeopleEnv();
  const memory = env.memory;
  const revision = useAppliedRevision();
  const inputs = useStatusInputs();
  const defaults = useSharingDefaults();
  // Any synced change (the applied revision), any receipt or new draft (the queue's counts), households and the primary household (B5).
  const queue = inputs.summary;
  const record = defaults.record;
  const signature = [
    revision.status === "ready" ? String(revision.value) : revision.status,
    queue === null
      ? "-"
      : `${queue.waiting}:${queue.needsDecision}:${queue.held}:${queue.total}`,
    record === null
      ? "-"
      : `${record.snapshot.defaults.preferences_version}:${record.snapshot.defaults.primary_household_id ?? ""}:${record.snapshot.households
          .map((h) => `${h.id}@${h.version}`)
          .join(",")}`,
  ].join("|");
  const seen = useRef<{ memory: PeopleMemory; signature: string } | null>(null);
  useEffect(() => {
    const before = seen.current;
    seen.current = { memory, signature };
    if (
      before !== null &&
      before.memory === memory &&
      before.signature !== signature
    )
      memory.invalidateSummaries();
  }, [memory, signature]);
  // Reconnection: a summary is re-read once the page is online again (nothing was shown offline).
  const wasOnline = useRef<{ memory: PeopleMemory; online: boolean } | null>(
    null,
  );
  useEffect(() => {
    const before = wasOnline.current;
    wasOnline.current = { memory, online: env.online };
    if (
      before !== null &&
      before.memory === memory &&
      !before.online &&
      env.online
    )
      memory.invalidateSummaries();
  }, [memory, env.online]);
  // Every 60 seconds while shown online and visible, and whenever the page becomes visible again.
  useEffect(() => {
    if (!env.online) return;
    const visible = () => document.visibilityState === "visible";
    const timer = setInterval(() => {
      if (visible()) memory.invalidateSummaries();
    }, SUMMARY_REFRESH_MS);
    const onVisibility = () => {
      if (visible()) memory.invalidateSummaries();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [memory, env.online]);
}
