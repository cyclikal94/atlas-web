import type { PeopleFailure, PeopleResult } from "../api";
import type { PeopleEnv } from "../env";
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

/** One read, as an outcome the summaries' machinery applies (no preferences version, no rows to compare). */
function asRead<T>(
  env: PeopleEnv,
  read: () => Promise<PeopleResult<T>>,
  current: () => boolean,
  explain: boolean,
): Promise<WalkOutcome<Refusable<T>>> {
  return readOne(
    async (): Promise<
      PeopleResult<Refusable<T> & { preferences_version: number }>
    > => {
      const result = await read();
      // Admitted at the preferences version applied now: an equal one changes nothing in the summaries' rules.
      const preferences_version = env.memory.summaryPreferences;
      if (result.ok)
        return {
          ok: true,
          value: { ok: true, value: result.value, preferences_version },
        };
      if (explain && EXPLAINED.has(result.kind))
        return {
          ok: true,
          value: {
            ok: false,
            refusal: result as Extract<PeopleFailure, { requestId?: string }>,
            preferences_version,
          },
        };
      return result;
    },
    () => [],
    current,
  );
}

/** `GET /people/requests` (D-11b-3): once per mount of a screen that shows it, and again on every invalidation. */
export const INCOMING_KEY = "requests:incoming";
export function useIncoming(
  env: PeopleEnv,
): SummaryView<Refusable<IncomingRequest[]>> {
  return useSummary(INCOMING_KEY, (current) =>
    asRead(env, () => env.api.readRequests(), current, false),
  );
}

/** The sent history's page size (D-11b-4). */
export const SENT_LIMIT = 50;
/** One page of `GET /people/requests/sent` after `after` (null: the first). */
export function useSentPage(
  env: PeopleEnv,
  after: string | null,
): SummaryView<Refusable<SentPage>> {
  return useSummary(`requests:sent:${after ?? ""}`, (current) =>
    asRead(
      env,
      () => env.api.readSentRequests({ after, limit: SENT_LIMIT }),
      current,
      false,
    ),
  );
}

/** `GET /people/requests/{id}/merge-preview`: the recipient's own comparison; its refusals are explained (404, 410, 403, 422). */
export function useRecipientPreview(
  env: PeopleEnv,
  requestId: string,
): SummaryView<Refusable<RecipientPreview>> {
  return useSummary(`requests:review:${requestId}`, (current) =>
    asRead(env, () => env.api.readRecipientPreview(requestId), current, true),
  );
}

/** `POST /people/merge-preview` (a read): the sender's comparison of `source` merged into `target`. */
export function useMergePreview(
  env: PeopleEnv,
  sourceId: string,
  targetId: string,
): SummaryView<Refusable<MergePreview>> {
  return useSummary(`merge:${sourceId}:${targetId}`, (current) =>
    asRead(env, () => env.api.previewMerge(sourceId, targetId), current, true),
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
