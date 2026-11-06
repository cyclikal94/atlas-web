import type { SnapshotHousehold } from "../../../data";
import { recogniseAtlasError } from "../../../lib/api-client/problem";
import type { Session } from "../../../session";
import {
  call,
  type DirectoryEntry,
  type Invitation,
  type ManagementCommand,
  parseDirectory,
  parseHouseholds,
  parseInvitations,
  parseReceipt,
  type RefusalKind,
  type SharingResult,
} from "../api";
import {
  type AccountInvitationSummary,
  type IssuedInvitation,
  parseAccountInvitations,
  parseIssued,
  parseSentPage,
  SENT_PAGE_LIMIT,
  type SentPage,
} from "./model";

/**
 * WEB-12b's household calls (plan §4.2), through the session's STAMPED client for the displayed `(account, epoch)`, online-only like every
 * sharing call (nothing here queues). WEB-12a's `SharingApi` and its consumers are unchanged.
 *
 * Classification (D-12b-10). Every answer is classified by WEB-12a's `classifyAnswer` EXCEPT two refusals the server raises with a status
 * the generic rule reads as "may have committed":
 *  - a household command answered `503` with the Atlas code `slice_capacity` (raised inside the rolled-back transaction: your 32
 *    households for a create or an accepted invitation, the recipient's 200 pending invitations for an invite; `messageOf` words it by
 *    the command): refusal `capacity`, nothing was made;
 *  - a signup issuance answered `429` with the Atlas code `rate_limited` (20 unredeemed per issuer, or the per-source throttle): refusal
 *    `limit`, nothing was issued.
 * Without an Atlas body, or with another code, a `429`/`5xx` stays `uncertain`.
 */
export type HouseholdRefusal = RefusalKind | "capacity" | "limit";
export type Special = {
  ok: false;
  kind: "capacity" | "limit";
  requestId?: string;
  message?: string;
};
export type HouseholdResult<T> = SharingResult<T> | Special;

export interface HouseholdApi {
  households(): Promise<SharingResult<SnapshotHousehold[]>>;
  invitations(): Promise<SharingResult<Invitation[]>>;
  /** One page of `GET /invitations/sent` (200 rows), after `after`. */
  sent(after?: string): Promise<SharingResult<SentPage>>;
  command(
    commands: readonly ManagementCommand[],
    key: string,
  ): Promise<HouseholdResult<{ revision: number }>>;
  signupList(): Promise<SharingResult<AccountInvitationSummary[]>>;
  /** Not idempotent: its caller NEVER sends it again after an uncertain answer (SHARE-7), it reads the list instead. */
  signupIssue(householdId: string): Promise<HouseholdResult<IssuedInvitation>>;
  signupRevoke(id: string): Promise<SharingResult<true>>;
  /** `GET /directory` without a query: the first 100 accounts by username, or `403` when the server's directory is disabled. */
  browse(): Promise<SharingResult<DirectoryEntry[]>>;
  /** `GET /directory?username=` (always an exact match). */
  lookup(username: string): Promise<SharingResult<DirectoryEntry[]>>;
}

/** The household-only refusal of a non-2xx answer, or null for the generic rule. */
export function classifyHousehold(
  which: "command" | "issue",
  status: number,
  contentType: string | null,
  body: unknown,
): Special | null {
  const atlas = recogniseAtlasError(contentType, body);
  if (atlas === null) return null;
  const detail = { requestId: atlas.request_id, message: atlas.message };
  if (which === "command" && status === 503 && atlas.code === "slice_capacity")
    return { ok: false, kind: "capacity", ...detail };
  if (which === "issue" && status === 429 && atlas.code === "rate_limited")
    return { ok: false, kind: "limit", ...detail };
  return null;
}

const accepted = (): true => true;

export function createHouseholdApi(
  session: Session,
  account: string,
  epoch: number,
): HouseholdApi {
  const client = () => session.api.client("ordinary", account, epoch);
  const offline = (): SharingResult<never> | null =>
    typeof navigator !== "undefined" && navigator.onLine === false
      ? { ok: false, kind: "offline" }
      : null;
  return {
    households: async () =>
      offline() ?? call(() => client().GET("/households"), parseHouseholds),
    invitations: async () =>
      offline() ?? call(() => client().GET("/invitations"), parseInvitations),
    sent: async (after) =>
      offline() ??
      call(
        () =>
          client().GET("/invitations/sent", {
            params: {
              query:
                after === undefined
                  ? { limit: SENT_PAGE_LIMIT }
                  : { after, limit: SENT_PAGE_LIMIT },
            },
          }),
        parseSentPage,
      ),
    command: async (commands, key) =>
      offline() ??
      call(
        () =>
          client().POST("/management-commands", {
            params: { header: { "Idempotency-Key": key } },
            body: { commands: [...commands] } as never,
          }),
        parseReceipt,
        (status, type, body) =>
          classifyHousehold("command", status, type, body),
      ),
    signupList: async () =>
      offline() ??
      call(() => client().GET("/account-invitations"), parseAccountInvitations),
    signupIssue: async (householdId) =>
      offline() ??
      call(
        () =>
          client().POST("/account-invitations", {
            body: { household_id: householdId },
          }),
        parseIssued,
        (status, type, body) => classifyHousehold("issue", status, type, body),
      ),
    signupRevoke: async (id) =>
      offline() ??
      call(
        () =>
          client().DELETE("/account-invitations/{id}", {
            params: { path: { id } },
          }),
        accepted,
      ),
    browse: async () =>
      offline() ?? call(() => client().GET("/directory"), parseDirectory),
    lookup: async (username) =>
      offline() ??
      call(
        () => client().GET("/directory", { params: { query: { username } } }),
        parseDirectory,
      ),
  };
}
