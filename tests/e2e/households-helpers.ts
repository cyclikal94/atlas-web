import {
  type BrowserContext,
  expect,
  type Page,
  type Route,
} from "@playwright/test";
import { ACCOUNT, seedSettled, stubNetwork } from "./data-sync-helpers";

/**
 * WEB-12b's fixture stub of the household endpoints (plan §4.5), registered AFTER `stubNetwork` so it answers first. It EMULATES the
 * released server's household rules closely enough for the journeys (the commands change the served state: a create makes the creator its
 * manager and, with none, the main household; an invite records a pending sent row; a revoke or a response changes its status; a
 * membership or primary change moves the snapshot's revision), and it counts every request by route. FIXTURE evidence: it is not the
 * server, and an answer it gives is its own (the I-SH integration cases run against the released backend).
 */
export const API = "/api/experimental/v1";
export const ME = ACCOUNT;
export const SAM = "22222222-2222-4222-8222-222222222222";
export const JAMIE = "44444444-4444-4444-8444-444444444444";
export const PRIYA = "33333333-3333-4333-8333-333333333333";
export const HOME = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const FLAT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
export const rev = (n: number) => n.toString(16).padStart(64, "0");
export const json = (status: number, body: unknown) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});
export const atlas = (
  code: string,
  id = "61af3d02-0000-4000-8000-000000000000",
) => ({ code, message: `refused: ${code}`, request_id: id, details: [] });

export interface Member {
  account_id: string;
  username: string;
  role: "manager" | "member";
}
export interface ServedHousehold {
  id: string;
  name: string;
  version: number;
  members: Member[];
}
export interface ServedSent {
  id: string;
  household_id: string;
  household_name: string;
  sender_id: string;
  recipient_id: string;
  recipient_username: string;
  status: "pending" | "accepted" | "declined" | "revoked" | "expired";
  expires_at: string;
  version: number;
}
export type Scripted = "abort" | { status: number; body: unknown };

export interface Households {
  households: ServedHousehold[];
  primary: string | null;
  preferencesVersion: number;
  revision: number;
  /** Invitations for ME (GET /invitations). */
  forMe: Array<{
    id: string;
    household_id: string;
    household_name: string;
    sender_id: string;
    status: "pending";
    expires_at: string;
    version: number;
  }>;
  sent: ServedSent[];
  /** The page size the stub serves (the client asks for 200). */
  sentPage: number;
  signup: Array<{
    id: string;
    household_id: string | null;
    expires_at: string;
  }>;
  directory: Array<{ id: string; username: string }>;
  directoryEnabled: boolean;
  /** Each management request, in order, with its key and body. */
  management: Array<{ key: string | null; body: unknown }>;
  /** What the next management requests answer, else the emulation. */
  managementScript: Scripted[];
  /** What the next POST /account-invitations answer (`abort`: committed, then the connection drops). */
  issueScript: Scripted[];
  /** What the next DELETE /account-invitations/{id} answer. */
  revokeScript: Scripted[];
  issued: number;
  /** Reads that are held (never answered while held): `households`, `snapshot`. */
  held: Set<string>;
  reads: Record<string, number>;
  /** The request URLs the stub saw (never containing a token: asserted by E-HH7). */
  urls: string[];
}

const hex = (n: number) => n.toString(16).padStart(12, "0");
export const sentId = (n: number) => `eeeeeeee-0000-4000-8000-${hex(n)}`;
export const signupId = (n: number) => `ffffffff-0000-4000-8000-${hex(n)}`;
const inDays = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString();

export function homeHousehold(
  over: Partial<ServedHousehold> = {},
): ServedHousehold {
  return {
    id: HOME,
    name: "Home",
    version: 2,
    members: [
      { account_id: ME, username: "me", role: "manager" },
      { account_id: SAM, username: "sam", role: "member" },
    ],
    ...over,
  };
}

function view(h: ServedHousehold) {
  const mine = h.members.find((m) => m.account_id === ME);
  return {
    id: h.id,
    name: h.name,
    version: h.version,
    role: mine?.role ?? "member",
    members: h.members,
  };
}

/** The household endpoints, with the emulation described above. */
export async function serveHouseholds(
  context: BrowserContext,
  arrange?: (served: Households) => void,
): Promise<Households> {
  const served: Households = {
    households: [homeHousehold()],
    primary: HOME,
    preferencesVersion: 1,
    revision: 1,
    forMe: [],
    sent: [],
    sentPage: 200,
    signup: [],
    directory: [
      { id: ME, username: "me" },
      { id: SAM, username: "sam" },
      { id: JAMIE, username: "jamie" },
      { id: PRIYA, username: "priya" },
    ],
    directoryEnabled: true,
    management: [],
    managementScript: [],
    issueScript: [],
    revokeScript: [],
    issued: 0,
    held: new Set(),
    reads: {},
    urls: [],
  };
  arrange?.(served);
  const count = (key: string) => {
    served.reads[key] = (served.reads[key] ?? 0) + 1;
  };
  const mine = () =>
    served.households.filter((h) => h.members.some((m) => m.account_id === ME));
  const snapshot = () => ({
    defaults: {
      revision: rev(served.revision),
      preferences_version: served.preferencesVersion,
      primary_household_id: served.primary,
      person: { kind: "primary_household", edit: true },
      field: { kind: "private" },
      task: { kind: "private" },
      list: { kind: "private" },
      progress: { kind: "private" },
    },
    households: mine()
      .filter((h) => h.id === served.primary)
      .map(view),
  });
  const refuse = (route: Route, status: number, code: string) =>
    route.fulfill(json(status, atlas(code)));

  /** Applies one command to the served state; returns the refusal code, or null. */
  const apply = (c: Record<string, unknown>): [number, string] | null => {
    const household = (id: unknown) =>
      served.households.find((h) => h.id === id);
    const manages = (h: ServedHousehold) =>
      h.members.some((m) => m.account_id === ME && m.role === "manager");
    switch (c.kind) {
      case "create_household": {
        if (mine().length >= 32) return [503, "slice_capacity"];
        served.households.push({
          id: c.id as string,
          name: c.name as string,
          version: 1,
          members: [{ account_id: ME, username: "me", role: "manager" }],
        });
        if (served.primary === null) {
          served.primary = c.id as string;
          served.preferencesVersion += 1;
        }
        return null;
      }
      case "rename_household": {
        const h = household(c.id);
        if (!h) return [404, "not_found"];
        if (!manages(h)) return [403, "forbidden"];
        if (h.version !== c.expected_version) return [409, "conflict"];
        h.name = c.name as string;
        h.version += 1;
        return null;
      }
      case "invite_to_household": {
        const h = household(c.household_id);
        if (!h) return [404, "not_found"];
        if (!manages(h)) return [403, "forbidden"];
        if (h.version !== c.expected_version) return [409, "conflict"];
        const recipient = served.directory.find((d) => d.id === c.recipient_id);
        if (!recipient) return [404, "not_found"];
        if (h.members.some((m) => m.account_id === c.recipient_id))
          return [409, "conflict"];
        if (
          served.sent.some(
            (s) =>
              s.household_id === h.id &&
              s.recipient_id === c.recipient_id &&
              s.status === "pending",
          )
        )
          return [409, "conflict"];
        served.sent.push({
          id: c.id as string,
          household_id: h.id,
          household_name: h.name,
          sender_id: ME,
          recipient_id: recipient.id,
          recipient_username: recipient.username,
          status: "pending",
          expires_at: inDays(7),
          version: 1,
        });
        h.version += 1;
        return null;
      }
      case "respond_to_household_invitation": {
        const invitation = served.forMe.find((i) => i.id === c.id);
        if (!invitation) return [404, "not_found"];
        if (invitation.version !== c.expected_version) return [409, "conflict"];
        served.forMe = served.forMe.filter((i) => i.id !== c.id);
        if (c.accept) {
          const h = household(invitation.household_id) ?? {
            id: invitation.household_id,
            name: invitation.household_name,
            version: 1,
            members: [],
          };
          if (!served.households.includes(h)) served.households.push(h);
          h.members.push({ account_id: ME, username: "me", role: "member" });
          h.version += 1;
          if (served.primary === null) {
            served.primary = h.id;
            served.preferencesVersion += 1;
          }
        }
        return null;
      }
      case "remove_household_member": {
        const h = household(c.household_id);
        if (!h) return [404, "not_found"];
        if (h.version !== c.expected_version) return [409, "conflict"];
        if (c.account_id !== ME && !manages(h)) return [403, "forbidden"];
        const target = h.members.find((m) => m.account_id === c.account_id);
        if (!target) return [404, "not_found"];
        const managersAfter = h.members.filter(
          (m) => m.role === "manager" && m.account_id !== c.account_id,
        );
        if (managersAfter.length === 0) return [409, "last_manager"];
        h.members = h.members.filter((m) => m.account_id !== c.account_id);
        h.version += 1;
        if (c.account_id === ME && served.primary === h.id) {
          served.primary = null;
          served.preferencesVersion += 1;
        }
        return null;
      }
      case "set_household_role": {
        const h = household(c.household_id);
        if (!h) return [404, "not_found"];
        if (!manages(h)) return [403, "forbidden"];
        if (h.version !== c.expected_version) return [409, "conflict"];
        const target = h.members.find((m) => m.account_id === c.account_id);
        if (!target) return [404, "not_found"];
        if (
          !c.manager &&
          h.members.filter((m) => m.role === "manager" && m !== target)
            .length === 0
        )
          return [409, "last_manager"];
        target.role = c.manager ? "manager" : "member";
        h.version += 1;
        if (!c.manager && c.account_id === ME)
          served.signup = served.signup.filter((s) => s.household_id !== h.id);
        return null;
      }
      case "set_primary_household": {
        if (c.expected_version !== served.preferencesVersion)
          return [409, "conflict"];
        served.primary = (c.household_id as string | null) ?? null;
        served.preferencesVersion += 1;
        return null;
      }
      case "revoke_household_invitation": {
        const sent = served.sent.find((s) => s.id === c.id);
        if (!sent) return [404, "not_found"];
        if (sent.version !== c.expected_version || sent.status !== "pending")
          return [409, "conflict"];
        sent.status = "revoked";
        sent.version += 1;
        return null;
      }
      default:
        return [400, "invalid_value"];
    }
  };

  await context.route(`**${API}/**`, async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(API, "");
    const method = route.request().method();
    served.urls.push(`${method} ${url.pathname}${url.search}`);
    if (path === "/me")
      return route.fulfill(
        json(200, {
          id: ME,
          username: "me",
          has_password: true,
          oidc_issuers: [],
        }),
      );
    if (path === "/sessions")
      return route.fulfill(
        json(200, {
          sessions: [
            {
              id: "s1",
              device_id: "dev-1",
              current: true,
              authentication: "local",
              created_at: new Date().toISOString(),
              expires_at: new Date(Date.now() + 86_400_000).toISOString(),
            },
          ],
        }),
      );
    if (path === "/defaults/snapshot") {
      count("snapshot");
      if (served.held.has("snapshot")) return;
      return route.fulfill(json(200, snapshot()));
    }
    if (path === "/defaults/templates") {
      const empty = { template: null, version: 0 };
      return route.fulfill(
        json(200, {
          person: empty,
          field: empty,
          task: empty,
          list: empty,
          progress: empty,
        }),
      );
    }
    if (path === "/households") {
      count("households");
      if (served.held.has("households")) return;
      return route.fulfill(json(200, mine().map(view)));
    }
    if (path === "/invitations") {
      count("invitations");
      return route.fulfill(json(200, served.forMe));
    }
    if (path === "/invitations/sent") {
      count("sent");
      const after = url.searchParams.get("after");
      const ordered = [...served.sent].sort((a, b) => a.id.localeCompare(b.id));
      const start =
        after === null ? 0 : ordered.findIndex((s) => s.id === after) + 1;
      const items = ordered.slice(start, start + served.sentPage);
      const last = items.at(-1);
      const more = start + served.sentPage < ordered.length;
      return route.fulfill(
        json(200, { items, next_after: more && last ? last.id : null }),
      );
    }
    if (path === "/directory") {
      const username = url.searchParams.get("username");
      if (username === null) {
        count("browse");
        if (!served.directoryEnabled) return refuse(route, 403, "forbidden");
        return route.fulfill(json(200, served.directory.slice(0, 100)));
      }
      count("lookup");
      return route.fulfill(
        json(
          200,
          served.directory.filter((d) => d.username === username),
        ),
      );
    }
    if (path === "/account-invitations" && method === "GET") {
      count("signupList");
      return route.fulfill(json(200, { invitations: served.signup }));
    }
    if (path === "/account-invitations" && method === "POST") {
      count("signupIssue");
      const body = JSON.parse(route.request().postData() ?? "{}") as {
        household_id: string;
      };
      const next = served.issueScript.shift();
      if (next && next !== "abort")
        return route.fulfill(json(next.status, next.body));
      served.issued += 1;
      const id = signupId(served.issued);
      served.signup.push({
        id,
        household_id: body.household_id,
        expires_at: inDays(7),
      });
      if (next === "abort") return route.abort("connectionreset");
      return route.fulfill(
        json(200, {
          id,
          token: served.issued.toString(16).padStart(64, "9"),
          expires_at: inDays(7),
        }),
      );
    }
    if (path.startsWith("/account-invitations/") && method === "DELETE") {
      count("signupRevoke");
      const id = path.split("/").at(-1);
      const next = served.revokeScript.shift();
      if (next && next !== "abort")
        return route.fulfill(json(next.status, next.body));
      const found = served.signup.some((s) => s.id === id);
      served.signup = served.signup.filter((s) => s.id !== id);
      if (next === "abort") return route.abort("connectionreset");
      if (!found) return refuse(route, 404, "not_found");
      return route.fulfill({ status: 204, body: "" });
    }
    if (path === "/management-commands" && method === "POST") {
      const body = JSON.parse(route.request().postData() ?? "null") as {
        commands: Array<Record<string, unknown>>;
      };
      served.management.push({
        key: route.request().headers()["idempotency-key"] ?? null,
        body,
      });
      const next = served.managementScript.shift();
      if (next && next !== "abort")
        return route.fulfill(json(next.status, next.body));
      // A committed command whose answer is lost applies its effect once: a repeat of the same key is its receipt.
      const key = route.request().headers()["idempotency-key"];
      const earlier = served.management
        .slice(0, -1)
        .find(
          (m) =>
            m.key === key && JSON.stringify(m.body) === JSON.stringify(body),
        );
      if (!earlier || (earlier as { failed?: boolean }).failed) {
        for (const c of body.commands) {
          const refusal = apply(c);
          if (refusal) {
            (served.management.at(-1) as { failed?: boolean }).failed = true;
            return refuse(route, refusal[0], refusal[1]);
          }
        }
        served.revision += 1;
      }
      if (next === "abort") return route.abort("connectionreset");
      return route.fulfill(json(200, { revision: served.revision }));
    }
    return route.fallback();
  });
  return served;
}

/** A booted session page (the production composition) on `route`, with the data harness attached. */
export async function bootAt(
  context: BrowserContext,
  route: string,
): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`/__session?route=${encodeURIComponent(route)}`);
  await page.waitForFunction(
    () => window.__atlasFixture?.session?.booted !== undefined,
  );
  await page.evaluate(() => window.__atlasFixture?.session?.ready);
  await page.waitForFunction(() => window.__atlasData !== undefined);
  return page;
}

/** The same page loaded again on `route` through the session harness (a plain reload would load the application's own route). */
export async function reopen(page: Page, route: string): Promise<void> {
  await page.goto(`/__session?route=${encodeURIComponent(route)}`);
  await page.waitForFunction(
    () => window.__atlasFixture?.session?.booted !== undefined,
  );
  await page.evaluate(() => window.__atlasFixture?.session?.ready);
  await page.waitForFunction(() => window.__atlasData !== undefined);
}

/** In-app navigation (history and popstate): the page and its memory stay. */
export async function navigateInApp(page: Page, path: string): Promise<void> {
  await page.evaluate((to) => {
    history.pushState(null, "", to);
    dispatchEvent(new PopStateEvent("popstate"));
  }, path);
}

export async function connectivity(
  context: BrowserContext,
  page: Page,
  online: boolean,
): Promise<void> {
  await context.setOffline(!online);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(online);
}

/** The shared stub, the household stub, a settled session, and a page booted on `route`. */
export async function setupHouseholds(
  context: BrowserContext,
  route: string,
  arrange?: (served: Households) => void,
) {
  const net = await stubNetwork(context);
  const served = await serveHouseholds(context, arrange);
  await seedSettled(context);
  const page = await bootAt(context, route);
  return { net, served, page };
}
