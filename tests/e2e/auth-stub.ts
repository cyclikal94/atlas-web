import { createHash } from "node:crypto";
import type { BrowserContext, Route } from "@playwright/test";

/**
 * A small stateful STAND-IN for the Atlas API, served to the PRODUCTION build in a real engine through `context.route`
 * (Layer B: a stubbed network). It processes a request when it ARRIVES and delivers the answer when the test releases it, so
 * a test can order "the server processed A first" against "A's answer reached tab 1 late", exactly as the fake-world suites
 * do. The browser's session cookie is modelled by `cookie`, which changes only when an `activate` answer is delivered (the
 * stub does not rely on the engine honouring a fulfilled `Set-Cookie`). It is NOT the backend and a pass against it is never
 * integration evidence.
 */
const API = "/api/experimental/v1";
const b64url = (buffer: Buffer) =>
  buffer
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
const challengeOf = (verifier: string) =>
  b64url(createHash("sha256").update(verifier).digest());

interface Account {
  id: string;
  username: string;
  password: string;
  hasPassword: boolean;
  issuers: string[];
}
interface Grant {
  account: string;
  challenge: string;
  device: string;
  state: "issued" | "redeemed";
}
interface Invitation {
  household: { id: string; name: string } | null;
  state: "open" | "redeemed";
  expires: number;
}
export interface Recorded {
  n: number;
  method: string;
  path: string;
  body: unknown;
  status: number;
  /** The page's address at the moment the request was issued: a grant or a token must never be in it. */
  pageUrl: string;
}
/** A provider flow the stub is holding between `/oidc/start` and the redirect back to the origin. */
export interface OidcFlow {
  attemptId: string;
  challenge: string;
  device: string;
  link: boolean;
  account: string | null;
}
export interface Hold {
  release(): void;
  stop(): void;
}

const err = (code: string) => ({
  code,
  message: code,
  request_id: "req-stub",
  details: [],
});

export class AuthStub {
  readonly accounts = new Map<string, Account>();
  readonly grants = new Map<string, Grant>();
  readonly invitations = new Map<string, Invitation>();
  readonly sessions = new Map<string, { id: string; account: string }>();
  readonly requests: Recorded[] = [];
  /** The browser's cookie jar for the origin: the session id the browser holds. */
  cookie: string | null = null;
  /** Every cookie value the browser has held, in order. */
  readonly cookieHistory: Array<string | null> = [null];
  private counter = 0;
  readonly oidcFlows: OidcFlow[] = [];
  private holds: Array<{
    match: (r: { method: string; path: string; n: number }) => boolean;
    gate: Promise<void>;
    open: () => void;
    active: boolean;
    remaining: number;
  }> = [];
  private nextOverride: Array<{
    match: (r: { method: string; path: string }) => boolean;
    answer: { status: number; body?: unknown; contentType?: string } | "abort";
    times: number;
  }> = [];

  addAccount(username: string, password: string, extra: Partial<Account> = {}) {
    const account: Account = {
      id: `00000000-0000-4000-8000-${String(++this.counter).padStart(12, "0")}`,
      username,
      password,
      hasPassword: true,
      issuers: [],
      ...extra,
    };
    this.accounts.set(account.id, account);
    return account;
  }
  addInvitation(
    options: { household?: { id: string; name: string } | null } = {},
  ) {
    const token = (++this.counter).toString(16).padStart(64, "d");
    this.invitations.set(token, {
      household: options.household ?? null,
      state: "open",
      expires: Date.now() + 7 * 86_400_000,
    });
    return token;
  }
  /**
   * Hold the ANSWERS to matching requests until `release()`: the next `times` of them (default all). The request is still
   * processed on arrival.
   */
  hold(
    match: (r: { method: string; path: string; n: number }) => boolean,
    times = Number.POSITIVE_INFINITY,
  ): Hold {
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const entry = { match, gate, open, active: true, remaining: times };
    this.holds.push(entry);
    return {
      release: () => entry.open(),
      stop: () => {
        entry.active = false;
        entry.open();
      },
    };
  }
  /** What the provider's callback redirect carries once the person approved: a grant bound to the flow's challenge. */
  completeOidc(flow: OidcFlow, subject: string): string {
    const account = flow.link ? (flow.account ?? subject) : subject;
    if (flow.link) {
      const owner = this.accounts.get(account);
      if (owner && !owner.issuers.includes("https://idp.example.test"))
        owner.issuers.push("https://idp.example.test");
    }
    const grant = `${(++this.counter).toString(16).padStart(64, "a")}`;
    this.grants.set(grant, {
      account,
      challenge: flow.challenge,
      device: flow.device,
      state: "issued",
    });
    const fragment = new URLSearchParams({
      atlas_grant: grant,
      atlas_attempt: flow.attemptId,
      atlas_account: account,
    });
    return `#${fragment.toString()}`;
  }
  /** Replace the answer to the next `times` matching requests (an Atlas error, a gateway page, a dropped connection). */
  answerNext(
    match: (r: { method: string; path: string }) => boolean,
    answer: { status: number; body?: unknown; contentType?: string } | "abort",
    times = 1,
  ) {
    this.nextOverride.push({ match, answer, times });
  }
  count(method: string, path: string): number {
    return this.requests.filter((r) => r.method === method && r.path === path)
      .length;
  }
  recordsFor(path: string, method?: string) {
    return this.requests.filter(
      (r) => r.path === path && (!method || r.method === method),
    );
  }

  async install(context: BrowserContext) {
    await context.route(`**${API}/**`, (route) => this.handle(route));
  }

  private async handle(route: Route) {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.slice(API.length);
    const method = request.method();
    let body: unknown;
    try {
      body = request.postDataJSON();
    } catch {
      body = undefined;
    }
    const n = this.requests.length + 1;
    let answer = this.route(method, path, body, request.headers());
    const recorded: Recorded = {
      n,
      method,
      path,
      body,
      status: answer.status,
      pageUrl: request.frame().url(),
    };
    this.requests.push(recorded);
    const override = this.nextOverride.find(
      (o) => o.times > 0 && o.match({ method, path }),
    );
    let abort = false;
    if (override) {
      override.times -= 1;
      if (override.answer === "abort") abort = true;
      else {
        answer = { ...override.answer };
        recorded.status = answer.status;
      }
    }
    const hold = this.holds.find(
      (h) => h.active && h.remaining > 0 && h.match({ method, path, n }),
    );
    if (hold) {
      hold.remaining -= 1;
      await hold.gate;
    }
    if (abort) return route.abort("connectionreset");
    if (answer.cookie !== undefined) {
      this.cookie = answer.cookie;
      this.cookieHistory.push(answer.cookie);
    }
    const text =
      answer.body === undefined
        ? undefined
        : typeof answer.body === "string"
          ? answer.body
          : JSON.stringify(answer.body);
    return route.fulfill({
      status: answer.status,
      contentType: answer.contentType ?? "application/json",
      body: text,
    });
  }

  private route(
    method: string,
    path: string,
    body: unknown,
    headers: Record<string, string>,
  ): {
    status: number;
    body?: unknown;
    contentType?: string;
    cookie?: string | null;
  } {
    const b = (body ?? {}) as Record<string, unknown>;
    const json = (status: number, data: unknown) => ({ status, body: data });
    const fail = (status: number, code: string) => json(status, err(code));
    const session = this.cookie ? this.sessions.get(this.cookie) : undefined;

    if (path === "/registration/preview" && method === "POST") {
      const invitation = this.invitations.get(String(b.token ?? ""));
      if (invitation?.state !== "open") return fail(401, "unauthenticated");
      return json(200, {
        household: invitation.household,
        expires_at: new Date(invitation.expires).toISOString(),
      });
    }
    if (path === "/browser-registration" && method === "POST") {
      const token = String(b.token ?? "");
      const username = String(b.username ?? "");
      const password = typeof b.password === "string" ? b.password : "";
      const challenge = String(b.attempt_challenge ?? "");
      if (
        !/^[0-9a-f]{64}$/.test(token) ||
        !/^[a-z0-9_.-]{1,100}$/.test(username) ||
        new TextEncoder().encode(password).length < 12 ||
        !/^[A-Za-z0-9_-]{43}$/.test(challenge)
      )
        return fail(422, "invalid_value");
      const invitation = this.invitations.get(token);
      if (invitation?.state !== "open") return fail(401, "unauthenticated");
      if ([...this.accounts.values()].some((a) => a.username === username))
        return fail(409, "conflict");
      const account = this.addAccount(username, password);
      invitation.state = "redeemed";
      return this.issueGrant(account.id, String(b.device_id ?? ""), challenge);
    }
    if (path === "/browser-sessions" && method === "POST") {
      const account = [...this.accounts.values()].find(
        (a) => a.username === b.username && a.password === b.password,
      );
      if (!account) return fail(401, "unauthenticated");
      return this.issueGrant(
        account.id,
        String(b.device_id ?? ""),
        String(b.attempt_challenge ?? ""),
      );
    }
    if (path === "/browser-sessions/activate" && method === "POST") {
      const grant = this.grants.get(String(b.grant ?? ""));
      if (grant?.state !== "issued") return fail(401, "unauthenticated");
      if (challengeOf(String(b.verifier ?? "")) !== grant.challenge)
        return fail(401, "unauthenticated");
      grant.state = "redeemed";
      const id = `sess-${++this.counter}`;
      this.sessions.set(id, { id, account: grant.account });
      return {
        status: 200,
        body: {
          account_id: grant.account,
          expires_at: new Date(Date.now() + 86_400_000).toISOString(),
          csrf_token: `csrf.${id}`,
          session_id: id,
        },
        cookie: id,
      };
    }
    if (path === "/browser-sessions/activate/cancel" && method === "POST")
      return json(200, { result: "unknown" });
    if (path === "/browser-sessions/current" && method === "GET") {
      if (headers["x-atlas-session"] !== "1") return fail(403, "forbidden");
      if (!session) return fail(401, "unauthenticated");
      return json(200, {
        account_id: session.account,
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        csrf_token: `csrf.${session.id}`,
        session_id: session.id,
      });
    }
    if (path === "/oidc/start" && method === "POST") {
      if (b.link === true) {
        // As the released backend: a link is authenticated by the session cookie and so needs that session's CSRF token.
        if (!session) return fail(401, "unauthenticated");
        const csrf = headers["x-csrf-token"];
        if (!csrf) return fail(403, "forbidden");
        if (csrf !== `csrf.${session.id}`)
          return fail(403, "credential_mismatch");
      }
      this.oidcFlows.push({
        attemptId: String(b.attempt_id ?? ""),
        challenge: String(b.attempt_challenge ?? ""),
        device: String(b.device_id ?? ""),
        link: b.link === true,
        account: session?.account ?? null,
      });
      return json(200, {
        authorization_url: "https://idp.example.test/authorize",
      });
    }
    if (!session) return fail(401, "unauthenticated");
    if (path === "/me" && method === "GET") {
      const account = this.accounts.get(session.account);
      if (!account) return fail(401, "unauthenticated");
      return json(200, {
        id: account.id,
        username: account.username,
        has_password: account.hasPassword,
        oidc_issuers: account.issuers,
      });
    }
    if (path === "/sessions" && method === "GET") {
      return json(200, {
        sessions: [...this.sessions.values()]
          .filter((s) => s.account === session.account)
          .map((s) => ({
            id: s.id,
            device_id: "dev-stub",
            created_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 86_400_000).toISOString(),
            authentication: "local",
            current: s.id === session.id,
          })),
      });
    }
    return fail(404, "not_found");
  }

  private issueGrant(account: string, device: string, challenge: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(challenge))
      return { status: 422, body: err("invalid_value") };
    const grant = `grant-${++this.counter}`;
    this.grants.set(grant, { account, challenge, device, state: "issued" });
    return {
      status: 200,
      body: {
        grant,
        grant_expires_at: new Date(Date.now() + 60_000).toISOString(),
        account_id: account,
      },
    };
  }
}
