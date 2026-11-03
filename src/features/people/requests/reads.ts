import type { PeopleFailure, PeopleResult } from "../api";
import type { PeopleEnv } from "../env";
import {
  isCurrentMemory,
  type PeopleMemory,
  type RequestReadLedger,
} from "../memory";
import type {
  IncomingRequest,
  MergePreview,
  RecipientPreview,
  SentPage,
} from "../model/requests";
import type { PersonSummaryDetail } from "../model/summary";
import {
  readOne,
  type SummaryView,
  useSummary,
  type WalkOutcome,
} from "../summaries";

/**
 * WEB-11b's online reads as the screens READ them (D-11b-3, D-11b-4): the incoming requests, the pages of the sent history and the two
 * previews. Each is an identity-bound, online-only DISPLAY read kept in the identity's page memory exactly like the viewer-safe summaries
 * (`summaries.tsx`), under the SAME invalidation generation: every people command that was sent (`online.ts`), any receipt or synced
 * change, reconnection, the 60-second refresh and the page becoming visible read them again, an answer that arrives after an invalidation
 * is dropped, and a late answer for another identity writes into a memory nobody reads. Offline, nothing is shown (never an old answer).
 *
 * They carry no `preferences_version` and no summarised rows, so the summaries' monotonicity rules have nothing to compare: an answer is
 * admitted at the generation it was asked at (`asRead`).
 *
 * A REFUSAL that the screens explain (`404`, `410`, `403`, `422`, with its reference) is kept as the read's value (`Refusable`), so its
 * own copy is shown; a read that failed otherwise (uncertain, not sent) is the view's `failed`, with Try again.
 */
export type Refusable<T> =
  | { ok: true; value: T }
  | { ok: false; refusal: Extract<PeopleFailure, { requestId?: string }> };

const EXPLAINED = new Set([
  "not_found",
  "expired",
  "forbidden",
  "invalid",
  "conflict",
]);

/**
 * A read refused `403` is REMEMBERED for the page and not asked again by itself (D-12a-13, the WEB-13a lesson; finding N1 of revision 1):
 * an ordinary `403` makes the session evaluate again, which remounts the protected tree, and a remounted People screen reads its summaries
 * again; a read that asked again by itself would therefore ask for ever (the released backend refuses a preview of two people the reader
 * owns neither of: thousands of `POST /people/merge-preview` in half a minute). Only an explicit action asks again (`askAgain`,
 * `forgetRefusal`). The remembered refusal is display suppression for this page and identity (`memory.requestRefusals`), never a
 * permission; automatic signals (an invalidation, a remount) never end it.
 *
 * WHICH ANSWER COUNTS (R7 of review 2): every dispatch of a key is numbered (`memory.requestReads`), and only the NEWEST definite answer
 * of the key may remember a refusal or end one. An answer is obsolete once a later dispatch of the key has answered, or once the person
 * asked again after it was dispatched; an obsolete answer has no effect at all, so a superseded `403` never refuses a later read. A later
 * success (or another definite answer) ends a refusal an earlier dispatch remembered. An answer that is not the server's (uncertain, not
 * sent, offline, closed) says nothing about the refusal and changes nothing here.
 *
 * Why the key's newest answer and not the summaries' generation: the `403` itself makes the session evaluate again BEFORE the answer reaches
 * this read (`ordinaryCall` runs `handleOrdinaryAnswer`, then releases and seals the response), and the remount that follows invalidates
 * every summary. A refusal that had to be of the current generation could be superseded by its own consequence, and each next read refused
 * and superseded the same way, for ever: storm protection would depend on which side of that race runs first. The VALUE SHOWN still obeys
 * the generation and the exact entry (`readSummary`): an answer superseded there is never shown.
 *
 * A read that finds a remembered refusal while a LATER dispatch of the key is still on its way waits for that answer first (it is newer):
 * a refusal that a newer answer may end is never shown meanwhile.
 */
function ledgerOf(memory: PeopleMemory, key: string): RequestReadLedger {
  let ledger = memory.requestReads.get(key);
  if (ledger === undefined) {
    ledger = { issued: 0, answered: 0, latest: null };
    memory.requestReads.set(key, ledger);
  }
  return ledger;
}

/** Whether `result` is the server's definite answer (a success or a refusal): only that says anything about a remembered refusal. */
const definite = (result: PeopleResult<unknown>): boolean =>
  result.ok ||
  (result.kind !== "uncertain" &&
    result.kind !== "not_sent" &&
    result.kind !== "offline" &&
    result.kind !== "closed");

/** The answer of the key's dispatch `dispatch`: remembered (a `403`) or ending a remembered refusal, only while it is the newest. */
function noteAnswer(
  memory: PeopleMemory,
  key: string,
  dispatch: number,
  result: PeopleResult<unknown>,
): void {
  if (!isCurrentMemory(memory) || !definite(result)) return;
  const ledger = memory.requestReads.get(key);
  // Obsolete: a later dispatch of the key answered first, or the person asked again since this one was dispatched.
  if (ledger === undefined || dispatch <= ledger.answered) return;
  ledger.answered = dispatch;
  if (!result.ok && result.kind === "forbidden")
    memory.requestRefusals.set(key, {
      refusal: { ...result, kind: "forbidden" },
      dispatch,
    });
  else memory.requestRefusals.delete(key);
}

/** One numbered dispatch of the key's read: its answer is taken into account (`noteAnswer`) before it is returned. */
async function dispatchRead<T>(
  memory: PeopleMemory,
  key: string,
  read: () => Promise<PeopleResult<T>>,
): Promise<PeopleResult<T>> {
  const ledger = ledgerOf(memory, key);
  ledger.issued += 1;
  const dispatch = ledger.issued;
  let settle = () => {};
  const latest = {
    dispatch,
    settled: new Promise<void>((resolve) => {
      settle = resolve;
    }),
    done: false,
  };
  ledger.latest = latest;
  try {
    const result = await read();
    noteAnswer(memory, key, dispatch, result);
    return result;
  } finally {
    latest.done = true;
    if (ledger.latest === latest) ledger.latest = null;
    settle();
  }
}

/**
 * The key's explicit retry (a preview's Reload, a failed list's Try again): its remembered refusal ends, and every answer of a dispatch made
 * before it is obsolete (an older callback can neither remember a refusal again nor end the one a newer read finds).
 */
function retire(memory: PeopleMemory, key: string): void {
  memory.requestRefusals.delete(key);
  const ledger = memory.requestReads.get(key);
  if (ledger !== undefined) ledger.answered = ledger.issued;
}

/** A refused preview's Reload: retires the key's refusal and earlier dispatches, then reads every summary again. */
export function askAgain(env: PeopleEnv, key: string): void {
  retire(env.memory, key);
  env.memory.invalidateSummaries();
}
/** For a failed read's own Try again (`readSummary`'s forced read): retires the key's refusal and earlier dispatches first. */
export function forgetRefusal(env: PeopleEnv, key: string): void {
  retire(env.memory, key);
}

/** One read, as an outcome the summaries' machinery applies (no preferences version, no rows to compare). */
async function asRead<T>(
  env: PeopleEnv,
  key: string,
  read: () => Promise<PeopleResult<T>>,
  current: () => boolean,
  explain: boolean,
): Promise<WalkOutcome<Refusable<T>>> {
  const memory = env.memory;
  for (;;) {
    if (!current()) return { kind: "superseded" };
    const refused = memory.requestRefusals.get(key);
    const latest = memory.requestReads.get(key)?.latest ?? null;
    if (
      refused !== undefined &&
      latest !== null &&
      !latest.done &&
      latest.dispatch > refused.dispatch
    ) {
      // A newer answer of the key is on its way: it may end this refusal.
      await latest.settled;
      continue;
    }
    const result: PeopleResult<T> =
      refused?.refusal ?? (await dispatchRead(memory, key, read));
    if (!current()) return { kind: "superseded" };
    // Admitted at the preferences version applied now: an equal one changes nothing in the summaries' rules.
    const preferencesVersion = memory.summaryPreferences;
    if (result.ok)
      return {
        kind: "ok",
        value: { ok: true, value: result.value },
        preferencesVersion,
        rows: [],
      };
    if (explain && EXPLAINED.has(result.kind))
      return {
        kind: "ok",
        value: {
          ok: false,
          refusal: result as Extract<PeopleFailure, { requestId?: string }>,
        },
        preferencesVersion,
        rows: [],
      };
    return {
      kind: "failed",
      reason: result.kind === "not_found" ? "not_found" : "failed",
    };
  }
}

/** `GET /people/requests` (D-11b-3): once per mount of a screen that shows it, and again on every invalidation. */
export const INCOMING_KEY = "requests:incoming";
export function useIncoming(
  env: PeopleEnv,
): SummaryView<Refusable<IncomingRequest[]>> {
  return useSummary(INCOMING_KEY, (current) =>
    asRead(env, INCOMING_KEY, () => env.api.readRequests(), current, false),
  );
}

/** The sent history's page size (D-11b-4). */
export const SENT_LIMIT = 50;
/** One page of `GET /people/requests/sent` after `after` (null: the first). */
export const sentKey = (after: string | null): string =>
  `requests:sent:${after ?? ""}`;
export function useSentPage(
  env: PeopleEnv,
  after: string | null,
): SummaryView<Refusable<SentPage>> {
  const key = sentKey(after);
  return useSummary(key, (current) =>
    asRead(
      env,
      key,
      () => env.api.readSentRequests({ after, limit: SENT_LIMIT }),
      current,
      false,
    ),
  );
}

/** `GET /people/requests/{id}/merge-preview`: the recipient's own comparison; its refusals are explained (404, 410, 403, 422). */
export const reviewKey = (requestId: string): string =>
  `requests:review:${requestId}`;
export function useRecipientPreview(
  env: PeopleEnv,
  requestId: string,
): SummaryView<Refusable<RecipientPreview>> {
  const key = reviewKey(requestId);
  return useSummary(key, (current) =>
    asRead(
      env,
      key,
      () => env.api.readRecipientPreview(requestId),
      current,
      true,
    ),
  );
}

/** `POST /people/merge-preview` (a read): the sender's comparison of `source` merged into `target`. */
export const previewKey = (sourceId: string, targetId: string): string =>
  `merge:${sourceId}:${targetId}`;
export function useMergePreview(
  env: PeopleEnv,
  sourceId: string,
  targetId: string,
): SummaryView<Refusable<MergePreview>> {
  const key = previewKey(sourceId, targetId);
  return useSummary(key, (current) =>
    asRead(
      env,
      key,
      () => env.api.previewMerge(sourceId, targetId),
      current,
      true,
    ),
  );
}

/** A person's viewer-safe summary (the same read and key as the detail's "Shared with" rail, so it is asked once). */
export function usePersonSummary(
  env: PeopleEnv,
  personId: string | null,
): SummaryView<PersonSummaryDetail> {
  return useSummary(
    personId === null ? null : `person:${personId}`,
    (current) =>
      readOne(
        () => env.api.readPersonSummary(personId as string),
        (detail) => [detail.summary],
        current,
      ),
  );
}

/** What a view shows NOW and when it was read (null: nothing, or a re-read after an invalidation is on its way). */
export function currentOf<T>(
  view: SummaryView<T>,
): { value: T; checkedAt: number } | null {
  return view.status === "ready"
    ? { value: view.value, checkedAt: view.checkedAt }
    : null;
}
