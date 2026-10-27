import {
  type AccountSummary,
  type Attempts,
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
 * or `?error=devices`, `?offline=1`, `?only=1` (only the person's own rows), `?refuse=operation_pending`. WEB-08b adds the account
 * card and "Signing in": `?account=sso|nopw|hostile|slow`, `?error=account|account-closed`, `?fresh=1` (the current session is
 * new enough to link or unlink), `?password=unconfirmed|gateway|refuse` and `?unlink=gateway|refuse` (`gateway` is a `502`: an answer that
 * cannot show the change was not made; `unconfirmed` is a lost answer), `?sso=unset` (the provider is not configured). WEB-08d makes the
 * default answers 0.28-shaped (BE-Q25 client labels, a device name, both capacities) and adds `?labels=legacy|absent|hostile|duplicate|future`
 * (`absent` is a 0.27 server: no labels, no capacity, no naming), `?capacity=full|unlimited|unavailable|inconsistent` and
 * `?name=gone|refuse|lost|slow` for the naming outcomes. It says nothing about the protocol or a backend: a rendered fixture is evidence
 * about layout, contrast, focus and copy, not integration.
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
  const labels = params.get("labels");
  const capacity = params.get("capacity");
  const naming = params.get("name");
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
  // ---- WEB-08d: BE-Q25 members, applied to the canned rows at read time --------------------------------------------------------
  const browser = (b: string, p: string) => ({
    channel: "browser",
    browser: b,
    platform: p,
  });
  const native = (p: string) => ({
    channel: "native",
    browser: null,
    platform: p,
  });
  const clients: Record<string, unknown> =
    labels === "legacy"
      ? {}
      : labels === "duplicate"
        ? {
            "dev-1": browser("chrome", "macos"),
            "dev-2": browser("firefox", "windows"),
            "dev-3": browser("firefox", "windows"),
          }
        : labels === "future"
          ? {
              "dev-1": browser("brave", "macos"),
              "dev-2": { channel: "tv", browser: null, platform: "harmonyos" },
              "dev-3": browser("chrome", "plan9"),
            }
          : {
              "dev-1": browser("chrome", "macos"),
              "dev-2": native("ios"),
              "dev-3": browser("firefox", "windows"),
            };
  const names = new Map<string, string>(
    labels === "hostile"
      ? [
          [
            "dev-1",
            "\u05D4\u05DE\u05D7\u05E9\u05D1 \u05E9\u05DC \u05E7\u05D9\u05E8\u05DF",
          ],
          ["dev-2", "<img src=x onerror=alert(1)><script>alert(2)</script>"],
          ["dev-3", "\u{1F600}".repeat(64)],
        ]
      : labels === "legacy" || labels === "duplicate" || labels === "future"
        ? []
        : [["dev-2", "Kieran's phone"]],
  );
  // Hostile names are VALID DeviceNames (at most 64 scalars), so they reach the screen as text. A name a correct server never sends (a
  // right-to-left override) is treated as absent.
  const invalidName = labels === "hostile" ? "evil\u202Etxt.exe" : null;
  const capacityOf = (used: number): Record<string, unknown> | undefined => {
    if (capacity === "unavailable") return undefined;
    if (capacity === "unlimited") return { limit: null, used, remaining: null };
    if (capacity === "full") return { limit: used, used, remaining: 0 };
    if (capacity === "inconsistent") return { limit: 10, used, remaining: 3 };
    return { limit: 10, used, remaining: Math.max(10 - used, 0) };
  };
  const withLabels = <T extends object>(
    read: T,
    member: "session_capacity" | "sync_capacity",
    used: number,
  ): T => {
    if (labels === "absent") return read;
    const reading = capacityOf(used);
    return reading === undefined ? read : { ...read, [member]: reading };
  };
  const sessionRows = (): SessionSummary[] =>
    labels === "absent"
      ? sessions
      : sessions.map((row) => ({
          ...row,
          client: clients[row.device_id] ?? null,
          device_name: names.get(row.device_id) ?? null,
        }));
  const deviceRows = (): DeviceRow[] =>
    labels === "absent"
      ? devices
      : [
          ...devices.map((row) => ({
            ...row,
            client: clients[row.id] ?? null,
            name: names.get(row.id) ?? null,
          })),
          ...(invalidName && !only
            ? [
                {
                  id: "dev-4",
                  last_synced_at: hoursAgo(30),
                  active_sessions: 0,
                  current: false,
                  state_token: "v1.token-4",
                  summary: {
                    sessions: 0,
                    native_handoffs: 0,
                    notification_subscriptions: 0,
                    pending_sign_ins: 0,
                    sync_registered: true,
                  },
                  client: browser("edge", "windows"),
                  name: invalidName,
                },
              ]
            : []),
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
      const rows = deviceRows();
      return ok(
        withLabels(
          { devices: rows },
          "sync_capacity",
          rows.filter((row) => row.summary.sync_registered).length,
        ),
      );
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
      const rows = sessionRows();
      return ok(
        withLabels({ sessions: rows }, "session_capacity", rows.length),
      );
    },
    nameDevice: async (id, name) => {
      if (naming === "slow") await delay(1500);
      if (naming === "gone") return ok("gone" as const);
      if (naming === "lost") return { ok: false, error: "offline" };
      if (naming === "refuse")
        return {
          ok: false,
          error: "http",
          status: 422,
          atlasError: {
            code: "invalid_value",
            message: "invalid",
            request_id: "3b7e-91c4-fixture",
          },
        };
      if (name === null) names.delete(id);
      else names.set(id, name);
      return ok(name === null ? ("cleared" as const) : ("named" as const));
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
      seal: refusing("api.seal"),
      admission: refusing("api.admission"),
    } as never,
    attempts: fixtureAttempts(params),
    operations,
    recovery: {} as never,
    wipe: {} as never,
    compat: store({ status: "supported" as const, version: "0.29.0" }),
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
