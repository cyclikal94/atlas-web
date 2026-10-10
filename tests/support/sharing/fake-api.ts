import type { SnapshotHousehold } from "../../../src/data";
import type {
  AccessCommand,
  DirectoryEntry,
  Invitation,
  ManagementCommand,
  PolicyState,
  SharingApi,
  SharingResult,
  TemplateScope,
} from "../../../src/features/sharing/api";
import type { SharingEnv } from "../../../src/features/sharing/env";

/**
 * A scriptable double of WEB-12a's `SharingApi` for the component tests: every call is recorded with its key and body, and each answer
 * comes from a queue per operation (or a default). FIXTURE evidence: it says what the screens do with each answer, not what the server
 * answers (the I-SH integration cases do).
 */
export type Answer<T> = SharingResult<T> | (() => Promise<SharingResult<T>>);

export interface FakeSharingApi extends SharingApi {
  calls: Array<{ op: string; args: unknown[] }>;
  sent: Array<{ key: string; commands: unknown[] }>;
  next: {
    policy: Answer<PolicyState>[];
    templates: Answer<TemplateScope>[];
    households: Answer<SnapshotHousehold[]>[];
    invitations: Answer<Invitation[]>[];
    lookup: Answer<DirectoryEntry[]>[];
    management: Answer<{ revision: number }>[];
    access: Answer<{ revision: number }>[];
  };
  defaults: {
    policy: SharingResult<PolicyState>;
    templates: (householdId: string | null) => SharingResult<TemplateScope>;
    households: SharingResult<SnapshotHousehold[]>;
    invitations: SharingResult<Invitation[]>;
    lookup: (username: string) => SharingResult<DirectoryEntry[]>;
    management: SharingResult<{ revision: number }>;
  };
}

export const ok = <T>(value: T): SharingResult<T> => ({ ok: true, value });

export const emptyScope = (): TemplateScope => ({
  person: { template: null, version: 0 },
  field: { template: null, version: 0 },
  task: { template: null, version: 0 },
  list: { template: null, version: 0 },
  progress: { template: null, version: 0 },
});

export function fakeSharingApi(): FakeSharingApi {
  let revision = 100;
  const take = async <T>(
    queue: Answer<T>[],
    fallback: SharingResult<T>,
  ): Promise<SharingResult<T>> => {
    const next = queue.shift();
    if (next === undefined) return fallback;
    return typeof next === "function" ? next() : next;
  };
  const api: FakeSharingApi = {
    calls: [],
    sent: [],
    next: {
      policy: [],
      templates: [],
      households: [],
      invitations: [],
      lookup: [],
      management: [],
      access: [],
    },
    defaults: {
      policy: ok({ version: 1, policy: { grants: [], exclude_accounts: [] } }),
      templates: () => ok(emptyScope()),
      households: ok([]),
      invitations: ok([]),
      lookup: () => ok([]),
      management: ok({ revision: 0 }),
    },
    async readPolicy(id) {
      api.calls.push({ op: "readPolicy", args: [id] });
      return take(api.next.policy, api.defaults.policy);
    },
    async readTemplates(householdId) {
      api.calls.push({ op: "readTemplates", args: [householdId] });
      return take(api.next.templates, api.defaults.templates(householdId));
    },
    async readHouseholds() {
      api.calls.push({ op: "readHouseholds", args: [] });
      return take(api.next.households, api.defaults.households);
    },
    async readInvitations() {
      api.calls.push({ op: "readInvitations", args: [] });
      return take(api.next.invitations, api.defaults.invitations);
    },
    async lookup(username) {
      api.calls.push({ op: "lookup", args: [username] });
      return take(api.next.lookup, api.defaults.lookup(username));
    },
    async management(commands: readonly ManagementCommand[], key: string) {
      api.calls.push({ op: "management", args: [commands, key] });
      api.sent.push({ key, commands: [...commands] });
      revision += 1;
      return take(
        api.next.management,
        api.defaults.management.ok ? ok({ revision }) : api.defaults.management,
      );
    },
    async access(commands: readonly AccessCommand[], key: string) {
      api.calls.push({ op: "access", args: [commands, key] });
      api.sent.push({ key, commands: [...commands] });
      revision += 1;
      return take(api.next.access, ok({ revision }));
    },
  };
  return api;
}

export function sharingEnv(
  api: SharingApi,
  over: Partial<SharingEnv> = {},
): SharingEnv {
  let id = 0;
  return {
    api,
    accountId: "11111111-1111-4111-8111-111111111111",
    online: true,
    writable: true,
    newId: () => {
      id += 1;
      return `00000000-0000-4000-8000-${id.toString(16).padStart(12, "0")}`;
    },
    now: () => Date.now(),
    ...over,
  };
}
