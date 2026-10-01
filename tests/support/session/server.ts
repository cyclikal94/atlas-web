import { createHash } from "node:crypto";
import { base64url, EPOCH_BASE, sha256Base64url } from "./env";
import type { World } from "./world";

/**
 * A small stateful STAND-IN for the documented contract of plan section 3 (pinned `v0.27.0-rc.1`, API 0.27.0), written
 * from the OpenAPI facts. It is a stub of the contract, NOT a port of the backend, and a passing test against it is
 * fixture evidence, never integration evidence. Every answer can be delayed, dropped, rewritten or held (`Rule`).
 */
export const API = "/api/experimental/v1";

interface Account {
  id: string;
  username: string;
  password: string;
}
interface ServerSession {
  id: string;
  account: string;
  device: string;
  created: number;
  authentication: "local" | "oidc";
  token: string;
}
interface Grant {
  grant: string;
  account: string;
  device: string;
  challenge: string;
  state: "issued" | "redeemed" | "cancelled";
  wrongVerifiers: number;
  session: string | null;
}
interface DeviceData {
  sync_registered: boolean;
  handoffs: string[];
  subscriptions: string[];
  last_synced_at: string | null;
}

export interface Answer {
  status: number;
  body?: unknown;
  contentType?: string;
  /** A session token the browser stores when the answer is DELIVERED. */
  setCookie?: string;
}

export interface Rule {
  match: (request: {
    method: string;
    path: string;
    ordinal: number;
    page: string;
  }) => boolean;
  /** Delivery delay knob for this answer (default: the world's `Da` knob). */
  delay?: number | "unbounded";
  /**
   * Deliver the headers at `delay` and the BODY later, as a stream the page decodes asynchronously (delivery kind `Db`):
   * a transition can complete between the response and its decoded payload.
   */
  bodyDelay?: number | "unbounded";
  /** The server processed the request; the browser sees the connection close. */
  dropAfterForward?: boolean;
  /** The request never reaches the server (an offline blip): a network error, nothing processed. */
  dropBeforeForward?: boolean;
  /** The server processed the request; a gateway replaced the answer. */
  rewrite?: { status: number; body?: unknown; contentType?: string };
  times?: number;
}

export interface RecordedRequest {
  ordinal: number;
  page: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
  cookieToken: string | null;
  status: number;
  time: number;
  hadSetCookie: boolean;
}

const errorBody = (code: string, message = code) => ({
  code,
  message,
  request_id: "req-fixture",
  details: [] as unknown[],
});

export class StubServer {
  readonly accounts = new Map<string, Account>();
  readonly sessions = new Map<string, ServerSession>();
  readonly grants = new Map<string, Grant>();
  readonly devices = new Map<string, DeviceData>();
  readonly ledger = new Map<string, { outcome: string; kind: string }>();
  /** The browser's cookie jar for the origin: shared by every page. */
  cookie: string | null = null;
  apiVersion: string | undefined = "0.27.0";
  rules: Rule[] = [];
  readonly requests: RecordedRequest[] = [];
  /** Make the next activations answer `503 device_capacity`. */
  deviceCapacity = 0;
  private counter = 0;
  private ordinals = new Map<string, number>();

  constructor(private readonly world: World) {}

  // ---- fixtures ----
  addAccount(username: string, password: string): Account {
    const account = { id: `acct-${++this.counter}`, username, password };
    this.accounts.set(account.id, account);
    return account;
  }
  /** Create a session directly (a sign-in that the client did not perform, for example on another device). */
  createSession(
    account: string,
    device: string,
    authentication: "local" | "oidc" = "local",
  ): ServerSession {
    const id = `sess-${++this.counter}`;
    const session: ServerSession = {
      id,
      account,
      device,
      created: this.world.time,
      authentication,
      token: `tok.${id}`,
    };
    this.sessions.set(id, session);
    this.device(device);
    return session;
  }
  device(id: string): DeviceData {
    let data = this.devices.get(id);
    if (!data) {
      data = {
        sync_registered: false,
        handoffs: [],
        subscriptions: [],
        last_synced_at: null,
      };
      this.devices.set(id, data);
    }
    return data;
  }
  revoke(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
  sessionForToken(token: string | null): ServerSession | null {
    if (!token) return null;
    for (const session of this.sessions.values())
      if (session.token === token) return session;
    return null;
  }
  csrfFor(session: ServerSession): string {
    return `csrf.${session.id}`;
  }
  /** Give the browser this session's cookie, as `activate` would. */
  adoptCookie(session: ServerSession): void {
    this.cookie = session.token;
  }
  addRule(rule: Rule): () => void {
    this.rules.push(rule);
    return () => {
      this.rules = this.rules.filter((entry) => entry !== rule);
    };
  }
  recordsFor(path: string, method?: string): RecordedRequest[] {
    return this.requests.filter(
      (entry) => entry.path === path && (!method || entry.method === method),
    );
  }

  // ---- request processing (called at the moment the request reaches the server) ----
  process(
    page: string,
    method: string,
    path: string,
    headers: Headers,
    body: unknown,
    cookieToken: string | null,
  ): { answer: Answer; rule: Rule | null; ordinal: number } {
    const key = `${method} ${path}`;
    const ordinal = (this.ordinals.get(key) ?? 0) + 1;
    this.ordinals.set(key, ordinal);
    let rule: Rule | null = null;
    for (const candidate of this.rules) {
      if (candidate.times !== undefined && candidate.times <= 0) continue;
      if (candidate.match({ method, path, ordinal, page })) {
        rule = candidate;
        if (candidate.times !== undefined) candidate.times -= 1;
        break;
      }
    }
    if (rule?.dropBeforeForward) {
      // Nothing is processed: no effect, no ledger row, no session change.
      return { answer: { status: 0 }, rule, ordinal };
    }
    const answer = this.route(method, path, headers, body, cookieToken);
    const recorded: Record<string, string> = {};
    headers.forEach((value, name) => {
      recorded[name.toLowerCase()] = value;
    });
    this.requests.push({
      ordinal,
      page,
      method,
      path,
      headers: recorded,
      body,
      cookieToken,
      status: answer.status,
      time: this.world.time,
      hadSetCookie: answer.setCookie !== undefined,
    });
    return { answer, rule, ordinal };
  }

  private route(
    method: string,
    path: string,
    headers: Headers,
    body: unknown,
    cookieToken: string | null,
  ): Answer {
    const json = (status: number, data: unknown): Answer => ({
      status,
      body: data,
    });
    const error = (status: number, code: string): Answer =>
      json(status, errorBody(code));
    const session = this.sessionForToken(cookieToken);
    const b = (body ?? {}) as Record<string, unknown>;

    if (path === "/health" && method === "GET") {
      return json(
        200,
        this.apiVersion === undefined
          ? { status: "ok" }
          : { status: "ok", api_version: this.apiVersion },
      );
    }
    if (!path.startsWith(API)) return error(404, "not_found");
    const route = path.slice(API.length);

    if (route === "/browser-sessions" && method === "POST") {
      const account = [...this.accounts.values()].find(
        (a) => a.username === b.username && a.password === b.password,
      );
      if (!account) return error(401, "unauthenticated");
      const challenge = String(b.attempt_challenge ?? "");
      if (!/^[A-Za-z0-9_-]{43}$/.test(challenge))
        return error(422, "validation_failed");
      const grant: Grant = {
        grant: `grant-${++this.counter}`,
        account: account.id,
        device: String(b.device_id ?? ""),
        challenge,
        state: "issued",
        wrongVerifiers: 0,
        session: null,
      };
      this.grants.set(grant.grant, grant);
      return json(200, {
        grant: grant.grant,
        grant_expires_at: new Date(
          EPOCH_BASE + this.world.time + 60_000,
        ).toISOString(),
        account_id: account.id,
      });
    }
    if (route === "/browser-sessions/activate" && method === "POST") {
      const grant = this.grants.get(String(b.grant ?? ""));
      if (grant?.state !== "issued") return error(401, "unauthenticated");
      if (this.deviceCapacity > 0) {
        this.deviceCapacity -= 1;
        return error(503, "device_capacity");
      }
      const verifier = String(b.verifier ?? "");
      if (sha256Base64url(verifier) !== grant.challenge) {
        grant.wrongVerifiers += 1;
        if (grant.wrongVerifiers >= 5) grant.state = "cancelled";
        return error(401, "unauthenticated");
      }
      const created = this.createSession(grant.account, grant.device);
      grant.state = "redeemed";
      grant.session = created.id;
      return {
        status: 200,
        body: {
          account_id: created.account,
          expires_at: new Date(
            EPOCH_BASE + this.world.time + 86_400_000,
          ).toISOString(),
          csrf_token: this.csrfFor(created),
          session_id: created.id,
        },
        setCookie: created.token,
      };
    }
    if (route === "/browser-sessions/activate/cancel" && method === "POST") {
      const verifier = String(b.verifier ?? "");
      const challenge = sha256Base64url(verifier);
      const grant = [...this.grants.values()].find(
        (g) => g.challenge === challenge,
      );
      if (!grant) return json(200, { result: "unknown" });
      if (grant.state === "issued") {
        grant.state = "cancelled";
        return json(200, { result: "not_activated" });
      }
      if (grant.state === "cancelled")
        return json(200, { result: "not_activated" });
      if (grant.session) this.sessions.delete(grant.session);
      return json(200, { result: "session_revoked" });
    }
    if (route === "/browser-sessions/current" && method === "GET") {
      if (headers.get("X-Atlas-Session") !== "1")
        return error(403, "forbidden");
      if (!session) return error(401, "unauthenticated");
      return json(200, {
        account_id: session.account,
        expires_at: new Date(
          EPOCH_BASE + this.world.time + 86_400_000,
        ).toISOString(),
        csrf_token: this.csrfFor(session),
        session_id: session.id,
      });
    }

    // Everything below needs a cookie session and a matching CSRF token.
    if (!session) return error(401, "unauthenticated");
    const csrf = headers.get("X-CSRF-Token");
    if (!csrf || !/^csrf\./.test(csrf)) return error(403, "forbidden");
    if (csrf !== this.csrfFor(session))
      return error(403, "credential_mismatch");

    if (route === "/sessions" && method === "GET") {
      return json(200, {
        sessions: [...this.sessions.values()]
          .filter((s) => s.account === session.account)
          .map((s) => ({
            id: s.id,
            device_id: s.device,
            created_at: new Date(EPOCH_BASE + s.created).toISOString(),
            expires_at: new Date(
              EPOCH_BASE + s.created + 86_400_000,
            ).toISOString(),
            authentication: s.authentication,
            current: s.id === session.id,
          })),
      });
    }
    const sessionMatch = /^\/sessions\/([^/]+)$/.exec(route);
    if (sessionMatch && method === "DELETE") {
      const target = decodeURIComponent(sessionMatch[1] ?? "");
      const key = headers.get("Idempotency-Key");
      if (!key) {
        const found = this.sessions.get(target);
        if (!found || found.account !== session.account)
          return error(404, "not_found");
        this.sessions.delete(target);
        return { status: 204 };
      }
      const ledgerKey = `${session.account}/${key}`;
      const recorded = this.ledger.get(ledgerKey);
      if (recorded)
        return json(200, {
          operation_id: key,
          account_id: session.account,
          outcome: recorded.outcome,
        });
      const found = this.sessions.get(target);
      const outcome =
        found && found.account === session.account
          ? "confirmed_applied"
          : "superseded";
      if (outcome === "confirmed_applied") this.sessions.delete(target);
      this.ledger.set(ledgerKey, { outcome, kind: "logout" });
      return json(200, {
        operation_id: key,
        account_id: session.account,
        outcome,
      });
    }
    if (route === "/devices" && method === "GET") {
      const ids = new Set<string>();
      for (const s of this.sessions.values())
        if (s.account === session.account) ids.add(s.device);
      return json(200, {
        devices: [...ids].map((id) => this.deviceView(id, session)),
      });
    }
    const deviceMatch = /^\/devices\/([^/]+)$/.exec(route);
    if (deviceMatch && method === "DELETE") {
      const deviceId = decodeURIComponent(deviceMatch[1] ?? "");
      const key = headers.get("Idempotency-Key");
      const token = headers.get("Atlas-Device-State");
      if (!key || !token) return error(400, "bad_request");
      const ledgerKey = `${session.account}/${key}`;
      const recorded = this.ledger.get(ledgerKey);
      if (recorded) {
        if (recorded.outcome === "rejected_stale")
          return json(409, {
            ...errorBody("operation_conflict"),
            operation_id: key,
            account_id: session.account,
            outcome: "rejected_stale",
          });
        return json(200, {
          operation_id: key,
          account_id: session.account,
          outcome: recorded.outcome,
        });
      }
      const state = this.deviceState(deviceId, session.account);
      const current = this.deviceToken(deviceId, state);
      let outcome: string;
      if (state.members.length === 0) outcome = "superseded";
      else if (current !== token) outcome = "rejected_stale";
      else outcome = "confirmed_applied";
      if (outcome === "confirmed_applied") {
        for (const s of [...this.sessions.values()]) {
          if (s.account === session.account && s.device === deviceId)
            this.sessions.delete(s.id);
        }
        this.devices.delete(deviceId);
      }
      this.ledger.set(ledgerKey, { outcome, kind: "retire" });
      if (outcome === "rejected_stale")
        return json(409, {
          ...errorBody("operation_conflict"),
          operation_id: key,
          account_id: session.account,
          outcome,
        });
      return json(200, {
        operation_id: key,
        account_id: session.account,
        outcome,
      });
    }
    if (route === "/password" && method === "POST") {
      const account = this.accounts.get(session.account);
      if (!account || account.password !== b.current_password)
        return error(401, "unauthenticated");
      account.password = String(b.new_password ?? account.password);
      for (const s of [...this.sessions.values()])
        if (s.account === session.account) this.sessions.delete(s.id);
      return { status: 204 };
    }
    if (route === "/oidc/identities" && method === "DELETE") {
      for (const s of [...this.sessions.values()])
        if (s.account === session.account) this.sessions.delete(s.id);
      return { status: 204 };
    }
    if (
      route.startsWith("/probe") ||
      route.startsWith("/sync") ||
      route.startsWith("/items")
    ) {
      return json(200, { ok: true, path: route });
    }
    return error(404, "not_found");
  }

  private deviceState(
    deviceId: string,
    account: string,
  ): { members: string[] } {
    const data = this.device(deviceId);
    const members: string[] = [];
    for (const s of [...this.sessions.values()]
      .filter((x) => x.account === account && x.device === deviceId)
      .sort((a, b) => a.id.localeCompare(b.id)))
      members.push(`1 ${s.id}`);
    for (const h of [...data.handoffs].sort()) members.push(`2 ${h}`);
    for (const sub of [...data.subscriptions].sort()) members.push(`3 ${sub}`);
    for (const g of [...this.grants.values()]
      .filter(
        (x) =>
          x.state === "issued" &&
          x.account === account &&
          x.device === deviceId,
      )
      .sort((a, b) => a.grant.localeCompare(b.grant)))
      members.push(`4 ${g.grant}`);
    if (data.sync_registered) members.push("5 sync");
    return { members };
  }
  private deviceToken(deviceId: string, state: { members: string[] }): string {
    const canonical = [deviceId, ...state.members].join("\n");
    return `v1.${base64url(createHash("sha256").update(canonical).digest())}`;
  }
  private deviceView(deviceId: string, session: ServerSession) {
    const data = this.device(deviceId);
    const state = this.deviceState(deviceId, session.account);
    const sessionsHere = [...this.sessions.values()].filter(
      (x) => x.account === session.account && x.device === deviceId,
    );
    return {
      id: deviceId,
      last_synced_at: data.last_synced_at,
      active_sessions: sessionsHere.length,
      current: session.device === deviceId,
      state_token: this.deviceToken(deviceId, state),
      summary: {
        sessions: sessionsHere.length,
        native_handoffs: data.handoffs.length,
        notification_subscriptions: data.subscriptions.length,
        pending_sign_ins: [...this.grants.values()].filter(
          (g) =>
            g.state === "issued" &&
            g.account === session.account &&
            g.device === deviceId,
        ).length,
        sync_registered: data.sync_registered,
      },
    };
  }
}

/**
 * The page's `fetch`: the request reaches the server AT ONCE (with the cookie the browser holds now), and the
 * answer reaches the page later (delay knob `Da`). A `Set-Cookie` takes effect only when the answer is delivered to a
 * live request; an aborted or dropped answer installs nothing.
 */
export function createFakeFetch(
  world: World,
  server: StubServer,
  page: string,
  online: () => boolean = () => true,
) {
  return function fakeFetch(input: Request): Promise<Response> {
    const request = input;
    // A page that is offline cannot reach the server: the network error is immediate, and nothing is processed.
    if (!online()) {
      world.log({
        type: "fetch.offline",
        page,
        method: request.method,
        path: new URL(request.url).pathname,
      });
      return Promise.reject(new TypeError("Failed to fetch"));
    }
    const url = new URL(request.url);
    const cookieAtSend = server.cookie;
    const signal = request.signal;
    const headers = new Headers(request.headers);
    const method = request.method.toUpperCase();
    const path = url.pathname;
    return new Promise<Response>((resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException("aborted", "AbortError"));
        return;
      }
      let done = false;
      signal.addEventListener(
        "abort",
        () => {
          if (done) return;
          done = true;
          world.log({ type: "fetch.aborted", page, method, path });
          reject(new DOMException("aborted", "AbortError"));
        },
        { once: true },
      );
      const bodyPromise =
        method === "GET" || method === "DELETE" || method === "HEAD"
          ? Promise.resolve("")
          : request.text();
      bodyPromise.then((text) => {
        if (done) return;
        let parsed: unknown;
        try {
          parsed = text ? JSON.parse(text) : undefined;
        } catch {
          parsed = undefined;
        }
        const { answer, rule, ordinal } = server.process(
          page,
          method,
          path,
          headers,
          parsed,
          cookieAtSend,
        );
        if (rule?.dropBeforeForward) {
          done = true;
          world.log({ type: "fetch.lost", page, method, path, ordinal });
          world.schedule("Da", page, { method, path, ordinal }, () =>
            reject(new TypeError("Failed to fetch")),
          );
          return;
        }
        world.log({
          type: "fetch.sent",
          page,
          method,
          path,
          ordinal,
          status: answer.status,
        });
        const deliver = () => {
          if (done) return;
          done = true;
          if (rule?.dropAfterForward) {
            world.log({ type: "fetch.dropped", page, method, path, ordinal });
            reject(new TypeError("Failed to fetch"));
            return;
          }
          const final = rule?.rewrite
            ? {
                status: rule.rewrite.status,
                body: rule.rewrite.body,
                contentType: rule.rewrite.contentType,
                setCookie: undefined as string | undefined,
              }
            : {
                status: answer.status,
                body: answer.body,
                contentType: answer.contentType,
                setCookie: answer.setCookie,
              };
          if (final.setCookie !== undefined) server.cookie = final.setCookie;
          const bodyText =
            final.body === undefined
              ? null
              : typeof final.body === "string"
                ? final.body
                : JSON.stringify(final.body);
          const responseHeaders = new Headers();
          if (bodyText !== null)
            responseHeaders.set(
              "content-type",
              final.contentType ?? "application/json",
            );
          const spyResponse = (response: Response) => {
            if (!world.spyBodies) return response;
            for (const method of [
              "text",
              "json",
              "clone",
              "arrayBuffer",
            ] as const) {
              const original = (
                response[method] as (...args: unknown[]) => unknown
              ).bind(response);
              (response as unknown as Record<string, unknown>)[method] = (
                ...args: unknown[]
              ) => {
                world.log({ type: "spy.body", page, method, path });
                return original(...args);
              };
            }
            return response;
          };
          world.log({
            type: "fetch.answered",
            page,
            method,
            path,
            ordinal,
            status: final.status,
          });
          const nullBody = final.status === 204 || final.status === 304;
          const streamed = rule?.bodyDelay !== undefined && !nullBody;
          const payload = streamed
            ? new ReadableStream<Uint8Array>({
                start(controller) {
                  world.schedule(
                    "Db",
                    page,
                    { method, path, ordinal },
                    () => {
                      controller.enqueue(
                        new TextEncoder().encode(bodyText ?? ""),
                      );
                      controller.close();
                    },
                    rule?.bodyDelay,
                  );
                },
              })
            : nullBody
              ? null
              : bodyText;
          resolve(
            spyResponse(
              new Response(payload, {
                status: final.status,
                headers: responseHeaders,
              }),
            ),
          );
        };
        world.schedule(
          "Da",
          page,
          { method, path, ordinal },
          deliver,
          rule?.delay,
        );
      });
    });
  };
}
