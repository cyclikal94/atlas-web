import type { DraftRow, Epoch } from "./types";

/**
 * The sharing defaults as the client keeps them (WEB-12a; backend brief B5, WEB-04 §5.2 and §5.7). PURE: no browser, no clock.
 *
 * `GET /defaults/snapshot` returns the resolved defaults and the households their revision covers, read from ONE database snapshot:
 * `defaults.revision` is the revision of exactly those defaults and those household versions. The contract asks clients to store the
 * response AS ONE RECORD and never to combine it with separately timed `GET /defaults` or `GET /households` reads, so this module
 * parses the whole response strictly (every bound and pattern of the pinned contract) and the data layer persists it whole
 * (`sync_state.defaults`, writer W14). A draft queued while offline captures from that record (`captureDefaults`): the revision for
 * the `defaults_revision` guard, and, per template kind, the resolved template with the member lists of every household it names,
 * which is what the defaults review shows as "Was" (WEB-04 §5.7, F7a/F7b).
 */

export const TEMPLATE_KINDS = [
  "person",
  "field",
  "task",
  "list",
  "progress",
] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

export interface PrincipalGrant {
  kind: "account" | "household";
  id: string;
  edit: boolean;
}
export interface Policy {
  grants: PrincipalGrant[];
  exclude_accounts: string[];
}
export type DefaultTemplate =
  | { kind: "private" }
  | { kind: "primary_household"; edit: boolean }
  | { kind: "explicit"; policy: Policy };

export type HouseholdRole = "manager" | "member";
export interface HouseholdMember {
  account_id: string;
  username: string;
  role: HouseholdRole;
}
export interface SnapshotHousehold {
  id: string;
  name: string;
  version: number;
  role: HouseholdRole;
  members: HouseholdMember[];
}
export type ResolvedDefaults = {
  revision: string;
  preferences_version: number;
  primary_household_id: string | null;
} & Record<TemplateKind, DefaultTemplate>;
export interface SharingSnapshot {
  defaults: ResolvedDefaults;
  households: SnapshotHousehold[];
}

/** What `sync_state.defaults` holds: ONE snapshot (B5), when it was asked for and answered, and the sign-in that asked. */
export interface DefaultsRecord {
  format: 1;
  snapshot: SharingSnapshot;
  /** When the answer arrived (the page's clock). */
  fetched_at: number;
  /** When the request was issued: of two answers, the one asked for later is the newer state (two pages' reads landing out of order). */
  issued_at: number;
  epoch: Epoch;
}

// ---- the contract's bounds ------------------------------------------------------------------------------------------------------
export const MAX_HOUSEHOLDS = 32;
export const MAX_MEMBERS = 100;
export const MAX_GRANTS = 100;
export const MAX_EXCLUSIONS = 100;
export const MAX_HOUSEHOLD_NAME = 300;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REVISION = /^[0-9a-f]{64}$/;

export const isUuid = (value: unknown): value is string =>
  typeof value === "string" && UUID.test(value);
export const isRevision = (value: unknown): value is string =>
  typeof value === "string" && REVISION.test(value);

type Obj = Record<string, unknown>;
const isObject = (value: unknown): value is Obj =>
  typeof value === "object" && value !== null && !Array.isArray(value);
/** `additionalProperties: false`: exactly the named keys, the optional ones allowed to be absent. */
const hasExactly = (
  value: Obj,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean => {
  for (const key of required) if (!Object.hasOwn(value, key)) return false;
  for (const key of Object.keys(value))
    if (!required.includes(key) && !optional.includes(key)) return false;
  return true;
};
const isPositiveInt = (value: unknown, min: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min;
/** JSON Schema counts a string's length in code points, not UTF-16 units. */
const codePoints = (text: string): number => [...text].length;

export function parsePolicy(value: unknown): Policy | null {
  if (!isObject(value) || !hasExactly(value, ["grants", "exclude_accounts"]))
    return null;
  const { grants, exclude_accounts } = value;
  if (!Array.isArray(grants) || grants.length > MAX_GRANTS) return null;
  if (
    !Array.isArray(exclude_accounts) ||
    exclude_accounts.length > MAX_EXCLUSIONS
  )
    return null;
  const parsedGrants: PrincipalGrant[] = [];
  for (const grant of grants) {
    if (!isObject(grant) || !hasExactly(grant, ["kind", "id", "edit"]))
      return null;
    if (grant.kind !== "account" && grant.kind !== "household") return null;
    if (!isUuid(grant.id) || typeof grant.edit !== "boolean") return null;
    parsedGrants.push({ kind: grant.kind, id: grant.id, edit: grant.edit });
  }
  const excluded: string[] = [];
  for (const id of exclude_accounts) {
    if (!isUuid(id) || excluded.includes(id)) return null;
    excluded.push(id);
  }
  return { grants: parsedGrants, exclude_accounts: excluded };
}

export function parseTemplate(value: unknown): DefaultTemplate | null {
  if (!isObject(value)) return null;
  switch (value.kind) {
    case "private":
      return hasExactly(value, ["kind"]) ? { kind: "private" } : null;
    case "primary_household":
      return hasExactly(value, ["kind", "edit"]) &&
        typeof value.edit === "boolean"
        ? { kind: "primary_household", edit: value.edit }
        : null;
    case "explicit": {
      if (!hasExactly(value, ["kind", "policy"])) return null;
      const policy = parsePolicy(value.policy);
      return policy === null ? null : { kind: "explicit", policy };
    }
    default:
      return null;
  }
}

function parseMember(value: unknown): HouseholdMember | null {
  if (
    !isObject(value) ||
    !hasExactly(value, ["account_id", "username", "role"])
  )
    return null;
  if (!isUuid(value.account_id) || typeof value.username !== "string")
    return null;
  if (value.role !== "manager" && value.role !== "member") return null;
  return {
    account_id: value.account_id,
    username: value.username,
    role: value.role,
  };
}

export function parseHousehold(value: unknown): SnapshotHousehold | null {
  if (
    !isObject(value) ||
    !hasExactly(value, ["id", "name", "version", "role", "members"])
  )
    return null;
  const { id, name, version, role, members } = value;
  if (!isUuid(id)) return null;
  if (
    typeof name !== "string" ||
    codePoints(name) < 1 ||
    codePoints(name) > MAX_HOUSEHOLD_NAME
  )
    return null;
  if (!isPositiveInt(version, 1)) return null;
  if (role !== "manager" && role !== "member") return null;
  if (!Array.isArray(members) || members.length > MAX_MEMBERS) return null;
  const parsed: HouseholdMember[] = [];
  for (const member of members) {
    const m = parseMember(member);
    if (m === null) return null;
    parsed.push(m);
  }
  return { id, name, version, role, members: parsed };
}

function parseDefaults(value: unknown): ResolvedDefaults | null {
  if (
    !isObject(value) ||
    !hasExactly(value, [
      "revision",
      "preferences_version",
      "primary_household_id",
      ...TEMPLATE_KINDS,
    ])
  )
    return null;
  if (!isRevision(value.revision)) return null;
  if (!isPositiveInt(value.preferences_version, 1)) return null;
  const primary = value.primary_household_id;
  if (primary !== null && !isUuid(primary)) return null;
  const templates = {} as Record<TemplateKind, DefaultTemplate>;
  for (const kind of TEMPLATE_KINDS) {
    const template = parseTemplate(value[kind]);
    if (template === null) return null;
    templates[kind] = template;
  }
  return {
    revision: value.revision,
    preferences_version: value.preferences_version,
    primary_household_id: primary,
    ...templates,
  };
}

/**
 * The body of `GET /defaults/snapshot`, STRICTLY: every key, type, bound and pattern of the pinned contract (`SharingSnapshot`), no
 * extra keys, at most 32 households of at most 100 members, no repeated household. Anything else is `null`: an unrecognised answer,
 * never persisted and never shown. A TypeScript type is not validation.
 */
export function parseSharingSnapshot(body: unknown): SharingSnapshot | null {
  if (!isObject(body) || !hasExactly(body, ["defaults", "households"]))
    return null;
  const defaults = parseDefaults(body.defaults);
  if (defaults === null) return null;
  const { households } = body;
  if (!Array.isArray(households) || households.length > MAX_HOUSEHOLDS)
    return null;
  const parsed: SnapshotHousehold[] = [];
  for (const household of households) {
    const h = parseHousehold(household);
    if (h === null || parsed.some((other) => other.id === h.id)) return null;
    parsed.push(h);
  }
  return { defaults, households: parsed };
}

/**
 * The stored field, TOLERANTLY: `null`, the seed of an earlier slice, a record of another format or a damaged one all read as "no
 * record" (null), never as a defaults state. The snapshot inside is checked as strictly as the response it came from.
 */
export function parseDefaultsRecord(value: unknown): DefaultsRecord | null {
  if (!isObject(value) || value.format !== 1) return null;
  const snapshot = parseSharingSnapshot(value.snapshot);
  if (snapshot === null) return null;
  const { fetched_at, issued_at, epoch } = value;
  if (
    typeof fetched_at !== "number" ||
    !Number.isFinite(fetched_at) ||
    typeof issued_at !== "number" ||
    !Number.isFinite(issued_at) ||
    !isPositiveInt(epoch, 1)
  )
    return null;
  return { format: 1, snapshot, fetched_at, issued_at, epoch };
}

// ---- capture, for queued creates (WEB-04 §5.2, §5.7) ---------------------------------------------------------------------------
export const DEFAULTS_CONTEXT_FORMAT = "atlas-defaults-context-v1";

/** A household a captured template names that the snapshot does not list: the caller is not a member, so its people are unknown. */
export interface UnavailableHousehold {
  id: string;
  unavailable: true;
}
export type CapturedHousehold = SnapshotHousehold | UnavailableHousehold;

export interface CapturedKind {
  template: DefaultTemplate;
  /** Every household the template names, from the SAME snapshot (F7a: a membership-only change must be visible in the review). */
  households: CapturedHousehold[];
  /**
   * The usernames, as the SAME snapshot lists them among its households' members, of the accounts the template names directly (account
   * grants and exclusions), so the review can name the captured audience as it was (WEB-12a R4) rather than by today's names. An account
   * no listed household has as a member is absent (the review shows an abbreviated id). Absent in contexts captured before it existed.
   */
  accounts?: CapturedAccount[];
}

export interface CapturedAccount {
  account_id: string;
  username: string;
}

/** What a draft's `defaults_context` holds: the "Was" side of the defaults review, per template kind the command consumes. */
export interface DefaultsContextV1 {
  format: typeof DEFAULTS_CONTEXT_FORMAT;
  revision: string;
  fetched_at: number;
  primary_household_id: string | null;
  kinds: Partial<Record<TemplateKind, CapturedKind>>;
}

/**
 * What a builder attaches to a queued create that relies on implicit defaults. The three fields map one to one onto `BuildResult`
 * (`defaultsRevision`, `defaultsContext`, `defaultsReview`), so a builder may spread them into its result.
 *
 *  - `captured`: a record exists. `defaultsRevision` is its revision (send it as the command's `defaults_revision`), `defaultsContext`
 *    the captured templates and households. `defaultsReview` lists the kinds whose template names a household the snapshot does not
 *    list (an audience nobody on this device has seen): the draft is queued blocked on review for them (WEB-04 §5.7, F7b).
 *  - `never_fetched`: no record has ever been fetched for this account. Nothing can be captured; the draft is queued blocked on
 *    review for every kind requested, and is never sent with an omitted guard. A later background fetch does not unblock it: only
 *    the person's confirmation in the defaults review does ("fetching a list is not approval").
 */
export interface DefaultsCapture {
  kind: "captured" | "never_fetched";
  defaultsRevision: string | null;
  defaultsContext: DefaultsContextV1 | null;
  defaultsReview: TemplateKind[];
}

/** The households a template names: the primary household for `primary_household`, every household grant of an `explicit` policy. */
export function householdsNamedBy(
  template: DefaultTemplate,
  primaryHouseholdId: string | null,
): string[] {
  if (template.kind === "primary_household")
    return primaryHouseholdId === null ? [] : [primaryHouseholdId];
  if (template.kind === "explicit") {
    const ids: string[] = [];
    for (const grant of template.policy.grants)
      if (grant.kind === "household" && !ids.includes(grant.id))
        ids.push(grant.id);
    return ids;
  }
  return [];
}

/** The accounts a template names directly: its account grants, then its exclusions, once each. */
export function accountsNamedBy(template: DefaultTemplate): string[] {
  if (template.kind !== "explicit") return [];
  const ids: string[] = [];
  for (const grant of template.policy.grants)
    if (grant.kind === "account" && !ids.includes(grant.id)) ids.push(grant.id);
  for (const id of template.policy.exclude_accounts)
    if (!ids.includes(id)) ids.push(id);
  return ids;
}

const uniqueKinds = (kinds: readonly TemplateKind[]): TemplateKind[] => {
  const out: TemplateKind[] = [];
  for (const kind of kinds)
    if (
      (TEMPLATE_KINDS as readonly string[]).includes(kind) &&
      !out.includes(kind)
    )
      out.push(kind);
  return out;
};

/** Captures the kinds a command consumes from the persisted record. Pure and synchronous: a builder may call it from what it read. */
export function captureDefaults(
  record: DefaultsRecord | null,
  kinds: readonly TemplateKind[],
): DefaultsCapture {
  const wanted = uniqueKinds(kinds);
  if (record === null)
    return {
      kind: "never_fetched",
      defaultsRevision: null,
      defaultsContext: null,
      defaultsReview: wanted,
    };
  const { defaults, households } = record.snapshot;
  const captured: Partial<Record<TemplateKind, CapturedKind>> = {};
  const review: TemplateKind[] = [];
  for (const kind of wanted) {
    const template = defaults[kind];
    const named = householdsNamedBy(template, defaults.primary_household_id);
    const entries: CapturedHousehold[] = named.map(
      (id) =>
        households.find((household) => household.id === id) ?? {
          id,
          unavailable: true,
        },
    );
    if (entries.some((entry) => "unavailable" in entry)) review.push(kind);
    const accounts: CapturedAccount[] = [];
    for (const id of accountsNamedBy(template)) {
      const member = households
        .flatMap((household) => household.members)
        .find((m) => m.account_id === id);
      if (member !== undefined)
        accounts.push({ account_id: id, username: member.username });
    }
    captured[kind] = {
      template,
      households: entries,
      ...(accounts.length === 0 ? {} : { accounts }),
    };
  }
  return {
    kind: "captured",
    defaultsRevision: defaults.revision,
    defaultsContext: {
      format: DEFAULTS_CONTEXT_FORMAT,
      revision: defaults.revision,
      fetched_at: record.fetched_at,
      primary_household_id: defaults.primary_household_id,
      kinds: captured,
    },
    defaultsReview: review,
  };
}

/**
 * A stored `defaults_context`, read back TOLERANTLY: anything that is not this format (an earlier slice's seed such as
 * `{ kind: "defaults", kinds: [] }`, a foreign caller's data, damage) is null and the review says the audience was not recorded.
 */
export function parseDefaultsContext(value: unknown): DefaultsContextV1 | null {
  if (!isObject(value) || value.format !== DEFAULTS_CONTEXT_FORMAT) return null;
  if (!isRevision(value.revision)) return null;
  if (typeof value.fetched_at !== "number") return null;
  const primary = value.primary_household_id;
  if (primary !== null && !isUuid(primary)) return null;
  if (!isObject(value.kinds)) return null;
  const kinds: Partial<Record<TemplateKind, CapturedKind>> = {};
  for (const [key, entry] of Object.entries(value.kinds)) {
    if (!(TEMPLATE_KINDS as readonly string[]).includes(key)) return null;
    if (!isObject(entry) || !Array.isArray(entry.households)) return null;
    const template = parseTemplate(entry.template);
    if (template === null) return null;
    const households: CapturedHousehold[] = [];
    for (const household of entry.households) {
      if (
        isObject(household) &&
        household.unavailable === true &&
        isUuid(household.id)
      ) {
        households.push({ id: household.id, unavailable: true });
        continue;
      }
      const parsed = parseHousehold(household);
      if (parsed === null) return null;
      households.push(parsed);
    }
    // The captured names are a label only: an entry that is not one is left out (its account is shown by an abbreviated id).
    const accounts: CapturedAccount[] = [];
    if (Array.isArray(entry.accounts))
      for (const account of entry.accounts)
        if (
          isObject(account) &&
          isUuid(account.account_id) &&
          typeof account.username === "string"
        )
          accounts.push({
            account_id: account.account_id,
            username: account.username,
          });
    kinds[key as TemplateKind] = {
      template,
      households,
      ...(accounts.length === 0 ? {} : { accounts }),
    };
  }
  return {
    format: DEFAULTS_CONTEXT_FORMAT,
    revision: value.revision,
    fetched_at: value.fetched_at,
    primary_household_id: primary,
    kinds,
  };
}

/**
 * Which of WEB-04 §5.7's four review copies is true of a draft that waits on a defaults review, given the snapshot fetched for the
 * review. Only one of them may say the defaults "have changed" and that the change was refused: the draft that was SENT and refused.
 *
 *  1. `never_fetched`: nothing was captured (no record, or a context this format cannot read): "review before sending".
 *  2. `changed_rejected`: the draft was sent and the server answered `defaults_changed` (it is `in_flight` with the block).
 *  3. `review_unchanged`: queued, never sent, and the revision is unchanged (a captured household the device could not see).
 *  4. `changed_never_sent`: queued, never sent, and the revision now differs.
 */
export type DefaultsReviewCase =
  | "never_fetched"
  | "changed_rejected"
  | "review_unchanged"
  | "changed_never_sent";

export function defaultsReviewCase(
  draft: Pick<DraftRow, "status" | "defaults_revision" | "defaults_context">,
  current: SharingSnapshot,
): DefaultsReviewCase {
  if (draft.status === "in_flight") return "changed_rejected";
  const context = parseDefaultsContext(draft.defaults_context);
  if (context === null || draft.defaults_revision === null)
    return "never_fetched";
  return context.revision === current.defaults.revision
    ? "review_unchanged"
    : "changed_never_sent";
}

/**
 * The kinds a review covers: EVERY kind the draft consumes, that is, every kind its captured context holds AND every kind its block names
 * (WEB-04 §5.7: each consumed template is reviewed; WEB-12a R3). A block may name only some of them (`captureDefaults` blocks only the
 * kinds whose household nobody here has seen, and a server refusal names none), but the confirmation replaces the draft's revision of
 * ALL the defaults, so a kind whose audience was known at capture may have changed too and is reviewed with the others. Never inferred
 * unchanged. In `TEMPLATE_KINDS` order.
 */
export function reviewKinds(
  draft: Pick<DraftRow, "review_block" | "defaults_context">,
): TemplateKind[] {
  const context = parseDefaultsContext(draft.defaults_context);
  const consumed = new Set<string>([
    ...(draft.review_block?.kinds ?? []),
    ...(context === null ? [] : Object.keys(context.kinds)),
  ]);
  return TEMPLATE_KINDS.filter((kind) => consumed.has(kind));
}
