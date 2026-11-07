/**
 * WEB-14a revision 57 (Review 57, F-R57-2; design assessment of 6 November 2026, C-H3/C-H4, I-R1/I-R2): the generation server's canned
 * reads for a SEEDED entity, built once here instead of in each spec. A spec states which entity it seeds (a person, the sharing screens'
 * households, a task's day); the builder answers every backend GET the product makes for that entity's screens, with the healthy,
 * schema-valid body a backend gives (`tests/pwa/pwa-reads.test.ts` feeds each body to the product's own strict parser).
 *
 * Why here: a person-scoped read cannot be a server default (the server does not know the seeded person), and a base merge that adds a
 * read to a seeded screen (WEB-11b's `people/requests`, WEB-19's `people/{id}/activity`) then needs ONE change, made where the entity is
 * described. The ledger oracle (`pwa-world.ts` `unansweredReads`) and the console guard still fail any read nothing answers; nothing
 * here is an allowlist. FIXTURE evidence: these are the client's view of a backend, never a released one.
 */
import { occurrenceId, progressId } from "../../src/features/tasks/model/ids";
import { slotOn, todayIn, windows } from "../../src/features/tasks/model/time";
import { buildGraph } from "../support/tasks/graphs";

export const API = "/api/experimental/v1";
/** The stub identity's account (`scripts/serve-generations.mjs`). */
export const STUB_ACCOUNT = "11111111-1111-4111-8111-111111111111";

/** A canned read set (`Generations.reads`): exact path → JSON body (query ignored; GET/HEAD only). */
export type Reads = Record<string, unknown>;

// ---- a seeded person ------------------------------------------------------------------------------------------------------------------
export interface SeededPerson {
  id: string;
  /** The person as the sync projection (and the backend's `GET /people/{id}`) have it: owned, private, no fields. */
  row: {
    id: string;
    kind: "person";
    parent_id: null;
    label: string;
    value: null;
    version: number;
    policy_version: number;
    can_edit: boolean;
    archived: boolean;
  };
  /** The person's summary, as a healthy backend answers it to its owner. */
  summary: Record<string, unknown>;
  /** Every People read of the list and of the person's page. */
  reads: Reads;
}

/**
 * The person `id` called `label`, owned by the reader (`owner`): the list's page of summaries, the person, its summary and duplicates,
 * the reader's pending requests (accepted WEB-11b) and the person's recent activity (accepted WEB-19's timeline, `limit=5` on the page:
 * no events yet, recorded since `coverage_started_at`).
 */
export function seededPerson(options: {
  id: string;
  label: string;
  owner: { account_id: string; username: string };
}): SeededPerson {
  const { id, label } = options;
  const row = {
    id,
    kind: "person" as const,
    parent_id: null,
    label,
    value: null,
    version: 1,
    policy_version: 1,
    can_edit: true,
    archived: false,
  };
  const owner = { ...options.owner, you: true, person: null };
  const summary = {
    id,
    label,
    version: 1,
    policy_version: 1,
    archived: false,
    linkage: "none",
    linked_account_id: null,
    owner,
    added_by_you: "unknown",
    your_access: "owner",
    field_count: 0,
    audience: {
      disclosure: "complete",
      in_home: false,
      households: [],
      your_direct_grant: null,
      direct_grant_count: 0,
      excluded_count: 0,
    },
  };
  return {
    id,
    row,
    summary,
    reads: {
      [`${API}/people/summaries`]: {
        items: [summary],
        next_after: null,
        home: null,
        preferences_version: 1,
      },
      [`${API}/people/${id}`]: { person: row, linked_account_id: null },
      [`${API}/people/${id}/summary`]: {
        summary,
        shared_with: {
          disclosure: "complete",
          owner,
          accounts: [],
          households: [],
          excluded_accounts: [],
        },
        home: null,
        preferences_version: 1,
      },
      [`${API}/people/${id}/duplicates`]: { items: [], next_after: null },
      // Accepted WEB-11b: the People screens read the reader's pending requests (also a server default since revision 56, C-H1; a
      // canned set is answered first, as a whole, so it is kept here).
      [`${API}/people/requests`]: { items: [] },
      // Accepted WEB-19 (Review 57, F-R57-2): the person's page reads its recent activity. None yet, recorded since the epoch second 1.
      [`${API}/people/${id}/activity`]: {
        person_id: id,
        items: [],
        next_after: null,
        coverage_started_at: 1,
      },
    },
  };
}

// ---- the sharing screens --------------------------------------------------------------------------------------------------------------
export interface SeededHousehold {
  id: string;
  name: string;
  version: number;
  role: "manager" | "member";
  members: Array<{ account_id: string; username: string; role: string }>;
}

/** A household the stub account manages alone. */
export const managedHousehold = (
  id: string,
  name: string,
): SeededHousehold => ({
  id,
  name,
  version: 1,
  role: "manager",
  members: [{ account_id: STUB_ACCOUNT, username: "me", role: "manager" }],
});

/**
 * The sharing screens' reads for an account with `households` and no invitations: the personal layer of the field defaults (no template
 * set), the memberships and the invitations. The defaults snapshot itself is a server default.
 */
export function sharingReads(
  households: readonly SeededHousehold[] = [],
): Reads {
  const empty = { template: null, version: 0 };
  return {
    [`${API}/defaults/templates`]: {
      person: empty,
      field: empty,
      task: empty,
      list: empty,
      progress: empty,
    },
    [`${API}/households`]: [...households],
    [`${API}/invitations`]: [],
  };
}

// ---- a seeded task's day (WEB-10c's task detail: the dependency editor and the turn order dialog) -------------------------------------
/** The second account of a rota (shown as "Someone (2222…)": the reader does not know its name). */
export const OTHER_ACCOUNT = "22222222-2222-4222-8222-222222222222";

export interface SeededTaskDay {
  taskId: string;
  executionId: string;
  occurrenceId: string;
  progressId: string;
  /** The task, its execution, today's occurrence and the reader's progress stream, as the sync projection has them. */
  rows: Array<Record<string, unknown>>;
}

/**
 * Today's day of the task `taskId` called `title` (UTC), as the account's cache holds it after a sync, with the ids the product derives
 * (`model/ids.ts`): one checkbox day, open today, the reader its only participant. `repeat` makes it a daily task (a rota needs one),
 * `participation: "anyone"` lets a turn order be set, and `rota` is the day's projected turn.
 */
export async function seededTaskDay(options: {
  taskId: string;
  executionId: string;
  title: string;
  participation?: "personal" | "anyone";
  daily?: boolean;
  rota?: { revision: number; ordinal: number; account_id: string };
}): Promise<SeededTaskDay> {
  const today = todayIn("UTC", Date.now());
  const definition = {
    schedule: {
      start_date: today,
      time: null,
      timezone: "UTC",
      repeat: options.daily ? { frequency: "daily", interval: 1 } : null,
    },
    goal: { kind: "checkbox" },
    carry: "close_incomplete",
    participation: options.participation ?? "personal",
    open_days_before: 0,
    close_days_after: 1,
    allow_streak_exclusions: false,
  } as const;
  const slot = slotOn(definition.schedule as never, today);
  const occurrence = await occurrenceId(options.taskId, slot.key);
  const progress = await progressId(occurrence, STUB_ACCOUNT);
  const window = windows(slot, definition);
  const row = (over: Record<string, unknown>) => ({
    parent_id: null,
    value: null,
    version: 1,
    can_edit: true,
    archived: false,
    kind_date: null,
    ...over,
  });
  const empty = { outcome: "unknown", amount: null, checked: [] };
  return {
    taskId: options.taskId,
    executionId: options.executionId,
    occurrenceId: occurrence,
    progressId: progress,
    rows: [
      row({
        id: options.taskId,
        kind: "task",
        label: options.title,
        policy_version: 1,
      }),
      row({
        id: options.executionId,
        kind: "execution",
        parent_id: options.taskId,
        label: "Task details",
        value: definition,
      }),
      row({
        id: occurrence,
        kind: "occurrence",
        parent_id: options.executionId,
        label: "Occurrence",
        value: {
          task_id: options.taskId,
          definition,
          slot,
          opens_at: window.opens_at,
          closes_at: window.closes_at,
          participants: [STUB_ACCOUNT],
          covered_by: null,
          resolved: false,
          ...(options.rota ? { rota: options.rota } : {}),
        },
      }),
      row({
        id: progress,
        kind: "progress",
        parent_id: occurrence,
        label: "Progress",
        value: {
          subject_account_id: STUB_ACCOUNT,
          recent_entries: [],
          entry_count: 0,
          excluded: false,
          action: empty,
          period: empty,
          aggregate_consent: true,
        },
      }),
    ],
  };
}

/** A healthy dependency preview's token (`model/contract.ts` `isToken`: 64 lower-case hex). */
export const PREVIEW_TOKEN = "d".repeat(64);

/**
 * The task detail's reads of `day`: what the day waits for (nothing yet, so the preview lists the day itself), its timers (none) and, for
 * a task with a turn order (`rota`), the roster at `rota.version` with `rota.participants` (the reader and OTHER may be added) and the
 * enrolment (active, consented). A roster that moves on is the same call with a newer version.
 *
 * WEB-18 maintenance merge of 2f42ac35 (7 November 2026): the dependency editor saves only on its own depth-one graph read
 * (`GET /occurrences/{id}/dependency-graph?max_depth=1`, the edit's base): the day alone, at the cached day's version (1), editable, with
 * nothing it waits for. The canned reads match the path without its query, so this answers that read.
 */
export function taskDayReads(
  day: SeededTaskDay,
  rota?: { version: number; participants: string[] },
): Reads {
  const reads: Reads = {
    [`${API}/occurrences/${day.occurrenceId}/dependencies`]: {
      token: PREVIEW_TOKEN,
      items: [
        {
          occurrence_id: day.occurrenceId,
          task_id: day.taskId,
          complete: false,
          can_complete: true,
          progress_version: null,
        },
      ],
      unavailable: false,
      strict: false,
    },
    [`${API}/occurrences/${day.occurrenceId}/timers`]: {
      items: [],
      next_after: null,
    },
    [`${API}/occurrences/${day.occurrenceId}/dependency-graph`]: buildGraph({
      root: day.occurrenceId,
      nodes: [
        {
          id: day.occurrenceId,
          task: day.taskId,
          title: "This day",
          canEdit: true,
          version: 1,
        },
      ],
      edges: [],
      maxDepth: 1,
    }),
  };
  if (rota) {
    reads[`${API}/tasks/${day.taskId}/rota`] = {
      version: rota.version,
      participants: rota.participants,
      consent_version: 3,
      accepted: false,
      eligible_participants: [STUB_ACCOUNT, OTHER_ACCOUNT],
    };
    reads[`${API}/tasks/${day.taskId}/enrolment`] = {
      version: 1,
      active: true,
      aggregate_consent: true,
      policy: { grants: [], exclude_accounts: [] },
    };
  }
  return reads;
}
