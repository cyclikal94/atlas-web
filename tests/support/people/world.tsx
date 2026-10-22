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
  type JsonObject,
  type Loadable,
} from "../../../src/data";
import { digestOf } from "../../../src/data/model/canonical";
import {
  commandKindOf,
  estimateDraftBytes,
} from "../../../src/data/model/outbox";
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
 *  - The data layer is the stub controller (`stubEnv`) with a store double that answers the three read plans the screens use
 *    (`data.readMerged`, `data.readResourceList`, `data.readOutstandingCreates`) from `cache` and `drafts`, live.
 *  - The outbox is a double that runs each request's `build` on the bases the real plan would resolve (the record a queued save of this
 *    device raised, else the cached version of a checked target, else the seed of a created one; the record follows a newer cached version
 *    as the real reconciliation does) and records it; a queued draft then appears among the outstanding drafts, with its bases, as the
 *    real store would. A build that throws is a refused write (the real facade reports it as a failed save). A save under a local id that is
 *    already a draft is the same save (a duplicate adds nothing).
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
  /** The sync engine applied a page of changes (`sync_state.applied_revision` moves): the summaries' invalidation signal. */
  advanceRevision(): void;
  mount(path: string): Promise<{ router: ReturnType<typeof createAppRouter> }>;
}

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
      return {
        status: "ready",
        value: {
          drafts: window,
          next: live.length > 100 ? (window.at(-1)?.created_seq ?? null) : null,
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
        return {
          get: () =>
            compute === undefined
              ? ({ status: "loading" } as Loadable<unknown>)
              : answer(key, () => compute(input)),
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
  const basesOf = (request: EnqueueRequest) => {
    const bases: Record<string, number> = {};
    for (const target of request.targets) {
      const tracked = versions.get(target.resourceId);
      const cached = cache.get(target.resourceId)?.version;
      const base = tracked ?? cached ?? target.seedIfUntracked;
      if (base !== undefined) bases[target.resourceId] = base;
    }
    return bases;
  };
  const bumpedOf = (request: EnqueueRequest) =>
    request.targets
      .filter((target) => target.versionChecked)
      .map((target) => target.resourceId);
  /** Whether an outstanding draft other than `except` raised `id`. */
  const raisedBy = (id: string, except?: string) =>
    drafts.some(
      (d) =>
        d.local_id !== except &&
        d.bumped.includes(id) &&
        ["queued", "in_flight", "blocked", "acknowledged"].includes(d.status),
    );
  const nextLocalId = () => {
    seq += 1;
    return `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
  };
  const record = (
    op: Built["op"],
    request: EnqueueRequest,
    localId: string,
    target?: string,
  ) => {
    // The real facade sizes the write first, building from placeholder bases (no bases, the widest version) before the transaction.
    estimateDraftBytes(request);
    const bases = basesOf(request);
    const result = request.build(bases);
    if (op !== "edit")
      for (const id of bumpedOf(request))
        versions.set(id, (bases[id] as number) + 1);
    built.push({
      request,
      command: result.command as Record<string, unknown>,
      ...(result.displayPatch === undefined
        ? {}
        : { displayPatch: result.displayPatch }),
      ...(result.defaultsReview === undefined
        ? {}
        : { defaultsReview: result.defaultsReview }),
      localId,
      op,
      ...(target === undefined ? {} : { target }),
    });
    return { ...result, bases };
  };
  let outboxAvailable = true;
  const outbox = {
    enqueue: async (request: EnqueueRequest) => {
      const scripted = outcomes.shift();
      if (scripted !== undefined && scripted.kind === "refused")
        return scripted;
      const localId = request.localId ?? nextLocalId();
      // The same save again (a retry after a lost completion): nothing is added.
      if (drafts.some((d) => d.local_id === localId))
        return { kind: "queued", localId, createdSeq: seq } as EnqueueOutcome;
      const result = record("enqueue", request, localId);
      drafts = [
        ...drafts,
        {
          local_id: localId,
          account_id: ME,
          endpoint: request.endpoint,
          target_id: null,
          kind: commandKindOf(result.command, request.endpoint),
          command: result.command,
          command_digest: "x",
          defaults_revision: result.defaultsRevision ?? null,
          target_resource_ids: request.targets.map((t) => t.resourceId),
          side_effect_bases: {},
          index_targets: request.targets.map((t) => t.resourceId),
          bases: result.bases,
          bumped: bumpedOf(request),
          defaults_context: null,
          review_block:
            result.defaultsReview && result.defaultsReview.length > 0
              ? { kind: "defaults", kinds: [...result.defaultsReview] }
              : null,
          depends_on: [...(request.dependsOnExtra ?? [])],
          status: "queued",
          held_pending_cache: false,
          unavailable_outcome: false,
          retry_state: null,
          attempts: 0,
          last_attempt_at: null,
          last_error: null,
          display_patch: null,
          receipt_revision: null,
          created_seq: seq,
          created_at: "2026-10-12T09:00:00.000Z",
        } as DraftWithCommand,
      ];
      notify();
      return { kind: "queued", localId, createdSeq: seq } as EnqueueOutcome;
    },
    editQueued: async (localId: string, request: EnqueueRequest) => {
      const scripted = outcomes.shift();
      if (scripted !== undefined && scripted.kind === "refused")
        return scripted;
      const draft = drafts.find((d) => d.local_id === localId);
      if (draft === undefined) return { kind: "refused", reason: "not_found" };
      if (draft.status !== "queued")
        return { kind: "refused", reason: "not_queued" };
      if (request.expectDraft !== undefined && !request.expectDraft(draft))
        return { kind: "refused", reason: "draft_changed" };
      const result = record("edit", request, localId, localId);
      drafts = drafts.map((d) =>
        d.local_id === localId ? { ...d, command: result.command } : d,
      );
      notify();
      return { kind: "edited", localId };
    },
    supersede: async (old: string, request: EnqueueRequest) => {
      // The old draft's contribution is retired first, and the replacement reads the corrected record (the real plan's order).
      for (const id of bumpedOf(request))
        if (!raisedBy(id, old)) versions.delete(id);
      const localId = nextLocalId();
      record("supersede", request, localId, old);
      return { kind: "superseded", localId, paused: [] };
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
    async end(formContext, tab, expect) {
      const answer = heldEnds.shift();
      if (answer !== undefined) return { kind: answer };
      const key = copyKey(formContext, tab);
      const stored = copies.get(key);
      const state = stateOf(stored);
      if (state !== "live" || stored?.content_digest !== expect)
        return { kind: "changed", stored: state };
      copies.set(key, {
        ...(stored as FormRecoveryRow),
        fields: {},
        terminal: true,
        content_digest: digestOf({}),
      });
      later();
      return { kind: "ended" };
    },
    async read(formContext, tab) {
      const stored = copies.get(copyKey(formContext, tab));
      return stored === undefined
        ? { kind: "absent" }
        : stored.terminal
          ? { kind: "ended" }
          : { kind: "live", row: { ...stored, fields: { ...stored.fields } } };
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
      // `reconcileVersions`: a delivered version at or above the record ends it when nothing of this device is outstanding for the row;
      // a higher one otherwise raises the record (queued drafts keep their bases and meet a genuine 409).
      const tracked = versions.get(row.id);
      if (tracked !== undefined) {
        if (row.version >= tracked && !raisedBy(row.id))
          versions.delete(row.id);
        else if (row.version > tracked) versions.set(row.id, row.version);
      }
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
