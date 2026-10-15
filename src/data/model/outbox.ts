import { canonicalJson, digestOf } from "./canonical";
import type { Observation } from "./observation";
import { OUTSTANDING } from "./reconcile";
import { isArrayIndex, MAX_DEPTH, snapshotPlain } from "./snapshot";
import type {
  CacheRow,
  DraftEndpoint,
  DraftRow,
  DraftWithCommand,
  JsonObject,
  LocalId,
  PendingEffectRow,
  ProjectionPatch,
  ResourceId,
  ResourceVersionRow,
  SyncStateRow,
} from "./types";

/**
 * The generic outbox, as PURE functions (plan 5.5). This module knows endpoints, wire shapes and the store-level rules; it does
 * not know what any command MEANS (which ids a command touches, how its effect is displayed, what a conflict's cause is):
 * those arrive through the request's `targets` and `build`, and through the registries of `src/data/outbox`.
 *
 * Nothing here reads a clock, a random source or the database: every plan passes in the rows it read and the instant and
 * identifier it was given, so each decision is a table-driven test.
 */
export interface TargetSpec {
  resourceId: ResourceId;
  role: "primary" | "side_effect";
  basis: ResourceVersionRow["basis"];
  /** A version-checked primary carries `expected_version = base` and raises the record by one. Side effects always raise it. */
  versionChecked: boolean;
  /** The version to assume for a resource nothing tracks yet: `1` for a resource this client creates. */
  seedIfUntracked?: number;
  /**
   * The version the person REVIEWED, from the authorised current-state read of WF-QUEUE-02 (a "save as new" built on what the dialog showed,
   * WEB-10a R5): the base of this target instead of the local record or the cache, so the command is sent on that version and the record
   * is raised from it (a later save of the same target is based on what this one leaves). Only a supersession built on a reviewed read
   * passes it; an ordinary save never does.
   */
  reviewedBase?: number;
}

/** The versions the command is built from, by resource id (only the targets that have one). */
export type Bases = Readonly<Record<ResourceId, number>>;

export interface BuildResult {
  command: JsonObject;
  displayPatch?: Record<ResourceId, ProjectionPatch>;
  defaultsRevision?: string | null;
  defaultsContext?: unknown;
  /**
   * The template kinds that need the person's review before this draft may be sent (WEB-12a, WEB-04 §5.7): a queued create that
   * relies on implicit defaults the device never fetched, or whose captured template names a household nobody here has seen.
   * Non-empty: the draft is stored with `review_block { kind: "defaults", kinds }`, which the dispatcher never sends and which holds
   * the queue from it (D-19). On an EDIT of a queued draft the field decides the block: absent keeps the block the draft has (an edit
   * of the content is not a review of its audience), `[]` clears it (the defaults review's confirmation), a list replaces it.
   */
  defaultsReview?: readonly string[];
}

/** A build's `defaultsReview`, which must be a list of texts: anything else is not what the contract allows (`not_json`). */
function reviewKindsOf(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((kind) => typeof kind !== "string"))
    throw new TypeError("defaultsReview must be a list of template kinds");
  return value as string[];
}

/** The review block a build asks for, or null for none. Kinds are kept once each, in order. */
function reviewBlockOf(
  kinds: readonly string[] | undefined,
): DraftRow["review_block"] {
  if (kinds === undefined || kinds.length === 0) return null;
  return { kind: "defaults", kinds: [...new Set(kinds)] };
}

export interface EnqueueRequest {
  endpoint: DraftEndpoint;
  /** A templated endpoint (`/calendar-sources/{id}/import`) is resolved from this at dispatch (Q22). */
  targetId?: string;
  targets: readonly TargetSpec[];
  /** PURE. Called inside the enqueue transaction with the bases that transaction read. */
  build(bases: Bases): BuildResult;
  dependsOnExtra?: readonly LocalId[];
  /**
   * The identity of THIS save. A person's retry of a save that failed passes the same one, so that a save whose completion was
   * lost (the commit happened, the answer did not arrive) is recognised and not made twice. The facade supplies one otherwise.
   */
  localId?: LocalId;
  /**
   * What the caller saw when it chose the values it builds from (`readResourceView`'s `observation`), or nothing. When given, the save
   * is written only if the enqueue (or supersede) transaction reads the SAME facts of that resource; otherwise nothing is written and
   * the answer is `refused / changed` (WEB-13a revision 2). A retry of a save that was already made is recognised first.
   */
  observed?: Observation;
  /**
   * PURE. For an edit of a queued draft or a supersession only: called inside the writing transaction with the draft as it is stored
   * NOW (the one being edited, or the one being replaced). `false` refuses the request (`draft_changed`) and nothing is written. A
   * caller that decided on a draft it read earlier (the defaults review's confirmation, WEB-12a R2) states here what it decided on, so a
   * change committed in between (another page's edit of the same draft) is never overwritten by a body built from the older read.
   */
  expectDraft?(draft: DraftRow): boolean;
}

/**
 * The size of a text in UTF-8 bytes: the ONE accounting method of the quota reserve for what a draft stores (R25, revision 12). It is
 * counted, never taken from `.length` (UTF-16 code units: a character of a CJK text is one unit and three bytes), and without building
 * a byte array. A lone surrogate counts as the three bytes of its replacement character. For any text UTF-8 is no smaller than the
 * UTF-16 or Latin-1 a structured clone writes, so the figure bounds those too; it is a bound for the quota reserve, not a measurement of
 * what an engine allocates (compression and index overhead are not modelled).
 */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (
      unit >= 0xd800 &&
      unit <= 0xdbff &&
      i + 1 < text.length &&
      (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00
    ) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * The size, in UTF-8 bytes, of a value as PLAIN JSON: what an opaque caller input (a defaults context) costs, which `canonicalJson` cannot
 * say because it also turns a `Map` or a `Date` into `{}`. Only what JSON carries is measured: `null`, booleans, finite numbers, strings,
 * arrays and plain objects. Anything else (a `Map`, a typed array, a class instance, a function, a `bigint`, a cycle, a value nested
 * deeper than {@link MAX_DEPTH}) is `null`: a size that cannot be established is never a small write, and the plan refuses the save
 * rather than store what it could not count. An `undefined` is counted as a `null`.
 *
 * WHAT IS MEASURED IS WHAT THE STORED FORM CAN RETAIN, NOT WHAT ITERATING THE VALUE YIELDS (R25, revision 14). A structured clone keeps
 * every own enumerable string-keyed property of an object AND of an array: `Object.assign([], { note: "x".repeat(900_000) })` is a
 * two-byte list to `JSON.stringify` and to a walk of its elements, and a 900,000-byte value to IndexedDB. So an array is measured by its
 * own enumerable keys, never through its iterator (an instance can replace `Symbol.iterator`, which a clone ignores): the members it has
 * by index, each hole as the `null` it stands for (counted, not walked: a list of a billion holes is a bound, not a loop), and every
 * named property as it would be in an object. A property read through a getter is a value that can answer differently when it is
 * measured and when it is stored, so an accessor is not plain data: it is not measured and the value is refused.
 */
export function plainJsonBytes(value: unknown): number | null {
  const path = new Set<object>();
  const walk = (item: unknown, depth: number): number | null => {
    if (item === null || item === undefined) return 4;
    switch (typeof item) {
      case "boolean":
        return item ? 4 : 5;
      case "number":
        return Number.isFinite(item) ? String(item).length : null;
      case "string":
        return utf8Length(JSON.stringify(item));
      case "object":
        break;
      default:
        return null;
    }
    if (depth >= MAX_DEPTH || path.has(item)) return null;
    const proto = Object.getPrototypeOf(item);
    const array = Array.isArray(item);
    // A plain object's prototype is a root prototype (`Object.prototype` of any realm); a `Map`, `Date` or class instance has another.
    if (!array && proto !== null && Object.getPrototypeOf(proto) !== null)
      return null;
    path.add(item);
    // `Object.keys` is exactly what a clone retains: own, enumerable, string-keyed (on an array, its indexes first, then its named
    // properties). Each is read as DATA, from its descriptor, so that nothing here can run caller code.
    let payload = 0;
    let entries = 0;
    let indexed = 0;
    for (const key of Object.keys(item)) {
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (descriptor === undefined || !("value" in descriptor)) return null;
      const size = walk(descriptor.value, depth + 1);
      if (size === null) return null;
      const element = array && isArrayIndex(key);
      payload += element ? size : utf8Length(JSON.stringify(key)) + 1 + size;
      if (element) indexed += 1;
      entries += 1;
    }
    if (array) {
      // A hole is stored as nothing and counted as the `null` JSON says it is: a bound, in constant time whatever the length.
      const holes = (item as unknown[]).length - indexed;
      payload += holes * 4;
      entries += holes;
    }
    path.delete(item);
    return 2 + payload + Math.max(0, entries - 1);
  };
  try {
    return walk(value, 0);
  } catch {
    // A structure too deep for the stack, a revoked proxy: not measurable.
    return null;
  }
}

/**
 * The part of a draft's write that the allowance below stands for: the row's own fixed fields, the fixed overhead of the rows and of their
 * index entries (the figure the per-draft footprint reading, P-Q, measured at about 1.8 KB for a small draft). It is a FLOOR for what has a
 * fixed shape. It stands for NO caller-sized value: every one of those is measured (`draftWriteBytes`), and a bound for an opaque field is
 * never inferred from this figure.
 */
export const DRAFT_ALLOWANCE_BYTES = 4 * 1024;
/**
 * The canonical command and display patch, in UTF-8 bytes, plus the fixed allowance. `null`: a value that cannot be measured, which is
 * never a small write. This is the command's share of a write; `draftWriteBytes` is the whole of it.
 */
export function draftBytes(
  command: JsonObject,
  displayPatch: unknown,
): number | null {
  const body = plainJsonBytes(command);
  const patch =
    displayPatch === undefined || displayPatch === null
      ? 0
      : plainJsonBytes(displayPatch);
  return body === null || patch === null
    ? null
    : DRAFT_ALLOWANCE_BYTES + body + patch;
}

/**
 * How often an identifier is stored beyond the header that names it: a draft's `local_id` keys `drafts` and `draft_commands`; its
 * `depends_on` and `index_targets` entries are index entries of `drafts`; and the claim that sends it writes one candidate row per
 * primary target (`resource_id`, `local_id`, the key `[resource_id+local_id]` and two indexes). The save reserves what the later claim will
 * store, because the claim itself is not refused by the quota. Counted three times over, on top of the header's own copy.
 */
export const IDENTIFIER_COPIES = 3;
/** What rewriting one dependant adds (its pause and its re-pointed dependency), besides the replacement's identifier it now names. */
export const REWRITTEN_DEPENDANT_BYTES = 256;

/** Everything one save puts in the stores, as the plan composed it. */
export interface DraftWrite {
  /** The header as stored (`defaults_context`, `defaults_revision`, the identifiers and the rest included). */
  draft: DraftRow;
  /** The body, stored in `draft_commands`. */
  command: JsonObject;
  /** The `resource_versions` rows the save writes. */
  versionPuts: readonly ResourceVersionRow[];
  /** The dependants a supersession rewrites in the same transaction. */
  rewritten?: number;
}

/**
 * What a save will add to the origin's storage, in bytes, for the quota reserve (R25, revision 13): the WHOLE variable-size write, not the
 * command alone. Measured, in UTF-8: the canonical command and display patch (`draftBytes`), the header as stored without the patch
 * (so its `defaults_context`, which is opaque and unbounded, its `defaults_revision`, `endpoint`, `target_id`, `kind` and the identifiers
 * are counted), the `resource_versions` rows, every identifier again for the index entries and candidate rows (`IDENTIFIER_COPIES`), and
 * the dependants a supersession rewrites. Plus the fixed allowance for what has a fixed shape. `null`: a value that cannot be measured.
 *
 * It is a conservative BOUND for the quota policy, not a measurement of what an engine allocates. An edit replaces a header it already
 * holds and a supersession deletes one, and neither credit is taken: a bound that is too large refuses early, never late.
 */
export function draftWriteBytes(write: DraftWrite): number | null {
  const body = draftBytes(write.command, write.draft.display_patch);
  const header = plainJsonBytes({ ...write.draft, display_patch: null });
  const versions = plainJsonBytes(write.versionPuts);
  const identifiers = plainJsonBytes([
    write.draft.local_id,
    write.draft.depends_on,
    write.draft.index_targets,
    write.draft.target_resource_ids,
    write.versionPuts.map((row) => row.resource_id),
  ]);
  if (
    body === null ||
    header === null ||
    versions === null ||
    identifiers === null
  )
    return null;
  const rewritten = write.rewritten ?? 0;
  const rewrites =
    rewritten *
    (REWRITTEN_DEPENDANT_BYTES +
      (utf8Length(write.draft.local_id) + 3) * (1 + IDENTIFIER_COPIES));
  return body + header + versions + identifiers * IDENTIFIER_COPIES + rewrites;
}

/**
 * The widest version a command can carry: a base of this size is written with as many digits as any real one, so a command built from
 * it is no smaller than the command the transaction will build from the real bases.
 */
const WIDEST_VERSION = Number.MAX_SAFE_INTEGER;

/** What the estimate stands in for where the transaction knows the value: the identity of the save, as wide as a real one. */
export interface EstimateIdentity {
  localId?: string;
  accountId?: string;
}
const PLACEHOLDER_ID = "00000000-0000-4000-8000-000000000000";

/**
 * What the facade reserves BEFORE the transaction (the quota check is asynchronous and cannot run inside one). The bases are chosen
 * inside the transaction, so they are not known here: `build` is PURE, and it is asked for the command from two sets that bound the real
 * one (no bases, and the widest version for every target). For each set that builds, the header is composed by the same code as the
 * transaction's (`composeDraft`, over the widest bases, with the dependencies and the identity at their widest) and the whole write is
 * measured (`draftWriteBytes`); the larger is the estimate. A request whose `build` cannot run from either is estimated at the allowance
 * alone, which is a floor and never a claim that the write is small.
 *
 * It is only the FIRST figure. The plan measures the write it really composed, from the bases it read, against what was reserved
 * (`maxBytes`), and writes nothing when that is larger; the facade then admits the write again at its real size (R25, revisions 12 and 13).
 */
export function estimateDraftBytes(
  request: EnqueueRequest,
  identity: EstimateIdentity = {},
): number {
  const widest: Record<ResourceId, number> = {};
  const versions = new Map<ResourceId, ResourceVersionRow>();
  for (const target of request.targets) {
    widest[target.resourceId] = WIDEST_VERSION;
    versions.set(target.resourceId, {
      resource_id: target.resourceId,
      locally_assumed_version: WIDEST_VERSION,
      basis: target.basis,
    });
  }
  const resolved = resolveTargets(request.targets, {
    cache: new Map(),
    versions,
  });
  const localId = request.localId ?? identity.localId ?? PLACEHOLDER_ID;
  let largest = DRAFT_ALLOWANCE_BYTES;
  for (const bases of [{}, widest]) {
    try {
      const built = request.build(bases);
      let bytes: number | null;
      if (resolved === null)
        bytes = draftBytes(built.command, built.displayPatch);
      else {
        const draft = composeDraft(
          request,
          built,
          "0".repeat(64),
          resolved,
          // At most one dependency per target is found by the transaction, and the caller's own are known.
          [
            ...request.targets.map(() => PLACEHOLDER_ID),
            ...(request.dependsOnExtra ?? []),
          ],
          {
            localId,
            accountId: identity.accountId ?? PLACEHOLDER_ID,
            createdSeq: Number.MAX_SAFE_INTEGER,
            now: "0000-00-00T00:00:00.000Z",
          },
        );
        bytes = draftWriteBytes({
          draft,
          command: built.command,
          versionPuts: resolved.versionPuts,
        });
      }
      if (bytes !== null) largest = Math.max(largest, bytes);
    } catch {
      // This set of bases says nothing about the size.
    }
  }
  return largest;
}

/** A request the caller built wrongly (a defect, never a runtime condition): the facade throws it, nothing is written. */
export class OutboxRequestError extends Error {
  constructor(readonly reason: string) {
    super(`invalid outbox request: ${reason}`);
    this.name = "OutboxRequestError";
  }
}

/**
 * The kind of a command: `command.kind`, else the kind of a SINGLE wrapped command (`{command: {kind, ...}}`, the body of
 * `/calendar-commands`, `/task-commands` and `/reminder-commands`), else the first member of a command group, else the endpoint.
 * Derived ONCE, at enqueue, into the draft's header (`DraftRow.kind`), so nothing that lists or describes drafts needs the body. The
 * data layer never branches on it.
 */
export function commandKindOf(command: JsonObject, endpoint: string): string {
  if (typeof command.kind === "string") return command.kind;
  const wrapped = command.command;
  if (
    typeof wrapped === "object" &&
    wrapped !== null &&
    !Array.isArray(wrapped)
  ) {
    const kind = (wrapped as Record<string, unknown>).kind;
    if (typeof kind === "string") return kind;
  }
  const group = command.commands;
  if (Array.isArray(group) && group.length > 0) {
    const first = group[0] as Record<string, unknown> | null;
    if (first && typeof first.kind === "string") return first.kind;
  }
  return endpoint;
}

/** The terminal statuses of a draft, for `depends_on`: nothing waits on a draft in one of them. */
export const TERMINAL: ReadonlySet<string> = new Set([
  "acknowledged",
  "rejected",
  "superseded",
]);
export const isTerminal = (draft: Pick<DraftRow, "status">): boolean =>
  TERMINAL.has(draft.status);

const PATH = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/{}-]*$/;

/**
 * A private copy of what a request SAYS, taken at the public boundary before anything is awaited (R39, revision 22): the endpoint, the
 * target id, the targets, the extra dependencies and the identity of the save. What `validateRequest` checks, what the quota estimate
 * measures, what the transaction reads its facts for and what the header stores are then one value; a caller that edits its request while
 * the reservation is awaited or the transaction reads changes none of them (the endpoint it was validated with is the one stored).
 * `build` stays the caller's function (it is PURE and is asked again inside the transaction, from the bases that transaction read); what
 * it returns is snapshotted by the plan (`buildSnapshot`), not here.
 */
export function snapshotRequest(request: EnqueueRequest): EnqueueRequest {
  const build = request.build;
  return {
    endpoint: request.endpoint,
    targets: request.targets.map((target) => ({
      resourceId: target.resourceId,
      role: target.role,
      basis: target.basis,
      versionChecked: target.versionChecked,
      ...(target.seedIfUntracked === undefined
        ? {}
        : { seedIfUntracked: target.seedIfUntracked }),
      ...(target.reviewedBase === undefined
        ? {}
        : { reviewedBase: target.reviewedBase }),
    })),
    build: (bases) => build.call(request, bases),
    ...(request.targetId === undefined ? {} : { targetId: request.targetId }),
    ...(request.dependsOnExtra === undefined
      ? {}
      : { dependsOnExtra: [...request.dependsOnExtra] }),
    ...(request.localId === undefined ? {} : { localId: request.localId }),
    ...(request.observed === undefined
      ? {}
      : {
          observed: {
            resourceId: request.observed.resourceId,
            token: request.observed.token,
          },
        }),
    ...(request.expectDraft === undefined
      ? {}
      : {
          expectDraft: (draft: DraftRow) =>
            request.expectDraft?.call(request, draft) === true,
        }),
  };
}

/** The static checks of a request (everything that does not need the database). Throws `OutboxRequestError`. */
export function validateRequest(request: EnqueueRequest): void {
  const { endpoint } = request;
  if (!PATH.test(endpoint) || endpoint.includes(".."))
    throw new OutboxRequestError("endpoint");
  const bare = endpoint.replace(/\{id\}/g, "");
  if (bare.includes("{") || bare.includes("}"))
    throw new OutboxRequestError("endpoint");
  // A templated endpoint is resolved from `target_id` at dispatch, so the request must carry one.
  if (bare !== endpoint && !request.targetId)
    throw new OutboxRequestError("target_id");
  const seen = new Set<string>();
  let versioned = 0;
  for (const target of request.targets) {
    if (seen.has(target.resourceId)) throw new OutboxRequestError("duplicate");
    seen.add(target.resourceId);
    if (target.role === "primary" && target.versionChecked) versioned += 1;
    if (target.role === "side_effect" && !target.versionChecked)
      throw new OutboxRequestError("side_effect_unversioned");
    if (
      target.reviewedBase !== undefined &&
      (!Number.isSafeInteger(target.reviewedBase) || target.reviewedBase < 1)
    )
      throw new OutboxRequestError("reviewed_base");
  }
  if (versioned > 1) throw new OutboxRequestError("two_versioned_primaries");
}

/** Resolves a templated endpoint, or returns `null` for a draft that cannot be addressed. */
export function resolveEndpoint(
  endpoint: string,
  targetId: string | null,
): string | null {
  if (!endpoint.includes("{")) return endpoint;
  if (targetId === null || targetId === "") return null;
  return endpoint.replace(/\{id\}/g, encodeURIComponent(targetId));
}

// ---- enqueue ----------------------------------------------------------------------------------------------------------------
export interface EnqueueFacts {
  sync: SyncStateRow;
  /** The cached row of each target that has one. */
  cache: ReadonlyMap<ResourceId, CacheRow>;
  versions: ReadonlyMap<ResourceId, ResourceVersionRow>;
  /** Every draft whose `index_targets` names a primary target of the request. */
  related: readonly DraftRow[];
  /** The draft already stored under the request's local id, if any. */
  existing: DraftRow | undefined;
  localId: LocalId;
  accountId: string;
  /** An ISO instant. */
  now: string;
}

export type PlannedEnqueue =
  | { kind: "refused"; reason: "fenced" | "closing" | "no_base" }
  | { kind: "invalid"; reason: "build_failed" | "not_json" }
  /** The same save was already made (a retry after a lost completion): nothing changes. */
  | { kind: "duplicate"; draft: DraftRow }
  | {
      kind: "queued";
      /** The header, which goes to `drafts`, and the body, which goes to `draft_commands` in the same transaction. */
      draft: DraftRow;
      command: JsonObject;
      versionPuts: ResourceVersionRow[];
      sync: SyncStateRow;
    };

/** The fence refuses a draft insert and an in-place edit of a queued command (decision D-20); nothing else. */
export function fenceRefusal(sync: SyncStateRow): "fenced" | "closing" | null {
  const fence = sync.draft_fence;
  if (fence === null) return null;
  return fence.closing ? "closing" : "fenced";
}

interface ResolvedTargets {
  bases: Record<ResourceId, number>;
  sideEffectBases: Record<ResourceId, number>;
  bumped: ResourceId[];
  expectedVersion: number | undefined;
  versionPuts: ResourceVersionRow[];
}

/**
 * The one atomic read-increment-write that serialises two tabs enqueuing for the same resource (WEB-04 D:3128-3143): every base
 * is read and every record raised in the SAME transaction, so the second tab reads the first's increment.
 */
function resolveTargets(
  targets: readonly TargetSpec[],
  facts: Pick<EnqueueFacts, "cache" | "versions">,
): ResolvedTargets | null {
  const bases: Record<ResourceId, number> = {};
  const sideEffectBases: Record<ResourceId, number> = {};
  const bumped: ResourceId[] = [];
  const versionPuts: ResourceVersionRow[] = [];
  let expectedVersion: number | undefined;
  for (const target of targets) {
    const id = target.resourceId;
    const tracked = facts.versions.get(id)?.locally_assumed_version;
    const cached = facts.cache.get(id)?.version;
    const untracked = tracked === undefined && cached === undefined;
    const base =
      target.reviewedBase ??
      tracked ??
      cached ??
      target.seedIfUntracked ??
      null;
    const bumps = target.role === "side_effect" || target.versionChecked;
    if (bumps) {
      if (base === null) return null;
      bases[id] = base;
      bumped.push(id);
      if (target.role === "side_effect") sideEffectBases[id] = base;
      else expectedVersion = base;
      versionPuts.push({
        resource_id: id,
        locally_assumed_version: base + 1,
        basis: target.basis,
      });
    } else if (base !== null) {
      bases[id] = base;
      // A resource this client creates, and a timer session, start at their seed: no `expected_version`, no increment.
      if (untracked && target.seedIfUntracked !== undefined)
        versionPuts.push({
          resource_id: id,
          locally_assumed_version: target.seedIfUntracked,
          basis: target.basis,
        });
    }
  }
  return { bases, sideEffectBases, bumped, expectedVersion, versionPuts };
}

/**
 * What a new draft waits on: the latest still-unsettled draft against EACH of its targets, plus the caller's extras. A side-effect
 * id is a target exactly as a primary one is (WEB-04 D:3017-3023, `by_target_resource` indexes both), so two drafts that touch one
 * progress stream are one chain and a cascade can never leave a draft behind that stands on a voided increment.
 */
function dependencies(
  request: EnqueueRequest,
  related: readonly DraftRow[],
  self: LocalId,
): LocalId[] {
  const out: LocalId[] = [];
  const add = (id: LocalId): void => {
    if (id !== self && !out.includes(id)) out.push(id);
  };
  for (const target of request.targets) {
    let latest: DraftRow | undefined;
    for (const draft of related)
      if (
        draft.local_id !== self &&
        !isTerminal(draft) &&
        draft.index_targets.includes(target.resourceId) &&
        (latest === undefined || draft.created_seq > latest.created_seq)
      )
        latest = draft;
    if (latest) add(latest.local_id);
  }
  for (const extra of request.dependsOnExtra ?? []) add(extra);
  return out;
}

/**
 * What a request builds from `bases`, as ONE private snapshot (R39, revision 22; `snapshot.ts` says why). The caller's `build` returns a
 * graph it may still hold (the build contract gives the plan no exclusive ownership of it), and the plan digests it, measures it, and then
 * writes it a request at a time, so everything the plan derives (the digest, the kind, the admitted size, the header and the body) is taken
 * from this copy and the caller's graph is not read again. Each field of the result is read once. `bases` is passed as a copy as well: a
 * builder that keeps or alters its argument touches nothing the header stores. A value that is not plain JSON data (a hole in an array
 * among them, R40) is a `TypeError`, which the callers report as `not_json`.
 */
function buildSnapshot(request: EnqueueRequest, bases: Bases): BuildResult {
  const { command, displayPatch, defaultsRevision, ...defaults } =
    request.build({ ...bases });
  const { defaultsContext, defaultsReview } = defaults;
  return {
    command: snapshotPlain(command) as JsonObject,
    ...(displayPatch === undefined
      ? {}
      : {
          displayPatch: snapshotPlain(displayPatch) as Record<
            ResourceId,
            ProjectionPatch
          >,
        }),
    ...(defaultsRevision === undefined
      ? {}
      : { defaultsRevision: snapshotPlain(defaultsRevision) as string | null }),
    ...(defaultsContext === undefined
      ? {}
      : { defaultsContext: snapshotPlain(defaultsContext) }),
    ...(defaultsReview === undefined
      ? {}
      : { defaultsReview: reviewKindsOf(snapshotPlain(defaultsReview)) }),
  };
}

/** What the transaction knows about the draft it composes beyond the request: its identity, its place in the sequence and the instant. */
interface DraftIdentity {
  localId: LocalId;
  accountId: string;
  createdSeq: number;
  now: string;
}

/**
 * The header of a new draft, composed in ONE place: the transaction's `planEnqueue` and the pre-transaction estimate both build it here,
 * so what the estimate measures is the shape of what the plan stores and the two cannot drift apart.
 */
function composeDraft(
  request: EnqueueRequest,
  built: BuildResult,
  digest: string,
  resolved: ResolvedTargets,
  dependsOn: LocalId[],
  identity: DraftIdentity,
): DraftRow {
  const primaries = request.targets
    .filter((target) => target.role === "primary")
    .map((target) => target.resourceId);
  const indexTargets = [
    ...primaries,
    ...Object.keys(resolved.sideEffectBases).filter(
      (id) => !primaries.includes(id),
    ),
  ];
  return {
    local_id: identity.localId,
    account_id: identity.accountId,
    endpoint: request.endpoint,
    target_id: request.targetId ?? null,
    kind: commandKindOf(built.command, request.endpoint),
    command_digest: digest,
    defaults_revision: built.defaultsRevision ?? null,
    target_resource_ids: primaries,
    side_effect_bases: resolved.sideEffectBases,
    index_targets: indexTargets,
    bases: resolved.bases,
    bumped: resolved.bumped,
    ...(resolved.expectedVersion === undefined
      ? {}
      : { expected_version: resolved.expectedVersion }),
    defaults_context: built.defaultsContext ?? null,
    review_block: reviewBlockOf(built.defaultsReview),
    depends_on: dependsOn,
    status: "queued",
    held_pending_cache: false,
    unavailable_outcome: false,
    retry_state: null,
    attempts: 0,
    last_attempt_at: null,
    last_error: null,
    display_patch: built.displayPatch ?? null,
    receipt_revision: null,
    created_seq: identity.createdSeq,
    created_at: identity.now,
  };
}

export function planEnqueue(
  request: EnqueueRequest,
  facts: EnqueueFacts,
): PlannedEnqueue {
  if (facts.existing) return { kind: "duplicate", draft: facts.existing };
  const refusal = fenceRefusal(facts.sync);
  if (refusal !== null) return { kind: "refused", reason: refusal };
  const resolved = resolveTargets(request.targets, facts);
  if (resolved === null) return { kind: "refused", reason: "no_base" };

  let built: BuildResult;
  let digest: string;
  try {
    built = buildSnapshot(request, resolved.bases);
    digest = digestOf(built.command);
  } catch (error) {
    // The snapshot and `canonicalJson` throw on a value JSON cannot carry exactly; a throwing builder is the caller's defect.
    return {
      kind: "invalid",
      reason: error instanceof TypeError ? "not_json" : "build_failed",
    };
  }

  const createdSeq = facts.sync.draft_seq + 1;
  const draft = composeDraft(
    request,
    built,
    digest,
    resolved,
    dependencies(request, facts.related, facts.localId),
    {
      localId: facts.localId,
      accountId: facts.accountId,
      createdSeq,
      now: facts.now,
    },
  );
  return {
    kind: "queued",
    draft,
    command: built.command,
    versionPuts: resolved.versionPuts,
    sync: { ...facts.sync, draft_seq: createdSeq },
  };
}

// ---- an in-place edit of a queued command ---------------------------------------------------------------------------------
export type PlannedEdit =
  | {
      kind: "refused";
      reason:
        | "fenced"
        | "closing"
        | "not_found"
        | "not_queued"
        | "retargeted"
        | "draft_changed";
    }
  | { kind: "invalid"; reason: "build_failed" | "not_json" }
  | { kind: "edited"; draft: DraftRow; command: JsonObject };

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((id) => b.includes(id));

/** Whether a request addresses exactly what a stored draft does: the endpoint, the target id and the same primary and side-effect resources. */
function sameTargets(request: EnqueueRequest, draft: DraftRow): boolean {
  const primaries = request.targets
    .filter((target) => target.role === "primary")
    .map((target) => target.resourceId);
  const sides = request.targets
    .filter((target) => target.role === "side_effect")
    .map((target) => target.resourceId);
  return (
    request.endpoint === draft.endpoint &&
    (request.targetId ?? null) === draft.target_id &&
    sameSet(primaries, draft.target_resource_ids) &&
    sameSet(sides, Object.keys(draft.side_effect_bases))
  );
}

/**
 * The body of a `queued` draft, edited in place. The command is frozen the instant the status leaves `queued` (it may have been
 * transmitted), so an edit of any other status is refused and the change is a NEW draft (F-O3). The edit rebuilds from the
 * bases the draft already holds and cannot change what it targets.
 */
export function planEdit(
  request: EnqueueRequest,
  draft: DraftRow | undefined,
  sync: SyncStateRow,
): PlannedEdit {
  if (draft === undefined) return { kind: "refused", reason: "not_found" };
  const refusal = fenceRefusal(sync);
  if (refusal !== null) return { kind: "refused", reason: refusal };
  if (draft.status !== "queued")
    return { kind: "refused", reason: "not_queued" };
  if (!sameTargets(request, draft))
    return { kind: "refused", reason: "retargeted" };
  if (request.expectDraft !== undefined && !request.expectDraft(draft))
    return { kind: "refused", reason: "draft_changed" };
  let built: BuildResult;
  let digest: string;
  try {
    built = buildSnapshot(request, draft.bases);
    digest = digestOf(built.command);
  } catch (error) {
    return {
      kind: "invalid",
      reason: error instanceof TypeError ? "not_json" : "build_failed",
    };
  }
  return {
    kind: "edited",
    draft: {
      ...draft,
      kind: commandKindOf(built.command, draft.endpoint),
      command_digest: digest,
      defaults_revision: built.defaultsRevision ?? draft.defaults_revision,
      defaults_context: built.defaultsContext ?? draft.defaults_context,
      review_block:
        built.defaultsReview === undefined
          ? draft.review_block
          : reviewBlockOf(built.defaultsReview),
      display_patch: built.displayPatch ?? null,
    },
    command: built.command,
  };
}

/**
 * Whether `draft`, stored under the key of a replacement, IS that replacement: the same endpoint, target and resources, and a command
 * that the request builds again, from the bases the draft holds, to the digest the draft carries. A draft edited since, or another
 * command that merely uses the key, is not.
 */
function isSameSave(request: EnqueueRequest, draft: DraftRow): boolean {
  if (!sameTargets(request, draft)) return false;
  try {
    return (
      digestOf(buildSnapshot(request, draft.bases).command) ===
      draft.command_digest
    );
  } catch {
    return false;
  }
}

// ---- cascades and the version base -----------------------------------------------------------------------------------------
export interface RecomputeInput {
  /** The drafts that are leaving the queue (discarded, or rejected by a cascade). */
  members: readonly DraftRow[];
  /** Every OTHER draft that targets any id the members touched. */
  others: readonly DraftRow[];
  cache: ReadonlyMap<ResourceId, CacheRow>;
  versions: ReadonlyMap<ResourceId, ResourceVersionRow>;
}

export interface Recomputed {
  puts: ResourceVersionRow[];
  deletes: ResourceId[];
}

/**
 * The version base after a cascade (plan 5.5.5, WEB-04 D:3030-3034). For every id a member raised:
 *
 *   `resource_versions[id] = max(cache[id].version, min(bases the members assumed for id))`
 *
 * with an absent cache version counting as minus infinity. Two refinements, both only ever HIGHER or a deletion of a record that
 * can no longer mean anything: the record never falls below what a draft that stays in the queue still stands on (`base + 1` of
 * each outstanding draft that raised it), and a record for an id that has no cached row and that no outstanding draft targets
 * is removed (it would otherwise outlive the resource it described, for example a create that was discarded).
 */
export function recomputeVersions(input: RecomputeInput): Recomputed {
  const puts: ResourceVersionRow[] = [];
  const deletes: ResourceId[] = [];
  const touched = new Set<ResourceId>();
  for (const member of input.members) {
    for (const id of member.index_targets) touched.add(id);
    for (const id of member.bumped) touched.add(id);
  }
  for (const id of [...touched].sort()) {
    const record = input.versions.get(id);
    const bases: number[] = [];
    for (const member of input.members)
      if (member.bumped.includes(id) && member.bases[id] !== undefined)
        bases.push(member.bases[id] as number);
    const remaining = input.others.filter(
      (other) =>
        OUTSTANDING.has(other.status) && other.index_targets.includes(id),
    );
    const cacheVersion = input.cache.get(id)?.version;
    if (cacheVersion === undefined && remaining.length === 0) {
      if (record) deletes.push(id);
      continue;
    }
    if (bases.length === 0) continue;
    let value = Math.max(
      cacheVersion ?? Number.NEGATIVE_INFINITY,
      Math.min(...bases),
    );
    for (const other of remaining)
      if (other.bumped.includes(id) && other.bases[id] !== undefined)
        value = Math.max(value, (other.bases[id] as number) + 1);
    puts.push({
      resource_id: id,
      locally_assumed_version: value,
      basis: record?.basis ?? "resource",
    });
  }
  return { puts, deletes };
}

/** The body a request puts on the wire: the canonical JSON of the stored command, identical on every attempt. */
export const wireBody = (draft: Pick<DraftWithCommand, "command">): string =>
  canonicalJson(draft.command);

/** One candidate row per primary target, created when a draft is claimed for sending. */
export function candidateRows(
  draft: DraftRow,
  pageSeq: number,
): PendingEffectRow[] {
  return draft.target_resource_ids.map((id) => ({
    resource_id: id,
    local_id: draft.local_id,
    resource_version: draft.bases[id] ?? null,
    created_at: draft.created_at,
    submitted_at_page_seq: pageSeq,
    last_mentioned_page_seq: null,
    display: null,
    resolved: null,
    no_publication_floor: null,
    receipt_revision: null,
  }));
}

// ---- discard ------------------------------------------------------------------------------------------------------------------
export interface DiscardFacts {
  draft: DraftRow | undefined;
  /** Every direct and transitive dependant of `draft`, in `created_seq` order. */
  dependants: readonly DraftRow[];
  /** The candidate rows of `draft` and of its dependants. */
  effects: readonly PendingEffectRow[];
  /** Every draft that is neither `draft` nor a dependant and targets an id they touched. */
  others: readonly DraftRow[];
  cache: ReadonlyMap<ResourceId, CacheRow>;
  versions: ReadonlyMap<ResourceId, ResourceVersionRow>;
}

export type DiscardDecision =
  | {
      kind: "refused";
      reason:
        | "not_found"
        | "in_flight"
        | "acknowledged"
        | "dependant_in_flight";
    }
  | {
      kind: "discarded";
      /** `removed`: the row is deleted. `retained`: it becomes `rejected` and stays until the person dismisses it. */
      outcome: "removed" | "retained" | "dismissed";
      draftPuts: DraftRow[];
      draftDeletes: LocalId[];
      effectDeletes: Array<[ResourceId, LocalId]>;
      versions: Recomputed;
    };

const effectKeys = (
  effects: readonly PendingEffectRow[],
  members: readonly DraftRow[],
): Array<[ResourceId, LocalId]> => {
  const ids = new Set(members.map((member) => member.local_id));
  return effects
    .filter((row) => ids.has(row.local_id))
    .map((row) => [row.resource_id, row.local_id]);
};

/**
 * The person discards a draft (plan 5.5.5; WEB-04 D:2867-3078, D:3281-3290). What happens depends on what the draft IS:
 *
 *  - a `rejected` row, or an acknowledged row with a retained `unavailable_outcome`: a pure DISMISSAL, a delete with NO recompute
 *    (the cascade that rejected it already retired its contribution, atomically);
 *  - an `in_flight` draft with no defaults review: REFUSED. It may have been executed, and its body and existence are frozen once
 *    transmitted;
 *  - an `operation_conflict` draft: it becomes `rejected` and stays (whether the earlier operation took effect is the person's to
 *    judge, WEB-10c), and
 *  - every other draft (`queued`, `version_conflict`, `blocked`, a defaults review): the row is removed.
 *
 * Every direct and transitive dependant of a draft that is removed or rejected becomes `rejected` ("N other pending changes
 * depended on this and are affected") and is never deleted merely because its predecessor was. The version base is recomputed for
 * the whole cascade in the same step (`recomputeVersions`).
 */
export function decideDiscard(facts: DiscardFacts): DiscardDecision {
  const { draft } = facts;
  if (draft === undefined) return { kind: "refused", reason: "not_found" };
  const nothing: Recomputed = { puts: [], deletes: [] };

  if (draft.status === "rejected") {
    return {
      kind: "discarded",
      outcome: "dismissed",
      draftPuts: facts.dependants
        .filter((dependant) => dependant.depends_on.includes(draft.local_id))
        .map((dependant) => ({
          ...dependant,
          depends_on: dependant.depends_on.filter(
            (id) => id !== draft.local_id,
          ),
        })),
      draftDeletes: [draft.local_id],
      effectDeletes: effectKeys(facts.effects, [draft]),
      versions: nothing,
    };
  }
  if (draft.status === "acknowledged") {
    if (!draft.unavailable_outcome)
      return { kind: "refused", reason: "acknowledged" };
    return {
      kind: "discarded",
      outcome: "dismissed",
      draftPuts: [],
      draftDeletes: [draft.local_id],
      effectDeletes: effectKeys(facts.effects, [draft]),
      versions: nothing,
    };
  }
  if (draft.status === "in_flight" && draft.review_block === null)
    return { kind: "refused", reason: "in_flight" };
  for (const dependant of facts.dependants)
    if (dependant.status === "in_flight" && dependant.review_block === null)
      return { kind: "refused", reason: "dependant_in_flight" };

  const retained = draft.status === "operation_conflict";
  const members = [draft, ...facts.dependants];
  const puts: DraftRow[] = [];
  if (retained)
    puts.push({
      ...draft,
      status: "rejected",
      retry_state: null,
      last_error: { stage: "discarded" },
    });
  for (const dependant of facts.dependants)
    if (!isTerminal(dependant))
      puts.push({
        ...dependant,
        status: "rejected",
        retry_state: null,
        last_error: { stage: "dependency_rejected" },
      });
  return {
    kind: "discarded",
    outcome: retained ? "retained" : "removed",
    draftPuts: puts,
    draftDeletes: retained ? [] : [draft.local_id],
    effectDeletes: effectKeys(facts.effects, members),
    versions: recomputeVersions({
      members,
      others: facts.others,
      cache: facts.cache,
      versions: facts.versions,
    }),
  };
}

// ---- supersede ----------------------------------------------------------------------------------------------------------------
export interface SupersedeFacts {
  old: DraftRow | undefined;
  /**
   * The draft stored under the replacement's own `localId`, whatever its status. A key names ONE draft for its whole life, so a
   * replacement must have a fresh one (R24, revision 12): the key of `old`, of an unrelated draft, of a dependant or of a draft that is
   * in flight or retained after an answer is never overwritten.
   */
  existing: DraftRow | undefined;
  /**
   * Read only when `old` is gone and `existing` is there: the direct dependants of `existing` that a supersession paused for review
   * (`dependency_superseded`), which is what a retry of a completed supersession reports as paused.
   */
  existingPaused: readonly LocalId[];
  /** The drafts that name `old` in `depends_on`. */
  direct: readonly DraftRow[];
  /** `old`'s whole cascade, dependants included: they are never a dependency of the replacement. */
  cascade: readonly DraftRow[];
  /**
   * The drafts that exist under the ids of the request's `dependsOnExtra` (read by key; absent: none). They are what the caller says
   * the replacement waits for, so their place in the queue decides whether it may keep the old draft's (R45, revision 25).
   */
  extras?: readonly DraftRow[];
  effects: readonly PendingEffectRow[];
  /** Every draft outside the cascade that targets an id the replacement or `old` touches. */
  others: readonly DraftRow[];
  cache: ReadonlyMap<ResourceId, CacheRow>;
  versions: ReadonlyMap<ResourceId, ResourceVersionRow>;
  sync: SyncStateRow;
  localId: LocalId;
  accountId: string;
  now: string;
}

export type SupersedeDecision =
  | {
      kind: "refused";
      reason:
        | "fenced"
        | "closing"
        | "not_found"
        | "not_supersedable"
        | "key_in_use"
        | "no_base"
        /** The request's `expectDraft` refused the old draft as it is stored now: nothing is written. */
        | "draft_changed"
        /**
         * The replacement could not be put in an order that every draft involved can follow (R45, revision 25): it would have to wait
         * for a newer draft (or for one of its own dependants) while drafts older than that one wait for it, or it would stand on
         * a version a dependant has already counted. Nothing is written; the old draft stays as it was.
         */
        | "order_conflict";
    }
  | { kind: "invalid"; reason: "build_failed" | "not_json" }
  /** The same supersession was already made (a retry after a lost completion): nothing changes, as for a duplicate enqueue. */
  | { kind: "duplicate"; draft: DraftRow; paused: LocalId[] }
  | {
      kind: "superseded";
      draft: DraftRow;
      /** Present only when the replacement was given a NEW place at the end of the queue (it consumed a sequence number). */
      sync?: SyncStateRow;
      /** The replacement's body, written to `draft_commands` with its header. */
      command: JsonObject;
      draftPuts: DraftRow[];
      draftDeletes: LocalId[];
      effectDeletes: Array<[ResourceId, LocalId]>;
      versionPuts: ResourceVersionRow[];
      versionDeletes: ResourceId[];
      /** The dependants paused for review. */
      paused: LocalId[];
    };

/**
 * A draft replaced by a NEW one with a fresh `local_id` (D:3291-3350): a version conflict's "keep editing", a defaults review's
 * confirmation, an operation conflict's re-expression. The old row is deleted at once (its content lives on in its
 * replacement), every DIRECT dependant's `depends_on` entry is retargeted to the new `local_id`, and the old row's contribution to
 * the version base is retired before the replacement reads its own base, so the replacement is built against the corrected
 * record. A dependant is paused as `version_conflict` for review when the supersession is a version conflict's (D:3304-3330), and
 * ALSO whenever the replacement's assumed resulting version differs from the one the dependant was composed against: this layer
 * cannot rewrite a command body it does not understand, so it never forwards a body built on a version that no longer holds.
 *
 * THE QUEUE STAYS ORDERED (R45, revision 25). The replacement is a new draft whose bases and dependencies are those of the queue as it
 * is now, and it must leave the queue in an order every draft can follow: each dependency older than its dependant, so that the one
 * with the smallest `created_seq` among the unsettled is always free to go.
 *
 *  - Nothing it waits for is newer than the old draft: it takes the old draft's place (the dependants stay behind it).
 *  - Something it waits for is newer (a draft that was enqueued after the old one, for a target the replacement now uses): it takes the
 *    END of the queue, as an enqueue of the same request would, which is where its bases already put it. That is only possible while no
 *    dependant of the old draft stands behind it.
 *  - Otherwise nothing keeps every draft's order and every base honest, and the request is REFUSED (`order_conflict`) before anything is
 *    written: an explicit dependency on a dependant of the old draft (a cycle), a newer dependency with dependants to stay ahead of, or a
 *    target the replacement raises where the old draft did not and one of its dependants touches. The old draft is left as it was.
 *
 * A dependant is paused for review when the replacement leaves a different version for ANY id the old draft raised (another base, or
 * none because the target was dropped), and a dependant that stays queued keeps the record at what it stands on.
 */
export function decideSupersede(
  request: EnqueueRequest,
  facts: SupersedeFacts,
): SupersedeDecision {
  const { old, existing } = facts;
  if (old === undefined) {
    // The old draft is gone. When the draft under the replacement's key IS that replacement (a retry of a supersession whose completion
    // was lost: the old row is deleted by it), the retry is recognised and nothing changes, as for an enqueue. Anything else under the
    // key is somebody else's, and there is nothing to supersede.
    if (existing !== undefined && isSameSave(request, existing))
      return {
        kind: "duplicate",
        draft: existing,
        paused: [...facts.existingPaused],
      };
    return { kind: "refused", reason: "not_found" };
  }
  const refusal = fenceRefusal(facts.sync);
  if (refusal !== null) return { kind: "refused", reason: refusal };
  const supersedable =
    old.status === "version_conflict" ||
    old.status === "operation_conflict" ||
    (old.status === "in_flight" && old.review_block !== null);
  if (!supersedable) return { kind: "refused", reason: "not_supersedable" };
  if (request.expectDraft !== undefined && !request.expectDraft(old))
    return { kind: "refused", reason: "draft_changed" };
  // The replacement is written under its key and `old` is deleted, so a key that is already a draft's (the old one's included) would
  // lose or overwrite that draft, a frozen in-flight body among them. Refused before anything is changed: neither command, nor their
  // effects, dependencies or versions move.
  if (existing !== undefined) return { kind: "refused", reason: "key_in_use" };

  // The old contribution is retired first, and the replacement reads the corrected record.
  const recomputed = recomputeVersions({
    members: [old],
    others: facts.others,
    cache: facts.cache,
    versions: facts.versions,
  });
  const versions = new Map(facts.versions);
  for (const id of recomputed.deletes) versions.delete(id);
  for (const row of recomputed.puts) versions.set(row.resource_id, row);

  const planned = planEnqueue(request, {
    sync: facts.sync,
    cache: facts.cache,
    versions,
    related: facts.others,
    // Proven above: nothing is stored under the replacement's key.
    existing: undefined,
    localId: facts.localId,
    accountId: facts.accountId,
    now: facts.now,
  });
  if (planned.kind === "refused") return planned;
  if (planned.kind === "invalid") return planned;
  if (planned.kind === "duplicate")
    return { kind: "refused", reason: "no_base" };

  // ---- where the replacement stands (R45, revision 25) ----------------------------------------------------------------------------
  // THE INVARIANT: every `depends_on` entry names an OLDER draft (a smaller `created_seq`). The dispatcher holds a draft behind every
  // earlier unsettled draft that shares a target AND behind each of its dependencies, so a dependency that is newer than its dependant
  // is a draft that waits for the dependant (when they share a target) while the dependant waits for it: neither can ever be sent.
  // `planEnqueue` cannot break it (a new draft is the newest); a replacement that keeps the old draft's place can, because the bases and
  // the dependencies it derived are those of the queue as it is NOW, which includes drafts newer than the place it takes.
  //
  // The drafts that stand behind the replacement and wait for it: the old draft's dependants that are still in the queue.
  const standing = facts.cascade.filter(
    (member) => member.local_id !== old.local_id && !isTerminal(member),
  );
  const standingIds = new Set(standing.map((member) => member.local_id));
  const dependsOn = [
    ...new Set([...old.depends_on, ...planned.draft.depends_on]),
  ].filter((id) => id !== old.local_id);
  // An explicit dependency on a draft that itself waits for the old one is a cycle (the replacement would wait for its own dependant).
  if (dependsOn.some((id) => standingIds.has(id)))
    return { kind: "refused", reason: "order_conflict" };
  // The place the replacement may take is the old draft's only if nothing it waits for is newer than that place.
  const known = new Map<LocalId, DraftRow>();
  for (const row of [...facts.others, ...(facts.extras ?? [])])
    known.set(row.local_id, row);
  const newerDependency = dependsOn.some((id) => {
    const row = known.get(id);
    return (
      row !== undefined && !isTerminal(row) && row.created_seq > old.created_seq
    );
  });
  // Its bases were read from the record after every draft in the queue but its own dependants (the old draft's contribution is retired,
  // theirs is not counted), so it stands AFTER every other draft that raised a version it uses. Behind a newer draft it can only stand at
  // the end of the queue, which is what an enqueue of the same request would be; but a dependant of the old draft must stay behind the
  // replacement, and there is no place that is behind the newer draft and ahead of that dependant that every draft keeps.
  if (newerDependency && standing.length > 0)
    return { kind: "refused", reason: "order_conflict" };
  // A target the replacement raises where the old draft did not (a new target, a side effect added, a primary made version-checked) is
  // one the old draft's dependants cannot have counted: where one of them touches it, its base was derived from a record that holds
  // that dependant's own contribution, and the dependant would stand on a version the replacement now raises ahead of it.
  const raisedAhead = (id: string): boolean =>
    planned.draft.index_targets.includes(id) &&
    (!old.index_targets.includes(id) ||
      (planned.draft.bumped.includes(id) && !old.bumped.includes(id)));
  if (
    standing.some((member) =>
      [...member.index_targets, ...member.bumped].some(raisedAhead),
    )
  )
    return { kind: "refused", reason: "order_conflict" };

  const replacement: DraftRow = {
    ...planned.draft,
    // Where nothing it waits for is newer it takes the old draft's PLACE in the queue (and so stays ahead of the dependants it now
    // stands behind): the old row is deleted in this same transaction, so the sequence number is unique at rest and `draft_seq` is not
    // consumed. Behind a newer draft (and with no dependant to stay ahead of) it keeps the sequence number `planEnqueue` gave it, the
    // next one, and the plan writes the counter.
    created_seq: newerDependency ? planned.draft.created_seq : old.created_seq,
    depends_on: dependsOn,
  };
  // What a dependant assumed the old draft would leave: for each id it raised, its base plus one. A dependant is composed against that
  // figure, so any difference in what the replacement leaves (another base, another raise, or none at all: a target or side effect the
  // replacement no longer touches) is a body built on a version that no longer holds.
  const leaves = (draft: DraftRow, id: string): number | undefined =>
    draft.bumped.includes(id) && draft.bases[id] !== undefined
      ? (draft.bases[id] as number) + 1
      : undefined;
  const changed = old.bumped.some(
    (id) => leaves(old, id) !== leaves(replacement, id),
  );
  const pause = old.status === "version_conflict" || changed;
  const paused: LocalId[] = [];
  const puts: DraftRow[] = [];
  for (const dependant of facts.direct) {
    const retargeted = dependant.depends_on.map((id) =>
      id === old.local_id ? replacement.local_id : id,
    );
    const stop = pause && dependant.status === "queued";
    if (stop) paused.push(dependant.local_id);
    puts.push({
      ...dependant,
      depends_on: retargeted,
      ...(stop
        ? {
            status: "version_conflict" as const,
            last_error: { stage: "dependency_superseded" },
          }
        : {}),
    });
  }
  // The versions the replacement raised sit on top of the recomputed ones.
  const merged = new Map(recomputed.puts.map((row) => [row.resource_id, row]));
  for (const row of planned.versionPuts) merged.set(row.resource_id, row);
  // The recompute retired the old draft's contribution and, with it, the contribution of every dependant (they are not "other" drafts
  // to it: they are being moved, not removed), so the record the replacement left behind stands at ITS result alone. A dependant that
  // stays queued is still sent on the base it was composed against, so the record must not fall below what it stands on (the rule of
  // `recomputeVersions`): otherwise the next save of that target is based on a version the dependant is about to raise, and the server
  // refuses it. A dependant that was paused is resolved by the person, who supersedes or discards it, and both recompute from its bases.
  if (!pause)
    for (const member of standing)
      for (const id of member.bumped) {
        const row = merged.get(id);
        const stands = leaves(member, id);
        if (
          row !== undefined &&
          stands !== undefined &&
          row.locally_assumed_version < stands
        )
          merged.set(id, { ...row, locally_assumed_version: stands });
      }
  return {
    kind: "superseded",
    draft: replacement,
    ...(newerDependency ? { sync: planned.sync } : {}),
    command: planned.command,
    draftPuts: puts,
    draftDeletes: [old.local_id],
    effectDeletes: effectKeys(facts.effects, [old]),
    versionPuts: [...merged.values()],
    versionDeletes: recomputed.deletes.filter((id) => !merged.has(id)),
    paused,
  };
}
