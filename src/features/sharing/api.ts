import {
  type DefaultTemplate,
  isUuid,
  type Policy,
  parseHousehold,
  parsePolicy,
  parseTemplate,
  type SnapshotHousehold,
  TEMPLATE_KINDS,
  type TemplateKind,
} from "../../data";
import { recogniseAtlasError } from "../../lib/api-client/problem";
import { type Session, StampedRequestError } from "../../session";

/**
 * The sharing endpoints of the pinned contract, for WEB-12a's editors (online-only: D-12a-1). Every call goes through the session's
 * STAMPED typed client for the displayed `(account, epoch)`; nothing here queues, and nothing reaches the network any other way (R1).
 *
 * Every answer is CLASSIFIED, never guessed from a missing body:
 *  - a refusal (`conflict`, `operation_conflict`, `last_manager`, `forbidden`, `not_found`, `gone`, `invalid`) needs an Atlas error body
 *    (`recogniseAtlasError`): a 4xx without one (a gateway page) is not the server's refusal;
 *  - `uncertain`: a network error, a time-out, a `5xx`, a `429`, a 4xx without an Atlas body, or a `200` that is not the contract's
 *    answer. For a COMMAND it may have committed: the editor offers "Try again" with the SAME key and body (D-12a-2);
 *  - `not_sent`: the session did not put the request on the wire (a hold); asked again, bounded, by `untilSent`;
 *  - `closed`: the session closed the request or the identity moved (`stale`): nothing is shown, the gate has taken over.
 *
 * A `200` body is validated strictly against the contract before it is used. TypeScript types are not validation.
 */
export type RefusalKind =
  | "conflict"
  | "operation_conflict"
  | "last_manager"
  | "forbidden"
  | "not_found"
  | "gone"
  | "invalid";

export type SharingResult<T> =
  | { ok: true; value: T }
  | { ok: false; kind: RefusalKind; requestId?: string; message?: string }
  | { ok: false; kind: "uncertain"; requestId?: string }
  | { ok: false; kind: "not_sent" | "offline" | "closed" };

export type SharingFailure = Extract<SharingResult<never>, { ok: false }>;

export interface PolicyState {
  version: number;
  policy: Policy;
}
export type TemplateScope = Record<
  TemplateKind,
  { template: DefaultTemplate | null; version: number }
>;
export interface Invitation {
  id: string;
  household_id: string;
  household_name: string;
  sender_id: string;
  status: "pending" | "accepted" | "declined" | "revoked";
  expires_at: string;
  version: number;
}
export interface DirectoryEntry {
  id: string;
  username: string;
}

export type ManagementCommand =
  | {
      kind: "replace_policy";
      id: string;
      expected_version: number;
      policy: Policy;
    }
  | {
      kind: "set_defaults";
      household_id: string | null;
      resource_kind: TemplateKind;
      expected_version: number;
      template: DefaultTemplate | null;
    }
  | { kind: "create_household"; id: string; name: string }
  | {
      kind: "invite_to_household";
      id: string;
      household_id: string;
      recipient_id: string;
      expected_version: number;
    }
  | {
      kind: "respond_to_household_invitation";
      id: string;
      expected_version: number;
      accept: boolean;
    };

export type AccessCommand =
  | {
      kind: "grant";
      id: string;
      expected_version: number;
      account_id: string;
      edit: boolean;
    }
  | {
      kind: "revoke";
      id: string;
      expected_version: number;
      account_id: string;
    };

export interface SharingApi {
  readPolicy(id: string): Promise<SharingResult<PolicyState>>;
  readTemplates(
    householdId: string | null,
  ): Promise<SharingResult<TemplateScope>>;
  readHouseholds(): Promise<SharingResult<SnapshotHousehold[]>>;
  readInvitations(): Promise<SharingResult<Invitation[]>>;
  lookup(username: string): Promise<SharingResult<DirectoryEntry[]>>;
  /** 1 to 20 commands (CH1), with an `Idempotency-Key` the caller keeps for a retry of the same body. */
  management(
    commands: readonly ManagementCommand[],
    key: string,
  ): Promise<SharingResult<{ revision: number }>>;
  access(
    commands: readonly AccessCommand[],
    key: string,
  ): Promise<SharingResult<{ revision: number }>>;
}

// ---- validation of the answers --------------------------------------------------------------------------------------------------
type Obj = Record<string, unknown>;
const isObject = (value: unknown): value is Obj =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const keysAre = (value: Obj, keys: readonly string[]) =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const isInt = (value: unknown, min: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min;

export function parsePolicyState(body: unknown): PolicyState | null {
  if (!isObject(body) || !keysAre(body, ["version", "policy"])) return null;
  if (!isInt(body.version, 1)) return null;
  const policy = parsePolicy(body.policy);
  return policy === null ? null : { version: body.version, policy };
}

export function parseTemplateScope(body: unknown): TemplateScope | null {
  if (!isObject(body) || !keysAre(body, TEMPLATE_KINDS)) return null;
  const out = {} as TemplateScope;
  for (const kind of TEMPLATE_KINDS) {
    const entry = body[kind];
    if (!isObject(entry) || !keysAre(entry, ["template", "version"]))
      return null;
    if (!isInt(entry.version, 0)) return null;
    const template =
      entry.template === null ? null : parseTemplate(entry.template);
    if (entry.template !== null && template === null) return null;
    out[kind] = { template, version: entry.version };
  }
  return out;
}

export function parseHouseholds(body: unknown): SnapshotHousehold[] | null {
  if (!Array.isArray(body) || body.length > 32) return null;
  const out: SnapshotHousehold[] = [];
  for (const item of body) {
    const household = parseHousehold(item);
    if (household === null) return null;
    out.push(household);
  }
  return out;
}

const INVITATION_STATUSES = ["pending", "accepted", "declined", "revoked"];
export function parseInvitations(body: unknown): Invitation[] | null {
  if (!Array.isArray(body) || body.length > 80) return null;
  const out: Invitation[] = [];
  for (const item of body) {
    if (
      !isObject(item) ||
      !keysAre(item, [
        "id",
        "household_id",
        "household_name",
        "sender_id",
        "status",
        "expires_at",
        "version",
      ])
    )
      return null;
    if (
      !isUuid(item.id) ||
      !isUuid(item.household_id) ||
      !isUuid(item.sender_id) ||
      typeof item.household_name !== "string" ||
      typeof item.expires_at !== "string" ||
      !INVITATION_STATUSES.includes(item.status as string) ||
      !isInt(item.version, 1)
    )
      return null;
    out.push(item as unknown as Invitation);
  }
  return out;
}

export function parseDirectory(body: unknown): DirectoryEntry[] | null {
  if (!Array.isArray(body) || body.length > 100) return null;
  const out: DirectoryEntry[] = [];
  for (const item of body) {
    if (!isObject(item) || !keysAre(item, ["id", "username"])) return null;
    if (!isUuid(item.id) || typeof item.username !== "string") return null;
    out.push({ id: item.id, username: item.username });
  }
  return out;
}

export function parseReceipt(body: unknown): { revision: number } | null {
  if (!isObject(body) || !keysAre(body, ["revision"])) return null;
  return isInt(body.revision, 1) ? { revision: body.revision } : null;
}

// ---- classification ---------------------------------------------------------------------------------------------------------------
const REFUSAL_CODES: Readonly<Record<string, RefusalKind>> = {
  conflict: "conflict",
  operation_conflict: "operation_conflict",
  last_manager: "last_manager",
  invitation_expired: "gone",
};
const BY_STATUS: Readonly<Record<number, RefusalKind>> = {
  400: "invalid",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  410: "gone",
  422: "invalid",
};

/** What a response that is not `2xx` means. */
export function classifyAnswer(
  status: number,
  contentType: string | null,
  body: unknown,
): SharingFailure {
  const atlas = recogniseAtlasError(contentType, body);
  if (status === 401) return { ok: false, kind: "closed" };
  if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
    // A 4xx is the server's refusal only with its own error body; a gateway page is not an answer about the command.
    if (atlas === null) return { ok: false, kind: "uncertain" };
    const kind = REFUSAL_CODES[atlas.code] ?? BY_STATUS[status] ?? "invalid";
    return {
      ok: false,
      kind,
      requestId: atlas.request_id,
      message: atlas.message,
    };
  }
  return atlas === null
    ? { ok: false, kind: "uncertain" }
    : { ok: false, kind: "uncertain", requestId: atlas.request_id };
}

/** What a call that threw means: the session's closed set, else a network error, an abort or a time-out. */
export function classifyThrown(error: unknown): SharingFailure {
  if (error instanceof StampedRequestError) {
    switch (error.kind) {
      case "not_sent":
      case "not_covered":
        return { ok: false, kind: "not_sent" };
      case "stale":
      case "closed":
      case "closed_unresolved":
      case "auth_state":
        return { ok: false, kind: "closed" };
    }
  }
  return { ok: false, kind: "uncertain" };
}

interface Answered {
  data?: unknown;
  error?: unknown;
  response: Response;
}

async function call<T>(
  run: () => Promise<Answered>,
  parse: (body: unknown) => T | null,
): Promise<SharingResult<T>> {
  try {
    const { data, error, response } = await run();
    if (response.ok) {
      const value = parse(data);
      return value === null
        ? { ok: false, kind: "uncertain" }
        : { ok: true, value };
    }
    return classifyAnswer(
      response.status,
      response.headers.get("content-type"),
      error,
    );
  } catch (error) {
    return classifyThrown(error);
  }
}

const NOT_SENT_DELAYS_MS: readonly number[] = [50, 100, 200, 400, 800, 1_000];

/**
 * `not_sent` means the session held the request back for a moment (nothing was sent, nothing counted): the stamped-call contract says
 * the caller makes the same call again, so it is asked again quietly, a bounded number of times, and only then reported.
 */
export async function untilSent<T>(
  call: () => Promise<SharingResult<T>>,
  options: {
    isCurrent?: () => boolean;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<SharingResult<T>> {
  const isCurrent = options.isCurrent ?? (() => true);
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; ; attempt += 1) {
    const result = await call();
    if (result.ok || result.kind !== "not_sent") return result;
    const delay = NOT_SENT_DELAYS_MS[attempt];
    if (delay === undefined || !isCurrent()) return result;
    await sleep(delay);
    if (!isCurrent()) return result;
  }
}

/**
 * The policies this page was refused (`403`), by `<account>:<resource>`, for the page's lifetime. A `403` closes the protected display
 * while the session classifies it (session matrix 3.6.2: 401 and 403 are possibly invalidating) and reopens it for an ordinary refusal,
 * which REMOUNTS the protected tree, and with it the editor that asked; a remounted editor that asked again would be refused again, and
 * so on (measured: 173 reads in three seconds). It is recorded here, outside the component (which is unmounted before it sees the
 * answer), and a later read of the same policy for the same account answers `forbidden` without a request. Only resource ids are held,
 * per account, at most 500. Ownership of a resource never moves to another account, so the answer does not go stale. A read of the same
 * policy that is still on its way when the editor is remounted is SHARED rather than made again, so the order in which the remount and the
 * first answer's continuation run cannot add a request.
 */
const refusedPolicies = new Set<string>();
const policyReads = new Map<string, Promise<SharingResult<PolicyState>>>();
const REFUSED_LIMIT = 500;
function noteRefused(key: string): void {
  refusedPolicies.delete(key);
  refusedPolicies.add(key);
  if (refusedPolicies.size > REFUSED_LIMIT) {
    const oldest = refusedPolicies.values().next().value;
    if (oldest !== undefined) refusedPolicies.delete(oldest);
  }
}
/** For tests: forget what this page was refused. */
export function forgetRefusedPolicies(): void {
  refusedPolicies.clear();
  policyReads.clear();
}

/** The production client over the session, for the displayed `(account, epoch)`. */
export function createSharingApi(
  session: Session,
  account: string,
  epoch: number,
): SharingApi {
  const client = () => session.api.client("ordinary", account, epoch);
  const offline = (): SharingResult<never> | null =>
    typeof navigator !== "undefined" && navigator.onLine === false
      ? { ok: false, kind: "offline" }
      : null;
  return {
    readPolicy: async (id) => {
      const key = `${account}:${id}`;
      if (refusedPolicies.has(key)) return { ok: false, kind: "forbidden" };
      const shared = policyReads.get(key);
      if (shared !== undefined) return shared;
      const off = offline();
      if (off !== null) return off;
      const reading = call(
        () => client().GET("/policies/{id}", { params: { path: { id } } }),
        parsePolicyState,
      ).then((result) => {
        if (!result.ok && result.kind === "forbidden") noteRefused(key);
        return result;
      });
      policyReads.set(key, reading);
      try {
        return await reading;
      } finally {
        if (policyReads.get(key) === reading) policyReads.delete(key);
      }
    },
    readTemplates: async (householdId) =>
      offline() ??
      call(
        () =>
          client().GET("/defaults/templates", {
            params: {
              query: householdId === null ? {} : { household_id: householdId },
            },
          }),
        parseTemplateScope,
      ),
    readHouseholds: async () =>
      offline() ?? call(() => client().GET("/households"), parseHouseholds),
    readInvitations: async () =>
      offline() ?? call(() => client().GET("/invitations"), parseInvitations),
    lookup: async (username) =>
      offline() ??
      call(
        () => client().GET("/directory", { params: { query: { username } } }),
        parseDirectory,
      ),
    management: async (commands, key) =>
      offline() ??
      call(
        () =>
          client().POST("/management-commands", {
            params: { header: { "Idempotency-Key": key } },
            body: { commands: [...commands] } as never,
          }),
        parseReceipt,
      ),
    access: async (commands, key) =>
      offline() ??
      call(
        () =>
          client().POST("/access-commands", {
            params: { header: { "Idempotency-Key": key } },
            body: { commands: [...commands] } as never,
          }),
        parseReceipt,
      ),
  };
}
