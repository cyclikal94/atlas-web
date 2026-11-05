import type { SnapshotHousehold } from "../../../data";
import type { Projection } from "../api";
import { parseProjection } from "../api";
import type { LinkageState } from "./linkage";
import type { PersonSummary } from "./summary";

/**
 * WEB-11b's PURE model of people link and merge requests (WF-PEOPLE-05/06) against the pinned contract (`v0.29.0-rc.1`, API 0.29.0; backend
 * `crates/core/src/people/{workflows,merging,requests}.rs`, read at `4396c99`):
 *
 *  - strict parsers of the four reads (`GET /people/requests`, `GET /people/requests/sent`, `GET /people/requests/{id}/merge-preview`,
 *    `POST /people/merge-preview`): every schema is `additionalProperties: false`, and an answer that breaks it is not shown;
 *  - the five command bodies (`request_link`, `request_merge`, `merge`, `respond_request`, `cancel_request`), one per `/people-commands`
 *    call, each canonicalised by the caller's attempt (`model/attempt.ts`);
 *  - what the screens decide from what they know: time left, who sent a request (D-11b-5), the name a merge may take (D-11b-7), the
 *    comparison's values (D-11b-6), who has to accept a merge (D-11b-8) and whether a person is a merged alias (D-11b-12).
 *
 * Nothing here reads or sends; nothing guesses what the server decides (a merge or a request is chosen by the preview's
 * `requires_approval`, expiry is the server's at the action).
 */

// ---- the contract's shapes ------------------------------------------------------------------------------------------------------
export type LinkProposal = {
  kind: "link";
  person_id: string;
  account_id: string;
  name: string;
};
export type MergeProposal = {
  kind: "merge";
  source_id: string;
  target_id: string;
  name: string;
};
export type Proposal = LinkProposal | MergeProposal;

export interface IncomingRequest {
  id: string;
  sender_id: string;
  /** Unix SECONDS. */
  expires_at: number;
  proposal: Proposal;
}

export const SENT_STATES = [
  "pending",
  "accepted",
  "declined",
  "cancelled",
  "expired",
] as const;
export type SentState = (typeof SENT_STATES)[number];

export interface SentRequest {
  id: string;
  recipient_id: string;
  recipient_username: string;
  expires_at: number;
  state: SentState;
  proposal: Proposal;
}
export interface SentPage {
  items: SentRequest[];
  next_after: string | null;
}

export interface MergeField {
  id: string;
  parent_id: string | null;
  label: string;
  version: number;
}
export interface MergePreview {
  token: string;
  source: Projection;
  target: Projection;
  fields: MergeField[];
  requires_approval: boolean;
  combines_identity_audiences: boolean;
  freezes_field_policies: boolean;
}
/** The recipient's preview: a side the recipient cannot see is `null` (its fields are omitted); `stale`: the sender's view changed. */
export interface RecipientPreview
  extends Omit<MergePreview, "source" | "target"> {
  source: Projection | null;
  target: Projection | null;
  stale: boolean;
}

// ---- strict validation -------------------------------------------------------------------------------------------------------------
type Obj = Record<string, unknown>;
const isObject = (value: unknown): value is Obj =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isUuid = (value: unknown): value is string =>
  typeof value === "string" && UUID.test(value);
const TOKEN = /^[0-9a-f]{64}$/;
const isInt = (value: unknown, min: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min;
/** Exactly these keys, no more and no fewer. */
const keysAre = (value: Obj, keys: readonly string[]): boolean => {
  const own = Object.keys(value);
  return (
    own.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
};
/** The contract's name: 1–200 characters (code points). */
const isName = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  [...value].length <= MERGE_NAME_MAX;

export const MERGE_NAME_MAX = 200;
export const INCOMING_MAX = 100;
export const SENT_PAGE_MAX = 200;
export const PREVIEW_FIELDS_MAX = 200;

export function parseProposal(value: unknown): Proposal | null {
  if (!isObject(value)) return null;
  if (value.kind === "link") {
    if (!keysAre(value, ["kind", "person_id", "account_id", "name"]))
      return null;
    if (!isUuid(value.person_id) || !isUuid(value.account_id)) return null;
    if (!isName(value.name)) return null;
    return {
      kind: "link",
      person_id: value.person_id,
      account_id: value.account_id,
      name: value.name,
    };
  }
  if (value.kind === "merge") {
    if (!keysAre(value, ["kind", "source_id", "target_id", "name"]))
      return null;
    if (!isUuid(value.source_id) || !isUuid(value.target_id)) return null;
    if (!isName(value.name)) return null;
    return {
      kind: "merge",
      source_id: value.source_id,
      target_id: value.target_id,
      name: value.name,
    };
  }
  return null;
}

function parseIncoming(value: unknown): IncomingRequest | null {
  if (
    !isObject(value) ||
    !keysAre(value, ["id", "sender_id", "expires_at", "proposal"])
  )
    return null;
  if (!isUuid(value.id) || !isUuid(value.sender_id)) return null;
  if (!isInt(value.expires_at, 0)) return null;
  const proposal = parseProposal(value.proposal);
  if (proposal === null) return null;
  return {
    id: value.id,
    sender_id: value.sender_id,
    expires_at: value.expires_at,
    proposal,
  };
}

/** `GET /people/requests` (`PeopleRequests`): at most 100 pending requests addressed to the reader. */
export function parseIncomingRequests(body: unknown): IncomingRequest[] | null {
  if (
    !isObject(body) ||
    !keysAre(body, ["items"]) ||
    !Array.isArray(body.items)
  )
    return null;
  if (body.items.length > INCOMING_MAX) return null;
  const out: IncomingRequest[] = [];
  for (const item of body.items) {
    const parsed = parseIncoming(item);
    if (parsed === null) return null;
    out.push(parsed);
  }
  return out;
}

function parseSent(value: unknown): SentRequest | null {
  if (
    !isObject(value) ||
    !keysAre(value, [
      "id",
      "recipient_id",
      "recipient_username",
      "expires_at",
      "state",
      "proposal",
    ])
  )
    return null;
  if (!isUuid(value.id) || !isUuid(value.recipient_id)) return null;
  if (typeof value.recipient_username !== "string") return null;
  if (!isInt(value.expires_at, 0)) return null;
  if (!SENT_STATES.includes(value.state as SentState)) return null;
  const proposal = parseProposal(value.proposal);
  if (proposal === null) return null;
  return {
    id: value.id,
    recipient_id: value.recipient_id,
    recipient_username: value.recipient_username,
    expires_at: value.expires_at,
    state: value.state as SentState,
    proposal,
  };
}

/** `GET /people/requests/sent` (`SentPeopleRequestPage`): one page of at most `limit` (≤ 200), in id order after the cursor. */
export function parseSentPage(
  body: unknown,
  query: { after: string | null; limit: number },
): SentPage | null {
  if (!isObject(body) || !keysAre(body, ["items", "next_after"])) return null;
  if (!Array.isArray(body.items)) return null;
  if (body.items.length > Math.min(query.limit, SENT_PAGE_MAX)) return null;
  if (body.next_after !== null && !isUuid(body.next_after)) return null;
  const items: SentRequest[] = [];
  let previous = query.after;
  for (const item of body.items) {
    const parsed = parseSent(item);
    if (parsed === null) return null;
    // The server's order (`ORDER BY id`, after the exclusive cursor): an answer out of it is not the contract's.
    if (previous !== null && parsed.id <= previous) return null;
    previous = parsed.id;
    items.push(parsed);
  }
  return { items, next_after: body.next_after };
}

function parseMergeField(value: unknown): MergeField | null {
  if (
    !isObject(value) ||
    !keysAre(value, ["id", "parent_id", "label", "version"])
  )
    return null;
  if (!isUuid(value.id)) return null;
  if (value.parent_id !== null && !isUuid(value.parent_id)) return null;
  if (typeof value.label !== "string" || !isInt(value.version, 1)) return null;
  return {
    id: value.id,
    parent_id: value.parent_id,
    label: value.label,
    version: value.version,
  };
}

const PREVIEW_KEYS = [
  "token",
  "source",
  "target",
  "fields",
  "requires_approval",
  "combines_identity_audiences",
  "freezes_field_policies",
] as const;

function parsePreviewCommon(
  body: Obj,
): Omit<MergePreview, "source" | "target"> | null {
  if (typeof body.token !== "string" || !TOKEN.test(body.token)) return null;
  if (!Array.isArray(body.fields) || body.fields.length > PREVIEW_FIELDS_MAX)
    return null;
  if (
    typeof body.requires_approval !== "boolean" ||
    typeof body.combines_identity_audiences !== "boolean" ||
    typeof body.freezes_field_policies !== "boolean"
  )
    return null;
  const fields: MergeField[] = [];
  for (const item of body.fields) {
    const parsed = parseMergeField(item);
    if (parsed === null) return null;
    fields.push(parsed);
  }
  return {
    token: body.token,
    fields,
    requires_approval: body.requires_approval,
    combines_identity_audiences: body.combines_identity_audiences,
    freezes_field_policies: body.freezes_field_policies,
  };
}

const parsePersonProjection = (value: unknown): Projection | null => {
  const parsed = parseProjection(value);
  return parsed !== null && parsed.kind === "person" ? parsed : null;
};

/** `POST /people/merge-preview` (`MergePreview`): the caller's own comparison; both people visible. */
export function parseMergePreview(body: unknown): MergePreview | null {
  if (!isObject(body) || !keysAre(body, PREVIEW_KEYS)) return null;
  const common = parsePreviewCommon(body);
  const source = parsePersonProjection(body.source);
  const target = parsePersonProjection(body.target);
  if (common === null || source === null || target === null) return null;
  return { ...common, source, target };
}

/** `GET /people/requests/{id}/merge-preview` (`RecipientMergePreview`): a side the recipient cannot see is null. */
export function parseRecipientPreview(body: unknown): RecipientPreview | null {
  if (!isObject(body) || !keysAre(body, [...PREVIEW_KEYS, "stale"]))
    return null;
  const common = parsePreviewCommon(body);
  if (common === null || typeof body.stale !== "boolean") return null;
  const source =
    body.source === null ? null : parsePersonProjection(body.source);
  const target =
    body.target === null ? null : parsePersonProjection(body.target);
  if (
    (body.source !== null && source === null) ||
    (body.target !== null && target === null)
  )
    return null;
  return { ...common, source, target, stale: body.stale };
}

// ---- the command bodies (`/people-commands`, one command per call) -------------------------------------------------------------------
export function requestLinkBody(input: {
  requestId: string;
  personId: string;
  accountId: string;
  version: number;
}) {
  return {
    command: {
      kind: "request_link",
      id: input.requestId,
      person_id: input.personId,
      account_id: input.accountId,
      expected_version: input.version,
    },
  };
}

export function requestMergeBody(input: {
  requestId: string;
  sourceId: string;
  targetId: string;
  token: string;
  name: string;
}) {
  return {
    command: {
      kind: "request_merge",
      id: input.requestId,
      source_id: input.sourceId,
      target_id: input.targetId,
      preview_token: input.token,
      name: input.name,
    },
  };
}

export function mergeBody(input: {
  sourceId: string;
  targetId: string;
  token: string;
  name: string;
}) {
  return {
    command: {
      kind: "merge",
      source_id: input.sourceId,
      target_id: input.targetId,
      preview_token: input.token,
      name: input.name,
    },
  };
}

/** An answer. The recipient's preview token is sent only when ACCEPTING A MERGE (a link accept or any decline carries none). */
export function respondBody(input: {
  requestId: string;
  accept: boolean;
  recipientToken?: string | null;
}) {
  return {
    command: {
      kind: "respond_request",
      id: input.requestId,
      accept: input.accept,
      ...(input.accept && input.recipientToken
        ? { recipient_preview_token: input.recipientToken }
        : {}),
    },
  };
}

export function cancelBody(input: { requestId: string }) {
  return { command: { kind: "cancel_request", id: input.requestId } };
}

// ---- what the screens decide -------------------------------------------------------------------------------------------------------
export type TimeLeft =
  | { kind: "days"; n: number }
  | { kind: "hours"; n: number }
  | { kind: "under_hour" }
  /** Past `expires_at` on this device's clock: the server decides expiry at the action, so the row is still shown. */
  | { kind: "due" };

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** The time left before `expiresAtSeconds` (Unix SECONDS, the contract's unit) at `nowMs` (milliseconds). */
export function timeLeft(expiresAtSeconds: number, nowMs: number): TimeLeft {
  const left = expiresAtSeconds * 1000 - nowMs;
  if (left <= 0) return { kind: "due" };
  if (left >= DAY_MS) return { kind: "days", n: Math.floor(left / DAY_MS) };
  if (left >= HOUR_MS) return { kind: "hours", n: Math.floor(left / HOUR_MS) };
  return { kind: "under_hour" };
}

/**
 * Who sent an incoming request (D-11b-5), from what this page already holds, or null: the households of the account's B5 snapshot
 * (members' usernames), then the people summaries read on this page whose owner is the sender. No other read is made (a directory listing
 * can be refused and is bounded), and an account id is never shown as a name.
 */
export function senderName(
  senderId: string,
  households: readonly SnapshotHousehold[],
  summaries: Iterable<PersonSummary>,
): string | null {
  for (const household of households)
    for (const member of household.members)
      if (member.account_id === senderId) return member.username;
  for (const summary of summaries)
    if (summary.owner.account_id === senderId) return summary.owner.username;
  return null;
}

/**
 * The name a merge may take (D-11b-7). The server checks the account-linkage rules only when the merge COMMITS (a direct `merge`, or the
 * recipient's accept): two linked identities cannot merge, and a merge with one linked identity must take that identity's current name.
 * The page checks first, on what it knows of BOTH linkages:
 *  - `both_linked`: nothing is sent;
 *  - `unknown`: a linkage is not known, so nothing is offered until it is;
 *  - `fixed`: exactly one is linked; the name is that identity's label, exactly;
 *  - `choose`: neither is linked; either visible label, the kept person's by default.
 */
export type MergeNaming =
  | { kind: "both_linked" }
  | { kind: "unknown" }
  | { kind: "fixed"; name: string }
  | { kind: "choose"; options: [string, string]; default: string };

export function mergeNaming(
  source: LinkageState,
  target: LinkageState,
  labels: { source: string; target: string },
): MergeNaming {
  if (!source.known || !target.known) return { kind: "unknown" };
  const sourceLinked = source.kind !== "unlinked";
  const targetLinked = target.kind !== "unlinked";
  if (sourceLinked && targetLinked) return { kind: "both_linked" };
  if (sourceLinked) return { kind: "fixed", name: labels.source };
  if (targetLinked) return { kind: "fixed", name: labels.target };
  return {
    kind: "choose",
    options: [labels.target, labels.source],
    default: labels.target,
  };
}

/** One row of the comparison: the person's name, then each field (its label once, a value per side or null). */
export interface ComparisonRow {
  key: string;
  label: string;
  /** Null: no such field on that side (shown "—"). `unsynced`: the preview names the field, this device does not hold it at its version. */
  source: ComparisonCell | null;
  target: ComparisonCell | null;
}
export type ComparisonCell =
  | { kind: "value"; row: Projection }
  | { kind: "unsynced" }
  | { kind: "name"; text: string };

/**
 * The comparison's rows (D-11b-6): a "Name" row from the visible people's labels, then the preview's fields, each under its side, its
 * value ONLY from a synced field row this device holds with the SAME id and a version at least the preview's (the preview carries no
 * values). A field the device does not hold at that version says so. A side the reader cannot see has no rows.
 */
export function comparisonRows(
  preview: {
    source: Projection | null;
    target: Projection | null;
    fields: readonly MergeField[];
  },
  cached: (id: string) => Projection | null,
): ComparisonRow[] {
  const rows: ComparisonRow[] = [
    {
      key: "name",
      label: "Name",
      source: preview.source
        ? { kind: "name", text: preview.source.label }
        : null,
      target: preview.target
        ? { kind: "name", text: preview.target.label }
        : null,
    },
  ];
  for (const field of preview.fields) {
    const side =
      preview.source !== null && field.parent_id === preview.source.id
        ? "source"
        : preview.target !== null && field.parent_id === preview.target.id
          ? "target"
          : null;
    if (side === null) continue;
    const row = cached(field.id);
    const cell: ComparisonCell =
      row !== null && row.kind === "field" && row.version >= field.version
        ? { kind: "value", row }
        : { kind: "unsynced" };
    rows.push({
      key: field.id,
      label: field.label,
      source: side === "source" ? cell : null,
      target: side === "target" ? cell : null,
    });
  }
  return rows;
}

const labelKey = (label: string): string => label.trim().toLocaleLowerCase();

/**
 * The field labels both sides have (trimmed, case-insensitive): the note under the table says both are kept (the server moves every field;
 * nothing is deleted). Each label once, as the kept person's field spells it.
 */
export function conflictLabels(
  fields: readonly MergeField[],
  sides: { sourceId: string; targetId: string },
): string[] {
  const source = new Set(
    fields
      .filter((field) => field.parent_id === sides.sourceId)
      .map((field) => labelKey(field.label)),
  );
  const out: string[] = [];
  const seen = new Set<string>();
  for (const field of fields) {
    if (field.parent_id !== sides.targetId) continue;
    const key = labelKey(field.label);
    if (key === "" || !source.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(field.label.trim());
  }
  return out;
}

/**
 * Who has to accept a merge that needs approval (D-11b-8): the owner of whichever side the reader does not own, from that side's summary.
 * Null when it is not known (the copy then says "the other owner").
 */
export function mergeRecipient(
  source: PersonSummary | null,
  target: PersonSummary | null,
): { username: string } | null {
  for (const summary of [source, target])
    if (summary !== null && !summary.owner.you)
      return { username: summary.owner.username };
  return null;
}

/** The canonical person a merged alias points to (D-11b-12), or null: an archived person whose value names `canonical_person_id`. */
export function isMergedAlias(row: {
  kind?: string;
  archived: boolean;
  value: unknown;
}): string | null {
  if ((row.kind !== undefined && row.kind !== "person") || !row.archived)
    return null;
  const value = row.value;
  if (!isObject(value)) return null;
  const canonical = value.canonical_person_id;
  return isUuid(canonical) ? canonical : null;
}
