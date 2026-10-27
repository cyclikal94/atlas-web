import { RouterProvider } from "@tanstack/react-router";
import { act, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { ProtectedProviders } from "../../../src/app/providers";
import { createAppRouter } from "../../../src/app/router";
import { ShellEnvProvider } from "../../../src/app/shell/env";
import {
  type CacheRow,
  type ConditionalFormPort,
  DataEnvProvider,
  type DraftWithCommand,
  type EnqueueOutcome,
  type EnqueueRequest,
  type FormRecoveryRow,
  type HandOff,
  type JsonObject,
  type Loadable,
} from "../../../src/data";
import { digestOf } from "../../../src/data/model/canonical";
import {
  decideSupersede,
  estimateDraftBytes,
  planEdit,
  planEnqueue,
  snapshotRequest,
  validateRequestFor,
} from "../../../src/data/model/outbox";
import {
  OUTSTANDING,
  reconcileVersions,
} from "../../../src/data/model/reconcile";
import { TargetFold } from "../../../src/data/model/related";
import { initialSyncState } from "../../../src/data/model/sync-state";
import type {
  DraftRow,
  ResourceVersionRow,
  SyncStateRow,
} from "../../../src/data/model/types";
import type {
  CommandAttempt,
  PeopleApi,
  PeopleResult,
  PersonDetailAnswer,
  ProjectionPage,
  SummaryPageQuery,
} from "../../../src/features/people/api";
import {
  type PeopleEnv,
  PeopleEnvProvider,
} from "../../../src/features/people/env";
import {
  decodeHeld,
  encodeHeld,
  HEAD_TAB,
  type HeldChange,
  type HeldStore,
  heldContextOf,
  heldStoreOver,
} from "../../../src/features/people/field/held-store";
import { peopleMemory } from "../../../src/features/people/memory";
import {
  type AudienceSummary,
  type FieldAudience,
  type PeopleHome,
  type PersonSummary,
  type PersonSummaryDetail,
  parseFieldAudience,
  parsePersonSummary,
  parsePersonSummaryDetail,
  parseSummaryPage,
  type SharedWith,
  type SummaryPage,
  type SummaryScope,
} from "../../../src/features/people/model/summary";
import { SharingEnvProvider } from "../../../src/features/sharing/env";
import { SessionProvider } from "../../../src/session";
import { sessionDouble } from "../../helpers/session-double";
import { cacheRow } from "../data/rows";
import { type StubEnv, stubEnv } from "../data/ui-env";
import {
  type FakeSharingApi,
  fakeSharingApi,
  sharingEnv,
} from "../sharing/fake-api";
import { ME } from "./records";

/**
 * The people screens' component world (FIXTURE evidence: it says what the screens do with each input, never what a server answers).
 *
 *  - The data layer is the stub controller (`stubEnv`) with a store double that answers the read plans the screens use (`data.readMerged`,
 *    `data.readResourceList`, `data.readOutstandingCreates`, and review 16's reads of what is shown under a person, each from ONE state:
 *    `data.readChildPage`, `data.readMergedUnder`, `data.readFormCopiesUnder` and the drafts' witness) from `cache` and `drafts`, live.
 *  - The outbox is a double whose writes are DECIDED by the real pure plans (review 11, R11.1): the request is snapshotted and checked at
 *    its boundary (`snapshotRequest`, `validateRequestFor`), then `planEnqueue`, `planEdit` and `decideSupersede` decide over what the real
 *    transaction would read (the targets' cached rows, the version records `versions`, the other drafts by `TargetFold`, `draft_seq`; the
 *    draft an enqueue names as its reviewed predecessor, by its key; for an edit with the newest-save rule, the latest unsettled other
 *    draft of each target and the stored body: review 12), and
 *    the world applies what they return as ONE state change before telling its readers: the whole header with its body, whose
 *    `command_digest` is the digest of the stored body; an edit rebuilds from the draft's OWN bases and moves no version record; a
 *    supersession deletes the old draft (from the conflict inbox too), rewrites its dependants and recomputes the records. A refusal writes
 *    nothing; a build that cannot run or is not JSON throws a `TypeError`, as the real facades do. `built` logs each committed write. What
 *    the facade adds around the plans is NOT modelled here: the quota reservation and its re-admission, the store's transaction and its
 *    aborts, closure and the identity fence, pending effects and `observed` tokens. `outcomes` scripts a facade refusal instead.
 *  - Held audience changes are form copies (`copies`), written by a double of the held store and read by `data.readFormCopies`.
 *  - The people and sharing APIs are scriptable doubles that record every call.
 */
export interface Built {
  request: EnqueueRequest;
  command: Record<string, unknown>;
  displayPatch?: unknown;
  defaultsReview?: readonly string[];
  localId: string;
  op: "enqueue" | "edit" | "supersede";
  target?: string;
}

export type PeopleAnswer<T> =
  | PeopleResult<T>
  | (() => Promise<PeopleResult<T>>);

export interface FakePeopleApi extends PeopleApi {
  calls: Array<{ op: string; args: unknown[] }>;
  next: {
    person: PeopleAnswer<PersonDetailAnswer>[];
    duplicates: PeopleAnswer<ProjectionPage>[];
    people: PeopleAnswer<{ revision: number; person_id: string }>[];
    shared: PeopleAnswer<{ revision: number }>[];
    summaries: PeopleAnswer<SummaryPage<PersonSummary>>[];
    personSummary: PeopleAnswer<PersonSummaryDetail>[];
    fieldAudiences: PeopleAnswer<SummaryPage<FieldAudience>>[];
  };
  /** Linked accounts by person id (the default answer of `readPerson`); a person absent from the cache is `not_found`. */
  linked: Map<string, string | null>;
  /**
   * The viewer-safe summaries the fake server derives from the cache (an owner's private person or field by default), with these
   * overrides by id. Every answer is checked by the real strict parser: a fixture the contract would not send fails the test.
   */
  summary: {
    persons: Map<string, Partial<PersonSummary>>;
    rails: Map<string, SharedWith>;
    fields: Map<string, Partial<FieldAudience>>;
    home: PeopleHome | null;
    preferencesVersion: number;
  };
  /** The people the fake server answers for (default: every cached person); for a server ahead of or behind the cache. */
  summaryOf(id: string): PersonSummary | null;
}

export const OWNER_ONLY: AudienceSummary = {
  disclosure: "complete",
  in_home: false,
  households: [],
  your_direct_grant: null,
  direct_grant_count: 0,
  excluded_count: 0,
};

export function fakePeopleApi(
  cache: () => Map<string, CacheRow>,
): FakePeopleApi {
  let revision = 10;
  const take = async <T,>(
    queue: PeopleAnswer<T>[],
    fallback: () => PeopleResult<T>,
  ): Promise<PeopleResult<T>> => {
    const next = queue.shift();
    if (next === undefined) return fallback();
    return typeof next === "function" ? next() : next;
  };
  const personSummary = (row: CacheRow): PersonSummary => {
    const linked = api.linked.get(row.id) ?? null;
    const base: PersonSummary = {
      id: row.id,
      label: row.label,
      version: row.version,
      policy_version: row.policy_version ?? 1,
      archived: row.archived,
      linkage: linked === null ? "none" : linked === ME ? "you" : "other",
      linked_account_id: linked,
      owner: { account_id: ME, username: "me", you: true, person: null },
      added_by_you: "unknown",
      your_access: "owner",
      field_count: [...cache().values()].filter(
        (f) => f.kind === "field" && f.parent_id === row.id && !f.archived,
      ).length,
      audience: OWNER_ONLY,
    };
    return { ...base, ...(api.summary.persons.get(row.id) ?? {}) };
  };
  const inScope = (scope: SummaryScope, s: PersonSummary) =>
    scope === "all" ||
    (scope === "in_home" && api.summary.home !== null && s.audience.in_home) ||
    (scope === "shared_with_me" && !s.owner.you && s.added_by_you !== "yes") ||
    (scope === "not_linked" && s.linkage === "none");
  const pageOf = <Item extends { id: string; archived: boolean }>(
    all: Item[],
    query: SummaryPageQuery,
    parse: (value: unknown) => Item | null,
  ): SummaryPage<Item> => {
    const rest = all
      .filter((item) => item.archived === query.archived)
      .filter((item) => query.after === null || item.id > query.after)
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    const items = rest.slice(0, query.limit);
    const page = {
      items,
      next_after:
        items.length === query.limit ? (items.at(-1)?.id ?? null) : null,
      home: api.summary.home,
      preferences_version: api.summary.preferencesVersion,
    };
    const checked = parseSummaryPage(
      JSON.parse(JSON.stringify(page)),
      query,
      parse,
    );
    if (checked === null)
      throw new Error("the fake summary page breaks the contract");
    return checked;
  };
  const api: FakePeopleApi = {
    calls: [],
    linked: new Map(),
    next: {
      person: [],
      duplicates: [],
      people: [],
      shared: [],
      summaries: [],
      personSummary: [],
      fieldAudiences: [],
    },
    summary: {
      persons: new Map(),
      rails: new Map(),
      fields: new Map(),
      home: null,
      preferencesVersion: 1,
    },
    summaryOf(id) {
      const row = cache().get(id);
      return row === undefined || row.kind !== "person"
        ? null
        : personSummary(row);
    },
    async readSummaries(scope, page) {
      api.calls.push({ op: "readSummaries", args: [scope, page] });
      return take(api.next.summaries, () => ({
        ok: true,
        value: pageOf(
          [...cache().values()]
            .filter((row) => row.kind === "person")
            .map(personSummary)
            .filter((s) => inScope(scope, s)),
          page,
          parsePersonSummary,
        ),
      }));
    },
    async readPersonSummary(id) {
      api.calls.push({ op: "readPersonSummary", args: [id] });
      return take(api.next.personSummary, () => {
        const summary = api.summaryOf(id);
        if (summary === null) return { ok: false, kind: "not_found" };
        const rail: SharedWith = api.summary.rails.get(id) ?? {
          disclosure: summary.audience.disclosure,
          owner: summary.owner,
          accounts: [],
          households: [],
          excluded_accounts: summary.owner.you ? [] : null,
        };
        const detail = parsePersonSummaryDetail(
          JSON.parse(
            JSON.stringify({
              summary,
              shared_with: rail,
              home: api.summary.home,
              preferences_version: api.summary.preferencesVersion,
            }),
          ),
        );
        if (detail === null)
          throw new Error("the fake person summary breaks the contract");
        return { ok: true, value: detail };
      });
    },
    async readFieldAudiences(id, page) {
      api.calls.push({ op: "readFieldAudiences", args: [id, page] });
      return take(api.next.fieldAudiences, () => {
        if (api.summaryOf(id) === null) return { ok: false, kind: "not_found" };
        const fields = [...cache().values()]
          .filter((row) => row.kind === "field" && row.parent_id === id)
          .map(
            (row): FieldAudience => ({
              id: row.id,
              version: row.version,
              policy_version: row.policy_version ?? 1,
              archived: row.archived,
              owner_is_you: true,
              your_access: "owner",
              audience: OWNER_ONLY,
              effective: {
                disclosure: "complete",
                account_count: 0,
                limited_count: 0,
              },
              ...(api.summary.fields.get(row.id) ?? {}),
            }),
          );
        return { ok: true, value: pageOf(fields, page, parseFieldAudience) };
      });
    },
    async readPerson(id) {
      api.calls.push({ op: "readPerson", args: [id] });
      return take(api.next.person, () => {
        const row = cache().get(id);
        if (row === undefined) return { ok: false, kind: "not_found" };
        const { kind_date: _k, ...person } = row;
        return {
          ok: true,
          value: { person, linked_account_id: api.linked.get(id) ?? null },
        };
      });
    },
    async readDuplicates(id, page) {
      api.calls.push({ op: "readDuplicates", args: [id, page] });
      return take(api.next.duplicates, () => ({
        ok: true,
        value: { items: [], next_after: null },
      }));
    },
    async peopleCommand(attempt: CommandAttempt) {
      api.calls.push({
        op: "peopleCommand",
        args: [attempt.key, JSON.parse(attempt.body)],
      });
      revision += 1;
      return take(api.next.people, () => ({
        ok: true,
        value: {
          revision,
          person_id: JSON.parse(attempt.body).command.person_id,
        },
      }));
    },
    async putFieldShared(attempt: CommandAttempt) {
      api.calls.push({
        op: "putFieldShared",
        args: [attempt.key, JSON.parse(attempt.body)],
      });
      revision += 1;
      return take(api.next.shared, () => ({ ok: true, value: { revision } }));
    },
  };
  return api;
}

type Listener = () => void;

export interface PeopleWorld {
  env: StubEnv;
  api: FakePeopleApi;
  sharing: FakeSharingApi;
  people: PeopleEnv;
  cache: Map<string, CacheRow>;
  drafts: DraftWithCommand[];
  built: Built[];
  /** What the outbox answers next (default: queued). */
  outcomes: Array<EnqueueOutcome | { kind: "refused"; reason: string }>;
  setCache(rows: CacheRow[]): void;
  putCache(row: CacheRow): void;
  setDrafts(drafts: DraftWithCommand[]): void;
  /** The body of a draft the conflict inbox lists (the inbox lists headers; `data.readDraftWithCommand` answers with this). */
  putBody(localId: string, command: JsonObject): void;
  /** The outbox's version record (`resource_versions`), by resource id. */
  versions: Map<string, number>;
  /** The form copies of the account's database, by `[form_context, tab]`. */
  copies: Map<string, FormRecoveryRow>;
  /** The held changes the form copies carry now (live, non-terminal). */
  held(): HeldChange[];
  /** Puts a held change as a form copy (as a page that held it earlier did). */
  putHeld(change: HeldChange): void;
  /** What the held store's next conditional writes answer instead of writing (default: they write, compare-and-set). */
  heldSaves: Array<"saved" | "failed" | "refused">;
  /** What the held store's next ends answer instead of ending (default: they end, compare-and-set). */
  heldEnds: Array<"failed" | "refused">;
  /** Locks another page of the browser holds (`exclusive` answers null for them). */
  heldElsewhere: Set<string>;
  /** Another page lets go of a lock it held: whoever waits for it looks again. */
  releaseElsewhere(name: string): void;
  setOnline(online: boolean): void;
  /** The outbox is null (no database bound yet). */
  noDatabase(): void;
  /** Every list read fails (the store's `error`). */
  failReads(): void;
  /**
   * Reads of `plan` whose input `match` accepts fail (the store's `error`) until `restoreReads` (review 4, finding 5: an archive inventory
   * read that fails, for one kind, one parent or the outstanding drafts).
   */
  failRead(
    plan: string,
    match?: (input: Record<string, unknown>) => boolean,
  ): void;
  /**
   * The faults end. `notify: false` (review 9's design assessment, DA9-05) repairs the store WITHOUT any notification: an existing watch
   * that failed stays failed (a live query ends at its first error), so only a NEW watch can show the repair, as the editor's "Try again"
   * must make one.
   */
  restoreReads(options?: { notify?: boolean }): void;
  /** Every watch made, in order (its plan and input): a test counts the NEW watches a "Try again" made. */
  readonly watches: ReadonlyArray<{
    plan: string;
    input: Record<string, unknown>;
  }>;
  /**
   * A controlled read boundary (review 5, finding 2): every NEW watch of `plan` whose input `match` accepts starts `loading` and stays so
   * (one stable snapshot) until `releaseReads`, as a live query's first answer does; watches made earlier answer as before. `gated` lists
   * the inputs of the watches it held and that were read, so a test knows the new read exists before it looks.
   */
  holdReads(
    plan: string,
    match?: (input: Record<string, unknown>) => boolean,
  ): void;
  /** The held watches answer (and the next new ones are not held). */
  releaseReads(): void;
  /**
   * The EXISTING watches of `plan` keep answering what they last answered, until `thawReads` (DA7-12): a commit that plan's live query has
   * not delivered yet, while every other read (and every new watch) sees it. With `match`, only the watches whose input it accepts (review
   * 15, R15.1: the people list's own read of the people, but not each row's read of its fields). `match` is also given the watch's
   * number (its index in `watches`): two watches of the same plan and input are two live queries, and one may lag the other (review 16,
   * R16.1: the detail's read of the drafts and the editor's).
   */
  freezeReads(
    plan: string,
    match?: (input: Record<string, unknown>, watch: number) => boolean,
  ): void;
  thawReads(): void;
  /** ONE commit: `rows` are cached and the outstanding drafts become `drafts` (a receipt published, as `commitPage` does). */
  handOff(rows: CacheRow[], drafts: DraftWithCommand[]): void;
  readonly gated: Record<string, unknown>[];
  /** The sync engine applied a page of changes (`sync_state.applied_revision` moves): the summaries' invalidation signal. */
  advanceRevision(): void;
  mount(path: string): Promise<{ router: ReturnType<typeof createAppRouter> }>;
}

/** The instant every write of the world is made at. */
const NOW = "2026-10-12T09:00:00.000Z";

export function peopleWorld(
  options: { online?: boolean; identity?: string } = {},
): PeopleWorld {
  const env = stubEnv();
  const cache = new Map<string, CacheRow>();
  let drafts: DraftWithCommand[] = [];
  const versions = new Map<string, number>();
  const bodies = new Map<string, JsonObject>();
  const copies = new Map<string, FormRecoveryRow>();
  const heldSaves: Array<"saved" | "failed" | "refused"> = [];
  const heldEnds: Array<"failed" | "refused"> = [];
  const heldElsewhere = new Set<string>();
  const held = new Set<string>();
  const listeners = new Set<Listener>();
  let version = 0;
  let failing = false;
  let appliedRevision = 1;
  let seq = 100;
  const notify = () => {
    version += 1;
    for (const listener of [...listeners]) listener();
  };
  const memo = new Map<string, { version: number; value: Loadable<unknown> }>();
  const FAILED: Loadable<unknown> = { status: "unavailable", reason: "error" };
  const LOADING: Loadable<unknown> = { status: "loading" };
  const holds: Array<{
    plan: string;
    match: (input: Record<string, unknown>) => boolean;
  }> = [];
  let holding = 0;
  const gated: Record<string, unknown>[] = [];
  const watches: Array<{ plan: string; input: Record<string, unknown> }> = [];
  /** Plans whose EXISTING watches answer what they last answered (`freezeReads`): a commit their live query has not delivered yet. */
  const frozen: Array<{
    plan: string;
    match: (input: Record<string, unknown>, watch: number) => boolean;
  }> = [];
  const faults: Array<{
    plan: string;
    match: (input: Record<string, unknown>) => boolean;
  }> = [];
  const answer = (key: string, compute: () => Loadable<unknown>) => {
    const known = memo.get(key);
    if (known !== undefined && known.version === version) return known.value;
    const value = compute();
    memo.set(key, { version, value });
    return value;
  };
  const sorted = () =>
    [...cache.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  const plans: Record<
    string,
    (input: Record<string, unknown>) => Loadable<unknown>
  > = {
    "data.readMerged": (input) => {
      const row = cache.get(input.id as string) ?? null;
      return {
        status: "ready",
        value: {
          base: row,
          effects: [],
          creates: [],
          createsTotal: 0,
          createsNext: null,
          merged: row,
        },
      };
    },
    "data.readResourceList": (input) => {
      if (failing) return { status: "unavailable", reason: "error" };
      const all = sorted().filter(
        (row) =>
          row.kind === input.kind &&
          (input.parentId === undefined || row.parent_id === input.parentId),
      );
      const after = (input.after as string | undefined) ?? null;
      const rest = after === null ? all : all.filter((row) => row.id > after);
      const page = rest.slice(0, 100);
      return {
        status: "ready",
        value: {
          rows: page.map((row) => ({ base: row, merged: row, pending: 0 })),
          next: rest.length > 100 ? (page.at(-1)?.id ?? null) : null,
        },
      };
    },
    // The parent and its children from ONE state of the world, as the production plan reads them in one transaction (review 15, R15.1):
    // no row `parentId` of kind `parentKind` in the cache answers null, whatever children are still cached.
    "data.readVisibleChildren": (input) => {
      if (failing) return { status: "unavailable", reason: "error" };
      const parent = cache.get(input.parentId as string);
      if (parent === undefined || parent.kind !== input.parentKind)
        return { status: "ready", value: null };
      return plans["data.readResourceList"]?.({
        kind: input.kind,
        parentId: input.parentId,
      }) as Loadable<unknown>;
    },
    // WEB-11a review 16 (R16.1): a page of children with their parents and the drafts over them, from ONE state of the world, as the
    // production plan reads them in one transaction. A row whose parent the cache does not hold as `parentKind` is not answered; `next` is
    // the cursor of the page read; more than 1,000 OUTSTANDING drafts naming the kept rows answer `drafts: null` (the production bound,
    // review 17 R17.1: each draft counted once, retained conflicts and rejections never). The world keeps no `pending_effects`, so an
    // acknowledged draft counts as outstanding here; the production plan's acknowledgement rule is tested over the production plan.
    "data.readChildPage": (input) => {
      if (failing) return { status: "unavailable", reason: "error" };
      const read = plans["data.readResourceList"]?.({
        kind: input.kind,
        ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
        after: input.after ?? null,
      }) as Loadable<{
        rows: Array<{ base: CacheRow; merged: CacheRow; pending: number }>;
        next: string | null;
      }>;
      if (read.status !== "ready") return read;
      const parents: Record<string, CacheRow> = {};
      const ids = new Set<string>(
        input.parentId === undefined ? [] : [input.parentId as string],
      );
      for (const row of read.value.rows)
        if (row.base.parent_id !== null) ids.add(row.base.parent_id);
      for (const id of ids) {
        const row = cache.get(id);
        if (row !== undefined && row.kind === input.parentKind)
          parents[id] = row;
      }
      const rows = read.value.rows.filter(
        (row) => (row.base.parent_id ?? "") in parents,
      );
      const kinds = input.kinds as readonly string[] | undefined;
      let drafted: DraftWithCommand[] | null | undefined;
      if (kinds !== undefined) {
        const kept = new Set(rows.map((row) => row.base.id));
        const outstanding = drafts
          .filter(
            (d) =>
              kinds.includes(d.kind) &&
              ["queued", "in_flight", "blocked", "acknowledged"].includes(
                d.status,
              ) &&
              d.index_targets.some((t) => kept.has(t)),
          )
          .sort((a, b) => a.created_seq - b.created_seq);
        drafted = outstanding.length > 1000 ? null : outstanding;
      }
      return {
        status: "ready",
        value: {
          page: { rows, next: read.value.next },
          parents,
          ...(drafted === undefined ? {} : { drafts: drafted }),
        },
      };
    },
    // A resource and its parent (`parentId`, else the one the cached resource names) from ONE state, each as `data.readMerged` answers.
    "data.readMergedUnder": (input) => {
      const merged = plans["data.readMerged"] as (
        input: Record<string, unknown>,
      ) => Loadable<unknown>;
      const own = merged({ id: input.id });
      const parentId =
        (input.parentId as string | undefined) ??
        cache.get(input.id as string)?.parent_id ??
        null;
      const parent = parentId === null ? null : merged({ id: parentId });
      if (own.status !== "ready") return own;
      if (parent !== null && parent.status !== "ready") return parent;
      return {
        status: "ready",
        value: {
          resource: own.value,
          parent: parent === null ? null : parent.value,
        },
      };
    },
    "data.readFormCopiesUnder": (input) => {
      const witness = input.witness as { id: string; kind: string };
      return {
        status: "ready",
        value: {
          page: copiesPage(
            input.prefix as string,
            (input.after as readonly [string, string] | null | undefined) ??
              null,
          ),
          witnessed: cache.get(witness.id)?.kind === witness.kind,
        },
      };
    },
    "data.readAppliedRevision": () => ({
      status: "ready",
      value: appliedRevision,
    }),
    "data.readFormCopies": (input) => {
      const value = copiesPage(
        input.prefix as string,
        (input.after as readonly [string, string] | null | undefined) ?? null,
      );
      return { status: "ready", value };
    },
    "data.readDraftWithCommand": (input) => {
      const id = input.localId as string;
      const draft = drafts.find((d) => d.local_id === id);
      if (draft !== undefined) return { status: "ready", value: draft };
      const body = bodies.get(id);
      const page = env.conflicts.get();
      const listed =
        page.status === "ready"
          ? page.value.rows.find((row) => row.draft.local_id === id)?.draft
          : undefined;
      return {
        status: "ready",
        value:
          body === undefined || listed === undefined
            ? null
            : { ...listed, command: body },
      };
    },
    // One transaction over the cache and the outstanding drafts (review 7's design assessment, DA7-12): the same pages and windows as the
    // two separate reads, computed from ONE state of the world.
    "data.readInventory": (input) => {
      const resource =
        input.id === undefined ? null : (cache.get(input.id as string) ?? null);
      const pages: Array<{ after: string | null; page: unknown }> = [];
      if (input.id === undefined && input.kind !== undefined) {
        let after = (input.after as string | null | undefined) ?? null;
        for (
          let n = 0;
          n < Math.min((input.pages as number) ?? 20, 20);
          n += 1
        ) {
          const read = plans["data.readResourceList"]?.({
            kind: input.kind,
            ...(input.parentId === undefined
              ? {}
              : { parentId: input.parentId }),
            after,
          }) as Loadable<{ next: string | null }>;
          if (read.status !== "ready") return read;
          pages.push({ after, page: read.value });
          if (read.value.next === null) break;
          after = read.value.next;
        }
      }
      const outstanding: Array<{ after: number | null; page: unknown }> = [];
      let after: number | null = null;
      for (let n = 0; n < 10; n += 1) {
        const read = plans["data.readOutstandingCreates"]?.({
          kinds: input.kinds,
          after,
        }) as Loadable<{ next: number | null }>;
        if (read.status !== "ready") return read;
        outstanding.push({ after, page: read.value });
        if (read.value.next === null) break;
        after = read.value.next;
      }
      return { status: "ready", value: { resource, pages, outstanding } };
    },
    "data.readOutstandingCreates": (input) => {
      const kinds = input.kinds as string[];
      const after = (input.after as number | undefined) ?? 0;
      const live = drafts
        .filter(
          (d) =>
            kinds.includes(d.kind) &&
            ["queued", "in_flight", "blocked", "acknowledged"].includes(
              d.status,
            ) &&
            d.created_seq > after,
        )
        .sort((a, b) => a.created_seq - b.created_seq);
      const window = live.slice(0, 100);
      // With a witness, whether the cache holds it as that kind in the SAME state (R16.1).
      const witness = input.witness as { id: string; kind: string } | undefined;
      return {
        status: "ready",
        value: {
          drafts: window,
          next: live.length > 100 ? (window.at(-1)?.created_seq ?? null) : null,
          ...(witness === undefined
            ? {}
            : { witnessed: cache.get(witness.id)?.kind === witness.kind }),
        },
      };
    },
  };
  const service = {
    live: true,
    incarnationId: "stub",
    store: {
      watch: (plan: { name: string }, input: Record<string, unknown>) => {
        const key = `${plan.name}:${JSON.stringify(input)}`;
        const compute = plans[plan.name];
        const number = watches.length;
        watches.push({ plan: plan.name, input });
        // A watch that answered a `failRead` fault stays failed (a live query ENDS at its first error): only a new watch reads again.
        let ended = false;
        // A watch made while a `holdReads` gate matches it answers only once that gate is released.
        const gate = holds.some(
          (hold) => hold.plan === plan.name && hold.match(input),
        )
          ? holding
          : null;
        let seen = false;
        let last: Loadable<unknown> | undefined;
        return {
          get: () => {
            if (compute === undefined)
              return { status: "loading" } as Loadable<unknown>;
            if (
              last !== undefined &&
              frozen.some(
                (freeze) =>
                  freeze.plan === plan.name && freeze.match(input, number),
              )
            )
              return last;
            if (gate !== null && gate === holding) {
              if (!seen) gated.push(input);
              seen = true;
              return LOADING;
            }
            if (
              ended ||
              faults.some(
                (fault) => fault.plan === plan.name && fault.match(input),
              )
            ) {
              ended = true;
              return FAILED;
            }
            last = answer(key, () => compute(input));
            return last;
          },
          subscribe: (listener: Listener) => {
            listeners.add(listener);
            return () => {
              listeners.delete(listener);
            };
          },
        };
      },
    },
  };
  (env.serviceStore as unknown as { set(v: unknown): void }).set(service);

  const built: Built[] = [];
  const outcomes: PeopleWorld["outcomes"] = [];
  // The outbox's durable state as the real plans read it (review 11, R11.1): the version records with their basis, and `draft_seq`.
  const basis = new Map<string, ResourceVersionRow["basis"]>();
  let draftSeq = seq;
  const versionRows = (ids: readonly string[]) => {
    const rows = new Map<string, ResourceVersionRow>();
    for (const id of ids) {
      const tracked = versions.get(id);
      if (tracked !== undefined)
        rows.set(id, {
          resource_id: id,
          locally_assumed_version: tracked,
          basis: basis.get(id) ?? "resource",
        });
    }
    return rows;
  };
  const cachedRows = (ids: readonly string[]) => {
    const rows = new Map<string, CacheRow>();
    for (const id of ids) {
      const row = cache.get(id);
      if (row !== undefined) rows.set(id, row);
    }
    return rows;
  };
  const putVersions = (
    puts: readonly ResourceVersionRow[],
    deletes: readonly string[] = [],
  ) => {
    for (const id of deletes) {
      versions.delete(id);
      basis.delete(id);
    }
    for (const row of puts) {
      versions.set(row.resource_id, row.locally_assumed_version);
      basis.set(row.resource_id, row.basis);
    }
  };
  const syncRow = (): SyncStateRow => {
    // `draft_seq` never falls below a draft a test seeded: a new draft is the newest, as the real counter makes it.
    for (const d of drafts) draftSeq = Math.max(draftSeq, d.created_seq);
    return { ...initialSyncState(service.incarnationId), draft_seq: draftSeq };
  };
  const headers = () =>
    drafts.map(({ command: _command, ...header }) => header);
  /** `readTouched`'s other drafts: the ones that stand in, per id, for every non-terminal draft that targets it, `exclude` aside. */
  const relatedTo = (ids: readonly string[], exclude: ReadonlySet<string>) => {
    const others = new Map<string, DraftRow>();
    for (const id of new Set(ids)) {
      const fold = new TargetFold(id);
      for (const row of headers())
        if (row.index_targets.includes(id) && !exclude.has(row.local_id))
          fold.add(row);
      for (const row of fold.rows()) others.set(row.local_id, row);
    }
    return [...others.values()];
  };
  /** The real facades' answer to a plan that could not build or measure the command: a `TypeError`, never a success. */
  const unbuildable = (reason: string) =>
    new TypeError(`the save could not be built or measured as JSON: ${reason}`);
  /**
   * The version records after a delivered page names `rows` (`commitPage`'s `reconcileVersions`, over the drafts as that commit leaves
   * them): a delivered version at or above the record ends it when no outstanding draft targets the row; a higher one otherwise raises
   * the record (queued drafts keep their bases and meet a genuine 409).
   */
  const publish = (rows: readonly CacheRow[]) => {
    const outstanding = new Set<string>();
    for (const d of drafts)
      if (OUTSTANDING.has(d.status))
        for (const id of d.index_targets) outstanding.add(id);
    const named = rows.map((row) => row.id);
    const { versionPuts, versionDeletes } = reconcileVersions({
      versions: [...versionRows(named).values()],
      mentions: new Map(
        rows.map((row) => [row.id, { removed: false, version: row.version }]),
      ),
      outstanding,
    });
    putVersions(versionPuts, versionDeletes);
  };
  const nextLocalId = () => {
    seq += 1;
    return `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
  };
  /**
   * A committed write, as the log of what was built: the command is the one STORED (the plan's snapshot, built on the bases the plan used),
   * and the display patch and review are what the request's build returned on those same bases.
   */
  const record = (
    op: Built["op"],
    request: EnqueueRequest,
    stored: Pick<DraftRow, "local_id" | "bases">,
    command: JsonObject,
    target?: string,
  ) => {
    const result = request.build({ ...stored.bases });
    built.push({
      request,
      command: command as Record<string, unknown>,
      ...(result.displayPatch === undefined
        ? {}
        : { displayPatch: result.displayPatch }),
      ...(result.defaultsReview === undefined
        ? {}
        : { defaultsReview: result.defaultsReview }),
      localId: stored.local_id,
      op,
      ...(target === undefined ? {} : { target }),
    });
  };
  let outboxAvailable = true;
  const outbox = {
    enqueue: async (given: EnqueueRequest, handOff?: HandOff) => {
      // The facade's boundary: a private copy of the request, checked before anything is awaited (an invalid one throws).
      const request = snapshotRequest(given);
      validateRequestFor(request, "enqueue");
      const scripted = outcomes.shift();
      if (scripted !== undefined && scripted.kind === "refused")
        return scripted;
      // The real facade sizes the write first, building from placeholder bases (no bases, the widest version) before the transaction.
      estimateDraftBytes(request);
      const localId = request.localId ?? nextLocalId();
      // A hand-off (`transferDraft`): its copies must be as read and no draft may have the id; then the draft and the copy's end are one step.
      if (handOff !== undefined) {
        const wanted = [
          { ...handOff.source, terminal: false },
          ...handOff.also,
        ];
        const holds = wanted.every((want) => {
          const row = copies.get(copyKey(want.formContext, want.tabInstanceId));
          return (
            row !== undefined &&
            row.terminal === want.terminal &&
            row.content_digest === want.digest
          );
        });
        if (!holds || drafts.some((d) => d.local_id === localId))
          return {
            kind: "refused",
            reason: "source_changed",
          } as EnqueueOutcome;
      }
      // The enqueue plan (`planEnqueue`) over what the transaction reads: the targets' cached rows and version records, the drafts that
      // stand in for every other draft against them, and the draft already under this id (the same save again: nothing is added).
      const ids = request.targets.map((target) => target.resourceId);
      const planned = planEnqueue(request, {
        sync: syncRow(),
        cache: cachedRows(ids),
        versions: versionRows(ids),
        related: relatedTo(ids, new Set([localId])),
        existing: headers().find((d) => d.local_id === localId),
        // The reviewed predecessor by its key, as `enqueueDraft` reads it (review 12, R12.1).
        predecessor:
          request.expectPredecessor === undefined
            ? undefined
            : headers().find(
                (d) => d.local_id === request.expectPredecessor?.localId,
              ),
        localId,
        accountId: ME,
        now: NOW,
      });
      if (planned.kind === "refused")
        return { kind: "refused", reason: planned.reason } as EnqueueOutcome;
      if (planned.kind === "invalid") throw unbuildable(planned.reason);
      if (planned.kind === "duplicate")
        return {
          kind: "queued",
          localId,
          createdSeq: planned.draft.created_seq,
        } as EnqueueOutcome;
      // ONE state change: the header and its body, the version records and the counter (then the readers are told).
      putVersions(planned.versionPuts);
      draftSeq = planned.sync.draft_seq;
      record("enqueue", given, planned.draft, planned.command);
      if (handOff !== undefined) {
        const key = copyKey(
          handOff.source.formContext,
          handOff.source.tabInstanceId,
        );
        copies.set(key, {
          ...(copies.get(key) as FormRecoveryRow),
          fields: { ...handOff.tombstone },
          terminal: true,
          content_digest: digestOf(handOff.tombstone),
        });
      }
      drafts = [...drafts, { ...planned.draft, command: planned.command }];
      notify();
      return {
        kind: "queued",
        localId,
        createdSeq: planned.draft.created_seq,
      } as EnqueueOutcome;
    },
    editQueued: async (localId: string, given: EnqueueRequest) => {
      const request = snapshotRequest(given);
      validateRequestFor(request, "edit");
      const scripted = outcomes.shift();
      if (scripted !== undefined && scripted.kind === "refused")
        return scripted;
      estimateDraftBytes(request);
      // The edit plan (`planEdit`) over the draft as it is stored NOW: it rebuilds from the draft's OWN bases, refuses a draft that is gone,
      // sent, retargeted or no longer the one the request reviewed, and returns the whole header with the new body's digest.
      const stored = headers().find((d) => d.local_id === localId);
      // The newest-save rule's facts, as `editQueuedDraft` reads them (review 12): the latest unsettled other draft of each primary target
      // (`TargetFold.latest`) and the stored body.
      const later: DraftRow[] = [];
      if (stored !== undefined && request.expectLatest === true)
        for (const id of stored.target_resource_ids) {
          const fold = new TargetFold(id);
          for (const row of headers())
            if (row.index_targets.includes(id) && row.local_id !== localId)
              fold.add(row);
          if (fold.latest !== undefined) later.push(fold.latest);
        }
      const planned = planEdit(
        request,
        stored,
        syncRow(),
        undefined,
        undefined,
        stored === undefined || request.expectLatest !== true
          ? undefined
          : {
              later,
              command: drafts.find((d) => d.local_id === localId)?.command as
                | JsonObject
                | undefined,
            },
      );
      if (planned.kind === "refused")
        return { kind: "refused", reason: planned.reason };
      if (planned.kind === "invalid") throw unbuildable(planned.reason);
      // The header and the body replace the stored pair together; the version records do not move (the edit raised nothing).
      record("edit", given, planned.draft, planned.command, localId);
      drafts = drafts.map((d) =>
        d.local_id === localId
          ? { ...planned.draft, command: planned.command }
          : d,
      );
      notify();
      return { kind: "edited", localId };
    },
    supersede: async (old: string, given: EnqueueRequest) => {
      const request = snapshotRequest(given);
      validateRequestFor(request, "supersede");
      const scripted = outcomes.shift();
      if (scripted !== undefined && scripted.kind === "refused")
        return scripted;
      estimateDraftBytes(request);
      const localId = request.localId ?? nextLocalId();
      // The old draft as the store holds it: a draft of this world, else the conflict inbox's (its body is `putBody`'s).
      const inbox = env.conflicts.get();
      const listed =
        inbox.status === "ready"
          ? inbox.value.rows.find((row) => row.draft.local_id === old)?.draft
          : undefined;
      const oldRow = headers().find((d) => d.local_id === old) ?? listed;
      const existing = headers().find((d) => d.local_id === localId);
      // The cascade (`readCascade`): the old draft and everything that waits on it, transitively.
      const cascade = new Map<string, DraftRow>();
      if (oldRow !== undefined && existing === undefined) {
        cascade.set(oldRow.local_id, oldRow);
        const frontier = [oldRow.local_id];
        while (frontier.length > 0) {
          const id = frontier.pop() as string;
          for (const row of headers())
            if (row.depends_on.includes(id) && !cascade.has(row.local_id)) {
              cascade.set(row.local_id, row);
              frontier.push(row.local_id);
            }
        }
      }
      const members = [...cascade.values()].sort(
        (a, b) => a.created_seq - b.created_seq,
      );
      const ids = [
        ...(oldRow === undefined
          ? []
          : members.flatMap((m) => [...m.index_targets, ...m.bumped])),
        ...request.targets.map((target) => target.resourceId),
      ];
      const decision = decideSupersede(request, {
        old: oldRow,
        existing,
        existingPaused:
          oldRow === undefined && existing !== undefined
            ? headers()
                .filter(
                  (d) =>
                    d.depends_on.includes(existing.local_id) &&
                    d.status === "version_conflict" &&
                    d.last_error?.stage === "dependency_superseded",
                )
                .map((d) => d.local_id)
            : [],
        direct: members.filter(
          (m) => m.local_id !== old && m.depends_on.includes(old),
        ),
        cascade: members,
        extras: headers().filter((d) =>
          (request.dependsOnExtra ?? []).includes(d.local_id),
        ),
        // The world records no pending effects (nothing of it is sent).
        effects: [],
        others: relatedTo(ids, new Set(cascade.keys())),
        cache: cachedRows(ids),
        versions: versionRows(ids),
        sync: syncRow(),
        localId,
        accountId: ME,
        now: NOW,
      });
      if (decision.kind === "refused")
        return { kind: "refused", reason: decision.reason };
      if (decision.kind === "invalid") throw unbuildable(decision.reason);
      if (decision.kind === "duplicate")
        return {
          kind: "superseded",
          localId: decision.draft.local_id,
          paused: decision.paused,
        };
      // ONE state change: the old draft leaves (from the inbox too), its dependants are rewritten, the replacement and its body are put,
      // and the version records are recomputed.
      putVersions(decision.versionPuts, decision.versionDeletes);
      if (decision.sync !== undefined) draftSeq = decision.sync.draft_seq;
      record("supersede", given, decision.draft, decision.command, old);
      const rewritten = new Map(decision.draftPuts.map((d) => [d.local_id, d]));
      drafts = [
        ...drafts
          .filter((d) => !decision.draftDeletes.includes(d.local_id))
          .map((d) => {
            const put = rewritten.get(d.local_id);
            return put === undefined ? d : { ...put, command: d.command };
          }),
        { ...decision.draft, command: decision.command },
      ];
      bodies.delete(old);
      if (listed !== undefined && inbox.status === "ready")
        env.setConflicts({
          status: "ready",
          value: {
            ...inbox.value,
            rows: inbox.value.rows.filter((row) => row.draft.local_id !== old),
          },
        });
      notify();
      return {
        kind: "superseded",
        localId: decision.draft.local_id,
        paused: decision.paused,
      };
    },
  };
  (env as unknown as { outbox: () => unknown }).outbox = () =>
    outboxAvailable ? outbox : null;

  const api = fakePeopleApi(() => cache);
  // The real list of form copies is a live read that answers AFTER the write (a later task): never in the same turn as the write.
  const later = () =>
    setTimeout(() => {
      act(() => notify());
    }, 0);
  const copyKey = (context: string, tab: string) => `${context}\u0000${tab}`;
  /** One page of a family's live copies after `after`, in primary-key order (the real read's paging), shown oldest first. */
  const copiesPage = (
    prefix: string,
    after: readonly [string, string] | null,
  ) => {
    const keyed = [...copies.values()]
      .filter((row) => row.form_context.startsWith(prefix))
      .sort((a, b) =>
        a.form_context === b.form_context
          ? a.tab_instance_id < b.tab_instance_id
            ? -1
            : 1
          : a.form_context < b.form_context
            ? -1
            : 1,
      )
      .filter(
        (row) =>
          after === null ||
          row.form_context > after[0] ||
          (row.form_context === after[0] && row.tab_instance_id > after[1]),
      );
    const page: FormRecoveryRow[] = [];
    let next: readonly [string, string] | null = null;
    for (const row of keyed) {
      if (row.terminal) continue;
      page.push(row);
      if (page.length === 100) {
        next = [row.form_context, row.tab_instance_id];
        break;
      }
    }
    page.sort((a, b) => (a.saved_at < b.saved_at ? -1 : 1));
    return { copies: page, next, more: next !== null };
  };
  const stateOf = (row: FormRecoveryRow | undefined) =>
    row === undefined ? "absent" : row.terminal ? "ended" : "live";
  // The conditional port's double: compare-and-set over the copies (the real digest), answers scripted by `heldSaves`/`heldEnds`.
  const heldPort: ConditionalFormPort = {
    async put(snapshot, expect) {
      const answer = heldSaves.shift() ?? "write";
      if (answer === "failed" || answer === "refused") return { kind: answer };
      const key = copyKey(snapshot.formContext, snapshot.tabInstanceId);
      const stored = copies.get(key);
      const state = stateOf(stored);
      if (
        expect === null
          ? state !== "absent"
          : state !== "live" || stored?.content_digest !== expect
      )
        return { kind: "changed", stored: state };
      const digest = digestOf(snapshot.values);
      copies.set(key, {
        form_context: snapshot.formContext,
        tab_instance_id: snapshot.tabInstanceId,
        fields: { ...snapshot.values },
        redacted: [],
        saved_at: new Date(Date.now() + copies.size).toISOString(),
        capture_seq: 0,
        terminal: false,
        content_digest: digest,
      });
      later();
      return { kind: "saved", digest };
    },
    async end(formContext, tab, expect, tombstone = {}) {
      const answer = heldEnds.shift();
      if (answer !== undefined) return { kind: answer };
      const key = copyKey(formContext, tab);
      const stored = copies.get(key);
      const state = stateOf(stored);
      if (state !== "live" || stored?.content_digest !== expect)
        return { kind: "changed", stored: state };
      copies.set(key, {
        ...(stored as FormRecoveryRow),
        fields: { ...tombstone },
        terminal: true,
        content_digest: digestOf(tombstone),
      });
      later();
      return { kind: "ended" };
    },
    async read(formContext, tab) {
      const stored = copies.get(copyKey(formContext, tab));
      return stored === undefined
        ? { kind: "absent" }
        : stored.terminal
          ? {
              kind: "ended",
              fields: { ...stored.fields },
              digest: stored.content_digest,
            }
          : { kind: "live", row: { ...stored, fields: { ...stored.fields } } };
    },
    async apply(operations) {
      const answer = heldSaves.shift() ?? "write";
      if (answer === "failed" || answer === "refused") return { kind: answer };
      for (const [index, operation] of operations.entries()) {
        const stored = copies.get(
          copyKey(
            operation.snapshot.formContext,
            operation.snapshot.tabInstanceId,
          ),
        );
        const state = stateOf(stored);
        const want = operation.expect;
        if (
          want.state !== state ||
          (want.state !== "absent" && stored?.content_digest !== want.digest)
        )
          return { kind: "changed", index, stored: state };
      }
      const digests = operations.map((operation) => {
        const digest = digestOf(operation.snapshot.values);
        copies.set(
          copyKey(
            operation.snapshot.formContext,
            operation.snapshot.tabInstanceId,
          ),
          {
            form_context: operation.snapshot.formContext,
            tab_instance_id: operation.snapshot.tabInstanceId,
            fields: { ...operation.snapshot.values },
            redacted: [],
            saved_at: new Date(Date.now() + copies.size).toISOString(),
            capture_seq: 0,
            terminal: operation.terminal,
            content_digest: digest,
          },
        );
        return digest;
      });
      later();
      return { kind: "saved", digests };
    },
    pinned() {
      return heldPort;
    },
    async list(prefix, after) {
      return copiesPage(prefix, after);
    },
  };
  const heldStore: HeldStore = heldStoreOver(heldPort, () =>
    new Date().toISOString(),
  );
  // Who waits for a lock to be let go (`released`): told when this page's run ends, or when `releaseElsewhere` lets another page's go.
  const waiters = new Map<string, Array<() => void>>();
  const wake = (name: string) => {
    if (heldElsewhere.has(name) || held.has(name)) return;
    for (const resolve of waiters.get(name) ?? []) resolve();
    waiters.delete(name);
  };
  const exclusive = async <T,>(
    name: string,
    run: () => Promise<T>,
  ): Promise<T | null> => {
    if (heldElsewhere.has(name) || held.has(name)) return null;
    held.add(name);
    try {
      return await run();
    } finally {
      held.delete(name);
      wake(name);
    }
  };
  const released = (name: string): Promise<void> =>
    heldElsewhere.has(name) || held.has(name)
      ? new Promise((resolve) => {
          waiters.set(name, [...(waiters.get(name) ?? []), resolve]);
        })
      : Promise.resolve();
  const sharing = fakeSharingApi();
  const identity = options.identity ?? `${ME}:1`;
  let online = options.online ?? true;
  const shared = () => sharingEnv(sharing, { online, identity, accountId: ME });
  const people = (): PeopleEnv => {
    const base = shared();
    return {
      api,
      sharing,
      accountId: ME,
      identity,
      online,
      writable: true,
      newId: base.newId,
      now: () => Date.now(),
      memory: peopleMemory(identity),
      held: heldStore,
      exclusive,
      released,
    };
  };
  let peopleEnv = people();
  let sharingValue = shared();
  let rerender: ((ui: ReactNode) => void) | null = null;
  let router: ReturnType<typeof createAppRouter> | null = null;
  const tree = () => (
    <SessionProvider session={sessionDouble()}>
      <ProtectedProviders>
        <ShellEnvProvider
          value={{
            syncModel: { phase: "synced", pendingCount: 0, conflictCount: 0 },
            onOpenSync: () => {},
          }}
        >
          <DataEnvProvider env={env}>
            <SharingEnvProvider value={sharingValue}>
              <PeopleEnvProvider value={peopleEnv}>
                {router ? <RouterProvider router={router} /> : null}
              </PeopleEnvProvider>
            </SharingEnvProvider>
          </DataEnvProvider>
        </ShellEnvProvider>
      </ProtectedProviders>
    </SessionProvider>
  );
  const world: PeopleWorld = {
    env,
    api,
    sharing,
    get people() {
      return peopleEnv;
    },
    cache,
    get drafts() {
      return drafts;
    },
    built,
    outcomes,
    versions,
    copies,
    heldSaves,
    heldEnds,
    heldElsewhere,
    releaseElsewhere(name) {
      heldElsewhere.delete(name);
      act(() => wake(name));
    },
    held() {
      return [...copies.values()]
        .filter((row) => !row.terminal)
        .map(decodeHeld)
        .filter((change): change is HeldChange => change !== null);
    },
    putHeld(change) {
      const context = heldContextOf(change.personId, change.fieldId);
      const fields = encodeHeld(change);
      copies.set(copyKey(context, change.holdId), {
        form_context: context,
        tab_instance_id: change.holdId,
        fields,
        redacted: [],
        saved_at: new Date(Date.now() + copies.size).toISOString(),
        capture_seq: 0,
        terminal: false,
        content_digest: digestOf(fields),
      });
      // As "Hold as draft" writes it: the field's head names the hold put last (a retired record is never current).
      if (!change.retired) {
        const head = {
          held_head: JSON.stringify({
            v: 1,
            seq: change.seq,
            current: change.holdId,
          }),
        };
        copies.set(copyKey(context, HEAD_TAB), {
          form_context: context,
          tab_instance_id: HEAD_TAB,
          fields: head,
          redacted: [],
          saved_at: new Date().toISOString(),
          capture_seq: 0,
          terminal: true,
          content_digest: digestOf(head),
        });
      }
      act(() => notify());
    },
    putBody(localId, command) {
      bodies.set(localId, command);
      act(() => notify());
    },
    setCache(rows) {
      cache.clear();
      for (const row of rows) cache.set(row.id, row);
      act(() => notify());
    },
    putCache(row) {
      cache.set(row.id, row);
      publish([row]);
      act(() => notify());
    },
    setDrafts(next) {
      drafts = next;
      act(() => notify());
    },
    setOnline(next) {
      online = next;
      peopleEnv = people();
      sharingValue = shared();
      env.set({ online: next });
      act(() => rerender?.(tree()));
    },
    noDatabase() {
      outboxAvailable = false;
    },
    failReads() {
      failing = true;
      act(() => notify());
    },
    failRead(plan, match = () => true) {
      faults.push({ plan, match });
      act(() => notify());
    },
    restoreReads(options) {
      faults.length = 0;
      failing = false;
      if (options?.notify !== false) act(() => notify());
    },
    holdReads(plan, match = () => true) {
      holds.push({ plan, match });
    },
    releaseReads() {
      holds.length = 0;
      holding += 1;
      act(() => notify());
    },
    freezeReads(plan, match = () => true) {
      frozen.push({ plan, match });
    },
    thawReads() {
      frozen.length = 0;
      act(() => notify());
    },
    handOff(rows, next) {
      for (const row of rows) cache.set(row.id, row);
      drafts = next;
      publish(rows);
      act(() => notify());
    },
    gated,
    watches,
    advanceRevision() {
      appliedRevision += 1;
      act(() => notify());
    },
    async mount(path) {
      router = createAppRouter({ initialPath: path });
      const view = render(tree());
      rerender = (ui) => view.rerender(ui);
      await screen.findByRole("main", { hidden: true });
      await untilLazyScreensShown();
      return { router };
    },
  } as PeopleWorld;
  env.set({ cache: "valid", online });
  return world;
}

/**
 * The People screens are a lazy chunk (`src/features/people/screens.tsx`): each lazy route component suspends once on its first render,
 * even with its module loaded, and the nested ones (the layout, then the detail or the editor) resolve one after another. The module is
 * loaded first, then React is flushed until the document stops changing (two quiet flushes in a row), so a test's first query sees the
 * rendered screen. Bounded: a document that never settles is an error, not a pass.
 */
async function untilLazyScreensShown(): Promise<void> {
  await import("../../../src/features/people/screens");
  let last = document.body.innerHTML;
  let quiet = 0;
  for (let round = 0; round < 50 && quiet < 2; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const now = document.body.innerHTML;
    quiet = now === last ? quiet + 1 : 0;
    last = now;
  }
  if (quiet < 2) throw new Error("the people screens did not settle");
}

export const person = (over: Partial<CacheRow> = {}): CacheRow =>
  cacheRow({
    kind: "person",
    version: 3,
    policy_version: 2,
    can_edit: true,
    ...over,
  });

export const fieldRow = (over: Partial<CacheRow> = {}): CacheRow =>
  cacheRow({
    kind: "field",
    version: 2,
    policy_version: 1,
    can_edit: true,
    value: { kind: "text", text: "07700 900461" },
    label: "Phone",
    ...over,
  });
