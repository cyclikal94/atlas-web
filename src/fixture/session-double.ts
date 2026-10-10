import type {
  AccountSummary,
  Attempts,
  DeviceRow,
  Operations,
  Result,
  Session,
  SessionSummary,
  Store,
} from "../session";

/**
 * FIXTURE ONLY. A canned `Session` so the Settings screens can be rendered in a real engine without a backend, driven by the
 * query string: `?unsynced=3` (changes not yet synced), `?reconfirm=4` (a recount that differs), `?load=slow`, `?error=sessions`
 * or `?error=devices`, `?offline=1`, `?only=1` (only the person's own rows), `?refuse=operation_pending`. WEB-08b adds the account
 * card and "Signing in": `?account=sso|nopw|hostile|slow`, `?error=account|account-closed`, `?fresh=1` (the current session is
 * new enough to link or unlink), `?password=unconfirmed|gateway|refuse` and `?unlink=gateway|refuse` (`gateway` is a `502`: an answer that
 * cannot show the change was not made; `unconfirmed` is a lost answer), `?sso=unset` (the provider is not configured). It says nothing about
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
  const fresh = params.get("fresh") === "1";
  const sessions: SessionSummary[] = [
    {
      id: "sess-1",
      device_id: "dev-1",
      created_at: fresh ? new Date(now - 60_000).toISOString() : hoursAgo(5),
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
    changePassword: async () => {
      const outcome = params.get("password");
      if (outcome === "unconfirmed") return { ok: false, error: "offline" };
      if (outcome === "gateway")
        return { ok: false, error: "http", status: 502 };
      if (outcome === "refuse")
        return { ok: false, error: "http", status: 422 };
      return ok("changed" as const);
    },
    readAccount: async () => {
      if (params.get("account") === "slow") await delay(1500);
      if (failing === "account")
        return {
          ok: false,
          error: "http",
          status: 500,
          atlasError: {
            code: "internal",
            message: "boom",
            request_id: "5c1d-7e90-fixture",
          },
        };
      if (failing === "account-closed")
        return { ok: false, error: "closed" } as Result<AccountSummary>;
      const variant = params.get("account");
      const hostile = variant === "hostile";
      return ok({
        id: "fixture-account",
        username: hostile
          ? "<img src=x onerror=alert(1)> a-very-long-username-that-should-wrap-and-never-overflow-its-card-at-any-width-0123456789"
          : "kieran",
        has_password: variant !== "nopw",
        oidc_issuers:
          variant === "sso" || variant === "nopw"
            ? ["https://sso.example.org"]
            : hostile
              ? [
                  "javascript:alert(1)",
                  `https://${"very-long-host-name.".repeat(8)}example.org`,
                ]
              : [],
      });
    },
    unlinkOidc: async () => {
      const outcome = params.get("unlink");
      if (outcome === "gateway")
        return { ok: false, error: "http", status: 502 };
      if (outcome === "refuse")
        return { ok: false, error: "http", status: 409 };
      return ok("unlinked" as const);
    },
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
    } as never,
    attempts: fixtureAttempts(params),
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
  };
}

/** The attempts the Settings "Link single sign-on" control needs; nothing else in the fixture shell begins an attempt. */
function fixtureAttempts(params: URLSearchParams): Attempts {
  const unavailable = () => {
    throw new Error("fixture session: this attempt method is not available");
  };
  return {
    begin: async (method) => ({
      kind: "started",
      handle: { epoch: 1, method, challenge: "c".repeat(43) },
    }),
    startOidc: async () =>
      params.get("sso") === "unset"
        ? {
            kind: "refused",
            status: 404,
            error: {
              code: "not_found",
              message: "not found",
              request_id: "7a40-2bd1-fixture",
            },
          }
        : { kind: "exchange_failed", status: null },
    signInWithPassword: unavailable,
    registerWithInvitation: unavailable,
    previewInvitation: unavailable,
    completeExchange: unavailable,
    markRedirected: unavailable,
    landing: unavailable,
    cancel: unavailable,
  };
}
