import type { components } from "../../../lib/api-types";
import { charCount, LIMITS } from "./values";

/**
 * The VIEWER-SAFE SUMMARIES of API 0.29 (BE-PEOPLE-SUMMARY, finding 8 of the review of 13 October 2026; backend `docs/people.md`
 * "Viewer-safe summaries"). PURE: strict parsing of the three online reads and what the People screens say from them.
 *
 *  - `GET /people/summaries` (`PersonSummaryPage`), `GET /people/{id}/summary` (`PersonSummaryDetail`) and
 *    `GET /people/{id}/field-audiences` (`FieldAudiencePage`) are validated EXACTLY (every schema is `additionalProperties: false`), and the
 *    contract's own consistency rules are checked too (a partial audience carries no counts; only the owner gets a complete one; a page is
 *    in ascending id order after its cursor). An answer that breaks them is not shown: a TypeScript type is not validation.
 *  - Disclosure is never widened. A `partial` summary says only what the reader may know (the owner, the reader's own direct grant, the
 *    households the reader belongs to) and that the owner may have shared it more widely; it is never "Only you". Household size is never
 *    an audience count. A field's own sharing is an upper bound on who can see it; `effective` counts are shown only when `complete`.
 *  - Attribution is separate from ownership: "Added by you" only for `yes`; `unknown` makes no claim (product decisions of 14 October).
 */
type Schemas = components["schemas"];
export type AudienceSummary = Schemas["AudienceSummary"];
export type HouseholdAudience = Schemas["HouseholdAudience"];
export type SharedHousehold = Schemas["SharedHousehold"];
export type SharedWith = Schemas["SharedWith"];
export type SummaryOwner = Schemas["SummaryOwner"];
export type PersonSummary = Schemas["PersonSummary"];
export type FieldAudience = Schemas["FieldAudience"];
export type FieldEffectiveAccess = Schemas["FieldEffectiveAccess"];
export type PeopleHome = Schemas["PeopleHome"];
export type PersonSummaryDetail = Schemas["PersonSummaryDetail"];

/** `scope` of `GET /people/summaries`, evaluated by the server over the reader's WHOLE visible set before pagination. */
export type SummaryScope = "all" | "in_home" | "shared_with_me" | "not_linked";

/** One page of a summary read: its items, the cursor of the next, and the snapshot's primary household and preferences version. */
export interface SummaryPage<Item> {
  items: Item[];
  next_after: string | null;
  home: PeopleHome | null;
  preferences_version: number;
}

// ---- strict validation -------------------------------------------------------------------------------------------------------------
type Obj = Record<string, unknown>;
const isObject = (value: unknown): value is Obj =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isUuid = (value: unknown): value is string =>
  typeof value === "string" && UUID.test(value);
const isInt = (value: unknown, min: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min;
const isBool = (value: unknown): value is boolean => typeof value === "boolean";
/** 1..300 characters as the server counts them (`label.chars().count()`), not UTF-16 code units: 200 emoji are a valid label. */
const isLabel = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length >= 1 &&
  charCount(value) <= LIMITS.label;
const isName = (value: unknown): value is string =>
  typeof value === "string" && value.length >= 1;
/** Exactly these keys: none missing, none added. */
const exactly = (value: Obj, keys: readonly string[]): boolean => {
  const own = Object.keys(value);
  return (
    own.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
};
const oneOf = <T extends string>(
  value: unknown,
  values: readonly T[],
): value is T =>
  typeof value === "string" && (values as readonly string[]).includes(value);
const list = <T>(
  value: unknown,
  max: number,
  parse: (item: unknown) => T | null,
): T[] | null => {
  if (!Array.isArray(value) || value.length > max) return null;
  const out: T[] = [];
  for (const item of value) {
    const parsed = parse(item);
    if (parsed === null) return null;
    out.push(parsed);
  }
  return out;
};

function parseHousehold(value: unknown): HouseholdAudience | null {
  if (
    !isObject(value) ||
    !exactly(value, [
      "id",
      "can_edit",
      "you_are_member",
      "name",
      "version",
      "member_count",
    ])
  )
    return null;
  const { id, can_edit, you_are_member, name, version, member_count } = value;
  if (!isUuid(id) || !isBool(can_edit) || !isBool(you_are_member)) return null;
  // A household the reader is not in is redacted whole: its name, version and size are all null, or none is.
  const redacted = name === null && version === null && member_count === null;
  if (
    !redacted &&
    !(isLabel(name) && isInt(version, 1) && isInt(member_count, 1))
  )
    return null;
  return {
    id,
    can_edit,
    you_are_member,
    name,
    version,
    member_count,
  } as HouseholdAudience;
}

function parseSharedHousehold(value: unknown): SharedHousehold | null {
  if (!isObject(value) || !Object.hasOwn(value, "members")) return null;
  const { members, ...rest } = value;
  const household = parseHousehold(rest);
  if (household === null) return null;
  if (members === null) return { ...household, members: null };
  const parsed = list(members, 1000, (item) =>
    isObject(item) &&
    exactly(item, ["account_id", "username", "excluded"]) &&
    isUuid(item.account_id) &&
    isName(item.username) &&
    isBool(item.excluded)
      ? {
          account_id: item.account_id,
          username: item.username,
          excluded: item.excluded,
        }
      : null,
  );
  return parsed === null ? null : { ...household, members: parsed };
}

export function parseAudience(value: unknown): AudienceSummary | null {
  if (
    !isObject(value) ||
    !exactly(value, [
      "disclosure",
      "in_home",
      "households",
      "your_direct_grant",
      "direct_grant_count",
      "excluded_count",
    ])
  )
    return null;
  const {
    disclosure,
    in_home,
    your_direct_grant,
    direct_grant_count,
    excluded_count,
  } = value;
  if (!oneOf(disclosure, ["complete", "partial"] as const) || !isBool(in_home))
    return null;
  const households = list(value.households, 100, parseHousehold);
  if (households === null) return null;
  let grant: { can_edit: boolean } | null = null;
  if (your_direct_grant !== null) {
    if (
      !isObject(your_direct_grant) ||
      !exactly(your_direct_grant, ["can_edit"]) ||
      !isBool(your_direct_grant.can_edit)
    )
      return null;
    grant = { can_edit: your_direct_grant.can_edit };
  }
  if (disclosure === "complete") {
    // The owner's own: every count, and never a "direct grant" to themselves.
    if (
      !isInt(direct_grant_count, 0) ||
      !isInt(excluded_count, 0) ||
      grant !== null
    )
      return null;
  } else if (direct_grant_count !== null || excluded_count !== null)
    return null;
  return {
    disclosure,
    in_home,
    households,
    your_direct_grant: grant,
    direct_grant_count: direct_grant_count as number | null,
    excluded_count: excluded_count as number | null,
  };
}

function parseOwner(value: unknown): SummaryOwner | null {
  if (
    !isObject(value) ||
    !exactly(value, ["account_id", "username", "you", "person"])
  )
    return null;
  const { account_id, username, you, person } = value;
  if (!isUuid(account_id) || !isName(username) || !isBool(you)) return null;
  if (person === null) return { account_id, username, you, person: null };
  if (
    !isObject(person) ||
    !exactly(person, ["id", "label"]) ||
    !isUuid(person.id) ||
    !isLabel(person.label)
  )
    return null;
  return {
    account_id,
    username,
    you,
    person: { id: person.id, label: person.label },
  };
}

function parseHome(value: unknown): PeopleHome | null | undefined {
  if (value === null) return null;
  if (
    !isObject(value) ||
    !exactly(value, ["id", "name", "version", "member_count"]) ||
    !isUuid(value.id) ||
    !isLabel(value.name) ||
    !isInt(value.version, 1) ||
    !isInt(value.member_count, 1)
  )
    return undefined;
  return {
    id: value.id,
    name: value.name,
    version: value.version,
    member_count: value.member_count,
  };
}

export function parsePersonSummary(value: unknown): PersonSummary | null {
  if (
    !isObject(value) ||
    !exactly(value, [
      "id",
      "label",
      "version",
      "policy_version",
      "archived",
      "linkage",
      "linked_account_id",
      "owner",
      "added_by_you",
      "your_access",
      "field_count",
      "audience",
    ])
  )
    return null;
  const {
    id,
    label,
    version,
    policy_version,
    archived,
    linkage,
    linked_account_id,
  } = value;
  if (
    !isUuid(id) ||
    !isLabel(label) ||
    !isInt(version, 1) ||
    !isInt(policy_version, 1)
  )
    return null;
  if (!isBool(archived) || !oneOf(linkage, ["you", "other", "none"] as const))
    return null;
  // Linked: to an account; not linked: to none.
  if (
    linkage === "none" ? linked_account_id !== null : !isUuid(linked_account_id)
  )
    return null;
  const owner = parseOwner(value.owner);
  const audience = parseAudience(value.audience);
  if (owner === null || audience === null) return null;
  if (!oneOf(value.added_by_you, ["yes", "no", "unknown"] as const))
    return null;
  if (!oneOf(value.your_access, ["owner", "edit", "view"] as const))
    return null;
  if (!isInt(value.field_count, 0)) return null;
  // Only the owner owns it, and only the owner sees its complete audience.
  if ((value.your_access === "owner") !== owner.you) return null;
  if ((audience.disclosure === "complete") !== owner.you) return null;
  return {
    id,
    label,
    version,
    policy_version,
    archived,
    linkage,
    linked_account_id: linked_account_id as string | null,
    owner,
    added_by_you: value.added_by_you,
    your_access: value.your_access,
    field_count: value.field_count,
    audience,
  };
}

export function parseSharedWith(value: unknown): SharedWith | null {
  if (
    !isObject(value) ||
    !exactly(value, [
      "disclosure",
      "owner",
      "accounts",
      "households",
      "excluded_accounts",
    ])
  )
    return null;
  const { disclosure } = value;
  if (!oneOf(disclosure, ["complete", "partial"] as const)) return null;
  const owner = parseOwner(value.owner);
  const accounts = list(value.accounts, 200, (item) =>
    isObject(item) &&
    exactly(item, ["account_id", "username", "can_edit"]) &&
    isUuid(item.account_id) &&
    isName(item.username) &&
    isBool(item.can_edit)
      ? {
          account_id: item.account_id,
          username: item.username,
          can_edit: item.can_edit,
        }
      : null,
  );
  const households = list(value.households, 100, parseSharedHousehold);
  if (owner === null || accounts === null || households === null) return null;
  let excluded: { account_id: string; username: string }[] | null = null;
  if (value.excluded_accounts !== null) {
    excluded = list(value.excluded_accounts, 200, (item) =>
      isObject(item) &&
      exactly(item, ["account_id", "username"]) &&
      isUuid(item.account_id) &&
      isName(item.username)
        ? { account_id: item.account_id, username: item.username }
        : null,
    );
    if (excluded === null) return null;
  }
  // A partial rail never expands a household or names an exclusion; the complete one is the owner's.
  if (disclosure === "partial") {
    if (excluded !== null || households.some((h) => h.members !== null))
      return null;
    if (owner.you) return null;
  } else if (excluded === null || !owner.you) return null;
  return {
    disclosure,
    owner,
    accounts,
    households,
    excluded_accounts: excluded,
  };
}

export function parseFieldAudience(value: unknown): FieldAudience | null {
  if (
    !isObject(value) ||
    !exactly(value, [
      "id",
      "version",
      "policy_version",
      "archived",
      "owner_is_you",
      "your_access",
      "audience",
      "effective",
    ])
  )
    return null;
  const {
    id,
    version,
    policy_version,
    archived,
    owner_is_you,
    your_access,
    effective,
  } = value;
  if (!isUuid(id) || !isInt(version, 1) || !isInt(policy_version, 1))
    return null;
  if (!isBool(archived) || !isBool(owner_is_you)) return null;
  if (!oneOf(your_access, ["owner", "edit", "view"] as const)) return null;
  const audience = parseAudience(value.audience);
  if (audience === null) return null;
  if (
    !isObject(effective) ||
    !exactly(effective, ["disclosure", "account_count", "limited_count"])
  )
    return null;
  const { disclosure, account_count, limited_count } = effective;
  if (!oneOf(disclosure, ["complete", "partial"] as const)) return null;
  if (disclosure === "complete") {
    if (!isInt(account_count, 0) || !isInt(limited_count, 0) || !owner_is_you)
      return null;
  } else if (account_count !== null || limited_count !== null) return null;
  if ((your_access === "owner") !== owner_is_you) return null;
  if ((audience.disclosure === "complete") !== owner_is_you) return null;
  return {
    id,
    version,
    policy_version,
    archived,
    owner_is_you,
    your_access,
    audience,
    effective: {
      disclosure,
      account_count: account_count as number | null,
      limited_count: limited_count as number | null,
    },
  };
}

/**
 * A page of `parse` items read after `after` with `limit`: in strictly ascending id order after the cursor (the contract's order, which
 * the screens' id-ordered steps and joins rely on), the cursor of the next page being the last id or null, and every item of the asked
 * `archived` state. Null when anything is off.
 */
export function parseSummaryPage<
  Item extends { id: string; archived: boolean },
>(
  body: unknown,
  query: { after: string | null; limit: number; archived: boolean },
  parse: (value: unknown) => Item | null,
): SummaryPage<Item> | null {
  if (
    !isObject(body) ||
    !exactly(body, ["items", "next_after", "home", "preferences_version"])
  )
    return null;
  const items = list(body.items, query.limit, parse);
  const home = parseHome(body.home);
  if (
    items === null ||
    home === undefined ||
    !isInt(body.preferences_version, 1)
  )
    return null;
  let previous = query.after;
  for (const item of items) {
    if (item.archived !== query.archived) return null;
    if (previous !== null && !(item.id > previous)) return null;
    previous = item.id;
  }
  const next = body.next_after;
  if (next !== null && (!isUuid(next) || next !== items.at(-1)?.id))
    return null;
  return {
    items,
    next_after: next,
    home,
    preferences_version: body.preferences_version,
  };
}

export function parsePersonSummaryDetail(
  body: unknown,
): PersonSummaryDetail | null {
  if (
    !isObject(body) ||
    !exactly(body, ["summary", "shared_with", "home", "preferences_version"])
  )
    return null;
  const summary = parsePersonSummary(body.summary);
  const shared = parseSharedWith(body.shared_with);
  const home = parseHome(body.home);
  if (summary === null || shared === null || home === undefined) return null;
  if (!isInt(body.preferences_version, 1)) return null;
  // One snapshot: the rail and the summary name the same owner with the same disclosure.
  if (
    shared.owner.account_id !== summary.owner.account_id ||
    shared.disclosure !== summary.audience.disclosure
  )
    return null;
  return {
    summary,
    shared_with: shared,
    home,
    preferences_version: body.preferences_version,
  };
}

// ---- what the screens say ----------------------------------------------------------------------------------------------------------
/** The name the owner is shown by: their own linked person when the reader can see it, else their username. */
export const ownerName = (owner: SummaryOwner): string =>
  owner.person?.label ?? owner.username;

/** Who added the person, as the row says it: "You", "Added by you", "Shared with you by {owner}", or nothing (no claim). */
export type Attribution =
  | { kind: "you" }
  | { kind: "added_by_you" }
  | { kind: "shared_by"; owner: string }
  | { kind: "none" };

export function attributionOf(summary: PersonSummary): Attribution {
  if (summary.linkage === "you") return { kind: "you" };
  if (summary.added_by_you === "yes") return { kind: "added_by_you" };
  // Owned by another account: the reader sees it because that owner shared it. `unknown` attribution claims nothing more.
  if (!summary.owner.you)
    return { kind: "shared_by", owner: ownerName(summary.owner) };
  return { kind: "none" };
}

const role = (canEdit: boolean) => (canEdit ? "can edit" : "can view");
const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

/**
 * A resource's own sharing in a few words (a person's "Visible to", a field's tag). The owner's (`complete`) audience: "Only you", one
 * household with its role ("Home · can view"), or the counts ("2 households, 1 person"), with exclusions. Household SIZE never appears
 * here: it is not an audience count. A reader's (`partial`) audience: only what reaches the reader ("Shared from Home", "Shared with you")
 * — never "Only you", and never anything about other access.
 */
export function audienceText(audience: AudienceSummary): string {
  const households = audience.households;
  if (audience.disclosure === "partial") {
    const mine = households.filter((h) => h.you_are_member && h.name !== null);
    if (mine.length > 0)
      return `Shared from ${mine.map((h) => h.name).join(", ")}${audience.your_direct_grant ? " and with you" : ""}`;
    return "Shared with you";
  }
  const direct = audience.direct_grant_count ?? 0;
  const excluded = audience.excluded_count ?? 0;
  const tail = excluded > 0 ? ` · ${excluded} excluded` : "";
  if (households.length === 0 && direct === 0) return "Only you";
  const [only] = households;
  if (households.length === 1 && direct === 0 && only !== undefined)
    return `${only.name ?? "A household you've left"} · ${role(only.can_edit)}${tail}`;
  const parts: string[] = [];
  if (households.length > 0)
    parts.push(plural(households.length, "household", "households"));
  if (direct > 0) parts.push(plural(direct, "person", "people"));
  const mixed =
    households.length > 1 &&
    new Set(households.map((h) => h.can_edit)).size > 1;
  return `${parts.join(", ")}${mixed ? " · mixed" : ""}${tail}`;
}

/** Who can actually see a field: the counts when `complete` (owner of the field and its person, member of every named household), else null. */
export function effectiveText(
  effective: FieldEffectiveAccess,
  personName: string,
): string | null {
  if (effective.disclosure !== "complete" || effective.account_count === null)
    return null;
  const seeing =
    effective.account_count === 0
      ? "Nobody else can see it"
      : `${plural(effective.account_count, "other person", "other people")} can see it`;
  const limited = effective.limited_count ?? 0;
  return limited > 0
    ? `${seeing}. ${plural(limited, "person", "people")} it's shared with can't see ${personName}.`
    : `${seeing}.`;
}

/**
 * Whether a field policy this page read (or confirmed by its own change) may still name the field's audience beside its cached row
 * (review 3 of 22 October 2026, finding 3; the design assessment's C6): no LATER policy version of the field is known, neither the cached
 * row's nor one a summary applied (`floor`). A read ahead of a lagging cache is kept. PURE.
 */
export function policyShownFor(
  read: { version: number },
  cached: { policy_version?: number },
  floor: { policyVersion: number } | undefined,
): boolean {
  return (
    read.version >= (cached.policy_version ?? 0) &&
    read.version >= (floor?.policyVersion ?? 0)
  );
}

/**
 * Whether a summary row may be shown beside a cached projection: it is not OLDER than what this device shows. A newer one is the
 * server's later state (the cache catches up); an older one waits for the re-read the projection change has already asked for.
 */
export function summaryCurrentFor(
  summary: { version: number; policy_version: number },
  cached: { version: number; policy_version?: number } | null,
): boolean {
  if (cached === null) return true;
  if (summary.version < cached.version) return false;
  return (
    cached.policy_version === undefined ||
    summary.policy_version >= cached.policy_version
  );
}
