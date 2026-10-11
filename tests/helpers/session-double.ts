import { expect, vi } from "vitest";
import {
  type AttemptHandle,
  type Attempts,
  type Operations,
  type Session,
  type Store,
  unrevokedHold,
} from "../../src/session";

/**
 * A `Session` for component tests: every operation is a spy with a harmless default, and any of them can be replaced. It
 * is a double of the PUBLIC interface only, so it proves what a screen does with each answer and nothing about the protocol
 * (that is the fake-world suites' job).
 */
export const store = <T>(value: T): Store<T> => ({
  get: () => value,
  subscribe: () => () => undefined,
});

/**
 * `Attempts` as spies. By default `begin` starts an attempt of the requested method and every exchange settles; a test
 * replaces the one it is about. A double of the PUBLIC interface only: it proves what a screen does with each answer.
 */
export function attemptsDouble(over: Partial<Attempts> = {}): Attempts {
  return {
    begin: vi.fn(async (method) => ({
      kind: "started" as const,
      handle: { epoch: 1, method, challenge: "c".repeat(43) } as AttemptHandle,
    })),
    signInWithPassword: vi.fn(async () => ({
      kind: "settled" as const,
      account_id: "acct",
      epoch: 1,
      method: "password" as const,
    })),
    registerWithInvitation: vi.fn(async () => ({
      kind: "settled" as const,
      account_id: "acct",
      epoch: 1,
      method: "registration" as const,
    })),
    previewInvitation: vi.fn(async () => ({
      kind: "ok" as const,
      household: null,
      expires_at: "2026-10-08T18:00:00.000Z",
    })),
    startOidc: vi.fn(async () => ({
      kind: "redirect" as const,
      authorization_url: "https://idp.example.test/authorize",
    })),
    completeExchange: vi.fn(),
    markRedirected: vi.fn(),
    landing: vi.fn(async () => ({
      kind: "settled" as const,
      account_id: "acct",
      epoch: 1,
      method: "oidc" as const,
    })),
    cancel: vi.fn(),
    ...over,
  };
}

/**
 * WEB-08d review R3 (revision 2): the options an ordinary change request is now called with. A screen passes the `withdraw` signal of
 * the interaction that made the request (`SendOptions`), so a call assertion names it as the last argument. Adapted, labelled: the
 * earlier assertions named only the operation's own arguments; their intent is unchanged.
 */
export const WITHDRAW = expect.objectContaining({
  withdraw: expect.any(AbortSignal),
});

export function sessionDouble(
  operations: Partial<Operations> = {},
  overrides: Partial<Session> = {},
): Session {
  const base: Operations = {
    summariseLocalWork: vi.fn(async () => ({
      count: 0,
      items: [],
      digest: "0",
    })),
    readDevices: vi.fn(async () => ({
      ok: true as const,
      value: { devices: [] },
    })),
    listSessions: vi.fn(async () => ({
      ok: true as const,
      value: { sessions: [] },
    })),
    nameDevice: vi.fn(async (_id: string, name: string | null) => ({
      ok: true as const,
      value: name === null ? ("cleared" as const) : ("named" as const),
    })),
    revokeOtherSession: vi.fn(async () => ({
      ok: true as const,
      value: "revoked" as const,
    })),
    retireOtherDevice: vi.fn(async () => ({
      ok: true as const,
      value: "confirmed_applied" as const,
    })),
    logout: vi.fn(async () => ({
      kind: "started" as const,
      operation_id: "op-1",
    })),
    retireThisDevice: vi.fn(async () => ({
      kind: "started" as const,
      operation_id: "op-1",
    })),
    changePassword: vi.fn(async () => ({
      ok: true as const,
      value: "changed" as const,
    })),
    readAccount: vi.fn(async () => ({
      ok: true as const,
      value: {
        id: "acct",
        username: "kieran",
        has_password: true,
        oidc_issuers: [] as string[],
      },
    })),
    unlinkOidc: vi.fn(async () => ({
      ok: true as const,
      value: "unlinked" as const,
    })),
    resume: vi.fn(),
    pending: store([]),
  };
  const fail = (name: string) => () => {
    throw new Error(`session double: ${name} was not expected`);
  };
  return {
    bootId: "boot",
    notices: store([]),
    dismissNotice: vi.fn(),
    start: vi.fn(async () => undefined),
    dispose: vi.fn(),
    view: store({ kind: "displaying" as const, account_id: "acct", epoch: 1 }),
    identity: store({ account_id: "acct", epoch: 1, session_id: "sess-1" }),
    api: {
      client: fail("api.client"),
      fetchFor: fail("api.fetchFor"),
      seal: fail("api.seal"),
      admission: fail("api.admission"),
    } as never,
    attempts: {} as never,
    operations: { ...base, ...operations },
    recovery: {} as never,
    wipe: {} as never,
    compat: store({ status: "supported" as const, version: "0.28.0" }),
    actions: {
      signIn: vi.fn(),
      retry: vi.fn(),
      reload: vi.fn(),
      reviewDevice: vi.fn(),
      consent: vi.fn(),
    },
    persistence: {
      hold: vi.fn(async () => unrevokedHold()),
    },
    ...overrides,
  };
}

export const sessionRow = (over: Record<string, unknown> = {}) => ({
  id: "sess-1",
  device_id: "dev-1",
  created_at: "2026-09-30T09:00:00.000Z",
  expires_at: "2026-10-30T09:00:00.000Z",
  authentication: "local" as const,
  current: true,
  ...over,
});

export const deviceRow = (over: Record<string, unknown> = {}) => ({
  id: "dev-1",
  last_synced_at: "2026-09-30T11:00:00.000Z",
  active_sessions: 2,
  current: true,
  state_token: "tok-1",
  summary: {
    sessions: 2,
    native_handoffs: 0,
    notification_subscriptions: 1,
    pending_sign_ins: 0,
    sync_registered: true,
  },
  ...over,
});
