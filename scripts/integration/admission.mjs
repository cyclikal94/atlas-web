// The released backend's sign-in admission, as the integration harness has to account for it (WEB-08d review r5, H3).
//
// Read from the pinned release's source (atlas 30fec6a3f31aaeea9c69d10216c78b8c02645661, crates/server/src/throttle.rs, lib.rs,
// app.rs): one `Budget` per kind, keyed per source address / per account / per unknown-name bucket. A key's window opens at its first
// admitted use and lasts 60 whole seconds of the server's monotonic clock; `allow` admits at most `attempts` uses in it and a refused
// use is not counted. The source budget (120) is consumed by every route below, BEFORE the account lookup, whatever the outcome. The
// principal budget (10 per account, a separate space of 4096 three-hex-digit buckets for unknown names) is consumed by password
// authentication only, and a successful verification RESETS that account's bucket (never the source's).
//
// Every request of a stack, from a page or from the Node side of a spec, reaches the backend through the delaying proxy from one
// loopback address, so a whole stack shares ONE source budget. The proxy records what it forwards on these routes (no bodies, no
// credentials); `audit` turns that into evidence: whether any 60-second interval of the stack held more than the source allows.
export const WINDOW_SECONDS = 60;
export const SOURCE_LIMIT = 120;
export const PRINCIPAL_LIMIT = 10;

const API = "/api/experimental/v1";
/** The routes whose handler calls `source_attempt` (directly or through `authenticate_local`). */
export const SOURCE_ROUTES = [
  { method: "POST", path: `${API}/sessions`, kind: "password (native)" },
  {
    method: "POST",
    path: `${API}/browser-sessions`,
    kind: "password (browser)",
  },
  {
    method: "POST",
    path: `${API}/browser-sessions/activate`,
    kind: "activation",
  },
  {
    method: "POST",
    path: `${API}/browser-sessions/activate/cancel`,
    kind: "activation cancel",
  },
  { method: "POST", path: `${API}/password`, kind: "password change" },
  { method: "POST", path: `${API}/registration`, kind: "registration" },
  {
    method: "POST",
    path: `${API}/registration/preview`,
    kind: "registration preview",
  },
  {
    method: "POST",
    path: `${API}/browser-registration`,
    kind: "browser registration",
  },
  { method: "POST", path: `${API}/oidc/start`, kind: "single sign-on start" },
  {
    method: "GET",
    path: `${API}/oidc/callback`,
    kind: "single sign-on callback",
  },
  {
    method: "GET",
    path: `${API}/oidc/native/start`,
    kind: "native single sign-on start",
  },
  {
    method: "POST",
    path: `${API}/oidc/native/exchange`,
    kind: "native single sign-on exchange",
  },
];

/** The route kind a request consumes from the source budget, or null. The query string is ignored, as the router does. */
export function sourceRoute(method, url) {
  const path = new URL(url, "http://x").pathname;
  return (
    SOURCE_ROUTES.find((r) => r.method === method && r.path === path)?.kind ??
    null
  );
}

/** The backend's `throttle::Budget`: per key, a window opened at first admitted use, `attempts` admitted uses in it. */
export function createBudget(attempts, capacity = 4096) {
  const entries = new Map();
  return {
    allow(key, seconds) {
      for (const [k, [start]] of entries)
        if (seconds - start >= WINDOW_SECONDS) entries.delete(k);
      if (!entries.has(key) && entries.size >= capacity) return false;
      const entry = entries.get(key) ?? [seconds, 0];
      entries.set(key, entry);
      if (entry[1] >= attempts) return false;
      entry[1] += 1;
      return true;
    },
    reset(key) {
      entries.delete(key);
    },
    used(key) {
      return entries.get(key)?.[1] ?? 0;
    },
  };
}

/**
 * The model of the backend's admission for a sequence of requests at server seconds: the source budget first, then for password
 * authentication the principal budget, and a successful verification resetting the principal. Each event is
 * `{ seconds, route, account?, succeeds? }` (`account` null = an unknown name). Returns each event's verdict.
 */
export function admit(events, { source = "127.0.0.1" } = {}) {
  const sources = createBudget(SOURCE_LIMIT);
  const principals = createBudget(PRINCIPAL_LIMIT);
  const unknown = createBudget(PRINCIPAL_LIMIT);
  return events.map((event) => {
    if (!sources.allow(event.source ?? source, event.seconds))
      return "rate_limited_source";
    if (!String(event.route).startsWith("password")) return "admitted";
    const [budget, key] =
      event.account === null || event.account === undefined
        ? [unknown, event.bucket ?? "unknown"]
        : [principals, event.account];
    if (!budget.allow(key, event.seconds)) return "rate_limited_principal";
    if (event.succeeds && budget === principals) principals.reset(key);
    return event.succeeds ? "admitted" : "unauthenticated";
  });
}

/** The largest number of times in `at` (ms) that fall within any interval of `windowMs`: an upper bound for every fixed window. */
export function slidingPeak(at, windowMs = WINDOW_SECONDS * 1000) {
  const times = [...at].sort((a, b) => a - b);
  let peak = 0;
  let start = 0;
  for (let end = 0; end < times.length; end += 1) {
    while (times[end] - times[start] >= windowMs) start += 1;
    peak = Math.max(peak, end - start + 1);
  }
  return peak;
}

/** A per-stack recorder for the proxy's forwarding hook. */
export function createAdmissionRecorder() {
  const requests = new Map();
  return {
    observe(event) {
      if (event.event === "forwarded") {
        const kind = sourceRoute(event.method, event.path);
        if (kind)
          requests.set(event.id, {
            id: event.id,
            kind,
            method: event.method,
            path: new URL(event.path, "http://x").pathname,
            forwarded_at: event.at,
            status: null,
          });
      } else if (
        requests.has(event.id) &&
        requests.get(event.id).status === null
      ) {
        const r = requests.get(event.id);
        r.status = event.event === "answered" ? event.status : "upstream_error";
        r.answered_at = event.at;
      }
    },
    requests: () => [...requests.values()],
  };
}

/**
 * The evidence of one stack: what reached the backend on source routes, the busiest 60-second interval against the limit, and every
 * 429 the backend returned on them (I-30b provokes a PRINCIPAL refusal on purpose; a source refusal would show as a peak above the
 * limit). `backendStartedAt` (ms) approximates the server's monotonic origin for the fixed-window model.
 */
export function audit(requests, { backendStartedAt } = {}) {
  const forwarded = requests.map((r) => r.forwarded_at);
  const peak = slidingPeak(forwarded);
  const byKind = {};
  for (const r of requests) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
  const modelled =
    backendStartedAt === undefined
      ? null
      : admit(
          [...requests]
            .sort((a, b) => a.forwarded_at - b.forwarded_at)
            .map((r) => ({
              seconds: Math.floor((r.forwarded_at - backendStartedAt) / 1000),
              route: "other",
            })),
        ).filter((v) => v === "rate_limited_source").length;
  return {
    source_requests: requests.length,
    by_kind: byKind,
    sliding_peak_60s: peak,
    limit: SOURCE_LIMIT,
    within_limit: peak <= SOURCE_LIMIT,
    modelled_source_refusals: modelled,
    rate_limited: requests
      .filter((r) => r.status === 429)
      .map((r) => ({ kind: r.kind, path: r.path, at: r.forwarded_at })),
    unanswered: requests.filter((r) => r.status === null).length,
  };
}
