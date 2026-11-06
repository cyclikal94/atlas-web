import type { SnapshotHousehold } from "../../../src/data";
import type {
  DirectoryEntry,
  Invitation,
  ManagementCommand,
  SharingResult,
} from "../../../src/features/sharing/api";
import type {
  HouseholdApi,
  HouseholdResult,
} from "../../../src/features/sharing/households/api";
import type {
  AccountInvitationSummary,
  IssuedInvitation,
  SentInvitation,
  SentPage,
} from "../../../src/features/sharing/households/model";

/**
 * A scriptable double of WEB-12b's `HouseholdApi` for the component tests. Every call is recorded (with its key and body for a command),
 * and each answer comes from a queue per operation, else a default. An answer may be a function (a held answer: it resolves when the test
 * says). FIXTURE evidence: it says what the screens do with each answer, not what the server answers (the I-SH integration cases do).
 */
export type Answer<T> =
  | HouseholdResult<T>
  | (() => Promise<HouseholdResult<T>>);

export interface FakeHouseholdApi extends HouseholdApi {
  calls: Array<{ op: string; args: unknown[] }>;
  sentCommands: Array<{ key: string; commands: ManagementCommand[] }>;
  next: {
    households: Answer<SnapshotHousehold[]>[];
    invitations: Answer<Invitation[]>[];
    sent: Answer<SentPage>[];
    command: Answer<{ revision: number }>[];
    signupList: Answer<AccountInvitationSummary[]>[];
    signupIssue: Answer<IssuedInvitation>[];
    signupRevoke: Answer<true>[];
    browse: Answer<DirectoryEntry[]>[];
    lookup: Answer<DirectoryEntry[]>[];
  };
  defaults: {
    households: SharingResult<SnapshotHousehold[]>;
    invitations: SharingResult<Invitation[]>;
    sent: (after: string | undefined) => SharingResult<SentPage>;
    command: HouseholdResult<{ revision: number }> | null;
    signupList: SharingResult<AccountInvitationSummary[]>;
    signupIssue: () => HouseholdResult<IssuedInvitation>;
    browse: SharingResult<DirectoryEntry[]>;
    lookup: (username: string) => SharingResult<DirectoryEntry[]>;
  };
  count(op: string): number;
}

export const ok = <T>(value: T): SharingResult<T> => ({ ok: true, value });

export function fakeHouseholdApi(): FakeHouseholdApi {
  let revision = 100;
  let issued = 0;
  const take = async <T>(
    queue: Answer<T>[],
    fallback: () => HouseholdResult<T>,
  ): Promise<HouseholdResult<T>> => {
    const next = queue.shift();
    if (next === undefined) return fallback();
    return typeof next === "function" ? next() : next;
  };
  const api: FakeHouseholdApi = {
    calls: [],
    sentCommands: [],
    next: {
      households: [],
      invitations: [],
      sent: [],
      command: [],
      signupList: [],
      signupIssue: [],
      signupRevoke: [],
      browse: [],
      lookup: [],
    },
    defaults: {
      households: ok([]),
      invitations: ok([]),
      sent: () => ok({ items: [], next_after: null }),
      command: null,
      signupList: ok([]),
      signupIssue: () => {
        issued += 1;
        return ok({
          id: `eeeeeeee-0000-4000-8000-${issued.toString(16).padStart(12, "0")}`,
          token: issued.toString(16).padStart(64, "a"),
          expires_at: "2026-11-13T10:00:00Z",
        });
      },
      browse: ok([]),
      lookup: () => ok([]),
    },
    count: (op) => api.calls.filter((c) => c.op === op).length,
    async households() {
      api.calls.push({ op: "households", args: [] });
      return take(api.next.households, () => api.defaults.households) as never;
    },
    async invitations() {
      api.calls.push({ op: "invitations", args: [] });
      return take(
        api.next.invitations,
        () => api.defaults.invitations,
      ) as never;
    },
    async sent(after) {
      api.calls.push({ op: "sent", args: [after] });
      return take(api.next.sent, () => api.defaults.sent(after)) as never;
    },
    async command(commands, key) {
      api.calls.push({ op: "command", args: [commands, key] });
      api.sentCommands.push({ key, commands: structuredClone([...commands]) });
      revision += 1;
      return take(
        api.next.command,
        () => api.defaults.command ?? ok({ revision }),
      );
    },
    async signupList() {
      api.calls.push({ op: "signupList", args: [] });
      return take(api.next.signupList, () => api.defaults.signupList) as never;
    },
    async signupIssue(householdId) {
      api.calls.push({ op: "signupIssue", args: [householdId] });
      return take(api.next.signupIssue, api.defaults.signupIssue);
    },
    async signupRevoke(id) {
      api.calls.push({ op: "signupRevoke", args: [id] });
      return take(api.next.signupRevoke, () => ok(true as const)) as never;
    },
    async browse() {
      api.calls.push({ op: "browse", args: [] });
      return take(api.next.browse, () => api.defaults.browse) as never;
    },
    async lookup(username) {
      api.calls.push({ op: "lookup", args: [username] });
      return take(api.next.lookup, () =>
        api.defaults.lookup(username),
      ) as never;
    },
  };
  return api;
}

/** A held answer: `answer` is the promise to queue, `release(value)` settles it. */
export function held<T>(): {
  answer: () => Promise<HouseholdResult<T>>;
  release(value: HouseholdResult<T>): void;
  asked: () => boolean;
} {
  let resolve: (value: HouseholdResult<T>) => void = () => undefined;
  let asked = false;
  const promise = new Promise<HouseholdResult<T>>((r) => {
    resolve = r;
  });
  return {
    answer: () => {
      asked = true;
      return promise;
    },
    release: (value) => resolve(value),
    asked: () => asked,
  };
}

export function sentRow(
  over: Partial<SentInvitation> & { id: string },
): SentInvitation {
  return {
    household_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    household_name: "Home",
    sender_id: "11111111-1111-4111-8111-111111111111",
    recipient_id: "44444444-4444-4444-8444-444444444444",
    recipient_username: "jamie",
    status: "pending",
    expires_at: "2026-11-13T10:00:00Z",
    version: 1,
    ...over,
  };
}
