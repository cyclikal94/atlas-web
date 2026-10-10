import {
  type DeviceRow,
  type Operations,
  type Result,
  type Session,
  type SessionSummary,
  type Store,
  unrevokedHold,
} from "../session";

/**
 * FIXTURE ONLY. A canned `Session` so the Settings screens can be rendered in a real engine without a backend, driven by the
 * query string: `?unsynced=3` (changes not yet synced), `?reconfirm=4` (a recount that differs), `?load=slow`, `?error=sessions`
 * or `?error=devices`, `?offline=1`, `?only=1` (only the person's own rows), `?refuse=operation_pending`. It says nothing about
 * the protocol or a backend: a rendered fixture is evidence about layout, contrast, focus and copy, not integration.
 */
const store = <T>(value: T): Store<T> => ({
  get: () => value,
  subscribe: () => () => undefined,
});
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function fixtureSession(params: URLSearchParams): Session {
  const slow = params.get("load") === "slow";
  const only = params.get("only") === "1";
  const failing = params.get("error");
  const unsynced = Number(params.get("unsynced") ?? 0);
  const reconfirm = params.get("reconfirm");
  const refuse = params.get("refuse");
  const now = Date.now();
  const hoursAgo = (h: number) => new Date(now - h * 3_600_000).toISOString();
  const sessions: SessionSummary[] = [
    {
      id: "sess-1",
      device_id: "dev-1",
      created_at: hoursAgo(5),
      expires_at: hoursAgo(-24 * 25),
      authentication: "local",
      current: true,
    },
    ...(only
      ? []
      : [
          {
            id: "sess-2",
            device_id: "dev-2",
            created_at: hoursAgo(72),
            expires_at: hoursAgo(-24 * 20),
            authentication: "oidc" as const,
            current: false,
          },
        ]),
  ];
  const devices: DeviceRow[] = [
    {
      id: "dev-1",
      last_synced_at: hoursAgo(0.05),
      active_sessions: 2,
      current: true,
      state_token: "v1.token-1",
      summary: {
        sessions: 2,
        native_handoffs: 0,
        notification_subscriptions: 1,
        pending_sign_ins: 0,
        sync_registered: true,
      },
    },
    ...(only
      ? []
      : [
          {
            id: "dev-2",
            last_synced_at: hoursAgo(3),
            active_sessions: 1,
            current: false,
            state_token: "v1.token-2",
            summary: {
              sessions: 1,
              native_handoffs: 1,
              notification_subscriptions: 0,
              pending_sign_ins: 0,
              sync_registered: true,
            },
          },
          {
            id: "dev-3",
            last_synced_at: null,
            active_sessions: 0,
            current: false,
            state_token: "v1.token-3",
            summary: {
              sessions: 0,
              native_handoffs: 0,
              notification_subscriptions: 0,
              pending_sign_ins: 0,
              sync_registered: false,
            },
          },
        ]),
  ];
  let reconfirmed = false;
  const work = (count: number) => ({
    count,
    items:
      count > 0
        ? [
            "Buy new school shoes (created)",
            "Empty the dishwasher (marked done)",
            "Reminder time change on “Take medication”",
          ].slice(0, Math.min(3, count))
        : [],
    digest: `d${count}`,
  });
  const operations: Operations = {
    summariseLocalWork: async () => work(unsynced),
    readDevices: async () => {
      if (slow) await delay(1500);
      if (failing === "devices")
        return {
          ok: false,
          error: "http",
          status: 500,
          atlasError: {
            code: "internal",
            message: "boom",
            request_id: "4a6e-de03-fixture",
          },
        };
      return ok({ devices });
    },
    listSessions: async () => {
      if (slow) await delay(700);
      if (failing === "sessions")
        return {
          ok: false,
          error: "http",
          status: 500,
          atlasError: {
            code: "internal",
            message: "boom",
            request_id: "90fa-1c22-fixture",
          },
        };
      return ok({ sessions });
    },
    revokeOtherSession: async () =>
      failing === "revoke"
        ? {
            ok: false,
            error: "http",
            status: 500,
            atlasError: {
              code: "internal",
              message: "boom",
              request_id: "90fa-1c22-fixture",
            },
          }
        : ok("revoked" as const),
    retireOtherDevice: async () => ok("confirmed_applied" as const),
    logout: async () => {
      if (refuse) return { kind: "refused", reason: refuse as never };
      if (reconfirm && !reconfirmed) {
        reconfirmed = true;
        return { kind: "reconfirm", unsynced: work(Number(reconfirm)) };
      }
      return { kind: "started", operation_id: "fixture-op" };
    },
    retireThisDevice: async () =>
      refuse
        ? { kind: "refused", reason: refuse as never }
        : { kind: "started", operation_id: "fixture-op" },
    changePassword: async () => ok("changed" as const),
    unlinkOidc: async () => ok("unlinked" as const),
    resume: () => undefined,
    pending: store([]),
  };
  const refusing = (name: string) => () => {
    throw new Error(`fixture session: ${name} is not available`);
  };
  return {
    bootId: "fixture",
    notices: store(
      params.get("notice") === "1"
        ? [{ id: "n1", kind: "remained_signed_in" as const }]
        : [],
    ),
    dismissNotice: () => undefined,
    start: async () => undefined,
    dispose: () => undefined,
    view: store({
      kind: "displaying" as const,
      account_id: "fixture-account",
      epoch: 1,
    }),
    identity: store({
      account_id: "fixture-account",
      epoch: 1,
      session_id: "sess-1",
    }),
    api: {
      client: refusing("api.client"),
      fetchFor: refusing("api.fetchFor"),
      seal: refusing("api.seal"),
      admission: refusing("api.admission"),
    } as never,
    attempts: {} as never,
    operations,
    recovery: {} as never,
    wipe: {} as never,
    compat: store({ status: "supported" as const, version: "0.27.0" }),
    actions: {
      signIn: () => undefined,
      retry: () => undefined,
      reload: () => undefined,
      reviewDevice: () => undefined,
      consent: () => undefined,
    },
    // A fixture page has no `atlas-auth` record to order against: the hold is granted at once, and says nothing about identity.
    persistence: {
      hold: async () => unrevokedHold(),
    },
  };
}
