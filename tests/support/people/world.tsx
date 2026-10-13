import { RouterProvider } from "@tanstack/react-router";
import { act, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { ProtectedProviders } from "../../../src/app/providers";
import { createAppRouter } from "../../../src/app/router";
import { ShellEnvProvider } from "../../../src/app/shell/env";
import {
  type CacheRow,
  DataEnvProvider,
  type DraftWithCommand,
  type EnqueueOutcome,
  type EnqueueRequest,
  type Loadable,
} from "../../../src/data";
import { commandKindOf } from "../../../src/data/model/outbox";
import type {
  CommandAttempt,
  PeopleApi,
  PeopleResult,
  PersonDetailAnswer,
  ProjectionPage,
} from "../../../src/features/people/api";
import {
  type PeopleEnv,
  PeopleEnvProvider,
} from "../../../src/features/people/env";
import { peopleMemory } from "../../../src/features/people/memory";
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
 *  - The outbox is a double that runs each request's `build` on the bases the real plan would resolve (the cached version of a checked
 *    target, the seed of a created one) and records it; a queued draft then appears among the outstanding drafts, as the real store would.
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
  };
  /** Linked accounts by person id (the default answer of `readPerson`); a person absent from the cache is `not_found`. */
  linked: Map<string, string | null>;
}

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
  const api: FakePeopleApi = {
    calls: [],
    linked: new Map(),
    next: { person: [], duplicates: [], people: [], shared: [] },
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
  setOnline(online: boolean): void;
  /** The outbox is null (no database bound yet). */
  noDatabase(): void;
  /** Every list read fails (the store's `error`). */
  failReads(): void;
  mount(path: string): Promise<{ router: ReturnType<typeof createAppRouter> }>;
}

export function peopleWorld(
  options: { online?: boolean; identity?: string } = {},
): PeopleWorld {
  const env = stubEnv();
  const cache = new Map<string, CacheRow>();
  let drafts: DraftWithCommand[] = [];
  const listeners = new Set<Listener>();
  let version = 0;
  let failing = false;
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
      const cached = cache.get(target.resourceId)?.version;
      const base = cached ?? target.seedIfUntracked;
      if (base !== undefined) bases[target.resourceId] = base;
    }
    return bases;
  };
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
    const result = request.build(basesOf(request));
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
    return result;
  };
  let outboxAvailable = true;
  const outbox = {
    enqueue: async (request: EnqueueRequest) => {
      const scripted = outcomes.shift();
      if (scripted !== undefined && scripted.kind === "refused")
        return scripted;
      const localId = request.localId ?? nextLocalId();
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
          bases: {},
          bumped: [],
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
      const result = record("edit", request, localId, localId);
      drafts = drafts.map((d) =>
        d.local_id === localId ? { ...d, command: result.command } : d,
      );
      notify();
      return { kind: "edited", localId };
    },
    supersede: async (old: string, request: EnqueueRequest) => {
      const localId = nextLocalId();
      record("supersede", request, localId, old);
      return { kind: "superseded", localId, paused: [] };
    },
  };
  (env as unknown as { outbox: () => unknown }).outbox = () =>
    outboxAvailable ? outbox : null;

  const api = fakePeopleApi(() => cache);
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
      prefetchLinkage: 25,
      memory: peopleMemory(identity),
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
    setCache(rows) {
      cache.clear();
      for (const row of rows) cache.set(row.id, row);
      act(() => notify());
    },
    putCache(row) {
      cache.set(row.id, row);
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
