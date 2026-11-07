import { isUuid, type SnapshotHousehold } from "../../../data";
import type { Invitation, ManagementCommand } from "../api";

/**
 * WEB-12b's household model (plan §4.1). PURE: no browser, no clock, no React.
 *
 * Every `200` body is validated strictly against the pinned contract (`0.31.0-rc.1`) before it is used: exact keys, bounds, patterns and
 * enums. A body that is not the contract's answer is `null`, which the caller treats as an uncertain answer, never as an empty list.
 *
 * The command builders name the counter each command is guarded by (SHARE-9): a household's own `version` (rename, invite, remove, role),
 * an invitation's `version` (respond, revoke), and the B5 record's `preferences_version` (the main household). They are three counters,
 * moved by different things, and none of them may stand in for another.
 */
export type HouseholdRole = "manager" | "member";

export type SentStatus =
  | "pending"
  | "accepted"
  | "declined"
  | "revoked"
  | "expired";
/** One household invitation this account sent (`GET /invitations/sent`, Q16): durable, every status, no age limit. */
export interface SentInvitation {
  id: string;
  household_id: string;
  household_name: string;
  sender_id: string;
  recipient_id: string;
  recipient_username: string;
  status: SentStatus;
  expires_at: string;
  version: number;
}
export interface SentPage {
  items: SentInvitation[];
  next_after: string | null;
}
/** An active signup invitation (`GET /account-invitations`): issued by you or for a household you manage. No token, no issuer. */
export interface AccountInvitationSummary {
  id: string;
  household_id: string | null;
  expires_at: string;
}
/** A signup invitation just issued (`POST /account-invitations`): the token is shown ONCE and never kept anywhere but page memory. */
export interface IssuedInvitation {
  id: string;
  token: string;
  expires_at: string;
}

type Obj = Record<string, unknown>;
const isObject = (value: unknown): value is Obj =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const keysAre = (value: Obj, keys: readonly string[]) =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const isInt = (value: unknown, min: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min;
const isDateTime = (value: unknown): value is string =>
  typeof value === "string" && !Number.isNaN(Date.parse(value));
const TOKEN = /^[0-9a-f]{64}$/;

export const SENT_STATUSES: readonly SentStatus[] = [
  "pending",
  "accepted",
  "declined",
  "revoked",
  "expired",
];
const SENT_KEYS = [
  "id",
  "household_id",
  "household_name",
  "sender_id",
  "recipient_id",
  "recipient_username",
  "status",
  "expires_at",
  "version",
] as const;
export const SENT_PAGE_LIMIT = 200;

export function parseSentPage(body: unknown): SentPage | null {
  if (!isObject(body) || !keysAre(body, ["items", "next_after"])) return null;
  const { items, next_after } = body;
  if (!Array.isArray(items) || items.length > SENT_PAGE_LIMIT) return null;
  if (next_after !== null && !isUuid(next_after)) return null;
  const out: SentInvitation[] = [];
  for (const item of items) {
    if (!isObject(item) || !keysAre(item, SENT_KEYS)) return null;
    if (
      !isUuid(item.id) ||
      !isUuid(item.household_id) ||
      !isUuid(item.sender_id) ||
      !isUuid(item.recipient_id) ||
      typeof item.household_name !== "string" ||
      typeof item.recipient_username !== "string" ||
      !SENT_STATUSES.includes(item.status as SentStatus) ||
      !isDateTime(item.expires_at) ||
      !isInt(item.version, 1)
    )
      return null;
    out.push({
      id: item.id,
      household_id: item.household_id,
      household_name: item.household_name,
      sender_id: item.sender_id,
      recipient_id: item.recipient_id,
      recipient_username: item.recipient_username,
      status: item.status as SentStatus,
      expires_at: item.expires_at,
      version: item.version,
    });
  }
  return { items: out, next_after };
}

export function parseAccountInvitations(
  body: unknown,
): AccountInvitationSummary[] | null {
  if (!isObject(body) || !keysAre(body, ["invitations"])) return null;
  const { invitations } = body;
  if (!Array.isArray(invitations)) return null;
  const out: AccountInvitationSummary[] = [];
  for (const item of invitations) {
    if (!isObject(item) || !keysAre(item, ["id", "household_id", "expires_at"]))
      return null;
    if (
      !isUuid(item.id) ||
      (item.household_id !== null && !isUuid(item.household_id)) ||
      !isDateTime(item.expires_at)
    )
      return null;
    out.push({
      id: item.id,
      household_id: item.household_id,
      expires_at: item.expires_at,
    });
  }
  return out;
}

export function parseIssued(body: unknown): IssuedInvitation | null {
  if (!isObject(body) || !keysAre(body, ["id", "token", "expires_at"]))
    return null;
  if (
    !isUuid(body.id) ||
    typeof body.token !== "string" ||
    !TOKEN.test(body.token) ||
    !isDateTime(body.expires_at)
  )
    return null;
  return { id: body.id, token: body.token, expires_at: body.expires_at };
}

/** The redemption path WEB-08b serves (`/join#t=…`). */
export const JOIN_PATH = "/join";

/**
 * The link a signup invitation is delivered as (R7): the token in the FRAGMENT, which a browser never sends to a server (so it never
 * reaches access logs, proxies or `Referer`), never in a query string. Refuses anything but a contract token.
 */
export function signupLink(origin: string, token: string): string {
  if (!TOKEN.test(token)) throw new Error("not a signup token");
  return `${origin}${JOIN_PATH}#t=${token}`;
}

/** Whether `accountId` is the household's ONLY manager (SHARE-6: they can neither leave nor be demoted). */
export function lastManager(h: SnapshotHousehold, accountId: string): boolean {
  const managers = h.members.filter((m) => m.role === "manager");
  return managers.length === 1 && managers[0]?.account_id === accountId;
}

/** Whether the household has a single member (who is then its only manager, so it can never be left: `last_manager`). */
export const soleMember = (h: SnapshotHousehold): boolean =>
  h.members.length <= 1;

/** A name as the person would recognise it: trimmed, NFC, case-folded. */
const folded = (name: string) => name.trim().normalize("NFC").toLowerCase();
export const sameName = (a: string, b: string): boolean =>
  folded(a) === folded(b);

/** The length the contract counts (code points of the trimmed name): a valid household name has 1 to 300. */
export const nameLength = (name: string): number => [...name.trim()].length;
export const validName = (name: string): boolean => {
  const n = nameLength(name);
  return n >= 1 && n <= 300;
};

/**
 * Why an invite was refused with `conflict`, from a read made AFTER the refusal: already a member, already invited by you and still
 * waiting, or (anything else) the household changed and the invite can be tried again.
 */
export function conflictCause(
  after: {
    household: SnapshotHousehold | null;
    sent: readonly SentInvitation[];
  },
  recipientId: string,
  householdId: string,
): "member" | "invited" | "changed" {
  if (after.household?.members.some((m) => m.account_id === recipientId))
    return "member";
  if (
    after.sent.some(
      (s) =>
        s.household_id === householdId &&
        s.recipient_id === recipientId &&
        s.status === "pending",
    )
  )
    return "invited";
  return "changed";
}

/** Whole days left until `expiresAt` (rounded up; 0 once it has passed), or null when it is not a time. */
export function daysLeft(expiresAt: string, now: number): number | null {
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.ceil((at - now) / 86_400_000));
}

/** The command builders (SHARE-9: each names its counter). */
export const cmd = {
  create: (id: string, name: string): ManagementCommand => ({
    kind: "create_household",
    id,
    name: name.trim(),
  }),
  /** Household version. */
  rename: (h: SnapshotHousehold, name: string): ManagementCommand => ({
    kind: "rename_household",
    id: h.id,
    name: name.trim(),
    expected_version: h.version,
  }),
  /** Household version. */
  invite: (
    id: string,
    h: SnapshotHousehold,
    recipientId: string,
  ): ManagementCommand => ({
    kind: "invite_to_household",
    id,
    household_id: h.id,
    recipient_id: recipientId,
    expected_version: h.version,
  }),
  /** The INVITATION's version, never the household's. */
  respond: (invitation: Invitation, accept: boolean): ManagementCommand => ({
    kind: "respond_to_household_invitation",
    id: invitation.id,
    expected_version: invitation.version,
    accept,
  }),
  /** Household version (self: leave). */
  remove: (h: SnapshotHousehold, accountId: string): ManagementCommand => ({
    kind: "remove_household_member",
    household_id: h.id,
    account_id: accountId,
    expected_version: h.version,
  }),
  /** Household version. */
  setRole: (
    h: SnapshotHousehold,
    accountId: string,
    manager: boolean,
  ): ManagementCommand => ({
    kind: "set_household_role",
    household_id: h.id,
    account_id: accountId,
    expected_version: h.version,
    manager,
  }),
  /** The B5 record's `preferences_version`, never a household's. */
  setPrimary: (
    householdId: string | null,
    preferencesVersion: number,
  ): ManagementCommand => ({
    kind: "set_primary_household",
    household_id: householdId,
    expected_version: preferencesVersion,
  }),
  /** The sent invitation's own version. */
  revoke: (sent: SentInvitation): ManagementCommand => ({
    kind: "revoke_household_invitation",
    id: sent.id,
    expected_version: sent.version,
  }),
};

/** The households grouped by household id in their first-seen order, for the header-level "Sent by you" (households you left too). */
export function groupByHousehold(
  sent: readonly SentInvitation[],
): Array<{ householdId: string; name: string; items: SentInvitation[] }> {
  const groups = new Map<
    string,
    { householdId: string; name: string; items: SentInvitation[] }
  >();
  for (const s of sent) {
    let group = groups.get(s.household_id);
    if (group === undefined) {
      group = {
        householdId: s.household_id,
        name: s.household_name,
        items: [],
      };
      groups.set(s.household_id, group);
    }
    group.items.push(s);
  }
  return [...groups.values()];
}

/** The households sorted by name (the implicit selection's order), main household first only where the caller asks. */
export const byName = (a: SnapshotHousehold, b: SnapshotHousehold): number =>
  a.name.localeCompare(b.name, "en-GB") || a.id.localeCompare(b.id);

// ---- form recovery readiness (Q4; D-12b-15) ----------------------------------------------------------------------------------------
/**
 * The three household forms' page-memory draft keys (D-12b-15). Their app-update recovery (WEB-12b merge correction M-1,
 * `form-recovery.ts`) uses WEB-14a's own contexts and the validators below: values only, a name or a username, never a token (a signup
 * link is a credential and is never a recovery value). Restoring NEVER submits: the restored value is shown in its form, and sending stays
 * the person's act. A value that is not a valid input restores nothing.
 */
export const formContext = {
  create: (): string => "households:new",
  rename: (householdId: string): string => `households:rename:${householdId}`,
  invite: (householdId: string): string => `households:invite:${householdId}`,
} as const;
export const nameRecoveryValues = (name: string): Record<string, string> => ({
  name,
});
export function restoreName(
  values: Readonly<Record<string, string>>,
): string | null {
  const name = values.name;
  return typeof name === "string" && [...name].length <= 300 ? name : null;
}
export const usernameRecoveryValues = (
  username: string,
): Record<string, string> => ({ username });
export function restoreUsername(
  values: Readonly<Record<string, string>>,
): string | null {
  const username = values.username;
  return typeof username === "string" && username.length <= 100
    ? username
    : null;
}
